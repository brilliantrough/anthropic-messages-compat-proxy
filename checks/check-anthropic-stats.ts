import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
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
  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_stats',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Stats test answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  primary.listen(0, '127.0.0.1');
  await once(primary, 'listening');
  const primaryAddress = primary.address();
  if (!primaryAddress || typeof primaryAddress === 'string') {
    throw new Error('Failed to resolve mock server address');
  }

  const proxyPort = primaryAddress.port + 1;

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-stats-check',
      PRIMARY_PROVIDER_NAME: 'primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    // --- Send a successful non-stream request ---
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    assert.equal(response.status, 200, 'request should succeed');
    await response.text();

    // --- Check admin stats ---
    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json() as Record<string, unknown>;

    // Verify basic structure exists
    assert.ok(stats.instanceName, 'stats should have instanceName');
    assert.ok(stats.stats !== undefined, 'stats should have nested stats object');

    const statsCounters = stats.stats as Record<string, unknown>;

    // Verify request counter incremented
    assert.ok(typeof statsCounters.requestsTotal === 'number', 'stats.stats.requestsTotal should be a number');
    assert.ok((statsCounters.requestsTotal as number) >= 1, 'requestsTotal should be at least 1 after one request');

    // Verify JSON response counter
    assert.ok(typeof statsCounters.responsesJson === 'number', 'stats.stats.responsesJson should be a number');
    assert.ok((statsCounters.responsesJson as number) >= 1, 'responsesJson should be at least 1');

    // Verify usage accumulation
    assert.ok(typeof statsCounters.usageInputTokens === 'number', 'should have usageInputTokens');
    assert.ok((statsCounters.usageInputTokens as number) >= 15, `expected >=15 inputTokens, got ${statsCounters.usageInputTokens}`);

    assert.ok(typeof statsCounters.usageOutputTokens === 'number', 'should have usageOutputTokens');
    assert.ok((statsCounters.usageOutputTokens as number) >= 5, `expected >=5 outputTokens, got ${statsCounters.usageOutputTokens}`);

    assert.ok(typeof statsCounters.usageCachedInputTokens === 'number', 'should have usageCachedInputTokens');

    // Verify fallback reasons structure exists
    assert.ok(typeof statsCounters.fallbackReasons === 'object', 'should have fallbackReasons object');

    // Verify fallback by upstream structure exists
    assert.ok(typeof statsCounters.fallbackByUpstream === 'object', 'should have fallbackByUpstream object');

    // Verify error counters exist
    assert.ok(typeof statsCounters.errors4xx === 'number', 'should have errors4xx');
    assert.ok(typeof statsCounters.errors5xx === 'number', 'should have errors5xx');

    // Verify upstream timeouts counter exists
    assert.ok(typeof statsCounters.upstreamTimeouts === 'number', 'should have upstreamTimeouts');

    console.log('Anthropic admin stats check passed.');
    console.log('Stats snapshot:', JSON.stringify({
      requestsTotal: statsCounters.requestsTotal,
      responsesJson: statsCounters.responsesJson,
      usageInputTokens: statsCounters.usageInputTokens,
      usageOutputTokens: statsCounters.usageOutputTokens,
      usageCachedInputTokens: statsCounters.usageCachedInputTokens,
      errors4xx: statsCounters.errors4xx,
      errors5xx: statsCounters.errors5xx,
      upstreamTimeouts: statsCounters.upstreamTimeouts,
    }));
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => proxy.kill('SIGKILL')),
    ]);
    primary.close();
    await once(primary, 'close');
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
