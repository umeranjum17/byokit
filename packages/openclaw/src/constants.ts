// The pins this kit is built against (D4, D6). Data, not behavior: an installed engine on another version is
// `needs-update`, never silently run.
export const ENGINE_VERSION = '2026.8.35';
export const PROTOCOL_VERSION = 4;
// Providers whose live catalog the kit registers (5.6); key choice uses the same catalog hook.
export const LIVE_CATALOGS = ['opencode-go'];
export const OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.questions',
  'operator.pairing',
  'operator.talk',
] as const;
