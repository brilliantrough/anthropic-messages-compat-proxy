import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseRoutingConfig } from '../src/routing-config.js';

export async function getAvailablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error('Failed to resolve available port');
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type RoutingFixtureOptions = {
  primary?: { name?: string; baseUrl: string; apiKey: string; disableCooldown?: boolean };
  /** Legacy fallback.json written by a check; its entries are converted to channels. */
  legacyFallbackPath?: string;
  models?: string[];
  aliases?: Record<string, string>;
  extraChannels?: Array<{ id: string; name?: string; baseUrl: string; apiKey: string; disableCooldown?: boolean }>;
};

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : 'channel';
}

/** Builds a parsed routing config in memory for checks that create the proxy in-process. */
export function routingFixture(options: RoutingFixtureOptions) {
  return parseRoutingConfig(buildRoutingDocument(options), '<check>');
}

function buildRoutingDocument(options: RoutingFixtureOptions) {
  const channels: Array<Record<string, unknown>> = [];
  const usedIds = new Set<string>();
  if (options.primary) {
    channels.push({
      id: 'primary',
      name: options.primary.name ?? 'primary',
      base_url: options.primary.baseUrl,
      api_key: options.primary.apiKey,
      ...(options.primary.disableCooldown === true ? { disable_cooldown: true } : {}),
    });
    usedIds.add('primary');
  }

  if (options.legacyFallbackPath !== undefined && existsSync(options.legacyFallbackPath)) {
    const parsed = JSON.parse(readFileSync(options.legacyFallbackPath, 'utf8')) as {
      fallback_api_config?: Array<{ name: string; base_url: string; api_key?: string; api_key_env?: string; disable_cooldown?: boolean }>;
    };
    for (const entry of parsed.fallback_api_config ?? []) {
      let id = slugify(entry.name);
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${slugify(entry.name)}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      channels.push({
        id,
        name: entry.name,
        base_url: entry.base_url,
        api_key: entry.api_key ?? 'fixture-key',
        ...(entry.disable_cooldown === true ? { disable_cooldown: true } : {}),
      });
    }
  }

  for (const channel of options.extraChannels ?? []) {
    channels.push({
      id: channel.id,
      name: channel.name ?? channel.id,
      base_url: channel.baseUrl,
      api_key: channel.apiKey,
      ...(channel.disableCooldown === true ? { disable_cooldown: true } : {}),
    });
    usedIds.add(channel.id);
  }

  const models = options.models ?? ['test-model'];
  const channelIds = channels.map(channel => channel.id as string);
  const modelRoutes: Record<string, { channel_ids: string[] }> = {};
  for (const model of models) {
    modelRoutes[model] = { channel_ids: [...channelIds] };
  }

  return {
    default_model: models[0],
    channels,
    models: modelRoutes,
    aliases: options.aliases ?? {},
  };
}

/** Writes a channels/models/aliases routing document for an isolated test instance and returns its path. */
export async function writeRoutingConfig(dir: string, options: RoutingFixtureOptions): Promise<string> {
  const routingPath = path.join(dir, 'routing.json');
  await writeFile(routingPath, JSON.stringify(buildRoutingDocument(options), null, 2), 'utf8');
  return routingPath;
}

/** Instance env file path for spawned test proxies; the file itself is optional. */
export function instanceEnvPath(dir: string): string {
  return path.join(dir, 'instance.env');
}

type CompletableRegistry = {
  complete: (...args: never[]) => unknown;
  snapshot: () => { channels: Array<{ channelId: string; lastFailureReason?: string; windowFailures: number; remainingMs: number }> };
};

/** Throws on the first complete() call so checks can prove the proxy survives a failing health update. */
export function throwingOnceRegistry<T extends CompletableRegistry>(registry: T): T {
  let thrown = false;
  return {
    ...registry,
    complete(this: unknown, ...args: Parameters<T['complete']>) {
      if (!thrown) {
        thrown = true;
        throw new Error('boom-health-hook');
      }
      return registry.complete(...args);
    },
  } as T;
}

export function healthRecord(registry: CompletableRegistry, channelId: string) {
  const record = registry.snapshot().channels.find(channel => channel.channelId === channelId);
  if (!record) throw new Error(`no health record for ${channelId}`);
  return record;
}
