import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import type { ClaudeBillingHeaderMode } from './responses-input-normalization.js';
import { isEnabled } from './proxy-config.js';
import { loadRoutingConfig, type RoutingConfig } from './routing-config.js';
import { LEGACY_ROUTING_ENV_KEYS, readRoutingPolicyConfig, routingPolicyDefaults } from './routing-policy.js';

export type StreamMode = 'normalized' | 'raw';

export type AnthropicRuntimeConfig = {
  host: string;
  port: number;
  instanceName: string;
  adminAllowHost: boolean;
  routingConfigPath: string;
  routingConfig: RoutingConfig;
  anthropicVersion: string;
  anthropicBeta: string | undefined;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
  healthWindowMs: number;
  healthFailureThreshold: number;
  healthFailureRateThreshold: number;
  healthCooldownMs: number;
  channelMaxAttempts: number;
  channelRetryDelayMs: number;
  quotaCooldownMs: number;
  maxFallbackTotalMs: number;
  upstreamTimeoutMs: number;
  nonStreamingRequestTimeoutMs: number;
  firstByteTimeoutMs: number;
  firstTextTimeoutMs: number;
  streamIdleTimeoutMs: number;
  totalRequestTimeoutMs: number;
  maxConcurrentRequests: number;
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
  usageDbPath: string;
};

function parseStreamMode(value: string | undefined): StreamMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'raw' ? 'raw' : 'normalized';
}

function parseEnvList(value: string | undefined, defaults: string[]): string[] {
  if (value === undefined || value.trim() === '') {
    return defaults;
  }
  return value
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function parseClaudeBillingHeaderMode(value: string | undefined): ClaudeBillingHeaderMode {
  if (value === undefined || value.trim() === '') {
    return 'strip_line';
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'strip_line' || normalized === 'strip_cch') {
    return normalized;
  }
  console.warn(
    `Ignoring unsupported PROXY_CLAUDE_BILLING_HEADER_MODE value ${JSON.stringify(value)}; expected "strip_line" or "strip_cch"`,
  );
  return 'strip_line';
}

export function readInstanceEnv(envPath: string): NodeJS.ProcessEnv {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = dotenvParse(readFileSync(envPath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }
  return { ...process.env, ...fileEnv };
}

export function createAnthropicRuntimeConfig(envPath: string): AnthropicRuntimeConfig {
  const resolvedEnvPath = resolve(envPath);
  const configDir = dirname(resolvedEnvPath);
  const env = readInstanceEnv(resolvedEnvPath);

  const routingConfigPath = resolve(env.FALLBACK_CONFIG_PATH ?? join(configDir, 'fallback.json'));
  const routingConfig = loadRoutingConfig(routingConfigPath);

  const legacyPrimaryKeys = ['PRIMARY_PROVIDER_NAME', 'PRIMARY_PROVIDER_BASE_URL', 'PRIMARY_PROVIDER_API_KEY', 'PRIMARY_PROVIDER_DEFAULT_MODEL']
    .filter(key => env[key] !== undefined);
  if (legacyPrimaryKeys.length > 0) {
    console.warn(`PRIMARY_PROVIDER_* variables are ignored (${legacyPrimaryKeys.join(', ')}); channels and models come from ${routingConfigPath}`);
  }
  const legacyRoutingKeys = LEGACY_ROUTING_ENV_KEYS.filter(key => env[key] !== undefined);
  if (legacyRoutingKeys.length > 0) {
    console.warn(`Legacy endpoint health settings ignored: ${legacyRoutingKeys.join(', ')}; use the PROXY_HEALTH_* / PROXY_CHANNEL_* rolling-window policy`);
  }
  if (env.MODEL_MAP_PATH !== undefined) {
    console.warn('MODEL_MAP_PATH is ignored; aliases come from the routing config');
  }

  const host = env.HOST ?? '0.0.0.0';
  const port = Number(env.PORT ?? 11234);
  const instanceName = env.INSTANCE_NAME ?? `anthropic-proxy-${port}`;
  const policy = readRoutingPolicyConfig(env);
  const maxFallbackTotalMs = Number(env.PROXY_MAX_FALLBACK_TOTAL_MS ?? 30000);
  const defaultCompatFallbackPatterns = [
    'model not found',
    'unsupported model',
    '未配置模型',
    'does not support',
    'unsupported parameter',
    'store must be false',
  ];
  const defaultClientErrorPatterns = [
    'invalid json',
    'maximum context length',
    'context length exceeded',
    'too many input tokens',
    'prompt is too long',
    'invalid tool schema',
    'json schema is invalid',
  ];

  return {
    host,
    port,
    instanceName,
    adminAllowHost: isEnabled(env.PROXY_ADMIN_ALLOW_HOST),
    routingConfigPath,
    routingConfig,
    anthropicVersion: env.ANTHROPIC_VERSION ?? '2023-06-01',
    anthropicBeta: env.ANTHROPIC_BETA?.trim() || undefined,
    claudeBillingHeaderMode: parseClaudeBillingHeaderMode(env.PROXY_CLAUDE_BILLING_HEADER_MODE),
    ...policy,
    maxFallbackTotalMs,
    upstreamTimeoutMs: Number(env.PROXY_UPSTREAM_TIMEOUT_MS ?? 30000),
    nonStreamingRequestTimeoutMs: Number(env.PROXY_NON_STREAM_TIMEOUT_MS ?? 300000),
    firstByteTimeoutMs: Number(env.PROXY_FIRST_BYTE_TIMEOUT_MS ?? 30000),
    firstTextTimeoutMs: Number(env.PROXY_FIRST_TEXT_TIMEOUT_MS ?? 12000),
    streamIdleTimeoutMs: Number(env.PROXY_STREAM_IDLE_TIMEOUT_MS ?? 60000),
    totalRequestTimeoutMs: Number(env.PROXY_TOTAL_REQUEST_TIMEOUT_MS ?? 600000),
    maxConcurrentRequests: Number(env.PROXY_MAX_CONCURRENT_REQUESTS ?? 128),
    defaultStreamMode: parseStreamMode(env.PROXY_STREAM_MODE),
    logRequestBodies: isEnabled(env.PROXY_LOG_REQUEST_BODY),
    debugSse: isEnabled(env.PROXY_DEBUG_SSE),
    sseFailureDebugEnabled: isEnabled(env.PROXY_SSE_FAILURE_DEBUG),
    sseFailureDebugDir: resolve(env.PROXY_SSE_FAILURE_DIR ?? join(configDir, 'captures', instanceName, 'sse-failures')),
    streamMissingUsageDebugEnabled: isEnabled(env.PROXY_STREAM_MISSING_USAGE_DEBUG),
    streamMissingUsageDebugDir: resolve(
      env.PROXY_STREAM_MISSING_USAGE_DIR ?? join(configDir, 'captures', instanceName, 'stream', 'missing-usage'),
    ),
    fallbackOnRetryable4xx: isEnabled(env.PROXY_FALLBACK_ON_RETRYABLE_4XX, true),
    fallbackOnCompat4xx: isEnabled(env.PROXY_FALLBACK_ON_COMPAT_4XX, true),
    compatFallbackPatterns: parseEnvList(env.PROXY_FALLBACK_COMPAT_PATTERNS, defaultCompatFallbackPatterns),
    clientErrorPatterns: parseEnvList(
      env.PROXY_NO_FALLBACK_CLIENT_ERROR_PATTERNS ?? env.PROXY_FALLBACK_CLIENT_ERROR_PATTERNS,
      defaultClientErrorPatterns,
    ),
    usageDbPath: resolve(env.PROXY_USAGE_DB_PATH ?? join(configDir, 'usage.sqlite')),
  };
}

export { routingPolicyDefaults };
