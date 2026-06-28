import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createConfigFileStoreFromPaths } from '../src/config-files.js';
import { createRuntimeConfigStore } from '../src/runtime-config.js';
import { createAdminHandler } from '../src/admin-api.js';

const allTempDirs: string[] = [];
const allServers: import('node:http').Server[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-admin-config-'));
  allTempDirs.push(dir);
  return dir;
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Promise<{ server: import('node:http').Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled && !res.headersSent && !res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    allServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

async function main() {
  try {
    const expectedRuntimeDefaults = {
      PROXY_UPSTREAM_TIMEOUT_MS: '30000',
      PROXY_NON_STREAM_TIMEOUT_MS: '300000',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '30000',
      PROXY_FIRST_TEXT_TIMEOUT_MS: '12000',
      PROXY_STREAM_IDLE_TIMEOUT_MS: '60000',
      PROXY_TOTAL_REQUEST_TIMEOUT_MS: '600000',
      PROXY_MAX_CONCURRENT_REQUESTS: '128',
      PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS: '120000',
      PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS: '120000',
      PROXY_ENDPOINT_AUTH_COOLDOWN_MS: '1800000',
      PROXY_ENDPOINT_FAILURE_THRESHOLD: '1',
      PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES: '1',
      PROXY_MAX_FALLBACK_TOTAL_MS: '30000',
    } as const;

    console.log('=== 1. Setup with Anthropic env keys in .env ===');
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
    const adminHandler = createAdminHandler({ configStore, runtimeStore });
    const { port } = await startServer(adminHandler);
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log('=== 2. GET /admin/config exposes ANTHROPIC_VERSION ===');
    const configRes = await fetch(`${baseUrl}/admin/config`);
    assert.equal(configRes.status, 200);
    const configBody = (await configRes.json()) as Record<string, unknown>;
    const config = configBody.config as Record<string, unknown>;
    const envArr = config.env as Array<Record<string, unknown>>;

    const versionEntry = envArr.find(e => e.key === 'ANTHROPIC_VERSION');
    assert.ok(versionEntry, 'ANTHROPIC_VERSION should appear in admin env');
    assert.equal(versionEntry.value, '2023-06-01', 'ANTHROPIC_VERSION should have correct value');

    console.log('=== 3. GET /admin/config exposes ANTHROPIC_BETA ===');
    const betaEntry = envArr.find(e => e.key === 'ANTHROPIC_BETA');
    assert.ok(betaEntry, 'ANTHROPIC_BETA should appear in admin env');
    assert.equal(betaEntry.value, 'max-tokens-3-5-sonnet-2024-07-15', 'ANTHROPIC_BETA should have correct value');

    console.log('=== 4. GET /admin/config exposes PROXY_CLAUDE_BILLING_HEADER_MODE ===');
    const billingEntry = envArr.find(e => e.key === 'PROXY_CLAUDE_BILLING_HEADER_MODE');
    assert.ok(billingEntry, 'PROXY_CLAUDE_BILLING_HEADER_MODE should appear in admin env');
    assert.equal(billingEntry.value, 'strip_line', 'PROXY_CLAUDE_BILLING_HEADER_MODE should have correct value');

    console.log('=== 5. Snapshot exposes anthropicVersion and anthropicBeta ===');
    assert.equal(snap.config.anthropicVersion, '2023-06-01', 'snapshot should have anthropicVersion');
    assert.equal(snap.config.anthropicBeta, 'max-tokens-3-5-sonnet-2024-07-15', 'snapshot should have anthropicBeta');

    console.log('=== 6. Snapshot exposes upstreamMessagesUrl and upstreamModelsUrl ===');
    assert.equal(snap.config.upstreamMessagesUrl, 'https://api.anthropic.test/v1/messages');
    assert.equal(snap.config.upstreamModelsUrl, 'https://api.anthropic.test/v1/models');

    console.log('=== 7. ANTHROPIC_VERSION appears as default even without explicit .env entry ===');
    const configDir2 = makeTempDir();
    const envPath2 = path.join(configDir2, '.env');
    const fallbackPath2 = path.join(configDir2, 'fallback.json');
    const modelMapPath2 = path.join(configDir2, 'model-map.json');

    writeFileSync(fallbackPath2, JSON.stringify({ fallback_api_config: [] }, null, 2), 'utf8');
    writeFileSync(modelMapPath2, JSON.stringify({ model_mappings: {} }, null, 2), 'utf8');
    writeFileSync(envPath2, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-456',
      `FALLBACK_CONFIG_PATH=${fallbackPath2}`,
      `MODEL_MAP_PATH=${modelMapPath2}`,
    ].join('\n'), 'utf8');

    const runtimeStore2 = createRuntimeConfigStore({ envPath: envPath2, mode: 'anthropic' });
    const snap2 = runtimeStore2.getSnapshot();
    const configStore2 = createConfigFileStoreFromPaths({
      envPath: envPath2,
      fallbackPath: snap2.config.fallbackConfigPath,
      modelMapPath: snap2.config.modelMappingPath,
    });
    const adminHandler2 = createAdminHandler({ configStore: configStore2, runtimeStore: runtimeStore2 });
    const { port: port2 } = await startServer(adminHandler2);
    const baseUrl2 = `http://127.0.0.1:${port2}`;

    const configRes2 = await fetch(`${baseUrl2}/admin/config`);
    assert.equal(configRes2.status, 200);
    const configBody2 = (await configRes2.json()) as Record<string, unknown>;
    const config2 = configBody2.config as Record<string, unknown>;
    const envArr2 = config2.env as Array<Record<string, unknown>>;

    const defaultVersionEntry = envArr2.find(e => e.key === 'ANTHROPIC_VERSION');
    assert.ok(defaultVersionEntry, 'ANTHROPIC_VERSION should appear in admin env even without explicit .env entry');
    assert.equal(defaultVersionEntry.value, '2023-06-01', 'ANTHROPIC_VERSION should have default value');

    const defaultBillingEntry = envArr2.find(e => e.key === 'PROXY_CLAUDE_BILLING_HEADER_MODE');
    assert.ok(defaultBillingEntry, 'PROXY_CLAUDE_BILLING_HEADER_MODE should appear as default');
    assert.equal(defaultBillingEntry.value, 'strip_line');

    console.log('=== 8. Timeout and fallback runtime defaults appear in admin env even when omitted ===');
    for (const [key, expectedValue] of Object.entries(expectedRuntimeDefaults)) {
      const entry = envArr2.find(e => e.key === key);
      assert.ok(entry, `${key} should appear in admin env as a default`);
      assert.equal(entry.value, expectedValue, `${key} should have default value ${expectedValue}`);
    }

    const defaultAttemptsEntry = envArr2.find(e => e.key === 'PROXY_MAX_FALLBACK_ATTEMPTS');
    assert.ok(defaultAttemptsEntry, 'PROXY_MAX_FALLBACK_ATTEMPTS should appear in admin env as a derived default');
    assert.equal(defaultAttemptsEntry.value, '1', 'PROXY_MAX_FALLBACK_ATTEMPTS should default to 1 when no fallback providers exist');

    console.log('=== 9. Derived fallback-attempt default tracks fallback provider count ===');
    const configDir3 = makeTempDir();
    const envPath3 = path.join(configDir3, '.env');
    const fallbackPath3 = path.join(configDir3, 'fallback.json');
    const modelMapPath3 = path.join(configDir3, 'model-map.json');

    writeFileSync(fallbackPath3, JSON.stringify({
      fallback_api_config: [
        { name: 'fallback-a', base_url: 'https://fallback-a.example', api_key: 'key-a' },
        { name: 'fallback-b', base_url: 'https://fallback-b.example', api_key: 'key-b' },
      ],
    }, null, 2), 'utf8');
    writeFileSync(modelMapPath3, JSON.stringify({ model_mappings: {} }, null, 2), 'utf8');
    writeFileSync(envPath3, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-789',
      `FALLBACK_CONFIG_PATH=${fallbackPath3}`,
      `MODEL_MAP_PATH=${modelMapPath3}`,
    ].join('\n'), 'utf8');

    const runtimeStore3 = createRuntimeConfigStore({ envPath: envPath3, mode: 'anthropic' });
    const snap3 = runtimeStore3.getSnapshot();
    const configStore3 = createConfigFileStoreFromPaths({
      envPath: envPath3,
      fallbackPath: snap3.config.fallbackConfigPath,
      modelMapPath: snap3.config.modelMappingPath,
    });
    const adminHandler3 = createAdminHandler({ configStore: configStore3, runtimeStore: runtimeStore3 });
    const { port: port3 } = await startServer(adminHandler3);
    const baseUrl3 = `http://127.0.0.1:${port3}`;

    const configRes3 = await fetch(`${baseUrl3}/admin/config`);
    assert.equal(configRes3.status, 200);
    const configBody3 = (await configRes3.json()) as Record<string, unknown>;
    const config3 = configBody3.config as Record<string, unknown>;
    const envArr3 = config3.env as Array<Record<string, unknown>>;
    const derivedAttemptsEntry = envArr3.find(e => e.key === 'PROXY_MAX_FALLBACK_ATTEMPTS');
    assert.ok(derivedAttemptsEntry, 'PROXY_MAX_FALLBACK_ATTEMPTS should appear with fallback providers present');
    assert.equal(derivedAttemptsEntry.value, '2', 'PROXY_MAX_FALLBACK_ATTEMPTS should default to fallback provider count when env is omitted');

    console.log('=== 10. Admin runtime table allowlist includes fallback/timeout entries ===');
    const adminJs = readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'admin', 'assets', 'admin.js'), 'utf8');
    const requiredRuntimeKeys = [
      ...Object.keys(expectedRuntimeDefaults),
      'PROXY_MAX_FALLBACK_ATTEMPTS',
    ];
    for (const key of requiredRuntimeKeys) {
      assert.ok(adminJs.includes(`'${key}'`), `${key} should be included in admin.js runtime allowlist`);
    }

    console.log('=== 11. HTML renders the redesigned shared admin shell ===');
    const htmlRes = await fetch(`${baseUrl}/admin`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    const requiredShellClasses = [
      'admin-shell',
      'topbar',
      'content-grid',
      'config-column',
      'status-column',
    ];
    for (const cls of requiredShellClasses) {
      assert.ok(
        html.includes(cls),
        `anthropic admin page should render the shared admin shell class "${cls}"`,
      );
    }

    console.log('=== 12. HTML renders the redesigned notice and status panel structure ===');
    assert.ok(
      html.includes('status-panel'),
      'anthropic admin page should render the read-only status panel',
    );
    assert.ok(
      html.includes('panel-title'),
      'anthropic admin page should render compact panel titles',
    );

    console.log('=== 13. JS uses the redesigned model mapping editor structure ===');
    assert.ok(
      adminJs.includes('mapping-row'),
      'anthropic model mapping renderer should use the redesigned mapping row class',
    );
    assert.ok(
      adminJs.includes('mapping-arrow'),
      'anthropic model mapping renderer should render the visual mapping arrow',
    );

    console.log('=== 14. JS uses the redesigned provider/fallback editor structure ===');
    assert.ok(
      adminJs.includes('fallback-row'),
      'anthropic fallback renderer should emit redesigned fallback rows',
    );

    console.log('\nAll anthropic-admin-config-api checks passed.');
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
