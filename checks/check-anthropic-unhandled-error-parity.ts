import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';
import { createEndpointHealthStore } from '../src/proxy-core.js';
import { createProxyStats } from '../src/anthropic-messages-handler.js';

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

  const primaryEndpoint = {
    name: 'primary',
    url: `http://127.0.0.1:${upstreamAddress.port}/v1/messages`,
    apiKey: 'test-key',
    isFallback: false,
  };

  const realStore = createEndpointHealthStore({
    endpointTimeoutCooldownMs: 120000,
    endpointInvalidResponseCooldownMs: 120000,
    endpointAuthCooldownMs: 1800000,
    endpointFailureThreshold: 1,
    endpointHalfOpenMaxProbes: 1,
  });

  const wrappedStore = {
    ...realStore,
    markEndpointSuccess(endpoint: typeof primaryEndpoint) {
      if (endpoint.name === 'primary') {
        throw new Error('boom-success-hook');
      }
      realStore.markEndpointSuccess(endpoint);
    },
  };

  const stats = createProxyStats();
  const proxy = createAnthropicProxyServer({
    port: 0,
    host: '127.0.0.1',
    instanceName: 'anthropic-unhandled-parity-check',
    primaryProviderName: 'primary',
    primaryProviderBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    apiKey: 'test-key',
    anthropicVersion: '2023-06-01',
    endpointHealthStore: wrappedStore,
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
    const health = realStore.getSnapshot(primaryEndpoint);
    assert.equal(health.lastFailureReason, 'proxy_unhandled_error');
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
