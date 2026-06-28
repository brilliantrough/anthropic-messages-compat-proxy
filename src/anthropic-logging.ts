import {
  isJsonRecord,
  sanitizeClaudeBillingHeaderMessageContent,
  sanitizeClaudeBillingHeaderText,
  type ClaudeBillingHeaderMode,
  type JsonRecord,
  type JsonValue,
} from './responses-input-normalization.js';

let requestCounter = 0;

const SENSITIVE_STRING_KEYS = new Set(['text', 'content', 'system', 'input', 'instructions']);
const SAFE_SSE_STRING_KEYS = new Set(['type', 'id', 'model', 'role', 'stop_reason', 'stop_sequence']);

export function createRequestId() {
  requestCounter += 1;
  return `r${requestCounter}`;
}

export function logRequest(requestId: string, message: string, extra?: Record<string, unknown>) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${requestId}] ${message}${suffix}`);
}

export function sanitizeForLog(value: JsonValue, maxStringLength = 1200): JsonValue {
  if (typeof value === 'string') {
    if (value.length <= maxStringLength) {
      return value;
    }
    return `${value.slice(0, maxStringLength)}...[truncated ${value.length - maxStringLength} chars]`;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLog(item, maxStringLength));
  }

  if (!isJsonRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, sanitizeForLog(entryValue, maxStringLength)]),
  );
}

function redactString(value: string) {
  return `[redacted ${value.length} chars]`;
}

function sanitizeSensitiveValue(value: JsonValue, parentKey?: string, inheritedSensitive = false): JsonValue {
  const nextSensitive = inheritedSensitive || (parentKey ? SENSITIVE_STRING_KEYS.has(parentKey) : false);

  if (typeof value === 'string') {
    if (nextSensitive) {
      return redactString(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeSensitiveValue(item, parentKey, nextSensitive));
  }

  if (!isJsonRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, sanitizeSensitiveValue(entryValue, key, nextSensitive)]),
  );
}

function sanitizeSseEventData(data: string) {
  try {
    const parsed = JSON.parse(data) as JsonValue;
    const sanitizeSseValue = (value: JsonValue, parentKey?: string): JsonValue => {
      if (typeof value === 'string') {
        if (parentKey && SAFE_SSE_STRING_KEYS.has(parentKey)) {
          return value;
        }
        return redactString(value);
      }

      if (Array.isArray(value)) {
        return value.map(item => sanitizeSseValue(item, parentKey));
      }

      if (!isJsonRecord(value)) {
        return value;
      }

      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [key, sanitizeSseValue(entryValue, key)]),
      );
    };

    return JSON.stringify(sanitizeSseValue(parsed));
  } catch {
    return '[redacted non-json event data]';
  }
}

function sanitizeSseTextForDebug(upstreamText: string) {
  return upstreamText
    .split(/\r?\n\r?\n/)
    .map(block => {
      if (block.trim().length === 0) {
        return block;
      }

      const lines = block.split(/\r?\n/);
      const dataLines = lines.filter(line => line.startsWith('data:'));
      if (dataLines.length === 0) {
        return block;
      }

      const sanitizedData = sanitizeSseEventData(dataLines.map(line => line.slice(5).trimStart()).join('\n'));
      let replaced = false;
      return lines
        .filter(line => {
          if (!line.startsWith('data:')) {
            return true;
          }
          if (replaced) {
            return false;
          }
          replaced = true;
          return true;
        })
        .map(line => (line.startsWith('data:') ? `data: ${sanitizedData}` : line))
        .join('\n');
    })
    .join('\n\n');
}

function sanitizeAnthropicRequestBodyForLog(body: JsonRecord, mode: ClaudeBillingHeaderMode): JsonRecord {
  const sanitized: JsonRecord = { ...body };

  if (typeof sanitized.system === 'string') {
    sanitized.system = sanitizeClaudeBillingHeaderText(sanitized.system, mode);
  } else if (isJsonRecord(sanitized.system) && typeof sanitized.system.text === 'string') {
    sanitized.system = {
      ...sanitized.system,
      text: sanitizeClaudeBillingHeaderText(sanitized.system.text, mode),
    };
  } else if (Array.isArray(sanitized.system)) {
    sanitized.system = sanitized.system.map(part => {
      if (!isJsonRecord(part) || typeof part.text !== 'string') {
        return part;
      }
      return {
        ...part,
        text: sanitizeClaudeBillingHeaderText(part.text, mode),
      };
    });
  }

  if (Array.isArray(sanitized.messages)) {
    sanitized.messages = sanitized.messages.map(item => {
      if (!isJsonRecord(item) || typeof item.role !== 'string' || item.content === undefined) {
        return item;
      }
      return {
        ...item,
        content: sanitizeClaudeBillingHeaderMessageContent(item.role, item.content, mode),
      };
    });
  }

  return sanitized;
}

function sanitizeRequestPreviewValue(value: JsonValue, parentKey?: string): JsonValue {
  if (typeof value === 'string') {
    if (parentKey === 'type' || parentKey === 'role' || parentKey === 'model') {
      return value;
    }
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeRequestPreviewValue(item, parentKey));
  }

  if (!isJsonRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, sanitizeRequestPreviewValue(entryValue, key)]),
  );
}

export function logRequestBodiesPreview(
  requestId: string,
  requestBody: JsonRecord,
  upstreamBody: JsonRecord,
  options: { enabled: boolean; claudeBillingHeaderMode: ClaudeBillingHeaderMode },
) {
  if (!options.enabled) {
    return;
  }

  logRequest(requestId, 'request body preview', {
    requestBody: sanitizeForLog(sanitizeRequestPreviewValue(sanitizeSensitiveValue(sanitizeAnthropicRequestBodyForLog(requestBody, options.claudeBillingHeaderMode)))),
    upstreamBody: sanitizeForLog(sanitizeRequestPreviewValue(sanitizeSensitiveValue(upstreamBody))),
  });
}

export function logSseDebug(
  requestId: string,
  events: Array<{ event: string; data: string }>,
  enabled: boolean,
) {
  if (!enabled) {
    return;
  }

  const preview = events.slice(0, 8).map(item => ({
    event: item.event,
    dataPreview: sanitizeSseEventData(item.data).slice(0, 240),
  }));

  logRequest(requestId, 'sse debug preview', {
    eventCount: events.length,
    preview,
  });
}

export async function writeSseFailureDebug(
  requestId: string,
  upstreamContentType: string,
  upstreamStatus: number,
  upstreamText: string,
  options: { enabled: boolean; dir: string },
) {
  if (!options.enabled) {
    return;
  }

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(options.dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileBase = `${timestamp}_${requestId}_status${upstreamStatus}`;

    await fs.writeFile(
      path.join(options.dir, `${fileBase}.json`),
      JSON.stringify({
        requestId,
        upstreamContentType,
        upstreamStatus,
        createdAt: new Date().toISOString(),
      }, null, 2),
      'utf8',
    );
    await fs.writeFile(path.join(options.dir, `${fileBase}.sse.txt`), sanitizeSseTextForDebug(upstreamText), 'utf8');
  } catch (error) {
    logRequest(requestId, 'failed to write SSE failure debug files', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
}

export async function writeStreamMissingUsageDebug(
  requestId: string,
  upstreamStatus: number,
  streamMode: string,
  chunkCount: number,
  totalBytes: number,
  streamEventCount: number,
  upstreamText: string,
  options: { enabled: boolean; dir: string },
) {
  if (!options.enabled) {
    return;
  }

  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(options.dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileBase = `${timestamp}_${requestId}_status${upstreamStatus}`;

    await fs.writeFile(
      path.join(options.dir, `${fileBase}.json`),
      JSON.stringify({
        requestId,
        upstreamStatus,
        streamMode,
        chunkCount,
        totalBytes,
        streamEventCount,
        createdAt: new Date().toISOString(),
      }, null, 2),
      'utf8',
    );
    await fs.writeFile(path.join(options.dir, `${fileBase}.sse.txt`), sanitizeSseTextForDebug(upstreamText), 'utf8');
  } catch (error) {
    logRequest(requestId, 'failed to write stream missing usage debug files', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
}
