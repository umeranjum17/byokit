// Independent implementation of the Hermes manual PKCE protocol (pinned references in README and NOTICE).
// No Node, ambient credentials, installed tools, provider-response logging or backend token collection.
import type { AuthInteraction, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import type { AuthHost } from './accounts.ts';
import { anthropicMessages, type AnthropicRequest } from './anthropic.ts';
import { needsReauth, refreshCredential } from './stores.ts';

export const CLAUDE_PLAN_ID = 'byokit-claude-plan';
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

/** A refused/uncertain rotation requires a new sign-in; its old refresh token must not be tried again. */
export class ClaudePlanExpiredError extends Error {
  readonly code = 'CLAUDE_PLAN_EXPIRED';
  readonly status = 401;
  constructor() { super('Sign in with Claude again.'); this.name = 'ClaudePlanExpiredError'; }
}
export class ClaudePlanPlatformError extends Error {
  readonly code = 'CLAUDE_PLAN_UNSUPPORTED_PLATFORM';
  constructor() { super('Claude sign-in needs secure random bytes and SHA-256 on this device.'); this.name = 'ClaudePlanPlatformError'; }
}
export type ClaudePlanOptions = {
  fetch?: typeof fetch;
  /** Stand-ins for offline tests. Production uses the Hermes-reference endpoints directly. */
  authorizeUrl?: string;
  tokenUrl?: string;
  profileUrl?: string;
  /** On React Native, pass a Web Crypto implementation supplied by the app. */
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  now?: () => number;
};
const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Pending state/verifier never enter persistent storage. */
export async function claudeAuthorization(options: ClaudePlanOptions = {}) {
  const crypto = options.crypto ?? globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto.subtle?.digest) throw new ClaudePlanPlatformError();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(options.authorizeUrl ?? 'https://claude.ai/oauth/authorize');
  url.search = new URLSearchParams({ code: 'true', response_type: 'code', client_id: CLAUDE_CLIENT_ID,
    redirect_uri: REDIRECT, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return { url: url.toString(), verifier, state, redirect: REDIRECT };
}

export function claudeCode(paste: string, state: string) {
  let code: string | null, returned: string | null;
  if (/^https?:\/\//.test(paste)) {
    const url = new URL(paste);
    code = url.searchParams.get('code'); returned = url.searchParams.get('state');
  } else {
    const parts = paste.trim().split('#');
    code = parts.length === 2 ? parts[0] : null; returned = parts.length === 2 ? parts[1] : null;
  }
  if (!code || !returned || returned !== state) throw new Error('The Claude sign-in code does not match this sign-in. Try signing in again.');
  return code;
}

const credential = (j: any, now: number, previous?: OAuthCredential): OAuthCredential => {
  if (typeof j?.access_token !== 'string' || !j.access_token || typeof j.expires_in !== 'number'
    || !Number.isFinite(j.expires_in) || j.expires_in <= 0 || !Number.isFinite(now + j.expires_in * 1000)
    || (j.refresh_token !== undefined && (typeof j.refresh_token !== 'string' || !j.refresh_token)))
    throw new Error('Claude could not complete the sign-in. Try signing in again.');
  return { type: 'oauth', access: j.access_token, refresh: j.refresh_token ?? previous?.refresh ?? '', expires: now + j.expires_in * 1000 };
};

type State = { flight?: Promise<OAuthCredential | undefined>; spent: Set<string> };
const states = new WeakMap<CredentialStore, State>();

/** Adds only BYOKit's own Claude route; every other provider still belongs to the supplied engine. */
export function withClaudePlan(engine: AuthHost, credentials: CredentialStore, lockKey: CredentialStore, options: ClaudePlanOptions = {}): AuthHost {
  let shared = states.get(lockKey);
  if (!shared) states.set(lockKey, shared = { spent: new Set() });
  const state = shared;
  const now = options.now ?? Date.now;
  const post = async (body: object, signal?: AbortSignal) => {
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(options.tokenUrl ?? 'https://platform.claude.com/v1/oauth/token', {
        method: 'POST', signal: signal ?? AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', 'user-agent': 'axios/1.7.9' }, body: JSON.stringify(body),
      });
    } catch { throw new Error('Claude could not complete the sign-in on this connection.'); }
    if (!res.ok) {
      if ([400, 401, 403].includes(res.status)) throw new ClaudePlanExpiredError();
      throw new Error('Claude could not complete the sign-in. Try again later.');
    }
    try { return await res.json(); } catch { throw new Error('Claude could not complete the sign-in. Try signing in again.'); }
  };
  const login = async ({ signal, notify, prompt }: AuthInteraction) => {
    const pending = await claudeAuthorization(options);
    if (signal?.aborted) throw new Error('Login cancelled');
    // Register the paste receiver before publishing the URL, so an immediate paste cannot be lost.
    const pasted = prompt({ type: 'manual_code', message: 'Paste the code from the Claude page.', signal });
    notify({ type: 'auth_url', url: pending.url });
    const code = claudeCode(await pasted, pending.state);
    if (signal?.aborted) throw new Error('Login cancelled');
    const c = credential(await post({ grant_type: 'authorization_code', client_id: CLAUDE_CLIENT_ID,
      code, state: pending.state, redirect_uri: pending.redirect, code_verifier: pending.verifier }, signal), now());
    if (signal?.aborted) throw new Error('Login cancelled');
    try { await credentials.modify(CLAUDE_PLAN_ID, async () => c, { signal }); }
    catch { throw new Error('Claude sign-in could not be saved on this device. Try signing in again.'); }
    if (signal?.aborted) { await credentials.delete(CLAUDE_PLAN_ID); throw new Error('Login cancelled'); }
    return c;
  };
  const access = async (minOAuthValidityMs = 0) => {
    const min = Math.max(300_000, minOAuthValidityMs);
    const due = (c: OAuthCredential) => now() + min >= c.expires;
    const c = await credentials.read(CLAUDE_PLAN_ID);
    if (c?.type !== 'oauth') return undefined;
    if (state.flight) return state.flight;
    if (needsReauth(c) || state.spent.has(c.refresh)) throw new ClaudePlanExpiredError();
    if (!due(c)) return c;
    const work = refreshCredential(credentials, CLAUDE_PLAN_ID, due, async (current) => {
      if (!current.refresh || state.spent.has(current.refresh)) throw new ClaudePlanExpiredError();
      state.spent.add(current.refresh);
      return credential(await post({ grant_type: 'refresh_token', client_id: CLAUDE_CLIENT_ID, refresh_token: current.refresh }), now(), current);
    }).catch(async () => {
      await credentials.delete(CLAUDE_PLAN_ID).catch(() => {});
      throw new ClaudePlanExpiredError();
    });
    state.flight = work;
    try {
      const next = await work;
      if (next) state.spent.delete(next.refresh);
      return next;
    } finally { if (state.flight === work) state.flight = undefined; }
  };
  return Object.assign(engine, {
    login: ((original) => (id: string, type: 'oauth' | 'api_key', interaction: AuthInteraction) =>
      id === CLAUDE_PLAN_ID ? login(interaction) : original.call(engine, id, type, interaction))(engine.login),
    logout: ((original) => (id: string) => id === CLAUDE_PLAN_ID ? credentials.delete(id) : original.call(engine, id))(engine.logout),
    checkAuth: ((original) => async (id: string) => id === CLAUDE_PLAN_ID
      ? await (async () => { const c = await credentials.read(id); return c?.type === 'oauth' && !needsReauth(c) ? { source: 'OAuth', type: 'oauth' as const } : undefined; })()
      : original.call(engine, id))(engine.checkAuth),
    getAuth: ((original) => async (id: any, overrides?: { minOAuthValidityMs?: number }) => {
      if (id !== CLAUDE_PLAN_ID) return original.call(engine, id, overrides);
      const c = await access(overrides?.minOAuthValidityMs);
      return c ? { auth: { apiKey: c.access }, source: 'OAuth' } : undefined;
    })(engine.getAuth),
  });
}

/** Which Claude plan a sign-in is (`max`, `pro`, `team`, `enterprise`), from the provider's own profile; '' when it
 *  doesn't say. `work`: a Team or Enterprise plan, which follows the employer's rules. */
export async function claudeProfile(access: string, options: Pick<ClaudePlanOptions, 'fetch' | 'profileUrl'> = {}) {
  const res = await (options.fetch ?? fetch)(options.profileUrl ?? 'https://api.anthropic.com/api/oauth/profile', {
    headers: { authorization: `Bearer ${access}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error('Claude could not say which plan this is.');
  const j: any = await res.json();
  const type = String(j?.organization?.organization_type ?? '').toLowerCase().replace(/^claude_/, '');
  const plan = /^[a-z][a-z0-9_]{0,31}$/.test(type) ? type : j?.account?.has_claude_max ? 'max' : j?.account?.has_claude_pro ? 'pro' : '';
  const email = j?.account?.email ?? j?.account?.email_address;
  return { plan, email: typeof email === 'string' ? email : '', work: /^(team|enterprise)/.test(plan) };
}

/** Hermes's baseline native-client fingerprint. No installed CLI is consulted for its version. */
export function claudePlanMessages(access: string, options: { fetch?: typeof fetch } = {}) {
  return anthropicMessages({ ...options, headers: {
    authorization: `Bearer ${access}`, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'user-agent': 'claude-code/2.1.74 (external, cli)', 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true',
  }, prepare: (request: AnthropicRequest) => ({ ...request, system: [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ...(typeof request.system === 'string' ? [{ type: 'text' as const, text: request.system }] : request.system ?? []),
  ] }), safeErrors: true });
}
