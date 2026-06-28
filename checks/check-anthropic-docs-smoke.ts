import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function read(rel: string) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function main() {
  const readme = read('README.md');
  const dockerfile = read('Dockerfile');
  const env11234 = read('instances/example-11234/.env.example');
  const env11235 = read('instances/example-11235/.env.example');

  console.log('=== README references POST /v1/messages ===');
  assert.ok(readme.includes('POST /v1/messages'), 'README must reference POST /v1/messages');

  console.log('=== README mentions anthropic-version ===');
  assert.ok(readme.includes('anthropic-version'), 'README must mention anthropic-version');

  console.log('=== README contains linux.do ===');
  assert.ok(readme.includes('linux.do'), 'README must contain linux.do friendly link');

  console.log('=== Dockerfile uses dist/anthropic-proxy.js ===');
  assert.ok(
    dockerfile.includes('dist/anthropic-proxy.js'),
    'Dockerfile CMD must reference dist/anthropic-proxy.js',
  );

  console.log('=== example-11234 .env contains ANTHROPIC_VERSION=2023-06-01 ===');
  assert.ok(
    env11234.includes('ANTHROPIC_VERSION=2023-06-01'),
    'example-11234 .env must contain ANTHROPIC_VERSION=2023-06-01',
  );

  console.log('=== example-11234 .env contains PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5 ===');
  assert.ok(
    env11234.includes('PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5'),
    'example-11234 .env must contain PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5',
  );

  console.log('=== example-11235 .env contains ANTHROPIC_VERSION=2023-06-01 ===');
  assert.ok(
    env11235.includes('ANTHROPIC_VERSION=2023-06-01'),
    'example-11235 .env must contain ANTHROPIC_VERSION=2023-06-01',
  );

  console.log('=== example-11235 .env contains PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5 ===');
  assert.ok(
    env11235.includes('PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5'),
    'example-11235 .env must contain PRIMARY_PROVIDER_DEFAULT_MODEL=claude-sonnet-4-5',
  );

  console.log('=== README documents timeout and fallback budget config entries ===');
  for (const key of [
    'PROXY_UPSTREAM_TIMEOUT_MS',
    'PROXY_NON_STREAM_TIMEOUT_MS',
    'PROXY_FIRST_BYTE_TIMEOUT_MS',
    'PROXY_FIRST_TEXT_TIMEOUT_MS',
    'PROXY_STREAM_IDLE_TIMEOUT_MS',
    'PROXY_TOTAL_REQUEST_TIMEOUT_MS',
    'PROXY_MAX_CONCURRENT_REQUESTS',
    'PROXY_MAX_FALLBACK_ATTEMPTS',
    'PROXY_MAX_FALLBACK_TOTAL_MS',
    'PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS',
    'PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS',
    'PROXY_ENDPOINT_AUTH_COOLDOWN_MS',
    'PROXY_ENDPOINT_FAILURE_THRESHOLD',
    'PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES',
  ]) {
    assert.ok(readme.includes(key), `README must mention ${key}`);
  }

  console.log('=== README documents derived fallback-attempt default behavior ===');
  assert.ok(
    readme.includes('PROXY_MAX_FALLBACK_ATTEMPTS') && readme.includes('max(1, fallback provider count)'),
    'README must explain that PROXY_MAX_FALLBACK_ATTEMPTS defaults to max(1, fallback provider count)',
  );

  console.log('=== example env files include timeout and fallback operator knobs ===');
  for (const [name, contents] of [
    ['example-11234', env11234],
    ['example-11235', env11235],
  ] as const) {
    for (const key of [
      'PROXY_UPSTREAM_TIMEOUT_MS=',
      'PROXY_NON_STREAM_TIMEOUT_MS=',
      'PROXY_FIRST_BYTE_TIMEOUT_MS=',
      'PROXY_FIRST_TEXT_TIMEOUT_MS=',
      'PROXY_STREAM_IDLE_TIMEOUT_MS=',
      'PROXY_TOTAL_REQUEST_TIMEOUT_MS=',
      'PROXY_MAX_CONCURRENT_REQUESTS=',
      'PROXY_MAX_FALLBACK_TOTAL_MS=',
      'PROXY_ENDPOINT_TIMEOUT_COOLDOWN_MS=',
      'PROXY_ENDPOINT_INVALID_RESPONSE_COOLDOWN_MS=',
      'PROXY_ENDPOINT_AUTH_COOLDOWN_MS=',
      'PROXY_ENDPOINT_FAILURE_THRESHOLD=',
      'PROXY_ENDPOINT_HALF_OPEN_MAX_PROBES=',
    ]) {
      assert.ok(contents.includes(key), `${name} .env must contain ${key}`);
    }

    assert.equal(
      contents.includes('PROXY_MAX_FALLBACK_ATTEMPTS='),
      false,
      `${name} .env should omit PROXY_MAX_FALLBACK_ATTEMPTS so runtime can derive it from fallback provider count`,
    );
  }

  console.log('\nAll anthropic docs smoke checks passed.');
}

main();
