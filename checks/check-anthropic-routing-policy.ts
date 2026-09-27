import assert from 'node:assert/strict';

import { createHealthRegistry, classifyHealthDecision, isQuotaExhaustedEvidence } from '../src/channel-health.js';
import { buildHealthTopology } from '../src/runtime-config.js';
import { parseRoutingConfig } from '../src/routing-config.js';
import { createChannelAttempts, peekNextChannel, selectNextChannel } from '../src/upstream-router.js';
import { resolveModelRoute } from '../src/model-router.js';

const routingDoc = {
  default_model: 'model-a',
  channels: [
    { id: 'ch-1', name: 'Channel 1', base_url: 'https://ch1.example', api_key: 'key-1' },
    { id: 'ch-2', name: 'Channel 2', base_url: 'https://ch2.example', api_key: 'key-2', disable_cooldown: true },
  ],
  models: { 'model-a': { channel_ids: ['ch-1', 'ch-2'] } },
  aliases: { 'model-latest': 'model-a' },
};

const routing = parseRoutingConfig(routingDoc, '<policy-check>');
const ch1 = routing.channelsById.get('ch-1')!;
const ch2 = routing.channelsById.get('ch-2')!;

function registryWithClock(now: () => number, options: Record<string, number> = {}) {
  const registry = createHealthRegistry({
    healthWindowMs: 180_000,
    healthFailureThreshold: 15,
    healthFailureRateThreshold: 0.5,
    healthCooldownMs: 600_000,
    quotaCooldownMs: 7_200_000,
    now,
    ...options,
  });
  registry.reconcile(buildHealthTopology(routing));
  return registry;
}

function attemptOnce(registry: ReturnType<typeof createHealthRegistry>, channelId: string, success: boolean, reason = 'upstream_5xx', scope: 'channel' | 'model_channel' = 'model_channel') {
  const channel = routing.channelsById.get(channelId)!;
  const acquired = registry.acquire({ channelId, channelFingerprint: channel.fingerprint, canonicalModel: 'model-a', disableCooldown: channel.disableCooldown });
  assert.equal(acquired.ok, true);
  if (acquired.ok) {
    registry.complete(acquired.lease, { scope, success, reason, channelReachabilityProven: true });
  }
}

function channelSnapshot(registry: ReturnType<typeof createHealthRegistry>, channelId: string) {
  const snapshot = registry.snapshot();
  return snapshot.channels.find(record => record.channelId === channelId)!;
}

async function main() {
  console.log('=== 1. Routing config validation ===');
  assert.equal(routing.defaultModel, 'model-a');
  assert.equal(routing.aliases['model-latest'], 'model-a');
  assert.equal(ch1.messagesUrl, 'https://ch1.example/v1/messages');
  assert.equal(ch2.disableCooldown, true);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, fallback_api_config: [] }, '<x>'), /fallback_api_config/);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, channels: [{ id: 'a', base_url: 'https://a', api_key: 'k' }, { id: 'a', base_url: 'https://b', api_key: 'k' }] }, '<x>'), /duplicates another channel id/);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, models: { 'model-a': { channel_ids: ['nope'] } } }, '<x>'), /unknown channel id/);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, aliases: { 'model-latest': 'model-latest' } }, '<x>'), /must not target another alias/);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, aliases: { 'model-latest': 'nope' } }, '<x>'), /targets an unknown canonical model/);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, models: { ...routingDoc.models, 'model-latest': { channel_ids: ['ch-1'] } } }, '<x>'), /collides with a canonical model name/);
  assert.throws(() => parseRoutingConfig({ ...routingDoc, default_model: 'nope' }, '<x>'), /default_model/);
  console.log('Routing config validation checks passed.');

  console.log('=== 2. Model resolution ===');
  const aliasRoute = resolveModelRoute('model-latest', routing);
  assert.ok(!('code' in aliasRoute));
  assert.equal(aliasRoute.canonicalModel, 'model-a');
  assert.equal(aliasRoute.requestedModel, 'model-latest');
  const missing = resolveModelRoute('unconfigured-model', routing);
  assert.ok('code' in missing && missing.code === 'model_not_configured');
  const defaultRoute = resolveModelRoute(undefined, routing);
  assert.ok(!('code' in defaultRoute));
  assert.equal(defaultRoute.requestedModel, 'model-a');
  console.log('Model resolution checks passed.');

  console.log('=== 3. Attempt order, retry pacing and channel switching ===');
  let now = 1_000_000;
  const registry = registryWithClock(() => now);
  const attempts = createChannelAttempts(3);
  const route = { requestedModel: 'model-a', canonicalModel: 'model-a', channelIds: ['ch-1', 'ch-2'] as const };
  const first = selectNextChannel(route, routing, registry, attempts);
  assert.ok(first.ok && first.channel.id === 'ch-1' && first.retryOfSameChannel === false);
  attemptOnce(registry, 'ch-1', false);
  const second = selectNextChannel(route, routing, registry, attempts);
  assert.ok(second.ok && second.channel.id === 'ch-1' && second.retryOfSameChannel === true, 'second attempt retries the same channel');
  attemptOnce(registry, 'ch-1', false);
  const third = selectNextChannel(route, routing, registry, attempts);
  assert.ok(third.ok && third.channel.id === 'ch-1' && third.retryOfSameChannel === true);
  attemptOnce(registry, 'ch-1', false);
  const fourth = selectNextChannel(route, routing, registry, attempts);
  assert.ok(fourth.ok && fourth.channel.id === 'ch-2' && fourth.retryOfSameChannel === false, 'fourth attempt switches channel');
  assert.equal(attempts.counts.get('ch-1'), 3, 'a channel is attempted at most three times per request');
  attemptOnce(registry, 'ch-2', true);
  const fifth = selectNextChannel(route, routing, registry, attempts);
  assert.ok(fifth.ok && fifth.channel.id === 'ch-2' && fifth.retryOfSameChannel === true, 'the second channel is retried up to its own attempt limit');
  attemptOnce(registry, 'ch-2', true);
  const sixth = selectNextChannel(route, routing, registry, attempts);
  assert.ok(sixth.ok && sixth.channel.id === 'ch-2');
  const exhausted = selectNextChannel(route, routing, registry, attempts);
  assert.ok(!exhausted.ok && exhausted.code === 'all_attempted');
  assert.equal(peekNextChannel(route, routing, registry, createChannelAttempts(3))?.id, 'ch-1', 'a fresh request starts at the highest priority channel again');
  console.log('Attempt order checks passed.');

  console.log('=== 4. Window thresholds ===');
  now = 2_000_000;
  const windowRegistry = registryWithClock(() => now);
  for (let index = 0; index < 14; index += 1) attemptOnce(windowRegistry, 'ch-1', false);
  assert.equal(channelSnapshot(windowRegistry, 'ch-1').remainingMs, 0, '14 failures must not open the circuit');
  for (let index = 0; index < 15; index += 1) attemptOnce(windowRegistry, 'ch-1', true);
  let ch1snapshot = channelSnapshot(windowRegistry, 'ch-1');
  assert.equal(ch1snapshot.windowFailures, 14);
  assert.equal(ch1snapshot.windowSuccesses, 15);
  assert.equal(ch1snapshot.remainingMs, 0, 'failures=14 with a >50% ratio must stay closed');

  now = 2_100_000;
  const ratioRegistry = registryWithClock(() => now);
  for (let index = 0; index < 15; index += 1) attemptOnce(ratioRegistry, 'ch-1', true);
  for (let index = 0; index < 15; index += 1) attemptOnce(ratioRegistry, 'ch-1', false);
  let ratioSnapshot = channelSnapshot(ratioRegistry, 'ch-1');
  assert.equal(ratioSnapshot.windowFailures, 15);
  assert.equal(ratioSnapshot.windowSuccesses, 15);
  assert.equal(ratioSnapshot.remainingMs, 0, '15F+15S is exactly 50% and must not open (rate must be strictly above)');
  attemptOnce(ratioRegistry, 'ch-1', false);
  ratioSnapshot = channelSnapshot(ratioRegistry, 'ch-1');
  assert.equal(ratioSnapshot.remainingMs > 0, true, '16F+15S is above 50% and must open');

  now = 2_200_000;
  const successRegistry = registryWithClock(() => now);
  for (let index = 0; index < 8; index += 1) attemptOnce(successRegistry, 'ch-1', false);
  assert.equal(channelSnapshot(successRegistry, 'ch-1').remainingMs, 0, 'failures below the count threshold stay closed');
  for (let index = 0; index < 8; index += 1) attemptOnce(successRegistry, 'ch-1', true);
  let successSnapshot = channelSnapshot(successRegistry, 'ch-1');
  assert.equal(successSnapshot.windowFailures, 8);
  assert.equal(successSnapshot.windowSuccesses, 8);
  for (let index = 0; index < 3; index += 1) attemptOnce(successRegistry, 'ch-1', true);
  successSnapshot = channelSnapshot(successRegistry, 'ch-1');
  assert.equal(successSnapshot.windowFailures, 8, 'success must not clear the failure window');
  assert.equal(successSnapshot.windowSuccesses, 11);

  now = 2_300_000;
  const expiryRegistry = registryWithClock(() => now);
  for (let index = 0; index < 15; index += 1) attemptOnce(expiryRegistry, 'ch-1', false);
  const openedAt = channelSnapshot(expiryRegistry, 'ch-1').cooldownUntil;
  assert.ok(openedAt > 0);
  assert.equal(expiryRegistry.availability({ channelId: 'ch-1', channelFingerprint: ch1.fingerprint, canonicalModel: 'model-a' }).ok, false);
  now = openedAt + 1;
  const afterExpiry = channelSnapshot(expiryRegistry, 'ch-1');
  assert.equal(afterExpiry.remainingMs, 0, 'cooldown expires without a half-open probe');
  assert.equal(afterExpiry.windowFailures, 0, 'the window resets after expiry');
  console.log('Window threshold checks passed.');

  console.log('=== 5. Quota exhaustion and No breaker ===');
  now = 3_000_000;
  assert.equal(isQuotaExhaustedEvidence({ status: 200, payload: { error: { code: 'quota_exhausted' } }, upstreamResponseObserved: true }), true);
  assert.equal(isQuotaExhaustedEvidence({ status: 429, payload: { error: { type: 'rate_limit_error', message: 'rate limit reached' } }, upstreamResponseObserved: true }), false);
  assert.equal(classifyHealthDecision({ status: 429, payload: { error: { type: 'rate_limit_error' } }, upstreamResponseObserved: true }).reason, 'retryable_4xx');
  assert.equal(classifyHealthDecision({ status: 400, payload: { error: { type: 'invalid_request_error', message: 'max_tokens: must be >= 1' } }, upstreamResponseObserved: true }).scope, 'none');
  assert.equal(classifyHealthDecision({ status: 529, payload: { error: { type: 'overloaded_error' } }, upstreamResponseObserved: true }).scope, 'model_channel');
  assert.equal(classifyHealthDecision({ abortReason: { kind: 'client_disconnect' }, upstreamResponseObserved: false }).scope, 'none');
  assert.equal(classifyHealthDecision({ fallbackReason: 'proxy_unhandled_error', upstreamResponseObserved: false }).scope, 'none');

  const quotaRegistry = registryWithClock(() => now);
  const quotaAcquire = quotaRegistry.acquire({ channelId: 'ch-2', channelFingerprint: ch2.fingerprint, canonicalModel: 'model-a', disableCooldown: true });
  assert.ok(quotaAcquire.ok);
  if (quotaAcquire.ok) {
    quotaRegistry.complete(quotaAcquire.lease, { scope: 'channel', success: false, reason: 'quota_exhausted', channelReachabilityProven: true });
  }
  const ch2Quota = channelSnapshot(quotaRegistry, 'ch-2');
  assert.equal(ch2Quota.quotaFailureCount, 1);
  assert.equal(ch2Quota.quotaRemainingSeconds > 0, true, 'quota cooldown also applies to a disable_cooldown channel');
  assert.equal(ch2Quota.remainingMs, 0, 'quota exhaustion is not an ordinary breaker opening');
  assert.equal(quotaRegistry.availability({ channelId: 'ch-2', channelFingerprint: ch2.fingerprint, canonicalModel: 'model-a', disableCooldown: true }).ok, false);
  const quotaSelection = selectNextChannel(route, routing, quotaRegistry, createChannelAttempts(3));
  assert.ok(quotaSelection.ok && quotaSelection.channel.id === 'ch-1', 'the exhausted channel is skipped for the remaining attempts');
  console.log('Quota checks passed.');

  console.log('=== 6. Beijing 00:02 quota reset ===');
  const at = (utcIso: string) => new Date(utcIso).getTime();
  const cases: Array<{ label: string; now: number; expectedIso: string; expectedReason: string }> = [
    { label: '15:59 UTC (23:59 Beijing)', now: at('2030-03-01T15:59:00Z'), expectedIso: '2030-03-01T16:02:00.000Z', expectedReason: 'same-day 00:02' },
    { label: '16:00 UTC (00:00 Beijing)', now: at('2030-03-01T16:00:00Z'), expectedIso: '2030-03-01T16:02:00.000Z', expectedReason: '00:00 failure still expires at 00:02' },
    { label: '16:01:59 UTC (00:01:59 Beijing)', now: at('2030-03-01T16:01:59Z'), expectedIso: '2030-03-01T16:02:00.000Z', expectedReason: '00:01:59 failure still expires at 00:02' },
    { label: '16:02:00 UTC (00:02 Beijing)', now: at('2030-03-01T16:02:00Z'), expectedIso: '2030-03-02T16:02:00.000Z', expectedReason: 'a 00:02 failure uses the next day' },
    { label: '10:00 UTC', now: at('2030-03-01T10:00:00Z'), expectedIso: '2030-03-01T16:02:00.000Z', expectedReason: 'the 2h default ends before 00:02' },
  ];
  for (const testCase of cases) {
    let clock = testCase.now;
    const caseRegistry = registryWithClock(() => clock, { quotaCooldownMs: 7_200_000 });
    const acquired = caseRegistry.acquire({ channelId: 'ch-1', channelFingerprint: ch1.fingerprint, canonicalModel: 'model-a' });
    assert.ok(acquired.ok);
    if (acquired.ok) caseRegistry.complete(acquired.lease, { scope: 'channel', success: false, reason: 'quota_exhausted', channelReachabilityProven: true });
    const snapshot = channelSnapshot(caseRegistry, 'ch-1');
    const expected = Math.min(testCase.now + 7_200_000, Date.parse(testCase.expectedIso));
    assert.equal(snapshot.quotaCooldownUntil, expected, `${testCase.label} -> ${testCase.expectedReason}`);
  }
  console.log('Beijing quota reset checks passed.');

  console.log('=== 7. Manual control, epochs and topology changes ===');
  now = 4_000_000;
  const manualRegistry = registryWithClock(() => now);
  attemptOnce(manualRegistry, 'ch-1', false);
  assert.equal(manualRegistry.control('ch-1', 'open'), true);
  assert.equal(channelSnapshot(manualRegistry, 'ch-1').manualRemainingSeconds > 0, true);
  assert.equal(manualRegistry.availability({ channelId: 'ch-1', channelFingerprint: ch1.fingerprint, canonicalModel: 'model-a', disableCooldown: true }).ok, false, 'manual control also stops a No breaker channel');
  manualRegistry.control('ch-1', 'close');
  const closed = channelSnapshot(manualRegistry, 'ch-1');
  assert.equal(closed.manualRemainingSeconds, 0);
  assert.equal(closed.windowFailures, 0, 'manual close clears the decision window');
  assert.equal(closed.totalFailures, 1, 'manual close keeps cumulative counters');

  const staleLease = manualRegistry.acquire({ channelId: 'ch-1', channelFingerprint: ch1.fingerprint, canonicalModel: 'model-a' });
  assert.ok(staleLease.ok);
  manualRegistry.control('ch-1', 'close');
  if (staleLease.ok) {
    manualRegistry.complete(staleLease.lease, { scope: 'channel', success: false, reason: 'upstream_5xx', channelReachabilityProven: true });
  }
  assert.equal(channelSnapshot(manualRegistry, 'ch-1').windowFailures, 0, 'a late result from before the manual reset must not reopen the window');

  const rotatedDocument = {
    ...routingDoc,
    channels: [{ id: 'ch-1', name: 'Channel 1', base_url: 'https://ch1.example', api_key: 'rotated-key' }, routingDoc.channels[1]],
  };
  const rotated = parseRoutingConfig(rotatedDocument, '<policy-check>');
  const rotatedCh1 = rotated.channelsById.get('ch-1')!;
  assert.notEqual(rotatedCh1.fingerprint, ch1.fingerprint);
  manualRegistry.reconcile(buildHealthTopology(rotated));
  assert.equal(
    manualRegistry.availability({ channelId: 'ch-1', channelFingerprint: ch1.fingerprint, canonicalModel: 'model-a' }).ok,
    false,
    'an old snapshot lease must not resolve against a rotated channel',
  );
  const rotatedLease = manualRegistry.acquire({ channelId: 'ch-1', channelFingerprint: rotatedCh1.fingerprint, canonicalModel: 'model-a' });
  assert.ok(rotatedLease.ok, 'the rotated channel starts with a clean window');
  console.log('Manual control and topology checks passed.');

  console.log('Anthropic routing policy check passed.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
