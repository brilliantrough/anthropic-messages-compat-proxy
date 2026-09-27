import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { getAvailablePort, instanceEnvPath, writeRoutingConfig } from './_helpers.js';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForHealthy(url: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

type HealthSnapshot = {
  topologyGeneration: number;
  channels: Array<{
    channelId: string;
    fingerprint: string;
    windowFailures: number;
    windowSuccesses: number;
    totalFailures: number;
    remainingMs: number;
    manualRemainingSeconds: number;
    quotaRemainingSeconds: number;
    disableCooldown: boolean;
  }>;
};

async function readHealth(proxyPort: number): Promise<HealthSnapshot> {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
  assert.equal(response.status, 200);
  const body = await response.json() as { healthSnapshot: HealthSnapshot };
  return body.healthSnapshot;
}

function requestBody() {
  return JSON.stringify({ model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] });
}

// The shared rolling window, manual breaker control and the late-result guard, exercised over HTTP.
async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-cooldown-'));
  let primaryRequests = 0;
  let fallbackRequests = 0;

  const primary = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      primaryRequests += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'primary exploded' } }));
      return;
    }
    res.writeHead(404).end();
  });

  const fallback = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_fallback',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'fallback ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }));
      return;
    }
    res.writeHead(404).end();
  });

  primary.listen(0, '127.0.0.1');
  fallback.listen(0, '127.0.0.1');
  await Promise.all([once(primary, 'listening'), once(fallback, 'listening')]);
  const primaryAddress = primary.address();
  const fallbackAddress = fallback.address();
  if (!primaryAddress || typeof primaryAddress === 'string' || !fallbackAddress || typeof fallbackAddress === 'string') {
    throw new Error('Failed to resolve mock server addresses');
  }

  const proxyPort = await getAvailablePort();
  const routingConfigPath = await writeRoutingConfig(tempDir, {
    primary: { name: 'exploding-primary', baseUrl: `http://127.0.0.1:${primaryAddress.port}`, apiKey: 'primary-key' },
    extraChannels: [{ id: 'fallback-a', name: 'fallback-a', baseUrl: `http://127.0.0.1:${fallbackAddress.port}`, apiKey: 'fallback-key' }],
  });
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-cooldown-check',
      PROXY_ENV_PATH: instanceEnvPath(tempDir),
      FALLBACK_CONFIG_PATH: routingConfigPath,
      PROXY_HEALTH_FAILURE_THRESHOLD: '2',
      PROXY_HEALTH_COOLDOWN_MS: '60000',
      PROXY_CHANNEL_MAX_ATTEMPTS: '1',
      PROXY_CHANNEL_RETRY_DELAY_MS: '0',
      PROXY_MAX_FALLBACK_TOTAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { id?: string };
      assert.equal(body.id, 'msg_fallback');
    }

    let health = await readHealth(proxyPort);
    const primaryChannel = health.channels.find(channel => channel.channelId === 'primary')!;
    assert.equal(primaryChannel.windowFailures, 2, 'two failures land in the shared window');
    assert.equal(primaryChannel.remainingMs > 0, true, '2 failures with a 100% rate open the breaker at the configured threshold');
    const fingerprint = primaryChannel.fingerprint;

    const third = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(),
    });
    assert.equal(third.status, 200);
    assert.equal(primaryRequests, 2, 'the open breaker skips the primary channel');
    assert.equal(fallbackRequests, 3);
    assert.match(stdout.join(''), /attempting fallback upstream/);

    const stale = await fetch(`http://127.0.0.1:${proxyPort}/admin/channels/breaker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'primary', fingerprint: 'stale-fingerprint', action: 'close' }),
    });
    assert.equal(stale.status, 409, 'a stale fingerprint must be rejected so the admin refreshes first');

    const closed = await fetch(`http://127.0.0.1:${proxyPort}/admin/channels/breaker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'primary', fingerprint, action: 'close' }),
    });
    assert.equal(closed.status, 200);
    health = await readHealth(proxyPort);
    const afterClose = health.channels.find(channel => channel.channelId === 'primary')!;
    assert.equal(afterClose.remainingMs, 0);
    assert.equal(afterClose.windowFailures, 0, 'manual close clears the decision window');
    assert.equal(afterClose.totalFailures, 2, 'manual close keeps the cumulative counters');

    const fourth = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(),
    });
    assert.equal(fourth.status, 200);
    assert.equal(primaryRequests, 3, 'after a manual close the highest priority channel is tried again');

    const opened = await fetch(`http://127.0.0.1:${proxyPort}/admin/channels/breaker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'primary', fingerprint, action: 'open' }),
    });
    assert.equal(opened.status, 200);
    const fifth = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(),
    });
    assert.equal(fifth.status, 200);
    assert.equal(primaryRequests, 3, 'a manual open skips the channel immediately');

    console.log('Anthropic cooldown check passed (shared window, manual control, stale fingerprint guard).');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => proxy.kill('SIGKILL')),
    ]);
    primary.close();
    fallback.close();
    await Promise.all([once(primary, 'close'), once(fallback, 'close')]);
    await rm(tempDir, { recursive: true, force: true });
  }

  if (stderr.length > 0) {
    const stderrText = stderr.join('').trim();
    if (stderrText.length > 0) {
      console.error(stderrText);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
