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
    } catch { /* not ready */ }
    await delay(150);
  }
  throw new Error(`Timed out waiting for proxy health at ${url}`);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'anthropic-proxy-progressive-'));

  // Mock upstream that sends SSE events with delays between them
  const primary = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });

      // Send message_start immediately
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start","message":{"id":"msg_prog","type":"message","role":"assistant","content":[],"model":"upstream-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n');

      // Wait 200ms before first content
      await delay(200);

      // Send content_block_start
      res.write('event: content_block_start\n');
      res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');

      // Wait 200ms before first delta
      await delay(200);

      // Send first text delta (this is the "usable content" signal)
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n');

      await delay(200);

      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n');

      await delay(200);

      res.write('event: content_block_stop\n');
      res.write('data: {"type":"content_block_stop","index":0}\n\n');
      res.write('event: message_delta\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n');
      res.write('event: message_stop\n');
      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'upstream-model', type: 'model' }], has_more: false }));
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
      INSTANCE_NAME: 'anthropic-proxy-progressive-check',
      PRIMARY_PROVIDER_NAME: 'primary',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${primaryAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
      PROXY_UPSTREAM_TIMEOUT_MS: '30000',
      PROXY_FIRST_BYTE_TIMEOUT_MS: '15000',
      PROXY_FIRST_TEXT_TIMEOUT_MS: '15000',
      PROXY_STREAM_IDLE_TIMEOUT_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr: string[] = [];
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    // Send a streaming request and track when chunks arrive
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'client-alias',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes('text/event-stream'), 'should return SSE content-type');

    // Read the stream incrementally and track chunk arrival times
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunkArrivals: { time: number; text: string }[] = [];
    const startTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chunkArrivals.push({ time: Date.now() - startTime, text });
    }

    // The upstream sends events with 200ms delays between them (3 gaps × 200ms = 600ms minimum).
    // With buffer-then-replay, ALL chunks arrive at ~the same time (after upstream finishes).
    // With progressive streaming, chunks arrive spread out over time.

    // Verify: at least 2 separate chunks arrived with 100ms+ gap between them
    assert.ok(chunkArrivals.length >= 2, `Expected at least 2 chunks, got ${chunkArrivals.length}`);

    // Check that first and last chunk have a meaningful time gap (proves progressive delivery)
    const firstChunkTime = chunkArrivals[0].time;
    const lastChunkTime = chunkArrivals[chunkArrivals.length - 1].time;
    const span = lastChunkTime - firstChunkTime;

    assert.ok(span >= 300, `Expected progressive delivery with 300ms+ span between first and last chunk, got ${span}ms (buffer-then-replay detected)`);

    // Combine all text
    const allText = chunkArrivals.map(c => c.text).join('');

    // Verify model alias restoration in normalized mode (default)
    assert.match(allText, /client-alias/, 'normalized mode should rewrite model to client alias');
    assert.doesNotMatch(allText, /upstream-model/, 'normalized mode should not expose upstream model');

    // Verify content was received
    assert.match(allText, /Hello/, 'should contain first delta text');
    assert.match(allText, /world/, 'should contain second delta text');

    console.log(`Progressive streaming check passed. ${chunkArrivals.length} chunks over ${span}ms span.`);
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
