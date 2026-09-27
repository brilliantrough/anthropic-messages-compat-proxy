import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createConfigFileStoreFromPaths,
  readForAdmin,
  applyAdminDraft,
  validateDraft,
  type AdminConfigDraft,
  type ConfigFileStore,
} from './config-files.js';
import type { RuntimeConfigStore } from './runtime-config.js';
import type { RoutingConfig } from './routing-config.js';
import type { HealthRegistry } from './channel-health.js';
import { parseUsageQuery, type createUsageStore } from './usage-store.js';
import { collectUptime, UPTIME_INTERVAL_MS, type UptimeSample } from './uptime.js';

export function isLocalhost(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

export function isAllowedAdminAccess(remoteAddress: string | undefined, allowHost: boolean): boolean {
  if (isLocalhost(remoteAddress)) return true;
  if (allowHost && remoteAddress) return true;
  return false;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    try { res.end(); } catch { /* best-effort */ }
    return;
  }
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function getRemoteAddress(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress;
}

// Only the fields the admin surface actually reads are required, so legacy and current
// runtime stores stay assignable without a shared concrete config type.
export type AdminRuntimeConfig = Readonly<{
  adminAllowHost: boolean;
  instanceName: string;
  routingConfigPath: string;
  routingConfig: RoutingConfig;
  healthWindowMs: number;
  healthFailureThreshold: number;
  healthFailureRateThreshold: number;
}>;

const USAGE_TOTAL_KEYS = [
  'attempts', 'success', 'failed', 'cancelled', 'interrupted', 'pending',
  'inputTokens', 'uncachedInputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'outputTokens', 'totalTokens',
  'cacheEligibleInput', 'cacheEligibleCached', 'durationMs',
] as const;

/** Rolls per-bucket rows up so the Usage page and the report share one definition of "total". */
function sumUsageTotals(rows: Array<Record<string, unknown>>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    for (const key of USAGE_TOTAL_KEYS) {
      const value = row[key];
      if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

export type AdminHandlerOptions = {
  configStore: ConfigFileStore;
  runtimeStore: RuntimeConfigStore<AdminRuntimeConfig>;
  getAdminStats?: () => unknown;
  healthRegistry?: HealthRegistry;
  usageStore?: ReturnType<typeof createUsageStore>;
};

function rollbackBakFiles(store: ConfigFileStore): string[] {
  const files = [store.envPath, store.fallbackPath];
  const restored: string[] = [];
  for (const filePath of files) {
    const bakPath = filePath + '.bak';
    if (existsSync(bakPath)) {
      renameSync(bakPath, filePath);
      restored.push(resolve(filePath));
    }
  }
  return restored;
}

function serveAdminStatic(res: ServerResponse, filename: string, contentType: string, subDir?: string) {
  const base = resolve(import.meta.dirname, '..', 'public', 'admin');
  const filePath = subDir ? resolve(base, subDir, filename) : resolve(base, filename);
  if (!filePath.startsWith(base)) {
    sendJson(res, 403, { error: { message: 'Forbidden', type: 'forbidden' } });
    return;
  }
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    return;
  }
  try {
    const data = readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  } catch {
    sendJson(res, 500, { error: { message: 'Failed to read static file', type: 'server_error' } });
  }
}

const STATIC_ASSETS: Record<string, string> = {
  'admin.js': 'application/javascript; charset=utf-8',
  'admin.css': 'text/css; charset=utf-8',
  'monitor.js': 'application/javascript; charset=utf-8',
  'monitor.css': 'text/css; charset=utf-8',
  'usage.js': 'application/javascript; charset=utf-8',
  'usage.css': 'text/css; charset=utf-8',
};

function currentConfigStore(baseStore: ConfigFileStore, runtimeStore: RuntimeConfigStore<AdminRuntimeConfig>): ConfigFileStore {
  const snapshot = runtimeStore.getSnapshot();
  return createConfigFileStoreFromPaths({
    envPath: baseStore.envPath,
    fallbackPath: snapshot.config.routingConfigPath,
    modelMapPath: baseStore.modelMapPath,
  });
}

export function createAdminHandler(options: AdminHandlerOptions) {
  const { configStore, runtimeStore } = options;
  return async function handleAdminRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const rawUrl = req.url ?? '';
    const method = req.method ?? '';
    const url = rawUrl.split(/[?#]/)[0];

    if (url !== '/admin' && !url.startsWith('/admin/')) return false;

    if (!isAllowedAdminAccess(getRemoteAddress(req), runtimeStore.getSnapshot().config.adminAllowHost)) {
      sendJson(res, 403, { error: { message: 'Admin endpoints are only accessible from localhost', type: 'forbidden' } });
      return true;
    }

    const store = currentConfigStore(configStore, runtimeStore);

    if (method === 'POST' && url === '/admin/channels/breaker') {
      let body: unknown;
      try { body = await readJsonBody(req); } catch {
        sendJson(res, 400, { ok: false, error: { message: 'Invalid JSON body' } });
        return true;
      }
      const request = body as Record<string, unknown> | null;
      if (!request || typeof request.channelId !== 'string' || typeof request.fingerprint !== 'string' ||
          (request.action !== 'open' && request.action !== 'close')) {
        sendJson(res, 400, { ok: false, error: { message: 'Expected channelId, fingerprint and action (open|close)' } });
        return true;
      }
      if (!options.healthRegistry) {
        sendJson(res, 501, { ok: false, error: { message: 'Breaker control unavailable' } });
        return true;
      }
      const channel = runtimeStore.getSnapshot().config.routingConfig.channelsById.get(request.channelId);
      if (!channel || channel.fingerprint !== request.fingerprint) {
        sendJson(res, 409, { ok: false, error: { message: 'Channel changed; refresh before controlling its breaker' } });
        return true;
      }
      options.healthRegistry.control(request.channelId, request.action);
      console.log(`admin breaker ${request.action}: ${JSON.stringify(request.channelId)}`);
      sendJson(res, 200, { ok: true, healthSnapshot: options.healthRegistry.snapshot() });
      return true;
    }

    if (method === 'GET' && url === '/admin/config') {
      try {
        const config = readForAdmin(store);
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          config,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' },
        });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/config/validate') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
        return true;
      }
      const validation = validateDraft(body);
      if (!validation.ok) {
        sendJson(res, 200, { ok: true, valid: false, errors: validation.errors });
      } else {
        const config = readForAdmin(store);
        sendJson(res, 200, { ok: true, valid: true, warnings: validation.warnings, config });
      }
      return true;
    }

    if (method === 'PUT' && url === '/admin/config') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
        return true;
      }
      const validation = validateDraft(body);
      if (!validation.ok) {
        sendJson(res, 400, {
          ok: false,
          error: { message: 'Validation failed', type: 'invalid_request_error' },
          errors: validation.errors,
        });
        return true;
      }
      try {
        const draft = body as AdminConfigDraft;
        applyAdminDraft(store, draft);
        const reloadResult = runtimeStore.reloadFromFiles();
        if (!reloadResult.ok) {
          sendJson(res, 500, {
            ok: false,
            error: { message: `Config saved but reload failed: ${reloadResult.error}`, type: 'server_error' },
          });
          return true;
        }
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'invalid_request_error' },
        });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/config/reload') {
      try {
        const reloadResult = runtimeStore.reloadFromFiles();
        if (!reloadResult.ok) {
          sendJson(res, 500, { ok: false, error: { message: reloadResult.error, type: 'server_error' } });
          return true;
        }
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' },
        });
      }
      return true;
    }

    if (method === 'POST' && url === '/admin/config/rollback') {
      try {
        const restored = rollbackBakFiles(store);
        if (restored.length === 0) {
          sendJson(res, 200, { ok: true, restored: [], message: 'No backup files found' });
          return true;
        }
        const reloadResult = runtimeStore.reloadFromFiles();
        if (!reloadResult.ok) {
          sendJson(res, 500, {
            ok: false,
            error: { message: `Rollback restored files but reload failed: ${reloadResult.error}`, type: 'server_error' },
            restored,
          });
          return true;
        }
        const snapshot = runtimeStore.getSnapshot();
        sendJson(res, 200, {
          ok: true,
          restored,
          runtimeVersion: snapshot.runtimeVersion,
          restartRequiredFields: snapshot.restartRequiredFields,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' },
        });
      }
      return true;
    }

    if (method === 'GET' && url === '/admin/uptime') {
      if (!options.usageStore || !options.healthRegistry) {
        sendJson(res, 501, { ok: false, error: { message: 'Uptime history unavailable' } });
        return true;
      }
      const routing = runtimeStore.getSnapshot().config.routingConfig;
      const params = new URL(rawUrl, 'http://localhost').searchParams;
      const model = params.get('model') ?? routing.defaultModel;
      const hours = Number(params.get('hours') ?? 24);
      const route = routing.modelRoutes.get(model);
      if (!route || ![6, 24, 72, 168].includes(hours)) {
        sendJson(res, 400, { ok: false, error: { message: 'Choose a configured canonical model and 6, 24, 72 or 168 hours' } });
        return true;
      }
      const to = Math.floor(Date.now() / UPTIME_INTERVAL_MS) * UPTIME_INTERVAL_MS + UPTIME_INTERVAL_MS;
      const from = to - hours * 3600000;
      try {
        const result = await options.usageStore.queryUptime({ from, to, model }) as { rows: UptimeSample[]; writeError: string | null };
        const active = (row: UptimeSample) => route.channelIds.includes(row.channelId) && routing.channelsById.get(row.channelId)?.fingerprint === row.fingerprint;
        sendJson(res, 200, {
          ok: true, from, to, intervalMs: UPTIME_INTERVAL_MS, model, hours,
          models: [...routing.modelRoutes.keys()],
          channels: route.channelIds.map(id => ({ id, name: routing.channelsById.get(id)?.name ?? id })),
          rows: result.rows.filter(active).map(({ fingerprint: _, ...row }) => row),
          current: collectUptime(runtimeStore, options.healthRegistry).filter(row => row.model === model && active(row)).map(({ fingerprint: _, ...row }) => row),
          writeError: result.writeError,
          generatedAt: Date.now(),
        });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return true;
    }

    if (method === 'GET' && url === '/admin/usage/stats') {
      const params = new URL(rawUrl, 'http://localhost').searchParams;
      if (!params.has('from') || !params.has('to')) {
        const hours = Number(params.get('hours') ?? 24);
        if (![6, 24, 72, 168].includes(hours)) {
          sendJson(res, 400, { ok: false, error: { message: 'hours must be one of 6, 24, 72 or 168 (or pass explicit from/to)' } });
          return true;
        }
        const now = Date.now();
        params.set('from', String(now - hours * 3_600_000));
        params.set('to', String(now));
        if (!params.has('bucket')) params.set('bucket', hours <= 48 ? 'hour' : 'day');
      }
      let query;
      try { query = parseUsageQuery(params); }
      catch (error) { sendJson(res, 400, { ok: false, error: { message: String(error instanceof Error ? error.message : error) } }); return true; }
      try {
        if (!options.usageStore) throw new Error('Usage storage is unavailable; restart this instance to enable it');
        const data = await options.usageStore.query(query) as { rows?: Array<Record<string, unknown>> };
        const config = runtimeStore.getSnapshot().config;
        sendJson(res, 200, {
          ...data,
          totals: sumUsageTotals(data.rows ?? []),
          instanceName: config.instanceName,
          configuredChannels: Array.from(config.routingConfig.channelsById.values()).map(channel => ({ id: channel.id, name: channel.name })),
          configuredModels: Array.from(config.routingConfig.modelRoutes.keys()),
        });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: { message: String(error instanceof Error ? error.message : error) } });
      }
      return true;
    }

    if (method === 'GET' && url === '/admin/usage') {
      serveAdminStatic(res, 'usage.html', 'text/html; charset=utf-8');
      return true;
    }

    if (method === 'GET' && (url === '/admin/stats' || url === '/admin/monitor/stats')) {
      const snapshot = runtimeStore.getSnapshot();
      const config = snapshot.config;
      sendJson(res, 200, {
        ok: true,
        ...(options.getAdminStats ? (options.getAdminStats() as Record<string, unknown>) : {}),
        runtimeVersion: snapshot.runtimeVersion,
        instanceName: config.instanceName,
        routingConfigPath: config.routingConfigPath,
        defaultModel: config.routingConfig.defaultModel,
        channels: Array.from(config.routingConfig.channelsById.values()).map(channel => ({
          id: channel.id,
          name: channel.name,
          baseUrl: channel.baseUrl,
          fingerprint: channel.fingerprint,
          disableCooldown: channel.disableCooldown,
        })),
        modelRoutes: Array.from(config.routingConfig.modelRoutes.values()).map(route => ({
          canonicalModel: route.canonicalModel,
          channelIds: route.channelIds,
        })),
        aliases: config.routingConfig.aliases,
        healthSnapshot: options.healthRegistry?.snapshot() ?? null,
        // The static Usage page is shared between instances, so the nav needs to know whether this one has a database.
        usageAvailable: Boolean(options.usageStore),
      });
      return true;
    }

    if (method === 'GET' && (url === '/admin' || url === '/admin/')) {
      serveAdminStatic(res, 'admin.html', 'text/html; charset=utf-8');
      return true;
    }

    if (method === 'GET' && (url === '/admin/monitor' || url === '/admin/monitor/')) {
      serveAdminStatic(res, 'monitor.html', 'text/html; charset=utf-8');
      return true;
    }

    if (method === 'GET' && url.startsWith('/admin/assets/')) {
      const assetName = url.slice('/admin/assets/'.length);
      const contentType = assetName && !assetName.includes('..') && !assetName.includes('/') && !assetName.includes('\\')
        ? STATIC_ASSETS[assetName]
        : undefined;
      if (!contentType) {
        sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
        return true;
      }
      serveAdminStatic(res, assetName, contentType, 'assets');
      return true;
    }

    return false;
  };
}
