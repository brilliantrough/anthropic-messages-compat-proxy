import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ClaudeBillingHeaderMode, type JsonValue, type JsonRecord } from './responses-input-normalization.js';
import { normalizeAnthropicMessageRequest } from './anthropic-input-normalization.js';
import type { UpstreamEndpoint, StreamMode } from './anthropic-config.js';
import { getAnthropicFallbackReason, isAnthropicMessageWithUsableContent, type AnthropicFallbackReason } from './anthropic-errors.js';
import { buildEndpointOrder, createFallbackBudget, canFallback, type EndpointHealthStore } from './proxy-core.js';
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
  primaryEndpoint: UpstreamEndpoint;
  fallbackEndpoints: UpstreamEndpoint[];
  anthropicVersion: string;
  anthropicBeta: string | undefined;
  defaultModel: string;
  modelMappings: Record<string, string>;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
  maxFallbackAttempts: number;
  maxFallbackTotalMs: number;
  endpointHealthStore: EndpointHealthStore;
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
  | { kind: 'timeout'; phase: string; wroteTextContent: boolean; wroteAnyEvent: boolean; startedStreaming: boolean; chunkCount: number; totalBytes: number; textCharCount: number; fallbackReason?: AnthropicFallbackReason }
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

function handleSseFallbackExhausted(res: ServerResponse) {
  sendJson(res, 502, makeAnthropicError('api_error', 'All upstream endpoints exhausted'));
}

function getFallbackBudgetRemainingMs(startedAt: number, maxFallbackTotalMs: number) {
  if (maxFallbackTotalMs <= 0) {
    return null;
  }
  return Math.max(0, maxFallbackTotalMs - (Date.now() - startedAt));
}

function logUnavailableEndpoint(options: AnthropicMessagesHandlerOptions, endpoint: UpstreamEndpoint) {
  const before = options.endpointHealthStore.getSnapshot(endpoint);
  const available = options.endpointHealthStore.isEndpointAvailable(endpoint);
  const after = options.endpointHealthStore.getSnapshot(endpoint);

  if (before.state === 'open' && after.state === 'half_open') {
    options.logRequest('endpoint circuit moved to half-open', {
      upstreamName: endpoint.name,
      upstreamUrl: endpoint.url,
      previousFailureReason: before.lastFailureReason,
    });
  }

  if (!available) {
    if (before.state === 'open' && before.remainingMs > 0) {
      options.logRequest('skipping upstream during circuit cooldown', {
        upstreamName: endpoint.name,
        upstreamUrl: endpoint.url,
        remainingMs: before.remainingMs,
        lastFailureReason: before.lastFailureReason,
        endpointHealth: before,
      });
    } else if (after.state === 'half_open') {
      options.logRequest('skipping upstream because half-open probe is already in flight', {
        upstreamName: endpoint.name,
        upstreamUrl: endpoint.url,
        halfOpenProbeInFlight: after.halfOpenProbeInFlight,
        endpointHealth: after,
      });
    }
  }

  return available;
}

function markEndpointFailureWithLog(
  options: AnthropicMessagesHandlerOptions,
  endpoint: UpstreamEndpoint,
  reason: AnthropicFallbackReason,
) {
  const before = options.endpointHealthStore.getSnapshot(endpoint);
  options.endpointHealthStore.markEndpointFailure(endpoint, reason);
  const after = options.endpointHealthStore.getSnapshot(endpoint);

  if (after.state === 'open' && (before.state !== 'open' || before.cooldownUntil !== after.cooldownUntil)) {
    options.logRequest('endpoint circuit opened', {
      upstreamName: endpoint.name,
      upstreamUrl: endpoint.url,
      failureReason: reason,
      cooldownMs: after.remainingMs,
      failureCount: after.failureCount,
      endpointHealth: after,
    });
    return;
  }

  options.logRequest('endpoint failure recorded without cooldown', {
    upstreamName: endpoint.name,
    upstreamUrl: endpoint.url,
    failureReason: reason,
    failureCount: after.failureCount,
    endpointHealth: after,
  });
}

function markEndpointSuccessWithLog(options: AnthropicMessagesHandlerOptions, endpoint: UpstreamEndpoint) {
  const before = options.endpointHealthStore.getSnapshot(endpoint);
  options.endpointHealthStore.markEndpointSuccess(endpoint);
  if (before.state !== 'closed' || before.failureCount > 0) {
    options.logRequest('endpoint circuit recovered', {
      upstreamName: endpoint.name,
      upstreamUrl: endpoint.url,
      previousState: before.state,
      previousFailureReason: before.lastFailureReason,
    });
  }
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
  const upstreamBody = normalizeAnthropicMessageRequest(requestBody, {
    defaultModel: options.defaultModel,
    modelMappings: options.modelMappings,
    claudeBillingHeaderMode: options.claudeBillingHeaderMode,
  });
  logRequestBodiesPreview(options.requestId, requestBody, upstreamBody, {
    enabled: options.logRequestBodies,
    claudeBillingHeaderMode: options.claudeBillingHeaderMode,
  });

  const endpoints = buildEndpointOrder(options.primaryEndpoint, options.fallbackEndpoints);
  const budget = createFallbackBudget();
  let pendingFallbackReason: AnthropicFallbackReason | null = null;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    if (!logUnavailableEndpoint(options, endpoint)) {
      continue;
    }
    if (endpoint.isFallback || i > 0) {
      options.logRequest('attempting fallback upstream', {
        fallbackName: endpoint.name,
        fallbackUrl: endpoint.url,
        attempt: budget.attemptsUsed,
        totalFallbacks: endpoints.length - 1,
        fallbackAttemptsUsed: budget.attemptsUsed,
        fallbackReason: pendingFallbackReason,
        fallbackBudgetRemainingMs: getFallbackBudgetRemainingMs(budget.startedAt, options.maxFallbackTotalMs),
        endpointHealth: options.endpointHealthStore.getSnapshot(endpoint),
      });
    }
    options.endpointHealthStore.reserveEndpointProbe(endpoint);
    const headers = getOutboundHeaders(endpoint.apiKey, options.anthropicVersion, options.anthropicBeta, req.headers);

    const parentController = new AbortController();
    const linkedReq = req;
    const onClientClose = () => {
      parentController.abort({ kind: 'client_disconnect', source: 'request' } satisfies AbortReason);
    };
    linkedReq.on('close', onClientClose);

    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.totalRequestTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        if (!parentController.signal.aborted) {
          parentController.abort({ kind: 'timeout', phase: 'total' } satisfies AbortReason);
        }
      }, options.totalRequestTimeoutMs);
    }
    const clearTotalTimer = () => {
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = undefined; }
    };
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
      });

      upstreamAttemptController = createLinkedAbortController(parentController.signal);
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchWithTimeout(
          endpoint.url,
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
        options.endpointHealthStore.releaseEndpointProbe(endpoint);
        const abortReason = getAbortReasonFromUnknown(upstreamAttemptController?.controller.signal.reason) ?? getAbortReasonFromUnknown(error);
        if (abortReason?.kind === 'client_disconnect') {
          options.finish(499, 'request cancelled by client', {
            source: abortReason.source ?? 'request',
            upstreamName: endpoint.name,
          });
          return;
        }
        const failureReason = abortReason?.kind === 'timeout' && abortReason.phase === 'connect'
          ? 'connect_timeout'
          : 'connect_error';
        markEndpointFailureWithLog(options, endpoint, failureReason);
        recordFallbackReason(options.stats, failureReason, endpoint.name);
        if (failureReason === 'connect_timeout') {
          options.stats.upstreamTimeouts += 1;
        }

        if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
          pendingFallbackReason = failureReason;
          options.logRequest(failureReason === 'connect_timeout' ? 'upstream connect timeout encountered, falling back' : 'upstream connect error encountered, falling back', {
            upstreamName: endpoint.name,
            upstreamUrl: endpoint.url,
            phase: abortReason?.kind === 'timeout' ? abortReason.phase : undefined,
            errorName: error instanceof Error ? error.name : null,
            errorMessage: error instanceof Error ? error.message : String(error),
            nextFallbackName: endpoints[i + 1]?.name ?? null,
          });
          budget.attemptsUsed += 1;
          continue;
        }

        options.finish(502, failureReason === 'connect_timeout' ? 'upstream connect timeout' : 'upstream connect error', {
          upstreamName: endpoint.name,
          upstreamUrl: endpoint.url,
        });
        sendJson(res, 502, makeAnthropicError('api_error', `${failureReason === 'connect_timeout' ? 'Upstream connect timeout' : 'Upstream connect error'}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      linkedReq.removeListener('close', onClientClose);

      if (isStream) {
        options.logRequest('stream passthrough started', {
          upstreamName: endpoint.name,
          upstreamStatus: upstreamResponse.status,
          upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
          streamMode,
        });
        const streamController = createLinkedAbortController(parentController.signal).controller;
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
            options.endpointHealthStore.releaseEndpointProbe(endpoint);
            options.finish(499, 'client disconnected during stream passthrough', {
              source: outcome.source ?? 'request',
              upstreamStatus: upstreamResponse.status,
              upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
              chunkCount: outcome.chunkCount,
              totalBytes: outcome.totalBytes,
              streamMode,
              upstreamName: endpoint.name,
            });
            return;
          }

          if (outcome.kind === 'completed' || outcome.kind === 'timeout' || outcome.kind === 'error') {
            if (outcome.wroteTextContent) {
              options.endpointHealthStore.releaseEndpointProbe(endpoint);
              if (outcome.kind === 'completed' && outcome.usage) {
                addUsageToStats(options.stats, outcome.usage);
              }
              markEndpointSuccessWithLog(options, endpoint);
              if (streamMode === 'normalized') {
                options.stats.responsesSseNormalized += 1;
              } else {
                options.stats.responsesSseRaw += 1;
              }
              if (endpoint.isFallback || i > 0) {
                options.logRequest('fallback upstream succeeded', {
                  fallbackName: endpoint.name,
                  fallbackUrl: endpoint.url,
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

          options.endpointHealthStore.releaseEndpointProbe(endpoint);
          if (outcome.kind === 'timeout') {
            options.stats.upstreamTimeouts += 1;
          }
          const reason = outcome.fallbackReason ?? 'stream_no_text_content';
          markEndpointFailureWithLog(options, endpoint, reason);
          recordFallbackReason(options.stats, reason, endpoint.name);

          if (outcome.fallbackReason && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
            pendingFallbackReason = reason;
            if (outcome.kind === 'completed') {
                options.logRequest('stream completed without usable output, falling back', {
                  upstreamName: endpoint.name,
                  upstreamUrl: endpoint.url,
                  fallbackReason: reason,
                  nextFallbackName: endpoints[i + 1]?.name ?? null,
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
                  upstreamName: endpoint.name,
                  upstreamUrl: endpoint.url,
                  phase: outcome.phase,
                  fallbackReason: reason,
                  nextFallbackName: endpoints[i + 1]?.name ?? null,
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
                  upstreamName: endpoint.name,
                  upstreamUrl: endpoint.url,
                  fallbackReason: reason,
                  nextFallbackName: endpoints[i + 1]?.name ?? null,
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
            options.endpointHealthStore.releaseEndpointProbe(endpoint);
            markEndpointFailureWithLog(options, endpoint, 'proxy_unhandled_error');
            recordFallbackReason(options.stats, 'proxy_unhandled_error', endpoint.name);
            const taggedError = error instanceof Error ? error : new Error(String(error));
            (taggedError as Error & { afterResponseCommit?: boolean }).afterResponseCommit = true;
            throw taggedError;
          }
          options.endpointHealthStore.releaseEndpointProbe(endpoint);
          markEndpointFailureWithLog(options, endpoint, 'unknown_upstream_error');
          recordFallbackReason(options.stats, 'unknown_upstream_error', endpoint.name);

          if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
            pendingFallbackReason = 'unknown_upstream_error';
            budget.attemptsUsed += 1;
            continue;
          }

          if (!res.writableEnded && !res.destroyed) {
            options.finish(502, 'stream read error', {
              upstreamName: endpoint.name,
              upstreamUrl: endpoint.url,
            });
            sendJson(res, 502, makeAnthropicError('api_error', error instanceof Error ? error.message : String(error)));
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
        upstreamName: endpoint.name,
        upstreamUrl: endpoint.url,
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
            options.endpointHealthStore.releaseEndpointProbe(endpoint);
            if (!synthesizedUsage && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
              markEndpointFailureWithLog(options, endpoint, 'stream_missing_usage');
              recordFallbackReason(options.stats, 'stream_missing_usage', endpoint.name);
              pendingFallbackReason = 'stream_missing_usage';
              options.logRequest('upstream json response incomplete, falling back', {
                fallbackReason: 'stream_missing_usage',
                upstreamContentType,
                upstreamStatus: upstreamResponse.status,
                upstreamName: endpoint.name,
                usageFound: false,
                hasTextOutput: true,
                nextFallbackName: endpoints[i + 1]?.name ?? null,
              });
              budget.attemptsUsed += 1;
              continue;
            }
            markEndpointSuccessWithLog(options, endpoint);
            options.stats.responsesJson += 1;
            if (endpoint.isFallback || i > 0) {
              options.logRequest('fallback upstream succeeded', {
                fallbackName: endpoint.name,
                fallbackUrl: endpoint.url,
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
        options.endpointHealthStore.releaseEndpointProbe(endpoint);
        if (abortReason.kind === 'client_disconnect') {
          options.finish(499, 'client disconnected during non-standard stream probe', {
            source: abortReason.source ?? 'request',
            upstreamStatus: upstreamResponse.status,
            upstreamContentType,
            upstreamName: endpoint.name,
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
        markEndpointFailureWithLog(options, endpoint, sseFallbackReason);
        recordFallbackReason(options.stats, sseFallbackReason, endpoint.name);
        sseFallbackFailureRecorded = true;
        options.logRequest(sseFallbackReason === 'headers_only_timeout' ? 'non-standard stream probe timed out before meaningful output, falling back' : 'non-standard stream read error before usable output, falling back', {
          upstreamName: endpoint.name,
          upstreamUrl: endpoint.url,
          phase: abortReason.kind === 'timeout' ? abortReason.phase : undefined,
          fallbackReason: sseFallbackReason,
          nextFallbackName: endpoints[i + 1]?.name ?? null,
        });
      }

      let nonStreamSseFallbackReason: AnthropicFallbackReason = 'stream_no_text_content';
      if (!sseFallbackFailureRecorded) {
        options.endpointHealthStore.releaseEndpointProbe(endpoint);
        nonStreamSseFallbackReason = nonStandardProbeTimedOut ? 'headers_only_timeout' : 'stream_no_text_content';
        if (nonStreamSseFallbackReason === 'headers_only_timeout') {
          options.stats.upstreamTimeouts += 1;
        }
        markEndpointFailureWithLog(options, endpoint, nonStreamSseFallbackReason);
        recordFallbackReason(options.stats, nonStreamSseFallbackReason, endpoint.name);
        options.logRequest(nonStreamSseFallbackReason === 'headers_only_timeout' ? 'non-standard stream probe timed out before meaningful output, falling back' : 'non-standard stream completed without usable output, falling back', {
          upstreamName: endpoint.name,
          upstreamUrl: endpoint.url,
          fallbackReason: nonStreamSseFallbackReason,
          nextFallbackName: endpoints[i + 1]?.name ?? null,
        });
      }

      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        pendingFallbackReason = sseFallbackFailureRecorded ? sseFallbackReason : nonStreamSseFallbackReason;
        budget.attemptsUsed += 1;
        continue;
      }

      options.finish(502, 'stream fallback exhausted without usable output', {
        upstreamStatus: upstreamResponse.status,
        fallbackReason: sseFallbackFailureRecorded ? sseFallbackReason : nonStreamSseFallbackReason,
      });
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream returned SSE for non-stream request with no usable content'));
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
      options.endpointHealthStore.releaseEndpointProbe(endpoint);

      if (abortReason?.kind === 'client_disconnect') {
        options.finish(499, 'client disconnected while reading upstream body', {
          source: abortReason.source ?? 'request',
          upstreamName: endpoint.name,
          upstreamContentType,
        });
        return;
      }

      if (abortReason?.kind === 'timeout') {
        options.stats.upstreamTimeouts += 1;
        markEndpointFailureWithLog(options, endpoint, 'body_timeout');
        recordFallbackReason(options.stats, 'headers_only_timeout', endpoint.name);

        if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
          pendingFallbackReason = 'headers_only_timeout';
          options.logRequest('upstream body timeout, falling back', {
            phase: abortReason.phase,
            upstreamName: endpoint.name,
            upstreamContentType,
            nextFallbackName: endpoints[i + 1]?.name ?? null,
          });
          budget.attemptsUsed += 1;
          continue;
        }

        options.finish(504, 'upstream body timeout', {
          phase: abortReason.phase,
          upstreamName: endpoint.name,
          upstreamContentType,
        });
        sendJson(res, 504, makeAnthropicError('api_error', `Upstream body timeout: ${abortReason.phase}`));
        return;
      }

      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        pendingFallbackReason = 'unknown_upstream_error';
        markEndpointFailureWithLog(options, endpoint, 'unknown_upstream_error');
        recordFallbackReason(options.stats, 'unknown_upstream_error', endpoint.name);
        options.logRequest('unhandled upstream body read error, falling back', {
          upstreamName: endpoint.name,
          upstreamContentType,
          nextFallbackName: endpoints[i + 1]?.name ?? null,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        budget.attemptsUsed += 1;
        continue;
      }

      options.finish(502, 'unhandled upstream body read error', {
        upstreamName: endpoint.name,
        upstreamContentType,
      });
      sendJson(res, 502, makeAnthropicError('api_error', error instanceof Error ? error.message : String(error)));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        pendingFallbackReason = 'unknown_upstream_error';
        markEndpointFailureWithLog(options, endpoint, 'unknown_upstream_error');
        recordFallbackReason(options.stats, 'unknown_upstream_error', endpoint.name);
        options.logRequest('upstream invalid json, falling back', {
          upstreamStatus: upstreamResponse.status,
          upstreamName: endpoint.name,
          nextFallbackName: endpoints[i + 1]?.name ?? null,
        });
        budget.attemptsUsed += 1;
        continue;
      }
      options.finish(502, 'upstream invalid json', {
        upstreamName: endpoint.name,
        upstreamUrl: endpoint.url,
      });
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream messages endpoint returned invalid JSON'));
      return;
    }

    if (!upstreamResponse.ok) {
      const fallbackReason = getAnthropicFallbackReason(upstreamResponse.status, payload, {
        fallbackOnRetryable4xx: options.fallbackOnRetryable4xx,
        fallbackOnCompat4xx: options.fallbackOnCompat4xx,
        compatFallbackPatterns: options.compatFallbackPatterns,
        clientErrorPatterns: options.clientErrorPatterns,
      });
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      if (fallbackReason) {
        markEndpointFailureWithLog(options, endpoint, fallbackReason);
        recordFallbackReason(options.stats, fallbackReason, endpoint.name);
      }
      if (fallbackReason && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        pendingFallbackReason = fallbackReason;
        options.logRequest('upstream error matched fallback policy', {
          upstreamName: endpoint.name,
          upstreamUrl: endpoint.url,
          upstreamStatus: upstreamResponse.status,
          upstreamContentType,
          fallbackReason,
          nextFallbackName: endpoints[i + 1]?.name ?? null,
        });
        budget.attemptsUsed += 1;
        continue;
      }

      if (!fallbackReason) {
        options.logRequest('upstream error did not match fallback policy', {
          upstreamName: endpoint.name,
          upstreamUrl: endpoint.url,
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
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      markEndpointFailureWithLog(options, endpoint, 'empty_response');
      recordFallbackReason(options.stats, 'empty_response', endpoint.name);
      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        pendingFallbackReason = 'empty_response';
        options.logRequest('upstream json response incomplete, falling back', {
          fallbackReason: 'empty_response',
          upstreamContentType,
          upstreamStatus: upstreamResponse.status,
          upstreamName: endpoint.name,
          usageFound: false,
          hasTextOutput: false,
          nextFallbackName: endpoints[i + 1]?.name ?? null,
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
    if (!jsonUsage && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      markEndpointFailureWithLog(options, endpoint, 'stream_missing_usage');
      recordFallbackReason(options.stats, 'stream_missing_usage', endpoint.name);
      pendingFallbackReason = 'stream_missing_usage';
      options.logRequest('upstream json response incomplete, falling back', {
        fallbackReason: 'stream_missing_usage',
        upstreamContentType,
        upstreamStatus: upstreamResponse.status,
        upstreamName: endpoint.name,
        usageFound: false,
        hasTextOutput: true,
        nextFallbackName: endpoints[i + 1]?.name ?? null,
      });
      budget.attemptsUsed += 1;
      continue;
    }
    if (jsonUsage) {
      addUsageToStats(options.stats, jsonUsage as AnthropicStreamUsage);
    }

    options.endpointHealthStore.releaseEndpointProbe(endpoint);
    markEndpointSuccessWithLog(options, endpoint);
    options.stats.responsesJson += 1;

    if (endpoint.isFallback || i > 0) {
      options.logRequest('fallback upstream succeeded', {
        fallbackName: endpoint.name,
        fallbackUrl: endpoint.url,
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
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      markEndpointFailureWithLog(options, endpoint, 'proxy_unhandled_error');
      recordFallbackReason(options.stats, 'proxy_unhandled_error', endpoint.name);
      throw error;
    } finally {
      upstreamAttemptController?.dispose();
      clearTotalTimer();
    }
  }

  options.finish(502, 'all upstream endpoints exhausted', {
    fallbackReason: pendingFallbackReason,
  });
  handleSseFallbackExhausted(res);
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
