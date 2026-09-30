import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Keystore } from '@byokit/secrets';
import { ConnectError } from './errors.ts';
import { discover, type Discovered } from './discovery.ts';
import { endpoint, redirect, request, json } from './http.ts';
import { providers, type ProviderId } from './providers.ts';
import type { ConnectOptions, OAuthClient, Provider, SignIn, McpOptions } from './types.ts';

interface Tokens { access: string; refresh?: string; expires?: number; scope?: string }
interface Saved extends Discovered { client: OAuthClient; tokens: Tokens }
interface Slot { tail: Promise<unknown>; epoch: number; tokenFlight?: { epoch: number; promise: Promise<string> } }
// Across handles, only the same store + person + connection share work. No global token cache.
const stores = new WeakMap<Keystore, Map<string, Slot>>();
function slotFor(store: Keystore, key: string): Slot {
  let slots = stores.get(store); if (!slots) { slots = new Map(); stores.set(store, slots); }
  let slot = slots.get(key); if (!slot) { slot = { tail: Promise.resolve(), epoch: 0 }; slots.set(key, slot); }
  return slot;
}
function serial<T>(slot: Slot, action: () => Promise<T>): Promise<T> {
  const next = slot.tail.then(action, action); slot.tail = next.catch(() => {}); return next;
}
function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function random(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }

/** One person's connection on one device; the host owns the store and browser. */
export class Connection {
  readonly provider: Readonly<Provider>;
  private options: ConnectOptions;
  private key: string;
  private storageKey?: Promise<string>;
  private slot: Slot;
  constructor(target: ProviderId | Provider | string, options: ConnectOptions) {
    const provider: Provider = typeof target === 'string'
      ? (Object.hasOwn(providers, target) ? providers[target as ProviderId] : { id: endpoint(target).href, name: 'App', mcpUrl: endpoint(target).href })
      : target;
    this.provider = Object.freeze({ ...provider,
      oauth: provider.oauth && Object.freeze({ ...provider.oauth }),
      scopes: provider.scopes && Object.freeze([...provider.scopes]),
      extra: provider.extra && Object.freeze({ ...provider.extra }),
    });
    if (!options.person || !this.provider.id) throw new ConnectError('configuration');
    redirect(options.redirectUri);
    if (this.provider.mcpUrl) endpoint(this.provider.mcpUrl);
    this.options = { ...options, scopes: options.scopes && Object.freeze([...options.scopes]), client: options.client && { ...options.client } };
    this.key = `byokit.connect:${JSON.stringify([options.person, this.provider.id, this.provider.mcpUrl ?? '', this.provider.oauth?.token ?? this.provider.issuer ?? '', options.client?.id ?? ''])}`;
    this.slot = slotFor(options.store, this.key);
  }
  private storeKey(): Promise<string> {
    return this.storageKey ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.key))
      .then(bytes => `byokit.connect.${base64url(new Uint8Array(bytes))}`);
  }
  private get fetcher(): typeof fetch { return this.options.fetch ?? globalThis.fetch; }
  private get timeout(): number { return this.options.timeoutMs ?? 20_000; }
  private get now(): number { return (this.options.now ?? Date.now)(); }
  private async saved(): Promise<Saved | null> {
    const raw = await this.options.store.get(await this.storeKey());
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Saved;
      if (!value.tokens?.access || typeof value.tokens.access !== 'string' || !value.client?.id || !value.endpoints?.token || !Array.isArray(value.scopes)) throw new Error();
      endpoint(value.endpoints.token);
      return value;
    } catch { throw new ConnectError('token'); }
  }
  async connected(): Promise<boolean> { return !!await this.saved(); }
  async disconnect(): Promise<void> {
    ++this.slot.epoch;
    await serial(this.slot, async () => { await this.options.store.delete(await this.storeKey()); });
  }
  /** Starts a fresh browser sign-in. No opt-in flag or server-held account is required. */
  async signIn(): Promise<SignIn> {
    const epoch = ++this.slot.epoch;
    const info = await discover(this.provider, this.fetcher, this.timeout);
    const scopes = this.options.scopes ?? info.scopes;
    const client = this.options.client ?? await this.register(info);
    if (!client.id || (client.authMethod !== 'none' && client.authMethod && !client.secret)) throw new ConnectError('configuration');
    const state = random(), verifier = random();
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const uri = this.options.redirectUri;
    const url = endpoint(info.endpoints.authorize);
    const fields = { ...this.provider.extra, response_type: 'code', client_id: client.id, redirect_uri: uri, state,
      code_challenge: challenge, code_challenge_method: 'S256', scope: scopes.join(' '), ...(info.resource ? { resource: info.resource } : {}) };
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    const ends = this.now + (this.options.flowTimeoutMs ?? 15 * 60_000);
    let consumed = false, cancelled = false;
    return { url: url.href, redirectUri: uri, cancel: () => { consumed = true; cancelled = true; }, finish: async callback => {
      if (consumed || epoch !== this.slot.epoch) throw new ConnectError('callback');
      if (this.now >= ends) { consumed = true; throw new ConnectError('expired'); }
      let returned: URL;
      try { returned = new URL(callback); } catch { throw new ConnectError('callback'); }
      const expected = new URL(uri);
      if (returned.protocol !== expected.protocol || returned.host !== expected.host || returned.pathname !== expected.pathname || returned.username || returned.password || returned.hash || returned.searchParams.getAll('state').length !== 1 || returned.searchParams.get('state') !== state) throw new ConnectError('callback');
      for (const [key, value] of expected.searchParams) if (returned.searchParams.getAll(key).length !== 1 || returned.searchParams.get(key) !== value) throw new ConnectError('callback');
      consumed = true;
      if (returned.searchParams.has('error')) throw new ConnectError('declined');
      if (returned.searchParams.getAll('code').length !== 1 || !returned.searchParams.get('code')) throw new ConnectError('callback');
      await serial(this.slot, async () => {
        if (epoch !== this.slot.epoch) throw new ConnectError('callback');
        const tokens = await this.exchange(info, client, { grant_type: 'authorization_code', code: returned.searchParams.get('code')!, redirect_uri: uri, code_verifier: verifier });
        if (cancelled) throw new ConnectError('declined');
        if (this.now >= ends) throw new ConnectError('expired');
        if (tokens.scope !== undefined && !scopes.every(sc => tokens.scope!.split(/\s+/).includes(sc))) throw new ConnectError('scope');
        if (epoch !== this.slot.epoch) throw new ConnectError('callback');
        await this.options.store.set(await this.storeKey(), JSON.stringify({ ...info, scopes, client, tokens } satisfies Saved));
      });
    } };
  }
  private async register(info: Discovered): Promise<OAuthClient> {
    if (!info.endpoints.register) throw new ConnectError('configuration');
    const response = await request(this.fetcher, info.endpoints.register, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_name: this.options.clientName ?? 'BYOKit', redirect_uris: [this.options.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    }, this.timeout);
    if (!response.ok) { await response.body?.cancel(); throw new ConnectError('registration', response.status); }
    const m = await json(response, 'registration');
    if (typeof m.client_id !== 'string' || !m.client_id || (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== 'none')) throw new ConnectError('registration');
    return { id: m.client_id, authMethod: 'none' };
  }
  private async exchange(info: Discovered, client: OAuthClient, fields: Record<string, string>, previous?: Tokens): Promise<Tokens> {
    const form = new URLSearchParams({ ...fields, client_id: client.id, ...(info.resource ? { resource: info.resource } : {}) });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const method = client.authMethod ?? (client.secret ? 'client_secret_post' : 'none');
    if (method === 'client_secret_post' && client.secret) form.set('client_secret', client.secret);
    if (method === 'client_secret_basic' && client.secret) {
      const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
      headers.authorization = `Basic ${btoa(`${encode(client.id)}:${encode(client.secret)}`)}`;
      form.delete('client_id');
    }
    const response = await request(this.fetcher, info.endpoints.token, { method: 'POST', headers, body: form }, this.timeout);
    const m = await json(response, 'token');
    if (!response.ok || m.error) {
      // Only an explicit invalid grant proves revocation. Transient failures preserve the sign-in.
      if (m.error === 'invalid_grant' && previous) throw new ConnectError('signin', response.status);
      throw new ConnectError('token', response.status);
    }
    if (typeof m.access_token !== 'string' || !m.access_token || typeof m.token_type !== 'string' || m.token_type.toLowerCase() !== 'bearer' || (m.expires_in !== undefined && (!Number.isFinite(Number(m.expires_in)) || Number(m.expires_in) < 0))) throw new ConnectError('token');
    return { access: m.access_token, refresh: typeof m.refresh_token === 'string' ? m.refresh_token : previous?.refresh,
      expires: m.expires_in === undefined ? undefined : this.now + Number(m.expires_in) * 1000,
      scope: typeof m.scope === 'string' ? m.scope : previous?.scope };
  }
  /** For trusted app code (mail/calendar/API calls). Never display or log this value. */
  async token(rejectedAccessToken?: string): Promise<string> {
    const epoch = this.slot.epoch;
    if (this.slot.tokenFlight?.epoch === epoch) return this.slot.tokenFlight.promise;
    const promise = serial(this.slot, async () => {
      if (epoch !== this.slot.epoch) throw new ConnectError('signin');
      const saved = await this.saved();
      if (!saved) throw new ConnectError('signin');
      const old = saved.tokens;
      const force = rejectedAccessToken !== undefined && rejectedAccessToken === old.access;
      if (!force && (old.expires === undefined || old.expires - this.now > 60_000)) return old.access;
      if (!old.refresh) {
        if (!force && old.expires !== undefined && old.expires > this.now) return old.access;
        throw new ConnectError('signin');
      }
      try {
        const tokens = await this.exchange(saved, saved.client, { grant_type: 'refresh_token', refresh_token: old.refresh }, old);
        if (epoch !== this.slot.epoch) throw new ConnectError('signin');
        await this.options.store.set(await this.storeKey(), JSON.stringify({ ...saved, tokens }));
        return tokens.access;
      } catch (error) {
        if (error instanceof ConnectError && error.code === 'signin' && epoch === this.slot.epoch) await this.options.store.delete(await this.storeKey());
        if (!force && error instanceof ConnectError && error.code === 'network' && old.expires !== undefined && old.expires > this.now) return old.access;
        throw error;
      }
    });
    this.slot.tokenFlight = { epoch, promise };
    try { return await promise; } finally { if (this.slot.tokenFlight?.promise === promise) this.slot.tokenFlight = undefined; }
  }
  /** The full official SDK Client: typed helpers, schemas, handlers, notifications and requests. */
  async mcp(options: McpOptions = {}): Promise<Client> {
    if (!this.provider.mcpUrl) throw new ConnectError('configuration');
    const url = endpoint(this.provider.mcpUrl);
    const fetcher: typeof fetch = async (input, init) => {
      // Transport may issue POST/GET/DELETE; credentials remain bound to this resource.
      const requested = input instanceof Request ? input.url : String(input);
      if (endpoint(requested).href !== url.href) throw new ConnectError('configuration');
      const access = await this.token();
      const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${access}`);
      const response = await request(this.fetcher, url, { ...init, headers }, this.timeout);
      if (response.status !== 401) return response;
      await response.body?.cancel();
      headers.set('authorization', `Bearer ${await this.token(access)}`);
      return request(this.fetcher, url, { ...init, headers }, this.timeout);
    };
    const client = new Client(options.clientInfo ?? { name: this.options.clientName ?? 'byokit', version: '0.1.0' }, options.clientOptions);
    try {
      options.configure?.(client);
      await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetcher }));
      return client;
    } catch (error) { await client.close().catch(() => {}); throw error; }
  }
}
export function connect(provider: ProviderId | Provider | string, options: ConnectOptions): Connection { return new Connection(provider, options); }
