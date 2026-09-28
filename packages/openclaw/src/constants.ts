// The pins this kit is built against (D4, D6). Data, not behavior: an installed engine on another version is
// `needs-update`, never silently run.
export const ENGINE_VERSION = '2026.8.1';
export const PROTOCOL_VERSION = 4;
export const OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.questions',
  'operator.pairing',
  'operator.talk',
] as const;
