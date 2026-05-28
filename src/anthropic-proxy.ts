import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeAnthropicMessageRequest } from './anthropic-input-normalization.js';
import { isJsonRecord, type ClaudeBillingHeaderMode, type JsonRecord, type JsonValue } from './responses-input-normalization.js';

export type AnthropicProxyConfig = {
  instanceName: string;
  primaryProviderName: string;
  primaryProviderBaseUrl: string;
  apiKey: string;
  anthropicVersion: string;
  anthropicBeta?: string;
  defaultModel: string;
  modelMappings: Record<string, string>;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
};

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonValue) {
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

function makeError(type: string, message: string) {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  } as JsonRecord;
}

async function readJsonBody(req: IncomingMessage) {
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

function wantsStreaming(req: IncomingMessage, body: JsonRecord) {
  if (body.stream === true) {
    return true;
  }

  const accept = req.headers.accept ?? '';
  return String(accept).includes('text/event-stream');
}

function getOutboundHeaders(config: AnthropicProxyConfig, inboundHeaders: IncomingMessage['headers']) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': config.apiKey,
    'anthropic-version': typeof inboundHeaders['anthropic-version'] === 'string'
      ? inboundHeaders['anthropic-version']
      : config.anthropicVersion,
  };

  const inboundBeta = inboundHeaders['anthropic-beta'];
  const beta = typeof inboundBeta === 'string' && inboundBeta.trim().length > 0
    ? inboundBeta
    : config.anthropicBeta;
  if (beta) {
    headers['anthropic-beta'] = beta;
  }

  return headers;
}

function getRequestedModel(requestBody: JsonRecord, config: AnthropicProxyConfig) {
  return typeof requestBody.model === 'string' && requestBody.model.trim().length > 0
    ? requestBody.model
    : config.defaultModel;
}

function restoreClientModelInMessage(payload: unknown, requestedModel: string) {
  if (!isJsonRecord(payload)) {
    return payload;
  }

  return {
    ...payload,
    model: requestedModel,
  } as JsonRecord;
}

function applyModelMappingsToModelsPayload(payload: unknown, modelMappings: Record<string, string>) {
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

async function pipeUpstreamStream(upstreamResponse: Response, res: ServerResponse) {
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

export function createAnthropicProxyServer(config: AnthropicProxyConfig) {
  const baseUrl = normalizeBaseUrl(config.primaryProviderBaseUrl);
  const upstreamMessagesUrl = `${baseUrl}/v1/messages`;
  const upstreamModelsUrl = `${baseUrl}/v1/models`;

  return createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta',
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          instanceName: config.instanceName,
          primaryProviderName: config.primaryProviderName,
          upstreamMessagesUrl,
          upstreamModelsUrl,
          anthropicVersion: config.anthropicVersion,
          anthropicBeta: config.anthropicBeta ?? null,
          modelMappings: config.modelMappings,
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        const upstreamResponse = await fetch(upstreamModelsUrl, {
          method: 'GET',
          headers: getOutboundHeaders(config, req.headers),
        });
        const upstreamText = await upstreamResponse.text();
        let payload: unknown;
        try {
          payload = JSON.parse(upstreamText);
        } catch {
          sendJson(res, 502, makeError('api_error', 'Upstream models endpoint returned invalid JSON'));
          return;
        }

        sendJson(
          res,
          upstreamResponse.status,
          (upstreamResponse.ok ? applyModelMappingsToModelsPayload(payload, config.modelMappings) : payload) as JsonValue,
        );
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        sendJson(res, 404, makeError('not_found_error', 'Supported routes: GET /healthz, GET /v1/models, POST /v1/messages'));
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      if (!String(contentType).includes('application/json')) {
        sendJson(res, 415, makeError('invalid_request_error', 'Content-Type must be application/json'));
        return;
      }

      let requestBody: JsonRecord;
      try {
        requestBody = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, makeError('invalid_request_error', `Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      const requestedModel = getRequestedModel(requestBody, config);
      const upstreamBody = normalizeAnthropicMessageRequest(requestBody, config);
      const upstreamResponse = await fetch(upstreamMessagesUrl, {
        method: 'POST',
        headers: getOutboundHeaders(config, req.headers),
        body: JSON.stringify(upstreamBody),
      });

      const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
      if (wantsStreaming(req, requestBody) || upstreamContentType.includes('text/event-stream')) {
        await pipeUpstreamStream(upstreamResponse, res);
        return;
      }

      const upstreamText = await upstreamResponse.text();
      let payload: unknown;
      try {
        payload = JSON.parse(upstreamText);
      } catch {
        sendJson(res, 502, makeError('api_error', 'Upstream messages endpoint returned invalid JSON'));
        return;
      }

      sendJson(
        res,
        upstreamResponse.status,
        (upstreamResponse.ok ? restoreClientModelInMessage(payload, requestedModel) : payload) as JsonValue,
      );
    } catch (error) {
      sendJson(res, 500, makeError('api_error', error instanceof Error ? error.message : String(error)));
    }
  });
}

function loadModelMappings(filePath: string) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const source = isJsonRecord(parsed) && isJsonRecord(parsed.model_mappings) ? parsed.model_mappings : parsed;
    if (!isJsonRecord(source)) {
      return {} as Record<string, string>;
    }

    const mappings: Record<string, string> = {};
    for (const [alias, target] of Object.entries(source)) {
      if (typeof target === 'string' && alias.trim().length > 0 && target.trim().length > 0) {
        mappings[alias.trim()] = target.trim();
      }
    }
    return mappings;
  } catch {
    return {} as Record<string, string>;
  }
}

function parseClaudeBillingHeaderMode(value: string | undefined): ClaudeBillingHeaderMode {
  const normalized = (value ?? 'strip_line').trim().toLowerCase().replace(/-/g, '_');
  return normalized === 'strip_cch' ? 'strip_cch' : 'strip_line';
}

export function createConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicProxyConfig & { host: string; port: number } {
  const apiKey = env.PRIMARY_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PRIMARY_PROVIDER_API_KEY in environment');
  }

  const port = Number(env.PORT ?? 11234);
  const primaryProviderBaseUrl = env.PRIMARY_PROVIDER_BASE_URL ?? 'https://api.anthropic.com';
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    instanceName: env.INSTANCE_NAME ?? `anthropic-proxy-${port}`,
    primaryProviderName: env.PRIMARY_PROVIDER_NAME ?? 'primary-provider',
    primaryProviderBaseUrl,
    apiKey,
    anthropicVersion: env.ANTHROPIC_VERSION ?? '2023-06-01',
    anthropicBeta: env.ANTHROPIC_BETA?.trim() || undefined,
    defaultModel: env.PRIMARY_PROVIDER_DEFAULT_MODEL ?? 'claude-sonnet-4-5',
    modelMappings: loadModelMappings(resolve(env.MODEL_MAP_PATH ?? 'model-map.json')),
    claudeBillingHeaderMode: parseClaudeBillingHeaderMode(env.PROXY_CLAUDE_BILLING_HEADER_MODE),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = createConfigFromEnv();
  const server = createAnthropicProxyServer(config);
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Anthropic Messages compatibility proxy listening',
      instanceName: config.instanceName,
      host: config.host,
      port: config.port,
      upstreamMessagesUrl: `${normalizeBaseUrl(config.primaryProviderBaseUrl)}/v1/messages`,
      upstreamModelsUrl: `${normalizeBaseUrl(config.primaryProviderBaseUrl)}/v1/models`,
    }));
  });
}
