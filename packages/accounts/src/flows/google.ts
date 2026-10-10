// Google Cloud Code Assist sign-in for @byokit/accounts on a computer: PKCE on Google's own page, the browser returning
// to the loopback port the app listens on (or the person pasting the redirect address), then the code exchange and
// userinfo. An independent implementation of the protocol the upstream Google CLI uses; the recorded facts are the
// fixture (fixtures/conformance/google-oauth-typescript.json). The public OAuth client id is reused as the upstream
// implementation does (the C3 decision in docs/runtime-kits.md); no client secret or upstream code is included.
// No Node import here: the portable bundle carries this file, so it uses Web Crypto only.
import type { AuthInteraction, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import type { AuthHost } from '../accounts.ts';
import { RefreshRequiredError, refreshCredential, revoked } from '../stores.ts';

/** The Pi provider id this flow signs in to. Both Google clients reuse the one flow; they differ in data only. */
export type GoogleClient = 'google-gemini-cli' | 'google-antigravity';

export type GoogleProtocol = {
  authorize: string;
  token: string;
  userinfo: string;
  clientId: string;
  scopes: string[];
  /** The upstream fresh-sign-in parameters the client sends (the C3 decision: whichever the parity snapshot uses). */
  authorizeParams: Record<string, string>;
  /** The loopback host, path and the fixed port the client registers; the port comes from here unless an app moves it. */
  callback: { hostname: string; path: string; port: number };
  /** Cloud Code Assist: the service that holds the account's project, and the client metadata its calls carry. */
  codeAssist: string;
  metadata: Record<string, string>;
};

/** Public client id, reused from the open-source upstream as the upstream implementations do. No secret. */
export const GOOGLE_CLIENTS: Record<GoogleClient, GoogleProtocol> = {
  'google-gemini-cli': {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    callback: { hostname: '127.0.0.1', path: '/oauth2callback', port: 8085 },
    codeAssist: 'https://cloudcode-pa.googleapis.com',
    metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  },
  'google-antigravity': {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    callback: { hostname: '127.0.0.1', path: '/oauth-callback', port: 51121 },
    codeAssist: 'https://daily-cloudcode-pa.googleapis.com',
    metadata: { ideType: 'ANTIGRAVITY' },
  },
};

export type GoogleOptions = {
  fetch?: typeof fetch;
  /** A stand-in base for offline tests and demos (`mockGoogle()` from @byokit/accounts/testing). */
  base?: string;
  /** An app-set loopback port, moved off the client's fixed one; the redirect address and the listener move together. */
  callbackPort?: number;
};

const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A stand-in base replaces Google's host, so a test or demo never leaves this device. */
const at = (url: string, base?: string) => !base ? url : new URL(url.substring(url.indexOf('/', url.indexOf('//') + 2)), base.endsWith('/') ? base : `${base}/`).href;
/** A stalled Google endpoint ends the call after 15 seconds, even when the sign-in itself has no deadline. */
const bounded = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);

/** The redirect address the client registers: the loopback host and path, on the port the kit listens on. */
export const googleRedirect = (client: GoogleProtocol, port: number) => `http://${client.callback.hostname}:${port}${client.callback.path}`;

/** Whether a Pi provider id is a Google client this flow signs in. */
export const isGoogleClient = (pi: string): pi is GoogleClient => pi in GOOGLE_CLIENTS;

/** The Google client a `google-...:<via>` route id names, so the kit routes both clients to this one flow. */
export const googleRouteClient = (id: string): GoogleClient | undefined => (Object.keys(GOOGLE_CLIENTS) as GoogleClient[]).find((client) => id.startsWith(`${client}:`));

/** Google's documented OAuth revoke endpoint, on the `googleBase` stand-in when an app sets one. The refresh token goes
 *  only to Google's own host (or its stand-in); `authBase` is OpenAI's and never receives a Google call. */
export const googleRevokeUrl = (base?: string) => at('https://oauth2.googleapis.com/revoke', base);

/** Ends a Google sign-in at Google's revoke endpoint (RFC 7009): the refresh token, else the access token, as one form
 *  field, never retried. A refused revoke throws a message that never names the token; the caller deletes the local copy. */
export async function googleRevoke(url: string, c: { access: string; refresh: string }, doFetch: typeof fetch = fetch) {
  const body = new URLSearchParams({ token: c.refresh || c.access }).toString();
  const response = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Google sign-out failed (${response.status})`);
}

/** Pending state/verifier never enter persistent storage. */
export async function googleAuthorization(id: GoogleClient, options: GoogleOptions) {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto.subtle?.digest) throw new Error('Google sign-in needs secure random bytes and SHA-256 on this device.');
  const client = GOOGLE_CLIENTS[id];
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const redirect = googleRedirect(client, options.callbackPort ?? client.callback.port);
  const url = new URL(at(client.authorize, options.base));
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: redirect,
    scope: client.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', ...client.authorizeParams }).toString();
  return { url: url.toString(), verifier, state, redirect };
}

/** The code from the redirect address the browser landed on (or a raw code), checked against this sign-in's state. */
export function googleCode(paste: string, state: string) {
  const text = paste.trim();
  if (!text) throw new Error('Paste the address the Google page returned to.');
  if (!/\?|code=|state=/.test(text)) return text;
  const params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1) : text);
  if (params.get('state') !== state) throw new Error('The Google sign-in code does not match this sign-in. Try signing in again.');
  if (params.get('error')) throw new Error(params.get('error')!);
  const code = params.get('code');
  if (!code) throw new Error('The Google sign-in code does not match this sign-in. Try signing in again.');
  return code;
}

/** An individual Google account with no allowed Code Assist tier (the sunset): the sign-in is refused, and the caller
 *  keeps nothing. The message is only read for the person's plain sentence; the tier answer never reaches a log. */
export class CodeAssistIneligibleError extends Error {
  readonly status = 403;
  constructor() { super('This Google account is not eligible for Code Assist. Try another account.'); this.name = 'CodeAssistIneligibleError'; }
}

/** The project each freshly signed-in credential discovered, keyed by the credential object itself. It is non-secret
 *  account metadata: it never enters the credential, a log or an error, and the accounts index records it by account id. */
const projects = new WeakMap<object, string>();
export const googleProject = (c: unknown): string | undefined => typeof c === 'object' && c ? projects.get(c as object) : undefined;

/** Cloud Code Assist host, or the app's stand-in (`googleBase`) in tests. */
const codeAssistHost = (client: GoogleProtocol, base?: string) => base ? base.replace(/\/+$/, '') : client.codeAssist;

/** The account's Code Assist project id after a fresh sign-in: the one it already has, or the default tier's onboardUser
 *  result, whose operation is polled until done. An account with no allowed tier ends the sign-in typed, and nothing is
 *  kept. The id is returned, never logged or thrown; only the plain refusal is. */
async function codeAssistProject(client: GoogleProtocol, access: string, doFetch: typeof fetch, base: string | undefined, signal?: AbortSignal): Promise<string> {
  const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${access}` };
  const call = async (method: string, body?: Record<string, unknown>) => {
    let res: Response;
    try { res = await doFetch(`${codeAssistHost(client, base)}/v1internal:${method}`, { method: 'POST', signal: bounded(signal), headers, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw Object.assign(new Error('Google could not set up Code Assist on this connection.'), { status: 0 }); }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw Object.assign(new Error('Google could not set up Code Assist for this account.'), { status: res.status });
    try { return JSON.parse(text); } catch { throw new Error('Google could not set up Code Assist for this account.'); }
  };
  const idOf = (value: any): string | undefined => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : undefined;
  const loaded = await call('loadCodeAssist', { metadata: client.metadata });
  // An account can carry an ineligible free tier beside the project it already has or a paid tier it is allowed: take
  // the project it has first; only an account with no project and no allowed tier to onboard is refused.
  const existing = idOf(loaded?.cloudaicompanionProject);
  if (existing) return existing;
  const tiers: any[] = Array.isArray(loaded?.allowedTiers) ? loaded.allowedTiers : [];
  const tier = tiers.find((t) => t?.isDefault) ?? tiers[0];
  if (!tier) throw new CodeAssistIneligibleError();
  let operation = await call('onboardUser', { ...(tier?.id ? { tierId: String(tier.id) } : {}), metadata: client.metadata });
  for (let tries = 0; !operation?.done && operation?.name && tries < 20; tries++) {
    if (signal?.aborted) throw new Error('Login cancelled');
    await new Promise((r) => setTimeout(r, 500));
    let res: Response;
    try { res = await doFetch(`${codeAssistHost(client, base)}/v1internal/${operation.name}`, { signal: bounded(signal), headers }); }
    catch { throw Object.assign(new Error('Google could not set up Code Assist on this connection.'), { status: 0 }); }
    if (!res.ok) throw Object.assign(new Error('Google could not set up Code Assist for this account.'), { status: res.status });
    operation = await res.json().catch(() => ({}));
  }
  const provisioned = idOf(operation?.response?.cloudaicompanionProject);
  if (!provisioned) throw new Error('Google could not set up Code Assist for this account.');
  return provisioned;
}

const credential = (j: any, now: number, previous?: string): OAuthCredential => {
  if (typeof j?.access_token !== 'string' || !j.access_token || typeof j.expires_in !== 'number' || !Number.isFinite(j.expires_in) || j.expires_in <= 0)
    throw new Error('Google could not complete the sign-in. Try signing in again.');
  const refresh = typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : previous;
  if (typeof refresh !== 'string' || !refresh) throw new Error('Google did not return a lasting sign-in. Try signing in again.');
  return { type: 'oauth', access: j.access_token, refresh, expires: now + j.expires_in * 1000 };
};

/** Adds only BYOKit's own Google routes; every other provider still belongs to the supplied engine. */
export function withGoogle(engine: AuthHost, credentials: CredentialStore, options: GoogleOptions): AuthHost {
  const isGoogle = isGoogleClient;
  const post = async (url: string, body: Record<string, string>, signal?: AbortSignal) => {
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(url, { method: 'POST', signal: bounded(signal), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
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
    const grant = credential(token, Date.now());
    // The email is display metadata: a failed lookup leaves the account without one rather than failing the sign-in.
    const info = await (options.fetch ?? fetch)(at(client.userinfo, options.base), { headers: { authorization: `Bearer ${grant.access}`, accept: 'application/json' }, signal: bounded(signal) }).catch(() => undefined);
    const email = info?.ok ? String((await info.json().catch(() => null) as { email?: string } | null)?.email ?? '') : '';
    // Code Assist discovery runs before the sign-in is saved, so a refused account keeps no credential at all. The
    // project id is held beside the credential (non-secret metadata) and never written into it.
    const project = await codeAssistProject(client, grant.access, options.fetch ?? fetch, options.base, signal);
    if (signal?.aborted) throw new Error('Login cancelled');
    const c = { ...grant, ...(email ? { accountId: email, email } : {}) } as OAuthCredential;
    projects.set(c, project);
    if (signal?.aborted) throw new Error('Login cancelled');
    try { await credentials.modify(id, async () => c, { signal }); }
    catch { throw new Error('Google sign-in could not be saved on this device. Try signing in again.'); }
    if (signal?.aborted) { await credentials.delete(id); throw new Error('Login cancelled'); }
    return c;
  };
  const access = async (id: GoogleClient, minOAuthValidityMs = 0) => {
    const client = GOOGLE_CLIENTS[id];
    const min = Math.max(300_000, minOAuthValidityMs);
    const due = (c: OAuthCredential) => Date.now() + min >= c.expires;
    const c = await credentials.read(id);
    if (c?.type !== 'oauth') return undefined;
    return refreshCredential(credentials, id, due, async (current) => {
      if (!current.refresh) throw new RefreshRequiredError();
      const next = credential(await post(at(client.token, options.base), { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: current.refresh }), Date.now(), current.refresh);
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
