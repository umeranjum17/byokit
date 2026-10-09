// Google Cloud Code Assist sign-in for @byokit/accounts on a computer: PKCE on Google's own page, the browser returning
// to the client's fixed loopback port (or the person pasting the redirect address), then the code exchange and userinfo.
// An independent implementation of the protocol the two upstream Google clients use; the recorded facts are the
// fixture (fixtures/conformance/google-oauth-typescript.json). The public OAuth client ids are reused as the upstream
// implementations do (the C3 decision in docs/runtime-kits.md); no client secret or upstream code is included.
// No Node import here: the portable bundle carries this file, so it uses Web Crypto only.
import type { AuthInteraction, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import type { AuthHost } from '../accounts.ts';
import { RefreshRequiredError, refreshCredential, revoked } from '../stores.ts';

/** The Pi provider ids this flow signs in to. Both clients share the protocol and differ only in the data below. */
export type GoogleClient = 'google-gemini-cli' | 'google-antigravity';

export type GoogleProtocol = {
  authorize: string;
  token: string;
  userinfo: string;
  clientId: string;
  scopes: string[];
  /** The upstream fresh-sign-in parameters the client sends (the C3 decision: whichever the parity snapshot uses). */
  authorizeParams: Record<string, string>;
  callback: { hostname: string; port: number; path: string };
};

/** Public client ids, reused from the open-source upstream CLIs as the upstream implementations do. No secret. */
export const GOOGLE_CLIENTS: Record<GoogleClient, GoogleProtocol> = {
  'google-gemini-cli': {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    callback: { hostname: '127.0.0.1', port: 8085, path: '/oauth2callback' },
  },
  'google-antigravity': {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    callback: { hostname: '127.0.0.1', port: 51121, path: '/oauth-callback' },
  },
};

export type GoogleOptions = {
  fetch?: typeof fetch;
  /** A stand-in base for offline tests and demos (`mockGoogle()` from @byokit/accounts/testing). */
  base?: string;
  now?: () => number;
};

const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A stand-in base replaces Google's host, so a test or demo never leaves this device. */
const at = (url: string, base?: string) => !base ? url : new URL(url.substring(url.indexOf('/', url.indexOf('//') + 2)), base.endsWith('/') ? base : `${base}/`).href;

/** The redirect address the client registers: the loopback port and path from the pinned client. */
export const googleRedirect = (client: GoogleProtocol) => `http://${client.callback.hostname}:${client.callback.port}${client.callback.path}`;

/** Pending state/verifier never enter persistent storage. */
export async function googleAuthorization(id: GoogleClient, options: GoogleOptions = {}) {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto.subtle?.digest) throw new Error('Google sign-in needs secure random bytes and SHA-256 on this device.');
  const client = GOOGLE_CLIENTS[id];
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(at(client.authorize, options.base));
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: googleRedirect(client),
    scope: client.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', ...client.authorizeParams }).toString();
  return { url: url.toString(), verifier, state, redirect: googleRedirect(client) };
}

/** The code from the redirect address the browser landed on (or a raw code), checked against this sign-in's state. */
export function googleCode(paste: string, state: string) {
  const text = paste.trim();
  if (/^https?:\/\//.test(text)) {
    const url = new URL(text);
    const code = url.searchParams.get('code');
    const returned = url.searchParams.get('state');
    if (!code || returned !== state) throw new Error('The Google sign-in code does not match this sign-in. Try signing in again.');
    return code;
  }
  if (!text) throw new Error('Paste the address the Google page returned to.');
  return text;
}

const credential = (j: any, now: number, previous?: string): OAuthCredential => {
  if (typeof j?.access_token !== 'string' || !j.access_token || typeof j.expires_in !== 'number' || !Number.isFinite(j.expires_in) || j.expires_in <= 0)
    throw new Error('Google could not complete the sign-in. Try signing in again.');
  const refresh = typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : previous;
  if (typeof refresh !== 'string' || !refresh) throw new Error('Google did not return a lasting sign-in. Try signing in again.');
  return { type: 'oauth', access: j.access_token, refresh, expires: now + j.expires_in * 1000 };
};

/** Adds only BYOKit's own Google routes; every other provider still belongs to the supplied engine. */
export function withGoogle(engine: AuthHost, credentials: CredentialStore, options: GoogleOptions = {}): AuthHost {
  const now = options.now ?? Date.now;
  const isGoogle = (id: string): id is GoogleClient => id in GOOGLE_CLIENTS;
  const post = async (url: string, body: Record<string, string>, signal?: AbortSignal) => {
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(url, { method: 'POST', signal: signal ?? AbortSignal.timeout(15_000), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
    } catch { throw new Error('Google could not complete the sign-in on this connection.'); }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // Only invalid_grant proves the grant revoked; any other refusal may pass, and the sign-in is kept.
      if (revoked(res.status, text)) throw Object.assign(new Error('Sign in with Google again.'), { revoked: true, status: res.status });
      throw Object.assign(new Error('Google could not complete the sign-in. Try again later.'), { status: res.status });
    }
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Google could not complete the sign-in. Try signing in again.'), { status: res.status }); }
  };
  const login = async (id: GoogleClient, { signal, notify, prompt }: AuthInteraction) => {
    const client = GOOGLE_CLIENTS[id];
    const pending = await googleAuthorization(id, options);
    if (signal?.aborted) throw new Error('Login cancelled');
    // Register the paste receiver before publishing the URL, so an immediate return or paste cannot be lost.
    const pasted = prompt({ type: 'manual_code', message: 'Paste the address the Google page returned to.', signal });
    notify({ type: 'auth_url', url: pending.url });
    const code = googleCode(await pasted, pending.state);
    if (signal?.aborted) throw new Error('Login cancelled');
    const token = await post(at(client.token, options.base), { grant_type: 'authorization_code', client_id: client.clientId,
      code, code_verifier: pending.verifier, redirect_uri: pending.redirect }, signal);
    if (signal?.aborted) throw new Error('Login cancelled');
    const info = await (options.fetch ?? fetch)(at(client.userinfo, options.base), { headers: { authorization: `Bearer ${String(token.access_token)}`, accept: 'application/json' }, signal });
    const email = info.ok ? String(((await info.json().catch(() => ({}))) as { email?: string }).email ?? '') : '';
    const c = { ...credential(token, now()), ...(email ? { accountId: email, email } : {}) } as OAuthCredential;
    if (signal?.aborted) throw new Error('Login cancelled');
    try { await credentials.modify(id, async () => c, { signal }); }
    catch { throw new Error('Google sign-in could not be saved on this device. Try signing in again.'); }
    if (signal?.aborted) { await credentials.delete(id); throw new Error('Login cancelled'); }
    return c;
  };
  const access = async (id: GoogleClient, minOAuthValidityMs = 0) => {
    const client = GOOGLE_CLIENTS[id];
    const min = Math.max(300_000, minOAuthValidityMs);
    const due = (c: OAuthCredential) => now() + min >= c.expires;
    const c = await credentials.read(id);
    if (c?.type !== 'oauth') return undefined;
    return refreshCredential(credentials, id, due, async (current) => {
      if (!current.refresh) throw new RefreshRequiredError();
      const next = credential(await post(at(client.token, options.base), { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: current.refresh }), now(), current.refresh);
      // The account identity is non-secret metadata; a rotation keeps it, so the same person is not a new account.
      return { ...next, ...(current.accountId ? { accountId: current.accountId } : {}), ...(current.email ? { email: current.email } : {}) };
    });
  };
  return Object.assign(engine, {
    login: ((original) => (id: string, type: 'oauth' | 'api_key', interaction: AuthInteraction) =>
      isGoogle(id) ? login(id, interaction) : original.call(engine, id, type, interaction))(engine.login),
    logout: ((original) => (id: string) => isGoogle(id) ? credentials.delete(id) : original.call(engine, id))(engine.logout),
    checkAuth: ((original) => async (id: string) => {
      if (!isGoogle(id)) return original.call(engine, id);
      const c = await credentials.read(id);
      return c?.type === 'oauth' ? { source: 'OAuth', type: 'oauth' as const } : undefined;
    })(engine.checkAuth),
    getAuth: ((original) => async (id: any, overrides?: { minOAuthValidityMs?: number }) => {
      if (!isGoogle(id)) return original.call(engine, id, overrides);
      const c = await access(id, overrides?.minOAuthValidityMs);
      return c ? { auth: { apiKey: c.access }, source: 'OAuth' } : undefined;
    })(engine.getAuth),
  });
}
