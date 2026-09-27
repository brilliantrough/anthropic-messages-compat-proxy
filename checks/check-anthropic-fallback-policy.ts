import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

type ChannelRecord = { channelId: string; fingerprint: string; quotaFailureCount: number; quotaRemainingSeconds: number; windowFailures: number; remainingMs: number };

async function readHealth(proxyPort: number) {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ healthSnapshot: { channels: ChannelRecord[] } }>;
}

function messageBody(model = 'test-model') {
  return JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] });
}

function okMessage(text: string) {
  return {
    id: 'msg_ok',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

// Attempt budget per channel, same-channel retry pacing, quota exhaustion skipping the rest of a
// channel's attempts, local model rejection and the 503 no-channel-startable path.
async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-fallback-policy-'));
  const counts = { primary: 0, quota: 0, good: 0 };

  const primary = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      counts.primary += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'primary exploded' } }));
      return;
    }
    res.writeHead(404).end();
  });

  const quota = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      counts.quota += 1;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'insufficient quota, please recharge your account', code: 'quota_exhausted' } }));
      return;
    }
    res.writeHead(404).end();
  });

  const good = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      counts.good += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(okMessage('good channel answer')));
      return;
    }
    res.writeHead(404).end();
  });

  for (const server of [primary, quota, good]) {
    server.listen(0, '127.0.0.1');
  }
  await Promise.all([once(primary, 'listening'), once(quota, 'listening'), once(good, 'listening')]);
  const addresses = [primary.address(), quota.address(), good.address()].map(address => {
    if (!address || typeof address === 'string') throw new Error('Failed to resolve mock server addresses');
    return address.port;
  });

  const proxyPort = await getAvailablePort();
  const routingConfigPath = await writeRoutingConfig(tempDir, {
    primary: { name: 'exploding-primary', baseUrl: `http://127.0.0.1:${addresses[0]}`, apiKey: 'primary-key' },
    extraChannels: [
      { id: 'quota-a', name: 'quota-a', baseUrl: `http://127.0.0.1:${addresses[1]}`, apiKey: 'quota-key' },
      { id: 'good-a', name: 'good-a', baseUrl: `http://127.0.0.1:${addresses[2]}`, apiKey: 'good-key' },
    ],
  });

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-fallback-policy-check',
      PROXY_ENV_PATH: instanceEnvPath(tempDir),
      FALLBACK_CONFIG_PATH: routingConfigPath,
      PROXY_CHANNEL_MAX_ATTEMPTS: '3',
      PROXY_CHANNEL_RETRY_DELAY_MS: '60',
      PROXY_HEALTH_FAILURE_THRESHOLD: '100',
      PROXY_MAX_FALLBACK_TOTAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  const post = (body: string) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const startedAt = Date.now();
    const first = await post(messageBody());
    const firstElapsed = Date.now() - startedAt;
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { id?: string }).id, 'msg_ok');
    assert.equal(counts.primary, 3, 'the primary channel is attempted three times (first try plus two retries)');
    assert.equal(counts.quota, 1, 'quota exhaustion stops the remaining attempts for that channel');
    assert.equal(counts.good, 1);
    assert.ok(firstElapsed >= 110, `two same-channel retry delays of 60ms should be observable, got ${firstElapsed}ms`);

    let health = await readHealth(proxyPort);
    const quotaRecord = health.healthSnapshot.channels.find(channel => channel.channelId === 'quota-a')!;
    assert.equal(quotaRecord.quotaFailureCount, 1);
    assert.ok(quotaRecord.quotaRemainingSeconds > 0, 'the quota cooldown is visible in the admin snapshot');
    const primaryRecord = health.healthSnapshot.channels.find(channel => channel.channelId === 'primary')!;
    assert.equal(primaryRecord.windowFailures, 3, 'each failed attempt lands in the shared window');
    assert.equal(primaryRecord.remainingMs, 0, 'a high failure threshold keeps the circuit closed');

    const second = await post(messageBody());
    assert.equal(second.status, 200);
    assert.equal(counts.primary, 6, 'a new request starts from the highest priority channel again');
    assert.equal(counts.quota, 1, 'the quota-exhausted channel is skipped without a new attempt');
    assert.equal(counts.good, 2);

    const unknown = await post(messageBody('not-configured-model'));
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json() as { type?: string; error?: { type?: string; message?: string } };
    assert.equal(unknownBody.type, 'error');
    assert.equal(unknownBody.error?.type, 'invalid_request_error');
    assert.match(unknownBody.error?.message ?? '', /model_not_configured/);
    assert.equal(counts.primary + counts.quota + counts.good, 9, 'an unknown model never reaches an upstream');

    const fingers = new Map(health.healthSnapshot.channels.map(channel => [channel.channelId, channel.fingerprint]));
    for (const channelId of ['primary', 'quota-a', 'good-a']) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/channels/breaker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId, fingerprint: fingers.get(channelId), action: 'open' }),
      });
      assert.equal(response.status, 200);
    }

    const blocked = await post(messageBody());
    assert.equal(blocked.status, 503);
    const retryAfter = blocked.headers.get('retry-after');
    assert.ok(retryAfter !== null && Number(retryAfter) >= 1, `expected a Retry-After header, got ${retryAfter}`);
    const blockedBody = await blocked.json() as { error?: { message?: string } };
    assert.match(blockedBody.error?.message ?? '', /model_channels_unavailable/);
    assert.equal(counts.primary + counts.quota + counts.good, 9, 'a fully blocked route starts no upstream request');

    health = await readHealth(proxyPort);
    for (const channelId of ['primary', 'quota-a', 'good-a']) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/admin/channels/breaker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId, fingerprint: fingers.get(channelId), action: 'close' }),
      });
      assert.equal(response.status, 200);
    }
    const recovered = await post(messageBody());
    assert.equal(recovered.status, 200);
    assert.equal(counts.primary, 9, 'after the manual reset the primary channel is tried again');

    console.log('Anthropic fallback policy check passed (attempts, pacing, quota skip, local reject, 503).');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => proxy.kill('SIGKILL')),
    ]);
    for (const server of [primary, quota, good]) {
      server.close();
    }
    await Promise.all([once(primary, 'close'), once(quota, 'close'), once(good, 'close')]);
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
