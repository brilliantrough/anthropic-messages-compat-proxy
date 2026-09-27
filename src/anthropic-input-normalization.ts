import {
  isJsonRecord,
  sanitizeClaudeBillingHeaderText,
  type ClaudeBillingHeaderMode,
  type JsonRecord,
  type JsonValue,
} from './responses-input-normalization.js';

export type CacheControlMode = 'off' | 'standardize';

export type NormalizeAnthropicMessageRequestOptions = {
  canonicalModel: string;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
  cacheControlMode: CacheControlMode;
  cacheControlTtl: string;
};

function sanitizeSystemValue(value: JsonValue | undefined, mode: ClaudeBillingHeaderMode): JsonValue | undefined {
  if (typeof value === 'string') {
    return sanitizeClaudeBillingHeaderText(value, mode);
  }

  if (!Array.isArray(value)) {
    if (!isJsonRecord(value) || typeof value.text !== 'string') {
      return value;
    }

    return {
      ...value,
      text: sanitizeClaudeBillingHeaderText(value.text, mode),
    };
  }

  return value.map(part => {
    if (!isJsonRecord(part) || typeof part.text !== 'string') {
      return part;
    }

    return {
      ...part,
      text: sanitizeClaudeBillingHeaderText(part.text, mode),
    };
  });
}

function stripCacheControl(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stripCacheControl);
  }
  if (!isJsonRecord(value)) {
    return value;
  }
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'cache_control') continue;
    out[key] = stripCacheControl(entry);
  }
  return out;
}

// Mirrors claude_cache_proxy's "standardize" policy: drop every cache_control the client
// placed (system, messages, tools, ...), then mark the last content block of the last
// message as the single ephemeral breakpoint.
function standardizeCacheControl(body: JsonRecord, ttl: string): JsonRecord {
  const stripped = stripCacheControl(body) as JsonRecord;
  const messages = stripped.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !isJsonRecord(messages[messages.length - 1])) {
    return stripped;
  }
  const marker = { type: 'ephemeral', ttl };
  const last = messages[messages.length - 1] as JsonRecord;
  let content: JsonValue;
  if (typeof last.content === 'string') {
    content = [{ type: 'text', text: last.content, cache_control: marker }];
  } else if (Array.isArray(last.content) && last.content.length > 0 && isJsonRecord(last.content[last.content.length - 1])) {
    content = [...last.content.slice(0, -1), { ...(last.content[last.content.length - 1] as JsonRecord), cache_control: marker }];
  } else {
    content = [{ type: 'text', text: '', cache_control: marker }];
  }
  return { ...stripped, messages: [...messages.slice(0, -1), { ...last, content }] };
}

export function normalizeAnthropicMessageRequest(
  body: JsonRecord,
  options: NormalizeAnthropicMessageRequestOptions,
): JsonRecord {
  const { proxy_stream_mode: _proxyStreamMode, ...rest } = body;
  const system = sanitizeSystemValue(rest.system, options.claudeBillingHeaderMode);

  const normalized: JsonRecord = {
    ...rest,
    model: options.canonicalModel,
    ...(rest.system === undefined ? {} : { system }),
  };
  return options.cacheControlMode === 'standardize' ? standardizeCacheControl(normalized, options.cacheControlTtl) : normalized;
}
