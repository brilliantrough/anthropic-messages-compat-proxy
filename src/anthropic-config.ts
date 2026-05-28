import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import type { ClaudeBillingHeaderMode } from './responses-input-normalization.js';
import { isEnabled } from './proxy-config.js';

export type UpstreamEndpoint = {
  name: string;
  url: string;
  apiKey: string;
  isFallback: boolean;
  disableCooldown?: boolean;
};

export type AnthropicRuntimeConfig = {
  host: string;
  port: number;
  instanceName: string;
  primaryProviderName: string;
  primaryProviderBaseUrl: string;
  apiKey: string;
  upstreamMessagesUrl: string;
  upstreamModelsUrl: string;
  anthropicVersion: string;
  anthropicBeta: string | undefined;
  defaultModel: string;
  modelMappings: Record<string, string>;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
  primaryEndpoint: UpstreamEndpoint;
  fallbackEndpoints: UpstreamEndpoint[];
  allEndpoints: UpstreamEndpoint[];
  adminAllowHost: boolean;
  endpointTimeoutCooldownMs: number;
  endpointInvalidResponseCooldownMs: number;
  endpointAuthCooldownMs: number;
  endpointFailureThreshold: number;
  endpointHalfOpenMaxProbes: number;
  maxFallbackAttempts: number;
  maxFallbackTotalMs: number;
  fallbackConfigPath: string;
  modelMappingPath: string;
};

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
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

type FallbackApiConfig = {
  name: string;
  base_url: string;
  api_key?: string;
  api_key_env?: string;
  disable_cooldown?: boolean;
};

function isFallbackApiConfig(value: unknown): value is FallbackApiConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'base_url' in value &&
    typeof (value as FallbackApiConfig).name === 'string' &&
    typeof (value as FallbackApiConfig).base_url === 'string' &&
    ((('api_key' in value) && typeof (value as FallbackApiConfig).api_key === 'string') ||
      (('api_key_env' in value) && typeof (value as FallbackApiConfig).api_key_env === 'string'))
  );
}

function resolveFallbackApiKey(item: FallbackApiConfig, env: Record<string, string | undefined>) {
  if (typeof item.api_key === 'string' && item.api_key.length > 0) {
    return item.api_key;
  }
  if (typeof item.api_key_env === 'string' && item.api_key_env.length > 0) {
    return env[item.api_key_env];
  }
  return undefined;
}

export function loadFallbackEndpoints(fallbackConfigPath: string, env: Record<string, string | undefined>) {
  try {
    const raw = readFileSync(fallbackConfigPath, 'utf8');
    const parsed = JSON.parse(raw) as { fallback_api_config?: unknown };

    if (!Array.isArray(parsed.fallback_api_config)) {
      return [] as UpstreamEndpoint[];
    }

    return parsed.fallback_api_config
      .filter(isFallbackApiConfig)
      .flatMap(item => {
        const resolvedApiKey = resolveFallbackApiKey(item, env);
        if (!resolvedApiKey) {
          console.warn(
            `Skipping fallback '${item.name}' from ${fallbackConfigPath}: missing api_key or unresolved api_key_env`,
          );
          return [] as UpstreamEndpoint[];
        }
        return [{
          name: item.name,
          url: `${normalizeBaseUrl(item.base_url)}/v1/messages`,
          apiKey: resolvedApiKey,
          isFallback: true,
          disableCooldown: item.disable_cooldown === true,
        }];
      });
  } catch (error) {
    console.warn(
      `Failed to load fallback API config from ${fallbackConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [] as UpstreamEndpoint[];
  }
}

function normalizeModelMappings(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {} as Record<string, string>;
  }
  const mappings: Record<string, string> = {};
  for (const [alias, target] of Object.entries(value)) {
    if (typeof target !== 'string') continue;
    const normalizedAlias = alias.trim();
    const normalizedTarget = target.trim();
    if (normalizedAlias.length === 0 || normalizedTarget.length === 0) continue;
    mappings[normalizedAlias] = normalizedTarget;
  }
  return mappings;
}

function loadModelMappings(modelMappingPath: string) {
  try {
    const raw = readFileSync(modelMappingPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mappingSource =
      typeof parsed === 'object' && parsed !== null && 'model_mappings' in parsed
        ? parsed.model_mappings
        : parsed;
    return normalizeModelMappings(mappingSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {} as Record<string, string>;
    }
    console.warn(
      `Failed to load model mapping config from ${modelMappingPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {} as Record<string, string>;
  }
}

export function createAnthropicRuntimeConfig(configDir: string): AnthropicRuntimeConfig {
  const envPath = join(configDir, '.env');

  let fileEnv: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, 'utf8');
    fileEnv = dotenvParse(raw);
  } catch {}

  const env: Record<string, string | undefined> = { ...process.env, ...fileEnv };
  const fallbackPath = resolve(env.FALLBACK_CONFIG_PATH ?? join(configDir, 'fallback.json'));
  const modelMapPath = resolve(env.MODEL_MAP_PATH ?? join(configDir, 'model-map.json'));

  const apiKey = env.PRIMARY_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PRIMARY_PROVIDER_API_KEY in environment');
  }

  const host = env.HOST ?? '0.0.0.0';
  const port = Number(env.PORT ?? 11234);
  const instanceName = env.INSTANCE_NAME ?? `anthropic-proxy-${port}`;
  const primaryProviderName = env.PRIMARY_PROVIDER_NAME ?? 'primary-provider';
  const primaryProviderBaseUrl = normalizeBaseUrl(env.PRIMARY_PROVIDER_BASE_URL ?? 'https://api.anthropic.com');
  const upstreamMessagesUrl = `${primaryProviderBaseUrl}/v1/messages`;
  const upstreamModelsUrl = `${primaryProviderBaseUrl}/v1/models`;
  const anthropicVersion = env.ANTHROPIC_VERSION ?? '2023-06-01';
  const anthropicBeta = env.ANTHROPIC_BETA?.trim() || undefined;
  const defaultModel = env.PRIMARY_PROVIDER_DEFAULT_MODEL ?? 'claude-sonnet-4-5';
  const claudeBillingHeaderMode = parseClaudeBillingHeaderMode(env.PROXY_CLAUDE_BILLING_HEADER_MODE);
  const fallbackEndpoints = loadFallbackEndpoints(fallbackPath, env);
  const endpointTimeoutCooldownMs = Number(env.PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS ?? 120000);
  const endpointInvalidResponseCooldownMs = Number(env.PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS ?? 120000);
  const endpointAuthCooldownMs = Number(env.PROXY_ENDPOINT_AUTH_COOLDOWN_MS ?? 1800000);
  const endpointFailureThreshold = Number(env.PROXY_ENDPOINT_FAILURE_THRESHOLD ?? 1);
  const endpointHalfOpenMaxProbes = Number(env.PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES ?? 1);
  const maxFallbackAttempts = Number(env.PROXY_MAX_FALLBACK_ATTEMPTS ?? Math.max(1, fallbackEndpoints.length));
  const maxFallbackTotalMs = Number(env.PROXY_MAX_FALLBACK_TOTAL_MS ?? 30000);

  const primaryEndpoint: UpstreamEndpoint = {
    name: primaryProviderName,
    url: upstreamMessagesUrl,
    apiKey,
    isFallback: false,
  };

  const modelMappings = loadModelMappings(modelMapPath);
  const allEndpoints = [primaryEndpoint, ...fallbackEndpoints];

  return {
    host,
    port,
    instanceName,
    primaryProviderName,
    primaryProviderBaseUrl,
    apiKey,
    upstreamMessagesUrl,
    upstreamModelsUrl,
    anthropicVersion,
    anthropicBeta,
    defaultModel,
    modelMappings,
    claudeBillingHeaderMode,
    primaryEndpoint,
    fallbackEndpoints,
    allEndpoints,
    adminAllowHost: isEnabled(env.PROXY_ADMIN_ALLOW_HOST),
    endpointTimeoutCooldownMs,
    endpointInvalidResponseCooldownMs,
    endpointAuthCooldownMs,
    endpointFailureThreshold,
    endpointHalfOpenMaxProbes,
    maxFallbackAttempts,
    maxFallbackTotalMs,
    fallbackConfigPath: resolve(fallbackPath),
    modelMappingPath: resolve(modelMapPath),
  };
}
