import {
  isJsonRecord,
  sanitizeClaudeBillingHeaderText,
  type ClaudeBillingHeaderMode,
  type JsonRecord,
  type JsonValue,
} from './responses-input-normalization.js';

export type NormalizeAnthropicMessageRequestOptions = {
  defaultModel: string;
  modelMappings: Record<string, string>;
  claudeBillingHeaderMode: ClaudeBillingHeaderMode;
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

export function normalizeAnthropicMessageRequest(
  body: JsonRecord,
  options: NormalizeAnthropicMessageRequestOptions,
): JsonRecord {
  const { proxy_stream_mode: _proxyStreamMode, ...rest } = body;
  const requestedModel = typeof rest.model === 'string' && rest.model.trim().length > 0
    ? rest.model
    : options.defaultModel;
  const mappedModel = options.modelMappings[requestedModel] ?? requestedModel;
  const system = sanitizeSystemValue(rest.system, options.claudeBillingHeaderMode);

  return {
    ...rest,
    model: mappedModel,
    ...(rest.system === undefined ? {} : { system }),
  };
}
