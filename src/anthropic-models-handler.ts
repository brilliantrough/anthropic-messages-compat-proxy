import type { IncomingMessage, ServerResponse } from 'node:http';
import { type JsonValue } from './responses-input-normalization.js';
import type { UpstreamEndpoint } from './anthropic-config.js';
import {
  sendJson,
  makeAnthropicError,
  getOutboundHeaders,
  applyModelMappingsToModelsPayload,
  getModelsUrlFromEndpoint,
} from './anthropic-http-utils.js';

export async function handleModelsRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  options: {
    primaryEndpoint: UpstreamEndpoint;
    anthropicVersion: string;
    anthropicBeta: string | undefined;
    modelMappings: Record<string, string>;
  },
) {
  const headers = getOutboundHeaders(
    options.primaryEndpoint.apiKey,
    options.anthropicVersion,
    options.anthropicBeta,
    { 'anthropic-version': options.anthropicVersion },
  );

  delete headers['anthropic-beta'];

  if (options.anthropicBeta) {
    headers['anthropic-beta'] = options.anthropicBeta;
  }

  const modelsUrl = getModelsUrlFromEndpoint(options.primaryEndpoint);

  const upstreamResponse = await fetch(modelsUrl, {
    method: 'GET',
    headers,
  });

  const upstreamText = await upstreamResponse.text();
  let payload: unknown;
  try {
    payload = JSON.parse(upstreamText);
  } catch {
    sendJson(res, 502, makeAnthropicError('api_error', 'Upstream models endpoint returned invalid JSON'));
    return;
  }

  sendJson(
    res,
    upstreamResponse.status,
    (upstreamResponse.ok ? applyModelMappingsToModelsPayload(payload, options.modelMappings) : payload) as JsonValue,
  );
}
