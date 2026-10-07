// Sign in with the AI plan you already pay for, one person at a time, into that person's own store. Sharing one
// person's plan breaks the vendors' terms, so every sign-in, rest and refresh is keyed by member and account.
// The engine does the signing in (Pi's own flows on a computer, portableEngine on phones and in browsers); the app only
// shows the provider's page to open or the code to type. No Node import here: see index.ts for the computer's side.
import type { Keystore } from '@byokit/secrets';
import type { Api, ApiStreamOptions, AssistantMessage, AssistantMessageEventStream, AuthPrompt, CredentialStore, Model, Models, Context } from '@earendil-works/pi-ai';
import { cloudSelection, CloudAccountError, type CloudOptions, type CloudStream } from './cloud.ts';
import type { AiBinding } from '@earendil-works/pi-ai/api/cloudflare-ai-binding';
import { CLAUDE_PLAN_ID, ClaudePlanExpiredError, claudePlanMessages, claudeProfile, withClaudePlan, type ClaudePlanOptions } from './claude-plan.ts';
import { anthropic, type AnthropicAsk, type AnthropicResult, type AnthropicTool } from './anthropic.ts';
import { offered, provider, route, routes, type Provider, type RouteView, type Readiness, type RouteHost } from './catalogue.ts';
import { endpointConfig, endpointLabel, endpointNeedsHost, EndpointError, type EndpointDriver, type EndpointOptions, type EndpointConfig } from './endpoints.ts';
import { checkKeyModel, keyRespond, KeyRouteError, type KeyAsk, type KeyRuntime } from './key-routes.ts';
import { claims, PORTABLE, portableEngine, signable } from './engine.ts';
import { classify, REST_MS, type Kind } from './limits.ts';
import { respond, ResponseError, type Ask, type ResponseResult, type ResponseTool } from './responses.ts';
import type { ChatGPTRespondAccount } from './chatgpt-plan.ts';
import { emptyIndex, viewStore, memoryStore, refreshCredential, type AccountMetadata, type EndingStore, type RefreshStore } from './stores.ts';
import type { Account, Defaults, Via } from './multi.ts';
import type { Credential } from '@earendil-works/pi-ai';
import { callbackPage, clock, failure, say, signInError, type WordKey, type Why } from './words.ts';

/** What signing in needs from an engine: Pi's `Models`, or anything shaped like it (the coding agent's `ModelRuntime`). */
type BoundStore = CredentialStore & Partial<Pick<RefreshStore, 'refresh'>> & { signOut: (id: string, p: Provider) => Promise<void> };
export type AuthHost = Pick<Models, 'login' | 'logout' | 'checkAuth' | 'getAuth'> & { readCredential: CredentialStore['read']; credentialStore: BoundStore };
export type Member = string | number;
/** What the person sees while signing in: the provider's own page to open (`via: 'browser'`), or a code to type there
 *  (`via: 'code'`), never the engine's own prompts. `why` names how a failed one failed, for apps that word it themselves. */
/** Explicit method selection; Claude defaults to paste. Enterprise domains apply only to Copilot.
 *  OpenRouter authorization creates an API-billed key: billedPerUse explicitly selects that billing. */
export type SignInOptions = { via?: 'browser' | 'code' | 'paste'; fresh?: boolean; enterpriseDomain?: string; billedPerUse?: true };
export type SignIn = { id?: string; state: 'waiting' | 'done' | 'failed'; via?: 'browser' | 'code'; url?: string; code?: string; expiresAt?: number; error?: string; why?: Why };
export type Status = { id: string; provider: string; account: string; name: string; state: 'ready' | 'signing' | 'resting' | 'signed_out' | 'needs_again' | 'not_included'; until?: number; words: string };
type Flow = SignIn & { generation: number; abort: AbortController; paste?: (text: string) => void; refuse?: (e: Error) => void; timedOut?: boolean; toCode?: boolean;
  oauthState?: string; done?: Promise<void>; shown?: () => void };

/** Listens on this computer for the provider's page coming back: each request's path in, the page to answer with out. */
export type Loopback = (port: number, handle: (path: string) => Promise<{ status: number; html: string }>) => Promise<{ close(): void }>;
/** What differs by platform: the engine that signs in, which providers it can, and (on a computer) a loopback listener. */
export type Platform = { kind?: 'node' | 'browser' | 'rn'; keys?: () => Promise<KeyRuntime>; engine: (credentials: CredentialStore, authBase?: string, deviceBase?: string) => AuthHost; signsIn: (pi: string) => boolean; loopback?: Loopback; endpoint?: EndpointDriver; cloudStream?: CloudStream };
/** Phones and browsers: any provider whose catalogue row carries RFC 8628 device data (ChatGPT on its own flow), no
 *  listener. Key routes answer once `withKeys` from `@byokit/accounts/keys` adds their runtime, which this entry never imports. */
export const portable: Platform = { kind: 'browser', engine: (c, base, deviceBase) => portableEngine(c, { base, deviceBase }), signsIn: (pi) => pi === CLAUDE_PLAN_ID || signable(pi) };

export type ClaudePlanAsk = AnthropicAsk & { provider: 'claude' };

export type AnthropicAccountAsk = AnthropicAsk & { provider: 'anthropic'; key: string };

export type AccountsOptions<M extends Member = Member> = {
  /** The accounts this app offers, in order. Default: every subscription provider supported on this platform. */
  offer?: readonly string[];
  /** Each member's own store. Default: in memory. */
  store?: (member: M) => CredentialStore;
  /** Device-owned @byokit/secrets store per member. Required to save API keys; no plaintext fallback. */
  keyStore?: (member: M) => Keystore;
  /** Same-device pinned Pi endpoint driver for browser/RN hosts; no remote credential forwarding. */
  endpointDriver?: EndpointDriver;
  /** The host driver can reach loopback on this device (never inferred from billing). */
  endpointHost?: boolean;
  /** Explicit app-owned Workers AI binding by the selected non-secret name; never called at save/list/default time. */
  cloudBinding?: (member: M, name: string) => AiBinding | undefined;
  /** The app's name, for the page the provider's sign-in sends the browser back to. */
  app?: string;
  /** Longest a sign-in may wait: longer than any provider's code lives. */
  signInMs?: number;
  /** No redirect back by then: the page is probably stuck (or on a phone), so a code takes over by itself. */
  redirectMs?: number;
  /** Listen here for the provider's redirect instead of its fixed port (tests, so they never meet a real sign-in). */
  callbackPort?: number;
  /** Where OpenAI's sign-in lives, for a stand-in in tests and demos (`mockOpenAI()` from `@byokit/accounts/testing`).
   *  Phones and browsers sign in and sign out there; on a computer Pi's engine always calls OpenAI, and only sign-out's
   *  revoke goes here. */
  authBase?: string;
  /** Where every catalogue device sign-in goes instead of each provider's own host, for a stand-in in tests and
   *  demos (`mockDevice()` from `@byokit/accounts/testing`). */
  deviceBase?: string;
  /** Where ChatGPT answers `respond`, for a stand-in in tests and demos. */
  apiBase?: string;
  /** Anthropic Messages origin: an app-owned proxy or stand-in. */
  anthropicBase?: string;
  /** Claude PKCE transport and Web Crypto supplied by the app (React Native). */
  claudePlan?: ClaudePlanOptions;
  /** The fetch `respond` asks with: one that streams on a phone (Expo's `expo/fetch`). Default: the platform's. */
  fetch?: typeof fetch;
  /** The originator header `respond` sends. Default: 'byokit'. */
  originator?: string;
};

/** The ChatGPT plan behind a sign-in, from its own token: a work plan (Business, Enterprise, Edu) follows the employer's rules. */
export function planOf(access: string): { plan: string; email: string; work: boolean } {
  let c: any = {};
  try { c = claims(access); } catch {}
  const plan = String(c['https://api.openai.com/auth']?.chatgpt_plan_type ?? '').toLowerCase();
  return { plan, email: String(c['https://api.openai.com/profile']?.email ?? c.email ?? ''), work: /^(team|business|enterprise|edu|education|k12)/.test(plan) };
}

const ports = new Set<number>();
const offline = (e: any) => failure(String(e?.message)) === 'offline';

/** Ends a sign-in on the provider's side, as Codex's own logout does (openai/codex#17825): the refresh token, else the
 *  access token, never retried (fixtures/conformance/revoke.json). */
async function revoke(url: string, clientId: string | undefined, c: { access: string; refresh: string }) {
  const body = c.refresh ? { token: c.refresh, token_type_hint: 'refresh_token', client_id: clientId } : { token: c.access, token_type_hint: 'access_token' };
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`ChatGPT sign-out failed (${response.status})`);
}

export class Accounts<R extends AuthHost = AuthHost, M extends Member = Member> {
  readonly providers: Provider[];
  private opts: AccountsOptions<M>;
  private runtimes = new Map<string, Promise<R>>();
  private stores = new Map<string, EndingStore>();
  private baseStores = new Map<string, CredentialStore>();
  private generations = new Map<string, number>();
  private signals = new WeakMap<AbortSignal, number>();
  private chains = new Map<string, Promise<void>>();
  private signingOut = new Map<string, Promise<void>>();
  private flows = new Map<string, Flow>();
  private ready = new Map<string, boolean>();
  private lapsed = new Set<string>();
  /** Signed in, but the plan doesn't include this use (ChatGPT's own "usage not included"). ponytail: in memory, so a
   *  restart simply tries once more. */
  private without = new Set<string>();
  private rests = new Map<string, { until: number; kind: Kind }>();
  /** Which Claude plan each member signed in with, read once per sign-in. */
  private claudePlans = new Map<string, { refresh: string; read: Promise<{ plan: string; email: string; work: boolean }> }>();
  onChange?: (member: M, key: string) => void;
  /** A sign-in just finished and works. */
  onSignedIn?: (member: M, key: string) => void;
  /** Said once when a sign-in can no longer be refreshed. */
  onExpired?: (member: M, key: string) => void;
  onSignOutError?: (member: M, key: string, error: Error) => void;

  private additions = new Map<string, EndingStore>();
  private aliases = new Map<string, string>();
  private preferred = new Map<string, string>();
  private accountKey(member: M, key: string) { return this.aliases.get(`${member}:${key}`) ?? key; }
  private stateKey(member: M, key: string) { return this.accountKey(member, this.preferred.get(`${member}:${key}`) ?? key); }
  private providerKey(key: string) { return key.split('.')[0]; }
  private storageKey(key: string) { return key.includes('.') || key.includes(':') ? key : this.offer(key).pi; }
  private async resolveKey(member: M, key: string) {
    if (key.includes('.')) return this.accountKey(member, key);
    const index = await this.index(member);
    const ids = (await this.store(member).list()).map((c) => this.publicKey(c.providerId)).filter((id) => this.providerKey(id) === key);
    const chosen = ids.includes(index.defaults.account ?? '') ? index.defaults.account! : ids[0] ?? key;
    this.preferred.set(`${member}:${key}`, chosen);
    return chosen;
  }
  private publicKey(key: string) { return this.providers.find((p) => p.pi === key)?.key ?? key; }
  private index(member: M) { return this.store(member).index(); }
  private async endpointRecord(member: M, id: string) { return (await this.index(member)).accounts?.[id]?.endpoint; }
  private cloudHost(): RouteHost { return { platform: this.platform.kind ?? (this.platform.cloudStream ? 'node' : 'browser'), hostSide: !!this.opts.cloudBinding }; }

  async list(member: M): Promise<Account[]> {
    const index = await this.index(member);
    const rows: Account[] = [];
    for (const c of await this.store(member).list()) {
      const id = this.publicKey(c.providerId);
      const cloud = index.accounts?.[id]?.cloud;
      if (cloud) {
        const r = route(cloud.route, this.cloudHost());
        const status = await this.cloudStatus(member, id);
        rows.push({ id, provider: cloud.provider, route: cloud.route, name: index.names[id] ?? r.name, label: cloud.billing === r.billing ? r.label : `Your own server (${cloud.billing} billing)`, billing: cloud.billing, state: status.state, addedAt: index.addedAt[id] ?? 0 });
        continue;
      }
      const p = id.includes(':') ? this.offer(id) : this.providers.find((p) => p.key === this.providerKey(id));
      if (!p) continue;
      const metadata = index.accounts?.[id];
      const status = await this.accountStatus(member, id);
      const token = await this.store(member).read(c.providerId);
      const info = token?.type === 'oauth' ? planOf(token.access) : undefined;
      rows.push({ id, provider: metadata?.route.includes(':') ? route(metadata.route).provider : p.key, route: metadata?.route ?? p.pi, name: index.names[id] ?? p.name, label: p.label ?? p.name,
        billing: metadata?.billing ?? p.billing, state: status.state, ...(status.until ? { until: status.until } : {}),
        ...(index.emails[id] || info?.email ? { email: index.emails[id] || info?.email } : {}),
        ...(index.plans[id] || info?.plan ? { plan: index.plans[id] || info?.plan } : {}), addedAt: index.addedAt[id] ?? 0 });
    }
    for (const [id, metadata] of Object.entries(index.accounts ?? {})) {
      const config = metadata.endpoint;
      if (!config) continue;
      const status = await this.endpointStatus(member, id);
      rows.push({ id, provider: 'custom', route: config.billing === 'local' ? 'custom:local' : 'custom:endpoint',
        name: index.names[id] ?? config.name ?? 'Your own server', label: endpointLabel(config.billing), billing: config.billing,
        state: status.state, readiness: status.readiness, addedAt: index.addedAt[id] ?? 0 });
    }
    return rows;
  }

  /** Add explicitly selected billing and public endpoint metadata; credentials only enter keyStore. No network at add time. */
  async endpoint(member: M, options: EndpointOptions): Promise<{ id: string }> {
    const config = endpointConfig(options);
    this.requireEndpointHost(config);
    if (options.key !== undefined && (typeof options.key !== 'string' || !options.key.trim())) throw new Error('Enter a key to connect this endpoint.');
    const bytes = new Uint8Array(12);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let n = 0; n < bytes.length; n++) bytes[n] = Math.floor(Math.random() * 256);
    const id = `endpoint.${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const metadata: AccountMetadata = { route: config.billing === 'local' ? 'custom:local' : 'custom:endpoint',
      billing: config.billing, baseUrl: config.baseUrl, compat: config.compat,
      endpoint: { ...config, hasKey: options.key !== undefined, active: true } };
    await this.store(member).index(() => {}); // Check the durable metadata seam before saving a secret.
    if (options.key !== undefined) await this.saveAccountKey(member, id, options.key, metadata);
    else await this.store(member).index((i) => { (i.accounts ??= {})[id] = metadata; i.addedAt[id] = Date.now(); });
    this.onChange?.(member, id);
    return { id };
  }

  private requireEndpointHost(config: EndpointConfig) {
    if (!(this.opts.endpointDriver ?? this.platform.endpoint) || (endpointNeedsHost(config.baseUrl) && !this.platform.loopback && !this.opts.endpointHost)) throw new EndpointError('needs_host');
  }

  /** Readiness is public metadata only, before opening any key backend. */
  async endpointReadiness(member: M, id: string): Promise<Readiness> {
    const config = await this.endpointRecord(member, id);
    if (!config) throw new EndpointError('no_upstream_flow');
    try { this.requireEndpointHost(config); return 'ready'; }
    catch (e) { if (e instanceof EndpointError) return e.readiness as Readiness; throw e; }
  }

  private async endpointStatus(member: M, id: string): Promise<Status & { readiness: Readiness }> {
    const index = await this.index(member);
    const config = index.accounts?.[id]?.endpoint;
    if (!config) throw new EndpointError('no_upstream_flow');
    const readiness = await this.endpointReadiness(member, id);
    const until = this.accountRestingUntil(member, id);
    const state = readiness !== 'ready' ? 'not_included' : !config.active ? 'signed_out' : until ? 'resting' : this.without.has(`${member}:${id}`) ? 'not_included' : 'ready';
    return { id, provider: 'custom', account: id, name: index.names[id] ?? config.name ?? 'Your own server', state, readiness, ...(until ? { until } : {}),
      words: readiness !== 'ready' ? 'This endpoint needs the app’s host side.' : !config.active ? 'Endpoint signed out' : until ? 'Endpoint is resting' : endpointLabel(config.billing) };
  }

  /** Complete typed Pi Models pass-through, scoped to exactly this member and account, never registered in a default runtime. */
  async endpointRuntime(member: M, id: string): Promise<Models> {
    const config = await this.endpointRecord(member, id);
    if (!config) throw new EndpointError('no_upstream_flow');
    this.requireEndpointHost(config);
    if (!config.active) throw new EndpointError('signed_out');
    return (this.opts.endpointDriver ?? this.platform.endpoint)!(id, config, async () => {
      // Previously returned runtimes also stop working after removal/sign-out. Readiness precedes secrets.
      const current = await this.endpointRecord(member, id);
      if (!current?.active) throw new EndpointError('signed_out');
      this.requireEndpointHost(current);
      if (!current.hasKey) return undefined;
      const key = await this.keys(member, (store) => store.get(`accounts.${id}`));
      if (!key) throw new EndpointError('signed_out');
      return key;
    });
  }

  async defaults(member: M): Promise<Defaults> { return (await this.index(member)).defaults; }
  async setDefaults(member: M, defaults: Defaults): Promise<void> {
    const accounts = await this.list(member);
    if (defaults.account && !accounts.some((a) => a.id === defaults.account)) throw new Error('No such account.');
    await this.store(member).index((i) => { i.defaults = { ...defaults }; });
    for (const p of this.providers) {
      const rows = accounts.filter((a) => a.provider === p.key);
      const chosen = rows.find((a) => a.id === defaults.account) ?? rows[0];
      if (chosen) this.preferred.set(`${member}:${p.key}`, chosen.id);
      else this.preferred.delete(`${member}:${p.key}`);
    }
  }
  async rename(member: M, id: string, name: string): Promise<Account> {
    id = this.accountKey(member, id);
    const account = (await this.list(member)).find((a) => a.id === id);
    if (!account) throw new Error('No such account.');
    name = name.trim();
    if (!name) throw new Error('Give this account a name.');
    await this.store(member).index((i) => { i.names[id] = name; });
    this.onChange?.(member, id);
    return { ...account, name };
  }
  async remove(member: M, id: string): Promise<void> {
    id = this.accountKey(member, id);
    try { await this.endAccount(member, id, true); }
    finally {
      await this.store(member).index((i) => {
        for (const map of [i.names, i.emails, i.plans, i.addedAt]) delete map[id];
        if (i.accounts) delete i.accounts[id];
        if (i.defaults.account === id) delete i.defaults.account;
      });
      this.preferred.delete(`${member}:${this.providerKey(id)}`);
      await this.resolveKey(member, this.providerKey(id));
    }
  }
  async add(member: M, key: string, options: (Omit<SignInOptions, 'via'> & { via?: Via; key?: string }) | CloudOptions = {}): Promise<{ id: string; signIn?: SignIn }> {
    if ('route' in options) return this.addCloud(member, key, options);
    if (key.includes(':') || options.via === 'key' || options.via === 'plan_key' || options.key !== undefined) {
      const r = key.includes(':') ? route(key) : routes().find((r) => (r.provider === key || r.aliases?.includes(key)) && r.via === (options.via ?? 'key'));
      if (!r || !['key', 'plan_key'].includes(r.via)) throw new Error('Choose a key route to add an account.');
      this.keyRoute(r.id); // Platform/flow before any credentials or storage.
      if (options.key === undefined) throw new Error('Enter a key to connect this account.');
      const id = `${r.id}.${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`;
      await this.saveKey(member, id, options.key, { billedPerUse: true });
      return { id, signIn: { id, state: 'done' } };
    }
    const p = this.offer(key);
    if (p.auth === 'api-key' || options.via === 'session') throw new Error('This sign-in method is not available here.');
    if (key !== p.key) throw new Error('Choose a provider to add an account.');
    this.signInReady(p, { ...options, via: options.via as SignInOptions['via'] });
    await this.store(member).index(() => {}); // Validate the storage seam before starting a flow.
    const bytes = new Uint8Array(4);
    let id: string;
    do {
      // These are non-secret row ids, not OAuth state. Older phone hosts need no crypto shim for them.
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
      else for (let n = 0; n < bytes.length; n++) bytes[n] = Math.floor(Math.random() * 256);
      id = `${key}.${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    } while (this.additions.has(`${member}:${id}`) || await this.store(member).read(id));
    this.additions.set(`${member}:${id}`, memoryStore());
    const signIn = await this.login(member, id, { ...options, via: options.via as SignInOptions['via'], fresh: true });
    return { id, ...(signIn ? { signIn } : {}) };
  }
  /** Explicit Node-only cloud account. Saving never resolves SDK credentials, reads paths or sends a request. */
  async addCloud(member: M, provider: string, options: CloudOptions): Promise<{ id: string }> {
    if (this.cloudHost().platform !== 'node') throw new CloudAccountError('unsupported_platform');
    if (!this.platform.cloudStream) throw new CloudAccountError('needs_host');
    const cloud = cloudSelection(provider, options, this.cloudHost());
    await this.store(member).index(() => {});
    const id = `${provider}.${globalThis.crypto.randomUUID()}`;
    if (await this.store(member).read(id)) throw new Error('Try adding this account again.');
    const metadata: AccountMetadata = { route: cloud.route, billing: cloud.billing, cloud };
    if (options.via === 'key') await this.saveAccountKey(member, id, options.key!, metadata);
    else await this.store(member).index((index, data) => {
      data[id] = { type: 'api_key' };
      (index.accounts ??= {})[id] = metadata;
      index.addedAt[id] = Date.now();
    });
    this.onChange?.(member, id);
    return { id };
  }

  private async cloudStatus(member: M, id: string): Promise<Status> {
    const a = (await this.index(member)).accounts?.[id]?.cloud;
    if (!a) throw new Error('No such cloud account.');
    const r = route(a.route, this.cloudHost());
    // Configuration readiness is not a live credential/permissions check. No profile, ADC or SDK probing here.
    const state = !this.platform.cloudStream || r.readiness !== 'ready' ? 'not_included' : r.via === 'key' && !(await this.keys(member, (store) => store.get(`accounts.${id}`))) ? 'signed_out' : 'ready';
    return { id, provider: a.provider, account: id, name: r.name, state, words: state === 'ready' ? 'Cloud account configured; credentials checked when you ask.' : state === 'signed_out' ? 'Connect this cloud account again.' : r.why ?? 'Cloud account needs its host adapter.' };
  }

  /** Full pinned Pi API stream for one explicitly selected cloud account; never a billing/provider fallback. */
  async cloudStream<A extends Api>(member: M, id: string, model: Model<A>, context: Context, options?: ApiStreamOptions<A>): Promise<AssistantMessageEventStream> {
    if (!this.platform.cloudStream || this.cloudHost().platform !== 'node') throw new CloudAccountError('unsupported_platform');
    return this.serial(`${member}:${id}`, async () => {
      const a = (await this.index(member)).accounts?.[id]?.cloud;
      if (!a || model.provider !== a.upstream) throw new CloudAccountError('invalid_selection');
      const r = route(a.route, { platform: 'node', hostSide: !!this.opts.cloudBinding });
      if (r.readiness !== 'ready') throw new CloudAccountError(r.readiness);
      const key = r.via === 'key' ? await this.keys(member, (store) => store.get(`accounts.${id}`)) : undefined;
      if (r.via === 'key' && !key) throw new Error('Connect this cloud account again.');
      let binding: AiBinding | undefined;
      try { if (a.binding) binding = this.opts.cloudBinding?.(member, a.binding); }
      catch { throw new CloudAccountError('needs_host'); }
      if (a.binding && !binding) throw new CloudAccountError('needs_host');
      return this.platform.cloudStream!(a, key ?? undefined, model, context, options, binding);
    });
  }
  async cloudComplete<A extends Api>(member: M, id: string, model: Model<A>, context: Context, options?: ApiStreamOptions<A>): Promise<AssistantMessage> {
    return (await this.cloudStream(member, id, model, context, options)).result();
  }

  private identity(c: Credential | undefined): string | undefined {
    if (c?.type !== 'oauth') return undefined;
    if (typeof c.accountId === 'string' && c.accountId) return c.accountId;
    try {
      const j = claims(c.access);
      const identity = j.sub ?? j['https://api.openai.com/auth']?.chatgpt_account_id ?? j.email ?? j['https://api.openai.com/profile']?.email;
      return typeof identity === 'string' && identity ? identity : undefined;
    } catch { return undefined; }
  }
  private async commitAddition(member: M, key: string, flow: Flow) {
    const staged = this.additions.get(`${member}:${key}`);
    if (!staged) return key;
    const p = this.offer(key);
    const c = await staged.read(p.pi);
    if (!c) throw new Error('No usable sign-in.');
    let canonical = key;
    await this.store(member).index((index, data) => {
      if (flow.state !== 'waiting' || flow.abort.signal.aborted) throw new Error('Login cancelled');
      const identity = this.identity(c);
      const entries = Object.entries(data).filter(([id]) => !id.startsWith('.') && this.providerKey(this.publicKey(id)) === p.key);
      const match = identity && entries.find(([, old]) => this.identity(old as Credential) === identity);
      canonical = match ? this.publicKey(match[0]) : entries.length ? key : p.key;
      data[this.storageKey(canonical)] = c;
      index.addedAt[canonical] ??= Date.now();
      const info = c.type === 'oauth' ? planOf(c.access) : undefined;
      if (info?.email) index.emails[canonical] = info.email;
      if (info?.plan) index.plans[canonical] = info.plan;
    }, { signal: flow.abort.signal });
    this.aliases.set(`${member}:${key}`, canonical);
    flow.id = canonical;
    this.additions.delete(`${member}:${key}`);
    this.runtimes.delete(`${member}:${key}`);
    return canonical;
  }

  private platform: Platform;
  /** Offered: the providers named in `offer`, else every subscription provider that this platform can sign in to. */
  constructor(opts: AccountsOptions<M> = {}, platform: Platform = portable) {
    this.opts = opts;
    this.platform = platform;
    this.providers = opts.offer ? offered(opts.offer) : offered().filter((p) => platform.signsIn(p.pi));
  }

  /** A member's own store. */
  protected store(member: M) {
    let s = this.stores.get(String(member));
    if (!s) {
      const base = (this.opts.store ?? memoryStore)(member);
      this.baseStores.set(String(member), base);
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>) => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };
      s = {
        index: (fn, options) => {
          const index = (base as Partial<EndingStore>).index;
          if (index) return serial(() => index.call(base, fn, options));
          if (fn) throw new Error('Multiple accounts require recordStore(load, save).');
          return Promise.resolve(emptyIndex());
        },
        read: (id) => base.read(id),
        list: () => base.list(),
        modify: (id, fn, options) => serial(() => base.modify(id, fn, options)),
        refresh: (id, due, rotate) => serial(() => refreshCredential(base, id, due, rotate)),
        delete: (id, options) => serial(() => base.delete(id, options)),
        end: (id, fn) => serial(async () => {
          if (typeof (base as EndingStore).end === 'function') return (base as EndingStore).end(id, fn);
          try { await fn(await base.read(id)); } finally { await base.delete(id); }
        }),
      };
      this.stores.set(String(member), s);
    }
    return s;
  }

  private async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const work = previous.then(fn, fn);
    const tail = work.then(() => {}, () => {});
    this.chains.set(id, tail);
    try { return await work; } finally { if (this.chains.get(id) === tail) this.chains.delete(id); }
  }

  protected boundStore(member: M, raw: CredentialStore, accountId?: string): BoundStore {
    const key = (id: string) => `${member}:${accountId ?? this.providers.find((p) => p.pi === id)?.key ?? id}`;
    return {
      read: (id, options) => raw.read(id, options),
      list: (options) => raw.list(options),
      refresh: (id, due, rotate) => {
        const account = key(id);
        const started = this.generations.get(account) ?? 0;
        return this.serial(account, async () => {
          if (started !== (this.generations.get(account) ?? 0)) return undefined;
          const next = await refreshCredential(raw, id, due, rotate);
          // Sign-out waits on this lock and revokes the committed replacement pair.
          return started === (this.generations.get(account) ?? 0) ? next : undefined;
        });
      },
      modify: (id, fn, options) => {
        const account = key(id);
        const stale = Symbol();
        const started = options?.signal ? this.signals.get(options.signal) ?? this.generations.get(account) ?? 0 : this.generations.get(account) ?? 0;
        const discard = async (next: Awaited<ReturnType<CredentialStore['read']>>) => {
          const p = this.providers.find((p) => p.pi === id);
          if (next?.type === 'oauth' && p?.revoke) {
            try { await revoke(this.opts.authBase ? `${this.opts.authBase}/oauth/revoke` : p.revoke!, p.clientId, next); } catch (e) {
              const error = e instanceof Error ? e : new Error(String(e));
              if (this.onSignOutError) this.onSignOutError(member, accountId ?? p.key, error);
              else console.error('Sign-out of a discarded credential failed');
              throw error;
            }
          }
        };
        return this.serial(account, async () => {
          if (started !== (this.generations.get(account) ?? 0)) {
            await discard(await fn(undefined));
            return undefined;
          }
          try {
            return await raw.modify(id, async (current) => {
              const next = await fn(current);
              if (started !== (this.generations.get(account) ?? 0)) {
                await discard(next);
                throw stale;
              }
              return next;
            }, options);
          } catch (e) {
            if (e === stale) return undefined;
            throw e;
          }
        });
      },
      delete: (id, options) => this.serial(key(id), () => raw.delete(id, options)),
      signOut: (id, p) => this.serial(key(id), async () => {
        let error: unknown;
        try {
          const c = await raw.read(id);
          if (c?.type === 'oauth' && p.revoke) await revoke(this.opts.authBase ? `${this.opts.authBase}/oauth/revoke` : p.revoke!, p.clientId, c);
        } catch (e) { error = e; }
        await raw.delete(id);
        if (error) throw error;
      }),
    };
  }

  protected engine(member: M, raw: CredentialStore, accountId?: string): Promise<R> {
    const credentials = this.boundStore(member, raw, accountId);
    return Promise.resolve(Object.assign(withClaudePlan(this.platform.engine(credentials, this.opts.authBase, this.opts.deviceBase), credentials, accountId ? raw : this.baseStores.get(String(member)) ?? raw, { ...this.opts.claudePlan, fetch: this.opts.claudePlan?.fetch ?? this.opts.fetch }), {
      credentialStore: credentials, readCredential: (id: string) => credentials.read(id),
    }) as R);
  }

  /** A member's engine, holding only their own sign-ins (`store(member)`). Override to use another engine with the same seam. */
  protected open(member: M): Promise<R> { return this.engine(member, this.store(member)); }

  runtime(member: M, accountId?: string): Promise<R> {
    if (accountId && !accountId.includes('.')) return this.runtime(member);
    if (accountId) {
      accountId = this.accountKey(member, accountId);
      const id = `${member}:${accountId}`;
      let r = this.runtimes.get(id);
      if (!r) {
        const p = this.offer(accountId);
        const staged = this.additions.get(id);
        const raw = staged ?? viewStore(this.store(member), p.pi, this.storageKey(accountId));
        this.runtimes.set(id, r = this.engine(member, raw, accountId));
      }
      return r;
    }
    let r = this.runtimes.get(String(member));
    if (!r) this.runtimes.set(String(member), r = this.open(member));
    return r;
  }

  /** Route discovery is independent of legacy provider offers; naming a route is explicit selection. */
  routes(): RouteView[] { return routes({ platform: this.platform.kind ?? 'browser' }); }

  private offer(key: string): Provider {
    if (key.includes(':')) {
      const r = route(this.providerKey(key));
      if (!['key', 'plan_key'].includes(r.via)) throw new Error('This route needs its own sign-in adapter.');
      return { key: r.id, pi: r.upstream.id, name: r.name, company: r.company, label: r.label, billing: r.billing,
        auth: 'api-key', models: { strong: '' }, routes: [r.id],
        source: r.upstream.revision, multiAccount: { terms: 'grey', why: 'Each account belongs to its member.', source: r.upstream.revision } };
    }
    const p = provider(this.providerKey(key));
    if (!this.providers.includes(p)) throw Object.assign(new Error('AI account not offered here'), { status: 404 });
    return p;
  }

  private isKey(p: Provider) {
    return p.auth === 'api-key' || p.billing === 'api' && !!this.opts.keyStore && routes().some((r) => r.upstream.id === p.pi && r.via === 'key');
  }

  private keyRoute(key: string) {
    const p = this.offer(key);
    const r = p.key.includes(':') ? route(p.key) : routes().find((r) => r.upstream.id === p.pi && r.via === 'key');
    if (p.auth !== 'api-key' && !(p.billing === 'api' && r)) throw new Error('This account uses a subscription sign-in.');
    if (r?.upstream.flow === 'absent') throw new KeyRouteError('no_upstream_flow');
    if (r?.platforms[this.platform.kind ?? 'browser'] === 'no') throw new KeyRouteError('unsupported_platform');
    return p;
  }

  /** Shared key-store seam for key, cloud and endpoint account adapters; sanitized failures only. */
  protected async keys<T>(member: M, action: (store: Keystore) => Promise<T>): Promise<T> {
    try {
      if (!this.opts.keyStore) throw new Error();
      return await action(this.opts.keyStore(member));
    } catch { throw new Error('Saved keys could not be opened or changed. Try again after unlocking this device.'); }
  }

  /** Shared persistence for adapters that have already validated route/platform/billing. No secret enters the index. */
  protected async saveAccountKey(member: M, id: string, secret: string, metadata: AccountMetadata, options?: { signal?: AbortSignal }): Promise<void> {
    if (typeof secret !== 'string' || !secret.trim()) throw new Error('Enter a key to connect this account.');
    await this.serial(`${member}:${id}`, async () => {
      if (options?.signal?.aborted) throw new Error('Login cancelled');
      const previous = await this.keys(member, (store) => store.get(`accounts.${id}`));
      await this.keys(member, (store) => store.set(`accounts.${id}`, secret));
      try {
        if (options?.signal?.aborted) throw new Error('Login cancelled');
        await this.store(member).index((index, data) => {
          data[id] = { type: 'api_key' }; // A marker, never the secret.
          (index.accounts ??= {})[id] = { ...metadata };
          index.addedAt[id] ??= Date.now();
        }, options);
      } catch {
        await this.keys(member, async (store) => { if (previous === null) await store.delete(`accounts.${id}`); else await store.set(`accounts.${id}`, previous); });
        throw new Error('This account could not be saved. Try again.');
      }
    });
  }

  /** Explicit consent to per-use billing. Saves only in this member's device-owned secrets store. */
  async saveKey(member: M, key: string, secret: string, consent?: { billedPerUse: true }): Promise<SignIn> {
    const p = this.keyRoute(key);
    if (p.billing === 'api' && consent?.billedPerUse !== true) throw new Error('Agree to billing per use before connecting this key.');
    key = this.accountKey(member, key);
    const r = p.key.includes(':') ? route(p.key) : routes().find((r) => r.upstream.id === p.pi && r.via === 'key');
    const generation = this.generations.get(`${member}:${key}`) ?? 0;
    await this.saveAccountKey(member, key, secret, { route: r?.id ?? p.key, billing: p.billing });
    if (generation !== (this.generations.get(`${member}:${key}`) ?? 0)) return { state: 'failed' };
    this.ready.set(`${member}:${key}`, true);
    this.lapsed.delete(`${member}:${key}`);
    this.without.delete(`${member}:${key}`);
    this.rests.delete(`${member}:${key}`);
    this.onSignedIn?.(member, key);
    this.onChange?.(member, key);
    return { state: 'done' };
  }

  /** Host-only credential handoff to jev({key}) or openai({key}); never include the result in a view or log. */
  async key(member: M, key: string): Promise<string> {
    key = await this.resolveKey(member, key);
    const p = this.keyRoute(key);
    const value = await this.keys(member, (store) => store.get(`accounts.${key}`));
    if (!value) throw new ResponseError(say('status.signedOut', { name: p.name }), 'signed_out');
    return value;
  }

  /** Signed in, from the engine's own side-effect-free check. */
  async signedIn(member: M, key: string) {
    if ((await this.index(member)).accounts?.[key]?.cloud) return (await this.cloudStatus(member, key)).state === 'ready';
    key = this.additions.has(`${member}:${key}`) ? key : await this.resolveKey(member, key);
    const config = await this.endpointRecord(member, key);
    if (config) {
      const status = await this.endpointStatus(member, key);
      if (status.state !== 'ready') return false;
      return !config.hasKey || !!(await this.keys(member, (store) => store.get(`accounts.${key}`)));
    }
    return this.checked(member, key);
  }

  private async checked(member: M, key: string) {
    const p = this.offer(key);
    if (this.isKey(p)) this.keyRoute(key);
    const ok = this.isKey(p)
      ? !!(await this.keys(member, (store) => store.get(`accounts.${key}`)))
      : !!(await (await this.runtime(member, key)).checkAuth(p.pi).catch(() => undefined));
    this.ready.set(`${member}:${key}`, ok);
    if (ok) this.lapsed.delete(`${member}:${key}`);
    return ok;
  }

  /** Which plan the member signed in with (ChatGPT's by default, or Claude's): its plan, email, and whether it is a work
   *  account; `planLabel` says it ("ChatGPT Plus"). Null when not signed in. Claude's comes from its profile, read once
   *  per sign-in with the stored access, never refreshing it; an empty plan when Claude doesn't say or the access is due. */
  async plan(member: M, provider = 'chatgpt') {
    // Claude's label names the account respond() asks with: the primary one.
    const key = provider === 'claude' ? 'claude' : await this.resolveKey(member, provider);
    const c = await (await this.runtime(member, key)).readCredential(this.offer(key).pi).catch(() => undefined);
    if (c?.type !== 'oauth') return null;
    if (provider !== 'claude') return planOf(c.access);
    const unknown = { plan: '', email: '', work: false };
    const id = `${member}:${key}`;
    let kept = this.claudePlans.get(id);
    if (kept?.refresh !== c.refresh) {
      if (c.expires <= Date.now() + 300_000) return unknown; // refreshing is for asking, not for a label
      const read = claudeProfile(c.access, { ...this.opts.claudePlan, fetch: this.opts.claudePlan?.fetch ?? this.opts.fetch });
      this.claudePlans.set(id, kept = { refresh: c.refresh, read });
      read.catch(() => { if (this.claudePlans.get(id)?.read === read) this.claudePlans.delete(id); });
    }
    return kept.read.catch(() => unknown);
  }

  /** Whether the member's plan lacks this use; `on` records what the provider said, or that the person changed plans. */
  notIncluded(member: M, key: string, on?: boolean) { return this.accountNotIncluded(member, this.stateKey(member, key), on); }

  private accountNotIncluded(member: M, key: string, on?: boolean) {
    const id = `${member}:${key}`;
    if (on !== undefined) { if (on) this.without.add(id); else this.without.delete(id); this.onChange?.(member, key); }
    return this.without.has(id);
  }

  /** Known to be unusable: signed out, or a plan without this use. An unchecked account counts as usable, so a first run still tries. */
  unready(member: M, key: string) { key = this.stateKey(member, key); return this.ready.get(`${member}:${key}`) === false || this.without.has(`${member}:${key}`); }

  /** The account turned a request away (its sign-in lapsed): signed out until the person signs in again. */
  forget(member: M, key: string) { this.forgetAccount(member, this.stateKey(member, key)); }

  private forgetAccount(member: M, key: string) {
    this.ready.set(`${member}:${key}`, false);
    this.lapsed.add(`${member}:${key}`);
    this.onChange?.(member, key);
  }

  /** 0 when the account is available; otherwise when it stops resting. */
  restingUntil(member: M, key: string) { return this.accountRestingUntil(member, this.stateKey(member, key)); }

  private accountRestingUntil(member: M, key: string) {
    const r = this.rests.get(`${member}:${key}`);
    return r && r.until > Date.now() ? r.until : 0;
  }

  /** Fresh ChatGPT access for a host-side capability. Never send this to another device. */
  async access(member: M, signal?: AbortSignal, accountId?: string): Promise<{ access: string; accountId: string }> {
    signal?.throwIfAborted();
    const key = accountId ? this.accountKey(member, accountId) : await this.resolveKey(member, 'chatgpt');
    if (this.providerKey(key) !== 'chatgpt') throw new ResponseError('This capability needs a ChatGPT subscription account.', 'not_included');
    const p = this.offer(key);
    const rt = await this.runtime(member, key);
    let access: string | undefined;
    try { access = (await rt.getAuth(p.pi))?.auth?.apiKey; }
    catch (e: any) {
      // The engine says 400-403 only for a revoked or quarantined grant; a passing refusal at refresh keeps the sign-in.
      if ([400, 401, 403].includes(e?.status)) {
        await rt.credentialStore.delete(p.pi);
        this.forgetAccount(member, key);
        throw new ResponseError(say('status.needsAgain', { name: p.name }), 'signed_out');
      }
      throw new ResponseError('ChatGPT could not refresh its sign-in. Try again when the network is back.', 'network');
    }
    const c = await rt.readCredential(p.pi).catch(() => undefined);
    if (!access || c?.type !== 'oauth') throw new ResponseError(say('status.signedOut', { name: p.name }), 'signed_out');
    signal?.throwIfAborted();
    return { access, accountId: String(c.accountId ?? '') };
  }

  /** Ask ChatGPT with this member's own sign-in, the answer streaming into `onText`; refreshed first when due. A
   *  failure about the account (a limit, a lapsed sign-in) is acted on as `failed()` does, then thrown as a
   *  ResponseError with the words to show. Without `tools` the answer is the plain text, as before: pass `input` as
   *  words or as turns (messages with `input_image`, then the `function_call` with its `function_call_output`). With
   *  `tools` it is the text with every output item, and `onEvent` sees each tool call as it lands. */
  async respond<T extends Api>(member: M, ask: KeyAsk<T>): Promise<AssistantMessage>;
  async respond(member: M, ask: ClaudePlanAsk & { result: true }): Promise<AnthropicResult>;
  async respond(member: M, ask: ClaudePlanAsk & { tools: AnthropicTool[] }): Promise<AnthropicResult>;
  async respond(member: M, ask: ClaudePlanAsk & { tools?: undefined; result?: false }): Promise<string>;
  async respond(member: M, ask: ClaudePlanAsk): Promise<string | AnthropicResult>;
  async respond(member: M, ask: AnthropicAccountAsk & { result: true }): Promise<AnthropicResult>;
  async respond(member: M, ask: AnthropicAccountAsk & { tools: AnthropicTool[] }): Promise<AnthropicResult>;
  async respond(member: M, ask: AnthropicAccountAsk & { tools?: undefined; result?: false }): Promise<string>;
  async respond(member: M, ask: AnthropicAccountAsk): Promise<string | AnthropicResult>;
  async respond(member: M, ask: Ask & { result: true }): Promise<ResponseResult>;
  async respond(member: M, ask: Ask & { tools?: undefined; result?: false }): Promise<string>;
  async respond(member: M, ask: Ask & { tools: ResponseTool[] }): Promise<ResponseResult>;
  async respond(member: M, ask: Ask): Promise<string | ResponseResult>;
  async respond(member: M, query: Ask | AnthropicAccountAsk | ClaudePlanAsk | KeyAsk): Promise<string | ResponseResult | AssistantMessage> {
    if ('account' in query && 'context' in query) return this.respondKey(member, query as KeyAsk);
    const ask = query as Ask;
    if ('provider' in query && query.provider === 'claude') {
      this.offer('claude');
      const rt = await this.runtime(member);
      const { provider: _provider, ...request } = query as ClaudePlanAsk;
      let access: string | undefined;
      try { access = (await rt.getAuth(CLAUDE_PLAN_ID))?.auth?.apiKey; }
      catch (e) {
        if (e instanceof ClaudePlanExpiredError) { this.forget(member, 'claude'); this.onExpired?.(member, 'claude'); }
        throw e;
      }
      if (!access) throw new ClaudePlanExpiredError();
      try { return await claudePlanMessages(access, { fetch: this.opts.fetch }).respond(request); }
      catch (e) {
        if (e instanceof ResponseError && e.kind === 'signed_out') {
          await this.logout(member, 'claude').catch(() => {});
          this.forget(member, 'claude');
          this.onExpired?.(member, 'claude');
          throw new ClaudePlanExpiredError();
        }
        if (e instanceof ResponseError && e.kind) await this.failed(member, 'claude', e);
        throw e;
      }
    }
    if ('provider' in query && query.provider === 'anthropic') {
      this.offer('anthropic');
      const { provider: _provider, key, ...request } = query as AnthropicAccountAsk;
      return anthropic({ key, fetch: this.opts.fetch, base: this.opts.anthropicBase }).respond(request);
    }
    const key = 'chatgpt';
    const p = this.offer(key);
    const { access, accountId } = await this.access(member);
    try {
      const base = { ...ask, access, accountId, model: ask.model ?? p.models.strong, base: this.opts.apiBase, fetch: this.opts.fetch, originator: ask.originator ?? this.opts.originator };
      return await respond(base);
    } catch (e: any) {
      if (e instanceof ResponseError && e.kind && e.kind !== 'network') {
        const acted = await this.failed(member, key, e);
        if (acted && acted.kind !== e.kind) throw new ResponseError(e.message, acted.kind, acted.until,
          e.status !== undefined ? { status: e.status, retryAfter: e.retryAfter } : undefined);
      }
      throw e;
    }
  }

  /** Full typed pinned Models request, bound to one selected member/account for the whole response. */
  async respondKey<T extends Api>(member: M, ask: KeyAsk<T>): Promise<AssistantMessage> {
    const p = this.keyRoute(ask.account);
    const r = route(p.key.includes(':') ? p.key : routes().find((r) => r.upstream.id === p.pi && r.via === 'key')?.id ?? 'missing');
    if (ask.options?.signal?.aborted) throw new KeyRouteError('aborted');
    if (ask.options && 'client' in ask.options && ask.options.client !== undefined) throw new KeyRouteError('auth_override');
    if (!this.platform.keys) throw new KeyRouteError('needs_keys');
    const runtime = await this.platform.keys();
    checkKeyModel(r, ask.model, this.platform.kind ?? 'browser', runtime.supported);
    const secret = await this.key(member, ask.account);
    return keyRespond(r, secret, ask, this.opts.fetch, runtime);
  }

  /** Bind this member's existing ChatGPT subscription login for consumers such as decide. Each request uses
   * the current sign-in and Accounts' refresh/limit/sign-out handling; the handle exposes no credentials. */
  chatgpt(member: M): ChatGPTRespondAccount {
    this.offer('chatgpt');
    return { billing: 'subscription', respond: (ask) => this.respond(member, ask) };
  }

  /** An account's error, acted on. A limit or overload rests it (until when it said, or a default). A plan without this
   *  use is marked so. A refusal is checked: a sign-in that no longer refreshes is signed out for real, one that still
   *  does was a passing refusal and rests a few minutes (kind `overloaded`) rather than loop. Returns the kind acted on,
   *  or null for an error that is not about the account; `network` changes nothing. */
  async failed(member: M, key: string, error: string | ResponseError) {
    key = await this.resolveKey(member, key);
    const c = error instanceof ResponseError ? error.kind && { kind: error.kind, until: error.until } : classify(error);
    if (!c || c.kind === 'network') return c;
    if (c.kind === 'signed_out' && await this.recheck(member, key)) c.kind = 'overloaded';
    if (c.kind === 'not_included') this.accountNotIncluded(member, key, true);
    else if (c.kind !== 'signed_out') {
      c.until ||= Date.now() + REST_MS[c.kind];
      this.rests.set(`${member}:${key}`, { until: c.until, kind: c.kind });
      this.onChange?.(member, key);
    }
    return c;
  }

  /** The first choice whose account is neither resting nor known to be unusable: the fallback ladder. */
  ladder<T>(member: M, choices: readonly T[], key: (c: T) => string = String) {
    return choices.find((c) => provider(key(c)).billing === 'subscription' && !this.restingUntil(member, key(c)) && !this.unready(member, key(c)));
  }

  /** Where one account stands, in one plain sentence every app shows the same way. */
  async status(member: M, key: string): Promise<Status & { readiness?: Readiness }> {
    key = this.additions.has(`${member}:${key}`) ? key : await this.resolveKey(member, key);
    return this.accountStatus(member, key);
  }

  private async accountStatus(member: M, key: string): Promise<Status> {
    if (await this.endpointRecord(member, key)) return this.endpointStatus(member, key);
    if ((await this.index(member)).accounts?.[key]?.cloud) return this.cloudStatus(member, key);
    const { name } = this.offer(key);
    const id = `${member}:${key}`;
    const s = (state: Status['state'], w: WordKey, until?: number): Status => ({ id: key, provider: this.providerKey(key), account: key, name, state, until, words: say(w, { name, until: until ? clock(until) : '' }) });
    if (this.flows.get(id)?.state === 'waiting') return s('signing', 'status.signing');
    const until = this.accountRestingUntil(member, key);
    if (until) return s('resting', this.rests.get(id)!.kind === 'rate_limit' ? 'status.resting' : 'status.busy', until);
    if (!(this.ready.get(id) ?? await this.checked(member, key))) return this.lapsed.has(id) ? s('needs_again', 'status.needsAgain') : s('signed_out', 'status.signedOut');
    return this.without.has(id) ? s('not_included', 'status.notIncluded') : s('ready', 'status.ready');
  }

  /** Start "Sign in with …". The provider's own page by default: where it has a fixed redirect back to this computer
   *  (ChatGPT), the kit listens there itself, so the tab shows the app's words, and only once they are true. The code is
   *  the fallback: asked for (`via: 'code'`, "Having trouble?", even mid-way), or by itself when no redirect has come back
   *  in time, or when a browser sign-in could not return at all. `fresh` asks the page which account again. A flow that
   *  stalls times out; nothing is kept unless the engine then sees a working sign-in; every failure ends in one plain
   *  sentence. Returns as soon as there is a page to open or a code to show (or it is over); the rest carries on by itself. */
  async login(member: M, key: string, body: SignInOptions = {}): Promise<SignIn | null> {
    const p = this.offer(key);
    if (this.isKey(p) && p.key !== 'openrouter') throw new Error(p.billing === 'api' ? 'Connect an API key after agreeing to billing per use.' : 'Connect this account through its key route.');
    this.signInReady(p, body);
    key = this.additions.has(`${member}:${key}`) ? key : await this.resolveKey(member, key);
    const id = `${member}:${key}`;
    const pending = this.signingOut.get(id);
    if (pending) await pending.catch(() => {});
    const now = this.flows.get(id);
    if (now?.state === 'waiting' && body.via === 'code' && now.via === 'browser') {
      // "Having trouble?": the same sign-in carries on with a code instead.
      const visible = new Promise<void>((r) => (now.shown = r));
      this.toCode(now);
      await Promise.race([visible, now.done]);
    } else if (now?.state !== 'waiting') {
      const flow: Flow = { state: 'waiting', abort: new AbortController(), generation: this.generations.get(id) ?? 0 };
      this.signals.set(flow.abort.signal, flow.generation);
      this.flows.set(id, flow);
      const visible = new Promise<void>((r) => (flow.shown = r));
      flow.done = this.signIn(member, key, body, flow);
      await Promise.race([visible, flow.done]);
    }
    return this.view(member, key);
  }

  /** The whole sign-in, for when the caller wants to wait for its end (tests do). */
  finished(member: M, key: string) { key = this.preferred.get(`${member}:${key}`) ?? key; return this.flows.get(`${member}:${key}`)?.done ?? Promise.resolve(); }

  private toCode(flow: Flow) {
    if (flow.state !== 'waiting' || flow.via !== 'browser' || flow.toCode) return;
    flow.toCode = true;
    flow.refuse?.(new Error('switching to a code'));
  }

  /** Check the selected route before opening any member store or starting a provider request. */
  private signInReady(p: Provider, body: SignInOptions) {
    if (p.auth === 'api-key') throw new Error('Connect an API key after agreeing to billing per use.');
    if (p.readiness && p.readiness !== 'ready') throw Object.assign(new Error('This sign-in method is not available here.'), { readiness: p.readiness });
    if (body.enterpriseDomain !== undefined) {
      if (p.pi !== 'github-copilot') throw new Error('Enterprise domains apply only to GitHub Copilot.');
      const domain = body.enterpriseDomain.trim();
      if (domain && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || !domain.includes('.') || domain.includes('..')))
        throw new Error('Enter a GitHub Enterprise domain, without a path or credentials.');
    }
    if (p.key === 'claude' && body.via === 'code') throw new Error('Claude uses a browser or a pasted code, not a device code.');
    if (body.via === 'paste' && !['claude', 'chatgpt', 'openrouter'].includes(p.key))
      throw Object.assign(new Error('This provider has no paste sign-in flow.'), { readiness: 'no_upstream_flow' });
    if (p.key === 'openrouter') {
      if (body.via === 'code') throw new Error('OpenRouter uses a browser or a pasted code, not a device code.');
      if (body.billedPerUse !== true) throw new Error('Agree to billing per use before connecting this key.');
      if (!this.opts.keyStore) throw Object.assign(new Error('OpenRouter sign-in needs a device-owned key store.'), { readiness: 'needs_host' });
    }
    const selected = p.key === 'claude' && body.via === 'browser' ? 'anthropic:browser'
      : p.key === 'radius' ? `radius:${body.via ?? 'browser'}`
      : p.key === 'openrouter' ? `openrouter:${body.via ?? 'browser'}` : undefined;
    if (selected) {
      const r = route(selected, { platform: this.platform.loopback ? 'node' : 'rn' });
      if (r.readiness !== 'ready') throw Object.assign(new Error(r.why), { readiness: r.readiness });
    }
  }

  private async signIn(member: M, key: string, body: SignInOptions, flow: Flow) {
    const p = this.offer(key);
    const id = `${member}:${key}`;
    const rt = await this.runtime(member, key);
    // Browser Claude stores into the same plan namespace, never the API-key namespace. OpenRouter's
    // permanent key stays in transient memory until the shared device-owned keyStore seam accepts it.
    const temporary = p.key === 'openrouter' ? memoryStore() : undefined;
    const driver = temporary ? this.platform.engine(temporary, this.opts.authBase, this.opts.deviceBase)
      : p.key === 'claude' && body.via === 'browser' ? this.platform.engine(this.boundStore(member, viewStore(this.additions.get(id) ?? this.store(member), 'anthropic', this.additions.has(id) ? p.pi : this.storageKey(key)), key)) : rt;
    const pi = p.key === 'claude' && body.via === 'browser' ? 'anthropic' : p.pi;
    let codeOffered = false;
    const attempt = (via?: SignInOptions['via']) => driver.login(pi, 'oauth', {
      signal: flow.abort.signal,
      prompt: (q: AuthPrompt): Promise<string> => {
        if (q.type === 'select') {
          const device = q.options.find((o) => /device/i.test(o.id));
          codeOffered = !!device;
          return Promise.resolve((via === 'code' && device ? device : q.options.find((o) => o !== device) ?? q.options[0]).id);
        }
        if (q.type === 'text') {
          if (p.pi === 'github-copilot') return Promise.resolve(body.enterpriseDomain?.trim() ?? '');
          throw new Error('This sign-in needs an app-supplied prompt handler.');
        }
        // "Paste the redirect address": the kit's own listener (or the person) hands the engine the address the browser landed on.
        return new Promise((resolve, reject) => {
          const cleanup = () => {
            flow.abort.signal.removeEventListener('abort', cancelled);
            q.signal?.removeEventListener('abort', answered);
          };
          const cancelled = () => { cleanup(); reject(new Error('Login cancelled')); };
          const answered = () => { cleanup(); reject(new Error('answered elsewhere')); };
          Object.assign(flow, {
            paste: (text: string) => { cleanup(); resolve(text); },
            refuse: (error: Error) => { cleanup(); reject(error); },
          });
          flow.abort.signal.addEventListener('abort', cancelled, { once: true });
          q.signal?.addEventListener('abort', answered, { once: true });
          if (flow.abort.signal.aborted) cancelled();
          else if (q.signal?.aborted) answered();
        });
      },
      notify: (e) => {
        if (e.type === 'auth_url') {
          const url = new URL(e.url);
          if (body.fresh && p.fresh) url.searchParams.set(p.fresh.param, p.fresh.value); // "Use my personal account": ask which account, again
          Object.assign(flow, { via: 'browser', url: url.toString(), code: undefined, oauthState: url.searchParams.get('state') ?? undefined });
        }
        if (e.type === 'device_code') Object.assign(flow, { via: 'code', code: e.userCode, url: e.verificationUri, expiresAt: e.expiresInSeconds ? Date.now() + e.expiresInSeconds * 1000 : undefined });
        if (flow.url) flow.shown?.();
        this.onChange?.(member, key);
      },
    });
    const timer = setTimeout(() => { flow.timedOut = true; flow.abort.abort(); }, this.opts.signInMs ?? 15 * 60_000);
    const stuck = p.key === 'claude' ? undefined : setTimeout(() => this.toCode(flow), this.opts.redirectMs ?? 3 * 60_000);
    // Listen where the provider sends the browser back (the engine then finds the port taken and waits to be handed the address).
    const port = p.callbackPort && (this.opts.callbackPort ?? p.callbackPort);
    let reserved = !!port && body.via !== 'code' && !!this.platform.loopback && !ports.has(port);
    if (reserved) ports.add(port!);
    const catcher = reserved && this.platform.loopback ? await this.catchRedirect(this.platform.loopback, flow, p.name, port!).catch(() => null) : undefined;
    let closed = false;
    const close = () => {
      if (!closed) { catcher?.close(); closed = true; }
      if (reserved) { ports.delete(port!); reserved = false; }
    };
    try {
      if (catcher === null && !this.additions.has(id)) throw Object.assign(new Error('port busy'), { why: 'busy' as const });
      try { await attempt(catcher === null || (port && !reserved && body.via !== 'code') ? 'code' : body.via ?? (catcher ? 'browser' : undefined)); } catch (e) {
        // The code instead: asked for, or the page never came back. Also when a browser sign-in could not return here at all.
        if (!flow.toCode && (catcher || body.via === 'code' || !codeOffered || flow.abort.signal.aborted)) throw e;
        Object.assign(flow, { url: undefined, code: undefined, via: 'code' });
        close();
        await attempt('code');
      }
      if (flow.generation !== (this.generations.get(id) ?? 0) || flow.state !== 'waiting') return;
      if (!(await driver.checkAuth(pi).catch(() => undefined))) { await driver.logout(pi).catch(() => {}); throw new Error('no usable credential'); }
      if (flow.generation !== (this.generations.get(id) ?? 0) || flow.state !== 'waiting') return;
      if (temporary) {
        const credential = await temporary.read(pi);
        if (credential?.type !== 'oauth' || !credential.access) throw new Error('no usable credential');
        await this.saveAccountKey(member, key, credential.access, { route: `openrouter:${body.via ?? 'browser'}`, billing: 'api' }, { signal: flow.abort.signal });
        this.additions.delete(id);
        this.runtimes.delete(id);
      }
      const canonical = temporary ? key : await this.commitAddition(member, key, flow);
      flow.state = 'done';
      this.ready.set(`${member}:${canonical}`, true);
      for (const set of [this.lapsed, this.without]) set.delete(`${member}:${canonical}`);
      this.rests.delete(`${member}:${canonical}`);
      this.claudePlans.delete(id);
      this.claudePlans.delete(`${member}:${canonical}`);
      this.ready.set(id, true);
      for (const s of [this.lapsed, this.without]) s.delete(id);
      this.rests.delete(id);
      this.onSignedIn?.(member, flow.id ?? key);
    } catch (e: any) {
      if (flow.state !== 'waiting') return; // cancelled: already settled
      const error = String(e?.message ?? e);
      const why: Why = e?.why ?? (e?.code === 'EADDRINUSE' ? 'busy' : flow.timedOut ? 'tooLong' : failure(error));
      console.error('Sign-in failed');
      Object.assign(flow, { state: 'failed', url: undefined, code: undefined, expiresAt: undefined, why,
        error: why === 'busy' || why === 'tooLong' ? say(`signIn.${why}`, { name: p.name }) : signInError(p.name, error) });
    } finally {
      clearTimeout(timer);
      clearTimeout(stuck);
      close();
      if (flow.state !== 'done') { this.additions.delete(id); this.runtimes.delete(id); }
      this.onChange?.(member, flow.id ?? key);
    }
  }

  /** Listen where the provider sends the browser back; rejects if something else on this computer already listens there. */
  private catchRedirect(loopback: Loopback, flow: Flow, name: string, port: number) {
    const app = this.opts.app ?? 'the app';
    const page = (status: number, words: string, close = false) => ({ status, html: callbackPage(this.opts.app ?? name, words, close) });
    return loopback(port, async (path) => {
      const q = new URL(path, 'http://localhost').searchParams;
      if (!flow.oauthState || q.get('state') !== flow.oauthState || flow.state !== 'waiting') return page(400, say('callback.outOfDate', { app, name }));
      if (q.get('error')) flow.refuse?.(new Error(q.get('error')!));
      // The engine only reads the query; the address it expects is the provider's registered one, on its fixed port.
      else flow.paste?.(`http://localhost:${port}${path}`);
      // The tab waits for the real outcome (a few seconds at most), so it never says "signed in" before it is.
      await Promise.race([flow.done, new Promise((r) => (setTimeout(r, 30_000) as any).unref?.())]);
      const end = flow.state as SignIn['state'];
      if (end === 'done') return page(200, say('callback.done', { app }), true);
      if (flow.why === 'declined') return page(200, say('callback.declined', { app }), true);
      return page(200, end === 'failed' ? say('callback.failed', { app, error: flow.error ?? '' }) : say('callback.nearly', { app }));
    });
  }

  /** The redirect address (or a code) pasted back, for when the browser couldn't return to this computer by itself. */
  paste(member: M, key: string, text: string) {
    key = this.preferred.get(`${member}:${key}`) ?? key;
    const f = this.flows.get(`${member}:${key}`);
    if (f?.state !== 'waiting' || !f.paste) throw Object.assign(new Error('no sign-in is waiting'), { status: 409 });
    f.paste(text.trim());
  }

  /** Stop a sign-in and forget it; nothing it started is kept. */
  cancel(member: M, key: string) { this.cancelFlow(member, this.preferred.get(`${member}:${key}`) ?? key); }

  private cancelFlow(member: M, key: string) {
    const f = this.flows.get(`${member}:${key}`);
    if (f?.state === 'waiting') { f.state = 'failed'; f.abort.abort(); f.refuse?.(new Error('cancelled')); }
    this.flows.delete(`${member}:${key}`);
    this.onChange?.(member, key);
  }

  private async refreshed(member: M, key: string, minOAuthValidityMs: number) {
    const p = this.offer(key);
    if (this.isKey(p)) return this.signedIn(member, key);
    const pi = p.pi;
    key = this.accountKey(member, key);
    return (await this.runtime(member, key)).getAuth(pi, { minOAuthValidityMs }).then(Boolean, async (e: Error) => {
      if (offline(e)) return true;
      if (e?.message === `OAuth refresh returned a token that expires too soon for ${pi}`) {
        const c = await this.store(member).read(this.storageKey(key));
        return c?.type === 'oauth' && c.expires > Date.now();
      }
      // A revoked (invalid_grant) or quarantined refresh requires sign-in again. A lost answer, any other refusal (a
      // passing 401 included), a server error or a read failure before sending (a locked keychain) is unknown: try later.
      const status = (e as any)?.status;
      return typeof status !== 'number' || status < 400 || status > 403;
    });
  }

  /** Refresh every signed-in account an hour ahead of expiry (call it now and then), so a sign-in never lapses while
   *  nobody is looking. A revoked or uncertain refresh requires sign-in again; `onExpired` says so once. A lost answer,
   *  any other refusal, a server error or a storage read failure before sending keeps the sign-in and is retried. */
  async keepFresh(members: readonly M[]) {
    for (const m of members) {
      const keys = new Set([...this.ready].filter(([id, ready]) => ready && id.startsWith(`${m}:`)).map(([id]) => this.accountKey(m, id.slice(String(m).length + 1))));
      for (const row of await this.store(m).list().catch(() => [])) keys.add(this.publicKey(row.providerId));
      for (const key of keys) {
        if ((!key.includes(':') && !this.providers.some((p) => p.key === this.providerKey(key))) || this.ready.get(`${m}:${key}`) === false) continue;
        const ok = await this.refreshed(m, key, 60 * 60_000);
        if (!ok) { this.forgetAccount(m, key); this.onExpired?.(m, key); }
      }
    }
  }

  /** After the account turned a request away: true if its sign-in still refreshes or the refresh failed in passing; it is
   *  signed out for good only when the provider proves the grant revoked (or the grant is quarantined). */
  async recheck(member: M, key: string) {
    key = await this.resolveKey(member, key);
    if (await this.endpointRecord(member, key)) { await this.logout(member, key); return false; }
    const p = this.offer(key);
    // A saved API key cannot refresh itself after an authentication refusal.
    const ok = this.isKey(p)
      ? false : await this.refreshed(member, key, 365 * 86_400_000);
    if (!ok) { await this.logout(member, key).catch(() => {}); this.forgetAccount(member, key); }
    return ok;
  }

  /** Signs out here, and at the provider too where it can end a sign-in (ChatGPT), best effort: the sign-in is deleted
   *  here whatever the provider answers. */
  logout(member: M, key: string) { return this.endAccount(member, key); }

  private async endAccount(member: M, key: string, exact = false) {
    const endpoint = key.startsWith('endpoint.') ? await this.endpointRecord(member, key) : undefined;
    if (endpoint) {
      await this.serial(`${member}:${key}`, async () => {
        await this.store(member).index((i, data) => {
          const config = i.accounts?.[key]?.endpoint;
          if (config) config.active = false;
          delete data[key];
        });
        if (endpoint.hasKey) await this.keys(member, (store) => store.delete(`accounts.${key}`));
      });
      this.onChange?.(member, key);
      return;
    }
    // Invalidate synchronously before any storage read can yield to an in-flight refresh.
    const initial = this.accountKey(member, exact ? key : this.preferred.get(`${member}:${key}`) ?? key);
    const initialId = `${member}:${initial}`;
    this.generations.set(initialId, (this.generations.get(initialId) ?? 0) + 1);
    if ((await this.index(member)).accounts?.[key]?.cloud) {
      await this.serial(`${member}:${key}`, async () => {
        const a = (await this.index(member)).accounts?.[key]?.cloud;
        if (!a) return;
        if (route(a.route).via === 'key') await this.keys(member, (store) => store.delete(`accounts.${key}`));
        await this.store(member).index((index, data) => {
          delete data[key]; delete index.accounts?.[key];
          for (const map of [index.names, index.emails, index.plans, index.addedAt]) delete map[key];
          if (index.defaults.account === key) delete index.defaults.account;
        });
      });
      this.onChange?.(member, key);
      return;
    }
    key = exact || this.additions.has(`${member}:${key}`) ? this.accountKey(member, key) : await this.resolveKey(member, key);
    const p = this.offer(key);
    const id = `${member}:${key}`;
    if (id !== initialId) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.claudePlans.delete(id);
    this.cancelFlow(member, key);
    const work = (async () => {
      if (this.isKey(p)) {
        this.keyRoute(key);
        await this.serial(id, async () => {
          await this.keys(member, (store) => store.delete(`accounts.${key}`));
          await this.store(member).delete(this.storageKey(key)).catch(() => { throw new Error('This account could not be removed. Try again.'); });
        });
        this.ready.set(id, false);
        this.onChange?.(member, key);
        return;
      }
      const rt = await this.runtime(member, key);
      let error: unknown;
      try {
        if (p.revoke) await rt.credentialStore.signOut(p.pi, p);
        else await rt.logout(p.pi);
      } catch (e) { error = e; }
      this.ready.set(id, false);
      this.claudePlans.delete(id); // a read started while signing out
      this.onChange?.(member, key);
      if (error) throw error;
    })();
    this.signingOut.set(id, work);
    try { await work; } finally { if (this.signingOut.get(id) === work) this.signingOut.delete(id); }
  }

  view(member: M, key: string): SignIn | null {
    key = this.preferred.get(`${member}:${key}`) ?? key;
    const f = this.flows.get(`${member}:${key}`);
    return f ? { ...(f.id ? { id: f.id } : {}), state: f.state, via: f.via, url: f.url, code: f.code, expiresAt: f.state === 'waiting' ? f.expiresAt : undefined, error: f.error, why: f.why } : null;
  }

  stop() { for (const f of this.flows.values()) f.abort.abort(); }
}
