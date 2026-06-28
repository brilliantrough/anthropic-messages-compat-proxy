import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { getAvailablePort } from './_helpers.js';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForHealthy(url: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function main() {
  const primary = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.flushHeaders();
      await delay(1000);
      res.end(JSON.stringify({ data: [{ id: 'late-model', type: 'model' }], has_more: false }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_ok',
        type: 'message',
        role: 'assistant',
        model: 'late-model',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
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

  const proxyPort = await getAvailablePort();
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-models-timeout-check',
      PRIMARY_PROVIDER_NAME: 'late-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 504);
    assert.ok(elapsed < 500, `models timeout should happen fast, got ${elapsed}ms`);

    const stdoutText = stdout.join('');
    assert.match(stdoutText, /forwarding models request/, 'expected models forwarding log');
    assert.match(stdoutText, /models response body timeout/, 'expected models body-timeout log');

    console.log('Anthropic models timeout check passed.');
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
