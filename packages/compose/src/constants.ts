// The engine this kit wraps and the protocol range it speaks (docs/capability-kits.md D-H, 4.9).

export const ENGINE_PACKAGE = 'ownvoice-engine';

// BK-P2 sets the exact published pin, the committed schema's sha256 and the matching dependency; until then these
// are placeholders behind a todo test.
export const ENGINE_VERSION: string = '0.0.0';
export const ENGINE_SCHEMA_SHA256: string = '';

// Engine protocols this kit accepts: from the floor to the current one, both inclusive. Outside is needs-update.
export const PROTOCOL = 1;
export const PROTOCOL_FLOOR = 1;
