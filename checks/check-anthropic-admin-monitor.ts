import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createAdminHandler } from '../src/admin-api.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-admin-monitor-'));
  allTempDirs.push(dir);
  return dir;
}

async function main() {
  try {
    console.log('=== 1. Setup with Anthropic env ===');
    const configDir = makeTempDir();
    const envPath = path.join(configDir, '.env');
    const fallbackPath = path.join(configDir, 'fallback.json');
    const modelMapPath = path.join(configDir, 'model-map.json');

    writeFileSync(fallbackPath, JSON.stringify({ fallback_api_config: [] }, null, 2), 'utf8');
    writeFileSync(modelMapPath, JSON.stringify({ model_mappings: {} }, null, 2), 'utf8');
    writeFileSync(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'ANTHROPIC_VERSION=2023-06-01',
      'ANTHROPIC_BETA=max-tokens-3-5-sonnet-2024-07-15',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line',
      `FALLBACK_CONFIG_PATH=${fallbackPath}`,
      `MODEL_MAP_PATH=${modelMapPath}`,
    ].join('\n'), 'utf8');

    const runtimeStore = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
    const snap = runtimeStore.getSnapshot();

    const configStore = createConfigFileStoreFromPaths({
      envPath,
      fallbackPath: snap.config.fallbackConfigPath,
      modelMapPath: snap.config.modelMappingPath,
    });

    const getAdminStats = () => {
      const s = runtimeStore.getSnapshot();
      return {
        instanceName: s.config.instanceName,
        anthropicVersion: s.config.anthropicVersion,
        anthropicBeta: s.config.anthropicBeta ?? null,
        upstreamMessagesUrl: s.config.upstreamMessagesUrl,
        upstreamModelsUrl: s.config.upstreamModelsUrl,
        claudeBillingHeaderMode: s.config.claudeBillingHeaderMode,
        modelMappings: s.config.modelMappings,
      };
    };

    const adminHandler = createAdminHandler({ configStore, runtimeStore, getAdminStats });

    const proxy = createAnthropicProxyServer({
      instanceName: snap.config.instanceName,
      primaryProviderName: snap.config.primaryProviderName,
      primaryProviderBaseUrl: snap.config.primaryProviderBaseUrl,
      apiKey: snap.config.apiKey,
      anthropicVersion: snap.config.anthropicVersion,
      anthropicBeta: snap.config.anthropicBeta,
      defaultModel: snap.config.defaultModel,
      modelMappings: snap.config.modelMappings,
      claudeBillingHeaderMode: snap.config.claudeBillingHeaderMode,
      primaryEndpoint: snap.config.primaryEndpoint,
      fallbackEndpoints: snap.config.fallbackEndpoints,
      maxFallbackAttempts: 3,
      maxFallbackTotalMs: 30000,
      adminHandler,
    });

    await new Promise<void>((resolve, reject) => {
      proxy.listen(0, '127.0.0.1', () => {
        const addr = proxy.address();
        if (typeof addr === 'object' && addr) {
          allServers.push(proxy);
          resolve();
        } else {
          reject(new Error('Failed to get proxy address'));
        }
      });
    });

    const proxyAddr = proxy.address() as { port: number };
    const proxyBaseUrl = `http://127.0.0.1:${proxyAddr.port}`;

    console.log('=== 2. GET /healthz exposes Anthropic fields ===');
    const healthRes = await fetch(`${proxyBaseUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthBody.anthropicVersion, '2023-06-01', 'healthz should have anthropicVersion');
    assert.equal(healthBody.anthropicBeta, 'max-tokens-3-5-sonnet-2024-07-15', 'healthz should have anthropicBeta');
    assert.equal(healthBody.upstreamMessagesUrl, 'https://api.anthropic.test/v1/messages');
    assert.equal(healthBody.upstreamModelsUrl, 'https://api.anthropic.test/v1/models');
    assert.equal(healthBody.claudeBillingHeaderMode, 'strip_line', 'healthz should have claudeBillingHeaderMode');

    console.log('=== 3. Proxy serves admin routes (GET /admin/config) ===');
    const configRes = await fetch(`${proxyBaseUrl}/admin/config`);
    assert.equal(configRes.status, 200, '/admin/config should return 200');
    const configBody = (await configRes.json()) as Record<string, unknown>;
    assert.equal(configBody.ok, true);
    const config = configBody.config as Record<string, unknown>;
    const envArr = config.env as Array<Record<string, unknown>>;

    const versionEntry = envArr.find(e => e.key === 'ANTHROPIC_VERSION');
    assert.ok(versionEntry, 'ANTHROPIC_VERSION should appear in admin env');
    assert.equal(versionEntry.value, '2023-06-01');

    const betaEntry = envArr.find(e => e.key === 'ANTHROPIC_BETA');
    assert.ok(betaEntry, 'ANTHROPIC_BETA should appear in admin env');
    assert.equal(betaEntry.value, 'max-tokens-3-5-sonnet-2024-07-15');

    console.log('=== 4. Proxy serves admin stats (GET /admin/stats) with Anthropic fields ===');
    const statsRes = await fetch(`${proxyBaseUrl}/admin/stats`);
    assert.equal(statsRes.status, 200);
    const statsBody = (await statsRes.json()) as Record<string, unknown>;
    assert.equal(
      statsBody.anthropicVersion, '2023-06-01',
      'admin/stats should have anthropicVersion',
    );
    assert.equal(
      statsBody.anthropicBeta, 'max-tokens-3-5-sonnet-2024-07-15',
      'admin/stats should have anthropicBeta',
    );
    assert.equal(
      statsBody.upstreamMessagesUrl, 'https://api.anthropic.test/v1/messages',
      'admin/stats should have upstreamMessagesUrl',
    );
    assert.equal(
      statsBody.upstreamModelsUrl, 'https://api.anthropic.test/v1/models',
      'admin/stats should have upstreamModelsUrl',
    );

    console.log('=== 5. Proxy serves admin monitor stats (GET /admin/monitor/stats) with Anthropic fields ===');
    const monitorRes = await fetch(`${proxyBaseUrl}/admin/monitor/stats`);
    assert.equal(monitorRes.status, 200);
    const monitorBody = (await monitorRes.json()) as Record<string, unknown>;
    assert.equal(monitorBody.ok, true);
    assert.equal(
      monitorBody.anthropicVersion, '2023-06-01',
      'monitor/stats should have anthropicVersion',
    );
    assert.equal(
      monitorBody.anthropicBeta, 'max-tokens-3-5-sonnet-2024-07-15',
      'monitor/stats should have anthropicBeta',
    );
    assert.equal(
      monitorBody.upstreamMessagesUrl, 'https://api.anthropic.test/v1/messages',
      'monitor/stats should have upstreamMessagesUrl',
    );
    assert.equal(
      monitorBody.upstreamModelsUrl, 'https://api.anthropic.test/v1/models',
      'monitor/stats should have upstreamModelsUrl',
    );

    console.log('\nAll anthropic-admin-monitor checks passed.');
  } finally {
    for (const server of allServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const d of allTempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
