import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { createAnthropicProxyServer } from '../src/anthropic-proxy.js';
import { routingFixture } from './_helpers.js';

async function main() {
  let upstreamRequestBody: unknown;
  let sawRequest = false;

  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      sawRequest = true;
      let raw = '';
      for await (const chunk of req) {
        raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      try {
        upstreamRequestBody = JSON.parse(raw);
      } catch {
        upstreamRequestBody = { parseError: true, raw };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_cache_check',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 4 },
      }));
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
    instanceName: 'anthropic-cache-control-check',
    cacheControlMode: 'standardize',
    cacheControlTtl: '1h',
    routingConfig: routingFixture({
      primary: { name: 'mock-anthropic', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'upstream-key' },
      models: ['claude-sonnet-4-5'],
    }),
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'client-key', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 't', description: 'd', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'early', cache_control: { type: 'ephemeral' } }] },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'final' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(sawRequest, 'upstream received the forwarded request');

    const body = upstreamRequestBody as {
      system?: { cache_control?: unknown }[];
      tools?: { cache_control?: unknown }[];
      messages?: { role: string; content: unknown }[];
    };
    assert.equal(body.system?.[0].cache_control, undefined, 'system cache_control is stripped');
    assert.equal(body.tools?.[0].cache_control, undefined, 'tools cache_control is stripped');
    assert.deepEqual(body.messages?.[0].content, [{ type: 'text', text: 'early' }], 'early message markers are stripped');
    assert.deepEqual(body.messages?.[2].content, [
      { type: 'text', text: 'final', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ], 'single ephemeral breakpoint with configured ttl lands on the last message');
    console.log('Anthropic cache control checks passed.');
  } finally {
    proxy.close();
    upstream.close();
    await Promise.allSettled([once(proxy, 'close'), once(upstream, 'close')]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
