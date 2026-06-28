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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-stream-timeout-fallback-'));

  let primaryRequests = 0;
  let fallbackRequests = 0;

  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      primaryRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start","message":{"id":"msg_timeout","type":"message","role":"assistant","content":[],"model":"timeout-primary-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n');
      await delay(1000);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'timeout-primary-model', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
  });

  const fallback = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      fallbackRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_timeout_fallback","type":"message","role":"assistant","content":[],"model":"fallback-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":4}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"timeout fallback response"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'fallback-model', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
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
      INSTANCE_NAME: 'anthropic-proxy-stream-timeout-fallback-check',
      PRIMARY_PROVIDER_NAME: 'timeout-primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'primary-key',
      FALLBACK_CONFIG_PATH: fallbackConfigPath,
      PROXY_FIRST_TEXT_TIMEOUT_MS: '100',
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
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /timeout fallback response/);
    assert.equal(primaryRequests, 1);
    assert.equal(fallbackRequests, 1);

    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json() as {
      endpointHealth?: Array<{ name?: string; lastFailureReason?: string | null }>;
      stats?: { upstreamTimeouts?: number };
    };
    const primaryHealth = stats.endpointHealth?.find(item => item.name === 'timeout-primary');
    assert.equal(primaryHealth?.lastFailureReason, 'headers_only_timeout');
    assert.ok((stats.stats?.upstreamTimeouts ?? 0) >= 1, 'expected upstream timeout counter to increment');

    const stdoutText = stdout.join('');
    assert.match(stdoutText, /stream timeout before usable output, falling back/, 'expected timeout fallback log');
    assert.match(stdoutText, /"fallbackReason":"headers_only_timeout"/, 'expected headers_only_timeout classification');

    console.log('Anthropic stream timeout fallback check passed.');
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
