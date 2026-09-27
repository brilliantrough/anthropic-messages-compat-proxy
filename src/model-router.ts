import type { RoutingConfig } from './routing-config.js';

export type ResolvedModelRoute = Readonly<{
  requestedModel: string;
  canonicalModel: string;
  channelIds: readonly string[];
}>;

export type ModelResolutionError = Readonly<{
  code: 'model_not_configured';
  requestedModel: string;
}>;

export function resolveModelRoute(
  requestedModel: unknown,
  config: RoutingConfig,
): ResolvedModelRoute | ModelResolutionError {
  const requestedModelText =
    typeof requestedModel === 'string' && requestedModel.length > 0 ? requestedModel : config.defaultModel;
  const canonicalModel = config.modelRoutes.has(requestedModelText)
    ? requestedModelText
    : config.aliases[requestedModelText];

  if (canonicalModel === undefined) {
    return { code: 'model_not_configured', requestedModel: requestedModelText };
  }

  const route = config.modelRoutes.get(canonicalModel);
  if (route === undefined) {
    return { code: 'model_not_configured', requestedModel: requestedModelText };
  }

  return { requestedModel: requestedModelText, canonicalModel, channelIds: route.channelIds };
}

export type ConfiguredModelEntry = Readonly<{
  type: 'model';
  id: string;
  display_name: string;
  created_at: string;
  capabilities: null;
  max_input_tokens: null;
  max_tokens: null;
}>;

export function listConfiguredModelEntries(config: RoutingConfig): readonly ConfiguredModelEntry[] {
  const ids = new Set<string>([...config.modelRoutes.keys(), ...Object.keys(config.aliases)]);
  return Array.from(ids)
    .sort()
    .map(id => ({
      type: 'model' as const,
      id,
      display_name: config.aliases[id] === undefined ? id : `${id} (${config.aliases[id]})`,
      // The proxy cannot know a real publication date; this placeholder epoch is documented in the API contract.
      created_at: '1970-01-01T00:00:00Z',
      capabilities: null,
      max_input_tokens: null,
      max_tokens: null,
    }));
}
