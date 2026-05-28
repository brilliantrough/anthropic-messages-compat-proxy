import type { IncomingMessage, ServerResponse } from 'node:http';
import { isJsonRecord, type JsonRecord, type JsonValue } from './responses-input-normalization.js';
import type { UpstreamEndpoint } from './anthropic-config.js';

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

export function sendJson(res: ServerResponse, statusCode: number, body: JsonValue) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta',
  });
  res.end(JSON.stringify(body, null, 2));
}

export function makeAnthropicError(type: string, message: string) {
  return {
    type: 'error',
    error: { type, message },
  } as JsonRecord;
}

export function getRequestedModel(requestBody: JsonRecord, defaultModel: string) {
  return typeof requestBody.model === 'string' && requestBody.model.trim().length > 0
    ? requestBody.model
    : defaultModel;
}

export function restoreClientModel(payload: unknown, requestedModel: string) {
  if (!isJsonRecord(payload)) {
    return payload;
  }

  return {
    ...payload,
    model: requestedModel,
  } as JsonRecord;
}

export function getOutboundHeaders(
  apiKey: string,
  anthropicVersion: string,
  anthropicBeta: string | undefined,
  inboundHeaders: IncomingMessage['headers'],
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': typeof inboundHeaders['anthropic-version'] === 'string'
      ? inboundHeaders['anthropic-version']
      : anthropicVersion,
  };

  const inboundBeta = inboundHeaders['anthropic-beta'];
  const beta = typeof inboundBeta === 'string' && inboundBeta.trim().length > 0
    ? inboundBeta
    : anthropicBeta;
  if (beta) {
    headers['anthropic-beta'] = beta;
  }

  return headers;
}

export function applyModelMappingsToModelsPayload(payload: unknown, modelMappings: Record<string, string>) {
  if (!isJsonRecord(payload) || !Array.isArray(payload.data) || Object.keys(modelMappings).length === 0) {
    return payload;
  }

  const data = payload.data.map(item => (isJsonRecord(item) ? { ...item } : item));
  const entriesById = new Map<string, JsonRecord>();
  const existingIds = new Set<string>();

  for (const item of data) {
    if (!isJsonRecord(item) || typeof item.id !== 'string') {
      continue;
    }
    entriesById.set(item.id, item);
    existingIds.add(item.id);
  }

  for (const [alias, target] of Object.entries(modelMappings)) {
    if (existingIds.has(alias)) {
      continue;
    }

    const targetEntry = entriesById.get(target);
    if (!targetEntry) {
      continue;
    }

    data.push({
      ...targetEntry,
      id: alias,
    });
    existingIds.add(alias);
  }

  return {
    ...payload,
    data,
  } as JsonRecord;
}

export async function pipeUpstreamStream(upstreamResponse: Response, res: ServerResponse) {
  res.writeHead(upstreamResponse.status, {
    'content-type': upstreamResponse.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    'cache-control': upstreamResponse.headers.get('cache-control') ?? 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    res.write(Buffer.from(value));
  }
  res.end();
}

export async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {} as JsonRecord;
  }

  return JSON.parse(raw) as JsonRecord;
}

export function getModelsUrlFromEndpoint(endpoint: UpstreamEndpoint) {
  return endpoint.url.replace(/\/v1\/messages$/, '/v1/models');
}
