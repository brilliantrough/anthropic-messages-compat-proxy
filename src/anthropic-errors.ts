import { isJsonRecord, type JsonRecord } from './responses-input-normalization.js';

export type AnthropicFallbackReason =
  | 'upstream_5xx'
  | 'retryable_4xx'
  | 'compat_4xx'
  | 'connect_error'
  | 'connect_timeout'
  | 'body_timeout'
  | 'headers_only_timeout'
  | 'stream_no_text_content'
  | 'stream_missing_usage'
  | 'empty_response'
  | 'sse_reconstruction_failure'
  | 'proxy_unhandled_error'
  | 'unknown_upstream_error';

export function getAnthropicFallbackReason(
  status: number,
  payload?: unknown,
  options?: {
    fallbackOnRetryable4xx: boolean;
    fallbackOnCompat4xx: boolean;
    compatFallbackPatterns: string[];
    clientErrorPatterns: string[];
  },
): AnthropicFallbackReason | undefined {
  const message = extractErrorMessage(payload)?.toLowerCase();
  const wrappedStatus = message ? extractWrappedUpstreamStatus(message) : undefined;

  if (status >= 500) {
    return 'upstream_5xx';
  }

  if (typeof wrappedStatus === 'number') {
    if (wrappedStatus >= 500) {
      return 'upstream_5xx';
    }
    if (options?.fallbackOnRetryable4xx && [408, 409, 423, 425, 429].includes(wrappedStatus)) {
      return 'retryable_4xx';
    }
    if (wrappedStatus >= 400 && wrappedStatus < 500) {
      return 'compat_4xx';
    }
  }

  if (status >= 400 && status < 500) {
    if (options?.fallbackOnRetryable4xx && [408, 409, 423, 425, 429].includes(status)) {
      return 'retryable_4xx';
    }

    if ([401, 403].includes(status)) {
      return 'compat_4xx';
    }

    if (options && matchesAnyPattern(message, options.clientErrorPatterns)) {
      return undefined;
    }

    if (options && !options.fallbackOnCompat4xx) {
      return undefined;
    }

    if (options && matchesAnyPattern(message, options.compatFallbackPatterns)) {
      return 'compat_4xx';
    }

    return 'compat_4xx';
  }

  return undefined;
}

export function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isJsonRecord(payload)) {
    return undefined;
  }

  if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
    return payload.message.trim();
  }

  if (typeof payload.detail === 'string' && payload.detail.trim().length > 0) {
    return payload.detail.trim();
  }

  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return payload.error.trim();
  }

  if (isJsonRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim().length > 0) {
    return payload.error.message.trim();
  }

  if (isJsonRecord(payload.response)) {
    return extractErrorMessage(payload.response);
  }

  return undefined;
}

function extractWrappedUpstreamStatus(message: string) {
  const match = message.match(/all\s+\d+\s+attempts\s+failed:\s+http\s+(\d{3})\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function matchesAnyPattern(message: string | undefined, patterns: string[]) {
  if (!message) {
    return false;
  }

  return patterns.some(pattern => pattern.length > 0 && message.includes(pattern));
}

export function isQuotaLikeCompatError(status: number, payload: unknown): boolean {
  if (status !== 403) {
    return false;
  }

  const message = extractErrorMessage(payload)?.toLowerCase();
  if (!message) {
    return false;
  }

  return [
    '不允许使用余额',
    '无可用套餐',
    '令牌权限',
    'token permission',
    'insufficient balance',
    'no available package',
    'daily quota exceeded',
    'quota exhausted',
    'credit exhausted',
    'billing required',
    'disallowed ip address',
    'local or disallowed ip address',
    'dns records resolve to a local',
    'dns resolution failed',
    'dns lookup failed',
    'upstream unavailable',
    'origin unreachable',
    'host unreachable',
  ].some(pattern => message.includes(pattern));
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
