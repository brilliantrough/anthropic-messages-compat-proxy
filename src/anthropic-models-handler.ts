import type { IncomingMessage, ServerResponse } from 'node:http';
import { listConfiguredModelEntries } from './model-router.js';
import type { RoutingConfig } from './routing-config.js';
import { makeAnthropicError, sendJson } from './anthropic-http-utils.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

export function handleModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    requestId: string;
    routingConfig: RoutingConfig;
    logRequest: (message: string, extra?: Record<string, unknown>) => void;
    finish: (statusCode: number, note: string, extra?: Record<string, unknown>) => void;
  },
) {
  const entries = listConfiguredModelEntries(options.routingConfig);
  const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  const afterId = params.get('after_id');
  const beforeId = params.get('before_id');

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    options.finish(400, 'models request rejected: invalid limit', { limit: rawLimit });
    sendJson(res, 400, makeAnthropicError('invalid_request_error', `limit must be an integer between 1 and ${MAX_LIMIT}`));
    return;
  }

  let start = 0;
  let end = entries.length;
  if (afterId !== null) {
    const index = entries.findIndex(entry => entry.id === afterId);
    if (index < 0) {
      options.finish(400, 'models request rejected: unknown after_id', { afterId });
      sendJson(res, 400, makeAnthropicError('invalid_request_error', `after_id '${afterId}' is not a configured model`));
      return;
    }
    start = index + 1;
  }
  if (beforeId !== null) {
    const index = entries.findIndex(entry => entry.id === beforeId);
    if (index < 0) {
      options.finish(400, 'models request rejected: unknown before_id', { beforeId });
      sendJson(res, 400, makeAnthropicError('invalid_request_error', `before_id '${beforeId}' is not a configured model`));
      return;
    }
    end = index;
  }

  const page = start >= end ? [] : entries.slice(start, Math.min(end, start + limit));
  options.finish(200, 'configured models returned', {
    configuredModels: entries.length,
    returned: page.length,
    hasMore: start + page.length < end,
  });
  sendJson(res, 200, {
    data: page,
    first_id: page[0]?.id ?? null,
    last_id: page[page.length - 1]?.id ?? null,
    has_more: start + page.length < end,
  });
}
