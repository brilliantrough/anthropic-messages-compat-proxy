import { isJsonRecord, type JsonRecord } from './responses-input-normalization.js';

export type SseEvent = { event: string; data: string };

const anthropicEventTypes = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

export function parseSse(text: string) {
  const events: SseEvent[] = [];
  const chunks = text.split(/\r?\n\r?\n/);

  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }

    events.push(parseSseChunk(chunk));
  }

  return events;
}

export function parseSseChunk(chunk: string) {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return { event, data: dataLines.join('\n') };
}

export function formatSseEvent(event: SseEvent) {
  const lines = [`event: ${event.event}`];
  if (event.data.length === 0) {
    lines.push('data:');
  } else {
    for (const line of event.data.split('\n')) {
      lines.push(`data: ${line}`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

export function parseStreamPayload(data: string) {
  if (!data) {
    return undefined;
  }

  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function isAnthropicMessageEventStream(events: SseEvent[]) {
  return events.some(event => {
    if (anthropicEventTypes.has(event.event)) {
      return true;
    }

    const payload = parseStreamPayload(event.data);
    return isJsonRecord(payload) && typeof payload.type === 'string' && anthropicEventTypes.has(payload.type);
  });
}

export function getAnthropicStreamTextDeltaLength(payload: unknown) {
  if (!isJsonRecord(payload) || payload.type !== 'content_block_delta' || !isJsonRecord(payload.delta)) {
    return 0;
  }

  const delta = payload.delta;
  return delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text.length : 0;
}

function mapAnthropicUsage(usage: JsonRecord, model?: string, messageId?: string) {
  const mapped: JsonRecord = {};

  if (messageId) {
    mapped.messageId = messageId;
  }

  if (model) {
    mapped.model = model;
  }

  if (typeof usage.input_tokens === 'number') {
    mapped.inputTokens = usage.input_tokens;
  }

  if (typeof usage.output_tokens === 'number') {
    mapped.outputTokens = usage.output_tokens;
  }

  if (typeof usage.cache_creation_input_tokens === 'number') {
    mapped.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }

  if (typeof usage.cache_read_input_tokens === 'number') {
    mapped.cacheReadInputTokens = usage.cache_read_input_tokens;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function extractAnthropicUsageFromPayload(payload: unknown, requestedModel?: string) {
  if (!isJsonRecord(payload)) {
    return undefined;
  }

  if (isJsonRecord(payload.message) && isJsonRecord(payload.message.usage)) {
    return mapAnthropicUsage(
      payload.message.usage,
      requestedModel ?? (typeof payload.message.model === 'string' ? payload.message.model : undefined),
      typeof payload.message.id === 'string' ? payload.message.id : undefined,
    );
  }

  if (isJsonRecord(payload.usage)) {
    return mapAnthropicUsage(payload.usage, requestedModel);
  }

  return undefined;
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function ensureContentBlock(blocks: JsonRecord[], index: number, fallbackType: string) {
  const existing = blocks[index];
  if (existing) {
    return existing;
  }

  const created: JsonRecord = fallbackType === 'thinking'
    ? { type: 'thinking', thinking: '', signature: '' }
    : { type: fallbackType, text: '' };
  blocks[index] = created;
  return created;
}

export function synthesizeAnthropicMessageFromEvents(events: SseEvent[], requestedModel?: string) {
  if (!isAnthropicMessageEventStream(events)) {
    return undefined;
  }

  let message: JsonRecord | undefined;
  const contentBlocks: JsonRecord[] = [];
  const partialToolJson = new Map<number, string>();

  for (const event of events) {
    const payload = parseStreamPayload(event.data);
    if (!isJsonRecord(payload) || typeof payload.type !== 'string') {
      continue;
    }

    if (payload.type === 'message_start' && isJsonRecord(payload.message)) {
      message = cloneJsonRecord(payload.message);
      if (Array.isArray(message.content)) {
        message.content = [];
      }
      continue;
    }

    if (payload.type === 'content_block_start' && typeof payload.index === 'number' && isJsonRecord(payload.content_block)) {
      contentBlocks[payload.index] = cloneJsonRecord(payload.content_block);
      continue;
    }

    if (payload.type === 'content_block_delta' && typeof payload.index === 'number' && isJsonRecord(payload.delta)) {
      const delta = payload.delta;

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        const block = ensureContentBlock(contentBlocks, payload.index, 'text');
        block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        const block = ensureContentBlock(contentBlocks, payload.index, 'thinking');
        block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        const block = ensureContentBlock(contentBlocks, payload.index, 'thinking');
        block.signature = delta.signature;
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        partialToolJson.set(payload.index, `${partialToolJson.get(payload.index) ?? ''}${delta.partial_json}`);
      }

      continue;
    }

    if (payload.type === 'content_block_stop' && typeof payload.index === 'number') {
      const partialJson = partialToolJson.get(payload.index);
      const block = contentBlocks[payload.index];
      if (partialJson !== undefined && block) {
        try {
          block.input = JSON.parse(partialJson) as JsonRecord;
        } catch {
          block.input = {};
        }
      }
      continue;
    }

    if (payload.type === 'message_delta' && isJsonRecord(payload.delta)) {
      message = message ?? { type: 'message', role: 'assistant', content: [] };
      if ('stop_reason' in payload.delta) {
        message.stop_reason = payload.delta.stop_reason;
      }
      if ('stop_sequence' in payload.delta) {
        message.stop_sequence = payload.delta.stop_sequence;
      }
      if (isJsonRecord(payload.usage)) {
        message.usage = {
          ...(isJsonRecord(message.usage) ? message.usage : {}),
          ...payload.usage,
        };
      }
    }
  }

  if (!message) {
    return undefined;
  }

  return {
    ...message,
    type: typeof message.type === 'string' ? message.type : 'message',
    role: typeof message.role === 'string' ? message.role : 'assistant',
    model: requestedModel ?? message.model,
    content: contentBlocks.filter(Boolean),
  } as JsonRecord;
}
