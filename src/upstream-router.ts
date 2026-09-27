import type { HealthLease, HealthRegistry, FailureEvidence } from './channel-health.js';
import { classifyHealthDecision } from './channel-health.js';
import type { ResolvedModelRoute } from './model-router.js';
import type { ChannelConfig, RoutingConfig } from './routing-config.js';

export type ChannelAttempts = {
  attemptedChannelIds: Set<string>;
  counts: Map<string, number>;
  cursor: number;
  maxAttempts: number;
};

export const routingAttemptStats = { upstreamAttempts: 0, sameChannelRetries: 0, channelSwitches: 0 };

export function createChannelAttempts(maxAttempts = 3): ChannelAttempts {
  return { attemptedChannelIds: new Set(), counts: new Map(), cursor: 0, maxAttempts };
}

export type AnthropicFallbackBudget = {
  startedAt: number;
  attemptsUsed: number;
};

export function createFallbackBudget(): AnthropicFallbackBudget {
  return { startedAt: Date.now(), attemptsUsed: 0 };
}

export function hasBudgetLeft(budget: AnthropicFallbackBudget, maxTotalMs: number): boolean {
  return maxTotalMs <= 0 || Date.now() - budget.startedAt < maxTotalMs;
}

// Availability-only probe used for retry decisions and log fields; it never reserves a lease.
export function peekNextChannel(
  route: ResolvedModelRoute,
  config: RoutingConfig,
  health: HealthRegistry,
  attempts: ChannelAttempts,
): ChannelConfig | undefined {
  for (let index = attempts.cursor; index < route.channelIds.length; index += 1) {
    const channelId = route.channelIds[index];
    if ((attempts.counts.get(channelId) ?? 0) >= attempts.maxAttempts) {
      continue;
    }
    const channel = config.channelsById.get(channelId);
    if (channel === undefined) {
      continue;
    }
    const availability = health.availability({
      channelId: channel.id,
      channelFingerprint: channel.fingerprint,
      canonicalModel: route.canonicalModel,
      disableCooldown: channel.disableCooldown,
    });
    if (availability.ok) {
      return channel;
    }
  }
  return undefined;
}

export type ChannelSelection =
  | Readonly<{ ok: true; channel: ChannelConfig; channelIndex: number; lease: HealthLease; retryOfSameChannel: boolean }>
  | Readonly<{ ok: false; code: 'all_attempted'; attemptedChannelIds: readonly string[] }>
  | Readonly<{ ok: false; code: 'all_unavailable'; retryAfterMs: number; attemptedChannelIds: readonly string[] }>;

function attemptedIds(attemptedChannelIds: ReadonlySet<string>): readonly string[] {
  return Array.from(attemptedChannelIds);
}

export function selectNextChannel(
  route: ResolvedModelRoute,
  config: RoutingConfig,
  health: HealthRegistry,
  attempts: ChannelAttempts,
): ChannelSelection {
  const { attemptedChannelIds } = attempts;
  let maxRetryAfterMs = 0;
  let unavailableCandidateCount = 0;

  for (let channelIndex = attempts.cursor; channelIndex < route.channelIds.length; channelIndex += 1) {
    const channelId = route.channelIds[channelIndex];
    if ((attempts.counts.get(channelId) ?? 0) >= attempts.maxAttempts) {
      continue;
    }

    const channel = config.channelsById.get(channelId);
    if (channel === undefined) {
      continue;
    }

    const acquisition = health.acquire({
      channelId: channel.id,
      channelFingerprint: channel.fingerprint,
      canonicalModel: route.canonicalModel,
      disableCooldown: channel.disableCooldown,
    });

    if (acquisition.ok) {
      routingAttemptStats.upstreamAttempts += 1;
      const retryOfSameChannel = attempts.counts.has(channelId);
      if (retryOfSameChannel) routingAttemptStats.sameChannelRetries += 1;
      else if (attemptedChannelIds.size > 0) routingAttemptStats.channelSwitches += 1;
      attempts.cursor = channelIndex;
      attempts.counts.set(channelId, (attempts.counts.get(channelId) ?? 0) + 1);
      attemptedChannelIds.add(channelId);
      return { ok: true, channel, channelIndex, lease: acquisition.lease, retryOfSameChannel };
    }

    unavailableCandidateCount += 1;
    maxRetryAfterMs = Math.max(maxRetryAfterMs, acquisition.retryAfterMs);
  }

  if (unavailableCandidateCount > 0) {
    return {
      ok: false,
      code: 'all_unavailable',
      retryAfterMs: maxRetryAfterMs,
      attemptedChannelIds: attemptedIds(attemptedChannelIds),
    };
  }

  return {
    ok: false,
    code: 'all_attempted',
    attemptedChannelIds: attemptedIds(attemptedChannelIds),
  };
}

export function reportChannelSuccess(lease: HealthLease, health: HealthRegistry): void {
  health.complete(lease, { scope: 'model_channel', success: true, reason: 'ok', channelReachabilityProven: true });
}

export function reportChannelFailure(lease: HealthLease, health: HealthRegistry, evidence: FailureEvidence): void {
  const decision = classifyHealthDecision(evidence);
  health.complete(lease, {
    scope: decision.scope,
    success: false,
    reason: decision.reason,
    channelReachabilityProven: decision.channelReachabilityProven,
  });
}

export function isModelChannelsUnavailable(selection: ChannelSelection): boolean {
  return !selection.ok && selection.code === 'all_unavailable' && selection.attemptedChannelIds.length === 0;
}

// Same-channel retry pacing; the wait is cancellable so client disconnects and the
// request deadline stop a queued retry instead of letting it fire late.
export function waitForRetryDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) {
    return Promise.resolve(true);
  }
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
