// ChatGPT's sign-in with fetch alone: the engine on phones and in browsers, where Pi's own sign-in flows can't run (they
// need Node's http and crypto, and load through imports a bundler can't follow). Device code only: ChatGPT's page returns
// to a fixed address on the computer (localhost:1455), which a phone or a web page can't listen on. Same credential
// shape, error wording and store seam as Pi; the rules are the shared fixtures (device-code.json, token-responses.json).
// OpenAI's sign-in endpoints answer any web page (CORS), so a PWA signs in directly.
import type { Api, AuthEvent, AuthInteraction, Credential, CredentialStore, Model, OAuthCredential } from '@earendil-works/pi-ai';
import type { AuthHost } from './accounts.ts';
import { deviceFlow, PROVIDERS, type DeviceFlow } from './catalogue.ts';
import { RefreshRequiredError, refreshCredential, revoked } from './stores.ts';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODE_LIVES_S = 15 * 60;
/** The Pi provider ids this engine signs in to. */
export const PORTABLE = ['openai-codex'];
/** ChatGPT's own device flow, plus every provider whose catalogue row carries RFC 8628 device data. */
export const signable = (pi: string) => PORTABLE.includes(pi) || !!deviceFlow(pi);
/** The name the person knows this provider by, for the words a failed sign-in shows them. */
const nameOf = (pi: string) => Object.values(PROVIDERS).find((p) => p.pi === pi)?.name ?? pi;

/** A JWT's claims, on any platform (no Buffer). */
export function claims(token: string): any {
  const b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(atob(b64).replace(/[\s\S]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))));
}

const json = (body: string) => { try { return JSON.parse(body); } catch { return undefined; } };

export function deviceStart(status: number, body: string) {
  if (status === 404) throw new Error('OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.');
  if (status < 200 || status > 299) throw new Error(`OpenAI Codex device code request failed with status ${status}`);
  const j = json(body);
  const intervalSeconds = typeof j?.interval === 'string' ? Number(j.interval.trim()) : j?.interval;
  if (!j?.device_auth_id || !j.user_code || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0)
    throw new Error('Invalid OpenAI Codex device code response');
  return { deviceAuthId: String(j.device_auth_id), userCode: String(j.user_code), intervalSeconds };
}

export type Poll = { status: 'complete'; authorizationCode: string; codeVerifier: string } | { status: 'pending' | 'slow_down' } | { status: 'failed'; message: string };
export function devicePoll(status: number, body: string): Poll {
  if (status >= 200 && status <= 299) {
    const j = json(body);
    return j?.authorization_code && j.code_verifier
      ? { status: 'complete', authorizationCode: j.authorization_code, codeVerifier: j.code_verifier }
      : { status: 'failed', message: 'Invalid OpenAI Codex device auth token response' };
  }
  if (status === 403 || status === 404) return { status: 'pending' };
  const error = json(body)?.error;
  const code = typeof error === 'object' ? error?.code : error;
  if (code === 'deviceauth_authorization_pending') return { status: 'pending' };
  if (code === 'slow_down') return { status: 'slow_down' };
  const detail = code === 'deviceauth_expired' || code === 'access_denied' ? `: ${code}` : '';
  return { status: 'failed', message: `OpenAI Codex device auth failed with status ${status}${detail}` };
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
  /** Where every catalogue device sign-in lives instead of each provider's own host; a stand-in for tests and demos. */
  deviceBase?: string;
  /** Which region's device endpoints a provider with regions uses (`minimax` on the cn host). */
  region?: 'global' | 'cn';
};

/** RFC 8628 device authorization, one implementation for every provider the catalogue gives data for: the person
 *  types the code on the provider's page, this polls until the provider says yes. No provider-specific code here. */
const form = async (url: string, fields: Record<string, string>, signal?: AbortSignal) => {
  try {
    const res = await fetch(url, { method: 'POST', signal, headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    if (signal?.aborted) throw new Error('Login cancelled');
    throw e;
  }
};
/** A stand-in base replaces each provider's host, so a demo or test never leaves this device. */
const at = (url: string, base?: string) => !base ? url : new URL(url.substring(url.indexOf('/', url.indexOf('//') + 2)), base.endsWith('/') ? base : `${base}/`).href;
const number = (j: any, field: string, fallback: number) => typeof j?.[field] === 'number' && Number.isFinite(j[field]) && j[field] > 0 ? j[field] : fallback;

/** What the person must type, and where, and the field the poll is keyed by; only http(s) the provider itself chose. */
function deviceAsked(j: any, name: string, minimax: boolean) {
  const uri = typeof j?.verification_uri === 'string' ? j.verification_uri : typeof j?.verification_uri_complete === 'string' ? j.verification_uri_complete : '';
  let url: URL | undefined;
  try { url = new URL(uri); } catch {}
  if (!url || !['https:', 'http:'].includes(url.protocol) || typeof j?.user_code !== 'string' || (!minimax && typeof j?.device_code !== 'string'))
    throw new Error(`${name} did not send a device code to type.`);
  const handle: Record<string, string> = minimax ? { user_code: j.user_code } : { device_code: j.device_code };
  return { handle, userCode: j.user_code as string, verificationUri: url.href,
    intervalSeconds: number(j, 'interval', 5), expiresInSeconds: minimax ? minimaxSeconds(j.expired_in, name) : number(j, 'expires_in', CODE_LIVES_S) };
}

/** A token response as the stored credential, the same shape Pi keeps for every provider. */
function deviceCredential(j: any, name: string, previous?: string): OAuthCredential {
  const refresh = typeof j?.refresh_token === 'string' && j.refresh_token ? j.refresh_token : previous;
  if (typeof j?.access_token !== 'string' || typeof refresh !== 'string')
    throw new Error(`${name} did not return a token for this sign-in.`);
  return { type: 'oauth', access: j.access_token, refresh, expires: Date.now() + number(j, 'expires_in', 3600) * 1000 };
}

/** Keep the credential, or nothing, if the person gave up while it was being written. */
async function keep(credentials: CredentialStore, id: string, c: OAuthCredential, signal?: AbortSignal) {
  let wrote = false;
  await credentials.modify(id, async () => {
    if (signal?.aborted) return undefined;
    wrote = true;
    return c;
  }, { signal });
  if (signal?.aborted) {
    if (wrote) await credentials.delete(id);
    throw new Error('Login cancelled');
  }
}

/** A token step's answer: the credential, a wait for the next poll, or how the sign-in ended. */
type Answer = { credential: OAuthCredential } | { wait: 'pending' | 'slow_down' } | { ended: string };
/** RFC 8628's token answers. */
function rfcAnswer(r: { status: number; body: string }, name: string): Answer {
  if (r.status >= 200 && r.status <= 299) return { credential: deviceCredential(json(r.body), name) };
  const error = json(r.body)?.error;
  if (r.status === 0 || error === 'authorization_pending') return { wait: 'pending' };
  if (error === 'slow_down') return { wait: 'slow_down' };
  return { ended: `${name} device sign-in ${error === 'access_denied' ? 'was declined' : error === 'expired_token' ? 'expired' : `failed (${r.status || 'no answer'})`}.` };
}
/** MiniMax's token answers: a 2xx body whose status is 'success' (the token) or 'error' (a refusal); any other 2xx body
 *  keeps polling. A non-2xx answer ends the sign-in, 400 as the code's expiry, except no answer, which keeps polling. */
function minimaxAnswer(r: { status: number; body: string }, name: string): Answer {
  const ok = r.status >= 200 && r.status <= 299;
  const status = ok ? json(r.body)?.status : undefined;
  if (ok && status === 'success') return { credential: minimaxCredential(json(r.body), name) };
  if (ok && status === 'error') return { ended: `${name} device sign-in was declined.` };
  if (ok || r.status === 0) return { wait: 'pending' };
  return { ended: `${name} device sign-in ${r.status === 400 ? 'expired' : `failed (${r.status})`}.` };
}

/** RFC 8628 device authorization, plus the catalogue's data for a provider whose client differs: `pkce` adds the S256
 *  challenge, `grant` overrides the token grant, and `dialect: 'minimax'` polls by user code with the verifier, reads a
 *  status-field answer and takes the code's absolute expiry. */
async function deviceLogin(pi: string, flow: DeviceFlow, name: string, base: string | undefined, credentials: CredentialStore, { signal, notify }: AuthInteraction): Promise<Credential> {
  const minimax = flow.dialect === 'minimax';
  const pk = flow.pkce ? await pkce() : undefined;
  const asked = await form(at(flow.authorization, base), { client_id: flow.clientId, ...(flow.scope ? { scope: flow.scope } : {}),
    ...(pk ? { code_challenge: pk.challenge, code_challenge_method: 'S256' } : {}), ...flow.form }, signal);
  if (asked.status < 200 || asked.status > 299) throw new Error(`${name} did not start a device sign-in (${asked.status}).`);
  const device = deviceAsked(json(asked.body), name, minimax);
  notify({ type: 'device_code', userCode: device.userCode, verificationUri: device.verificationUri, intervalSeconds: device.intervalSeconds, expiresInSeconds: device.expiresInSeconds } as AuthEvent);
  let interval = Math.max(1000, device.intervalSeconds * 1000);
  for (const deadline = Date.now() + device.expiresInSeconds * 1000; ;) {
    if (Date.now() >= deadline) throw new Error('Device flow timed out');
    // A poll that can't get through waits for the next, as a phone cuts a backgrounded app's network while the
    // person is typing the code on the provider's page.
    const r = await form(at(flow.token, base), { grant_type: flow.grant ?? 'urn:ietf:params:oauth:grant-type:device_code', client_id: flow.clientId, ...device.handle, ...(pk ? { code_verifier: pk.verifier } : {}) }, signal)
      .catch((e) => { if (signal?.aborted) throw e; return { status: 0, body: '' }; });
    const answer = minimax ? minimaxAnswer(r, name) : rfcAnswer(r, name);
    if ('credential' in answer) {
      await keep(credentials, pi, answer.credential, signal);
      return answer.credential;
    }
    if ('ended' in answer) throw new Error(answer.ended);
    if (answer.wait === 'slow_down') interval += 5000;
    await sleep(interval, signal);
  }
}

/** A PKCE verifier and its S256 challenge, for a provider whose device client asks for them. */
const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pkce() {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto.subtle?.digest) throw new Error('This sign-in needs secure random bytes and SHA-256 on this device.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** How long a MiniMax `expired_in` lasts, in seconds: a relative count below the threshold, else an absolute epoch-ms
 *  time (the code step's own shape). */
const MINIMAX_RELATIVE_SECONDS_THRESHOLD = 1e9;
function minimaxSeconds(value: unknown, name: string): number {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  if (n === undefined) throw new Error(`${name} did not say when the sign-in expires.`);
  return n >= MINIMAX_RELATIVE_SECONDS_THRESHOLD ? Math.max(1, Math.ceil((n - Date.now()) / 1000)) : n;
}
/** The pinned upstream engine's token answer as the stored credential (no account id in the token: the row's own id). */
function minimaxCredential(j: any, name: string): OAuthCredential {
  if (typeof j?.access_token !== 'string' || typeof j?.refresh_token !== 'string')
    throw new Error(`${name} did not return a token for this sign-in.`);
  return { type: 'oauth', access: j.access_token, refresh: j.refresh_token, expires: Date.now() + minimaxSeconds(j.expired_in, name) * 1000 };
}

const deviceRefresh = (flow: DeviceFlow, name: string, base?: string) => async (c: OAuthCredential) => {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), 15_000);
  try {
    const r = await form(at(flow.token, base), { grant_type: 'refresh_token', client_id: flow.clientId, refresh_token: c.refresh }, stop.signal);
    if (r.status < 200 || r.status > 299) { throw Object.assign(new Error(`${name} token refresh failed (${r.status})`), { status: r.status, revoked: revoked(r.status, r.body) }); }
    // An answer the provider accepted (2xx) spent the grant even when it cannot be read; keep its status to say so.
    try { return deviceCredential(json(r.body), name, c.refresh); } catch (e) { throw Object.assign(e as Error, { status: r.status }); }
  } finally { clearTimeout(t); }
};

/** A member's engine on phones and in browsers: ChatGPT's device-code sign-in, refresh and sign-out, into `credentials`. */
export function portableEngine(credentials: CredentialStore, { base = 'https://auth.openai.com', deviceBase, region }: EngineOptions = {}): AuthHost {
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
    if (r.status < 200 || r.status > 299) throw Object.assign(new Error(`OpenAI Codex token ${what} failed (${r.status})`), { status: r.status, revoked: revoked(r.status, r.body) });
    try { return credentialOf(json(r.body)); } catch (e) { throw Object.assign(e as Error, { status: r.status }); }
  };
  /** Each provider refreshes at its own token endpoint; a failure never reaches the person as anything but a reason. */
  const refreshOf = (id: string) => {
    const flow = deviceFlow(id, region);
    if (!flow) return async (c: OAuthCredential) => {
      const stop = new AbortController();
      const t = setTimeout(() => stop.abort(), 15_000);
      try { return await tokens('refresh', await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: CLIENT_ID }, true, stop.signal)); }
      catch (e: any) { throw Object.assign(new Error(`OAuth refresh failed for ${id}: ${e?.message ?? e}`), { status: e?.status, revoked: e?.revoked }); }
      finally { clearTimeout(t); }
    };
    const name = nameOf(id);
    // The pinned MiniMax engine has no refresh grant: nothing is sent, and the grant ends so the account needs signing in.
    if (flow.dialect === 'minimax') return async () => { throw Object.assign(new Error(`OAuth refresh failed for ${id}`), { revoked: true }); };
    return async (c: OAuthCredential) => {
      try { return await deviceRefresh(flow, name, deviceBase)(c); }
      catch (e: any) { throw Object.assign(new Error(`OAuth refresh failed for ${id}: ${e?.message ?? e}`), { status: e?.status, revoked: e?.revoked }); }
    };
  };
  const known = (id: string) => { if (!signable(id)) throw new Error(`${id} can't be signed in to on this device`); };
  /** MiniMax has no refresh: its sign-in is due only once the access token has run out. */
  const fixed = (id: string) => deviceFlow(id, region)?.dialect === 'minimax';
  const engine = {
    async login(id: string, _type: string, io: AuthInteraction): Promise<Credential> {
      known(id);
      const flow = deviceFlow(id, region);
      if (flow) return deviceLogin(id, flow, nameOf(id), deviceBase, credentials, io);
      const { signal, notify } = io;
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
          await keep(credentials, id, c, signal);
          return c;
        }
        if (p.status === 'slow_down') interval += 5000;
        await sleep(interval, signal);
      }
    },
    checkAuth: async (id: string) => {
      if (!signable(id)) return undefined;
      try {
        // Wait for a live transaction rather than mistake its before-send marker for a failed sign-in.
        // A false due predicate only reads under the lock; it never sends or saves. A MiniMax sign-in is due only once
        // its token has run out, and then ends without a send.
        const c = await refreshCredential(credentials, id, (current) => fixed(id) && current.expires <= Date.now(), refreshOf(id));
        return c?.type === 'oauth' ? { source: 'OAuth', type: 'oauth' as const } : undefined;
      } catch (e) {
        if (e instanceof RefreshRequiredError) return undefined;
        throw e;
      }
    },
    /** Pi's rule: refresh under the store's lock when under 5 minutes (or `minOAuthValidityMs`) remain, re-checked there,
     *  so a sign-out or another refresh in between wins; undefined once signed out. */
    async getAuth(id: string, { minOAuthValidityMs }: { minOAuthValidityMs?: number } = {}) {
      if (!signable(id)) return undefined;
      const min = fixed(id) ? 0 : Math.max(5 * 60_000, minOAuthValidityMs ?? 0);
      const soon = (c: OAuthCredential) => Date.now() + min >= c.expires;
      // Even a still-valid access token must not bypass quarantine, including a forced refresh after a refusal.
      const c = await refreshCredential(credentials, id, soon, refreshOf(id));
      if (c?.type !== 'oauth') return undefined;
      return { auth: { apiKey: c.access }, source: 'OAuth' };
    },
    logout: (id: string) => credentials.delete(id),
  };
  return engine as unknown as AuthHost;
}

/** Adds the kit's portable device sign-in for a catalogue row the host engine cannot sign in to itself (MiniMax's
 *  user-code flow, which Pi's computer engine has no module for). Every other provider still belongs to `engine`. */
export function withDevice(engine: AuthHost, credentials: CredentialStore, options: EngineOptions = {}): AuthHost {
  const portable = portableEngine(credentials, options);
  const mine = (id: string | Model<Api>) => typeof id === 'string' && deviceFlow(id, options.region)?.dialect !== undefined;
  return {
    login: (id, type, io) => (mine(id) ? portable.login(id, type, io) : engine.login(id, type, io)),
    checkAuth: (id) => (mine(id) ? portable.checkAuth(id) : engine.checkAuth(id)),
    getAuth: (id, opts) => (mine(id) ? portable.getAuth(id as string, opts) : engine.getAuth(id as string, opts)),
    logout: (id) => (mine(id) ? portable.logout(id) : engine.logout(id)),
  } as AuthHost;
}
