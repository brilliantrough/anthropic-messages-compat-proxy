import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ClaudeBillingHeaderMode, type JsonValue, type JsonRecord } from './responses-input-normalization.js';
import { normalizeAnthropicMessageRequest } from './anthropic-input-normalization.js';
import type { StreamMode } from './anthropic-config.js';
import type { ChannelConfig } from './routing-config.js';
import { resolveModelRoute } from './model-router.js';
import type { FailureEvidence, HealthLease, HealthRegistry } from './channel-health.js';
import {
  createChannelAttempts,
  createFallbackBudget,
  hasBudgetLeft,
  peekNextChannel,
  reportChannelFailure,
  reportChannelSuccess,
  selectNextChannel,
  waitForRetryDelay,
} from './upstream-router.js';
import { beginUsageAttempt, type AnthropicUsageObservation, type UsageContext } from './usage-tracking.js';
import { getAnthropicFallbackReason, isAnthropicMessageWithUsableContent, type AnthropicFallbackReason } from './anthropic-errors.js';
import {
  sendJson,
  makeAnthropicError,
  getRequestedModel,
  restoreClientModel,
  getOutboundHeaders,
} from './anthropic-http-utils.js';
import {
  type SseEvent,
  getAnthropicStreamTextDeltaLength,
  isAnthropicStreamEventWithUsableContent,
  formatSseEvent,
  parseSseChunk,
  parseStreamPayload,
  normalizeAnthropicStreamEvent,
  makeAnthropicStreamError,
  extractAnthropicUsageFromStreamPayload,
  type AnthropicStreamUsage,
} from './anthropic-sse.js';
import {
  logRequestBodiesPreview,
  logSseDebug,
  writeSseFailureDebug,
  writeStreamMissingUsageDebug,
} from './anthropic-logging.js';

export type ProxyStats = {
  requestsTotal: number;
  responsesJson: number;
  responsesSseNormalized: number;
  responsesSseRaw: number;
  cacheHits: number;
  cacheMisses: number;
  cacheStores: number;
  cacheEvictions: number;
  cacheClears: number;
  upstreamTimeouts: number;
  overloadRejects: number;
  errors4xx: number;
  errors5xx: number;
  usageResponses: number;
  usageInputTokens: number;
  usageOutputTokens: number;
  usageTotalTokens: number;
  usageCachedInputTokens: number;
  usageReasoningTokens: number;
  activeRequests: number;
  fallbackReasons: Record<string, number>;
  fallbackByUpstream: Record<string, Record<string, number>>;
};

function createFallbackReasonBuckets() {
  return {
    upstream5xx: 0,
    retryable4xx: 0,
    compat4xx: 0,
    unknownUpstreamError: 0,
    headersOnlyTimeout: 0,
    streamTimeoutAfterText: 0,
    streamErrorAfterText: 0,
    streamNoTextContent: 0,
    streamMissingUsage: 0,
    emptyResponse: 0,
    sseReconstructionFailure: 0,
    proxyUnhandledError: 0,
  } as Record<string, number>;
}

function createFallbackByUpstreamBuckets() {
  return {
    total: 0,
    upstream5xx: 0,
    retryable4xx: 0,
    compat4xx: 0,
    unknownUpstreamError: 0,
    headersOnlyTimeout: 0,
    streamTimeoutAfterText: 0,
    streamErrorAfterText: 0,
    streamNoTextContent: 0,
    streamMissingUsage: 0,
    emptyResponse: 0,
    sseReconstructionFailure: 0,
    proxyUnhandledError: 0,
  } as Record<string, number>;
}

export function createProxyStats(): ProxyStats {
  return {
    requestsTotal: 0,
    responsesJson: 0,
    responsesSseNormalized: 0,
    responsesSseRaw: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheStores: 0,
    cacheEvictions: 0,
    cacheClears: 0,
    upstreamTimeouts: 0,
    overloadRejects: 0,
    errors4xx: 0,
    errors5xx: 0,
    usageResponses: 0,
    usageInputTokens: 0,
    usageOutputTokens: 0,
    usageTotalTokens: 0,
    usageCachedInputTokens: 0,
    usageReasoningTokens: 0,
    activeRequests: 0,
    fallbackReasons: createFallbackReasonBuckets(),
    fallbackByUpstream: {},
  };
}

export function recordFallbackReason(stats: ProxyStats, reason: string, upstreamName: string) {
  const bucket = (() => {
    if (reason === 'upstream_5xx') return 'upstream5xx';
    if (reason === 'retryable_4xx') return 'retryable4xx';
    if (reason === 'compat_4xx') return 'compat4xx';
    if (reason === 'headers_only_timeout' || reason === 'connect_timeout' || reason === 'body_timeout') return 'headersOnlyTimeout';
    if (reason === 'stream_timeout_after_text') return 'streamTimeoutAfterText';
    if (reason === 'stream_error_after_text') return 'streamErrorAfterText';
    if (reason === 'stream_no_text_content') return 'streamNoTextContent';
    if (reason === 'stream_missing_usage') return 'streamMissingUsage';
    if (reason === 'empty_response') return 'emptyResponse';
    if (reason === 'sse_reconstruction_failure') return 'sseReconstructionFailure';
    if (reason === 'proxy_unhandled_error') return 'proxyUnhandledError';
    return 'unknownUpstreamError';
  })();

  stats.fallbackReasons[bucket] = (stats.fallbackReasons[bucket] ?? 0) + 1;
  const perUpstream = stats.fallbackByUpstream[upstreamName] ?? createFallbackByUpstreamBuckets();
  perUpstream[bucket] = (perUpstream[bucket] ?? 0) + 1;
  perUpstream.total = (perUpstream.total ?? 0) + 1;
  stats.fallbackByUpstream[upstreamName] = perUpstream;
}

export function addUsageToStats(stats: ProxyStats, usage: AnthropicStreamUsage | undefined) {
  if (!usage) return;
  stats.usageResponses += 1;
  if (typeof usage.inputTokens === 'number') stats.usageInputTokens += usage.inputTokens;
  if (typeof usage.outputTokens === 'number') stats.usageOutputTokens += usage.outputTokens;
  if (typeof usage.cacheReadInputTokens === 'number') stats.usageCachedInputTokens += usage.cacheReadInputTokens;
  const totalFromParts =
    (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0) +
    (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0);
  if (totalFromParts > 0) stats.usageTotalTokens += totalFromParts;
}

export function recordStatus(stats: ProxyStats, statusCode: number) {
  if (statusCode >= 400 && statusCode < 500) stats.errors4xx += 1;
  if (statusCode >= 500) stats.errors5xx += 1;
}

export type AnthropicMessagesHandlerOptions = {
  requestId: string;
  routingConfig: import('./routing-config.js').RoutingConfig;
  healthRegistry: HealthRegistry;
  channelMaxAttempts: number;
  channelRetryDelayMs: number;
  usageContext: UsageContext;
  anthropicVersion: string;
  anthropicBeta: string | undefined;
  defaultModel: string;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
  cacheControlMode: import('./anthropic-input-normalization.js').CacheControlMode;
  cacheControlTtl: string;
  maxFallbackTotalMs: number;
  upstreamTimeoutMs: number;
  nonStreamingRequestTimeoutMs: number;
  firstByteTimeoutMs: number;
  firstTextTimeoutMs: number;
  streamIdleTimeoutMs: number;
  totalRequestTimeoutMs: number;
  defaultStreamMode: StreamMode;
  logRequestBodies: boolean;
  debugSse: boolean;
  sseFailureDebugEnabled: boolean;
  sseFailureDebugDir: string;
  streamMissingUsageDebugEnabled: boolean;
  streamMissingUsageDebugDir: string;
  fallbackOnRetryable4xx: boolean;
  fallbackOnCompat4xx: boolean;
  compatFallbackPatterns: string[];
  clientErrorPatterns: string[];
  stats: ProxyStats;
  logRequest: (message: string, extra?: Record<string, unknown>) => void;
  finish: (statusCode: number, note: string, extra?: Record<string, unknown>) => void;
};

function getAbortReasonFromUnknown(error: unknown): AbortReason | undefined {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const candidate = error as AbortReason;
    if (candidate.kind === 'timeout' || candidate.kind === 'client_disconnect') {
      return candidate;
    }
  }
  return undefined;
}

type AbortReason =
  | { kind: 'timeout'; phase: 'connect' | 'first-byte' | 'first-text' | 'idle' | 'total' }
  | { kind: 'client_disconnect'; source?: 'request' | 'response' };

type StreamOutcome =
  | { kind: 'completed'; wroteTextContent: boolean; wroteAnyEvent: boolean; startedStreaming: boolean; chunkCount: number; totalBytes: number; textCharCount: number; usage?: AnthropicStreamUsage; fallbackReason?: AnthropicFallbackReason }
  | { kind: 'timeout'; phase: Extract<AbortReason, { kind: 'timeout' }>['phase']; wroteTextContent: boolean; wroteAnyEvent: boolean; startedStreaming: boolean; chunkCount: number; totalBytes: number; textCharCount: number; fallbackReason?: AnthropicFallbackReason }
  | { kind: 'client_disconnect'; source?: 'request' | 'response'; wroteTextContent: boolean; wroteAnyEvent: boolean; startedStreaming: boolean; chunkCount: number; totalBytes: number; textCharCount: number }
  | { kind: 'error'; wroteTextContent: boolean; wroteAnyEvent: boolean; startedStreaming: boolean; chunkCount: number; totalBytes: number; textCharCount: number; error: unknown; fallbackReason?: AnthropicFallbackReason };

function getObservedStreamState(observation: Pick<StreamOutcome, 'wroteAnyEvent' | 'wroteTextContent'>) {
  if (observation.wroteTextContent) return 'recognized_text_observed';
  if (observation.wroteAnyEvent) return 'sse_events_observed_without_recognized_text';
  return 'no_complete_sse_events_observed';
}

function getClientOutputState(observation: Pick<StreamOutcome, 'startedStreaming' | 'wroteTextContent'>) {
  if (observation.startedStreaming) return 'stream_committed_to_client';
  if (observation.wroteTextContent) return 'recognized_text_detected_but_not_committed';
  return 'no_client_stream_output';
}

function getStreamTimeoutObservation(
  phase: Extract<AbortReason, { kind: 'timeout' }>['phase'],
  observation: Pick<StreamOutcome, 'wroteAnyEvent' | 'wroteTextContent'>,
) {
  if (phase === 'first-byte') return 'no_upstream_body_chunk_before_timeout';
  if (phase === 'first-text') {
    return observation.wroteAnyEvent
      ? 'upstream_sse_active_but_no_recognized_text_before_timeout'
      : 'no_recognized_text_before_timeout';
  }
  if (phase === 'idle') {
    return observation.wroteAnyEvent
      ? 'stream_became_idle_without_recognized_text'
      : 'stream_became_idle_before_complete_sse_event';
  }
  return 'request_total_timeout_before_usable_stream_output';
}

function getFallbackReasonNote(reason: AnthropicFallbackReason, phase?: Extract<AbortReason, { kind: 'timeout' }>['phase']) {
  if (reason === 'headers_only_timeout') {
    if (phase === 'first-byte') return 'internal timeout bucket for requests that never produced the first upstream body chunk';
    if (phase === 'first-text') return 'internal timeout bucket for streams that produced transport activity but no recognized assistant text before the timeout';
    if (phase === 'idle') return 'internal timeout bucket for streams that stalled before any recognized assistant text was usable';
    return 'internal timeout bucket for streams that timed out before usable output reached the client';
  }
  if (reason === 'stream_no_text_content') return 'stream completed but no recognizable assistant text was reconstructed';
  if (reason === 'stream_missing_usage') return 'stream completed with usable output but without extractable usage';
  return undefined;
}

function getStreamObservationLogFields(
  observation: { startedStreaming: boolean; wroteAnyEvent: boolean; wroteTextContent: boolean; usage?: AnthropicStreamUsage },
  options?: { phase?: Extract<AbortReason, { kind: 'timeout' }>['phase']; fallbackReason?: AnthropicFallbackReason },
) {
  const fields: Record<string, unknown> = {
    observedStreamState: getObservedStreamState(observation),
    clientOutputState: getClientOutputState(observation),
    usageState: observation.usage ? 'extractable_usage_observed' : 'extractable_usage_not_observed',
  };
  if (options?.phase) fields.timeoutObservation = getStreamTimeoutObservation(options.phase, observation);
  if (options?.fallbackReason) {
    const note = getFallbackReasonNote(options.fallbackReason, options.phase);
    if (note) fields.fallbackReasonNote = note;
  }
  return fields;
}

function getStreamMode(req: IncomingMessage, body: JsonRecord, defaultMode: StreamMode): StreamMode {
  const bodyMode = typeof body.proxy_stream_mode === 'string' ? body.proxy_stream_mode.toLowerCase() : undefined;
  if (bodyMode === 'raw' || bodyMode === 'normalized') return bodyMode;

  const headerMode = typeof req.headers['x-proxy-stream-mode'] === 'string'
    ? req.headers['x-proxy-stream-mode'].toLowerCase()
    : undefined;
  if (headerMode === 'raw' || headerMode === 'normalized') return headerMode;

  return defaultMode;
}

function createLinkedAbortController(parentSignal: AbortSignal) {
  const controller = new AbortController();
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return { controller, dispose: () => {} };
  }
  const handleAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', handleAbort, { once: true });
  return {
    controller,
    dispose: () => parentSignal.removeEventListener('abort', handleAbort),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, controller: AbortController, timeoutMs: number): Promise<Response> {
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort({ kind: 'timeout', phase: 'connect' } satisfies AbortReason);
    }
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw signal.reason;
  }

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function pipeProgressiveSse(
  upstreamResponse: Response,
  res: ServerResponse,
  requestedModel: string,
  streamMode: StreamMode,
  controller: AbortController,
  firstByteTimeoutMs: number,
  firstTextTimeoutMs: number,
  streamIdleTimeoutMs: number,
  options: {
    requestId: string;
    debugSse: boolean;
    sseFailureDebugEnabled: boolean;
    sseFailureDebugDir: string;
    streamMissingUsageDebugEnabled: boolean;
    streamMissingUsageDebugDir: string;
    logRequest: (message: string, extra?: Record<string, unknown>) => void;
  },
): Promise<StreamOutcome> {
  let wroteTextContent = false;
  let startedStreaming = false;
  const pendingEvents: SseEvent[] = [];
  const pendingRawChunks: string[] = [];
  let accumulatedUsage: AnthropicStreamUsage | undefined;
  const observedEvents: Array<{ event: string; data: string }> = [];
  let observedSseText = '';
  let chunkCount = 0;
  let totalBytes = 0;
  let textCharCount = 0;

  const ensureHeaders = () => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(upstreamResponse.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
  };

  const flushPending = () => {
    ensureHeaders();
    startedStreaming = true;
    if (streamMode === 'raw') {
      const raw = pendingRawChunks.join('');
      if (raw.length > 0) res.write(raw);
      pendingRawChunks.length = 0;
    } else {
      for (const event of pendingEvents) {
        res.write(formatSseEvent(normalizeAnthropicStreamEvent(event, requestedModel)));
      }
      pendingEvents.length = 0;
    }
  };

  if (!upstreamResponse.body) {
    ensureHeaders();
    res.end();
    return {
      kind: 'completed',
      wroteTextContent: false,
      wroteAnyEvent: false,
      startedStreaming: false,
      chunkCount: 0,
      totalBytes: 0,
      textCharCount: 0,
      fallbackReason: 'empty_response',
    };
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTextTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearAllTimers = () => {
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = undefined; }
    if (firstTextTimer) { clearTimeout(firstTextTimer); firstTextTimer = undefined; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  };

  const abortWithReason = (reason: AbortReason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  firstByteTimer = setTimeout(() => abortWithReason({ kind: 'timeout', phase: 'first-byte' }), firstByteTimeoutMs);
  if (firstTextTimeoutMs > 0) {
    firstTextTimer = setTimeout(() => abortWithReason({ kind: 'timeout', phase: 'first-text' }), firstTextTimeoutMs);
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortWithReason({ kind: 'timeout', phase: 'idle' }), streamIdleTimeoutMs);
  };
  resetIdleTimer();

  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, controller.signal);
      if (done) break;

      if (!value || value.byteLength === 0) continue;

      chunkCount += 1;
      totalBytes += value.byteLength;

      resetIdleTimer();

      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }

      if (streamMode === 'raw') {
        const textChunk = decoder.decode(value, { stream: true });
        observedSseText += textChunk;
        pending += textChunk;

        const blocks = pending.split(/\r?\n\r?\n/);
        pending = blocks.pop() ?? '';

        let rawHasUsableContent = wroteTextContent;

        for (const block of blocks) {
          const sseEvent = parseSseChunk(block);
          observedEvents.push({ event: sseEvent.event, data: sseEvent.data });
          const payload = parseStreamPayload(sseEvent.data);
          textCharCount += getAnthropicStreamTextDeltaLength(payload);

          const usage = extractAnthropicUsageFromStreamPayload(payload);
          if (usage) {
            accumulatedUsage = { ...accumulatedUsage, ...usage };
          }

          if (!rawHasUsableContent && isAnthropicStreamEventWithUsableContent(sseEvent)) {
            rawHasUsableContent = true;
          }

          pendingRawChunks.push(block + '\r\n\r\n');
        }

        if (rawHasUsableContent && !wroteTextContent) {
          if (firstTextTimer) {
            clearTimeout(firstTextTimer);
            firstTextTimer = undefined;
          }
          wroteTextContent = true;
          flushPending();
        } else if (wroteTextContent) {
          const raw = pendingRawChunks.join('');
          pendingRawChunks.length = 0;
          ensureHeaders();
          res.write(raw);
        }

        continue;
      }

      const textChunk = decoder.decode(value, { stream: true });
      observedSseText += textChunk;
      pending += textChunk;

      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? '';

      for (const block of blocks) {
        if (!block.trim()) continue;

        const event = parseSseChunk(block);
        observedEvents.push({ event: event.event, data: event.data });
        const payload = parseStreamPayload(event.data);
        textCharCount += getAnthropicStreamTextDeltaLength(payload);

        const usage = extractAnthropicUsageFromStreamPayload(payload);
        if (usage) {
          accumulatedUsage = { ...accumulatedUsage, ...usage };
        }

        const isUsableContent = isAnthropicStreamEventWithUsableContent(event);

        if (isUsableContent && !wroteTextContent) {
          if (firstTextTimer) {
            clearTimeout(firstTextTimer);
            firstTextTimer = undefined;
          }
          wroteTextContent = true;
          flushPending();
          const normalized = normalizeAnthropicStreamEvent(event, requestedModel);
          res.write(formatSseEvent(normalized));
        } else if (wroteTextContent) {
          const normalized = normalizeAnthropicStreamEvent(event, requestedModel);
          ensureHeaders();
          res.write(formatSseEvent(normalized));
        } else {
          pendingEvents.push(event);
        }
      }
    }

    clearAllTimers();

    const finalChunk = decoder.decode();
    observedSseText += finalChunk;
    pending += finalChunk;
    if (pending.trim()) {
      const event = parseSseChunk(pending);
      observedEvents.push({ event: event.event, data: event.data });
      if (wroteTextContent) {
        const normalized = normalizeAnthropicStreamEvent(event, requestedModel);
        ensureHeaders();
        res.write(formatSseEvent(normalized));
      } else {
        pendingEvents.push(event);
      }
    }
  } catch (error) {
    clearAllTimers();
    logSseDebug(options.requestId, observedEvents, options.debugSse);

    if (controller.signal.aborted) {
      const reason = controller.signal.reason as AbortReason | undefined;
      if (reason?.kind === 'timeout') {
        if (!wroteTextContent) {
          void writeSseFailureDebug(
            options.requestId,
            upstreamResponse.headers.get('content-type') ?? '',
            upstreamResponse.status,
            observedSseText,
            { enabled: options.sseFailureDebugEnabled, dir: options.sseFailureDebugDir },
          );
        }
        if (wroteTextContent && !res.writableEnded && !res.destroyed) {
          const errorEvent = makeAnthropicStreamError('Stream timeout', 'server_error');
          res.write(formatSseEvent(errorEvent));
          res.end();
        }
        return {
          kind: 'timeout',
          phase: reason.phase,
          wroteTextContent,
          wroteAnyEvent: observedEvents.length > 0,
          startedStreaming,
          chunkCount,
          totalBytes,
          textCharCount,
          fallbackReason: !wroteTextContent ? 'headers_only_timeout' : undefined,
        };
      }
      if (reason?.kind === 'client_disconnect') {
        if (startedStreaming && !res.writableEnded && !res.destroyed) {
          res.end();
        }
        return { kind: 'client_disconnect', source: reason.source, wroteTextContent, wroteAnyEvent: observedEvents.length > 0, startedStreaming, chunkCount, totalBytes, textCharCount };
      }
    }
    if (!wroteTextContent) {
      void writeSseFailureDebug(
        options.requestId,
        upstreamResponse.headers.get('content-type') ?? '',
        upstreamResponse.status,
        observedSseText,
        { enabled: options.sseFailureDebugEnabled, dir: options.sseFailureDebugDir },
      );
    }
    if (!res.writableEnded && !res.destroyed) {
      if (wroteTextContent) {
        const errorEvent = makeAnthropicStreamError('Stream error', 'server_error');
        res.write(formatSseEvent(errorEvent));
        res.end();
      }
    }
    return { kind: 'error', wroteTextContent, wroteAnyEvent: observedEvents.length > 0, startedStreaming, chunkCount, totalBytes, textCharCount, error, fallbackReason: !wroteTextContent ? 'stream_no_text_content' : undefined };
  }

  logSseDebug(options.requestId, observedEvents, options.debugSse);

  if (wroteTextContent && !res.writableEnded && !res.destroyed) {
    res.end();
  }

  if (!wroteTextContent) {
    return { kind: 'completed', wroteTextContent: false, wroteAnyEvent: observedEvents.length > 0, startedStreaming, chunkCount, totalBytes, textCharCount, usage: undefined, fallbackReason: 'stream_no_text_content' };
  }

  if (!accumulatedUsage) {
    options.logRequest('stream stopped before extractable usage was observed', {
      upstreamStatus: upstreamResponse.status,
      streamMode,
      chunkCount,
      totalBytes,
      streamEventCount: observedEvents.length,
    });
    void writeStreamMissingUsageDebug(
      options.requestId,
      upstreamResponse.status,
      streamMode,
      chunkCount,
      totalBytes,
      observedEvents.length,
      observedSseText,
      { enabled: options.streamMissingUsageDebugEnabled, dir: options.streamMissingUsageDebugDir },
    );
  }

  options.logRequest('stream passthrough finished', {
    chunkCount,
    totalBytes,
    usage: accumulatedUsage ?? null,
    wroteTextContent,
    usageOutputTokens: accumulatedUsage && typeof accumulatedUsage.outputTokens === 'number' ? accumulatedUsage.outputTokens : null,
    textCharCount,
  });

  return {
    kind: 'completed',
    wroteTextContent: true,
    wroteAnyEvent: observedEvents.length > 0,
    startedStreaming,
    chunkCount,
    totalBytes,
    textCharCount,
    usage: accumulatedUsage,
    fallbackReason: accumulatedUsage ? undefined : 'stream_missing_usage',
  };
}

function handleFallbackExhausted(res: ServerResponse, reason: string | null) {
  sendJson(res, 502, makeAnthropicError('api_error', `All configured channels failed for this model (fallback_exhausted)${reason ? `: ${reason}` : ''}`));
}

function handleModelChannelsUnavailable(res: ServerResponse, retryAfterMs: number) {
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  res.writeHead(503, {
    'content-type': 'application/json; charset=utf-8',
    'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(makeAnthropicError('api_error', 'No configured channel is currently available for this model (model_channels_unavailable)'), null, 2));
}

function getFallbackBudgetRemainingMs(startedAt: number, maxFallbackTotalMs: number) {
  if (maxFallbackTotalMs <= 0) {
    return null;
  }
  return Math.max(0, maxFallbackTotalMs - (Date.now() - startedAt));
}

export async function handleMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestBody: JsonRecord,
  options: AnthropicMessagesHandlerOptions,
): Promise<void> {
  const isStream = requestBody.stream === true || (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/event-stream'));
  const streamMode = getStreamMode(req, requestBody, options.defaultStreamMode);
  options.logRequest('request accepted', {
    method: req.method,
    url: req.url,
    stream: isStream,
    mode: streamMode,
    active: options.stats.activeRequests,
  });
  const requestedModel = getRequestedModel(requestBody, options.defaultModel);
  const route = resolveModelRoute(requestBody.model, options.routingConfig);
  if ('code' in route) {
    options.finish(400, 'model is not configured', { requestedModel: route.requestedModel, modelNotConfigured: true });
    sendJson(res, 400, makeAnthropicError('invalid_request_error', `model '${route.requestedModel}' is not configured (model_not_configured)`));
    return;
  }
  const upstreamBody = normalizeAnthropicMessageRequest(requestBody, {
    canonicalModel: route.canonicalModel,
    claudeBillingHeaderMode: options.claudeBillingHeaderMode,
    cacheControlMode: options.cacheControlMode,
    cacheControlTtl: options.cacheControlTtl,
  });
  logRequestBodiesPreview(options.requestId, requestBody, upstreamBody, {
    enabled: options.logRequestBodies,
    claudeBillingHeaderMode: options.claudeBillingHeaderMode,
  });

  const attempts = createChannelAttempts(options.channelMaxAttempts);
  const budget = createFallbackBudget();
  let pendingFallbackReason: AnthropicFallbackReason | null = null;
  let attemptIndex = 0;
  let isFallbackAttempt = false;
  let channelId = '';
  let channelName = '';
  let lease: HealthLease | undefined;
  let currentAttempt: ReturnType<typeof beginUsageAttempt> | undefined;

  // The total request deadline lives outside the attempt loop so retries, retry pacing and
  // channel switches all share one budget instead of restarting it per attempt.
  const requestController = new AbortController();
  const totalTimer = options.totalRequestTimeoutMs > 0
    ? setTimeout(() => {
      if (!requestController.signal.aborted) {
        requestController.abort({ kind: 'timeout', phase: 'total' } satisfies AbortReason);
      }
    }, options.totalRequestTimeoutMs)
    : undefined;
  const clearTotalTimer = () => { if (totalTimer) clearTimeout(totalTimer); };
  const onRequestClose = () => {
    if (!requestController.signal.aborted) {
      requestController.abort({ kind: 'client_disconnect', source: 'request' } satisfies AbortReason);
    }
  };
  req.on('close', onRequestClose);

  const healthSnapshotFor = (id: string) => options.healthRegistry.snapshot().channels.find(record => record.channelId === id) ?? null;
  const peekNextChannelName = () => peekNextChannel(route, options.routingConfig, options.healthRegistry, attempts)?.name ?? null;
  const canRetry = () =>
    hasBudgetLeft(budget, options.maxFallbackTotalMs) &&
    !requestController.signal.aborted &&
    peekNextChannel(route, options.routingConfig, options.healthRegistry, attempts) !== undefined;
  const markFailure = (reason: string, evidence: Omit<FailureEvidence, 'fallbackReason' | 'upstreamResponseObserved'> & { upstreamResponseObserved?: boolean } = {}) => {
    if (lease === undefined) return;
    const before = healthSnapshotFor(channelId);
    reportChannelFailure(lease, options.healthRegistry, {
      ...evidence,
      fallbackReason: reason,
      upstreamResponseObserved: evidence.upstreamResponseObserved ?? true,
    });
    const after = healthSnapshotFor(channelId);
    currentAttempt?.result('failed', reason);
    options.logRequest(after && after.remainingMs > 0 && (!before || before.remainingMs === 0) ? 'channel breaker opened' : 'channel failure recorded', {
      upstreamName: channelName,
      failureReason: reason,
      failureCount: after?.windowFailures ?? null,
      cooldownMs: after?.remainingMs ?? null,
      channelHealth: after,
    });
  };
  const markSuccess = (usage?: AnthropicUsageObservation) => {
    if (lease === undefined) return;
    reportChannelSuccess(lease, options.healthRegistry);
    currentAttempt?.observe(usage);
    currentAttempt?.result('success');
  };

  try {
  while (true) {
    const selection = selectNextChannel(route, options.routingConfig, options.healthRegistry, attempts);
    if (!selection.ok) {
      if (selection.code === 'all_unavailable' && selection.attemptedChannelIds.length === 0) {
        options.finish(503, 'all model channels unavailable', {
          requestedModel,
          canonicalModel: route.canonicalModel,
          channelIds: route.channelIds,
          retryAfterMs: selection.retryAfterMs,
        });
        handleModelChannelsUnavailable(res, selection.retryAfterMs);
        return;
      }
      options.finish(502, 'all upstream channels exhausted', {
        requestedModel,
        canonicalModel: route.canonicalModel,
        attemptedChannelIds: selection.attemptedChannelIds,
        fallbackReason: pendingFallbackReason,
      });
      handleFallbackExhausted(res, pendingFallbackReason);
      return;
    }
    const selected = selection.channel;
    channelId = selected.id;
    channelName = selected.name;
    lease = selection.lease;
    if (selection.retryOfSameChannel && options.channelRetryDelayMs > 0) {
      const waited = await waitForRetryDelay(options.channelRetryDelayMs, requestController.signal);
      if (!waited) {
        const abortReason = getAbortReasonFromUnknown(requestController.signal.reason);
        if (abortReason?.kind === 'timeout') {
          options.finish(504, 'request total timeout while pacing a same-channel retry', { upstreamName: channelName });
          sendJson(res, 504, makeAnthropicError('api_error', 'Request total timeout elapsed before the retry could start'));
        } else {
          options.finish(499, 'request cancelled by client while pacing a same-channel retry', { source: 'request' });
        }
        return;
      }
    }
    attemptIndex += 1;
    isFallbackAttempt = attemptIndex > 1;
    if (isFallbackAttempt) {
      options.logRequest('attempting fallback upstream', {
        fallbackName: selected.name,
        fallbackUrl: selected.messagesUrl,
        attempt: budget.attemptsUsed,
        totalFallbacks: route.channelIds.length - 1,
        fallbackAttemptsUsed: budget.attemptsUsed,
        retryOfSameChannel: selection.retryOfSameChannel,
        fallbackReason: pendingFallbackReason,
        fallbackBudgetRemainingMs: getFallbackBudgetRemainingMs(budget.startedAt, options.maxFallbackTotalMs),
        endpointHealth: healthSnapshotFor(selected.id),
      });
    }
    const headers = getOutboundHeaders(selected.apiKey, options.anthropicVersion, options.anthropicBeta, req.headers);

    const parentController = createLinkedAbortController(requestController.signal);
    const linkedReq = req;
    const onClientClose = () => {
      parentController.controller.abort({ kind: 'client_disconnect', source: 'request' } satisfies AbortReason);
    };
    linkedReq.on('close', onClientClose);
    currentAttempt = undefined;
    let upstreamAttemptController: ReturnType<typeof createLinkedAbortController> | null = null;

    try {
      const connectTimeoutMs = isStream ? options.upstreamTimeoutMs : options.nonStreamingRequestTimeoutMs;
      options.logRequest('forwarding upstream', {
        model: typeof upstreamBody.model === 'string' ? upstreamBody.model : null,
        requestedModel,
        stream: isStream,
        mode: streamMode,
        connectMs: connectTimeoutMs,
        firstByteMs: options.firstByteTimeoutMs,
        claudeBillingHeaderMode: options.claudeBillingHeaderMode,
        cacheControlMode: options.cacheControlMode,
        cacheControlTtl: options.cacheControlTtl,
      });

      upstreamAttemptController = createLinkedAbortController(parentController.controller.signal);
      currentAttempt = beginUsageAttempt(
        options.usageContext,
        { id: selected.id, name: selected.name },
        route.canonicalModel,
        'messages',
        parentController.controller.signal,
      );
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchWithTimeout(
          selected.messagesUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...upstreamBody, ...(isStream ? { stream: true } : {}) }),
          },
          upstreamAttemptController.controller,
          connectTimeoutMs,
        );
      } catch (error) {
        linkedReq.removeListener('close', onClientClose);
        const abortReason = getAbortReasonFromUnknown(upstreamAttemptController?.controller.signal.reason) ?? getAbortReasonFromUnknown(error);
        if (abortReason?.kind === 'client_disconnect') {
          options.finish(499, 'request cancelled by client', {
            source: abortReason.source ?? 'request',
            upstreamName: selected.name,
          });
          return;
        }
        const failureReason = abortReason?.kind === 'timeout' && abortReason.phase === 'connect'
          ? 'connect_timeout'
          : 'connect_error';
        markFailure(failureReason, { error, abortReason, upstreamResponseObserved: false });
        recordFallbackReason(options.stats, failureReason, selected.name);
        if (failureReason === 'connect_timeout') {
          options.stats.upstreamTimeouts += 1;
        }

        if (canRetry()) {
          pendingFallbackReason = failureReason;
          options.logRequest(failureReason === 'connect_timeout' ? 'upstream connect timeout encountered, falling back' : 'upstream connect error encountered, falling back', {
            upstreamName: selected.name,
            upstreamUrl: selected.messagesUrl,
            phase: abortReason?.kind === 'timeout' ? abortReason.phase : undefined,
            errorName: error instanceof Error ? error.name : null,
            errorMessage: error instanceof Error ? error.message : String(error),
            nextFallbackName: peekNextChannelName(),
          });
          budget.attemptsUsed += 1;
          continue;
        }

        options.finish(502, failureReason === 'connect_timeout' ? 'upstream connect timeout' : 'upstream connect error', {
          upstreamName: selected.name,
          upstreamUrl: selected.messagesUrl,
        });
        sendJson(res, 502, makeAnthropicError('api_error', `${failureReason === 'connect_timeout' ? 'Upstream connect timeout' : 'Upstream connect error'}: ${error instanceof Error ? error.message : String(error)} (fallback_exhausted)`));
        return;
      }

      linkedReq.removeListener('close', onClientClose);

      if (isStream) {
        options.logRequest('stream passthrough started', {
          upstreamName: selected.name,
          upstreamStatus: upstreamResponse.status,
          upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
          streamMode,
        });
        const streamController = createLinkedAbortController(parentController.controller.signal).controller;
        const onClientCloseStream = () => {
          streamController.abort({ kind: 'client_disconnect', source: 'request' } satisfies AbortReason);
        };
        req.on('close', onClientCloseStream);

        try {
          const outcome = await pipeProgressiveSse(
            upstreamResponse,
            res,
            requestedModel,
            streamMode,
            streamController,
            options.firstByteTimeoutMs,
            options.firstTextTimeoutMs,
            options.streamIdleTimeoutMs,
            {
              requestId: options.requestId,
              debugSse: options.debugSse,
              sseFailureDebugEnabled: options.sseFailureDebugEnabled,
              sseFailureDebugDir: options.sseFailureDebugDir,
              streamMissingUsageDebugEnabled: options.streamMissingUsageDebugEnabled,
              streamMissingUsageDebugDir: options.streamMissingUsageDebugDir,
              logRequest: options.logRequest,
            },
          );

          req.removeListener('close', onClientCloseStream);

          if (outcome.kind === 'client_disconnect') {
            options.finish(499, 'client disconnected during stream passthrough', {
              source: outcome.source ?? 'request',
              upstreamStatus: upstreamResponse.status,
              upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
              chunkCount: outcome.chunkCount,
              totalBytes: outcome.totalBytes,
              streamMode,
              upstreamName: selected.name,
            });
            return;
          }

          if (outcome.kind === 'completed' || outcome.kind === 'timeout' || outcome.kind === 'error') {
            if (outcome.wroteTextContent) {
              let postTextFailureReason: string | undefined;
              if (outcome.kind !== 'completed') {
                postTextFailureReason = outcome.kind === 'timeout' ? 'stream_timeout_after_text' : 'stream_error_after_text';
                markFailure(postTextFailureReason, {
                  status: upstreamResponse.status,
                  abortReason: streamController.signal.reason,
                  error: outcome.kind === 'error' ? outcome.error : undefined,
                });
                recordFallbackReason(options.stats, postTextFailureReason, selected.name);
                if (outcome.kind === 'timeout') {
                  options.stats.upstreamTimeouts += 1;
                }
                options.logRequest('stream produced usable text but did not end cleanly', {
                  upstreamName: selected.name,
                  upstreamUrl: selected.messagesUrl,
                  upstreamStatus: upstreamResponse.status,
                  upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
                  streamMode,
                  failureReason: postTextFailureReason,
                  outcomeKind: outcome.kind,
                  phase: outcome.kind === 'timeout' ? outcome.phase : undefined,
                  chunkCount: outcome.chunkCount,
                  totalBytes: outcome.totalBytes,
                  textCharCount: outcome.textCharCount,
                  error: outcome.kind === 'error'
                    ? outcome.error instanceof Error
                      ? { name: outcome.error.name, message: outcome.error.message }
                      : String(outcome.error)
                    : undefined,
                  ...getStreamObservationLogFields(outcome, outcome.kind === 'timeout' ? { phase: outcome.phase } : undefined),
                });
              }
              if (outcome.kind === 'completed' && outcome.usage) {
                addUsageToStats(options.stats, outcome.usage);
              }
              if (outcome.kind === 'completed') {
                markSuccess(outcome.usage);
              }
              if (streamMode === 'normalized') {
                options.stats.responsesSseNormalized += 1;
              } else {
                options.stats.responsesSseRaw += 1;
              }
              if (outcome.kind === 'completed' && (isFallbackAttempt)) {
                options.logRequest('fallback upstream succeeded', {
                  fallbackName: selected.name,
                  fallbackUrl: selected.messagesUrl,
                  upstreamStatus: upstreamResponse.status,
                  upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
                });
              }
              options.finish(upstreamResponse.status, 'stream passthrough returned', {
                upstreamStatus: upstreamResponse.status,
                streamMode,
              });
              return;
            }
          }

          if (outcome.kind === 'timeout') {
            options.stats.upstreamTimeouts += 1;
          }
          const reason = outcome.fallbackReason ?? 'stream_no_text_content';
          markFailure(reason, {
            status: upstreamResponse.status,
            abortReason: streamController.signal.reason,
            error: outcome.kind === 'error' ? outcome.error : undefined,
          });
          recordFallbackReason(options.stats, reason, selected.name);

          if (outcome.fallbackReason && canRetry()) {
            pendingFallbackReason = reason;
            if (outcome.kind === 'completed') {
                options.logRequest('stream completed without usable output, falling back', {
                  upstreamName: selected.name,
                  upstreamUrl: selected.messagesUrl,
                  fallbackReason: reason,
                  nextFallbackName: peekNextChannelName(),
                  streamMode,
                  wroteAnyEvent: outcome.wroteAnyEvent,
                  wroteTextContent: outcome.wroteTextContent,
                  textCharCount: outcome.textCharCount,
                  usageFound: Boolean(outcome.usage),
                  usageOutputTokens: outcome.usage && typeof outcome.usage.outputTokens === 'number' ? outcome.usage.outputTokens : null,
                  chunkCount: outcome.chunkCount,
                  totalBytes: outcome.totalBytes,
                  ...getStreamObservationLogFields(outcome, { fallbackReason: reason }),
                });
              } else if (outcome.kind === 'timeout') {
                options.logRequest('stream timeout before usable output, falling back', {
                  upstreamName: selected.name,
                  upstreamUrl: selected.messagesUrl,
                  phase: outcome.phase,
                  fallbackReason: reason,
                  nextFallbackName: peekNextChannelName(),
                  streamMode,
                  wroteAnyEvent: outcome.wroteAnyEvent,
                  wroteTextContent: outcome.wroteTextContent,
                  textCharCount: outcome.textCharCount,
                  chunkCount: outcome.chunkCount,
                  totalBytes: outcome.totalBytes,
                  ...getStreamObservationLogFields(outcome, { phase: outcome.phase as Extract<AbortReason, { kind: 'timeout' }>['phase'], fallbackReason: reason }),
                });
              } else {
                options.logRequest('stream read error before usable output, falling back', {
                  upstreamName: selected.name,
                  upstreamUrl: selected.messagesUrl,
                  fallbackReason: reason,
                  nextFallbackName: peekNextChannelName(),
                  streamMode,
                  wroteAnyEvent: outcome.wroteAnyEvent,
                  wroteTextContent: outcome.wroteTextContent,
                  textCharCount: outcome.textCharCount,
                  chunkCount: outcome.chunkCount,
                  totalBytes: outcome.totalBytes,
                  error: outcome.error instanceof Error ? { name: outcome.error.name, message: outcome.error.message } : String(outcome.error),
                  ...getStreamObservationLogFields(outcome, { fallbackReason: reason }),
                });
              }
            budget.attemptsUsed += 1;
            continue;
          }

          if (!res.writableEnded && !res.destroyed) {
            if (!res.headersSent) {
              res.writeHead(upstreamResponse.status, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'access-control-allow-origin': '*',
              });
              res.end();
            } else {
              res.end();
            }
          }
          options.stats.responsesSseNormalized += 1;
          options.finish(upstreamResponse.status, 'stream fallback exhausted without usable output', {
            upstreamStatus: upstreamResponse.status,
            fallbackReason: reason,
          });
          return;
        } catch (error) {
          req.removeListener('close', onClientCloseStream);
          if (res.headersSent || res.writableEnded || res.destroyed) {
            markFailure('proxy_unhandled_error');
            recordFallbackReason(options.stats, 'proxy_unhandled_error', selected.name);
            const taggedError = error instanceof Error ? error : new Error(String(error));
            (taggedError as Error & { afterResponseCommit?: boolean }).afterResponseCommit = true;
            throw taggedError;
          }
          markFailure('unknown_upstream_error', { error, status: upstreamResponse.status });
          recordFallbackReason(options.stats, 'unknown_upstream_error', selected.name);

          if (canRetry()) {
            pendingFallbackReason = 'unknown_upstream_error';
            budget.attemptsUsed += 1;
            continue;
          }

          if (!res.writableEnded && !res.destroyed) {
            options.finish(502, 'stream read error', {
              upstreamName: selected.name,
              upstreamUrl: selected.messagesUrl,
            });
            sendJson(res, 502, makeAnthropicError('api_error', `${error instanceof Error ? error.message : String(error)} (fallback_exhausted)`));
          }
          return;
        }
      }

    const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';

    if (upstreamContentType.includes('text/event-stream') && !isStream) {
      const streamController = upstreamAttemptController.controller;
      let sseFallbackFailureRecorded = false;
      let sseFallbackReason: AnthropicFallbackReason | null = null;
      let nonStandardProbeTimedOut = false;
      options.logRequest('probing non-standard stream response', {
        upstreamName: selected.name,
        upstreamUrl: selected.messagesUrl,
        upstreamStatus: upstreamResponse.status,
        upstreamContentType,
      });
      try {
        const bodyText = await readTextWithTimeout(upstreamResponse, streamController, options.firstByteTimeoutMs);
        const { parseSse } = await import('./anthropic-sse.js');
        const events = parseSse(bodyText);
        logSseDebug(options.requestId, events, options.debugSse);
        const hasUsable = events.some(e => isAnthropicStreamEventWithUsableContent(e));
        nonStandardProbeTimedOut = !hasUsable && events.length === 0;

        if (hasUsable) {
          const synthesized = (await import('./anthropic-sse.js')).synthesizeAnthropicMessageFromEvents(events, requestedModel);
          if (synthesized && isAnthropicMessageWithUsableContent(synthesized)) {
            const synthesizedUsage = (await import('./anthropic-sse.js')).extractAnthropicUsageFromPayload(synthesized, requestedModel) as AnthropicStreamUsage | undefined;
            if (!synthesizedUsage) {
              // Usable content is already available; a missing usage block must not trigger another upstream attempt.
              options.logRequest('usable output without extractable usage; keeping the response', {
                upstreamContentType,
                upstreamStatus: upstreamResponse.status,
                upstreamName: selected.name,
                usageFound: false,
              });
            }
            markSuccess(synthesizedUsage);
            options.stats.responsesJson += 1;
            if (isFallbackAttempt) {
              options.logRequest('fallback upstream succeeded', {
                fallbackName: selected.name,
                fallbackUrl: selected.messagesUrl,
                upstreamStatus: upstreamResponse.status,
                upstreamContentType: upstreamContentType,
              });
            }
            options.finish(upstreamResponse.status, 'sse normalized to json', {
              upstreamStatus: upstreamResponse.status,
              upstreamContentType,
            });
            if (synthesizedUsage) {
              addUsageToStats(options.stats, synthesizedUsage);
            }
            sendJson(res, upstreamResponse.status, restoreClientModel(synthesized, requestedModel) as JsonValue);
            return;
          }
        }
      } catch (error) {
        const abortReason = getAbortReasonFromUnknown(streamController.signal.reason)
          ?? getAbortReasonFromUnknown(error)
          ?? ({ kind: 'timeout', phase: 'first-byte' } satisfies AbortReason);
        if (abortReason.kind === 'client_disconnect') {
          options.finish(499, 'client disconnected during non-standard stream probe', {
            source: abortReason.source ?? 'request',
            upstreamStatus: upstreamResponse.status,
            upstreamContentType,
            upstreamName: selected.name,
          });
          return;
        }
        void writeSseFailureDebug(options.requestId, upstreamContentType, upstreamResponse.status, '', {
          enabled: options.sseFailureDebugEnabled,
          dir: options.sseFailureDebugDir,
        });
        sseFallbackReason = abortReason.kind === 'timeout' ? 'headers_only_timeout' : 'unknown_upstream_error';
        if (sseFallbackReason === 'headers_only_timeout') {
          options.stats.upstreamTimeouts += 1;
        }
        markFailure(sseFallbackReason, {
          status: upstreamResponse.status,
          abortReason: streamController.signal.reason,
          error,
        });
        recordFallbackReason(options.stats, sseFallbackReason, selected.name);
        sseFallbackFailureRecorded = true;
        options.logRequest(sseFallbackReason === 'headers_only_timeout' ? 'non-standard stream probe timed out before meaningful output, falling back' : 'non-standard stream read error before usable output, falling back', {
          upstreamName: selected.name,
          upstreamUrl: selected.messagesUrl,
          phase: abortReason.kind === 'timeout' ? abortReason.phase : undefined,
          fallbackReason: sseFallbackReason,
          nextFallbackName: peekNextChannelName(),
        });
      }

      let nonStreamSseFallbackReason: AnthropicFallbackReason = 'stream_no_text_content';
      if (!sseFallbackFailureRecorded) {
        nonStreamSseFallbackReason = nonStandardProbeTimedOut ? 'headers_only_timeout' : 'stream_no_text_content';
        if (nonStreamSseFallbackReason === 'headers_only_timeout') {
          options.stats.upstreamTimeouts += 1;
        }
        markFailure(nonStreamSseFallbackReason, { status: upstreamResponse.status });
        recordFallbackReason(options.stats, nonStreamSseFallbackReason, selected.name);
        options.logRequest(nonStreamSseFallbackReason === 'headers_only_timeout' ? 'non-standard stream probe timed out before meaningful output, falling back' : 'non-standard stream completed without usable output, falling back', {
          upstreamName: selected.name,
          upstreamUrl: selected.messagesUrl,
          fallbackReason: nonStreamSseFallbackReason,
          nextFallbackName: peekNextChannelName(),
        });
      }

      if (canRetry()) {
        pendingFallbackReason = sseFallbackFailureRecorded ? sseFallbackReason : nonStreamSseFallbackReason;
        budget.attemptsUsed += 1;
        continue;
      }

      options.finish(502, 'stream fallback exhausted without usable output', {
        upstreamStatus: upstreamResponse.status,
        fallbackReason: sseFallbackFailureRecorded ? sseFallbackReason : nonStreamSseFallbackReason,
      });
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream returned SSE for non-stream request with no usable content (fallback_exhausted)'));
      return;
    }

    let upstreamText: string;
    try {
      upstreamText = await readTextWithTimeout(upstreamResponse, upstreamAttemptController.controller, options.firstByteTimeoutMs);
    } catch (error) {
      const abortReason = getAbortReasonFromUnknown(upstreamAttemptController?.controller.signal.reason)
        ?? (error instanceof Error && error.message === 'readTextWithTimeout: first-byte'
          ? ({ kind: 'timeout', phase: 'first-byte' } satisfies AbortReason)
          : undefined);

      if (abortReason?.kind === 'client_disconnect') {
        options.finish(499, 'client disconnected while reading upstream body', {
          source: abortReason.source ?? 'request',
          upstreamName: selected.name,
          upstreamContentType,
        });
        return;
      }

      if (abortReason?.kind === 'timeout') {
        options.stats.upstreamTimeouts += 1;
        markFailure('body_timeout', { abortReason, upstreamResponseObserved: false });
        recordFallbackReason(options.stats, 'headers_only_timeout', selected.name);

        if (canRetry()) {
          pendingFallbackReason = 'headers_only_timeout';
          options.logRequest('upstream body timeout, falling back', {
            phase: abortReason.phase,
            upstreamName: selected.name,
            upstreamContentType,
            nextFallbackName: peekNextChannelName(),
          });
          budget.attemptsUsed += 1;
          continue;
        }

        options.finish(504, 'upstream body timeout', {
          phase: abortReason.phase,
          upstreamName: selected.name,
          upstreamContentType,
        });
        sendJson(res, 504, makeAnthropicError('api_error', `Upstream body timeout: ${abortReason.phase}`));
        return;
      }

      if (canRetry()) {
        pendingFallbackReason = 'unknown_upstream_error';
        markFailure('unknown_upstream_error', { error });
        recordFallbackReason(options.stats, 'unknown_upstream_error', selected.name);
        options.logRequest('unhandled upstream body read error, falling back', {
          upstreamName: selected.name,
          upstreamContentType,
          nextFallbackName: peekNextChannelName(),
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        budget.attemptsUsed += 1;
        continue;
      }

      options.finish(502, 'unhandled upstream body read error', {
        upstreamName: selected.name,
        upstreamContentType,
      });
      sendJson(res, 502, makeAnthropicError('api_error', `${error instanceof Error ? error.message : String(error)} (fallback_exhausted)`));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      if (canRetry()) {
        pendingFallbackReason = 'unknown_upstream_error';
        markFailure('unknown_upstream_error', { status: upstreamResponse.status });
        recordFallbackReason(options.stats, 'unknown_upstream_error', selected.name);
        options.logRequest('upstream invalid json, falling back', {
          upstreamStatus: upstreamResponse.status,
          upstreamName: selected.name,
          nextFallbackName: peekNextChannelName(),
        });
        budget.attemptsUsed += 1;
        continue;
      }
      options.finish(502, 'upstream invalid json', {
        upstreamName: selected.name,
        upstreamUrl: selected.messagesUrl,
      });
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream messages endpoint returned invalid JSON (fallback_exhausted)'));
      return;
    }

    if (!upstreamResponse.ok) {
      const fallbackReason = getAnthropicFallbackReason(upstreamResponse.status, payload, {
        fallbackOnRetryable4xx: options.fallbackOnRetryable4xx,
        fallbackOnCompat4xx: options.fallbackOnCompat4xx,
        compatFallbackPatterns: options.compatFallbackPatterns,
        clientErrorPatterns: options.clientErrorPatterns,
      });
      if (fallbackReason) {
        markFailure(fallbackReason, { status: upstreamResponse.status, payload });
        recordFallbackReason(options.stats, fallbackReason, selected.name);
      }
      if (fallbackReason && canRetry()) {
        pendingFallbackReason = fallbackReason;
        options.logRequest('upstream error matched fallback policy', {
          upstreamName: selected.name,
          upstreamUrl: selected.messagesUrl,
          upstreamStatus: upstreamResponse.status,
          upstreamContentType,
          fallbackReason,
          nextFallbackName: peekNextChannelName(),
        });
        budget.attemptsUsed += 1;
        continue;
      }

      if (!fallbackReason) {
        options.logRequest('upstream error did not match fallback policy', {
          upstreamName: selected.name,
          upstreamUrl: selected.messagesUrl,
          upstreamStatus: upstreamResponse.status,
          upstreamContentType,
        });
      }
      options.finish(upstreamResponse.status, 'upstream json error', {
        upstreamStatus: upstreamResponse.status,
        upstreamContentType,
      });
      sendJson(res, upstreamResponse.status, payload as JsonValue);
      return;
    }

    if (!isAnthropicMessageWithUsableContent(payload)) {
      markFailure('empty_response', { status: upstreamResponse.status, payload });
      recordFallbackReason(options.stats, 'empty_response', selected.name);
      if (canRetry()) {
        pendingFallbackReason = 'empty_response';
        options.logRequest('upstream json response incomplete, falling back', {
          fallbackReason: 'empty_response',
          upstreamContentType,
          upstreamStatus: upstreamResponse.status,
          upstreamName: selected.name,
          usageFound: false,
          hasTextOutput: false,
          nextFallbackName: peekNextChannelName(),
        });
        budget.attemptsUsed += 1;
        continue;
      }
      options.stats.responsesJson += 1;
      options.finish(upstreamResponse.status, 'json response returned', {
        upstreamStatus: upstreamResponse.status,
        upstreamContentType,
        fallbackReason: 'empty_response',
      });
      sendJson(res, upstreamResponse.status, restoreClientModel(payload, requestedModel) as JsonValue);
      return;
    }

    const jsonUsage = (await import('./anthropic-sse.js')).extractAnthropicUsageFromPayload(payload, requestedModel);
    if (!jsonUsage) {
      // Usable content is already available; a missing usage block must not trigger another upstream attempt.
      options.logRequest('usable output without extractable usage; keeping the response', {
        upstreamContentType,
        upstreamStatus: upstreamResponse.status,
        upstreamName: selected.name,
        usageFound: false,
      });
    }
    if (jsonUsage) {
      addUsageToStats(options.stats, jsonUsage as AnthropicStreamUsage);
    }

    markSuccess(jsonUsage as AnthropicStreamUsage | undefined);
    options.stats.responsesJson += 1;

    if (isFallbackAttempt) {
      options.logRequest('fallback upstream succeeded', {
        fallbackName: selected.name,
        fallbackUrl: selected.messagesUrl,
        upstreamStatus: upstreamResponse.status,
        upstreamContentType,
      });
    }
    options.finish(upstreamResponse.status, 'json response returned', {
      upstreamStatus: upstreamResponse.status,
      upstreamContentType,
    });
    sendJson(res, upstreamResponse.status, restoreClientModel(payload, requestedModel) as JsonValue);
    return;
    } catch (error) {
      if ((error as Error & { afterResponseCommit?: boolean }).afterResponseCommit) {
        throw error;
      }
      markFailure('proxy_unhandled_error');
      recordFallbackReason(options.stats, 'proxy_unhandled_error', selected.name);
      throw error;
    } finally {
      upstreamAttemptController?.dispose();
      parentController.dispose();
      currentAttempt?.finish();
    }
  }
  } finally {
    clearTotalTimer();
    req.removeListener('close', onRequestClose);
  }
}

export async function readTextWithTimeout(response: Response, controller: AbortController, timeoutMs: number): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let sawFirstChunk = false;

  const resetBodyTimer = (phase: 'first-byte' | 'idle') => {
    if (bodyTimer) {
      clearTimeout(bodyTimer);
    }

    bodyTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort({ kind: 'timeout', phase });
      }
    }, timeoutMs);
  };

  resetBodyTimer('first-byte');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      chunks.push(decoder.decode(value, { stream: true }));
      sawFirstChunk = true;
      resetBodyTimer('idle');
    }

    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    if (bodyTimer) {
      clearTimeout(bodyTimer);
    }

    if (!sawFirstChunk) {
      chunks.push(decoder.decode());
    }

    reader.releaseLock();
  }
}
