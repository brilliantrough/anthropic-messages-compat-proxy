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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-nonstream-missing-usage-'));
  let primaryRequests = 0;
  let fallbackRequests = 0;

  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      primaryRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_missing_usage_primary',
        type: 'message',
        role: 'assistant',
        model: 'primary-model',
        content: [{ type: 'text', text: 'usable but no usage' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'primary-model', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404).end();
  });

  const fallback = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_missing_usage_fallback',
        type: 'message',
        role: 'assistant',
        model: 'fallback-model',
        content: [{ type: 'text', text: 'fallback after missing usage' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'fallback-model', type: 'model' }], has_more: false }));
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
  const fallbackConfigPath = path.join(tempDir, 'fallback.json');
  await writeFile(fallbackConfigPath, JSON.stringify({ fallback_api_config: [{ name: 'fallback-a', base_url: `http://127.0.0.1:${fallbackAddress.port}`, api_key: 'fallback-key' }] }, null, 2), 'utf8');

  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-nonstream-missing-usage-check',
      PRIMARY_PROVIDER_NAME: 'missing-usage-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { id?: string };
    assert.equal(body.id, 'msg_missing_usage_fallback');
    assert.equal(primaryRequests, 1);
    assert.equal(fallbackRequests, 1);

    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    const stats = await statsResponse.json() as { stats?: { responsesJson?: number; fallbackReasons?: Record<string, number> } };
    assert.ok((stats.stats?.responsesJson ?? 0) >= 1, 'fallback success should still yield one accepted JSON response overall');
    assert.ok((stats.stats?.fallbackReasons?.streamMissingUsage ?? 0) >= 1, 'streamMissingUsage bucket should increment');

    const stdoutText = stdout.join('');
    assert.match(stdoutText, /upstream json response incomplete, falling back/, 'expected missing-usage source fallback log');
    assert.match(stdoutText, /"fallbackReason":"stream_missing_usage"/, 'expected stream_missing_usage source fallback reason');

    console.log('Anthropic non-stream missing-usage fallback check passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([once(proxy, 'exit'), delay(3000).then(() => proxy.kill('SIGKILL'))]);
    primary.close();
    fallback.close();
    await Promise.all([once(primary, 'close'), once(fallback, 'close')]);
    await rm(tempDir, { recursive: true, force: true });
  }

  if (stderr.length > 0) {
    const stderrText = stderr.join('').trim();
    if (stderrText.length > 0) console.error(stderrText);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
