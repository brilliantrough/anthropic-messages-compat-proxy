import { isJsonRecord } from './responses-input-normalization.js';

export type AnthropicFallbackReason =
  | 'upstream_5xx'
  | 'retryable_4xx'
  | 'connect_error'
  | 'empty_response'
  | 'stream_no_usable_content'
  | 'unknown_upstream_error';

export function getAnthropicFallbackReason(
  status: number,
): AnthropicFallbackReason | undefined {
  if (status >= 500) {
    return 'upstream_5xx';
  }

  if ([408, 429].includes(status)) {
    return 'retryable_4xx';
  }

  return undefined;
}

export function isAnthropicMessageWithUsableContent(payload: unknown): boolean {
  if (!isJsonRecord(payload)) {
    return false;
  }

  if (!Array.isArray(payload.content)) {
    return false;
  }

  for (const block of payload.content) {
    if (!isJsonRecord(block)) {
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return true;
    }

    if (block.type === 'tool_use') {
      return true;
    }

    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
      return true;
    }
  }

  return false;
}
