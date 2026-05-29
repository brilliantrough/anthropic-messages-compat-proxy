import assert from 'node:assert/strict';

import {
  extractAnthropicUsageFromPayload,
  isAnthropicStreamEventWithUsableContent,
  parseSse,
  synthesizeAnthropicMessageFromEvents,
} from '../src/anthropic-sse.js';

// NEW imports that should exist after Task 4:
import {
  normalizeAnthropicStreamEvent,
  makeAnthropicStreamError,
  extractAnthropicUsageFromStreamPayload,
  hasAnthropicStreamUsage,
} from '../src/anthropic-sse.js';

import { getAnthropicFallbackReason } from '../src/anthropic-errors.js';

function main() {
  // --- Test: normalizeAnthropicStreamEvent rewrites model in message_start ---
  const messageStartEvent = {
    event: 'message_start',
    data: JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'upstream-internal-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  };

  const normalized = normalizeAnthropicStreamEvent(messageStartEvent, 'client-requested-alias');
  const normalizedPayload = JSON.parse(normalized.data);
  assert.equal(normalizedPayload.message.model, 'client-requested-alias', 'normalized mode should rewrite model in message_start');

  // --- Test: normalizeAnthropicStreamEvent leaves non-message events alone ---
  const deltaEvent = {
    event: 'content_block_delta',
    data: JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    }),
  };
  const normalizedDelta = normalizeAnthropicStreamEvent(deltaEvent, 'client-requested-alias');
  assert.equal(normalizedDelta.data, deltaEvent.data, 'non-message events should not be modified');

  // --- Test: makeAnthropicStreamError produces correct SSE error payload ---
  const errorEvent = makeAnthropicStreamError('Upstream provider failed', 'server_error');
  const errorPayload = JSON.parse(errorEvent.data);
  assert.equal(errorEvent.event, 'error');
  assert.equal(errorPayload.type, 'error');
  assert.equal(errorPayload.error.type, 'server_error');
  assert.equal(errorPayload.error.message, 'Upstream provider failed');

  // --- Test: extractAnthropicUsageFromStreamPayload extracts from message_start ---
  const messageStartPayload = JSON.parse(messageStartEvent.data);
  const startUsage = extractAnthropicUsageFromStreamPayload(messageStartPayload);
  assert.ok(startUsage, 'should extract usage from message_start');
  assert.equal(startUsage!.inputTokens, 10);
  assert.equal(startUsage!.outputTokens, 1);

  // --- Test: extractAnthropicUsageFromStreamPayload extracts cumulative from message_delta ---
  const messageDeltaPayload = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 42 },
  };
  const deltaUsage = extractAnthropicUsageFromStreamPayload(messageDeltaPayload);
  assert.ok(deltaUsage, 'should extract usage from message_delta');
  assert.equal(deltaUsage!.outputTokens, 42);

  // --- Test: hasAnthropicStreamUsage returns true when events contain usage ---
  const events = parseSse([
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_u","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
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

  assert.equal(hasAnthropicStreamUsage(events), true, 'events with message_delta.usage should return true');

  // --- Test: usable content covers thinking_delta ---
  const thinkingEvent = {
    event: 'content_block_delta',
    data: JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me think...' },
    }),
  };
  assert.equal(isAnthropicStreamEventWithUsableContent(thinkingEvent), true, 'thinking_delta should be usable content');

  // --- Test: usable content covers signature_delta ---
  const signatureEvent = {
    event: 'content_block_delta',
    data: JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'abc123' },
    }),
  };
  assert.equal(isAnthropicStreamEventWithUsableContent(signatureEvent), true, 'signature_delta should be usable content');

  // --- Test: usable content covers tool_use content_block_start ---
  const toolUseStart = {
    event: 'content_block_start',
    data: JSON.stringify({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    }),
  };
  assert.equal(isAnthropicStreamEventWithUsableContent(toolUseStart), true, 'tool_use block start should be usable content');

  // --- Test: getAnthropicFallbackReason handles 401 ---
  assert.equal(getAnthropicFallbackReason(401), 'compat_4xx', '401 should trigger compat_4xx fallback');

  // --- Test: getAnthropicFallbackReason handles 403 ---
  assert.equal(getAnthropicFallbackReason(403), 'compat_4xx', '403 should trigger compat_4xx fallback');

  // --- Test: getAnthropicFallbackReason handles other 4xx aggressively ---
  assert.ok(getAnthropicFallbackReason(400) !== undefined, '400 should trigger fallback (aggressive policy)');

  // --- Test: cache_creation_input_tokens extraction ---
  assert.deepEqual(
    extractAnthropicUsageFromPayload(
      {
        type: 'message_start',
        message: {
          id: 'msg_c',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'm',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 0, cache_creation_input_tokens: 8, cache_read_input_tokens: 12 },
        },
      },
      'client-model',
    ),
    {
      messageId: 'msg_c',
      model: 'client-model',
      inputTokens: 20,
      outputTokens: 0,
      cacheCreationInputTokens: 8,
      cacheReadInputTokens: 12,
    },
    'should extract cache_creation_input_tokens',
  );

  console.log('Anthropic SSE parity checks passed.');
}

main();
