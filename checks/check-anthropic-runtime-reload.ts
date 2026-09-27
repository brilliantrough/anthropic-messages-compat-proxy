import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHealthRegistry } from '../src/channel-health.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';

const allTempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-runtime-'));
  allTempDirs.push(dir);
  return dir;
}

function routingDocument(overrides: Record<string, unknown> = {}) {
  return {
    default_model: 'claude-opus-4-8',
    channels: [
      { id: 'primary', name: 'Primary', base_url: 'https://api.anthropic.test', api_key: 'test-key-123' },
      { id: 'fallback-a', name: 'Fallback A', base_url: 'https://fallback.test', api_key: 'fb-key' },
    ],
    models: { 'claude-opus-4-8': { channel_ids: ['primary', 'fallback-a'] } },
    aliases: { 'claude-latest': 'claude-opus-4-8' },
    ...overrides,
  };
}

function writeEnv(envPath: string, lines: string[]) {
  writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function main() {
  try {
    console.log('=== 1. Initial snapshot uses the routing config ===');
    const dir = makeTempDir();
    const envPath = path.join(dir, '.env');
    const routingPath = path.join(dir, 'fallback.json');
    writeFileSync(routingPath, JSON.stringify(routingDocument(), null, 2), 'utf8');
    writeEnv(envPath, [
      'HOST=127.0.0.1',
      'PORT=12241',
      'INSTANCE_NAME=runtime-reload-check',
      `FALLBACK_CONFIG_PATH=${routingPath}`,
    ]);

    const store = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
    const healthRegistry = createHealthRegistry({});
    store.registerHealthRegistry(healthRegistry);

    const snap1 = store.getSnapshot();
    assert.equal(snap1.config.anthropicVersion, '2023-06-01');
    assert.equal(snap1.config.anthropicBeta, undefined);
    assert.equal(snap1.config.claudeBillingHeaderMode, 'strip_line');
    assert.equal(snap1.config.routingConfig.channelsById.size, 2);
    assert.equal(snap1.config.routingConfig.channelsById.get('primary')?.messagesUrl, 'https://api.anthropic.test/v1/messages');
    assert.equal(snap1.config.routingConfig.aliases['claude-latest'], 'claude-opus-4-8');
    assert.equal(snap1.config.routingConfigPath, routingPath);
    assert.equal(healthRegistry.snapshot().channels.length, 2, 'every configured channel gets a health record at startup');
    assert.equal(healthRegistry.snapshot().channels.length, 2, 'aliases do not create extra health records');

    console.log('=== 2. Reload applies env and routing changes ===');
    writeEnv(envPath, [
      'HOST=127.0.0.1',
      'PORT=12241',
      'INSTANCE_NAME=runtime-reload-check',
      'ANTHROPIC_VERSION=2024-01-01',
      'ANTHROPIC_BETA=new-beta-feature',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_cch',
      'PROXY_HEALTH_FAILURE_THRESHOLD=7',
      'PROXY_CHANNEL_MAX_ATTEMPTS=2',
      `FALLBACK_CONFIG_PATH=${routingPath}`,
    ]);
    writeFileSync(routingPath, JSON.stringify(routingDocument({
      channels: [
        { id: 'primary', name: 'Primary renamed', base_url: 'https://api.anthropic.test', api_key: 'test-key-123' },
        { id: 'fallback-a', name: 'Fallback A', base_url: 'https://fallback.test', api_key: 'rotated-key' },
        { id: 'fallback-b', name: 'Fallback B', base_url: 'https://fallback-b.test', api_key: 'fb-b-key' },
      ],
      models: {
        'claude-opus-4-8': { channel_ids: ['primary', 'fallback-b'] },
        'claude-sonnet-4-6': { channel_ids: ['fallback-a'] },
      },
    }), null, 2), 'utf8');

    const generationBeforeReload = healthRegistry.snapshot().topologyGeneration;
    const result2 = store.reloadFromFiles();
    assert.equal(result2.ok, true);
    const snap2 = store.getSnapshot();
    assert.equal(snap2.runtimeVersion, 2, 'runtimeVersion increments on reload');
    assert.equal(snap2.config.anthropicVersion, '2024-01-01');
    assert.equal(snap2.config.anthropicBeta, 'new-beta-feature');
    assert.equal(snap2.config.claudeBillingHeaderMode, 'strip_cch');
    assert.equal(snap2.config.healthFailureThreshold, 7, 'policy changes apply without a restart');
    assert.equal(snap2.config.channelMaxAttempts, 2);
    assert.equal(snap2.config.routingConfig.channelsById.size, 3);
    assert.equal(snap2.config.routingConfig.channelsById.get('primary')?.name, 'Primary renamed');
    assert.equal(snap2.config.routingConfig.modelRoutes.get('claude-opus-4-8')?.channelIds.join(','), 'primary,fallback-b');
    assert.equal(snap2.config.routingConfig.modelRoutes.get('claude-sonnet-4-6')?.channelIds.join(','), 'fallback-a');

    const healthAfterReload = healthRegistry.snapshot();
    assert.ok(healthAfterReload.topologyGeneration > generationBeforeReload, 'reload bumps the topology generation');
    assert.equal(healthAfterReload.channels.length, 3, 'the new channel gets a health record');
    const renamedPrimary = healthAfterReload.channels.find(record => record.channelId === 'primary')!;
    assert.equal(renamedPrimary.fingerprint, snap1.config.routingConfig.channelsById.get('primary')!.fingerprint, 'a rename keeps the same fingerprint');
    const rotatedFallback = healthAfterReload.channels.find(record => record.channelId === 'fallback-a')!;
    assert.notEqual(rotatedFallback.fingerprint, snap1.config.routingConfig.channelsById.get('fallback-a')!.fingerprint, 'a key rotation changes the fingerprint');

    console.log('=== 3. An invalid routing document keeps the running snapshot ===');
    writeFileSync(routingPath, JSON.stringify({ default_model: 'x', channels: [], models: {}, aliases: {} }, null, 2), 'utf8');
    const failed = store.reloadFromFiles();
    assert.equal(failed.ok, false);
    assert.match(failed.ok === false ? failed.error : '', /channels/u);
    const snap3 = store.getSnapshot();
    assert.equal(snap3.runtimeVersion, 2, 'a rejected document must not bump the runtime version');
    assert.equal(snap3.config.routingConfig.channelsById.get('primary')?.name, 'Primary renamed');
    assert.equal(healthRegistry.snapshot().channels.length, 3, 'a rejected document must not touch the health topology');
    assert.equal(readFileSync(routingPath, 'utf8').includes('"channels": []'), true, 'reload never rewrites the routing file');

    writeFileSync(routingPath, JSON.stringify(routingDocument(), null, 2), 'utf8');

    console.log('=== 4. PORT/HOST changes report restartRequiredFields ===');
    writeEnv(envPath, [
      'HOST=0.0.0.0',
      'PORT=9999',
      'INSTANCE_NAME=runtime-reload-check',
      `FALLBACK_CONFIG_PATH=${routingPath}`,
    ]);
    const result4 = store.reloadFromFiles();
    assert.equal(result4.ok, true);
    const snap4 = store.getSnapshot();
    assert.ok(snap4.restartRequiredFields.includes('PORT'));
    assert.ok(snap4.restartRequiredFields.includes('HOST'));
    assert.equal(snap4.config.port, 9999);

    console.log('=== 5. Routing-only edits do not require a restart ===');
    writeEnv(envPath, [
      'HOST=0.0.0.0',
      'PORT=9999',
      'INSTANCE_NAME=runtime-reload-check',
      'ANTHROPIC_VERSION=2025-01-01',
      `FALLBACK_CONFIG_PATH=${routingPath}`,
    ]);
    const result5 = store.reloadFromFiles();
    assert.equal(result5.ok, true);
    const snap5 = store.getSnapshot();
    assert.deepEqual(snap5.restartRequiredFields, [], 'routing/model/alias edits apply live');
    assert.equal(snap5.config.anthropicVersion, '2025-01-01');

    console.log('All anthropic-runtime-reload checks passed.');
  } finally {
    for (const dir of allTempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

main();
