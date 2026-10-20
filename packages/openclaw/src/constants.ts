// The pins this kit is built against (D4, D6). Data, not behavior: an installed engine on another version is
// `needs-update`, never silently run.
export const ENGINE_VERSION = '2026.8.35';
export const PROTOCOL_VERSION = 4;
// Live catalogs (5.6) the kit registers whole; every other key route registers its chosen model alone. The engine canonicalizes Google preview ids on config write, so OpenRouter's
// list collides with itself (`google/x-preview` and `google/x`); an OpenRouter add registers only the chosen model.
export const REGISTERED_CATALOGS = ['opencode-go', 'minimax'];
export const OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.questions',
  'operator.pairing',
  'operator.talk',
] as const;
