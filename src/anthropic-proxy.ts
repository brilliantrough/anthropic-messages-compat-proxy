import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeAnthropicMessageRequest } from './anthropic-input-normalization.js';
import { isJsonRecord, type ClaudeBillingHeaderMode, type JsonRecord, type JsonValue } from './responses-input-normalization.js';
import {
  handleMessagesRequest,
  createProxyStats,
  type ProxyStats,
  type AnthropicMessagesHandlerOptions,
} from './anthropic-messages-handler.js';
import { handleModelsRequest } from './anthropic-models-handler.js';
import { type UpstreamEndpoint, type StreamMode, loadFallbackEndpoints } from './anthropic-config.js';
import { createAdminHandler } from './admin-api.js';
import { createConfigFileStoreFromPaths } from './config-files.js';
import { createRuntimeConfigStore } from './runtime-config.js';
import { createEndpointHealthStore, type EndpointHealthStore } from './proxy-core.js';
import {
  normalizeBaseUrl,
  sendJson,
  makeAnthropicError,
  getOutboundHeaders,
  applyModelMappingsToModelsPayload,
  readJsonBody,
} from './anthropic-http-utils.js';

const DEFAULT_TIMEOUTS = {
  upstreamTimeoutMs: 30000,
  nonStreamingRequestTimeoutMs: 300000,
  firstByteTimeoutMs: 30000,
  firstTextTimeoutMs: 12000,
  streamIdleTimeoutMs: 60000,
  totalRequestTimeoutMs: 600000,
  maxConcurrentRequests: 128,
  maxFallbackTotalMs: 30000,
} as const;

export type AnthropicProxyConfig = {
  port: number;
  host?: string;
  instanceName?: string;
  primaryProviderName: string;
  primaryProviderBaseUrl: string;
  apiKey: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
  defaultModel?: string;
  modelMappings?: Record<string, string>;
  claudeBillingHeaderMode?: ClaudeBillingHeaderMode;
  primaryEndpoint?: UpstreamEndpoint;
  fallbackEndpoints?: UpstreamEndpoint[];
  endpointTimeoutCooldownMs?: number;
  endpointInvalidResponseCooldownMs?: number;
  endpointAuthCooldownMs?: number;
  endpointFailureThreshold?: number;
  endpointHalfOpenMaxProbes?: number;
  maxFallbackAttempts?: number;
  maxFallbackTotalMs?: number;
  upstreamTimeoutMs?: number;
  nonStreamingRequestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  firstTextTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  totalRequestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  defaultStreamMode?: StreamMode;
  fallbackOnRetryable4xx?: boolean;
  fallbackOnCompat4xx?: boolean;
  compatFallbackPatterns?: string[];
  clientErrorPatterns?: string[];
  adminHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>;
  endpointHealthStore?: EndpointHealthStore;
  stats?: ProxyStats;
};

export function createAnthropicProxyServer(config: AnthropicProxyConfig) {
  const baseUrl = normalizeBaseUrl(config.primaryProviderBaseUrl);
  const upstreamMessagesUrl = `${baseUrl}/v1/messages`;
  const upstreamModelsUrl = `${baseUrl}/v1/models`;
  const anthropicVersion = config.anthropicVersion ?? '2023-06-01';
  const defaultModel = config.defaultModel ?? 'claude-sonnet-4-5';
  const modelMappings = config.modelMappings ?? {};
  const instanceName = config.instanceName ?? 'anthropic-proxy';

  const primaryEndpoint = config.primaryEndpoint ?? {
    name: config.primaryProviderName,
    url: upstreamMessagesUrl,
    apiKey: config.apiKey,
    isFallback: false,
  };
  const fallbackEndpoints = config.fallbackEndpoints ?? [];
  const endpointHealthStore = config.endpointHealthStore ?? createEndpointHealthStore({
    endpointTimeoutCooldownMs: config.endpointTimeoutCooldownMs ?? 120000,
    endpointInvalidResponseCooldownMs: config.endpointInvalidResponseCooldownMs ?? 120000,
    endpointAuthCooldownMs: config.endpointAuthCooldownMs ?? 1800000,
    endpointFailureThreshold: config.endpointFailureThreshold ?? 1,
    endpointHalfOpenMaxProbes: config.endpointHalfOpenMaxProbes ?? 1,
  });
  const stats = config.stats ?? createProxyStats();
  const maxConcurrentRequests = config.maxConcurrentRequests ?? DEFAULT_TIMEOUTS.maxConcurrentRequests;

  const resolveHandlerOptions = (): AnthropicMessagesHandlerOptions => ({
    primaryEndpoint,
    fallbackEndpoints,
    anthropicVersion,
    anthropicBeta: config.anthropicBeta,
    defaultModel,
    modelMappings,
    maxFallbackAttempts: config.maxFallbackAttempts ?? Math.max(1, fallbackEndpoints.length),
    maxFallbackTotalMs: config.maxFallbackTotalMs ?? DEFAULT_TIMEOUTS.maxFallbackTotalMs,
    endpointHealthStore,
    upstreamTimeoutMs: config.upstreamTimeoutMs ?? DEFAULT_TIMEOUTS.upstreamTimeoutMs,
    nonStreamingRequestTimeoutMs: config.nonStreamingRequestTimeoutMs ?? DEFAULT_TIMEOUTS.nonStreamingRequestTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs ?? DEFAULT_TIMEOUTS.firstByteTimeoutMs,
    firstTextTimeoutMs: config.firstTextTimeoutMs ?? DEFAULT_TIMEOUTS.firstTextTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_TIMEOUTS.streamIdleTimeoutMs,
    totalRequestTimeoutMs: config.totalRequestTimeoutMs ?? DEFAULT_TIMEOUTS.totalRequestTimeoutMs,
    defaultStreamMode: config.defaultStreamMode ?? 'normalized',
    fallbackOnRetryable4xx: config.fallbackOnRetryable4xx ?? true,
    fallbackOnCompat4xx: config.fallbackOnCompat4xx ?? true,
    compatFallbackPatterns: config.compatFallbackPatterns ?? [],
    clientErrorPatterns: config.clientErrorPatterns ?? [],
    stats,
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
          instanceName,
          primaryProviderName: config.primaryProviderName,
          upstreamMessagesUrl,
          upstreamModelsUrl,
          anthropicVersion,
          anthropicBeta: config.anthropicBeta ?? null,
          modelMappings,
          claudeBillingHeaderMode: config.claudeBillingHeaderMode,
          activeRequests: stats.activeRequests,
          maxConcurrentRequests,
        } as JsonValue);
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        const hasFallback = fallbackEndpoints.length > 0;
        if (hasFallback) {
          await handleModelsRequest(req, res, {
            primaryEndpoint,
            anthropicVersion,
            anthropicBeta: config.anthropicBeta,
            modelMappings,
          });
        } else {
          const upstreamResponse = await fetch(upstreamModelsUrl, {
            method: 'GET',
            headers: getOutboundHeaders(config.apiKey, anthropicVersion, config.anthropicBeta, req.headers),
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
            (upstreamResponse.ok ? applyModelMappingsToModelsPayload(payload, modelMappings) : payload) as JsonValue,
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

      stats.requestsTotal += 1;

      if (stats.activeRequests >= maxConcurrentRequests) {
        stats.overloadRejects += 1;
        sendJson(res, 503, makeAnthropicError('overloaded_error', `Proxy overloaded: ${stats.activeRequests}/${maxConcurrentRequests} active requests`));
        return;
      }

      stats.activeRequests += 1;
      try {
        await handleMessagesRequest(req, res, requestBody, resolveHandlerOptions());
      } finally {
        stats.activeRequests -= 1;
      }
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

function parseStreamMode(value: string | undefined): StreamMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'raw' ? 'raw' : 'normalized';
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
    maxFallbackTotalMs: Number(env.PROXY_MAX_FALLBACK_TOTAL_MS ?? DEFAULT_TIMEOUTS.maxFallbackTotalMs),
    upstreamTimeoutMs: Number(env.PROXY_UPSTREAM_TIMEOUT_MS ?? DEFAULT_TIMEOUTS.upstreamTimeoutMs),
    nonStreamingRequestTimeoutMs: Number(env.PROXY_NON_STREAM_TIMEOUT_MS ?? DEFAULT_TIMEOUTS.nonStreamingRequestTimeoutMs),
    firstByteTimeoutMs: Number(env.PROXY_FIRST_BYTE_TIMEOUT_MS ?? DEFAULT_TIMEOUTS.firstByteTimeoutMs),
    firstTextTimeoutMs: Number(env.PROXY_FIRST_TEXT_TIMEOUT_MS ?? DEFAULT_TIMEOUTS.firstTextTimeoutMs),
    streamIdleTimeoutMs: Number(env.PROXY_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_TIMEOUTS.streamIdleTimeoutMs),
    totalRequestTimeoutMs: Number(env.PROXY_TOTAL_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUTS.totalRequestTimeoutMs),
    maxConcurrentRequests: Number(env.PROXY_MAX_CONCURRENT_REQUESTS ?? DEFAULT_TIMEOUTS.maxConcurrentRequests),
    defaultStreamMode: parseStreamMode(env.PROXY_STREAM_MODE),
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
  const proxyStats = createProxyStats();
  const getAdminStats = () => {
    const snapNow = runtimeStore.getSnapshot();
    return {
      instanceName: snapNow.config.instanceName,
      anthropicVersion: snapNow.config.anthropicVersion,
      anthropicBeta: snapNow.config.anthropicBeta ?? null,
      upstreamMessagesUrl: snapNow.config.upstreamMessagesUrl,
      upstreamModelsUrl: snapNow.config.upstreamModelsUrl,
      claudeBillingHeaderMode: snapNow.config.claudeBillingHeaderMode,
      modelMappings: snapNow.config.modelMappings,
      upstreamTimeoutMs: snapNow.config.upstreamTimeoutMs,
      nonStreamingRequestTimeoutMs: snapNow.config.nonStreamingRequestTimeoutMs,
      firstByteTimeoutMs: snapNow.config.firstByteTimeoutMs,
      firstTextTimeoutMs: snapNow.config.firstTextTimeoutMs,
      streamIdleTimeoutMs: snapNow.config.streamIdleTimeoutMs,
      totalRequestTimeoutMs: snapNow.config.totalRequestTimeoutMs,
      maxConcurrentRequests: snapNow.config.maxConcurrentRequests,
      defaultStreamMode: snapNow.config.defaultStreamMode,
      endpointTimeoutCooldownMs: snapNow.config.endpointTimeoutCooldownMs,
      endpointInvalidResponseCooldownMs: snapNow.config.endpointInvalidResponseCooldownMs,
      endpointAuthCooldownMs: snapNow.config.endpointAuthCooldownMs,
      endpointFailureThreshold: snapNow.config.endpointFailureThreshold,
      endpointHalfOpenMaxProbes: snapNow.config.endpointHalfOpenMaxProbes,
      maxFallbackAttempts: snapNow.config.maxFallbackAttempts,
      maxFallbackTotalMs: snapNow.config.maxFallbackTotalMs,
      endpointHealth: endpointHealthStore.listSnapshots(snapNow.config.allEndpoints),
      stats: { ...proxyStats },
    };
  };
  const adminHandler = createAdminHandler({
    configStore: adminConfigStore,
    runtimeStore,
    getAdminStats,
  });
  const s = snap.config;
  const baseConfig: AnthropicProxyConfig & { host: string; port: number } = {
    port: s.port,
    host: s.host,
    instanceName: s.instanceName,
    primaryProviderName: s.primaryProviderName,
    primaryProviderBaseUrl: s.primaryProviderBaseUrl,
    apiKey: s.apiKey,
    anthropicVersion: s.anthropicVersion,
    anthropicBeta: s.anthropicBeta,
    defaultModel: s.defaultModel,
    modelMappings: s.modelMappings,
    claudeBillingHeaderMode: s.claudeBillingHeaderMode,
    primaryEndpoint: s.primaryEndpoint,
    fallbackEndpoints: s.fallbackEndpoints,
    endpointTimeoutCooldownMs: s.endpointTimeoutCooldownMs,
    endpointInvalidResponseCooldownMs: s.endpointInvalidResponseCooldownMs,
    endpointAuthCooldownMs: s.endpointAuthCooldownMs,
    endpointFailureThreshold: s.endpointFailureThreshold,
    endpointHalfOpenMaxProbes: s.endpointHalfOpenMaxProbes,
    maxFallbackAttempts: s.maxFallbackAttempts,
    maxFallbackTotalMs: s.maxFallbackTotalMs,
    upstreamTimeoutMs: s.upstreamTimeoutMs,
    nonStreamingRequestTimeoutMs: s.nonStreamingRequestTimeoutMs,
    firstByteTimeoutMs: s.firstByteTimeoutMs,
    firstTextTimeoutMs: s.firstTextTimeoutMs,
    streamIdleTimeoutMs: s.streamIdleTimeoutMs,
    totalRequestTimeoutMs: s.totalRequestTimeoutMs,
    maxConcurrentRequests: s.maxConcurrentRequests,
    defaultStreamMode: s.defaultStreamMode,
    stats: proxyStats,
  };
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
