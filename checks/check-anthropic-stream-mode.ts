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
    } catch { /* not ready */ }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function main() {
  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const sseBody = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_mode","type":"message","role":"assistant","content":[],"model":"upstream-real-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mode test"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');
      res.end(sseBody);
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'upstream-real-model', type: 'model' }], has_more: false }));
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
      INSTANCE_NAME: 'anthropic-proxy-stream-mode-check',
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

    // --- Test 1: Normalized mode (default) rewrites model ---
    const normalizedResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-alias-model',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(normalizedResponse.status, 200);
    const normalizedText = await normalizedResponse.text();

    // In normalized mode, message_start should have model rewritten to client alias
    assert.match(normalizedText, /client-alias-model/, 'normalized mode should rewrite model in events');
    assert.doesNotMatch(normalizedText, /upstream-real-model/, 'normalized mode should NOT expose upstream model');

    // --- Test 2: Raw mode preserves upstream events untouched ---
    const rawResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-proxy-stream-mode': 'raw',
      },
      body: JSON.stringify({
        model: 'client-alias-model',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(rawResponse.status, 200);
    const rawText = await rawResponse.text();

    // In raw mode, events should be passed through as-is
    assert.match(rawText, /upstream-real-model/, 'raw mode should preserve upstream model');

    // --- Test 3: Raw mode via body field ---
    const rawBodyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-alias-model',
        max_tokens: 128,
        stream: true,
        proxy_stream_mode: 'raw',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(rawBodyResponse.status, 200);
    const rawBodyText = await rawBodyResponse.text();
    assert.match(rawBodyText, /upstream-real-model/, 'raw mode via body field should preserve upstream model');

    console.log('Anthropic stream mode checks passed.');
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
