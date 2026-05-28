import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeAnthropicMessageRequest } from './anthropic-input-normalization.js';
import { isJsonRecord, type ClaudeBillingHeaderMode, type JsonRecord, type JsonValue } from './responses-input-normalization.js';
import { handleMessagesRequest } from './anthropic-messages-handler.js';
import { handleModelsRequest } from './anthropic-models-handler.js';
import { type UpstreamEndpoint, loadFallbackEndpoints } from './anthropic-config.js';
import { createAdminHandler } from './admin-api.js';
import { createConfigFileStoreFromPaths } from './config-files.js';
import { createRuntimeConfigStore } from './runtime-config.js';
import { createEndpointHealthStore, type EndpointHealthStore } from './proxy-core.js';
import {
  normalizeBaseUrl,
  sendJson,
  makeAnthropicError,
  getRequestedModel,
  restoreClientModel,
  getOutboundHeaders,
  applyModelMappingsToModelsPayload,
  pipeUpstreamStream,
  readJsonBody,
} from './anthropic-http-utils.js';

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
  primaryEndpoint: UpstreamEndpoint;
  fallbackEndpoints: UpstreamEndpoint[];
  endpointTimeoutCooldownMs: number;
  endpointInvalidResponseCooldownMs: number;
  endpointAuthCooldownMs: number;
  endpointFailureThreshold: number;
  endpointHalfOpenMaxProbes: number;
  maxFallbackAttempts: number;
  maxFallbackTotalMs: number;
  endpointHealthStore?: EndpointHealthStore;
  adminHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>;
};

export function createAnthropicProxyServer(config: AnthropicProxyConfig) {
  const baseUrl = normalizeBaseUrl(config.primaryProviderBaseUrl);
  const upstreamMessagesUrl = `${baseUrl}/v1/messages`;
  const upstreamModelsUrl = `${baseUrl}/v1/models`;
  const hasFallback = (config.fallbackEndpoints?.length ?? 0) > 0;
  const endpointHealthStore = config.endpointHealthStore ?? createEndpointHealthStore({
    endpointTimeoutCooldownMs: config.endpointTimeoutCooldownMs ?? 120000,
    endpointInvalidResponseCooldownMs: config.endpointInvalidResponseCooldownMs ?? 120000,
    endpointAuthCooldownMs: config.endpointAuthCooldownMs ?? 1800000,
    endpointFailureThreshold: config.endpointFailureThreshold ?? 1,
    endpointHalfOpenMaxProbes: config.endpointHalfOpenMaxProbes ?? 1,
  });

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

      if (config.adminHandler) {
        const handled = await config.adminHandler(req, res);
        if (handled) return;
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
          claudeBillingHeaderMode: config.claudeBillingHeaderMode,
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        if (hasFallback) {
          await handleModelsRequest(req, res, {
            primaryEndpoint: config.primaryEndpoint,
            anthropicVersion: config.anthropicVersion,
            anthropicBeta: config.anthropicBeta,
            modelMappings: config.modelMappings,
          });
        } else {
          const upstreamResponse = await fetch(upstreamModelsUrl, {
            method: 'GET',
            headers: getOutboundHeaders(config.apiKey, config.anthropicVersion, config.anthropicBeta, req.headers),
          });
          const upstreamText = await upstreamResponse.text();
          let payload: unknown;
          try {
            payload = JSON.parse(upstreamText);
          } catch {
            sendJson(res, 502, makeAnthropicError('api_error', 'Upstream models endpoint returned invalid JSON'));
            return;
          }

          sendJson(
            res,
            upstreamResponse.status,
            (upstreamResponse.ok ? applyModelMappingsToModelsPayload(payload, config.modelMappings) : payload) as JsonValue,
          );
        }
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        sendJson(res, 404, makeAnthropicError('not_found_error', 'Supported routes: GET /healthz, GET /v1/models, POST /v1/messages'));
        return;
      }

      const contentType = req.headers['content-type'] ?? '';
      if (!String(contentType).includes('application/json')) {
        sendJson(res, 415, makeAnthropicError('invalid_request_error', 'Content-Type must be application/json'));
        return;
      }

      let requestBody: JsonRecord;
      try {
        requestBody = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, makeAnthropicError('invalid_request_error', `Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      if (hasFallback) {
        await handleMessagesRequest(req, res, requestBody, {
          primaryEndpoint: config.primaryEndpoint,
          fallbackEndpoints: config.fallbackEndpoints,
          anthropicVersion: config.anthropicVersion,
          anthropicBeta: config.anthropicBeta,
          defaultModel: config.defaultModel,
          modelMappings: config.modelMappings,
          maxFallbackAttempts: config.maxFallbackAttempts,
          maxFallbackTotalMs: config.maxFallbackTotalMs,
          endpointHealthStore,
        });
        return;
      }

      const requestedModel = getRequestedModel(requestBody, config.defaultModel);
      const upstreamBody = normalizeAnthropicMessageRequest(requestBody, config);
      const upstreamResponse = await fetch(upstreamMessagesUrl, {
        method: 'POST',
        headers: getOutboundHeaders(config.apiKey, config.anthropicVersion, config.anthropicBeta, req.headers),
        body: JSON.stringify(upstreamBody),
      });

      const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
      if (upstreamContentType.includes('text/event-stream')) {
        await pipeUpstreamStream(upstreamResponse, res);
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

      sendJson(
        res,
        upstreamResponse.status,
        (upstreamResponse.ok ? restoreClientModel(payload, requestedModel) : payload) as JsonValue,
      );
    } catch (error) {
      sendJson(res, 500, makeAnthropicError('api_error', error instanceof Error ? error.message : String(error)));
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
  const normalizedBaseUrl = normalizeBaseUrl(primaryProviderBaseUrl);
  const fallbackConfigPath = env.FALLBACK_CONFIG_PATH ?? '';
  const modelMappings = loadModelMappings(resolve(env.MODEL_MAP_PATH ?? 'model-map.json'));

  const primaryEndpoint: UpstreamEndpoint = {
    name: env.PRIMARY_PROVIDER_NAME ?? 'primary-provider',
    url: `${normalizedBaseUrl}/v1/messages`,
    apiKey,
    isFallback: false,
  };

  const fallbackEndpoints = fallbackConfigPath
    ? loadFallbackEndpoints(fallbackConfigPath, env as Record<string, string>)
    : [];

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
    modelMappings,
    claudeBillingHeaderMode: parseClaudeBillingHeaderMode(env.PROXY_CLAUDE_BILLING_HEADER_MODE),
    primaryEndpoint,
    fallbackEndpoints,
    endpointTimeoutCooldownMs: Number(env.PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS ?? 120000),
    endpointInvalidResponseCooldownMs: Number(env.PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS ?? 120000),
    endpointAuthCooldownMs: Number(env.PROXY_ENDPOINT_AUTH_COOLDOWN_MS ?? 1800000),
    endpointFailureThreshold: Number(env.PROXY_ENDPOINT_FAILURE_THRESHOLD ?? 1),
    endpointHalfOpenMaxProbes: Number(env.PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES ?? 1),
    maxFallbackAttempts: Number(env.PROXY_MAX_FALLBACK_ATTEMPTS ?? Math.max(1, fallbackEndpoints.length)),
    maxFallbackTotalMs: Number(env.PROXY_MAX_FALLBACK_TOTAL_MS ?? 30000),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envPath = process.env.PROXY_ENV_PATH ?? resolve('.env');
  const runtimeStore = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
  const snap = runtimeStore.getSnapshot();
  const endpointHealthStore = createEndpointHealthStore({
    endpointTimeoutCooldownMs: snap.config.endpointTimeoutCooldownMs,
    endpointInvalidResponseCooldownMs: snap.config.endpointInvalidResponseCooldownMs,
    endpointAuthCooldownMs: snap.config.endpointAuthCooldownMs,
    endpointFailureThreshold: snap.config.endpointFailureThreshold,
    endpointHalfOpenMaxProbes: snap.config.endpointHalfOpenMaxProbes,
  });
  const adminConfigStore = createConfigFileStoreFromPaths({
    envPath,
    fallbackPath: snap.config.fallbackConfigPath,
    modelMapPath: snap.config.modelMappingPath,
  });
  const getAdminStats = () => {
    const s = runtimeStore.getSnapshot();
    return {
      instanceName: s.config.instanceName,
      anthropicVersion: s.config.anthropicVersion,
      anthropicBeta: s.config.anthropicBeta ?? null,
        upstreamMessagesUrl: s.config.upstreamMessagesUrl,
        upstreamModelsUrl: s.config.upstreamModelsUrl,
        claudeBillingHeaderMode: s.config.claudeBillingHeaderMode,
        modelMappings: s.config.modelMappings,
        endpointHealth: endpointHealthStore.listSnapshots(s.config.allEndpoints),
      };
  };
  const adminHandler = createAdminHandler({
    configStore: adminConfigStore,
    runtimeStore,
    getAdminStats,
  });
  const baseConfig = createConfigFromEnv();
  const config = { ...baseConfig, adminHandler, endpointHealthStore };
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
