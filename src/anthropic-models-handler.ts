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
import { readTextWithTimeout } from './anthropic-messages-handler.js';

export async function handleModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    requestId: string;
    primaryEndpoint: UpstreamEndpoint;
    anthropicVersion: string;
    anthropicBeta: string | undefined;
    modelMappings: Record<string, string>;
    firstByteTimeoutMs: number;
    upstreamTimeoutMs: number;
    logRequest: (message: string, extra?: Record<string, unknown>) => void;
    finish: (statusCode: number, note: string, extra?: Record<string, unknown>) => void;
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
  options.logRequest('forwarding models request', {
    upstreamName: options.primaryEndpoint.name,
    modelsUrl,
    connectMs: options.upstreamTimeoutMs,
    firstByteMs: options.firstByteTimeoutMs,
  });

  const controller = new AbortController();
  const onClientClose = () => {
    if (!controller.signal.aborted) {
      controller.abort({ kind: 'client_disconnect', source: 'request' });
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort({ kind: 'client_disconnect', source: 'response' });
    }
  };
  req.on('close', onClientClose);
  res.on('close', onResponseClose);

  const connectTimeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort({ kind: 'timeout', phase: 'connect' });
    }
  }, options.upstreamTimeoutMs);

  try {
    const upstreamResponse = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(connectTimeout);

    const upstreamText = await readTextWithTimeout(upstreamResponse, controller, options.firstByteTimeoutMs);

    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      options.finish(502, 'invalid models json', {
        upstreamName: options.primaryEndpoint.name,
        upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
      });
      sendJson(res, 502, makeAnthropicError('api_error', 'Upstream models endpoint returned invalid JSON'));
      return;
    }

    if (!upstreamResponse.ok) {
      options.finish(upstreamResponse.status, 'models upstream error', {
        upstreamStatus: upstreamResponse.status,
        upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
        upstreamName: options.primaryEndpoint.name,
      });
      sendJson(res, upstreamResponse.status, payload as JsonValue);
      return;
    }

    options.finish(upstreamResponse.status, 'models json returned', {
      upstreamStatus: upstreamResponse.status,
      upstreamContentType: upstreamResponse.headers.get('content-type') ?? '',
      upstreamName: options.primaryEndpoint.name,
      aliasCount: upstreamResponse.ok && payload && typeof payload === 'object' ? Object.keys(options.modelMappings).length : 0,
    });
    sendJson(
      res,
      upstreamResponse.status,
      (upstreamResponse.ok ? applyModelMappingsToModelsPayload(payload, options.modelMappings) : payload) as JsonValue,
    );
  } catch (error) {
    const reason = controller.signal.reason as { kind?: string; phase?: string; source?: string } | undefined;
    if (reason?.kind === 'client_disconnect') {
      options.finish(499, reason.source === 'response' ? 'models response cancelled by client' : 'models request cancelled by client', {
        upstreamName: options.primaryEndpoint.name,
        source: reason.source ?? 'request',
      });
      return;
    }
    if (reason?.kind === 'timeout' && reason.phase === 'connect') {
      options.finish(504, 'models upstream timeout', {
        phase: reason.phase,
        upstreamName: options.primaryEndpoint.name,
      });
      sendJson(res, 504, makeAnthropicError('api_error', `Models upstream timeout: ${reason.phase}`));
      return;
    }
    if (reason?.kind === 'timeout' && (reason.phase === 'first-byte' || reason.phase === 'idle')) {
      options.finish(504, 'models response body timeout', {
        phase: reason.phase,
        upstreamName: options.primaryEndpoint.name,
      });
      sendJson(res, 504, makeAnthropicError('api_error', `Models response body timeout: ${reason.phase}`));
      return;
    }
    throw error;
  } finally {
    clearTimeout(connectTimeout);
    req.removeListener('close', onClientClose);
    res.removeListener('close', onResponseClose);
  }
}
