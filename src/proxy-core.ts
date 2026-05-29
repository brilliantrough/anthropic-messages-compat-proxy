import type { UpstreamEndpoint } from './anthropic-config.js';

export type AnthropicFallbackBudget = {
  startedAt: number;
  attemptsUsed: number;
};

export type AnthropicEndpointFailureReason =
  | 'upstream_5xx'
  | 'retryable_4xx'
  | 'compat_4xx'
  | 'connect_error'
  | 'connect_timeout'
  | 'headers_only_timeout'
  | 'stream_no_usable_content'
  | 'stream_missing_usage'
  | 'empty_response'
  | 'unknown_upstream_error';

export type EndpointCircuitState = 'closed' | 'open' | 'half_open';

export type EndpointHealthRecord = {
  state: EndpointCircuitState;
  failureCount: number;
  successCount: number;
  cooldownUntil: number;
  lastFailureReason: AnthropicEndpointFailureReason | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  halfOpenProbeInFlight: number;
};

export type EndpointHealthSnapshot = EndpointHealthRecord & {
  name: string;
  url: string;
  remainingMs: number;
  remainingSeconds: number;
};

export type EndpointHealthStore = {
  getSnapshot(endpoint: UpstreamEndpoint): EndpointHealthSnapshot;
  listSnapshots(endpoints: UpstreamEndpoint[]): EndpointHealthSnapshot[];
  isEndpointAvailable(endpoint: UpstreamEndpoint): boolean;
  reserveEndpointProbe(endpoint: UpstreamEndpoint): void;
  releaseEndpointProbe(endpoint: UpstreamEndpoint): void;
  markEndpointFailure(endpoint: UpstreamEndpoint, reason: AnthropicEndpointFailureReason): void;
  markEndpointSuccess(endpoint: UpstreamEndpoint): void;
};

export function buildEndpointOrder(
  primary: UpstreamEndpoint,
  fallbacks: UpstreamEndpoint[],
): UpstreamEndpoint[] {
  return [primary, ...fallbacks];
}

export function createFallbackBudget(): AnthropicFallbackBudget {
  return {
    startedAt: Date.now(),
    attemptsUsed: 0,
  };
}

function createDefaultHealthRecord(): EndpointHealthRecord {
  return {
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    cooldownUntil: 0,
    lastFailureReason: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    halfOpenProbeInFlight: 0,
  };
}

function getCooldownMsForReason(
  reason: AnthropicEndpointFailureReason,
  config: {
    endpointTimeoutCooldownMs: number;
    endpointInvalidResponseCooldownMs: number;
    endpointAuthCooldownMs: number;
  },
) {
  if (reason === 'connect_error' || reason === 'connect_timeout' || reason === 'headers_only_timeout') {
    return config.endpointTimeoutCooldownMs;
  }

  if (reason === 'retryable_4xx' || reason === 'compat_4xx') {
    return config.endpointAuthCooldownMs;
  }

  return config.endpointInvalidResponseCooldownMs;
}

function shouldOpenCircuitImmediately(reason: AnthropicEndpointFailureReason) {
  return [
    'connect_error',
    'connect_timeout',
    'headers_only_timeout',
    'retryable_4xx',
    'compat_4xx',
    'upstream_5xx',
    'empty_response',
    'stream_no_usable_content',
    'stream_missing_usage',
    'unknown_upstream_error',
  ].includes(reason);
}

export function createEndpointHealthStore(config: {
  endpointTimeoutCooldownMs: number;
  endpointInvalidResponseCooldownMs: number;
  endpointAuthCooldownMs: number;
  endpointFailureThreshold: number;
  endpointHalfOpenMaxProbes: number;
}): EndpointHealthStore {
  const endpointHealth = new Map<string, EndpointHealthRecord>();

  function getEndpointKey(endpoint: UpstreamEndpoint) {
    return `${endpoint.name}::${endpoint.url}`;
  }

  function getHealth(endpoint: UpstreamEndpoint) {
    const key = getEndpointKey(endpoint);
    const current = endpointHealth.get(key);
    if (current) {
      return current;
    }

    const created = createDefaultHealthRecord();
    endpointHealth.set(key, created);
    return created;
  }

  function getSnapshot(endpoint: UpstreamEndpoint): EndpointHealthSnapshot {
    const health = getHealth(endpoint);
    const now = Date.now();
    const remainingMs = health.state === 'open' && health.cooldownUntil > now ? health.cooldownUntil - now : 0;
    return {
      name: endpoint.name,
      url: endpoint.url,
      ...health,
      remainingMs,
      remainingSeconds: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    };
  }

  function markEndpointFailure(endpoint: UpstreamEndpoint, reason: AnthropicEndpointFailureReason) {
    const health = getHealth(endpoint);
    const now = Date.now();
    health.failureCount += 1;
    health.lastFailureReason = reason;
    health.lastFailureAt = now;

    if (endpoint.disableCooldown) {
      health.state = 'closed';
      health.cooldownUntil = 0;
      health.halfOpenProbeInFlight = 0;
      return;
    }

    const shouldOpenNow = shouldOpenCircuitImmediately(reason) || health.failureCount >= Math.max(1, config.endpointFailureThreshold);
    if (!shouldOpenNow) {
      return;
    }

    const cooldownMs = getCooldownMsForReason(reason, config);
    health.state = cooldownMs > 0 ? 'open' : 'closed';
    health.cooldownUntil = cooldownMs > 0 ? now + cooldownMs : 0;
    health.halfOpenProbeInFlight = 0;
  }

  function markEndpointSuccess(endpoint: UpstreamEndpoint) {
    const health = getHealth(endpoint);
    health.state = 'closed';
    health.failureCount = 0;
    health.successCount += 1;
    health.cooldownUntil = 0;
    health.lastSuccessAt = Date.now();
    health.halfOpenProbeInFlight = 0;
  }

  function isEndpointAvailable(endpoint: UpstreamEndpoint) {
    const health = getHealth(endpoint);
    const now = Date.now();

    if (health.state === 'open') {
      if (health.cooldownUntil > now) {
        return false;
      }

      health.state = 'half_open';
      health.halfOpenProbeInFlight = 0;
    }

    if (health.state === 'half_open' && health.halfOpenProbeInFlight >= Math.max(1, config.endpointHalfOpenMaxProbes)) {
      return false;
    }

    return true;
  }

  function reserveEndpointProbe(endpoint: UpstreamEndpoint) {
    const health = getHealth(endpoint);
    if (health.state === 'half_open') {
      health.halfOpenProbeInFlight += 1;
    }
  }

  function releaseEndpointProbe(endpoint: UpstreamEndpoint) {
    const health = getHealth(endpoint);
    if (health.halfOpenProbeInFlight > 0) {
      health.halfOpenProbeInFlight -= 1;
    }
  }

  return {
    getSnapshot,
    listSnapshots(endpoints) {
      return endpoints.map(endpoint => getSnapshot(endpoint));
    },
    isEndpointAvailable,
    reserveEndpointProbe,
    releaseEndpointProbe,
    markEndpointFailure,
    markEndpointSuccess,
  };
}

export function canFallback(
  budget: AnthropicFallbackBudget,
  currentIndex: number,
  endpoints: UpstreamEndpoint[],
  maxAttempts: number,
  maxTotalMs: number,
): boolean {
  if (currentIndex >= endpoints.length - 1) {
    return false;
  }

  if (budget.attemptsUsed >= maxAttempts) {
    return false;
  }

  if (maxTotalMs > 0 && Date.now() - budget.startedAt >= maxTotalMs) {
    return false;
  }

  return true;
}
