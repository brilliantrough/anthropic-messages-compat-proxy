import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  const upstream = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean };

      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end([
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret chain of thought"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"apiKey\":\"secret-value\"}"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello stream"}}',
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
        ].join('\n'));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_json',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hello json' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1 },
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

  const proxyPort = await getAvailablePort();
  const tsxCliPath = require.resolve('tsx/cli');
  const proxy = spawn(process.execPath, [tsxCliPath, 'src/anthropic-proxy.ts'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      INSTANCE_NAME: 'anthropic-proxy-logging-check',
      PRIMARY_PROVIDER_NAME: 'mock-anthropic',
      PRIMARY_PROVIDER_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      PRIMARY_PROVIDER_API_KEY: 'test-key',
      PROXY_LOG_REQUEST_BODY: '1',
      PROXY_DEBUG_SSE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proxy.stdout.on('data', chunk => stdout.push(String(chunk)));
  proxy.stderr.on('data', chunk => stderr.push(String(chunk)));

  try {
    await waitForHealthy(`http://127.0.0.1:${proxyPort}/healthz`);

    const jsonResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'public-claude',
        max_tokens: 128,
        system: 'x-anthropic-billing-header: cc_version=2.1.119; cch=req-1;\n\nStable system',
        metadata: { debugPrompt: 'secret-arbitrary-field' },
        input: { apiKey: 'secret-nested-key' },
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              data: 'image-secret-data',
            },
          }],
        }],
      }),
    });
    assert.equal(jsonResponse.status, 200);
    await jsonResponse.text();

    const streamResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'public-claude',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Hello SSE' }],
      }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.match(streamText, /content_block_delta/);

    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/admin/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json() as {
      logRequestBodies?: boolean;
      debugSse?: boolean;
      fallbackOnRetryable4xx?: boolean;
      fallbackOnCompat4xx?: boolean;
      compatFallbackPatterns?: string[];
      clientErrorPatterns?: string[];
    };
    assert.equal(stats.logRequestBodies, true);
    assert.equal(stats.debugSse, true);
    assert.equal(stats.fallbackOnRetryable4xx, true);
    assert.equal(stats.fallbackOnCompat4xx, true);
    assert.ok(Array.isArray(stats.compatFallbackPatterns));
    assert.ok(Array.isArray(stats.clientErrorPatterns));

    const stdoutText = stdout.join('');
    assert.match(stdoutText, /Instance: anthropic-proxy-logging-check/, 'expected startup instance log');
    assert.match(stdoutText, /Primary provider: mock-anthropic/, 'expected startup provider log');
    assert.match(stdoutText, /Request body logging: enabled/, 'expected startup request-body logging status');
    assert.match(stdoutText, /SSE debug logging: enabled/, 'expected startup sse debug status');
    assert.match(stdoutText, /request accepted/, 'expected request accepted log');
    assert.match(stdoutText, /request body preview/, 'expected request body preview log');
    assert.match(stdoutText, /forwarding upstream/, 'expected forwarding upstream log');
    assert.match(stdoutText, /json response returned/, 'expected non-stream finish log');
    assert.match(stdoutText, /"statusCode":200/, 'expected status code in finish log');
    assert.match(stdoutText, /"durationMs":\d+/, 'expected durationMs in finish log');
    assert.match(stdoutText, /sse debug preview/, 'expected SSE debug preview log');
    assert.match(stdoutText, /stream passthrough started/, 'expected SSE start log');
    assert.match(stdoutText, /stream passthrough finished/, 'expected stream finish log');
    assert.doesNotMatch(stdoutText, /cch=req-1/, 'request body preview should sanitize billing header cch value');
    assert.doesNotMatch(stdoutText, /Hello JSON/, 'request body preview should redact request text content');
    assert.doesNotMatch(stdoutText, /secret-arbitrary-field/, 'request body preview should redact arbitrary nested string fields');
    assert.doesNotMatch(stdoutText, /secret-nested-key/, 'request body preview should redact nested input object values');
    assert.doesNotMatch(stdoutText, /image-secret-data/, 'request body preview should redact nested content object values');
    assert.doesNotMatch(stdoutText, /hello stream/, 'SSE debug preview should redact stream text content');
    assert.doesNotMatch(stdoutText, /secret chain of thought/, 'SSE debug preview should redact thinking delta content');
    assert.doesNotMatch(stdoutText, /secret-value/, 'SSE debug preview should redact input_json delta content');

    console.log('Anthropic logging check passed.');
  } finally {
    proxy.kill('SIGTERM');
    await Promise.race([
      once(proxy, 'exit'),
      delay(3000).then(() => proxy.kill('SIGKILL')),
    ]);
    upstream.close();
    await once(upstream, 'close');
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
