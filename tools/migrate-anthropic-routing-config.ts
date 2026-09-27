import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

import { parseRoutingConfig } from '../src/routing-config.js';

const SECRET_MODE = 0o600;

function isInsideDirectory(directory: string, candidate: string): boolean {
  const rel = relative(directory, candidate);
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
}

// A relative FALLBACK_CONFIG_PATH is written for the deployment root, not for the instance directory,
// so prefer an instance-local match and otherwise fall back to the working directory like the proxy does.
function resolveInstancePath(instanceDirectory: string, configured: string | undefined, fallbackName: string): string {
  const candidate = configured?.trim();
  if (candidate === undefined || candidate.length === 0) return join(instanceDirectory, fallbackName);
  if (isAbsolute(candidate)) return candidate;
  const local = resolve(instanceDirectory, candidate);
  if (existsSync(local)) return local;
  const fromCwd = resolve(candidate);
  return existsSync(fromCwd) ? fromCwd : local;
}

export type MigrationOptions = Readonly<{
  instanceDirectory: string;
  write: boolean;
  updateEnv: boolean;
  routingPath?: string;
  modelMapPath?: string;
}>;

type ChannelDocument = { id: string; name?: string; base_url: string; api_key: string; disable_cooldown?: boolean };
type RoutingDocument = {
  default_model: string;
  channels: ChannelDocument[];
  models: Record<string, { channel_ids: string[] }>;
  aliases: Record<string, string>;
};

type FallbackEntry = { name: string; base_url: string; api_key?: string; api_key_env?: string; disable_cooldown?: boolean };

function readObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must contain an object`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, property: string, context: string): string {
  const value = source[property];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}.${property} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalEnv(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim().length === 0 ? fallback : value.trim();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : 'channel';
}

function uniqueChannelId(name: string, usedIds: Set<string>): string {
  const baseId = slugify(name);
  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function maskApiKey(apiKey: string): string {
  return `****${apiKey.slice(-4)}`;
}

function maskDocument(document: RoutingDocument): RoutingDocument {
  return {
    ...document,
    channels: document.channels.map(channel => ({ ...channel, api_key: maskApiKey(channel.api_key) })),
  };
}

function resolveFallbackApiKey(
  entry: FallbackEntry,
  context: string,
  env: Record<string, string | undefined>,
): string {
  if (typeof entry.api_key === 'string' && entry.api_key.trim().length > 0) {
    return entry.api_key.trim();
  }
  if (typeof entry.api_key_env === 'string' && entry.api_key_env.trim().length > 0) {
    const name = entry.api_key_env.trim();
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`${context}.api_key_env '${name}' could not be resolved from .env or the process environment`);
    }
    return value.trim();
  }
  throw new Error(`${context} must provide api_key or api_key_env`);
}

function readAliases(modelMapPath: string): { aliases: Record<string, string>; names: string[] } {
  if (!existsSync(modelMapPath)) {
    return { aliases: {}, names: [] };
  }
  const parsed: unknown = JSON.parse(readFileSync(modelMapPath, 'utf8'));
  const root = readObject(parsed, 'model-map.json');
  const rawMappings = root['model_mappings'] ?? root;
  const mappings = readObject(rawMappings, 'model-map.json.model_mappings');
  const aliases: Record<string, string> = {};
  const names = new Set<string>();

  for (const [rawAlias, rawTarget] of Object.entries(mappings)) {
    const alias = rawAlias.trim();
    if (alias.length === 0) {
      throw new Error('model-map.json contains an empty alias name');
    }
    if (Object.hasOwn(aliases, alias)) {
      throw new Error(`model-map.json contains duplicate alias '${alias}'`);
    }
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
      // The legacy runtime skipped aliases with empty targets; the migration does the same.
      console.warn(`Keeping legacy behaviour: skipping alias '${alias}' because its target is empty`);
      continue;
    }
    const target = rawTarget.trim();
    if (Object.hasOwn(aliases, target)) {
      throw new Error(`model-map.json alias '${alias}' targets another alias ('${target}')`);
    }
    aliases[alias] = target;
    names.add(alias);
    names.add(target);
  }

  return { aliases, names: Array.from(names) };
}

function readExistingRoutingDocument(routingPath: string): RoutingDocument | undefined {
  if (!existsSync(routingPath)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(routingPath, 'utf8'));
  const root = readObject(parsed, 'fallback.json');
  if (!Array.isArray(root['channels'])) return undefined;
  return root as unknown as RoutingDocument;
}

export function buildRoutingDocument(instanceDirectory: string, overrides: { routingPath?: string; modelMapPath?: string } = {}): { document: RoutingDocument; envPath: string; routingPath: string; modelMapPath: string; warnings: string[] } {
  const envPath = join(instanceDirectory, '.env');
  const env = parseDotenv(readFileSync(envPath, 'utf8'));
  const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
  const routingPath = resolveInstancePath(instanceDirectory, overrides.routingPath ?? env.FALLBACK_CONFIG_PATH, 'fallback.json');
  const modelMapPath = resolveInstancePath(instanceDirectory, overrides.modelMapPath ?? env.MODEL_MAP_PATH, 'model-map.json');
  const warnings: string[] = [];

  const unexplained = [
    isInsideDirectory(instanceDirectory, routingPath) || overrides.routingPath !== undefined ? undefined : routingPath,
    isInsideDirectory(instanceDirectory, modelMapPath) || overrides.modelMapPath !== undefined ? undefined : modelMapPath,
  ].filter((candidate): candidate is string => candidate !== undefined);
  if (unexplained.length > 0) {
    throw new Error(
      `Resolved instance paths point outside ${instanceDirectory}: ${unexplained.join(', ')}. A relative FALLBACK_CONFIG_PATH is read from the process working directory, so run the tool from the deployment root or pass --routing-path / --model-map-path explicitly.`,
    );
  }
  const outside = [routingPath, modelMapPath].filter(candidate => !isInsideDirectory(instanceDirectory, candidate));
  if (outside.length > 0) {
    warnings.push(`writing outside the instance directory: ${outside.join(', ')}`);
  }

  const existing = readExistingRoutingDocument(routingPath);
  if (existing !== undefined) {
    // Already migrated: keep ids, order and keys untouched so a re-run is a no-op.
    const document: RoutingDocument = {
      default_model: existing.default_model,
      channels: existing.channels.map((channel, index) => {
        if (typeof channel?.base_url !== 'string' || typeof channel?.api_key !== 'string') {
          throw new Error(`fallback.json.channels[${index}] must carry base_url and api_key`);
        }
        return {
          id: channel.id,
          ...(channel.name === undefined ? {} : { name: channel.name }),
          base_url: normalizeBaseUrl(channel.base_url),
          api_key: channel.api_key,
          ...(channel.disable_cooldown === true ? { disable_cooldown: true } : {}),
        };
      }),
      models: existing.models,
      aliases: existing.aliases ?? {},
    };
    parseRoutingConfig(document, routingPath);
    warnings.push('routing config already uses the channels/models/aliases format; nothing to migrate');
    return { document, envPath, routingPath, modelMapPath, warnings };
  }

  const primaryBaseUrl = normalizeBaseUrl(
    env.PRIMARY_PROVIDER_BASE_URL === undefined || env.PRIMARY_PROVIDER_BASE_URL.trim().length === 0
      ? (() => { throw new Error('Missing PRIMARY_PROVIDER_BASE_URL in .env'); })()
      : env.PRIMARY_PROVIDER_BASE_URL.trim(),
  );
  const primaryApiKey = env.PRIMARY_PROVIDER_API_KEY?.trim();
  if (primaryApiKey === undefined || primaryApiKey.length === 0) {
    throw new Error('Missing PRIMARY_PROVIDER_API_KEY in .env');
  }
  const primaryName = readOptionalEnv(mergedEnv, 'PRIMARY_PROVIDER_NAME', 'primary-provider');
  const defaultModel = readOptionalEnv(mergedEnv, 'PRIMARY_PROVIDER_DEFAULT_MODEL', 'default-model');

  const parsedFallback: unknown = JSON.parse(readFileSync(routingPath, 'utf8'));
  const fallbackRoot = readObject(parsedFallback, 'fallback.json');
  const rawFallbacks = fallbackRoot['fallback_api_config'] ?? [];
  if (!Array.isArray(rawFallbacks)) {
    throw new Error('fallback.json.fallback_api_config must be an array when present');
  }

  const channels: ChannelDocument[] = [{ id: 'primary', name: primaryName, base_url: primaryBaseUrl, api_key: primaryApiKey }];
  const usedIds = new Set<string>(['primary']);
  for (let index = 0; index < rawFallbacks.length; index += 1) {
    const context = `fallback.json.fallback_api_config[${index}]`;
    const entry = readObject(rawFallbacks[index], context) as FallbackEntry;
    const name = readString(entry as unknown as Record<string, unknown>, 'name', context);
    const channel: ChannelDocument = {
      id: uniqueChannelId(name, usedIds),
      name,
      base_url: normalizeBaseUrl(readString(entry as unknown as Record<string, unknown>, 'base_url', context)),
      api_key: resolveFallbackApiKey(entry, context, mergedEnv),
    };
    if (entry.disable_cooldown === true) {
      channel.disable_cooldown = true;
    }
    channels.push(channel);
  }

  const modelMapping = readAliases(modelMapPath);
  const allNames = new Set<string>([defaultModel, ...modelMapping.names]);
  const canonicalModels = Array.from(allNames).filter(model => !Object.hasOwn(modelMapping.aliases, model));
  if (canonicalModels.length === 0) {
    throw new Error('Migration produced no canonical model routes');
  }

  const channelIds = channels.map(channel => channel.id);
  const models: Record<string, { channel_ids: string[] }> = {};
  for (const model of canonicalModels) {
    models[model] = { channel_ids: [...channelIds] };
  }

  warnings.push(
    `Model allowlist: only ${canonicalModels.length} model(s) taken from the legacy default model and model-map targets are configured; ` +
    'any other client model is now rejected locally. Add missing models to models{} before publishing.',
  );
  const unmappedAliases = Object.keys(modelMapping.aliases).length === 0 && existsSync(modelMapPath);
  if (unmappedAliases) {
    warnings.push('model-map.json exists but produced no aliases');
  }

  const document: RoutingDocument = { default_model: defaultModel, channels, models, aliases: modelMapping.aliases };
  parseRoutingConfig(document, routingPath);
  return { document, envPath, routingPath, modelMapPath, warnings };
}

function commentLegacyEnvKeys(envPath: string, modelMapPath: string): void {
  const source = readFileSync(envPath, 'utf8');
  const output: string[] = [];
  let primaryMarkerWritten = false;
  let modelMapMarkerWritten = false;
  let legacyPolicyMarkerWritten = false;
  let changed = false;

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    const isComment = trimmed.startsWith('#');
    const isPrimary = !isComment && trimmed.startsWith('PRIMARY_PROVIDER_') && trimmed.includes('=');
    const isModelMap = !isComment && trimmed.startsWith('MODEL_MAP_PATH=');
    // FALLBACK_CONFIG_PATH stays active: it is the single routing source now.
    const isLegacyPolicy = !isComment && (trimmed.startsWith('PROXY_ENDPOINT_') || trimmed.startsWith('PROXY_MAX_FALLBACK_ATTEMPTS='));
    if (!isPrimary && !isModelMap && !isLegacyPolicy) {
      output.push(line);
      continue;
    }
    changed = true;
    if (isPrimary && !primaryMarkerWritten) {
      output.push('# PRIMARY_PROVIDER_* removed by the Anthropic routing migration tool');
      primaryMarkerWritten = true;
    }
    if (isModelMap && !modelMapMarkerWritten) {
      output.push('# MODEL_MAP_PATH is no longer read; channels/models/aliases live in FALLBACK_CONFIG_PATH');
      modelMapMarkerWritten = true;
    }
    if (isLegacyPolicy && !legacyPolicyMarkerWritten) {
      output.push(`# Legacy endpoint health settings removed; use PROXY_HEALTH_*, PROXY_CHANNEL_MAX_ATTEMPTS / PROXY_CHANNEL_RETRY_DELAY_MS and PROXY_QUOTA_COOLDOWN_MS`);
      legacyPolicyMarkerWritten = true;
    }
    output.push(`# ${trimmed}`);
  }

  if (changed) {
    writeFileSync(envPath, output.join('\n'), 'utf8');
    chmodSync(envPath, SECRET_MODE);
  }
}

function backupWithConflictGuard(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  if (!existsSync(backupPath)) {
    copyFileSync(filePath, backupPath);
    chmodSync(backupPath, SECRET_MODE);
    return backupPath;
  }
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, 'Z');
  const datedPath = `${filePath}.bak-${stamp}`;
  copyFileSync(filePath, datedPath);
  chmodSync(datedPath, SECRET_MODE);
  return datedPath;
}

function atomicWrite(filePath: string, content: string): void {
  const directory = dirname(filePath);
  const tmpFile = join(directory, `.tmp-migrate-${process.pid}-${Date.now()}`);
  writeFileSync(tmpFile, content, { encoding: 'utf8', mode: SECRET_MODE });
  chmodSync(tmpFile, SECRET_MODE);
  renameSync(tmpFile, filePath);
  chmodSync(filePath, SECRET_MODE);
}

export function migrateAnthropicRoutingConfig(options: MigrationOptions): void {
  const instanceDirectory = resolve(options.instanceDirectory);
  const { document, envPath, routingPath, modelMapPath, warnings } = buildRoutingDocument(instanceDirectory, {
    routingPath: options.routingPath,
    modelMapPath: options.modelMapPath,
  });
  const alreadyMigrated = warnings.some(warning => warning.includes('already uses'));

  console.log(JSON.stringify(maskDocument(document), null, 2));
  console.log('\nMigration summary:');
  console.log(`- mode: ${options.write ? 'write' : 'dry-run'}`);
  console.log(`- instance directory: ${instanceDirectory}`);
  console.log(`- routing config: ${routingPath}`);
  console.log(`- legacy model map: ${modelMapPath} (${existsSync(modelMapPath) ? 'present, no longer read' : 'absent'})`);
  console.log(`- channels: ${document.channels.length}`);
  console.log(`- canonical model routes: ${Object.keys(document.models).length} (${Object.keys(document.models).join(', ')})`);
  console.log(`- aliases: ${Object.keys(document.aliases).length}`);
  for (const warning of warnings) {
    console.log(`- warning: ${warning}`);
  }

  if (!options.write) {
    console.log('- no files changed; rerun with --write to apply (dry-run is the default)');
    return;
  }
  if (alreadyMigrated) {
    console.log('- nothing written: the routing config already uses the new format (idempotent re-run)');
    return;
  }

  const routingBackup = backupWithConflictGuard(routingPath);
  const envBackup = backupWithConflictGuard(envPath);
  try {
    atomicWrite(routingPath, `${JSON.stringify(document, null, 2)}\n`);
    if (options.updateEnv) {
      commentLegacyEnvKeys(envPath, modelMapPath);
    }
  } catch (error) {
    // Multi-file best effort: restore both files so a partial write cannot leave a mixed config.
    copyFileSync(routingBackup, routingPath);
    copyFileSync(envBackup, envPath);
    chmodSync(routingPath, SECRET_MODE);
    chmodSync(envPath, SECRET_MODE);
    throw new Error(`Migration failed and files were restored from backup: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`- backup: ${routingBackup}`);
  console.log(`- backup: ${envBackup}`);
  console.log('- routing config and .env written with mode 0600');
  if (options.updateEnv) {
    console.log('- legacy PRIMARY_PROVIDER_* / FALLBACK_CONFIG_PATH / MODEL_MAP_PATH lines were commented out');
  }
}

function parseArgs(args: readonly string[]): MigrationOptions {
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a file path`);
    return value;
  };
  const usage = 'Usage: npx tsx tools/migrate-anthropic-routing-config.ts <instance-directory> [--write] [--routing-path <file>] [--model-map-path <file>] [--skip-env-update]';
  const routingPath = flagValue('--routing-path');
  const modelMapPath = flagValue('--model-map-path');
  const knownFlags = ['--write', '--skip-env-update', '--routing-path', '--model-map-path'];
  const consumed = new Set([routingPath, modelMapPath].filter((value): value is string => value !== undefined));
  const positional = args.filter(argument => !argument.startsWith('--') && !consumed.has(argument));
  const unknownFlags = args.filter(argument => argument.startsWith('--') && !knownFlags.includes(argument));
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown option: ${unknownFlags[0]}`);
  }
  if (positional.length !== 1) {
    throw new Error(usage);
  }
  return {
    instanceDirectory: positional[0],
    write: args.includes('--write'),
    updateEnv: !args.includes('--skip-env-update'),
    routingPath,
    modelMapPath,
  };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  if (process.argv.includes('--help')) {
    console.log('Usage: npx tsx tools/migrate-anthropic-routing-config.ts <instance-directory> [--write] [--routing-path <file>] [--model-map-path <file>] [--skip-env-update]');
    console.log('Dry-run is the default. API keys are always masked in terminal output.');
  } else {
    try {
      migrateAnthropicRoutingConfig(parseArgs(process.argv.slice(2)));
    } catch (error) {
      console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
