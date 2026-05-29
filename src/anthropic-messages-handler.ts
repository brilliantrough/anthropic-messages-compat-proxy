import type { IncomingMessage, ServerResponse } from 'node:http';
import { type JsonValue, type JsonRecord } from './responses-input-normalization.js';
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
  isAnthropicStreamEventWithUsableContent,
  formatSseEvent,
  parseSseChunk,
  parseStreamPayload,
  normalizeAnthropicStreamEvent,
  makeAnthropicStreamError,
  extractAnthropicUsageFromStreamPayload,
  type AnthropicStreamUsage,
} from './anthropic-sse.js';

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
    fallbackReasons: {},
    fallbackByUpstream: {},
  };
}

export function recordFallbackReason(stats: ProxyStats, reason: string, upstreamName: string) {
  stats.fallbackReasons[reason] = (stats.fallbackReasons[reason] ?? 0) + 1;
  const perUpstream = stats.fallbackByUpstream[upstreamName] ?? {};
  perUpstream[reason] = (perUpstream[reason] ?? 0) + 1;
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
  primaryEndpoint: UpstreamEndpoint;
  fallbackEndpoints: UpstreamEndpoint[];
  anthropicVersion: string;
  anthropicBeta: string | undefined;
  defaultModel: string;
  modelMappings: Record<string, string>;
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
  stats: ProxyStats;
};

type AbortReason =
  | { kind: 'timeout'; phase: 'connect' | 'first-byte' | 'first-text' | 'idle' | 'total' }
  | { kind: 'client_disconnect' };

type StreamOutcome =
  | { kind: 'completed'; wroteTextContent: boolean; usage?: AnthropicStreamUsage; fallbackReason?: AnthropicFallbackReason }
  | { kind: 'timeout'; phase: string; wroteTextContent: boolean; fallbackReason?: AnthropicFallbackReason }
  | { kind: 'error'; wroteTextContent: boolean; error: unknown; fallbackReason?: AnthropicFallbackReason };

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

async function pipeProgressiveSse(
  upstreamResponse: Response,
  res: ServerResponse,
  requestedModel: string,
  streamMode: StreamMode,
  controller: AbortController,
  firstByteTimeoutMs: number,
  firstTextTimeoutMs: number,
  streamIdleTimeoutMs: number,
): Promise<StreamOutcome> {
  let wroteTextContent = false;
  let startedStreaming = false;
  const pendingEvents: SseEvent[] = [];
  let accumulatedUsage: AnthropicStreamUsage | undefined;

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
    for (const event of pendingEvents) {
      res.write(formatSseEvent(normalizeAnthropicStreamEvent(event, requestedModel)));
    }
    pendingEvents.length = 0;
  };

  if (!upstreamResponse.body) {
    ensureHeaders();
    res.end();
    return { kind: 'completed', wroteTextContent: false, fallbackReason: 'empty_response' };
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
      const { done, value } = await reader.read();
      if (done) break;

      if (!value || value.byteLength === 0) continue;

      resetIdleTimer();

      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }

      if (streamMode === 'raw') {
        ensureHeaders();
        startedStreaming = true;
        res.write(Buffer.from(value));
        wroteTextContent = true;
        pending = '';
        continue;
      }

      const textChunk = decoder.decode(value, { stream: true });
      pending += textChunk;

      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? '';

      for (const block of blocks) {
        if (!block.trim()) continue;

        const event = parseSseChunk(block);
        const payload = parseStreamPayload(event.data);

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
    pending += finalChunk;
    if (pending.trim()) {
      const event = parseSseChunk(pending);
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

    if (controller.signal.aborted) {
      const reason = controller.signal.reason as AbortReason | undefined;
      if (reason?.kind === 'timeout') {
        if (wroteTextContent && !res.writableEnded && !res.destroyed) {
          const errorEvent = makeAnthropicStreamError('Stream timeout', 'server_error');
          res.write(formatSseEvent(errorEvent));
          res.end();
        }
        return {
          kind: 'timeout',
          phase: reason.phase,
          wroteTextContent,
          fallbackReason: !wroteTextContent ? 'connect_error' : undefined,
        };
      }
      if (reason?.kind === 'client_disconnect') {
        if (startedStreaming && !res.writableEnded && !res.destroyed) {
          res.end();
        }
        return { kind: 'completed', wroteTextContent };
      }
    }
    if (!res.writableEnded && !res.destroyed) {
      if (wroteTextContent) {
        const errorEvent = makeAnthropicStreamError('Stream error', 'server_error');
        res.write(formatSseEvent(errorEvent));
        res.end();
      }
    }
    return { kind: 'error', wroteTextContent, error, fallbackReason: !wroteTextContent ? 'stream_no_usable_content' : undefined };
  }

  if (wroteTextContent && !res.writableEnded && !res.destroyed) {
    res.end();
  }

  if (!wroteTextContent) {
    return { kind: 'completed', wroteTextContent: false, usage: undefined, fallbackReason: 'stream_no_usable_content' };
  }

  return { kind: 'completed', wroteTextContent: true, usage: accumulatedUsage };
}

function handleSseFallbackExhausted(res: ServerResponse, stats: ProxyStats) {
  recordStatus(stats, 502);
  sendJson(res, 502, makeAnthropicError('api_error', 'All upstream endpoints exhausted'));
}

export async function handleMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestBody: JsonRecord,
  options: AnthropicMessagesHandlerOptions,
): Promise<void> {
  const isStream = requestBody.stream === true || (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/event-stream'));
  const streamMode = getStreamMode(req, requestBody, options.defaultStreamMode);
  const requestedModel = getRequestedModel(requestBody, options.defaultModel);
  const upstreamBody = normalizeAnthropicMessageRequest(requestBody, {
    defaultModel: options.defaultModel,
    modelMappings: options.modelMappings,
    claudeBillingHeaderMode: 'strip_line',
  });

  const endpoints = buildEndpointOrder(options.primaryEndpoint, options.fallbackEndpoints);
  const budget = createFallbackBudget();

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    if (!options.endpointHealthStore.isEndpointAvailable(endpoint)) {
      continue;
    }
    options.endpointHealthStore.reserveEndpointProbe(endpoint);
    const headers = getOutboundHeaders(endpoint.apiKey, options.anthropicVersion, options.anthropicBeta, req.headers);

    const parentController = new AbortController();
    const linkedReq = req;
    const onClientClose = () => {
      parentController.abort({ kind: 'client_disconnect' } satisfies AbortReason);
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

    try {
      const connectTimeoutMs = isStream ? options.upstreamTimeoutMs : options.nonStreamingRequestTimeoutMs;

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetchWithTimeout(
          endpoint.url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...upstreamBody, ...(isStream ? { stream: true } : {}) }),
          },
          createLinkedAbortController(parentController.signal).controller,
          connectTimeoutMs,
        );
      } catch (error) {
        linkedReq.removeListener('close', onClientClose);
        options.endpointHealthStore.releaseEndpointProbe(endpoint);
        options.endpointHealthStore.markEndpointFailure(endpoint, 'connect_error');
        recordFallbackReason(options.stats, 'connect_error', endpoint.name);
        options.stats.upstreamTimeouts += 1;

        if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
          budget.attemptsUsed += 1;
          continue;
        }

        recordStatus(options.stats, 502);
        sendJson(res, 502, makeAnthropicError('api_error', `Upstream connect error: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      linkedReq.removeListener('close', onClientClose);

      if (isStream) {
        const streamController = createLinkedAbortController(parentController.signal).controller;
        const onClientCloseStream = () => {
          streamController.abort({ kind: 'client_disconnect' } satisfies AbortReason);
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
          );

          req.removeListener('close', onClientCloseStream);

          if (outcome.kind === 'completed' || outcome.kind === 'timeout' || outcome.kind === 'error') {
            if (outcome.wroteTextContent) {
              options.endpointHealthStore.releaseEndpointProbe(endpoint);
              if (outcome.kind === 'completed' && outcome.usage) {
                addUsageToStats(options.stats, outcome.usage);
              }
              options.endpointHealthStore.markEndpointSuccess(endpoint);
              if (streamMode === 'normalized') {
                options.stats.responsesSseNormalized += 1;
              } else {
                options.stats.responsesSseRaw += 1;
              }
              return;
            }
          }

          options.endpointHealthStore.releaseEndpointProbe(endpoint);
          const reason = outcome.fallbackReason ?? 'stream_no_usable_content';
          options.endpointHealthStore.markEndpointFailure(endpoint, reason);
          recordFallbackReason(options.stats, reason, endpoint.name);

          if (outcome.fallbackReason && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
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
          return;
        } catch (error) {
          req.removeListener('close', onClientCloseStream);
          options.endpointHealthStore.releaseEndpointProbe(endpoint);
          options.endpointHealthStore.markEndpointFailure(endpoint, 'unknown_upstream_error');
          recordFallbackReason(options.stats, 'unknown_upstream_error', endpoint.name);

          if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
            budget.attemptsUsed += 1;
            continue;
          }

          if (!res.writableEnded && !res.destroyed) {
            recordStatus(options.stats, 502);
            sendJson(res, 502, makeAnthropicError('api_error', error instanceof Error ? error.message : String(error)));
          }
          return;
        }
      }

    const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';

    if (upstreamContentType.includes('text/event-stream') && !isStream) {
      const streamController = createLinkedAbortController(parentController.signal).controller;
      try {
        const bodyText = await readTextWithTimeout(upstreamResponse, streamController, options.firstByteTimeoutMs);
        const { parseSse } = await import('./anthropic-sse.js');
        const events = parseSse(bodyText);
        const hasUsable = events.some(e => isAnthropicStreamEventWithUsableContent(e));

        if (hasUsable) {
          const synthesized = (await import('./anthropic-sse.js')).synthesizeAnthropicMessageFromEvents(events, requestedModel);
          if (synthesized && isAnthropicMessageWithUsableContent(synthesized)) {
            options.endpointHealthStore.releaseEndpointProbe(endpoint);
            options.endpointHealthStore.markEndpointSuccess(endpoint);
            options.stats.responsesJson += 1;
            recordStatus(options.stats, upstreamResponse.status);
            sendJson(res, upstreamResponse.status, restoreClientModel(synthesized, requestedModel) as JsonValue);
            return;
          }
        }
      } catch {
        options.endpointHealthStore.releaseEndpointProbe(endpoint);
        options.endpointHealthStore.markEndpointFailure(endpoint, 'unknown_upstream_error');
        recordFallbackReason(options.stats, 'unknown_upstream_error', endpoint.name);
      }

      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      options.endpointHealthStore.markEndpointFailure(endpoint, 'stream_no_usable_content');
      recordFallbackReason(options.stats, 'stream_no_usable_content', endpoint.name);

      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }

      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream returned SSE for non-stream request with no usable content'));
      return;
    }

    const upstreamText = await upstreamResponse.text();
    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      recordStatus(options.stats, 502);
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream messages endpoint returned invalid JSON'));
      return;
    }

    if (!upstreamResponse.ok) {
      const fallbackReason = getAnthropicFallbackReason(upstreamResponse.status);
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      if (fallbackReason) {
        options.endpointHealthStore.markEndpointFailure(endpoint, fallbackReason);
        recordFallbackReason(options.stats, fallbackReason, endpoint.name);
      }
      if (fallbackReason && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }

      recordStatus(options.stats, upstreamResponse.status);
      sendJson(res, upstreamResponse.status, payload as JsonValue);
      return;
    }

    if (!isAnthropicMessageWithUsableContent(payload)) {
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      options.endpointHealthStore.markEndpointFailure(endpoint, 'empty_response');
      recordFallbackReason(options.stats, 'empty_response', endpoint.name);
      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }
      options.stats.responsesJson += 1;
      recordStatus(options.stats, upstreamResponse.status);
      sendJson(res, upstreamResponse.status, restoreClientModel(payload, requestedModel) as JsonValue);
      return;
    }

    options.endpointHealthStore.releaseEndpointProbe(endpoint);
    options.endpointHealthStore.markEndpointSuccess(endpoint);
    options.stats.responsesJson += 1;

    const jsonUsage = (await import('./anthropic-sse.js')).extractAnthropicUsageFromPayload(payload, requestedModel);
    if (jsonUsage) {
      addUsageToStats(options.stats, jsonUsage as AnthropicStreamUsage);
    }

    recordStatus(options.stats, upstreamResponse.status);
    sendJson(res, upstreamResponse.status, restoreClientModel(payload, requestedModel) as JsonValue);
    return;
    } finally {
      clearTotalTimer();
    }
  }

  handleSseFallbackExhausted(res, options.stats);
}

async function readTextWithTimeout(response: Response, controller: AbortController, timeoutMs: number): Promise<string> {
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      const reason: AbortReason = { kind: 'timeout', phase: 'first-byte' };
      controller.abort(reason);
    }
  }, timeoutMs);

  try {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: string[] = [];

    while (true) {
      if (controller.signal.aborted) {
        reader.cancel().catch(() => {/* best-effort */});
        const reason = controller.signal.reason as AbortReason | undefined;
        if (reason?.kind === 'timeout') {
          throw new Error(`readTextWithTimeout: ${reason.phase}`);
        }
        if (reason?.kind === 'client_disconnect') {
          throw new Error('readTextWithTimeout: client disconnected');
        }
        throw new Error('readTextWithTimeout: aborted');
      }

      try {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value, { stream: true }));
      } catch (err) {
        if (controller.signal.aborted) {
          reader.cancel().catch(() => {/* best-effort */});
          const reason = controller.signal.reason as AbortReason | undefined;
          if (reason?.kind === 'timeout') {
            throw new Error(`readTextWithTimeout: ${reason.phase}`);
          }
          throw new Error('readTextWithTimeout: aborted');
        }
        throw err;
      }
    }

    return chunks.join('') + new TextDecoder().decode();
  } finally {
    clearTimeout(timer);
  }
}
