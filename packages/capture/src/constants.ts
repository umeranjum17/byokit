// Recorder protocol v1 constants (docs/capability-kits.md 6.2, 5.3–5.4).

// Protocols this kit accepts: from the floor to the current one, both inclusive. Outside is needs-update.
export const PROTOCOL = 1;
export const PROTOCOL_FLOOR = 1;

// The longest a recorder may wait for a person's yes before `consent-timeout` (6.4).
export const CONSENT_WINDOW_S = 120;

// BK-C1 sets the sha256 of schema/recorder-protocol-1.json; until then a placeholder behind a todo test.
export const PROTOCOL_SCHEMA_SHA256: string = '';

// The variables an app may pass for a recording's display session (5.4).
export const DISPLAY_VARS = [
  'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE', 'XAUTHORITY',
] as const;
