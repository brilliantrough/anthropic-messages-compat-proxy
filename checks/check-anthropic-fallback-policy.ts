import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForHealthy(url: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not ready */ }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-fallback-policy-'));

  let primaryRequests = 0;
  let fallbackRequests = 0;

  // Primary that returns 401 Unauthorized
  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      primaryRequests += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Invalid API key',
        },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'primary-model', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const fallback = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_auth_fb',
        type: 'message',
        role: 'assistant',
        model: 'fallback-model',
        content: [{ type: 'text', text: 'Auth fallback answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  primary.listen(0, '127.0.0.1');
  fallback.listen(0, '127.0.0.1');
  await Promise.all([once(primary, 'listening'), once(fallback, 'listening')]);

  const primaryAddress = primary.address();
  const fallbackAddress = fallback.address();
  if (!primaryAddress || typeof primaryAddress === 'string' || !fallbackAddress || typeof fallbackAddress === 'string') {
    throw new Error('Failed to resolve mock server addresses');
  }

  const proxyPort = fallbackAddress.port + 1;
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(
    fallbackConfigPath,
    JSON.stringify({
      fallback_api_config: [
        {
          name: 'fallback-a',
          base_url: `http://127.0.0.1:${fallbackAddress.port}`,
          api_key: 'fallback-key',
        },
      ],
    }, null, 2),
    'utf8',
  );

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-fallback-policy-check',
      PRIMARY_PROVIDER_NAME: 'auth-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_ENDPOINT_AUTH_COOLDOWN_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    // --- First request: primary returns 401, should fall back ---
    const response1 = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response1.status, 200);
    const body1 = await response1.json() as Record<string, unknown>;
    assert.equal(body1.id, 'msg_auth_fb', 'should have fallen back after 401');
    assert.equal(primaryRequests, 1, 'primary should have been called once');
    assert.equal(fallbackRequests, 1, 'fallback should have been called once');

    // --- Second request: primary should be skipped (cooldown), go directly to fallback ---
    const response2 = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello again' }],
      }),
    });

    assert.equal(response2.status, 200);
    const body2 = await response2.json() as Record<string, unknown>;
    assert.equal(body2.id, 'msg_auth_fb', 'second request should also go to fallback');

    // Primary should NOT have been called again (cooldown from first 401)
    assert.equal(primaryRequests, 1, 'primary should NOT be called again while in cooldown');
    assert.equal(fallbackRequests, 2, 'fallback should have been called twice total');

    // --- Check endpoint health shows auth cooldown ---
    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    const stats = await statsResponse.json() as Record<string, unknown>;
    const endpointHealth = stats.endpointHealth as Array<Record<string, unknown>>;

    const primaryHealth = endpointHealth.find(e => e.name === 'auth-primary');
    assert.ok(primaryHealth, 'should have health for auth-primary');
    assert.equal(primaryHealth.state, 'open', 'primary should be in open state after 401');
    assert.equal(primaryHealth.lastFailureReason, 'compat_4xx', 'failure reason should be compat_4xx');
    assert.ok((primaryHealth.failureCount as number) >= 1, 'failureCount should be at least 1');

    // --- Check fallback reasons counter ---
    const statsCounters = stats.stats as Record<string, unknown> | undefined;
    if (statsCounters) {
      const fallbackReasons = statsCounters.fallbackReasons as Record<string, number>;
      if (fallbackReasons) {
        assert.ok(
          (fallbackReasons.compat_4xx ?? fallbackReasons.compat4xx) >= 1,
          `expected compat_4xx >= 1, got ${JSON.stringify(fallbackReasons)}`,
        );
      }
    }

    console.log('Fallback policy (401/403 auth cooldown) check passed.');
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
