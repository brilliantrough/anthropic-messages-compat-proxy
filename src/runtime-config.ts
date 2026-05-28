import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
import { createProxyRuntimeConfig, type ProxyRuntimeConfig } from './proxy-config.js';
import { createAnthropicRuntimeConfig, type AnthropicRuntimeConfig } from './anthropic-config.js';

export type RuntimeSnapshot<T = ProxyRuntimeConfig | AnthropicRuntimeConfig> = {
  runtimeVersion: number;
  config: T;
  envPath: string;
  restartRequiredFields: string[];
};

export type RuntimeConfigStore<T = ProxyRuntimeConfig | AnthropicRuntimeConfig> = {
  getSnapshot(): RuntimeSnapshot<T>;
  reloadFromFiles(): { ok: true } | { ok: false; error: string };
};

export function createEndpointStateKey(endpoint: { name: string; url: string }): string {
  return `${endpoint.name}::${endpoint.url}`;
}

function loadAndMergeEnv(envPath: string): NodeJS.ProcessEnv {
  let fileEnv: Record<string, string> = {};
  try {
    const raw = readFileSync(envPath, 'utf8');
    fileEnv = dotenvParse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(fileEnv)) {
    merged[k] = v;
  }
  return merged;
}

type CommonConfig = { port: number; host: string };

function buildSnapshot<T extends CommonConfig>(
  buildConfig: () => T,
  version: number,
  previous: RuntimeSnapshot<T> | null,
): RuntimeSnapshot<T> {
  const config = buildConfig();

  const restartRequiredFields: string[] = [];
  if (previous) {
    if (config.port !== previous.config.port) {
      restartRequiredFields.push('PORT');
    }
    if (config.host !== previous.config.host) {
      restartRequiredFields.push('HOST');
    }
  }

  return {
    runtimeVersion: version,
    config,
    envPath: '',
    restartRequiredFields,
  };
}

function createStore<T extends CommonConfig>(buildConfig: () => T, envPath: string): RuntimeConfigStore<T> {
  let current: RuntimeSnapshot<T> = buildSnapshot(buildConfig, 1, null);
  current = { ...current, envPath: resolve(envPath) };

  return {
    getSnapshot(): RuntimeSnapshot<T> {
      return current;
    },
    reloadFromFiles(): { ok: true } | { ok: false; error: string } {
      try {
        const nextVersion = current.runtimeVersion + 1;
        const next = buildSnapshot(buildConfig, nextVersion, current);
        current = { ...next, envPath: resolve(envPath) };
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function createRuntimeConfigStore(options: { envPath: string; mode?: undefined | 'responses' }): RuntimeConfigStore<ProxyRuntimeConfig>;
export function createRuntimeConfigStore(options: { envPath: string; mode: 'anthropic' }): RuntimeConfigStore<AnthropicRuntimeConfig>;
export function createRuntimeConfigStore(options: { envPath: string; mode?: 'responses' | 'anthropic' }): RuntimeConfigStore<ProxyRuntimeConfig | AnthropicRuntimeConfig> {
  const { envPath, mode } = options;
  const configDir = dirname(resolve(envPath));

  if (mode === 'anthropic') {
    return createStore(() => createAnthropicRuntimeConfig(configDir), envPath);
  }

  return createStore(() => createProxyRuntimeConfig(loadAndMergeEnv(envPath)), envPath);
}
