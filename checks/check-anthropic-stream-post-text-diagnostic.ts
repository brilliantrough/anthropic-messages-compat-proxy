import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';
import { createHealthRegistry } from '../src/channel-health.js';
import { healthRecord, routingFixture } from './_helpers.js';
import { createProxyStats } from '../src/anthropic-messages-handler.js';

async function main() {
  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start","message":{"id":"msg_diag","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
      res.write('event: content_block_start\n');
      res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello timeout"}}\n\n');
      await delay(500);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-4-8', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404).end();
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');

  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(item => String(item)).join(' '));
    originalLog(...args);
  };

  const routingConfig = routingFixture({
    primary: { name: 'primary', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'test-key' },
    models: ['claude-opus-4-8'],
  });
  const healthRegistry = createHealthRegistry({ healthFailureThreshold: 1, healthCooldownMs: 120000, healthWindowMs: 180000 });
  const stats = createProxyStats();

  const proxy = createAnthropicProxyServer({
    port: 0,
    host: '127.0.0.1',
    instanceName: 'anthropic-stream-post-text-diagnostic-check',
    anthropicVersion: '2023-06-01',
    routingConfig,
    streamIdleTimeoutMs: 100,
    firstByteTimeoutMs: 1000,
    firstTextTimeoutMs: 1000,
    defaultStreamMode: 'normalized',
    healthRegistry,
    stats,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /hello timeout/);
    assert.match(text, /Stream timeout/);
    assert.equal(
      captured.some(line => line.includes('stream produced usable text but did not end cleanly')),
      true,
      'expected diagnostic log for post-text non-completed stream outcome',
    );
    const health = healthRecord(healthRegistry, 'primary');
    // The window reason is the classified one; the raw reason stays visible in the log line and the stats bucket.
    assert.equal(health.lastFailureReason, 'timeout');
    assert.equal((health as unknown as { windowFailures: number }).windowFailures, 1);
    assert.equal(stats.fallbackReasons.streamTimeoutAfterText, 1);
    assert.equal(
      captured.some(line => line.includes('"failureReason":"stream_timeout_after_text"')),
      true,
      'the raw post-text timeout reason stays observable',
    );

    console.log('Anthropic stream post-text diagnostic check passed.');
  } finally {
    console.log = originalLog;
    proxy.close();
    upstream.close();
    await Promise.all([once(proxy, 'close'), once(upstream, 'close')]);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
