import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createAdminHandler } from '../src/admin-api.js';
import { createHealthRegistry } from '../src/channel-health.js';
import { createUsageStore } from '../src/usage-store.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-admin-monitor-'));
  allTempDirs.push(dir);
  return dir;
}

async function main() {
  let usageStore: ReturnType<typeof createUsageStore> | undefined;
  try {
    console.log('=== 1. Setup with the channels/models/aliases config ===');
    const configDir = makeTempDir();
    const envPath = path.join(configDir, '.env');
    const routingPath = path.join(configDir, 'fallback.json');

    writeFileSync(routingPath, JSON.stringify({
      default_model: 'claude-opus-4-8',
      channels: [
        { id: 'primary', name: 'Primary', base_url: 'https://api.anthropic.test', api_key: 'test-key-123' },
        { id: 'fallback-a', name: 'Fallback A', base_url: 'https://fallback.test', api_key: 'fb-key', disable_cooldown: true },
      ],
      models: { 'claude-opus-4-8': { channel_ids: ['primary', 'fallback-a'] } },
      aliases: { 'claude-latest': 'claude-opus-4-8' },
    }, null, 2), 'utf8');
    writeFileSync(envPath, [
      'ANTHROPIC_VERSION=2023-06-01',
      'ANTHROPIC_BETA=max-tokens-3-5-sonnet-2024-07-15',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line',
      'PORT=12241',
      'INSTANCE_NAME=admin-monitor-check',
      `FALLBACK_CONFIG_PATH=${routingPath}`,
    ].join('\n'), 'utf8');

    const runtimeStore = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
    const snap = runtimeStore.getSnapshot();
    const healthRegistry = createHealthRegistry({
      healthWindowMs: snap.config.healthWindowMs,
      healthFailureThreshold: snap.config.healthFailureThreshold,
      healthFailureRateThreshold: snap.config.healthFailureRateThreshold,
      healthCooldownMs: snap.config.healthCooldownMs,
      quotaCooldownMs: snap.config.quotaCooldownMs,
    });
    runtimeStore.registerHealthRegistry(healthRegistry);

    const configStore = createConfigFileStoreFromPaths({
      envPath,
      fallbackPath: snap.config.routingConfigPath,
    });
    usageStore = createUsageStore(path.join(configDir, 'usage.sqlite'));
    const usageDbPath = path.join(configDir, 'usage.sqlite');

    const adminHandler = createAdminHandler({
      configStore,
      runtimeStore,
      healthRegistry,
      usageStore,
      getAdminStats: () => {
        const current = runtimeStore.getSnapshot();
        return {
          instanceName: current.config.instanceName,
          anthropicVersion: current.config.anthropicVersion,
          anthropicBeta: current.config.anthropicBeta ?? null,
          claudeBillingHeaderMode: current.config.claudeBillingHeaderMode,
          channelMaxAttempts: current.config.channelMaxAttempts,
          channelRetryDelayMs: current.config.channelRetryDelayMs,
          quotaCooldownMs: current.config.quotaCooldownMs,
          maxFallbackTotalMs: current.config.maxFallbackTotalMs,
        };
      },
    });

    let upstreamBroken = false;
    const upstream = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        if (upstreamBroken) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream exploded' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          id: 'msg_admin_monitor',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'hello from upstream' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
    allServers.push(upstream);

    // Point the primary channel at the mock upstream by rewriting the routing document once.
    writeFileSync(routingPath, JSON.stringify({
      default_model: 'claude-opus-4-8',
      channels: [
        { id: 'primary', name: 'Primary', base_url: `http://127.0.0.1:${upstreamAddress.port}`, api_key: 'test-key-123' },
        { id: 'fallback-a', name: 'Fallback A', base_url: 'http://127.0.0.1:1', api_key: 'fb-key', disable_cooldown: true },
      ],
      models: { 'claude-opus-4-8': { channel_ids: ['primary', 'fallback-a'] } },
      aliases: { 'claude-latest': 'claude-opus-4-8' },
    }, null, 2), 'utf8');
    assert.equal(runtimeStore.reloadFromFiles().ok, true, 'the point-at-the-mock routing document must reload cleanly');

    const proxy = createAnthropicProxyServer({
      port: snap.config.port,
      host: '127.0.0.1',
      instanceName: snap.config.instanceName,
      anthropicVersion: snap.config.anthropicVersion,
      anthropicBeta: snap.config.anthropicBeta,
      claudeBillingHeaderMode: snap.config.claudeBillingHeaderMode,
      routingConfig: runtimeStore.getSnapshot().config.routingConfig,
      healthRegistry,
      usageStore,
      adminHandler,
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    allServers.push(proxy);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== 'string');
    const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}`;

    console.log('=== 2. /healthz exposes the routing and policy surface ===');
    const healthRes = await fetch(`${proxyBaseUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health.anthropicVersion, '2023-06-01');
    assert.equal(health.anthropicBeta, 'max-tokens-3-5-sonnet-2024-07-15');
    assert.equal(health.claudeBillingHeaderMode, 'strip_line');
    assert.equal(health.channels, 2);
    assert.equal(health.models, 1);
    assert.equal(health.defaultModel, 'claude-opus-4-8');
    assert.equal(health.channelMaxAttempts, 3);
    assert.equal(health.channelRetryDelayMs, 500);
    assert.equal(health.quotaCooldownMs, 7200000);
    assert.equal(health.usageAvailable, true);

    console.log('=== 3. One successful request produces one usage row with Anthropic token semantics ===');
    const messageRes = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-latest', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(messageRes.status, 200);
    await new Promise(resolve => setTimeout(resolve, 600)); // the usage writer batches asynchronously

    // A failing request must add one row per upstream attempt, without touching the successful row.
    upstreamBroken = true;
    const failingRes = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-latest', max_tokens: 64, messages: [{ role: 'user', content: 'hi again' }] }),
    });
    assert.equal(failingRes.status, 502, 'every configured channel failing keeps the fallback_exhausted contract');
    const failingBody = await failingRes.json() as { error?: { message?: string } };
    assert.match(failingBody.error?.message ?? '', /fallback_exhausted/);
    upstreamBroken = false;
    await new Promise(resolve => setTimeout(resolve, 600));

    const usageRes = await fetch(`${proxyBaseUrl}/admin/usage/stats?hours=24`);
    assert.equal(usageRes.status, 200);
    const usageBody = (await usageRes.json()) as {
      ok?: boolean;
      totals?: Record<string, number>;
      rows?: Array<Record<string, unknown>>;
      configuredModels?: string[];
      configuredChannels?: Array<{ id?: string; name?: string }>;
      database?: string;
    };
    assert.equal(usageBody.ok, true);
    assert.equal(usageBody.totals?.attempts, 7, 'one success plus three attempts on each of two channels');
    assert.equal(usageBody.totals?.success, 1);
    assert.equal(usageBody.totals?.failed, 6);
    assert.equal(usageBody.totals?.uncachedInputTokens, 10, 'input_tokens is the plain (uncached) input');
    assert.equal(usageBody.totals?.cacheCreationInputTokens, 100);
    assert.equal(usageBody.totals?.cacheReadInputTokens, 1000);
    assert.equal(usageBody.totals?.inputTokens, 1110, 'inputTokens is the inclusive input (plain + cache creation + cache read)');
    assert.equal(usageBody.totals?.outputTokens, 20);
    assert.equal(usageBody.totals?.totalTokens, 1130);
    assert.equal(usageBody.database, usageDbPath);
    assert.deepEqual(usageBody.configuredModels, ['claude-opus-4-8']);
    assert.deepEqual(usageBody.configuredChannels?.map(channel => channel.id), ['primary', 'fallback-a']);
    const successfulRow = usageBody.rows?.find(row => row['channelId'] === 'primary' && (row['success'] as number) > 0);
    assert.ok(successfulRow, 'the successful attempt is grouped by channel and model');
    assert.equal(successfulRow?.['model'], 'claude-opus-4-8', 'usage records the canonical model');
    assert.equal(successfulRow?.['kind'], 'messages');
    assert.equal(successfulRow?.['success'], 1);
    const failedPrimaryRow = usageBody.rows?.find(row => row['channelId'] === 'primary' && (row['failed'] as number) > 0);
    assert.equal(failedPrimaryRow?.['failed'], 3, 'each failed attempt on a channel is counted separately');

    console.log('=== 4. /admin/stats exposes health, channels, models and usage availability ===');
    const statsRes = await fetch(`${proxyBaseUrl}/admin/stats`);
    assert.equal(statsRes.status, 200);
    const stats = (await statsRes.json()) as Record<string, unknown>;
    assert.equal(stats.ok, true);
    assert.equal(stats.anthropicVersion, '2023-06-01');
    assert.equal(stats.usageAvailable, true);
    const snapshot = stats.healthSnapshot as { channels: Array<{ channelId: string; windowSuccesses: number; disableCooldown: boolean }>; topologyGeneration: number };
    assert.equal(snapshot.channels.length, 2);
    const primaryRecord = snapshot.channels.find(record => record.channelId === 'primary');
    assert.equal(primaryRecord?.windowSuccesses, 1);
    assert.equal(snapshot.channels.find(record => record.channelId === 'fallback-a')?.disableCooldown, true);
    assert.ok(Array.isArray(stats.channels));
    assert.ok(Array.isArray(stats.modelRoutes));
    assert.equal((stats.modelRoutes as Array<{ canonicalModel: string }>)[0]?.canonicalModel, 'claude-opus-4-8');

    console.log('=== 5. /admin/monitor/stats keeps the legacy alias working ===');
    const monitorRes = await fetch(`${proxyBaseUrl}/admin/monitor/stats`);
    assert.equal(monitorRes.status, 200);
    const monitor = (await monitorRes.json()) as Record<string, unknown>;
    assert.equal(monitor.ok, true);
    assert.equal(monitor.anthropicVersion, '2023-06-01');
    assert.ok(monitor.healthSnapshot);

    console.log('=== 6. Manual breaker control from the monitor contract ===');
    const openRes = await fetch(`${proxyBaseUrl}/admin/channels/breaker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'primary', fingerprint: primaryRecord ? (primaryRecord as unknown as { fingerprint: string }).fingerprint : '', action: 'open' }),
    });
    assert.equal(openRes.status, 200);
    const afterOpen = (await (await fetch(`${proxyBaseUrl}/admin/stats`)).json()) as { healthSnapshot: { channels: Array<{ channelId: string; manualRemainingSeconds: number }> } };
    assert.ok((afterOpen.healthSnapshot.channels.find(record => record.channelId === 'primary')?.manualRemainingSeconds ?? 0) > 0);
    const closeRes = await fetch(`${proxyBaseUrl}/admin/channels/breaker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'primary', fingerprint: (primaryRecord as unknown as { fingerprint: string }).fingerprint, action: 'close' }),
    });
    assert.equal(closeRes.status, 200);

    console.log('=== 7. Uptime samples are stored beside the usage database ===');
    assert.equal(existsSync(usageDbPath), true);
    const uptimeRes = await fetch(`${proxyBaseUrl}/admin/uptime?model=claude-opus-4-8&hours=6`);
    assert.equal(uptimeRes.status, 200);
    const uptime = (await uptimeRes.json()) as { ok?: boolean; rows?: unknown[]; current?: unknown[]; model?: string; hours?: number; channels?: Array<{ id?: string }>; intervalMs?: number };
    assert.equal(uptime.ok, true);
    assert.equal(uptime.model, 'claude-opus-4-8');
    assert.equal(uptime.hours, 6);
    assert.equal(uptime.intervalMs, 180000, 'uptime samples on 180s UTC boundaries');
    assert.deepEqual(uptime.channels?.map(channel => channel.id), ['primary', 'fallback-a']);
    assert.ok(Array.isArray(uptime.rows));
    assert.equal(uptime.current?.length, 2, 'the current window state is reported for both routed channels');

    console.log('\nAll anthropic-admin-monitor checks passed.');
  } finally {
    for (const server of allServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (usageStore) {
      try { await usageStore.close(); } catch { /* the database may already be closed by a failed check */ }
    }
    for (const dir of allTempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
