import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { createUsageStore, parseUsageQuery } from '../src/usage-store.js';
import { beginUsageAttempt, createUsageContext } from '../src/usage-tracking.js';
import { collectUptime, UPTIME_INTERVAL_MS } from '../src/uptime.js';
import { createHealthRegistry } from '../src/channel-health.js';
import { buildHealthTopology, createRuntimeConfigStore } from '../src/runtime-config.js';
import { parseRoutingConfig } from '../src/routing-config.js';

const dir = await mkdtemp(join(tmpdir(), 'anthropic-parity-usage-'));
const boundary = Date.parse('2026-09-11T16:00:00Z'); // 北京时间午夜
const dayQuery = { from: boundary - 86400000, to: boundary + 86400000, bucket: 'day' as const, offset: 480, channels: [], models: [], kind: 'all' };
let store = createUsageStore(join(dir, 'history.sqlite'));
let proxy: ChildProcess | undefined;
let output = '';
let lastUpstreamModel = '';

const routingDoc = {
  default_model: 'claude-sonnet-4-5',
  channels: [
    { id: 'alpha', name: 'Alpha', base_url: 'https://alpha.example', api_key: 'alpha-key' },
    { id: 'beta', name: 'Beta', base_url: 'https://beta.example', api_key: 'beta-key', disable_cooldown: true },
  ],
  models: { 'claude-sonnet-4-5': { channel_ids: ['alpha', 'beta'] }, 'claude-haiku-4-5': { channel_ids: ['beta'] } },
  aliases: { 'claude-latest': 'claude-sonnet-4-5' },
};

const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  try { lastUpstreamModel = JSON.parse(Buffer.concat(chunks).toString() || '{}').model ?? ''; } catch { lastUpstreamModel = '<unparsable>'; }
  const payload = {
    id: 'msg_check', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 },
  };
  if (req.url?.includes('stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...payload, content: [] } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } })}\n\n`);
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function stopProxy() {
  if (proxy && proxy.exitCode === null) { const exited = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exited; }
}

try {
  console.log('=== 1. Anthropic token semantics: one row, components never double-counted ===');
  const context = createUsageContext();
  await context.run({ requestId: 'accounting', write: row => store.write({ ...row, startedAt: boundary }) }, () => {
    const attempt = beginUsageAttempt(context, { id: 'alpha', name: 'Alpha' }, 'claude-sonnet-4-5', 'messages', new AbortController().signal);
    attempt.observe({ inputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 1000, outputTokens: 20 });
    // message_delta carries cumulative usage: the same attempt is updated, never appended.
    attempt.observe({ outputTokens: 20 });
    assert.equal(attempt.row.inputTokens, 1110, 'inclusive input = plain + cache creation + cache read');
    assert.equal(attempt.row.totalTokens, 1130);
    attempt.result('success');
    attempt.finish();
    attempt.finish();
  });
  let result = await store.query(dayQuery) as any;
  assert.equal(result.requests, 1);
  assert.equal(result.rows.length, 1, 'one upstream attempt is one row regardless of repeated cumulative usage');
  assert.equal(result.rows[0].uncachedInputTokens, 10);
  assert.equal(result.rows[0].cacheCreationInputTokens, 100);
  assert.equal(result.rows[0].cacheReadInputTokens, 1000);
  assert.equal(result.rows[0].inputTokens, 1110);
  assert.equal(result.rows[0].totalTokens, 1130);
  assert.equal(result.rows[0].cacheEligibleInput, 1110, 'cache hit rate is weighted over the inclusive input');
  assert.equal(result.rows[0].cacheEligibleCached, 1000);
  assert.equal(result.rows[0].kind, 'messages');

  console.log('=== 2. Missing components stay NULL instead of becoming zero ===');
  let partialRow: { inputTokens: number | null; cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null; totalTokens: number | null; uncachedInputTokens: number | null } | undefined;
  await context.run({ requestId: 'partial', write: row => store.write({ ...row, startedAt: boundary }) }, () => {
    const attempt = beginUsageAttempt(context, { id: 'beta', name: 'Beta' }, 'claude-haiku-4-5', 'messages', new AbortController().signal);
    attempt.observe({ inputTokens: 7, outputTokens: 3 });
    attempt.result('success');
    attempt.finish();
    partialRow = attempt.row;
  });
  assert.equal(partialRow!.uncachedInputTokens, 7);
  assert.equal(partialRow!.cacheCreationInputTokens, null, 'an unreported component is stored as NULL, never as zero');
  assert.equal(partialRow!.cacheReadInputTokens, null);
  assert.equal(partialRow!.inputTokens, null, 'inclusive input needs all three components');
  assert.equal(partialRow!.totalTokens, null);
  result = await store.query({ ...dayQuery, models: ['claude-haiku-4-5'] }) as any;
  assert.equal(result.rows[0].uncachedKnown, 1);
  assert.equal(result.rows[0].inputKnown, 0, 'aggregates expose coverage counters next to the sums');
  assert.equal(result.rows[0].cacheCreationKnown, 0);
  assert.equal(result.rows[0].cacheReadKnown, 0);
  assert.equal(result.rows[0].totalKnown, 0);
  assert.equal(result.rows[0].usageKnown, 0, 'usage coverage only counts rows with a complete inclusive input and output');
  assert.equal(result.rows[0].cacheKnown, 0, 'cached coverage stays separate from usage coverage');
  assert.throws(() => parseUsageQuery(new URLSearchParams('from=1&to=9999999999999&bucket=hour')), /Invalid filters/);
  assert.throws(() => parseUsageQuery(new URLSearchParams(`from=${boundary}&to=${boundary + 1}&bucket=hour&kind=compact`)), /Invalid filters/);

  console.log('=== 3. Pending attempts become interrupted after a restart, history survives ===');
  await context.run({ requestId: 'abandoned', write: row => store.write({ ...row, startedAt: boundary }) }, () => {
    beginUsageAttempt(context, { id: 'alpha', name: 'Alpha' }, 'claude-sonnet-4-5', 'messages', new AbortController().signal);
  });
  await store.close();
  store = createUsageStore(join(dir, 'history.sqlite'));
  result = await store.query(dayQuery) as any;
  const total = (key: string) => result.rows.reduce((sum: number, row: any) => sum + row[key], 0);
  assert.equal(total('interrupted'), 1, 'a pending row is reconciled on the next start');
  assert.equal(total('inputTokens'), 1110, 'history survives the store restart');
  await store.close();

  console.log('=== 4. Uptime colours, buckets and fingerprint scope ===');
  const routing = parseRoutingConfig(routingDoc, '<usage-check>');
  let clock = boundary;
  const health = createHealthRegistry({
    healthWindowMs: 180_000, healthFailureThreshold: 15, healthFailureRateThreshold: 0.5,
    healthCooldownMs: 600_000, quotaCooldownMs: 7_200_000, now: () => clock,
  });
  health.reconcile(buildHealthTopology(routing));
  const runtime = { getSnapshot: () => ({ config: { routingConfig: routing, healthWindowMs: 180_000, healthFailureThreshold: 15, healthFailureRateThreshold: 0.5 } }) };
  const fail = (channelId: string, canonicalModel: string) => {
    const channel = routing.channelsById.get(channelId)!;
    const acquired = health.acquire({ channelId, channelFingerprint: channel.fingerprint, canonicalModel, disableCooldown: channel.disableCooldown });
    if (acquired.ok) health.complete(acquired.lease, { scope: 'model_channel', success: false, reason: 'timeout', channelReachabilityProven: true });
    return acquired.ok;
  };
  const driveTo = (channelId: string, canonicalModel: string, target: number) => {
    for (let i = 0; i < 60 && modelWindow(canonicalModel, channelId) < target; i += 1) {
      if (!fail(channelId, canonicalModel)) break;
    }
  };
  const sampleOf = (samples: ReturnType<typeof collectUptime>, model: string, channelId: string) => samples.find(row => row.model === model && row.channelId === channelId)!;
  const channelWindow = (channelId: string) => health.snapshot().channels.find(channel => channel.channelId === channelId)!.windowFailures;
  const modelWindow = (model: string, channelId: string) => health.snapshot().modelChannels.find(record => record.canonicalModel === model && record.channelId === channelId)?.modelWindowFailures ?? 0;

  let samples = collectUptime(runtime, health, clock);
  assert.equal(samples.length, 3, 'one sample per configured ordinary model route: aliases are not sampled');
  assert.ok(samples.every(row => row.bucket === boundary), '3-minute UTC boundary buckets');
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'alpha').state, 'green');
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'alpha').reason, 'available');

  assert.equal(fail('alpha', 'claude-sonnet-4-5'), true);
  samples = collectUptime(runtime, health, clock);
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'alpha').state, 'yellow', 'one threshold met is a model-scoped warning');
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'alpha').reason, 'failure_rate');
  assert.equal(channelWindow('alpha'), 1, 'the shared channel window counts the attempt once');
  assert.equal(modelWindow('claude-sonnet-4-5', 'alpha'), 1);
  assert.equal(health.snapshot().channels.find(channel => channel.channelId === 'alpha')!.remainingMs, 0, 'a model yellow light must not open the shared channel breaker');

  assert.equal(fail('beta', 'claude-sonnet-4-5'), true, 'a routed model may use any of its configured channels');
  assert.equal(fail('beta', 'claude-haiku-4-5'), true);
  samples = collectUptime(runtime, health, clock);
  assert.equal(channelWindow('beta'), 2, 'the channel window is shared across the models that route through it');
  assert.equal(modelWindow('claude-sonnet-4-5', 'beta'), 1);
  assert.equal(modelWindow('claude-haiku-4-5', 'beta'), 1, 'model windows stay separate');
  assert.equal(sampleOf(samples, 'claude-haiku-4-5', 'beta').state, 'yellow');

  driveTo('alpha', 'claude-sonnet-4-5', 15);
  samples = collectUptime(runtime, health, clock);
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'alpha').state, 'red', 'both thresholds met open the ordinary breaker');
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'alpha').reason, 'breaker');
  assert.ok(health.snapshot().channels.find(channel => channel.channelId === 'alpha')!.remainingMs > 0);
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'beta').state, 'yellow', 'another channel keeps its own window');

  driveTo('beta', 'claude-sonnet-4-5', 15);
  samples = collectUptime(runtime, health, clock);
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'beta').state, 'green', 'No breaker stays available even with both thresholds met');
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'beta').reason, 'no_breaker');
  assert.ok(channelWindow('beta') > 15, 'the exempt channel window can pass the threshold without any effect');
  assert.equal(sampleOf(samples, 'claude-haiku-4-5', 'beta').state, 'yellow', 'the sibling model keeps its own model window');
  assert.equal(health.snapshot().channels.find(channel => channel.channelId === 'beta')!.remainingMs, 0);

  clock += UPTIME_INTERVAL_MS;
  assert.ok(collectUptime(runtime, health, clock).every(row => row.bucket === boundary + UPTIME_INTERVAL_MS), 'the next bucket starts 180s later');

  health.control('beta', 'open');
  samples = collectUptime(runtime, health, clock);
  assert.ok(samples.filter(row => row.channelId === 'beta').every(row => row.state === 'red'), 'manual control turns the channel red even with No breaker');
  assert.equal(sampleOf(samples, 'claude-sonnet-4-5', 'beta').reason, 'manual');
  health.control('beta', 'close');
  health.control('alpha', 'close');

  clock += UPTIME_INTERVAL_MS;
  const uptimeStore = createUsageStore(join(dir, 'uptime.sqlite'));
  const uptimeQuery = { model: 'claude-sonnet-4-5', from: boundary, to: boundary + UPTIME_INTERVAL_MS * 4 };
  uptimeStore.writeUptime(collectUptime(runtime, health, clock));
  await delay(200);
  uptimeStore.writeUptime(collectUptime(runtime, health, clock));
  await delay(200);
  const stored = await uptimeStore.queryUptime(uptimeQuery) as any;
  assert.equal(stored.rows.length, 2, 're-sampling the same bucket upserts instead of duplicating');
  assert.ok(stored.rows.every((row: any) => typeof row.fingerprint === 'string' && row.fingerprint.length > 0), 'history keeps the channel fingerprint');

  const rotated = parseRoutingConfig({ ...routingDoc, channels: routingDoc.channels.map(channel => channel.id === 'alpha' ? { ...channel, api_key: 'alpha-key-rotated' } : channel) }, '<usage-check>');
  assert.notEqual(rotated.channelsById.get('alpha')!.fingerprint, routing.channelsById.get('alpha')!.fingerprint, 'a rotated credential changes the fingerprint');
  await uptimeStore.close();

  console.log('=== 5. Sampling never calls upstream, and a broken database stays visible ===');
  const upstreamPort = await listen(upstream);
  const hits: string[] = [];
  upstream.on('request', req => hits.push(req.url ?? ''));
  collectUptime(runtime, health, Date.now());
  await delay(100);
  assert.equal(hits.length, 0, 'uptime sampling is a local snapshot, never an upstream probe');

  const instanceDir = join(dir, 'instance');
  await mkdir(instanceDir, { recursive: true });
  await writeFile(join(instanceDir, 'fallback.json'), JSON.stringify({ ...routingDoc, channels: routingDoc.channels.map(channel => ({ ...channel, base_url: `http://127.0.0.1:${upstreamPort}` })) }), { mode: 0o600 });
  await mkdir(join(instanceDir, 'usage.sqlite'), { recursive: true }); // SQLite cannot open a directory: the worker fails.
  await writeFile(join(instanceDir, '.env'), `PORT=0\nHOST=127.0.0.1\nINSTANCE_NAME=usage-check\nFALLBACK_CONFIG_PATH=${join(instanceDir, 'fallback.json')}\n`, { mode: 0o600 });

  const reserve = createServer();
  const port = await listen(reserve);
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const reserveEnv = join(instanceDir, 'reserved.env');
  await writeFile(reserveEnv, `PORT=${port}\nHOST=127.0.0.1\nFALLBACK_CONFIG_PATH=${join(instanceDir, 'fallback.json')}\n`, { mode: 0o600 });
  proxy = spawn(process.execPath, ['--import', 'tsx', 'src/anthropic-proxy.ts'], {
    env: { ...process.env, PROXY_ENV_PATH: reserveEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout?.on('data', chunk => { output += chunk; });
  proxy.stderr?.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { await delay(100); }
  }
  assert.ok(up, `proxy should start even when the usage database cannot be opened\n${output}`);
  const message = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'client-key' },
    body: JSON.stringify({ model: 'claude-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(message.status, 200, 'requests keep flowing while usage history is unavailable');
  assert.equal(((await message.json()) as any).model, 'claude-latest', 'the client-requested alias is echoed back');
  assert.equal(lastUpstreamModel, 'claude-sonnet-4-5', 'the alias resolves to the canonical model upstream');
  await delay(300);
  const statsRes = await fetch(`${base}/admin/usage/stats?from=${Date.now() - 86400000}&to=${Date.now()}&bucket=hour&offset=480`);
  assert.equal(statsRes.status, 503, 'usage history reports the broken database instead of pretending to be empty');
  const stats = await statsRes.json() as any;
  assert.equal(stats.ok, false);
  assert.ok(String(stats.error?.message ?? '').length > 0, 'the database failure message is surfaced to the admin UI');
  const monitor = await (await fetch(`${base}/admin/monitor/stats`)).json() as any;
  assert.equal(monitor.usageAvailable, true);
  assert.ok(monitor.usageWriteError, 'the monitor shows the same write error');
  const uptimeStatus = await fetch(`${base}/admin/uptime?model=claude-sonnet-4-5&hours=24`);
  assert.equal(uptimeStatus.status, 503, 'uptime history reports the unavailable database');
  const badModel = await fetch(`${base}/admin/uptime?model=claude-latest&hours=24`);
  assert.equal(badModel.status, 400, 'aliases are not uptime scopes');
  assert.equal((await fetch(`${base}/admin/uptime?hours=99999`)).status, 400);

  console.log('Usage and uptime checks passed: Anthropic token semantics, NULL preservation, interrupted recovery, store restart, uptime colours, fingerprint scope, no upstream sampling, broken-database visibility.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stopProxy();
  upstream.closeAllConnections();
  upstream.close();
  await rm(dir, { recursive: true, force: true });
}
