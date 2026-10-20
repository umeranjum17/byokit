// The pins this kit is built against (D4, D6). Data, not behavior: an installed engine on another version is
// `needs-update`, never silently run.
export const ENGINE_VERSION = '2026.8.35';
export const PROTOCOL_VERSION = 4;
// Providers whose live catalog lists and checks a key's chosen model (5.6), through the catalog hook. OpenRouter is
// pay-as-you-go: its key takes any model its own catalog lists, with no plan to include it.
export const LIVE_CATALOGS = ['opencode-go', 'openrouter', 'minimax'];
// Live catalogs the kit registers whole. The engine canonicalizes Google preview ids on config write, so OpenRouter's
// list collides with itself (`google/x-preview` and `google/x`); an OpenRouter add registers only the chosen model.
export const REGISTERED_CATALOGS = ['opencode-go', 'minimax'];
// Pay-as-you-go catalogs whose vendor list can lag a model that already runs: an id the list lacks is warned about, never
// refused, and takes the capabilities of the route's own models.
export const OPEN_CATALOGS = ['minimax'];
export const OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.questions',
  'operator.pairing',
  'operator.talk',
] as const;
