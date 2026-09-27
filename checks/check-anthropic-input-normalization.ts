import assert from 'node:assert/strict';

import { normalizeAnthropicMessageRequest } from '../src/anthropic-input-normalization.js';

const off = { canonicalModel: 'claude-sonnet-4-5', claudeBillingHeaderMode: 'strip_line' as const, cacheControlMode: 'off' as const, cacheControlTtl: '5m' };
const standardize = { ...off, cacheControlMode: 'standardize' as const, cacheControlTtl: '1h' };

function main() {
  const normalized = normalizeAnthropicMessageRequest(
    {
      model: 'public-claude',
      system: 'x-anthropic-billing-header: cc_version=2.1.119; cch=dynamic-1;\n\nStable system prompt',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Prior answer',
            },
          ],
        },
      ],
      proxy_stream_mode: 'normalized',
    },
    {
      canonicalModel: 'claude-sonnet-4-5',
      claudeBillingHeaderMode: 'strip_line',
      cacheControlMode: 'off',
      cacheControlTtl: '5m',
    },
  );

  assert.deepEqual(normalized, {
    model: 'claude-sonnet-4-5',
    system: 'Stable system prompt',
    messages: [
      {
        role: 'user',
        content: 'Hello',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Prior answer',
          },
        ],
      },
    ],
  });

  const defaulted = normalizeAnthropicMessageRequest(
    {
      messages: [{ role: 'user', content: 'Hi' }],
    },
    {
      canonicalModel: 'claude-haiku-4-5',
      claudeBillingHeaderMode: 'strip_line',
      cacheControlMode: 'off',
      cacheControlTtl: '5m',
    },
  );

  assert.equal(defaulted.model, 'claude-haiku-4-5');
  assert.deepEqual(defaulted.messages, [{ role: 'user', content: 'Hi' }]);

  const stripCch = normalizeAnthropicMessageRequest(
    {
      model: 'claude-opus-4-5',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.119; cch=dynamic-2;\nStable system',
        },
      ],
      messages: [
        {
          role: 'user',
          content: 'x-anthropic-billing-header: cch=user-value;\nKeep user text intact',
        },
      ],
    },
    {
      canonicalModel: 'claude-opus-4-5',
      claudeBillingHeaderMode: 'strip_cch',
      cacheControlMode: 'off',
      cacheControlTtl: '5m',
    },
  );

  assert.deepEqual(stripCch.system, [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.119;\nStable system',
    },
  ]);
  assert.deepEqual(stripCch.messages, [
    {
      role: 'user',
      content: 'x-anthropic-billing-header: cch=user-value;\nKeep user text intact',
    },
  ]);

  const aliased = normalizeAnthropicMessageRequest(
    { model: 'public-claude', messages: [{ role: 'user', content: 'Hi' }] },
    off,
  );
  assert.equal(aliased.model, 'claude-sonnet-4-5', 'aliases are resolved before the body is forwarded');

  // off: client-placed cache_control passes through untouched.
  const passthrough = normalizeAnthropicMessageRequest(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'done' },
      ],
    },
    off,
  );
  assert.deepEqual(
    (passthrough.messages as { content: unknown[] }[])[0].content,
    [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }],
  );

  // standardize: every client cache_control is stripped, one ephemeral breakpoint lands on
  // the last content block of the last message, with the configured ttl.
  const standardized = normalizeAnthropicMessageRequest(
    {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 't', description: 'd', input_schema: {}, cache_control: { type: 'ephemeral', ttl: '5m' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'early', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'final string turn' },
      ],
    },
    standardize,
  );
  assert.deepEqual(standardized.system, [{ type: 'text', text: 'sys' }]);
  assert.deepEqual(standardized.tools, [{ name: 't', description: 'd', input_schema: {} }]);
  assert.deepEqual((standardized.messages as JsonRecord[])[0].content, [{ type: 'text', text: 'early' }]);
  assert.deepEqual((standardized.messages as JsonRecord[])[1].content, 'ok');
  assert.deepEqual((standardized.messages as JsonRecord[])[2].content, [
    { type: 'text', text: 'final string turn', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);

  // standardize with list content: marker lands on the last existing block, not a new one.
  const listTail = normalizeAnthropicMessageRequest(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'r' },
            { type: 'text', text: 'tail' },
          ],
        },
      ],
    },
    standardize,
  );
  assert.deepEqual((listTail.messages as JsonRecord[])[0].content, [
    { type: 'tool_result', tool_use_id: 't1', content: 'r' },
    { type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);

  console.log('Anthropic input normalization checks passed.');
}

main();
