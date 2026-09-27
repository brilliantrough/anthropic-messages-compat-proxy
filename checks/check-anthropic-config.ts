import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAnthropicRuntimeConfig, routingPolicyDefaults } from '../src/anthropic-config.js';
import { parseRoutingConfig } from '../src/routing-config.js';

const routingDoc = {
  default_model: 'claude-opus-4-8',
  channels: [
    { id: 'primary', name: 'Primary', base_url: 'https://primary.example.com/', api_key: 'primary-key-123' },
    { id: 'fallback-a', name: 'Fallback A', base_url: 'https://fallback.example.com', api_key: 'fb-key-123', disable_cooldown: true },
  ],
  models: {
    'claude-opus-4-8': { channel_ids: ['primary', 'fallback-a'] },
    'claude-sonnet-4-6': { channel_ids: ['fallback-a'] },
  },
  aliases: { 'claude-latest': 'claude-opus-4-8' },
};

async function writeInstance(dir: string, envLines: string) {
  const envPath = path.join(dir, '.env');
  // Relative routing paths resolve against the process working directory, so tests use absolute paths.
  await writeFile(envPath, envLines.trimStart().replaceAll('./fallback.json', path.join(dir, 'fallback.json')), 'utf8');
  await writeFile(path.join(dir, 'fallback.json'), JSON.stringify(routingDoc, null, 2), 'utf8');
  return envPath;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'anthropic-config-check-'));

  try {
    console.log('=== 1. Env and routing config basics ===');
    {
      const dir = path.join(tempRoot, 'basic');
      await rm(dir, { recursive: true, force: true });
      await mkdirFor(dir);
      const envPath = await writeInstance(dir, `
HOST=127.0.0.1
PORT=9123
INSTANCE_NAME=test-instance
FALLBACK_CONFIG_PATH=./fallback.json
`);
      const config = createAnthropicRuntimeConfig(envPath);
      assert.equal(config.host, '127.0.0.1');
      assert.equal(config.port, 9123);
      assert.equal(config.instanceName, 'test-instance');
      assert.equal(config.routingConfigPath, path.join(dir, 'fallback.json'));
      assert.equal(config.routingConfig.defaultModel, 'claude-opus-4-8');
      assert.equal(config.routingConfig.aliases['claude-latest'], 'claude-opus-4-8');
      assert.equal(config.routingConfig.channelsById.get('primary')?.messagesUrl, 'https://primary.example.com/v1/messages');
      assert.equal(config.routingConfig.channelsById.get('fallback-a')?.disableCooldown, true);
      assert.equal(config.routingConfig.modelRoutes.get('claude-sonnet-4-6')?.channelIds.length, 1);
      assert.equal(config.usageDbPath, path.join(dir, 'usage.sqlite'), 'the usage database lives beside the instance env');
      assert.equal(config.adminAllowHost, false, 'remote admin calls are rejected by default');
    }

    console.log('=== 2. Policy defaults and overrides ===');
    {
      const dir = path.join(tempRoot, 'policy');
      await mkdirFor(dir);
      const envPath = await writeInstance(dir, `
PORT=11234
FALLBACK_CONFIG_PATH=./fallback.json
`);
      const defaults = createAnthropicRuntimeConfig(envPath);
      assert.equal(defaults.healthWindowMs, Number(routingPolicyDefaults.PROXY_HEALTH_WINDOW_MS));
      assert.equal(defaults.healthFailureThreshold, Number(routingPolicyDefaults.PROXY_HEALTH_FAILURE_THRESHOLD));
      assert.equal(defaults.healthFailureRateThreshold, Number(routingPolicyDefaults.PROXY_HEALTH_FAILURE_RATE_THRESHOLD));
      assert.equal(defaults.healthCooldownMs, Number(routingPolicyDefaults.PROXY_HEALTH_COOLDOWN_MS));
      assert.equal(defaults.channelMaxAttempts, Number(routingPolicyDefaults.PROXY_CHANNEL_MAX_ATTEMPTS));
      assert.equal(defaults.channelRetryDelayMs, Number(routingPolicyDefaults.PROXY_CHANNEL_RETRY_DELAY_MS));
      assert.equal(defaults.quotaCooldownMs, Number(routingPolicyDefaults.PROXY_QUOTA_COOLDOWN_MS));
      assert.equal(defaults.channelMaxAttempts, 3);
      assert.equal(defaults.channelRetryDelayMs, 500);
      assert.equal(defaults.healthWindowMs, 180000);
      assert.equal(defaults.healthCooldownMs, 600000);
      assert.equal(defaults.quotaCooldownMs, 7200000);
      assert.equal(defaults.adminAllowHost, false, 'remote admin access stays disabled unless PROXY_ADMIN_ALLOW_HOST is set');
    }
    {
      const dir = path.join(tempRoot, 'policy-override');
      await mkdirFor(dir);
      const envPath = await writeInstance(dir, `
PORT=11234
FALLBACK_CONFIG_PATH=./fallback.json
PROXY_HEALTH_WINDOW_MS=60000
PROXY_HEALTH_FAILURE_THRESHOLD=5
PROXY_HEALTH_FAILURE_RATE_THRESHOLD=0.25
PROXY_HEALTH_COOLDOWN_MS=120000
PROXY_CHANNEL_MAX_ATTEMPTS=2
PROXY_CHANNEL_RETRY_DELAY_MS=250
PROXY_QUOTA_COOLDOWN_MS=3600000
PROXY_ADMIN_ALLOW_HOST=1
PROXY_INSTANCE_DIR=/tmp/does-not-exist
`);
      const config = createAnthropicRuntimeConfig(envPath);
      assert.equal(config.healthWindowMs, 60000);
      assert.equal(config.healthFailureThreshold, 5);
      assert.equal(config.healthFailureRateThreshold, 0.25);
      assert.equal(config.healthCooldownMs, 120000);
      assert.equal(config.channelMaxAttempts, 2);
      assert.equal(config.channelRetryDelayMs, 250);
      assert.equal(config.quotaCooldownMs, 3600000);
      assert.equal(config.adminAllowHost, true);
      assert.equal(config.usageDbPath, path.join(dir, 'usage.sqlite'), 'PROXY_INSTANCE_DIR must not move the usage database');
    }

    console.log('=== 3. Invalid policy values are rejected ===');
    for (const [key, value] of [['PROXY_CHANNEL_MAX_ATTEMPTS', '0'], ['PROXY_CHANNEL_RETRY_DELAY_MS', '-5'], ['PROXY_HEALTH_FAILURE_THRESHOLD', 'abc'], ['PROXY_HEALTH_FAILURE_RATE_THRESHOLD', '2']]) {
      const dir = path.join(tempRoot, `invalid-${key}`);
      await mkdirFor(dir);
      const envPath = await writeInstance(dir, `
PORT=11234
FALLBACK_CONFIG_PATH=./fallback.json
${key}=${value}
`);
      assert.throws(() => createAnthropicRuntimeConfig(envPath), new RegExp(key), `${key}=${value} must be rejected`);
    }

    console.log('=== 4. Missing routing config fails fast ===');
    {
      const dir = path.join(tempRoot, 'missing');
      await mkdirFor(dir);
      const envPath = path.join(dir, '.env');
      await writeFile(envPath, 'PORT=11234\n', 'utf8');
      assert.throws(() => createAnthropicRuntimeConfig(envPath), /ENOENT|no such file/u);
    }

    console.log('=== 5. Legacy keys are warned about, not silently used ===');
    {
      const dir = path.join(tempRoot, 'legacy');
      await mkdirFor(dir);
      const envPath = await writeInstance(dir, `
PORT=11234
FALLBACK_CONFIG_PATH=./fallback.json
PRIMARY_PROVIDER_BASE_URL=https://legacy.example.com
PRIMARY_PROVIDER_API_KEY=legacy-key
MODEL_MAP_PATH=./model-map.json
PROXY_ENDPOINT_FAILURE_THRESHOLD=1
PROXY_MAX_FALLBACK_ATTEMPTS=11
`);
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
      try {
        const config = createAnthropicRuntimeConfig(envPath);
        assert.equal(config.routingConfig.channelsById.size, 2, 'channels still come from the routing config only');
        assert.equal(config.channelMaxAttempts, 3, 'PROXY_MAX_FALLBACK_ATTEMPTS must not drive the new attempt policy');
      } finally {
        console.warn = originalWarn;
      }
      const joined = warnings.join('\n');
      assert.match(joined, /PRIMARY_PROVIDER_\*/u);
      assert.match(joined, /MODEL_MAP_PATH is ignored/u);
      assert.match(joined, /Legacy endpoint health settings ignored/u);
    }

    console.log('=== 6. Routing document validation covers the allowlist boundary ===');
    {
      assert.throws(() => parseRoutingConfig({ ...routingDoc, models: {} }, '<x>'), /at least one canonical model/u);
      assert.throws(() => parseRoutingConfig({ ...routingDoc, channels: [] }, '<x>'), /channels must be a non-empty array/u);
      const parsed = parseRoutingConfig(routingDoc, '<x>');
      const primaryFingerprint = parsed.channelsById.get('primary')!.fingerprint;
      assert.match(primaryFingerprint, /^[0-9a-f]{64}$/u, 'the fingerprint is a hash, never the raw credential');
      assert.equal(primaryFingerprint.includes('primary-key-123'), false, 'the API key is never echoed in the fingerprint');
      assert.equal(parseRoutingConfig(routingDoc, '<x>').channelsById.get('primary')!.fingerprint, primaryFingerprint, 'the fingerprint is stable for identical settings');
      const rotated = parseRoutingConfig({ ...routingDoc, channels: [{ ...routingDoc.channels[0], api_key: 'rotated-key' }, routingDoc.channels[1]] }, '<x>');
      assert.notEqual(rotated.channelsById.get('primary')!.fingerprint, primaryFingerprint, 'key rotation changes the fingerprint');
      const renamed = parseRoutingConfig({ ...routingDoc, channels: [{ ...routingDoc.channels[0], name: 'Renamed' }, routingDoc.channels[1]] }, '<x>');
      assert.equal(renamed.channelsById.get('primary')!.fingerprint, primaryFingerprint, 'a display-name rename keeps the health state (the fingerprint covers id, URL and key)');
      const moved = parseRoutingConfig({ ...routingDoc, channels: [{ ...routingDoc.channels[0], base_url: 'https://other.example.com' }, routingDoc.channels[1]] }, '<x>');
      assert.notEqual(moved.channelsById.get('primary')!.fingerprint, primaryFingerprint, 'a URL change rotates the fingerprint');
    }

    console.log('Anthropic config check passed.');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function mkdirFor(dir: string) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
