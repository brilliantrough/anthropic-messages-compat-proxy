import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createAdminHandler } from '../src/admin-api.js';
import { createHealthRegistry } from '../src/channel-health.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-admin-config-'));
  allTempDirs.push(dir);
  return dir;
}

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>) {
  return new Promise<{ server: import('node:http').Server; port: number }>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled && !res.headersSent && !res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    allServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve({ server, port: address.port });
      else reject(new Error('Failed to get server address'));
    });
  });
}

const routingDocument = {
  default_model: 'claude-opus-4-8',
  channels: [
    { id: 'primary', name: 'Primary', base_url: 'https://api.anthropic.test', api_key: 'test-key-123' },
    { id: 'fallback-a', name: 'Fallback A', base_url: 'https://fallback.test', api_key: 'fb-key' },
  ],
  models: { 'claude-opus-4-8': { channel_ids: ['primary', 'fallback-a'] } },
  aliases: { 'claude-latest': 'claude-opus-4-8' },
};

async function main() {
  try {
    console.log('=== 1. Setup with the channels/models/aliases config ===');
    const configDir = makeTempDir();
    const envPath = path.join(configDir, '.env');
    const routingPath = path.join(configDir, 'fallback.json');
    writeFileSync(routingPath, JSON.stringify(routingDocument, null, 2), 'utf8');
    writeFileSync(envPath, [
      'ANTHROPIC_VERSION=2023-06-01',
      'ANTHROPIC_BETA=max-tokens-3-5-sonnet-2024-07-15',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line',
      'HOST=127.0.0.1',
      'PORT=12241',
      `FALLBACK_CONFIG_PATH=${routingPath}`,
    ].join('\n'), 'utf8');

    const runtimeStore = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
    const healthRegistry = createHealthRegistry({});
    runtimeStore.registerHealthRegistry(healthRegistry);
    const configStore = createConfigFileStoreFromPaths({ envPath, fallbackPath: routingPath });
    const adminHandler = createAdminHandler({ configStore, runtimeStore, healthRegistry });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log('=== 2. GET /admin/config exposes env, channels, models, aliases and policy ===');
    const configRes = await fetch(`${baseUrl}/admin/config`);
    assert.equal(configRes.status, 200);
    const configBody = (await configRes.json()) as { ok?: boolean; config?: Record<string, unknown>; runtimeVersion?: number; restartRequiredFields?: string[] };
    assert.equal(configBody.ok, true);
    assert.equal(configBody.runtimeVersion, 1);
    const config = configBody.config as {
      env: Array<{ key: string; value: string; secret?: boolean }>;
      defaultModel: string;
      channels: Array<{ id: string; name?: string; baseUrl?: string; apiKeyMasked?: string; apiKeyConfigured?: boolean; disableCooldown?: boolean }>;
      models: Array<{ canonicalModel: string; channelIds: string[] }>;
      aliases: Record<string, string>;
      legacyModelMapPath: string;
    };
    assert.ok(config.env.some(entry => entry.key === 'ANTHROPIC_VERSION' && entry.value === '2023-06-01'));
    assert.ok(config.env.some(entry => entry.key === 'PROXY_CHANNEL_MAX_ATTEMPTS'), 'policy defaults are editable from the UI');
    assert.equal(config.env.find(entry => entry.key === 'PROXY_CHANNEL_RETRY_DELAY_MS')?.value, '500');
    assert.equal(config.defaultModel, 'claude-opus-4-8');
    assert.deepEqual(config.channels.map(channel => channel.id), ['primary', 'fallback-a']);
    assert.equal(config.channels[0]?.apiKeyConfigured, true, 'the UI learns that a key exists without receiving it');
    assert.equal(config.channels[0]?.apiKeyMasked, '***', 'the UI only receives a masked placeholder');
    assert.equal(JSON.stringify(config).includes('test-key-123'), false, 'GET /admin/config never returns credentials');
    assert.equal(JSON.stringify(config).includes('fb-key'), false);
    assert.deepEqual(config.models, [{ canonicalModel: 'claude-opus-4-8', channelIds: ['primary', 'fallback-a'] }]);
    assert.deepEqual(config.aliases, { 'claude-latest': 'claude-opus-4-8' });
    assert.equal(config.legacyModelMapPath, path.join(configDir, 'model-map.json'), 'the legacy model-map path is still reported but never read');

    console.log('=== 3. POST /admin/config/validate accepts a good draft and rejects a bad one ===');
    const goodDraft = {
      env: [{ key: 'ANTHROPIC_VERSION', value: '2023-06-01' }, { key: 'PROXY_CHANNEL_MAX_ATTEMPTS', value: '2' }],
      defaultModel: 'claude-opus-4-8',
      channels: [
        { id: 'primary', name: 'Primary', baseUrl: 'https://api.anthropic.test', apiKeyAction: 'keep' },
        { id: 'fallback-a', name: 'Fallback A', baseUrl: 'https://fallback.test', apiKeyAction: 'keep' },
      ],
      models: [{ canonicalModel: 'claude-opus-4-8', channelIds: ['primary', 'fallback-a'] }],
      aliases: { 'claude-latest': 'claude-opus-4-8' },
    };
    const validated = await fetch(`${baseUrl}/admin/config/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(goodDraft) });
    assert.equal(validated.status, 200);
    const validatedBody = (await validated.json()) as { Ok?: boolean; ok?: boolean; valid?: boolean; errors?: string[] };
    assert.equal(validatedBody.valid, true);

    const badPolicy = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...goodDraft, env: [{ key: 'PROXY_CHANNEL_MAX_ATTEMPTS', value: '0' }] }),
    });
    const badPolicyBody = (await badPolicy.json()) as { valid?: boolean; errors?: string[] };
    assert.equal(badPolicyBody.valid, false);
    assert.match(badPolicyBody.errors?.join(' ') ?? '', /PROXY_CHANNEL_MAX_ATTEMPTS/);

    const badRouting = await fetch(`${baseUrl}/admin/config/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...goodDraft, models: [{ canonicalModel: 'claude-opus-4-8', channelIds: ['nope'] }] }),
    });
    const badRoutingBody = (await badRouting.json()) as { valid?: boolean; errors?: string[] };
    assert.equal(badRoutingBody.valid, false);
    assert.match(badRoutingBody.errors?.join(' ') ?? '', /unknown channel id/);

    console.log('=== 4. PUT /admin/config writes both files atomically with backups ===');
    const envBefore = readFileSync(envPath, 'utf8');
    const putRes = await fetch(`${baseUrl}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: [{ key: 'ANTHROPIC_VERSION', value: '2024-01-01' }, { key: 'PROXY_CHANNEL_MAX_ATTEMPTS', value: '2' }],
        defaultModel: 'claude-opus-4-8',
        channels: [
          { id: 'primary', name: 'Primary renamed', baseUrl: 'https://api.anthropic.test', apiKeyAction: 'keep' },
          { id: 'fallback-a', name: 'Fallback A', baseUrl: 'https://fallback.test', apiKeyAction: 'keep' },
        ],
        models: [
          { canonicalModel: 'claude-opus-4-8', channelIds: ['primary', 'fallback-a'] },
          { canonicalModel: 'claude-sonnet-4-6', channelIds: ['fallback-a'] },
        ],
        aliases: { 'claude-latest': 'claude-opus-4-8', 'claude-sonnet-latest': 'claude-sonnet-4-6' },
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as { ok?: boolean; runtimeVersion?: number };
    assert.equal(putBody.ok, true);
    assert.equal(putBody.runtimeVersion, 2, 'a successful PUT reloads the runtime in place');
    assert.equal(readFileSync(`${envPath}.bak`, 'utf8'), envBefore, 'the previous .env is kept as a 0600 backup');
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.equal(statSync(routingPath).mode & 0o777, 0o600);
    const snapshot = runtimeStore.getSnapshot();
    assert.equal(snapshot.config.anthropicVersion, '2024-01-01');
    assert.equal(snapshot.config.channelMaxAttempts, 2);
    assert.equal(snapshot.config.routingConfig.modelRoutes.size, 2);
    assert.equal(snapshot.config.routingConfig.aliases['claude-sonnet-latest'], 'claude-sonnet-4-6');
    assert.equal(healthRegistry.snapshot().channels.length, 2, 'the live health topology follows the new routing document');

    console.log('=== 5. POST /admin/config/reload applies an out-of-band edit ===');
    writeFileSync(routingPath, JSON.stringify({
      ...routingDocument,
      aliases: { 'claude-latest': 'claude-opus-4-8', 'claude-edited': 'claude-opus-4-8' },
    }, null, 2), 'utf8');
    const reloadRes = await fetch(`${baseUrl}/admin/config/reload`, { method: 'POST' });
    assert.equal(reloadRes.status, 200);
    assert.equal(runtimeStore.getSnapshot().config.routingConfig.aliases['claude-edited'], 'claude-opus-4-8');

    console.log('=== 6. POST /admin/config/rollback restores the 0600 backups ===');
    writeFileSync(envPath, 'BROKEN=1\n', 'utf8');
    const rollbackRes = await fetch(`${baseUrl}/admin/config/rollback`, { method: 'POST' });
    assert.equal(rollbackRes.status, 200);
    const rollbackBody = (await rollbackRes.json()) as { ok?: boolean; restored?: string[] };
    assert.equal(rollbackBody.ok, true);
    assert.ok(rollbackBody.restored?.includes(envPath), `expected the env file to be restored, got ${JSON.stringify(rollbackBody.restored)}`);
    assert.ok(rollbackBody.restored?.includes(routingPath), 'expected the routing file to be restored');
    assert.equal(readFileSync(envPath, 'utf8').includes('ANTHROPIC_VERSION=2023-06-01'), true, 'the env backup is restored');
    assert.equal(statSync(envPath).mode & 0o777, 0o600);

    console.log('=== 7. Remote admin calls are rejected unless PROXY_ADMIN_ALLOW_HOST is set ===');
    const localDir = makeTempDir();
    const localEnv = path.join(localDir, '.env');
    const localRouting = path.join(localDir, 'fallback.json');
    writeFileSync(localRouting, JSON.stringify(routingDocument, null, 2), 'utf8');
    writeFileSync(localEnv, ['HOST=0.0.0.0', 'PORT=12241', `FALLBACK_CONFIG_PATH=${localRouting}`].join('\n'), 'utf8');
    const localStore = createRuntimeConfigStore({ envPath: localEnv, mode: 'anthropic' });
    const localHandler = createAdminHandler({
      configStore: createConfigFileStoreFromPaths({ envPath: localEnv, fallbackPath: localRouting }),
      runtimeStore: localStore,
      healthRegistry: createHealthRegistry({}),
    });
    const remoteResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const server = createServer(async (req, res) => {
        // Present the request as coming from a public address while still being reachable on loopback.
        const fakeRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          socket: { remoteAddress: '203.0.113.7' },
          on: () => fakeRequest,
          resume: () => undefined,
        };
        const handled = await localHandler(fakeRequest as unknown as IncomingMessage, res);
        if (!handled && !res.headersSent) {
          res.writeHead(404).end();
        }
      });
      allServers.push(server);
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address();
        if (typeof address !== 'object' || !address) {
          reject(new Error('no address'));
          return;
        }
        try {
          const response = await fetch(`http://127.0.0.1:${address.port}/admin/config`);
          resolve({ status: response.status, body: await response.text() });
        } catch (error) {
          reject(error);
        }
      });
    });
    assert.equal(remoteResponse.status, 403, 'admin routes are loopback-only unless explicitly allowed');
    assert.match(remoteResponse.body, /local/i);

    console.log('\nAll anthropic-admin-config-api checks passed.');
  } finally {
    for (const server of allServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
