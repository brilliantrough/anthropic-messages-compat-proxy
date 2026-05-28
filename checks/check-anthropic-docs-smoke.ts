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

  console.log('\nAll anthropic docs smoke checks passed.');
}

main();
