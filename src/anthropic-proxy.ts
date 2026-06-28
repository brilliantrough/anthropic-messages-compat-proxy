import 'dotenv/config';
import { bootstrapHttpProxySupport } from './http-proxy-bootstrap.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { isJsonRecord, type ClaudeBillingHeaderMode, type JsonRecord, type JsonValue } from './responses-input-normalization.js';
import {
  handleMessagesRequest,
  createProxyStats,
  recordStatus,
  type ProxyStats,
  type AnthropicMessagesHandlerOptions,
} from './anthropic-messages-handler.js';
import { handleModelsRequest } from './anthropic-models-handler.js';
import { type UpstreamEndpoint, type StreamMode, type AnthropicRuntimeConfig, loadFallbackEndpoints } from './anthropic-config.js';
import { createAdminHandler } from './admin-api.js';
import { createConfigFileStoreFromPaths } from './config-files.js';
import { createRuntimeConfigStore, type RuntimeConfigStore, type RuntimeSnapshot } from './runtime-config.js';
import { createEndpointHealthStore, type EndpointHealthStore } from './proxy-core.js';
import {
  normalizeBaseUrl,
  sendJson,
  makeAnthropicError,
  getOutboundHeaders,
  applyModelMappingsToModelsPayload,
  readJsonBody,
} from './anthropic-http-utils.js';
import { createRequestId, logRequest } from './anthropic-logging.js';

bootstrapHttpProxySupport();

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

const _requestContext = new AsyncLocalStorage<RuntimeSnapshot<AnthropicRuntimeConfig>>();
let _runtimeStore: RuntimeConfigStore<AnthropicRuntimeConfig> | null = null;

function getConfig(): AnthropicRuntimeConfig {
  const snap = _requestContext.getStore();
  return snap ? snap.config : _initialSnapshot.config;
}

function getLatestSnapshot(): RuntimeSnapshot<AnthropicRuntimeConfig> {
  if (_runtimeStore) {
    return _runtimeStore.getSnapshot();
  }
  return _initialSnapshot;
}

let _initialSnapshot: RuntimeSnapshot<AnthropicRuntimeConfig>;

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
  logRequestBodies?: boolean;
  debugSse?: boolean;
  sseFailureDebugEnabled?: boolean;
  sseFailureDebugDir?: string;
  streamMissingUsageDebugEnabled?: boolean;
  streamMissingUsageDebugDir?: string;
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

  _initialSnapshot = {
    runtimeVersion: 0,
    config: {
      host: config.host ?? '0.0.0.0',
      port: config.port,
      instanceName,
      primaryProviderName: config.primaryProviderName,
      primaryProviderBaseUrl: baseUrl,
      apiKey: config.apiKey,
      upstreamMessagesUrl,
      upstreamModelsUrl,
      anthropicVersion: config.anthropicVersion ?? '2023-06-01',
      anthropicBeta: config.anthropicBeta,
      defaultModel: config.defaultModel ?? 'claude-sonnet-4-5',
      modelMappings: config.modelMappings ?? {},
      claudeBillingHeaderMode: config.claudeBillingHeaderMode ?? 'strip_line',
      primaryEndpoint,
      fallbackEndpoints,
      allEndpoints: [primaryEndpoint, ...fallbackEndpoints],
      adminAllowHost: false,
      endpointTimeoutCooldownMs: config.endpointTimeoutCooldownMs ?? 120000,
      endpointInvalidResponseCooldownMs: config.endpointInvalidResponseCooldownMs ?? 120000,
      endpointAuthCooldownMs: config.endpointAuthCooldownMs ?? 1800000,
      endpointFailureThreshold: config.endpointFailureThreshold ?? 1,
      endpointHalfOpenMaxProbes: config.endpointHalfOpenMaxProbes ?? 1,
      maxFallbackAttempts: config.maxFallbackAttempts ?? Math.max(1, fallbackEndpoints.length),
      maxFallbackTotalMs: config.maxFallbackTotalMs ?? DEFAULT_TIMEOUTS.maxFallbackTotalMs,
      fallbackConfigPath: '',
      modelMappingPath: '',
      upstreamTimeoutMs: config.upstreamTimeoutMs ?? DEFAULT_TIMEOUTS.upstreamTimeoutMs,
      nonStreamingRequestTimeoutMs: config.nonStreamingRequestTimeoutMs ?? DEFAULT_TIMEOUTS.nonStreamingRequestTimeoutMs,
      firstByteTimeoutMs: config.firstByteTimeoutMs ?? DEFAULT_TIMEOUTS.firstByteTimeoutMs,
      firstTextTimeoutMs: config.firstTextTimeoutMs ?? DEFAULT_TIMEOUTS.firstTextTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_TIMEOUTS.streamIdleTimeoutMs,
       totalRequestTimeoutMs: config.totalRequestTimeoutMs ?? DEFAULT_TIMEOUTS.totalRequestTimeoutMs,
       maxConcurrentRequests,
       defaultStreamMode: config.defaultStreamMode ?? 'normalized',
       logRequestBodies: config.logRequestBodies ?? false,
       debugSse: config.debugSse ?? false,
       sseFailureDebugEnabled: config.sseFailureDebugEnabled ?? false,
       sseFailureDebugDir: config.sseFailureDebugDir ?? resolve('captures', instanceName, 'sse-failures'),
       streamMissingUsageDebugEnabled: config.streamMissingUsageDebugEnabled ?? false,
       streamMissingUsageDebugDir: config.streamMissingUsageDebugDir ?? resolve('captures', instanceName, 'stream', 'missing-usage'),
       fallbackOnRetryable4xx: config.fallbackOnRetryable4xx ?? true,
      fallbackOnCompat4xx: config.fallbackOnCompat4xx ?? true,
      compatFallbackPatterns: config.compatFallbackPatterns ?? [],
      clientErrorPatterns: config.clientErrorPatterns ?? [],
    },
    envPath: '',
    restartRequiredFields: [],
  };

  const resolveHandlerOptions = (
    requestId: string,
    finish: (statusCode: number, note: string, extra?: Record<string, unknown>) => void,
  ): AnthropicMessagesHandlerOptions => {
    const c = getConfig();
    return {
      requestId,
      primaryEndpoint: c.primaryEndpoint ?? primaryEndpoint,
      fallbackEndpoints: c.fallbackEndpoints ?? fallbackEndpoints,
      anthropicVersion: c.anthropicVersion ?? '2023-06-01',
      anthropicBeta: c.anthropicBeta,
      defaultModel: c.defaultModel ?? 'claude-sonnet-4-5',
      modelMappings: c.modelMappings ?? {},
      claudeBillingHeaderMode: c.claudeBillingHeaderMode,
      maxFallbackAttempts: c.maxFallbackAttempts ?? Math.max(1, fallbackEndpoints.length),
      maxFallbackTotalMs: c.maxFallbackTotalMs ?? DEFAULT_TIMEOUTS.maxFallbackTotalMs,
      endpointHealthStore,
      upstreamTimeoutMs: c.upstreamTimeoutMs ?? DEFAULT_TIMEOUTS.upstreamTimeoutMs,
      nonStreamingRequestTimeoutMs: c.nonStreamingRequestTimeoutMs ?? DEFAULT_TIMEOUTS.nonStreamingRequestTimeoutMs,
      firstByteTimeoutMs: c.firstByteTimeoutMs ?? DEFAULT_TIMEOUTS.firstByteTimeoutMs,
      firstTextTimeoutMs: c.firstTextTimeoutMs ?? DEFAULT_TIMEOUTS.firstTextTimeoutMs,
      streamIdleTimeoutMs: c.streamIdleTimeoutMs ?? DEFAULT_TIMEOUTS.streamIdleTimeoutMs,
      totalRequestTimeoutMs: c.totalRequestTimeoutMs ?? DEFAULT_TIMEOUTS.totalRequestTimeoutMs,
      defaultStreamMode: c.defaultStreamMode ?? 'normalized',
      logRequestBodies: c.logRequestBodies ?? false,
      debugSse: c.debugSse ?? false,
      sseFailureDebugEnabled: c.sseFailureDebugEnabled ?? false,
      sseFailureDebugDir: c.sseFailureDebugDir,
      streamMissingUsageDebugEnabled: c.streamMissingUsageDebugEnabled ?? false,
      streamMissingUsageDebugDir: c.streamMissingUsageDebugDir,
      fallbackOnRetryable4xx: c.fallbackOnRetryable4xx ?? true,
      fallbackOnCompat4xx: c.fallbackOnCompat4xx ?? true,
      compatFallbackPatterns: c.compatFallbackPatterns ?? [],
      clientErrorPatterns: c.clientErrorPatterns ?? [],
      stats,
      logRequest(message, extra) {
        logRequest(requestId, message, extra);
      },
      finish,
    };
  };

  return createServer((req, res) => {
    const snap = getLatestSnapshot();
    const requestId = createRequestId();
    const startedAt = Date.now();

    _requestContext.run(snap, async () => {
      const finish = (statusCode: number, note: string, extra?: Record<string, unknown>) => {
        recordStatus(stats, statusCode);
        logRequest(requestId, note, {
          statusCode,
          durationMs: Date.now() - startedAt,
          activeRequests: stats.activeRequests,
          runtimeVersion: snap.runtimeVersion,
          ...extra,
        });
      };

      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta',
          });
          res.end();
          finish(204, 'preflight handled');
          return;
        }

        if (config.adminHandler) {
          const handled = await config.adminHandler(req, res);
          if (handled) {
            finish(res.statusCode || 200, 'admin config api handled');
            return;
          }
        }

        const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

        if (req.method === 'GET' && requestPath === '/healthz') {
          const c = getConfig();
          sendJson(res, 200, {
            ok: true,
            instanceName,
            primaryProviderName: c.primaryProviderName,
            upstreamMessagesUrl: c.upstreamMessagesUrl,
            upstreamModelsUrl: c.upstreamModelsUrl,
            anthropicVersion: c.anthropicVersion,
            anthropicBeta: c.anthropicBeta ?? null,
            modelMappings: c.modelMappings,
            claudeBillingHeaderMode: c.claudeBillingHeaderMode,
            activeRequests: stats.activeRequests,
            maxConcurrentRequests,
          } as JsonValue);
          finish(200, 'health check');
          return;
        }

        if (req.method === 'GET' && requestPath === '/v1/models') {
          const c = getConfig();
          await handleModelsRequest(req, res, {
            requestId,
            primaryEndpoint: c.primaryEndpoint ?? primaryEndpoint,
            anthropicVersion: c.anthropicVersion ?? '2023-06-01',
            anthropicBeta: c.anthropicBeta,
            modelMappings: c.modelMappings ?? {},
            firstByteTimeoutMs: c.firstByteTimeoutMs ?? DEFAULT_TIMEOUTS.firstByteTimeoutMs,
            upstreamTimeoutMs: c.upstreamTimeoutMs ?? DEFAULT_TIMEOUTS.upstreamTimeoutMs,
            logRequest(message, extra) {
              logRequest(requestId, message, extra);
            },
            finish,
          });
          return;
        }

        if (req.method !== 'POST' || requestPath !== '/v1/messages') {
          finish(404, 'unsupported route', { method: req.method, url: req.url });
          sendJson(res, 404, makeAnthropicError('not_found_error', 'Supported routes: GET /healthz, GET /v1/models, POST /v1/messages'));
          return;
        }

        stats.requestsTotal += 1;

        const contentType = req.headers['content-type'] ?? '';
        if (!String(contentType).includes('application/json')) {
          finish(415, 'invalid content type');
          sendJson(res, 415, makeAnthropicError('invalid_request_error', 'Content-Type must be application/json'));
          return;
        }

        let requestBody: JsonRecord;
        try {
          requestBody = await readJsonBody(req);
        } catch (error) {
          finish(400, 'invalid json body');
          sendJson(res, 400, makeAnthropicError('invalid_request_error', `Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }

        if (stats.activeRequests >= maxConcurrentRequests) {
          stats.overloadRejects += 1;
          finish(503, 'rejected due to concurrency limit');
          sendJson(res, 503, makeAnthropicError('overloaded_error', `Proxy overloaded: ${stats.activeRequests}/${maxConcurrentRequests} active requests`));
          return;
        }

        stats.activeRequests += 1;
        try {
          await handleMessagesRequest(req, res, requestBody, resolveHandlerOptions(requestId, finish));
        } finally {
          stats.activeRequests -= 1;
        }
      } catch (error) {
        if ((error as Error & { afterResponseCommit?: boolean }).afterResponseCommit || res.headersSent || res.writableEnded || res.destroyed) {
          finish(res.statusCode || 500, 'unhandled proxy error after response commit', {
            error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
          });
          return;
        }
        finish(500, 'unhandled proxy error', {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
        sendJson(res, 500, makeAnthropicError('api_error', error instanceof Error ? error.message : String(error)));
      }
    });
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
    logRequestBodies: String(env.PROXY_LOG_REQUEST_BODY ?? '').trim() === '1',
    debugSse: String(env.PROXY_DEBUG_SSE ?? '').trim() === '1',
    sseFailureDebugEnabled: String(env.PROXY_SSE_FAILURE_DEBUG ?? '').trim() === '1',
    sseFailureDebugDir: resolve(env.PROXY_SSE_FAILURE_DIR ?? `captures/${env.INSTANCE_NAME ?? `anthropic-proxy-${port}`}/sse-failures`),
    streamMissingUsageDebugEnabled: String(env.PROXY_STREAM_MISSING_USAGE_DEBUG ?? '').trim() === '1',
    streamMissingUsageDebugDir: resolve(
      env.PROXY_STREAM_MISSING_USAGE_DIR ?? `captures/${env.INSTANCE_NAME ?? `anthropic-proxy-${port}`}/stream/missing-usage`,
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envPath = process.env.PROXY_ENV_PATH ?? resolve('.env');
  const runtimeStore = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
  _runtimeStore = runtimeStore;
  const snap = runtimeStore.getSnapshot();
  _initialSnapshot = snap;
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
      host: snapNow.config.host,
      port: snapNow.config.port,
      primaryProviderName: snapNow.config.primaryProviderName,
      anthropicVersion: snapNow.config.anthropicVersion,
      anthropicBeta: snapNow.config.anthropicBeta ?? null,
      upstreamMessagesUrl: snapNow.config.upstreamMessagesUrl,
      upstreamModelsUrl: snapNow.config.upstreamModelsUrl,
      fallbackConfigPath: snapNow.config.fallbackConfigPath,
      modelMappingPath: snapNow.config.modelMappingPath,
      fallbackNames: snapNow.config.fallbackEndpoints.map(item => item.name),
      claudeBillingHeaderMode: snapNow.config.claudeBillingHeaderMode,
      modelMappings: snapNow.config.modelMappings,
      activeRequests: proxyStats.activeRequests,
      upstreamTimeoutMs: snapNow.config.upstreamTimeoutMs,
      nonStreamingRequestTimeoutMs: snapNow.config.nonStreamingRequestTimeoutMs,
      firstByteTimeoutMs: snapNow.config.firstByteTimeoutMs,
      firstTextTimeoutMs: snapNow.config.firstTextTimeoutMs,
      streamIdleTimeoutMs: snapNow.config.streamIdleTimeoutMs,
      totalRequestTimeoutMs: snapNow.config.totalRequestTimeoutMs,
      maxConcurrentRequests: snapNow.config.maxConcurrentRequests,
      defaultStreamMode: snapNow.config.defaultStreamMode,
      logRequestBodies: snapNow.config.logRequestBodies,
      debugSse: snapNow.config.debugSse,
      sseFailureDebugEnabled: snapNow.config.sseFailureDebugEnabled,
      sseFailureDebugDir: snapNow.config.sseFailureDebugDir,
      streamMissingUsageDebugEnabled: snapNow.config.streamMissingUsageDebugEnabled,
      streamMissingUsageDebugDir: snapNow.config.streamMissingUsageDebugDir,
      fallbackOnRetryable4xx: snapNow.config.fallbackOnRetryable4xx,
      fallbackOnCompat4xx: snapNow.config.fallbackOnCompat4xx,
      compatFallbackPatterns: snapNow.config.compatFallbackPatterns,
      clientErrorPatterns: snapNow.config.clientErrorPatterns,
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
    logRequestBodies: s.logRequestBodies,
    debugSse: s.debugSse,
    sseFailureDebugEnabled: s.sseFailureDebugEnabled,
    sseFailureDebugDir: s.sseFailureDebugDir,
    streamMissingUsageDebugEnabled: s.streamMissingUsageDebugEnabled,
    streamMissingUsageDebugDir: s.streamMissingUsageDebugDir,
    stats: proxyStats,
  };
  const config = { ...baseConfig, adminHandler, endpointHealthStore };
  const server = createAnthropicProxyServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Instance: ${s.instanceName}`);
    console.log(`Anthropic proxy listening on http://${s.host}:${s.port}`);
    console.log(`Primary provider: ${s.primaryProviderName}`);
    console.log(`Forwarding POST /v1/messages to ${s.upstreamMessagesUrl}`);
    console.log(`Fallback config path: ${s.fallbackConfigPath}`);
    console.log(`Model mapping path: ${s.modelMappingPath}`);
    console.log(
      `Model aliases: ${Object.keys(s.modelMappings).length === 0 ? 'none' : Object.entries(s.modelMappings).map(([alias, target]) => `${alias} -> ${target}`).join(', ')}`,
    );
    console.log(`Concurrency limit: ${s.maxConcurrentRequests}, upstream timeout: ${s.upstreamTimeoutMs}ms`);
    console.log(`Non-stream upstream timeout: ${s.nonStreamingRequestTimeoutMs}ms`);
    console.log(`First-byte timeout: ${s.firstByteTimeoutMs}ms, stream idle timeout: ${s.streamIdleTimeoutMs}ms`);
    console.log(`First-text timeout: ${s.firstTextTimeoutMs <= 0 ? 'disabled' : `${s.firstTextTimeoutMs}ms`}`);
    console.log(`Total request lifetime timeout: ${s.totalRequestTimeoutMs}ms`);
    console.log(`Default stream mode: ${s.defaultStreamMode}`);
    console.log(`Claude billing header mode: ${s.claudeBillingHeaderMode}`);
    console.log(`Request body logging: ${s.logRequestBodies ? 'enabled' : 'disabled'}`);
    console.log(`SSE debug logging: ${s.debugSse ? 'enabled' : 'disabled'}`);
    console.log(`Retryable 4xx fallback: ${s.fallbackOnRetryable4xx ? 'enabled' : 'disabled'}`);
    console.log(`Compatibility 4xx fallback: ${s.fallbackOnCompat4xx ? 'enabled' : 'disabled'}`);
    console.log(`Endpoint timeout cooldown: ${s.endpointTimeoutCooldownMs}ms`);
    console.log(`Endpoint invalid-response cooldown: ${s.endpointInvalidResponseCooldownMs}ms`);
    console.log(`Endpoint auth cooldown: ${s.endpointAuthCooldownMs}ms`);
    console.log(`Endpoint failure threshold: ${s.endpointFailureThreshold}`);
    console.log(`Endpoint half-open max probes: ${s.endpointHalfOpenMaxProbes}`);
    console.log(`Fallback attempt budget: ${s.maxFallbackAttempts}`);
    console.log(`Fallback total budget: ${s.maxFallbackTotalMs}ms`);
    console.log(`SSE failure capture: ${s.sseFailureDebugEnabled ? `enabled -> ${s.sseFailureDebugDir}` : 'disabled'}`);
    console.log(`Stream missing usage capture: ${s.streamMissingUsageDebugEnabled ? `enabled -> ${s.streamMissingUsageDebugDir}` : 'disabled'}`);
    console.log(`Fallback upstreams: ${s.fallbackEndpoints.length === 0 ? 'none' : s.fallbackEndpoints.map(item => item.name).join(', ')}`);
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
