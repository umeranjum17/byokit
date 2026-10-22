// The pins this kit is built against (D4, D6). Data, not behavior: an installed engine on another version is
// `needs-update`, never silently run.
export const ENGINE_VERSION = '2026.9.33';
export const PROTOCOL_VERSION = 4;
// Live catalogs (5.6) the kit registers whole; every other key route registers its chosen model alone. The engine
// canonicalizes Google preview ids on config write, so the rows are deduped by the id it keeps (`engineModelId`)
// before they are written.
export const REGISTERED_CATALOGS = ['opencode-go', 'minimax'];
// The providers whose key add registers the provider's live list beside the chosen model, so the member keeps every
// model the vendor lists to pick from (the chosen model id sits beside the provider's own default, `openrouter/auto`).
// The engine's catalog stops at a registered list, so an add that registered the chosen model alone would leave the
// member with that one row and nothing else to pick.
export const LIVE_LIST_ADDS = ['openrouter'];
export const OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.questions',
  'operator.pairing',
  'operator.talk',
] as const;
