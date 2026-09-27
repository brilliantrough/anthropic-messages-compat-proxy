export const routingPolicyDefaults = {
  PROXY_HEALTH_WINDOW_MS: '180000',
  PROXY_HEALTH_FAILURE_THRESHOLD: '15',
  PROXY_HEALTH_FAILURE_RATE_THRESHOLD: '0.5',
  PROXY_HEALTH_COOLDOWN_MS: '600000',
  PROXY_CHANNEL_MAX_ATTEMPTS: '3',
  PROXY_CHANNEL_RETRY_DELAY_MS: '500',
  PROXY_QUOTA_COOLDOWN_MS: '7200000',
};

export type RoutingPolicyConfig = {
  healthWindowMs: number;
  healthFailureThreshold: number;
  healthFailureRateThreshold: number;
  healthCooldownMs: number;
  channelMaxAttempts: number;
  channelRetryDelayMs: number;
  quotaCooldownMs: number;
};

export const LEGACY_ROUTING_ENV_KEYS = [
  'PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS',
  'PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS',
  'PROXY_ENDPOINT_AUTH_COOLDOWN_MS',
  'PROXY_ENDPOINT_FAILURE_THRESHOLD',
  'PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES',
  'PROXY_MAX_FALLBACK_ATTEMPTS',
] as const;

export function readRoutingPolicyConfig(env: NodeJS.ProcessEnv): RoutingPolicyConfig {
  const number = (key: keyof typeof routingPolicyDefaults, min = 1, fraction = false) => {
    const value = Number(env[key] ?? routingPolicyDefaults[key]);
    if (!Number.isFinite(value) || value < min || (fraction ? value >= 1 : !Number.isSafeInteger(value))) {
      throw new Error(`${key} must be ${fraction ? 'a number >= 0 and < 1' : `an integer >= ${min}`}`);
    }
    return value;
  };
  return {
    healthWindowMs: number('PROXY_HEALTH_WINDOW_MS'),
    healthFailureThreshold: number('PROXY_HEALTH_FAILURE_THRESHOLD'),
    healthFailureRateThreshold: number('PROXY_HEALTH_FAILURE_RATE_THRESHOLD', 0, true),
    healthCooldownMs: number('PROXY_HEALTH_COOLDOWN_MS'),
    channelMaxAttempts: number('PROXY_CHANNEL_MAX_ATTEMPTS'),
    channelRetryDelayMs: number('PROXY_CHANNEL_RETRY_DELAY_MS', 0),
    quotaCooldownMs: number('PROXY_QUOTA_COOLDOWN_MS'),
  };
}
