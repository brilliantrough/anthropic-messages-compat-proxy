import 'dotenv/config';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ClaudeBillingHeaderMode, JsonValue } from './responses-input-normalization.js';
import {
  handleMessagesRequest,
  createProxyStats,
  recordStatus,
  type ProxyStats,
  type AnthropicMessagesHandlerOptions,
} from './anthropic-messages-handler.js';
import { handleModelsRequest } from './anthropic-models-handler.js';
import { type StreamMode, type AnthropicRuntimeConfig } from './anthropic-config.js';
import type { RoutingConfig } from './routing-config.js';
import { createAdminHandler } from './admin-api.js';
import { createConfigFileStoreFromPaths } from './config-files.js';
import { buildHealthTopology, createRuntimeConfigStore, type RuntimeConfigStore, type RuntimeSnapshot } from './runtime-config.js';
import { createHealthRegistry, type HealthRegistry, type HealthRegistryOptions } from './channel-health.js';
import { routingAttemptStats } from './upstream-router.js';
import { createUsageStore } from './usage-store.js';
import { createUsageContext, type UsageContext } from './usage-tracking.js';
import { collectUptime, startUptimeSampling, UPTIME_INTERVAL_MS } from './uptime.js';
import { bootstrapHttpProxySupport } from './http-proxy-bootstrap.js';
import {
  normalizeBaseUrl,
  sendJson,
  makeAnthropicError,
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
  channelMaxAttempts: 3,
  channelRetryDelayMs: 500,
} as const;

const _requestContext = new AsyncLocalStorage<RuntimeSnapshot<AnthropicRuntimeConfig>>();
let _runtimeStore: RuntimeConfigStore<AnthropicRuntimeConfig> | null = null;
let _initialSnapshot: RuntimeSnapshot<AnthropicRuntimeConfig>;

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

export type AnthropicProxyConfig = {
  port: number;
  host?: string;
  instanceName?: string;
  routingConfig: RoutingConfig;
  anthropicVersion?: string;
  anthropicBeta?: string;
  claudeBillingHeaderMode?: ClaudeBillingHeaderMode;
  cacheControlMode?: import('./anthropic-input-normalization.js').CacheControlMode;
  cacheControlTtl?: string;
  healthWindowMs?: number;
  healthFailureThreshold?: number;
  healthFailureRateThreshold?: number;
  healthCooldownMs?: number;
  quotaCooldownMs?: number;
  channelMaxAttempts?: number;
  channelRetryDelayMs?: number;
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
  healthRegistry?: HealthRegistry;
  usageStore?: ReturnType<typeof createUsageStore>;
  stats?: ProxyStats;
};

export function createAnthropicProxyServer(config: AnthropicProxyConfig) {
  const instanceName = config.instanceName ?? 'anthropic-proxy';
  const healthRegistryOptions: HealthRegistryOptions = {
    healthWindowMs: config.healthWindowMs,
    healthFailureThreshold: config.healthFailureThreshold,
    healthFailureRateThreshold: config.healthFailureRateThreshold,
    healthCooldownMs: config.healthCooldownMs,
    quotaCooldownMs: config.quotaCooldownMs,
  };
  const healthRegistry = config.healthRegistry ?? createHealthRegistry(healthRegistryOptions);
  // Both the CLI store and this factory use the same topology rule, so checks cannot diverge from production.
  healthRegistry.reconcile(buildHealthTopology(config.routingConfig));
  const stats = config.stats ?? createProxyStats();
  const maxConcurrentRequests = config.maxConcurrentRequests ?? DEFAULT_TIMEOUTS.maxConcurrentRequests;
  const usageContext: UsageContext = createUsageContext();
  const usageStore = config.usageStore;

  _initialSnapshot = {
    runtimeVersion: 0,
    config: {
      host: config.host ?? '0.0.0.0',
      port: config.port,
      instanceName,
      adminAllowHost: false,
      routingConfigPath: config.routingConfig.path,
      routingConfig: config.routingConfig,
      anthropicVersion: config.anthropicVersion ?? '2023-06-01',
      anthropicBeta: config.anthropicBeta,
      claudeBillingHeaderMode: config.claudeBillingHeaderMode ?? 'strip_line',
      cacheControlMode: config.cacheControlMode ?? 'off',
      cacheControlTtl: config.cacheControlTtl ?? '5m',
      healthWindowMs: config.healthWindowMs ?? 180000,
      healthFailureThreshold: config.healthFailureThreshold ?? 15,
      healthFailureRateThreshold: config.healthFailureRateThreshold ?? 0.5,
      healthCooldownMs: config.healthCooldownMs ?? 600000,
      channelMaxAttempts: config.channelMaxAttempts ?? DEFAULT_TIMEOUTS.channelMaxAttempts,
      channelRetryDelayMs: config.channelRetryDelayMs ?? DEFAULT_TIMEOUTS.channelRetryDelayMs,
      quotaCooldownMs: config.quotaCooldownMs ?? 7200000,
      maxFallbackTotalMs: config.maxFallbackTotalMs ?? DEFAULT_TIMEOUTS.maxFallbackTotalMs,
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
      usageDbPath: usageStore?.path ?? '',
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
      routingConfig: c.routingConfig,
      healthRegistry,
      channelMaxAttempts: c.channelMaxAttempts,
      channelRetryDelayMs: c.channelRetryDelayMs,
      usageContext,
      anthropicVersion: c.anthropicVersion,
      anthropicBeta: c.anthropicBeta,
      defaultModel: c.routingConfig.defaultModel,
      claudeBillingHeaderMode: c.claudeBillingHeaderMode,
      cacheControlMode: c.cacheControlMode,
      cacheControlTtl: c.cacheControlTtl,
      maxFallbackTotalMs: c.maxFallbackTotalMs,
      upstreamTimeoutMs: c.upstreamTimeoutMs,
      nonStreamingRequestTimeoutMs: c.nonStreamingRequestTimeoutMs,
      firstByteTimeoutMs: c.firstByteTimeoutMs,
      firstTextTimeoutMs: c.firstTextTimeoutMs,
      streamIdleTimeoutMs: c.streamIdleTimeoutMs,
      totalRequestTimeoutMs: c.totalRequestTimeoutMs,
      defaultStreamMode: c.defaultStreamMode,
      logRequestBodies: c.logRequestBodies,
      debugSse: c.debugSse,
      sseFailureDebugEnabled: c.sseFailureDebugEnabled,
      sseFailureDebugDir: c.sseFailureDebugDir,
      streamMissingUsageDebugEnabled: c.streamMissingUsageDebugEnabled,
      streamMissingUsageDebugDir: c.streamMissingUsageDebugDir,
      fallbackOnRetryable4xx: c.fallbackOnRetryable4xx,
      fallbackOnCompat4xx: c.fallbackOnCompat4xx,
      compatFallbackPatterns: c.compatFallbackPatterns,
      clientErrorPatterns: c.clientErrorPatterns,
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

    usageContext.run({ requestId, write: row => usageStore?.write(row) }, async () => {
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
            routingConfigPath: c.routingConfigPath,
            channels: c.routingConfig.channelsById.size,
            models: c.routingConfig.modelRoutes.size,
            defaultModel: c.routingConfig.defaultModel,
            anthropicVersion: c.anthropicVersion,
            anthropicBeta: c.anthropicBeta ?? null,
            claudeBillingHeaderMode: c.claudeBillingHeaderMode,
            cacheControlMode: c.cacheControlMode,
            cacheControlTtl: c.cacheControlTtl,
            healthWindowMs: c.healthWindowMs,
            healthFailureThreshold: c.healthFailureThreshold,
            healthFailureRateThreshold: c.healthFailureRateThreshold,
            healthCooldownMs: c.healthCooldownMs,
            channelMaxAttempts: c.channelMaxAttempts,
            channelRetryDelayMs: c.channelRetryDelayMs,
            quotaCooldownMs: c.quotaCooldownMs,
            activeRequests: stats.activeRequests,
            maxConcurrentRequests,
            usageAvailable: usageStore !== undefined,
          } as JsonValue);
          finish(200, 'health check');
          return;
        }

        if (req.method === 'GET' && requestPath === '/v1/models') {
          handleModelsRequest(req, res, {
            requestId,
            routingConfig: getConfig().routingConfig,
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

        let requestBody;
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
  });
}

export function buildAdminStats(
  runtimeStore: RuntimeConfigStore<AnthropicRuntimeConfig>,
  healthRegistry: HealthRegistry,
  proxyStats: ProxyStats,
  usageAvailable: boolean,
  usageWriteError: string | null,
) {
  const snap = runtimeStore.getSnapshot();
  const config = snap.config;
  return {
    instanceName: config.instanceName,
    host: config.host,
    port: config.port,
    routingConfigPath: config.routingConfigPath,
    defaultModel: config.routingConfig.defaultModel,
    anthropicVersion: config.anthropicVersion,
    anthropicBeta: config.anthropicBeta ?? null,
    claudeBillingHeaderMode: config.claudeBillingHeaderMode,
    cacheControlMode: config.cacheControlMode,
    cacheControlTtl: config.cacheControlTtl,
    channels: Array.from(config.routingConfig.channelsById.values()).map(channel => ({
      id: channel.id,
      name: channel.name,
      baseUrl: channel.baseUrl,
      disableCooldown: channel.disableCooldown,
      fingerprint: channel.fingerprint,
    })),
    models: Array.from(config.routingConfig.modelRoutes.values()).map(route => ({
      canonicalModel: route.canonicalModel,
      channelIds: [...route.channelIds],
    })),
    aliases: { ...config.routingConfig.aliases },
    healthWindowMs: config.healthWindowMs,
    healthFailureThreshold: config.healthFailureThreshold,
    healthFailureRateThreshold: config.healthFailureRateThreshold,
    healthCooldownMs: config.healthCooldownMs,
    channelMaxAttempts: config.channelMaxAttempts,
    channelRetryDelayMs: config.channelRetryDelayMs,
    quotaCooldownMs: config.quotaCooldownMs,
    maxFallbackTotalMs: config.maxFallbackTotalMs,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    nonStreamingRequestTimeoutMs: config.nonStreamingRequestTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    firstTextTimeoutMs: config.firstTextTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    totalRequestTimeoutMs: config.totalRequestTimeoutMs,
    maxConcurrentRequests: config.maxConcurrentRequests,
    defaultStreamMode: config.defaultStreamMode,
    logRequestBodies: config.logRequestBodies,
    debugSse: config.debugSse,
    sseFailureDebugEnabled: config.sseFailureDebugEnabled,
    sseFailureDebugDir: config.sseFailureDebugDir,
    streamMissingUsageDebugEnabled: config.streamMissingUsageDebugEnabled,
    streamMissingUsageDebugDir: config.streamMissingUsageDebugDir,
    fallbackOnRetryable4xx: config.fallbackOnRetryable4xx,
    fallbackOnCompat4xx: config.fallbackOnCompat4xx,
    compatFallbackPatterns: [...config.compatFallbackPatterns],
    clientErrorPatterns: [...config.clientErrorPatterns],
    usageAvailable,
    usageWriteError,
    usageDbPath: config.usageDbPath,
    uptimeIntervalMs: UPTIME_INTERVAL_MS,
    routingAttempts: { ...routingAttemptStats },
    healthSnapshot: healthRegistry.snapshot(),
    stats: { ...proxyStats },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envPath = process.env.PROXY_ENV_PATH ?? resolve('.env');
  const runtimeStore = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
  _runtimeStore = runtimeStore;
  const snap = runtimeStore.getSnapshot();
  _initialSnapshot = snap;

  const healthRegistry = createHealthRegistry({
    healthWindowMs: snap.config.healthWindowMs,
    healthFailureThreshold: snap.config.healthFailureThreshold,
    healthFailureRateThreshold: snap.config.healthFailureRateThreshold,
    healthCooldownMs: snap.config.healthCooldownMs,
    quotaCooldownMs: snap.config.quotaCooldownMs,
  });
  runtimeStore.registerHealthRegistry(healthRegistry);

  const usageStore = createUsageStore(snap.config.usageDbPath);
  const stopUptime = startUptimeSampling(runtimeStore, healthRegistry, usageStore);
  const proxyStats = createProxyStats();
  const adminConfigStore = createConfigFileStoreFromPaths({
    envPath,
    fallbackPath: snap.config.routingConfigPath,
  });
  const adminHandler = createAdminHandler({
    configStore: adminConfigStore,
    runtimeStore,
    healthRegistry,
    usageStore,
    getAdminStats: () => buildAdminStats(runtimeStore, healthRegistry, proxyStats, true, usageStore.writeError()),
  });

  const s = snap.config;
  const config: AnthropicProxyConfig & { host: string; port: number } = {
    port: s.port,
    host: s.host,
    instanceName: s.instanceName,
    routingConfig: s.routingConfig,
    anthropicVersion: s.anthropicVersion,
    anthropicBeta: s.anthropicBeta,
    claudeBillingHeaderMode: s.claudeBillingHeaderMode,
    cacheControlMode: s.cacheControlMode,
    cacheControlTtl: s.cacheControlTtl,
    healthWindowMs: s.healthWindowMs,
    healthFailureThreshold: s.healthFailureThreshold,
    healthFailureRateThreshold: s.healthFailureRateThreshold,
    healthCooldownMs: s.healthCooldownMs,
    quotaCooldownMs: s.quotaCooldownMs,
    channelMaxAttempts: s.channelMaxAttempts,
    channelRetryDelayMs: s.channelRetryDelayMs,
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
    fallbackOnRetryable4xx: s.fallbackOnRetryable4xx,
    fallbackOnCompat4xx: s.fallbackOnCompat4xx,
    compatFallbackPatterns: s.compatFallbackPatterns,
    clientErrorPatterns: s.clientErrorPatterns,
    stats: proxyStats,
    adminHandler,
    healthRegistry,
    usageStore,
  };
  const server = createAnthropicProxyServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Instance: ${s.instanceName}`);
    console.log(`Anthropic proxy listening on http://${s.host}:${s.port}`);
    console.log(`Routing config: ${s.routingConfigPath}`);
    console.log(`Channels: ${s.routingConfig.channelsById.size}, canonical models: ${s.routingConfig.modelRoutes.size}, aliases: ${Object.keys(s.routingConfig.aliases).length}`);
    console.log(`Default model: ${s.routingConfig.defaultModel}`);
    console.log(`Health window: ${s.healthWindowMs}ms, failure threshold: ${s.healthFailureThreshold}, failure rate > ${s.healthFailureRateThreshold}, cooldown: ${s.healthCooldownMs}ms`);
    console.log(`Channel attempts per request: ${s.channelMaxAttempts} (retry delay ${s.channelRetryDelayMs}ms), quota cooldown: ${s.quotaCooldownMs}ms`);
    console.log(`Concurrency limit: ${s.maxConcurrentRequests}, upstream timeout: ${s.upstreamTimeoutMs}ms`);
    console.log(`Non-stream upstream timeout: ${s.nonStreamingRequestTimeoutMs}ms`);
    console.log(`First-byte timeout: ${s.firstByteTimeoutMs}ms, stream idle timeout: ${s.streamIdleTimeoutMs}ms`);
    console.log(`First-text timeout: ${s.firstTextTimeoutMs <= 0 ? 'disabled' : `${s.firstTextTimeoutMs}ms`}`);
    console.log(`Total request lifetime timeout: ${s.totalRequestTimeoutMs}ms, fallback total budget: ${s.maxFallbackTotalMs}ms`);
    console.log(`Default stream mode: ${s.defaultStreamMode}`);
    console.log(`Claude billing header mode: ${s.claudeBillingHeaderMode}`);
    console.log(`Cache control mode: ${s.cacheControlMode} (ttl=${s.cacheControlTtl})`);
    console.log(`Request body logging: ${s.logRequestBodies ? 'enabled' : 'disabled'}`);
    console.log(`SSE debug logging: ${s.debugSse ? 'enabled' : 'disabled'}`);
    console.log(`Retryable 4xx fallback: ${s.fallbackOnRetryable4xx ? 'enabled' : 'disabled'}`);
    console.log(`Compatibility 4xx fallback: ${s.fallbackOnCompat4xx ? 'enabled' : 'disabled'}`);
    console.log(`SSE failure capture: ${s.sseFailureDebugEnabled ? `enabled -> ${s.sseFailureDebugDir}` : 'disabled'}`);
    console.log(`Stream missing usage capture: ${s.streamMissingUsageDebugEnabled ? `enabled -> ${s.streamMissingUsageDebugDir}` : 'disabled'}`);
    console.log(`Usage database: ${s.usageDbPath}`);
    console.log(`Uptime sampling every ${UPTIME_INTERVAL_MS}ms, ${collectUptime(runtimeStore, healthRegistry).length} channel/model pairs`);
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Anthropic Messages compatibility proxy listening',
      instanceName: s.instanceName,
      host: s.host,
      port: s.port,
      routingConfigPath: s.routingConfigPath,
      channels: s.routingConfig.channelsById.size,
      models: s.routingConfig.modelRoutes.size,
      upstreamBaseUrls: Array.from(new Set(Array.from(s.routingConfig.channelsById.values()).map(channel => normalizeBaseUrl(channel.baseUrl)))),
    }));
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; draining usage writes and closing the listener`);
    stopUptime();
    server.close(() => {
      void usageStore.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
