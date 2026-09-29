// The engine this kit wraps and the protocol range it speaks (docs/capability-kits.md D-H, 4.9).

export const ENGINE_PACKAGE = 'ownvoice-engine';

// The engine version whose protocol schema is committed (schema/engine-protocol-1.json, ownvoice faf2fc2) and that
// file's sha256. The exact `dependencies` pin joins them once the engine is on npm (4.9).
export const ENGINE_VERSION: string = '0.1.0';
export const ENGINE_SCHEMA_SHA256: string = '81c43976383b37118be372788ed34796255069b5b9240d20afbd969e27f3a4bb';

// Engine protocols this kit accepts: from the floor to the current one, both inclusive. Outside is needs-update.
export const PROTOCOL = 1;
export const PROTOCOL_FLOOR = 1;
