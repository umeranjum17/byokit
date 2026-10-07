import { b64, b64url, hash, unb64 } from './channel.ts';
import type { DeviceGrant } from './device.ts';

export type GrantMigrationProblem = 'unsupported-format' | 'invalid-grant';

/** A migration failure. Neither the message nor the error retains the input or its keys. */
export class GrantMigrationError extends Error {
  readonly code: GrantMigrationProblem;
  constructor(code: GrantMigrationProblem) {
    super(code === 'unsupported-format' ? 'This saved pairing needs a different update.' : 'This saved pairing cannot be read. Pair this device again.');
    this.name = 'GrantMigrationError';
    this.code = code;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const bad = (): never => { throw new GrantMigrationError('invalid-grant'); };
const key = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return bad();
  const bytes = unb64(value);
  if (bytes.length !== 32 || b64(bytes) !== value) return bad();
  return bytes;
};
const wsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^wss?:\/\//.test(value) || /\s/.test(value)) return false;
  const url = new URL(value);
  return !!url.hostname && !url.username && !url.password && !url.hash;
};

/** Converts the pre-kit Crewhouse phone grant (no `v`, padded base64 `sk`/`crewdPk`,
 *  `fp`, `urls`, `device`) from a parsed object or its JSON. The fingerprint checks
 *  host-key consistency, not authenticity: only a connection to the host verifies
 *  the device's access. No storage, network access or logging is performed. */
export function migrateGrant(raw: unknown, options: { format: 'crewhouse-v0' }): DeviceGrant {
  let supported = false;
  try { supported = options?.format === 'crewhouse-v0'; } catch {}
  if (!supported) throw new GrantMigrationError('unsupported-format');
  try {
    const g: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!record(g) || Object.keys(g).length !== 5 || Object.keys(g).some((k) => !['sk', 'crewdPk', 'fp', 'urls', 'device'].includes(k))) return bad();
    const secret = key(g.sk), host = key(g.crewdPk);
    const fp = Array.from(hash(16, host).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join(' ');
    if (g.fp !== fp || !Array.isArray(g.urls) || !g.urls.length) return bad();
    const urls: unknown[] = Array.from(g.urls);
    if (!urls.every(wsUrl)) return bad();
    const d = g.device;
    if (!record(d) || Object.keys(d).length !== 3 || Object.keys(d).some((k) => !['id', 'name', 'role'].includes(k)) ||
        !text(d.id) || !text(d.name) || (d.role !== 'control' && d.role !== 'view')) return bad();
    return { v: 1, secretKey: b64url(secret), host: b64url(host), hostName: 'your computer',
      urls: urls as string[], device: { id: d.id, name: d.name, role: d.role } };
  } catch {
    // JSON, URL and crypto errors can carry input text; expose only a fixed typed failure.
    throw new GrantMigrationError('invalid-grant');
  }
}
