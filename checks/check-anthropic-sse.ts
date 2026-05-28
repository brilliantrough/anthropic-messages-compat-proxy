import assert from 'node:assert/strict';

import {
  extractAnthropicUsageFromPayload,
  getAnthropicStreamTextDeltaLength,
  isAnthropicMessageEventStream,
  parseSse,
  synthesizeAnthropicMessageFromEvents,
} from '../src/anthropic-sse.js';

function main() {
  const events = parseSse([
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"provider-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":4}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\\"location\\\":"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\\"SF\\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n'));

  assert.equal(isAnthropicMessageEventStream(events), true);
  assert.equal(getAnthropicStreamTextDeltaLength(JSON.parse(events[2].data)), 3);
  assert.equal(getAnthropicStreamTextDeltaLength(JSON.parse(events[3].data)), 2);

  const synthesized = synthesizeAnthropicMessageFromEvents(events, 'public-claude');
  assert.ok(synthesized);
  assert.equal(synthesized.id, 'msg_1');
  assert.equal(synthesized.model, 'public-claude');
  assert.equal(synthesized.stop_reason, 'tool_use');
  assert.deepEqual(synthesized.content, [
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'SF' } },
  ]);

  assert.deepEqual(extractAnthropicUsageFromPayload(JSON.parse(events[0].data), 'public-claude'), {
    messageId: 'msg_1',
    model: 'public-claude',
    inputTokens: 10,
    outputTokens: 1,
    cacheReadInputTokens: 4,
  });

  assert.deepEqual(extractAnthropicUsageFromPayload(JSON.parse(events[9].data), 'public-claude'), {
    model: 'public-claude',
    outputTokens: 12,
  });

  const noise = parseSse('event: response.created\ndata: {"type":"response.created"}\n\n');
  assert.equal(isAnthropicMessageEventStream(noise), false);
  assert.equal(synthesizeAnthropicMessageFromEvents(noise, 'public-claude'), undefined);

  console.log('Anthropic SSE checks passed.');
}

main();
