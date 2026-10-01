import { createHash, randomBytes, randomInt } from 'node:crypto';
import { cleanName, normalizeCode } from '@byokit/link';
import type { Keystore } from '@byokit/secrets';
import { McpError, publicError } from './errors.ts';

export type Principal = { id: string; name: string };
/** Later authorization schemes implement this seam without changing the server. */
export interface Authenticator {
  authenticate(token: string): Promise<Principal | null>;
}
export type DeviceOffer = {
  device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number;
};
export type DeviceToken = { access_token: string; token_type: 'Bearer'; expires_in: number };
export type DeviceFlowOptions = {
  store: Keystore;
  verificationUri: string;
  codeSeconds?: number;
  tokenSeconds?: number;
  intervalSeconds?: number;
  maxPending?: number;
  now?: () => number;
};
type Pending = { userCode: string; expires: number; pollAt: number; principal?: Principal; issuing?: boolean };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenName = (token: string) => `mcp-token-${digest(token)}`;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

/** App-owned sign-in service. Only SHA-256 token digests reach the host's secrets backend. */
export function deviceFlow(o: DeviceFlowOptions) {
  const now = o.now ?? Date.now;
  const codeSeconds = o.codeSeconds ?? 300, tokenSeconds = o.tokenSeconds ?? 2_592_000;
  const interval = o.intervalSeconds ?? 5, maxPending = o.maxPending ?? 1000;
  const uri = new URL(o.verificationUri);
  if (![codeSeconds, tokenSeconds, interval, maxPending].every(positive) || uri.username || uri.password ||
      (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)))) {
    throw new McpError('invalid');
  }
  const pending = new Map<string, Pending>();
  const sweep = () => { for (const [key, p] of pending) if (p.expires <= now() && !p.issuing) pending.delete(key); };
  const safe = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) { throw publicError(error); }
  };
  return {
    begin(): DeviceOffer {
      sweep();
      if (pending.size >= maxPending) throw new McpError('busy');
      // Same unambiguous 12-character shape accepted by link pairing's normalizer.
      const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      let userCode: string;
      do { userCode = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
      while ([...pending.values()].some(p => p.userCode === userCode));
      const deviceCode = randomBytes(32).toString('base64url');
      pending.set(digest(deviceCode), { userCode, expires: now() + codeSeconds * 1000, pollAt: 0 });
      return { device_code: deviceCode, user_code: userCode.match(/.{4}/g)!.join('-'),
        verification_uri: uri.href, expires_in: codeSeconds, interval };
    },
    /** Call ONLY from the host's authenticated, CSRF-protected account page after explicit approval.
     * Never take the principal from the unauthenticated device request. */
    approve(userCode: string, principal: Principal): void {
      sweep();
      const code = normalizeCode(userCode);
      const p = [...pending.values()].find(p => p.userCode === code);
      if (!p) throw new McpError('expired');
      if (p.principal || p.issuing) throw new McpError('invalid');
      if (typeof principal?.id !== 'string' || !principal.id.trim() || principal.id.length > 256) throw new McpError('invalid');
      p.principal = { id: principal.id, name: cleanName(principal.name, 'your account') };
    },
    poll(deviceCode: string): Promise<DeviceToken> {
      return safe(async () => {
        const key = digest(deviceCode), p = pending.get(key);
        if (!p || p.expires <= now()) { pending.delete(key); throw new McpError('expired'); }
        if (p.issuing || now() < p.pollAt) throw new McpError('busy');
        p.pollAt = now() + interval * 1000;
        if (!p.principal) throw new McpError('pending');
        p.issuing = true;
        const token = randomBytes(32).toString('base64url');
        try {
          await o.store.set(tokenName(token), JSON.stringify({ principal: p.principal, expires: now() + tokenSeconds * 1000 }));
          if (p.expires <= now()) { await o.store.delete(tokenName(token)); throw new McpError('expired'); }
          pending.delete(key);
          return { access_token: token, token_type: 'Bearer', expires_in: tokenSeconds };
        } finally { p.issuing = false; }
      });
    },
    authenticate(token: string): Promise<Principal | null> {
      return safe(async () => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
        const name = tokenName(token), value = await o.store.get(name);
        if (value === null) return null;
        const record = JSON.parse(value);
        if (!Number.isFinite(record?.expires) || record.expires <= now()) { await o.store.delete(name); return null; }
        if (typeof record.principal?.id !== 'string' || typeof record.principal?.name !== 'string') throw new McpError('failed');
        return { id: record.principal.id, name: record.principal.name };
      });
    },
    revoke(token: string): Promise<boolean> { return safe(() => o.store.delete(tokenName(token))); },
  };
}
export type DeviceFlow = ReturnType<typeof deviceFlow>;
