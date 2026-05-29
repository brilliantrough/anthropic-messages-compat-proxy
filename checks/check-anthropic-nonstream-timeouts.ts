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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-nonstream-timeouts-'));

  let primaryRequests = 0;
  let fallbackRequests = 0;

  // Primary that hangs (never responds) to trigger connect timeout
  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      primaryRequests += 1;
      // Hang for 60 seconds to trigger timeout
      await delay(60000);
      res.writeHead(200);
      res.end();
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
        id: 'msg_timeout_fb',
        type: 'message',
        role: 'assistant',
        model: 'fallback-model',
        content: [{ type: 'text', text: 'Timeout fallback answer' }],
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
      INSTANCE_NAME: 'anthropic-proxy-timeout-check',
      PRIMARY_PROVIDER_NAME: 'hanging-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      // Short timeout to make the test fast
      PROXY_UPSTREAM_TIMEOUT_MS: '3000',
      PROXY_NON_STREAM_TIMEOUT_MS: '3000',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '3000',
      PROXY_STREAM_IDLE_TIMEOUT_MS: '3000',
      PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    // --- Send a non-stream request; primary will hang → proxy should timeout and fallback ---
    const startTime = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const elapsed = Date.now() - startTime;

    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;

    // Verify we got the fallback response
    assert.equal(body.id, 'msg_timeout_fb', 'should receive fallback response after timeout');
    assert.equal(elapsed < 10000, true, `should complete within 10s (took ${elapsed}ms) — timeout should fire fast`);

    // Verify primary was hit and fallback was hit
    assert.equal(primaryRequests, 1, 'expected primary to be called once');
    assert.ok(fallbackRequests >= 1, `expected fallback to be called at least once, got ${fallbackRequests}`);

    // --- Check that endpoint health shows the timeout ---
    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    const stats = await statsResponse.json() as Record<string, unknown>;
    const endpointHealth = stats.endpointHealth as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(endpointHealth), 'endpointHealth should be an array');

    const primaryHealth = endpointHealth.find(e => e.name === 'hanging-primary');
    assert.ok(primaryHealth, 'should have health record for hanging-primary');

    // Primary should have been marked as failed (connect_error or timeout)
    assert.ok(
      primaryHealth.failureCount !== undefined && (primaryHealth.failureCount as number) >= 1,
      `primary should have failureCount >= 1, got ${JSON.stringify(primaryHealth)}`,
    );

    // Verify admin stats has upstreamTimeouts counter
    const statsCounters = stats.stats as Record<string, unknown> | undefined;
    if (statsCounters) {
      assert.ok(typeof statsCounters.upstreamTimeouts === 'number', 'stats.stats should have upstreamTimeouts');
      assert.ok((statsCounters.upstreamTimeouts as number) >= 1, 'upstreamTimeouts should be at least 1');
    }

    console.log(`Non-stream timeout fallback check passed (elapsed: ${elapsed}ms).`);
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
