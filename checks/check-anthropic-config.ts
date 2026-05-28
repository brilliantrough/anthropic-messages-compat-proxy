import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAnthropicRuntimeConfig,
  type AnthropicRuntimeConfig,
  type UpstreamEndpoint,
} from '../src/anthropic-config.js';

const allTempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anthropic-config-'));
  allTempDirs.push(dir);
  return dir;
}

function writeDotEnv(dir: string, lines: string[]) {
  const envPath = path.join(dir, '.env');
  const fallbackPath = path.join(dir, 'fallback.json');
  const modelMapPath = path.join(dir, 'model-map.json');
  const full = [
    ...lines,
    `FALLBACK_CONFIG_PATH=${fallbackPath}`,
    `MODEL_MAP_PATH=${modelMapPath}`,
  ].join('\n');
  writeFileSync(envPath, full, 'utf8');
}

function writeFallbackJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'fallback.json'), JSON.stringify(content, null, 2), 'utf8');
}

function writeModelMapJson(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'model-map.json'), JSON.stringify(content, null, 2), 'utf8');
}

function main() {
  try {
    // === 1. Host/port parsing ===
    console.log('=== 1. Host/port parsing ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
        'PORT=9123',
        'HOST=127.0.0.1',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.host, '127.0.0.1', 'host from HOST env');
      assert.equal(config.port, 9123, 'port from PORT env');
    }

    // === 2. Default host/port ===
    console.log('=== 2. Default host/port ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.host, '0.0.0.0', 'default host');
      assert.equal(config.port, 11234, 'default port');
    }

    // === 3. upstreamMessagesUrl = <base>/v1/messages ===
    console.log('=== 3. upstreamMessagesUrl ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
        'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.com',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.upstreamMessagesUrl, 'https://api.anthropic.com/v1/messages');
    }

    // === 4. upstreamModelsUrl = <base>/v1/models ===
    console.log('=== 4. upstreamModelsUrl ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
        'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.com/',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.upstreamModelsUrl, 'https://api.anthropic.com/v1/models');
      assert.equal(config.primaryProviderBaseUrl, 'https://api.anthropic.com', 'trailing slash stripped');
    }

    // === 5. anthropicVersion and anthropicBeta parsing ===
    console.log('=== 5. anthropicVersion and anthropicBeta ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
        'ANTHROPIC_VERSION=2023-06-01',
        'ANTHROPIC_BETA=max-tokens-3-5-sonnet-2024-07-15,interleaved-thinking-2025-05-14',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.anthropicVersion, '2023-06-01');
      assert.equal(config.anthropicBeta, 'max-tokens-3-5-sonnet-2024-07-15,interleaved-thinking-2025-05-14');
    }

    // === 6. anthropicBeta absent ===
    console.log('=== 6. anthropicBeta absent ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.anthropicBeta, undefined, 'anthropicBeta undefined when not set');
    }

    // === 7. model mapping load from model-map.json ===
    console.log('=== 7. Model mapping load ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, {
        model_mappings: {
          'claude-3': 'claude-sonnet-4-5',
          'sonnet': 'claude-sonnet-4-5',
        },
      });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.deepEqual(config.modelMappings, {
        'claude-3': 'claude-sonnet-4-5',
        'sonnet': 'claude-sonnet-4-5',
      });
    }

    // === 8. fallback endpoint load from fallback.json using api_key_env ===
    console.log('=== 8. Fallback endpoint load with api_key_env ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, {
        fallback_api_config: [
          {
            name: 'fallback-a',
            base_url: 'https://fallback.example.com',
            api_key_env: 'FALLBACK_KEY_A',
            disable_cooldown: true,
          },
        ],
      });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
        'FALLBACK_KEY_A=fb-key-123',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.fallbackEndpoints.length, 1);
      assert.equal(config.fallbackEndpoints[0].name, 'fallback-a');
      assert.equal(config.fallbackEndpoints[0].url, 'https://fallback.example.com/v1/messages');
      assert.equal(config.fallbackEndpoints[0].apiKey, 'fb-key-123');
      assert.equal(config.fallbackEndpoints[0].isFallback, true);
      assert.equal(config.fallbackEndpoints[0].disableCooldown, true);
    }

    // === 9. fallback with inline api_key ===
    console.log('=== 9. Fallback with inline api_key ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, {
        fallback_api_config: [
          {
            name: 'fallback-inline',
            base_url: 'https://inline.example.com',
            api_key: 'inline-key-456',
          },
        ],
      });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.fallbackEndpoints.length, 1);
      assert.equal(config.fallbackEndpoints[0].apiKey, 'inline-key-456');
    }

    // === 10. primaryEndpoint constructed correctly ===
    console.log('=== 10. primaryEndpoint ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=pk-abc',
        'PRIMARY_PROVIDER_NAME=primary',
        'PRIMARY_PROVIDER_BASE_URL=https://api.anthropic.com',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.primaryEndpoint.name, 'primary');
      assert.equal(config.primaryEndpoint.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(config.primaryEndpoint.apiKey, 'pk-abc');
      assert.equal(config.primaryEndpoint.isFallback, false);
    }

    // === 11. claudeBillingHeaderMode parsing ===
    console.log('=== 11. claudeBillingHeaderMode ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
        'PROXY_CLAUDE_BILLING_HEADER_MODE=strip-cch',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.claudeBillingHeaderMode, 'strip_cch');
    }

    // === 12. default claudeBillingHeaderMode ===
    console.log('=== 12. default claudeBillingHeaderMode ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=test-key',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.claudeBillingHeaderMode, 'strip_line');
    }

    // === 13. Missing PRIMARY_PROVIDER_API_KEY throws ===
    console.log('=== 13. Missing API key throws ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, { fallback_api_config: [] });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, []);
      let thrown = false;
      try {
        createAnthropicRuntimeConfig(dir);
      } catch (err) {
        thrown = true;
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('PRIMARY_PROVIDER_API_KEY'));
      }
      assert.ok(thrown, 'should throw on missing API key');
    }

    // === 14. allEndpoints includes primary + fallbacks ===
    console.log('=== 14. allEndpoints ===');
    {
      const dir = makeTempDir();
      writeFallbackJson(dir, {
        fallback_api_config: [
          { name: 'fb-1', base_url: 'https://fb1.example.com', api_key: 'k1' },
        ],
      });
      writeModelMapJson(dir, { model_mappings: {} });
      writeDotEnv(dir, [
        'PRIMARY_PROVIDER_API_KEY=pk',
        'PRIMARY_PROVIDER_BASE_URL=https://primary.example.com',
      ]);
      const config = createAnthropicRuntimeConfig(dir);
      assert.equal(config.allEndpoints.length, 2);
      assert.equal(config.allEndpoints[0].name, 'primary-provider');
      assert.equal(config.allEndpoints[1].name, 'fb-1');
    }

    console.log('\nAll anthropic-config checks passed.');
  } finally {
    for (const d of allTempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
}

main();
