import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeConfigStore } from '../src/runtime-config.js';

const allTempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-runtime-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(envPath: string, lines: string[]) {
  writeFileSync(envPath, lines.join('\n'), 'utf8');
}

function setupDir(dir: string) {
  const fallbackPath = path.join(dir, 'fallback.json');
  const modelMapPath = path.join(dir, 'model-map.json');
  writeFileSync(fallbackPath, JSON.stringify({ fallback_api_config: [] }, null, 2), 'utf8');
  writeFileSync(modelMapPath, JSON.stringify({ model_mappings: {} }, null, 2), 'utf8');
}

function main() {
  try {
    console.log('=== 1. Initial snapshot has Anthropic defaults ===');
    const dir1 = makeTempDir();
    setupDir(dir1);
    const envPath = path.join(dir1, '.env');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=8080',
      'HOST=127.0.0.1',
      `FALLBACK_CONFIG_PATH=${path.join(dir1, 'fallback.json')}`,
      `MODEL_MAP_PATH=${path.join(dir1, 'model-map.json')}`,
    ]);

    const store = createRuntimeConfigStore({ envPath, mode: 'anthropic' });
    const snap1 = store.getSnapshot();

    assert.equal(snap1.config.anthropicVersion, '2023-06-01', 'default anthropicVersion should be 2023-06-01');
    assert.equal(snap1.config.anthropicBeta, undefined, 'default anthropicBeta should be undefined');
    assert.equal(
      snap1.config.upstreamMessagesUrl,
      'https://api.anthropic.test/v1/messages',
      'upstreamMessagesUrl should be built from base URL',
    );
    assert.equal(
      snap1.config.upstreamModelsUrl,
      'https://api.anthropic.test/v1/models',
      'upstreamModelsUrl should be built from base URL',
    );
    assert.equal(snap1.config.claudeBillingHeaderMode, 'strip_line', 'default billing header mode');

    console.log('=== 2. Reload picks up new ANTHROPIC_VERSION ===');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=8080',
      'HOST=127.0.0.1',
      'ANTHROPIC_VERSION=2024-01-01',
      `FALLBACK_CONFIG_PATH=${path.join(dir1, 'fallback.json')}`,
      `MODEL_MAP_PATH=${path.join(dir1, 'model-map.json')}`,
    ]);

    const result2 = store.reloadFromFiles();
    assert.equal(result2.ok, true, 'reload should succeed');
    const snap2 = store.getSnapshot();
    assert.equal(snap2.runtimeVersion, 2, 'version incremented');
    assert.equal(snap2.config.anthropicVersion, '2024-01-01', 'anthropicVersion should be updated after reload');
    assert.equal(snap2.config.anthropicBeta, undefined, 'anthropicBeta should still be undefined');

    console.log('=== 3. Reload picks up new ANTHROPIC_BETA ===');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=8080',
      'HOST=127.0.0.1',
      'ANTHROPIC_VERSION=2024-01-01',
      'ANTHROPIC_BETA=new-beta-feature',
      `FALLBACK_CONFIG_PATH=${path.join(dir1, 'fallback.json')}`,
      `MODEL_MAP_PATH=${path.join(dir1, 'model-map.json')}`,
    ]);

    const result3 = store.reloadFromFiles();
    assert.equal(result3.ok, true);
    const snap3 = store.getSnapshot();
    assert.equal(snap3.config.anthropicBeta, 'new-beta-feature', 'anthropicBeta should be updated');

    console.log('=== 4. Reload picks up PROXY_CLAUDE_BILLING_HEADER_MODE change ===');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=8080',
      'HOST=127.0.0.1',
      'ANTHROPIC_VERSION=2024-01-01',
      'ANTHROPIC_BETA=new-beta-feature',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_cch',
      `FALLBACK_CONFIG_PATH=${path.join(dir1, 'fallback.json')}`,
      `MODEL_MAP_PATH=${path.join(dir1, 'model-map.json')}`,
    ]);

    const result4 = store.reloadFromFiles();
    assert.equal(result4.ok, true);
    const snap4 = store.getSnapshot();
    assert.equal(snap4.config.claudeBillingHeaderMode, 'strip_cch', 'billing header mode updated');

    console.log('=== 5. PORT/HOST changes still report restartRequiredFields ===');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=9999',
      'HOST=0.0.0.0',
      'ANTHROPIC_VERSION=2024-01-01',
      'ANTHROPIC_BETA=new-beta-feature',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_cch',
      `FALLBACK_CONFIG_PATH=${path.join(dir1, 'fallback.json')}`,
      `MODEL_MAP_PATH=${path.join(dir1, 'model-map.json')}`,
    ]);

    const result5 = store.reloadFromFiles();
    assert.equal(result5.ok, true);
    const snap5 = store.getSnapshot();
    assert.ok(snap5.restartRequiredFields.includes('PORT'), 'PORT should be in restartRequiredFields');
    assert.ok(snap5.restartRequiredFields.includes('HOST'), 'HOST should be in restartRequiredFields');
    assert.equal(snap5.config.port, 9999, 'port should be updated in snapshot');
    assert.equal(snap5.config.host, '0.0.0.0', 'host should be updated in snapshot');

    console.log('=== 6. Anthropic field changes do NOT trigger restartRequiredFields ===');
    writeDotEnv(envPath, [
      'PRIMARY_PROVIDER_NAME=anthropic-test',
      'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.test',
      'PRIMARY_PROVIDER_API_KEY=test-key-123',
      'PORT=9999',
      'HOST=0.0.0.0',
      'ANTHROPIC_VERSION=2025-01-01',
      'ANTHROPIC_BETA=another-beta',
      'PROXY_CLAUDE_BILLING_HEADER_MODE=strip_line',
      `FALLBACK_CONFIG_PATH=${path.join(dir1, 'fallback.json')}`,
      `MODEL_MAP_PATH=${path.join(dir1, 'model-map.json')}`,
    ]);

    const result6 = store.reloadFromFiles();
    assert.equal(result6.ok, true);
    const snap6 = store.getSnapshot();
    assert.equal(snap6.config.anthropicVersion, '2025-01-01', 'anthropicVersion updated');
    assert.equal(snap6.config.anthropicBeta, 'another-beta', 'anthropicBeta updated');
    assert.equal(snap6.config.claudeBillingHeaderMode, 'strip_line', 'billing mode updated');
    assert.deepEqual(
      snap6.restartRequiredFields, [],
      'Anthropic field changes should NOT trigger restartRequiredFields',
    );

    console.log('\nAll anthropic-runtime-reload checks passed.');
  } finally {
    for (const d of allTempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

main();
