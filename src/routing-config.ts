import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type ChannelConfig = Readonly<{
  id: string;
  name: string;
  baseUrl: string;
  messagesUrl: string;
  apiKey: string;
  fingerprint: string;
  disableCooldown: boolean;
}>;

export type ModelRoute = Readonly<{
  canonicalModel: string;
  channelIds: readonly string[];
}>;

export type RoutingConfig = Readonly<{
  path: string;
  defaultModel: string;
  channelsById: ReadonlyMap<string, ChannelConfig>;
  modelRoutes: ReadonlyMap<string, ModelRoute>;
  aliases: Readonly<Record<string, string>>;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

type FieldContext = Readonly<{
  configPath: string;
  fieldPath: string;
}>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(configPath: string, fieldPath: string, detail: string): never {
  throw new Error(`routing config ${configPath}: ${fieldPath} ${detail}`);
}

function readNonEmptyString(source: JsonObject, property: string, context: FieldContext): string {
  const value = source[property];
  const fieldPath = `${context.fieldPath}.${property}`;
  if (typeof value !== 'string') {
    fail(context.configPath, fieldPath, 'must be a non-empty string');
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    fail(context.configPath, fieldPath, 'must be a non-empty string');
  }

  return normalized;
}

function readOptionalName(source: JsonObject, context: FieldContext, fallback: string): string {
  const value = source['name'];
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'string') {
    fail(context.configPath, `${context.fieldPath}.name`, 'must be a string when present');
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

function fingerprintChannel(id: string, baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(`${id}|${baseUrl}|${apiKey}`).digest('hex');
}

function parseChannel(value: unknown, context: FieldContext): ChannelConfig {
  if (!isJsonObject(value)) {
    fail(context.configPath, context.fieldPath, 'must be an object');
  }

  if (Object.hasOwn(value, 'api_key_env')) {
    fail(context.configPath, `${context.fieldPath}.api_key_env`, 'is not supported; migrate the key into api_key');
  }

  const disableCooldown = value['disable_cooldown'];
  if (disableCooldown !== undefined && typeof disableCooldown !== 'boolean') {
    fail(context.configPath, `${context.fieldPath}.disable_cooldown`, 'must be a boolean');
  }

  const id = readNonEmptyString(value, 'id', context);
  const name = readOptionalName(value, context, id);
  const rawBaseUrl = readNonEmptyString(value, 'base_url', context);
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (baseUrl.length === 0) {
    fail(context.configPath, `${context.fieldPath}.base_url`, 'must not normalize to an empty URL');
  }

  const apiKey = readNonEmptyString(value, 'api_key', context);

  return Object.freeze({
    id,
    name,
    baseUrl,
    messagesUrl: `${baseUrl}/v1/messages`,
    apiKey,
    fingerprint: fingerprintChannel(id, baseUrl, apiKey),
    disableCooldown: disableCooldown === true,
  });
}

function parseChannels(root: JsonObject, configPath: string): Map<string, ChannelConfig> {
  const channels = root['channels'];
  if (!Array.isArray(channels) || channels.length === 0) {
    fail(configPath, 'channels', 'must be a non-empty array');
  }

  const channelsById = new Map<string, ChannelConfig>();
  for (let index = 0; index < channels.length; index += 1) {
    const channel = parseChannel(channels[index], { configPath, fieldPath: `channels[${index}]` });
    if (channelsById.has(channel.id)) {
      fail(configPath, `channels[${index}].id`, 'duplicates another channel id');
    }
    channelsById.set(channel.id, channel);
  }

  return channelsById;
}

function readChannelIds(route: JsonObject, context: FieldContext): readonly string[] {
  const channelIds = route['channel_ids'];
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    fail(context.configPath, `${context.fieldPath}.channel_ids`, 'must be a non-empty array');
  }

  return channelIds.map((channelId, index) => {
    if (typeof channelId !== 'string' || channelId.trim().length === 0) {
      fail(context.configPath, `${context.fieldPath}.channel_ids[${index}]`, 'must be a non-empty channel id string');
    }
    return channelId.trim();
  });
}

function parseModelRoutes(
  root: JsonObject,
  channelsById: ReadonlyMap<string, ChannelConfig>,
  configPath: string,
): Map<string, ModelRoute> {
  const models = root['models'];
  if (!isJsonObject(models)) {
    fail(configPath, 'models', 'must be an object');
  }

  const routes = new Map<string, ModelRoute>();
  for (const [rawModel, rawRoute] of Object.entries(models)) {
    const canonicalModel = rawModel.trim();
    const modelPath = `models['${canonicalModel}']`;
    if (canonicalModel.length === 0) {
      fail(configPath, "models['']", 'must have a non-empty canonical model name');
    }
    if (routes.has(canonicalModel)) {
      fail(configPath, modelPath, 'duplicates another canonical model name');
    }
    if (!isJsonObject(rawRoute)) {
      fail(configPath, modelPath, 'must be an object');
    }

    const channelIds = readChannelIds(rawRoute, { configPath, fieldPath: modelPath });
    const seenChannelIds = new Set<string>();
    for (let index = 0; index < channelIds.length; index += 1) {
      const channelId = channelIds[index];
      const channelPath = `${modelPath}.channel_ids[${index}]`;
      if (seenChannelIds.has(channelId)) {
        fail(configPath, channelPath, 'duplicates another channel in the route');
      }
      if (!channelsById.has(channelId)) {
        fail(configPath, channelPath, 'references an unknown channel id');
      }
      seenChannelIds.add(channelId);
    }

    routes.set(canonicalModel, Object.freeze({ canonicalModel, channelIds }));
  }

  if (routes.size === 0) {
    fail(configPath, 'models', 'must define at least one canonical model route');
  }

  return routes;
}

function parseAliases(
  root: JsonObject,
  modelRoutes: ReadonlyMap<string, ModelRoute>,
  configPath: string,
): Readonly<Record<string, string>> {
  const rawAliases = root['aliases'];
  if (rawAliases === undefined) {
    return {} as Readonly<Record<string, string>>;
  }
  if (!isJsonObject(rawAliases)) {
    fail(configPath, 'aliases', 'must be an object');
  }

  const aliasTargets = new Map<string, string>();
  for (const [rawAlias, rawTarget] of Object.entries(rawAliases)) {
    const alias = rawAlias.trim();
    const aliasPath = `aliases['${alias}']`;
    if (alias.length === 0) {
      fail(configPath, "aliases['']", 'must have a non-empty alias name');
    }
    if (aliasTargets.has(alias)) {
      fail(configPath, aliasPath, 'duplicates another alias name');
    }
    if (modelRoutes.has(alias)) {
      fail(configPath, aliasPath, 'collides with a canonical model name');
    }
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
      fail(configPath, aliasPath, 'must target a non-empty canonical model string');
    }
    aliasTargets.set(alias, rawTarget.trim());
  }

  const aliases: Record<string, string> = {};
  for (const [alias, target] of aliasTargets) {
    const aliasPath = `aliases['${alias}']`;
    if (aliasTargets.has(target)) {
      fail(configPath, aliasPath, 'must not target another alias');
    }
    if (!modelRoutes.has(target)) {
      fail(configPath, aliasPath, 'targets an unknown canonical model');
    }
    aliases[alias] = target;
  }

  return Object.freeze(aliases);
}

function warnUnusedChannels(
  channelsById: ReadonlyMap<string, ChannelConfig>,
  modelRoutes: ReadonlyMap<string, ModelRoute>,
  configPath: string,
): void {
  const usedChannelIds = new Set<string>();
  for (const route of modelRoutes.values()) {
    for (const channelId of route.channelIds) {
      usedChannelIds.add(channelId);
    }
  }

  for (const channelId of channelsById.keys()) {
    if (!usedChannelIds.has(channelId)) {
      console.warn(`routing config ${configPath}: unused channel '${channelId}' is not referenced by any model route`);
    }
  }
}

export function loadRoutingConfig(path: string): RoutingConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parseRoutingConfig(parsed, path);
}

export function parseRoutingConfig(value: unknown, path: string): RoutingConfig {
  if (!isJsonObject(value)) {
    fail(path, 'root', 'must be an object');
  }

  if (Object.hasOwn(value, 'fallback_api_config')) {
    fail(path, 'fallback_api_config', 'is no longer supported; run tools/migrate-anthropic-routing-config.ts');
  }

  const rootContext = { configPath: path, fieldPath: 'root' };
  const requestedDefaultModel = readNonEmptyString(value, 'default_model', rootContext);
  const channelsById = parseChannels(value, path);
  const modelRoutes = parseModelRoutes(value, channelsById, path);
  const aliases = parseAliases(value, modelRoutes, path);
  const aliasTarget = Object.hasOwn(aliases, requestedDefaultModel) ? aliases[requestedDefaultModel] : undefined;
  const defaultModel = modelRoutes.has(requestedDefaultModel) ? requestedDefaultModel : aliasTarget;
  if (defaultModel === undefined) {
    fail(path, 'default_model', 'must resolve to a canonical model or alias');
  }

  warnUnusedChannels(channelsById, modelRoutes, path);

  return Object.freeze({
    path,
    defaultModel,
    channelsById,
    modelRoutes,
    aliases,
  });
}

export function listConfiguredModels(config: RoutingConfig): readonly string[] {
  return Array.from(config.modelRoutes.keys()).sort();
}
