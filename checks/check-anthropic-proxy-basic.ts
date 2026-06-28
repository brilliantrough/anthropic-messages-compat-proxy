import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';

async function main() {
  let upstreamRequestBody: unknown;
  let upstreamVersion: string | undefined;
  let upstreamApiKey: string | undefined;

  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      upstreamVersion = req.headers['anthropic-version'] as string | undefined;
      upstreamApiKey = req.headers['x-api-key'] as string | undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_upstream_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hello from upstream' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', type: 'model' }], has_more: false }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');

  const proxy = createAnthropicProxyServer({
    instanceName: 'anthropic-proxy-basic-check',
    primaryProviderName: 'mock-anthropic',
    primaryProviderBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    apiKey: 'upstream-key',
    anthropicVersion: '2023-06-01',
    defaultModel: 'claude-haiku-4-5',
    modelMappings: { 'public-claude': 'claude-sonnet-4-5' },
    claudeBillingHeaderMode: 'strip_line',
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}`;

  try {
    const healthResponse = await fetch(`${proxyBaseUrl}/healthz?verbose=1`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as { upstreamMessagesUrl?: string };
    assert.equal(health.upstreamMessagesUrl, `http://127.0.0.1:${upstreamAddress.port}/v1/messages`);

    const response = await fetch(`${proxyBaseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'client-key-that-must-not-be-forwarded',
      },
      body: JSON.stringify({
        model: 'public-claude',
        max_tokens: 128,
        system: 'x-anthropic-billing-header: cc_version=2.1.119; cch=req-1;\n\nStable system',
        messages: [{ role: 'user', content: 'Hello' }],
        proxy_stream_mode: 'normalized',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { model?: string; usage?: { cache_read_input_tokens?: number } };
    assert.equal(body.model, 'public-claude');
    assert.equal(body.usage?.cache_read_input_tokens, 3);
    assert.equal(upstreamVersion, '2023-06-01');
    assert.equal(upstreamApiKey, 'upstream-key');
    assert.deepEqual(upstreamRequestBody, {
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      system: 'Stable system',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const modelsResponse = await fetch(`${proxyBaseUrl}/v1/models?beta=true`);
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json() as { data?: Array<{ id?: string }> };
    assert.equal(models.data?.some(item => item.id === 'public-claude'), true);

    console.log('Anthropic proxy basic check passed.');
  } finally {
    proxy.close();
    upstream.close();
    await Promise.all([once(proxy, 'close'), once(upstream, 'close')]);
  }
}

main();
