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

// Local model listing also owns pagination and cursor validation for a stalled upstream.
async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-models-idle-'));
  let upstreamModelsRequests = 0;

  const primary = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      upstreamModelsRequests += 1;
      // Headers plus one byte, then stall forever: the old handler waited for the body.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.write('{');
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
  const routingConfigPath = await writeRoutingConfig(tempDir, {
    primary: { name: 'stalled-primary', baseUrl: `http://127.0.0.1:${primaryAddress.port}`, apiKey: 'test-key' },
    models: ['claude-sonnet-4-5', 'claude-opus-4-8'],
  });
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-models-idle-timeout-check',
      PROXY_ENV_PATH: instanceEnvPath(tempDir),
      FALLBACK_CONFIG_PATH: routingConfigPath,
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
    const page = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?limit=1`);
    const elapsed = Date.now() - startedAt;
    assert.equal(page.status, 200);
    assert.ok(elapsed < 500, `local models pagination should answer fast, got ${elapsed}ms`);
    const pageBody = await page.json() as { data?: Array<{ id?: string }>; first_id?: string | null; last_id?: string | null; has_more?: boolean };
    assert.deepEqual(pageBody.data?.map(entry => entry.id), ['claude-opus-4-8']);
    assert.equal(pageBody.has_more, true);

    const nextPage = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?limit=1&after_id=claude-opus-4-8`);
    assert.equal(nextPage.status, 200);
    const nextBody = await nextPage.json() as { data?: Array<{ id?: string }>; has_more?: boolean };
    assert.deepEqual(nextBody.data?.map(entry => entry.id), ['claude-sonnet-4-5']);
    assert.equal(nextBody.has_more, false);

    const badCursor = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?after_id=missing-model`);
    assert.equal(badCursor.status, 400);
    const badCursorBody = await badCursor.json() as { type?: string; error?: { type?: string } };
    assert.equal(badCursorBody.type, 'error');
    assert.equal(badCursorBody.error?.type, 'invalid_request_error');

    const badLimit = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?limit=0`);
    assert.equal(badLimit.status, 400);

    assert.equal(upstreamModelsRequests, 0, 'the upstream models endpoint must not be called');
    assert.match(stdout.join(''), /configured models returned/);

    console.log('Anthropic models idle-timeout check passed (local pagination, stalled upstream untouched).');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => proxy.kill('SIGKILL')),
    ]);
    primary.close();
    await once(primary, 'close');
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
