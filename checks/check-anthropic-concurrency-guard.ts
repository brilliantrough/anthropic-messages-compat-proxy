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
      await delay(2000);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_conc',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'Concurrent answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
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
      INSTANCE_NAME: 'anthropic-proxy-concurrency-check',
      PRIMARY_PROVIDER_NAME: 'primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
      PROXY_MAX_CONCURRENT_REQUESTS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const makeRequest = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const first = await makeRequest();
    assert.equal(first.status, 200, 'first request should succeed when under limit');
    await first.text();

    const [second, concurrentBlocked] = await Promise.all([
      makeRequest(),
      makeRequest(),
    ]);

    const statuses = [second.status, concurrentBlocked.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 503], `Expected one 200 and one 503, got ${statuses}`);

    const blockedText = await Promise.all([second.text(), concurrentBlocked.text()]);
    const blockedBody = blockedText.find(t => t.includes('overloaded_error') || t.includes('overloadRejects'));
    assert.ok(blockedBody === undefined || blockedBody.length > 0, 'blocked response should have a body');

    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    const stats = await statsResponse.json() as Record<string, unknown>;
    const statsCounters = stats.stats as Record<string, unknown>;

    assert.ok(typeof statsCounters.overloadRejects === 'number', 'should have overloadRejects counter');
    assert.ok((statsCounters.overloadRejects as number) >= 1, `overloadRejects should be >= 1, got ${statsCounters.overloadRejects}`);

    const healthResponse = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    const health = await healthResponse.json() as Record<string, unknown>;
    assert.equal(health.maxConcurrentRequests, 1, 'healthz should expose maxConcurrentRequests from env');

    console.log('Anthropic concurrency guard check passed.');
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
