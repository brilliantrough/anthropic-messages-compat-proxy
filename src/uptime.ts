import type { HealthRegistry } from './channel-health.js';
import type { RuntimeConfigStore } from './runtime-config.js';
import type { AnthropicRuntimeConfig } from './anthropic-config.js';
import type { RoutingConfig } from './routing-config.js';
import type { createUsageStore } from './usage-store.js';

export const UPTIME_INTERVAL_MS = 180_000;

// Only the fields the sampling loop reads are required, so any current runtime snapshot qualifies.
export type UptimeRuntimeConfig = Readonly<{
  routingConfig: RoutingConfig;
  healthWindowMs: number;
  healthFailureThreshold: number;
  healthFailureRateThreshold: number;
}>;

export type UptimeRuntime = Readonly<{ getSnapshot(): Readonly<{ config: UptimeRuntimeConfig }> }>;
export type UptimeSample = {
  bucket: number; sampledAt: number; model: string; channelId: string; fingerprint: string;
  state: 'green' | 'yellow' | 'red'; reason: string; successes: number; failures: number;
  failureThreshold: number; rateThreshold: number; windowMs: number;
};
export type UptimeQuery = { from: number; to: number; model: string };

export function collectUptime(runtime: UptimeRuntime, health: HealthRegistry, now = Date.now()): UptimeSample[] {
  const config = runtime.getSnapshot().config;
  const snapshot = health.snapshot();
  const channels = new Map(snapshot.channels.map(channel => [channel.channelId, channel]));
  const records = new Map(snapshot.modelChannels.map(record => [JSON.stringify([record.canonicalModel, record.channelId]), record]));
  const rows: UptimeSample[] = [];
  for (const route of config.routingConfig.modelRoutes.values()) {
    for (const id of route.channelIds) {
      const channel = channels.get(id);
      const record = records.get(JSON.stringify([route.canonicalModel, id]));
      if (!channel || !record) continue;
      const failures = record.modelWindowFailures, successes = record.modelWindowSuccesses;
      const countExceeded = failures >= config.healthFailureThreshold;
      const rateExceeded = failures + successes > 0 && failures / (failures + successes) > config.healthFailureRateThreshold;
      const reason = channel.manualRemainingSeconds > 0 ? 'manual' : channel.quotaRemainingSeconds > 0 ? 'quota'
        : !channel.disableCooldown && channel.remainingMs > 0 ? 'breaker'
        : countExceeded !== rateExceeded ? (countExceeded ? 'failure_count' : 'failure_rate')
        : channel.disableCooldown && countExceeded && rateExceeded ? 'no_breaker' : 'available';
      rows.push({ bucket: Math.floor(now / UPTIME_INTERVAL_MS) * UPTIME_INTERVAL_MS, sampledAt: now,
        model: route.canonicalModel, channelId: id, fingerprint: channel.fingerprint,
        state: ['manual', 'quota', 'breaker'].includes(reason) ? 'red' : countExceeded !== rateExceeded ? 'yellow' : 'green',
        reason, successes, failures, failureThreshold: config.healthFailureThreshold, rateThreshold: config.healthFailureRateThreshold, windowMs: config.healthWindowMs });
    }
  }
  return rows;
}

export function startUptimeSampling(runtime: RuntimeConfigStore<AnthropicRuntimeConfig>, health: HealthRegistry, store: ReturnType<typeof createUsageStore>) {
  let timer: NodeJS.Timeout;
  function sample() {
    store.writeUptime(collectUptime(runtime, health));
    timer = setTimeout(sample, UPTIME_INTERVAL_MS - Date.now() % UPTIME_INTERVAL_MS);
    timer.unref();
  }
  sample();
  return () => clearTimeout(timer);
}
