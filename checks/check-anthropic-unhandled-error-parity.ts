import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';
import { createHealthRegistry } from '../src/channel-health.js';
import { createProxyStats } from '../src/anthropic-messages-handler.js';
import { healthRecord, routingFixture, throwingOnceRegistry } from './_helpers.js';

async function main() {
  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_unhandled',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 1 },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404).end();
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');

  const routingConfig = routingFixture({
    primary: { name: 'primary', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'test-key' },
    models: ['claude-sonnet-4-5'],
  });
  const realStore = createHealthRegistry({
    healthFailureThreshold: 1,
    healthCooldownMs: 120000,
    healthWindowMs: 180000,
  });
  const wrappedStore = throwingOnceRegistry(realStore);

  const stats = createProxyStats();
  const proxy = createAnthropicProxyServer({
    port: 0,
    host: '127.0.0.1',
    instanceName: 'anthropic-unhandled-parity-check',
    anthropicVersion: '2023-06-01',
    routingConfig,
    healthRegistry: wrappedStore,
    stats,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}`;

  try {
    const response = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(response.status, 500);
    const health = healthRecord(realStore, 'primary');
    // proxy_unhandled_error keeps scope 'none': it is recorded for diagnosis but never counted as a channel failure.
    assert.equal(health.lastFailureReason, 'proxy_internal');
    assert.equal(health.windowFailures, 0, 'a proxy-side bug must not blame the channel window');
    assert.equal(health.remainingMs, 0, 'a proxy-side bug must not open the breaker');
    assert.equal(stats.fallbackReasons.proxyUnhandledError, 1);

    console.log('Anthropic unhandled-error parity check passed.');
  } finally {
    proxy.close();
    upstream.close();
    await Promise.all([once(proxy, 'close'), once(upstream, 'close')]);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
