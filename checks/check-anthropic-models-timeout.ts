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

// The models list now comes from the routing config, so an upstream whose models endpoint
// never answers must not delay or break GET /v1/models (it must not be called at all).
async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-models-timeout-'));
  let upstreamModelsRequests = 0;

  const primary = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      upstreamModelsRequests += 1;
      res.flushHeaders();
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
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
  const routingConfigPath = await writeRoutingConfig(tempDir, {
    primary: { name: 'late-primary', baseUrl: `http://127.0.0.1:${primaryAddress.port}`, apiKey: 'test-key' },
    models: ['late-model'],
  });
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-models-timeout-check',
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
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 200);
    assert.ok(elapsed < 500, `local models list should answer fast, got ${elapsed}ms`);
    const body = await response.json() as { data?: Array<{ id?: string; type?: string }>; first_id?: string | null; last_id?: string | null; has_more?: boolean };
    assert.deepEqual(body.data?.map(entry => entry.id), ['late-model']);
    assert.equal(body.data?.[0]?.type, 'model');
    assert.equal(body.first_id, 'late-model');
    assert.equal(body.last_id, 'late-model');
    assert.equal(body.has_more, false);
    assert.equal(upstreamModelsRequests, 0, 'the upstream models endpoint must not be called');
    assert.match(stdout.join(''), /configured models returned/);

    console.log('Anthropic models timeout check passed (local list ignores the hanging upstream).');
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
