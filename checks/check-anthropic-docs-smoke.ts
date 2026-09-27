import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function read(rel: string) {
  return readFileSync(path.join(root, rel), 'utf8');
}

const activeDocs = [
  'AGENTS.md',
  'README.md',
  'docs/quickstart.md',
  'docs/examples.md',
  'docs/configuration.md',
  'docs/streaming-compatibility.md',
  'docs/operations.md',
  'docs/zh/README.md',
  'docs/zh/quickstart.md',
  'docs/zh/examples.md',
  'docs/zh/configuration.md',
  'docs/zh/streaming-compatibility.md',
  'docs/zh/operations.md',
] as const;

const forbiddenActiveText = [
  '/v1/responses',
  'response.output_text.delta',
  'prompt_cache_key',
  'prompt_cache_retention',
  'Responses API Compatibility Proxy',
  '/opt/responses-api-compat-proxy',
  'responses-proxy@',
  'deploy/systemd/responses-proxy@.service.example',
  'env $(grep -v',
] as const;

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

  console.log('=== example instances use the routing document ===');
  for (const [name, env, routing] of [
    ['example-11234', env11234, read('instances/example-11234/fallback.json.example')],
    ['example-11235', env11235, read('instances/example-11235/fallback.json.example')],
  ] as const) {
    assert.ok(env.includes('ANTHROPIC_VERSION=2023-06-01'), `${name} .env must contain ANTHROPIC_VERSION=2023-06-01`);
    const doc = JSON.parse(routing) as { default_model?: string; channels?: unknown[]; models?: Record<string, unknown>; aliases?: Record<string, string> };
    assert.ok(doc.default_model, `${name} routing document must declare default_model`);
    assert.ok(Array.isArray(doc.channels) && doc.channels.length > 0, `${name} routing document must declare channels`);
    assert.ok(doc.models && Object.keys(doc.models).length > 0, `${name} routing document must declare canonical models`);
    assert.ok(doc.aliases && Object.keys(doc.aliases).length > 0, `${name} routing document must declare aliases`);
  }

  console.log('=== README documents timeout, routing, and health config entries ===');
  for (const key of [
    'PROXY_UPSTREAM_TIMEOUT_MS',
    'PROXY_NON_STREAM_TIMEOUT_MS',
    'PROXY_FIRST_BYTE_TIMEOUT_MS',
    'PROXY_FIRST_TEXT_TIMEOUT_MS',
    'PROXY_STREAM_IDLE_TIMEOUT_MS',
    'PROXY_TOTAL_REQUEST_TIMEOUT_MS',
    'PROXY_MAX_CONCURRENT_REQUESTS',
    'PROXY_MAX_FALLBACK_TOTAL_MS',
    'PROXY_HEALTH_WINDOW_MS',
    'PROXY_HEALTH_FAILURE_THRESHOLD',
    'PROXY_HEALTH_FAILURE_RATE_THRESHOLD',
    'PROXY_HEALTH_COOLDOWN_MS',
    'PROXY_CHANNEL_MAX_ATTEMPTS',
    'PROXY_CHANNEL_RETRY_DELAY_MS',
    'PROXY_QUOTA_COOLDOWN_MS',
    'PROXY_USAGE_DB_PATH',
  ]) {
    assert.ok(readme.includes(key), `README must mention ${key}`);
  }

  console.log('=== example env files include timeout, policy, and usage knobs ===');
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
      'PROXY_HEALTH_WINDOW_MS=',
      'PROXY_HEALTH_FAILURE_THRESHOLD=',
      'PROXY_HEALTH_FAILURE_RATE_THRESHOLD=',
      'PROXY_HEALTH_COOLDOWN_MS=',
      'PROXY_CHANNEL_MAX_ATTEMPTS=',
      'PROXY_CHANNEL_RETRY_DELAY_MS=',
      'PROXY_QUOTA_COOLDOWN_MS=',
      'PROXY_USAGE_DB_PATH=',
    ]) {
      assert.ok(contents.includes(key), `${name} .env must contain ${key}`);
    }

    for (const retired of ['MODEL_MAP_PATH=', 'PRIMARY_PROVIDER_', 'PROXY_ENDPOINT_', 'PROXY_MAX_FALLBACK_ATTEMPTS=']) {
      assert.equal(
        contents.includes(retired),
        false,
        `${name} .env must not carry the retired key ${retired}`,
      );
    }
  }

  console.log('=== active docs contain no Responses-era protocol or deployment references ===');
  for (const rel of activeDocs) {
    const contents = read(rel);
    for (const forbidden of forbiddenActiveText) {
      assert.equal(contents.includes(forbidden), false, `${rel} must not contain ${forbidden}`);
    }
  }

  const agents = read('AGENTS.md');
  const quickstart = read('docs/quickstart.md');
  const streaming = read('docs/streaming-compatibility.md');
  const service = read('deploy/systemd/anthropic-messages-proxy@.service.example');
  const waitHelper = read('wait-proxy-idle.sh');

  for (const required of ['POST /v1/messages', 'GET /v1/models', 'anthropic-version', 'cache_control']) {
    assert.ok(`${agents}\n${quickstart}`.includes(required), `active instructions must mention ${required}`);
  }
  for (const required of ['message_start', 'content_block_delta', 'input_json_delta']) {
    assert.ok(streaming.includes(required), `streaming docs must mention ${required}`);
  }
  assert.ok(service.includes('/opt/anthropic-messages-compat-proxy'));
  assert.ok(waitHelper.includes('anthropic-messages-proxy@${INSTANCE_NAME}'));

  console.log('\nAll anthropic docs smoke checks passed.');
}

main();
