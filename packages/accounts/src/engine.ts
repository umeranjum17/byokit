// ChatGPT's sign-in with fetch alone: the engine on phones and in browsers, where Pi's own sign-in flows can't run (they
// need Node's http and crypto, and load through imports a bundler can't follow). Device code only: ChatGPT's page returns
// to a fixed address on the computer (localhost:1455), which a phone or a web page can't listen on. Same credential
// shape, error wording and store seam as Pi; the rules are the shared fixtures (device-code.json, token-responses.json).
// OpenAI's sign-in endpoints answer any web page (CORS), so a PWA signs in directly.
import type { AuthEvent, AuthInteraction, Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import type { AuthHost } from './accounts.ts';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODE_LIVES_S = 15 * 60;
/** The Pi provider ids this engine signs in to. */
export const PORTABLE = ['openai-codex'];

/** A JWT's claims, on any platform (no Buffer). */
export function claims(token: string): any {
  const b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(atob(b64).replace(/[\s\S]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))));
}

const json = (body: string) => { try { return JSON.parse(body); } catch { return undefined; } };

export function deviceStart(status: number, body: string) {
  if (status === 404) throw new Error('OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.');
  if (status < 200 || status > 299) throw new Error(`OpenAI Codex device code request failed with status ${status}${body ? `: ${body}` : ''}`);
  const j = json(body);
  const intervalSeconds = typeof j?.interval === 'string' ? Number(j.interval.trim()) : j?.interval;
  if (!j?.device_auth_id || !j.user_code || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0)
    throw new Error(`Invalid OpenAI Codex device code response: ${body}`);
  return { deviceAuthId: String(j.device_auth_id), userCode: String(j.user_code), intervalSeconds };
}

export type Poll = { status: 'complete'; authorizationCode: string; codeVerifier: string } | { status: 'pending' | 'slow_down' } | { status: 'failed'; message: string };
export function devicePoll(status: number, body: string): Poll {
  if (status >= 200 && status <= 299) {
    const j = json(body);
    return j?.authorization_code && j.code_verifier
      ? { status: 'complete', authorizationCode: j.authorization_code, codeVerifier: j.code_verifier }
      : { status: 'failed', message: `Invalid OpenAI Codex device auth token response: ${body}` };
  }
  if (status === 403 || status === 404) return { status: 'pending' };
  const error = json(body)?.error;
  const code = typeof error === 'object' ? error?.code : error;
  if (code === 'deviceauth_authorization_pending') return { status: 'pending' };
  if (code === 'slow_down') return { status: 'slow_down' };
  return { status: 'failed', message: `OpenAI Codex device auth failed with status ${status}${body ? `: ${body}` : ''}` };
}

/** A token response as the stored credential, the same shape Pi keeps. */
export function credentialOf(j: any, now = Date.now()): OAuthCredential {
  if (typeof j?.access_token !== 'string' || typeof j.refresh_token !== 'string' || typeof j.expires_in !== 'number')
    throw new Error('OpenAI Codex token response missing fields');
  let accountId: unknown;
  try { accountId = claims(j.access_token)['https://api.openai.com/auth']?.chatgpt_account_id; } catch {}
  if (typeof accountId !== 'string' || !accountId) throw new Error('Failed to extract accountId from token');
  return { type: 'oauth', access: j.access_token, refresh: j.refresh_token, expires: now + j.expires_in * 1000, accountId };
}

/** Wait, unless the sign-in is cancelled first. */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Login cancelled'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(new Error('Login cancelled')); };
  signal?.addEventListener('abort', stop, { once: true });
});

export type EngineOptions = {
  /** Where OpenAI's sign-in lives; a stand-in for tests and demos (`mockOpenAI()` from `@byokit/accounts/testing`). */
  base?: string;
};

/** A member's engine on phones and in browsers: ChatGPT's device-code sign-in, refresh and sign-out, into `credentials`. */
export function portableEngine(credentials: CredentialStore, { base = 'https://auth.openai.com' }: EngineOptions = {}): AuthHost {
  const post = async (path: string, body: object, form = false, signal?: AbortSignal) => {
    try {
      const res = await fetch(base + path, {
        method: 'POST', signal,
        headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(body as any).toString() : JSON.stringify(body),
      });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      if (signal?.aborted) throw new Error('Login cancelled');
      throw e;
    }
  };
  const tokens = async (what: 'exchange' | 'refresh', r: { status: number; body: string }) => {
    if (r.status < 200 || r.status > 299) throw new Error(`OpenAI Codex token ${what} failed (${r.status})`);
    return credentialOf(json(r.body));
  };
  const refresh = async (c: OAuthCredential) => {
    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), 15_000);
    try { return await tokens('refresh', await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: CLIENT_ID }, true, stop.signal)); }
    catch (e: any) { throw new Error(`OAuth refresh failed for openai-codex: ${e?.message ?? e}`); }
    finally { clearTimeout(t); }
  };
  const known = (id: string) => { if (!PORTABLE.includes(id)) throw new Error(`${id} can't be signed in to on this device`); };
  const engine = {
    async login(id: string, _type: string, { signal, notify }: AuthInteraction): Promise<Credential> {
      known(id);
      const asked = await post('/api/accounts/deviceauth/usercode', { client_id: CLIENT_ID }, false, signal);
      const start = deviceStart(asked.status, asked.body);
      notify({ type: 'device_code', userCode: start.userCode, verificationUri: `${base}/codex/device`, intervalSeconds: start.intervalSeconds, expiresInSeconds: CODE_LIVES_S } as AuthEvent);
      let interval = Math.max(1000, start.intervalSeconds * 1000);
      for (const deadline = Date.now() + CODE_LIVES_S * 1000; ;) {
        if (Date.now() >= deadline) throw new Error('Device flow timed out');
        // A poll that can't get through waits for the next: a phone cuts a backgrounded app's network while the person
        // is typing the code in the browser (Android 15 and later), which isn't the sign-in failing.
        const r = await post('/api/accounts/deviceauth/token', { device_auth_id: start.deviceAuthId, user_code: start.userCode }, false, signal)
          .catch((e) => { if (signal?.aborted) throw e; return { status: 0, body: '' }; });
        const p: Poll = r.status ? devicePoll(r.status, r.body) : { status: 'pending' };
        if (p.status === 'failed') throw new Error(p.message);
        if (p.status === 'complete') {
          const c = await tokens('exchange', await post('/oauth/token', {
            grant_type: 'authorization_code', client_id: CLIENT_ID, code: p.authorizationCode, code_verifier: p.codeVerifier, redirect_uri: `${base}/deviceauth/callback`,
          }, true, signal));
          if (signal?.aborted) throw new Error('Login cancelled');
          await credentials.modify(id, async () => c);
          return c;
        }
        if (p.status === 'slow_down') interval += 5000;
        await sleep(interval, signal);
      }
    },
    checkAuth: async (id: string) => (PORTABLE.includes(id) && (await credentials.read(id))?.type === 'oauth' ? { source: 'OAuth', type: 'oauth' as const } : undefined),
    /** Pi's rule: refresh under the store's lock when under 5 minutes (or `minOAuthValidityMs`) remain, re-checked there,
     *  so a sign-out or another refresh in between wins; undefined once signed out. */
    async getAuth(id: string, { minOAuthValidityMs }: { minOAuthValidityMs?: number } = {}) {
      if (!PORTABLE.includes(id)) return undefined;
      const min = Math.max(5 * 60_000, minOAuthValidityMs ?? 0);
      const soon = (c: OAuthCredential) => Date.now() + min >= c.expires;
      let c = await credentials.read(id);
      if (c?.type !== 'oauth') return undefined;
      if (soon(c)) {
        c = await credentials.modify(id, async (now) => (now?.type === 'oauth' && soon(now) ? refresh(now) : undefined));
        if (c?.type !== 'oauth') return undefined;
      }
      return { auth: { apiKey: c.access }, source: 'OAuth' };
    },
    logout: (id: string) => credentials.delete(id),
  };
  return engine as unknown as AuthHost;
}
