import type { UpstreamEndpoint } from './anthropic-config.js';

export type AnthropicFallbackBudget = {
  startedAt: number;
  attemptsUsed: number;
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
