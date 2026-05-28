import assert from 'node:assert/strict';

import { normalizeAnthropicMessageRequest } from '../src/anthropic-input-normalization.js';

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
      defaultModel: 'claude-sonnet-4-5',
      modelMappings: {
        'public-claude': 'claude-sonnet-4-5',
      },
      claudeBillingHeaderMode: 'strip_line',
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
      defaultModel: 'claude-haiku-4-5',
      modelMappings: {},
      claudeBillingHeaderMode: 'strip_line',
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
      defaultModel: 'claude-sonnet-4-5',
      modelMappings: {},
      claudeBillingHeaderMode: 'strip_cch',
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

  console.log('Anthropic input normalization checks passed.');
}

main();
