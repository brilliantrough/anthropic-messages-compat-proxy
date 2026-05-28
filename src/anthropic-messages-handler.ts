import type { IncomingMessage, ServerResponse } from 'node:http';
import { type JsonValue } from './responses-input-normalization.js';
import { normalizeAnthropicMessageRequest } from './anthropic-input-normalization.js';
import type { UpstreamEndpoint } from './anthropic-config.js';
import { getAnthropicFallbackReason, isAnthropicMessageWithUsableContent, type AnthropicFallbackReason } from './anthropic-errors.js';
import { buildEndpointOrder, createFallbackBudget, canFallback, type EndpointHealthStore } from './proxy-core.js';
import {
  sendJson,
  makeAnthropicError,
  getRequestedModel,
  restoreClientModel,
  getOutboundHeaders,
} from './anthropic-http-utils.js';
import { type SseEvent, isAnthropicStreamEventWithUsableContent, formatSseEvent, parseSse } from './anthropic-sse.js';

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
};

async function readSseStreamAsText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}

function hasUsableContentInSseEvents(events: SseEvent[]): boolean {
  return events.some(event => isAnthropicStreamEventWithUsableContent(event));
}

function replaySseEvents(res: ServerResponse, events: SseEvent[]) {
  for (const event of events) {
    res.write(formatSseEvent(event));
  }
  res.end();
}

export async function handleMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestBody: import('./responses-input-normalization.js').JsonRecord,
  options: AnthropicMessagesHandlerOptions,
) {
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

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      });
    } catch (error) {
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      options.endpointHealthStore.markEndpointFailure(endpoint, 'connect_error');
      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }

      sendJson(res, 502, makeAnthropicError('api_error', `Upstream connect error: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';

    if (upstreamContentType.includes('text/event-stream')) {
      const sseText = await readSseStreamAsText(upstreamResponse);
      const events = parseSse(sseText);

      if (hasUsableContentInSseEvents(events)) {
        options.endpointHealthStore.releaseEndpointProbe(endpoint);
        options.endpointHealthStore.markEndpointSuccess(endpoint);
        res.writeHead(upstreamResponse.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        replaySseEvents(res, events);
        return;
      }

      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      options.endpointHealthStore.markEndpointFailure(endpoint, 'stream_no_usable_content');
      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }

      res.writeHead(upstreamResponse.status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      replaySseEvents(res, events);
      return;
    }

    const upstreamText = await upstreamResponse.text();
    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream messages endpoint returned invalid JSON'));
      return;
    }

    if (!upstreamResponse.ok) {
      const fallbackReason = getAnthropicFallbackReason(upstreamResponse.status);
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      if (fallbackReason) {
        options.endpointHealthStore.markEndpointFailure(endpoint, fallbackReason);
      }
      if (fallbackReason && canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }

      sendJson(res, upstreamResponse.status, payload as JsonValue);
      return;
    }

    if (!isAnthropicMessageWithUsableContent(payload)) {
      options.endpointHealthStore.releaseEndpointProbe(endpoint);
      options.endpointHealthStore.markEndpointFailure(endpoint, 'empty_response');
      if (canFallback(budget, i, endpoints, options.maxFallbackAttempts, options.maxFallbackTotalMs)) {
        budget.attemptsUsed += 1;
        continue;
      }
      console.warn('Non-stream fallback budget exhausted; returning empty upstream 200 response to client');
      sendJson(res, upstreamResponse.status, restoreClientModel(payload, requestedModel) as JsonValue);
      return;
    }

    options.endpointHealthStore.releaseEndpointProbe(endpoint);
    options.endpointHealthStore.markEndpointSuccess(endpoint);
    sendJson(res, upstreamResponse.status, restoreClientModel(payload, requestedModel) as JsonValue);
    return;
  }

  sendJson(res, 502, makeAnthropicError('api_error', 'All upstream endpoints exhausted'));
}
