// Sign in with the AI plan you already pay for, one person at a time, into that person's own store. Sharing one
// person's plan breaks the vendors' terms, so every sign-in, rest and refresh is keyed by member and account.
// The engine does the signing in (Pi's own flows on a computer, portableEngine on phones and in browsers); the app only
// shows the provider's page to open or the code to type. No Node import here: see index.ts for the computer's side.
import type { AuthPrompt, CredentialStore, Models } from '@earendil-works/pi-ai';
import { offered, provider, type Provider } from './catalogue.ts';
import { claims, PORTABLE, portableEngine } from './engine.ts';
import { classify, REST_MS, type Kind } from './limits.ts';
import { memoryStore } from './stores.ts';
import { callbackPage, clock, failure, say, signInError, type WordKey, type Why } from './words.ts';

/** What signing in needs from an engine: Pi's `Models`, or anything shaped like it (the coding agent's `ModelRuntime`). */
type BoundStore = CredentialStore & { signOut: (id: string, p: Provider) => Promise<void> };
export type AuthHost = Pick<Models, 'login' | 'logout' | 'checkAuth' | 'getAuth'> & { readCredential: CredentialStore['read']; credentialStore: BoundStore };
export type Member = string | number;
/** What the person sees while signing in: the provider's own page to open (`via: 'browser'`), or a code to type there
 *  (`via: 'code'`), never the engine's own prompts. `why` names how a failed one failed, for apps that word it themselves. */
export type SignIn = { state: 'waiting' | 'done' | 'failed'; via?: 'browser' | 'code'; url?: string; code?: string; expiresAt?: number; error?: string; why?: Why };
export type Status = { account: string; name: string; state: 'ready' | 'signing' | 'resting' | 'signed_out' | 'needs_again' | 'not_included'; until?: number; words: string };
type Flow = SignIn & { generation: number; abort: AbortController; paste?: (text: string) => void; refuse?: (e: Error) => void; timedOut?: boolean; toCode?: boolean;
  oauthState?: string; done?: Promise<void>; shown?: () => void };

/** Listens on this computer for the provider's page coming back: each request's path in, the page to answer with out. */
export type Loopback = (port: number, handle: (path: string) => Promise<{ status: number; html: string }>) => Promise<{ close(): void }>;
/** What differs by platform: the engine that signs in, which providers it can, and (on a computer) a loopback listener. */
export type Platform = { engine: (credentials: CredentialStore, authBase?: string) => AuthHost; signsIn: (pi: string) => boolean; loopback?: Loopback };
/** Phones and browsers: ChatGPT by device code, no listener. */
export const portable: Platform = { engine: (c, base) => portableEngine(c, { base }), signsIn: (pi) => PORTABLE.includes(pi) };

export type AccountsOptions<M extends Member = Member> = {
  /** The accounts this app offers, in order. Default: every provider not hidden (ChatGPT, OpenRouter). */
  offer?: readonly string[];
  /** Each member's own store. Default: in memory. */
  store?: (member: M) => CredentialStore;
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
};

/** The ChatGPT plan behind a sign-in, from its own token: a work plan (Business, Enterprise, Edu) follows the employer's rules. */
export function planOf(access: string): { plan: string; email: string; work: boolean } {
  let c: any = {};
  try { c = claims(access); } catch {}
  const plan = String(c['https://api.openai.com/auth']?.chatgpt_plan_type ?? '').toLowerCase();
  return { plan, email: String(c['https://api.openai.com/profile']?.email ?? c.email ?? ''), work: /^(team|business|enterprise|edu|education|k12)/.test(plan) };
}

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
  private stores = new Map<string, CredentialStore>();
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
  onChange?: (member: M, key: string) => void;
  /** A sign-in just finished and works. */
  onSignedIn?: (member: M, key: string) => void;
  /** Said once when a sign-in can no longer be refreshed. */
  onExpired?: (member: M, key: string) => void;
  onSignOutError?: (member: M, key: string, error: Error) => void;

  private platform: Platform;
  /** Offered: the providers named in `offer`, else every provider not hidden that this platform can sign in to. */
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
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>) => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };
      s = {
        read: (id) => base.read(id),
        list: () => base.list(),
        modify: (id, fn) => serial(() => base.modify(id, fn)),
        delete: (id) => serial(() => base.delete(id)),
        end: (id, fn) => serial(async () => { try { await fn(await base.read(id)); } finally { await base.delete(id); } }),
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

  protected boundStore(member: M, raw: CredentialStore): BoundStore {
    const key = (id: string) => `${member}:${this.providers.find((p) => p.pi === id)?.key ?? id}`;
    return {
      read: (id, options) => raw.read(id, options),
      list: (options) => raw.list(options),
      modify: (id, fn, options) => {
        const account = key(id);
        const stale = Symbol();
        const started = options?.signal ? this.signals.get(options.signal) ?? this.generations.get(account) ?? 0 : this.generations.get(account) ?? 0;
        const discard = async (next: Awaited<ReturnType<CredentialStore['read']>>) => {
          const p = this.providers.find((p) => p.pi === id);
          if (next?.type === 'oauth' && p?.revoke) {
            try { await revoke(this.opts.authBase ? `${this.opts.authBase}/oauth/revoke` : p.revoke!, p.clientId, next); } catch (e) {
              const error = e instanceof Error ? e : new Error(String(e));
              if (this.onSignOutError) this.onSignOutError(member, p.key, error);
              else console.error(`sign-out ${p.key} for member ${member}:`, error);
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
          if (c?.type === 'oauth') await revoke(this.opts.authBase ? `${this.opts.authBase}/oauth/revoke` : p.revoke!, p.clientId, c);
        } catch (e) { error = e; }
        await raw.delete(id);
        if (error) throw error;
      }),
    };
  }

  protected engine(member: M, raw: CredentialStore): Promise<R> {
    const credentials = this.boundStore(member, raw);
    return Promise.resolve(Object.assign((this.opts.engine ?? this.platform.engine)(credentials, this.opts.authBase), {
      credentialStore: credentials, readCredential: (id: string) => credentials.read(id),
    }) as R);
  }

  /** A member's engine, holding only their own sign-ins (`store(member)`). Override to use another engine with the same seam. */
  protected open(member: M): Promise<R> { return this.engine(member, this.store(member)); }

  runtime(member: M) {
    let r = this.runtimes.get(String(member));
    if (!r) this.runtimes.set(String(member), r = this.open(member));
    return r;
  }

  private offer(key: string) {
    const p = provider(key);
    if (!this.providers.includes(p)) throw Object.assign(new Error('AI account not offered here'), { status: 404 });
    return p;
  }

  /** Signed in, from the engine's own side-effect-free check. */
  async signedIn(member: M, key: string) {
    const ok = !!(await (await this.runtime(member)).checkAuth(this.offer(key).pi).catch(() => undefined));
    this.ready.set(`${member}:${key}`, ok);
    if (ok) this.lapsed.delete(`${member}:${key}`);
    return ok;
  }

  /** Which ChatGPT the member signed in with: its plan, email, and whether it is a work account. Null when not signed in. */
  async plan(member: M) {
    const c = await (await this.runtime(member)).readCredential(this.offer('chatgpt').pi).catch(() => undefined);
    return c?.type === 'oauth' ? planOf(c.access) : null;
  }

  /** Whether the member's plan lacks this use; `on` records what the provider said, or that the person changed plans. */
  notIncluded(member: M, key: string, on?: boolean) {
    const id = `${member}:${key}`;
    if (on !== undefined) { if (on) this.without.add(id); else this.without.delete(id); this.onChange?.(member, key); }
    return this.without.has(id);
  }

  /** Known to be unusable: signed out, or a plan without this use. An unchecked account counts as usable, so a first run still tries. */
  unready(member: M, key: string) { return this.ready.get(`${member}:${key}`) === false || this.without.has(`${member}:${key}`); }

  /** The account turned a request away (its sign-in lapsed): signed out until the person signs in again. */
  forget(member: M, key: string) {
    this.ready.set(`${member}:${key}`, false);
    this.lapsed.add(`${member}:${key}`);
    this.onChange?.(member, key);
  }

  /** 0 when the account is available; otherwise when it stops resting. */
  restingUntil(member: M, key: string) {
    const r = this.rests.get(`${member}:${key}`);
    return r && r.until > Date.now() ? r.until : 0;
  }

  /** An account's error, acted on. A limit or overload rests it (until when it said, or a default). A plan without this
   *  use is marked so. A refusal is checked: a sign-in that no longer refreshes is signed out for real, one that still
   *  does was a passing refusal and rests a few minutes (kind `overloaded`) rather than loop. Returns the kind acted on,
   *  or null for an error that is not about the account; `network` changes nothing. */
  async failed(member: M, key: string, error: string) {
    const c = classify(error);
    if (!c || c.kind === 'network') return c;
    if (c.kind === 'signed_out' && await this.recheck(member, key)) c.kind = 'overloaded';
    if (c.kind === 'not_included') this.notIncluded(member, key, true);
    else if (c.kind !== 'signed_out') {
      c.until ||= Date.now() + REST_MS[c.kind];
      this.rests.set(`${member}:${key}`, { until: c.until, kind: c.kind });
      this.onChange?.(member, key);
    }
    return c;
  }

  /** The first choice whose account is neither resting nor known to be unusable: the fallback ladder. */
  ladder<T>(member: M, choices: readonly T[], key: (c: T) => string = String) {
    return choices.find((c) => !this.restingUntil(member, key(c)) && !this.unready(member, key(c)));
  }

  /** Where one account stands, in one plain sentence every app shows the same way. */
  async status(member: M, key: string): Promise<Status> {
    const { name } = this.offer(key);
    const id = `${member}:${key}`;
    const s = (state: Status['state'], w: WordKey, until?: number): Status => ({ account: key, name, state, until, words: say(w, { name, until: until ? clock(until) : '' }) });
    if (this.flows.get(id)?.state === 'waiting') return s('signing', 'status.signing');
    const until = this.restingUntil(member, key);
    if (until) return s('resting', this.rests.get(id)!.kind === 'rate_limit' ? 'status.resting' : 'status.busy', until);
    if (!(this.ready.get(id) ?? await this.signedIn(member, key))) return this.lapsed.has(id) ? s('needs_again', 'status.needsAgain') : s('signed_out', 'status.signedOut');
    return this.without.has(id) ? s('not_included', 'status.notIncluded') : s('ready', 'status.ready');
  }

  /** Start "Sign in with …". The provider's own page by default: where it has a fixed redirect back to this computer
   *  (ChatGPT), the kit listens there itself, so the tab shows the app's words, and only once they are true. The code is
   *  the fallback: asked for (`via: 'code'`, "Having trouble?", even mid-way), or by itself when no redirect has come back
   *  in time, or when a browser sign-in could not return at all. `fresh` asks the page which account again. A flow that
   *  stalls times out; nothing is kept unless the engine then sees a working sign-in; every failure ends in one plain
   *  sentence. Returns as soon as there is a page to open or a code to show (or it is over); the rest carries on by itself. */
  async login(member: M, key: string, body: { via?: 'code' | 'browser'; fresh?: boolean } = {}): Promise<SignIn | null> {
    this.offer(key);
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
  finished(member: M, key: string) { return this.flows.get(`${member}:${key}`)?.done ?? Promise.resolve(); }

  private toCode(flow: Flow) {
    if (flow.state !== 'waiting' || flow.via !== 'browser' || flow.toCode) return;
    flow.toCode = true;
    flow.refuse?.(new Error('switching to a code'));
  }

  private async signIn(member: M, key: string, body: { via?: 'code' | 'browser'; fresh?: boolean }, flow: Flow) {
    const p = this.offer(key);
    const id = `${member}:${key}`;
    const rt = await this.runtime(member);
    let codeOffered = false;
    const attempt = (via?: 'code' | 'browser') => rt.login(p.pi, 'oauth', {
      signal: flow.abort.signal,
      prompt: (q: AuthPrompt): Promise<string> => {
        if (q.type === 'select') {
          const device = q.options.find((o) => /device/i.test(o.id));
          codeOffered = !!device;
          return Promise.resolve((via === 'code' && device ? device : q.options.find((o) => o !== device) ?? q.options[0]).id);
        }
        if (q.type === 'text') return Promise.resolve(''); // GitHub Enterprise domain: never, for a household
        // "Paste the redirect address": the kit's own listener (or the person) hands the engine the address the browser landed on.
        return new Promise((resolve, reject) => {
          Object.assign(flow, { paste: resolve, refuse: reject });
          q.signal?.addEventListener('abort', () => reject(new Error('answered elsewhere')));
        });
      },
      notify: (e) => {
        if (e.type === 'auth_url') {
          const url = new URL(e.url);
          if (body.fresh) url.searchParams.set('prompt', 'login'); // "Use my personal account": ask which account, again
          Object.assign(flow, { via: 'browser', url: url.toString(), code: undefined, oauthState: url.searchParams.get('state') ?? undefined });
        }
        if (e.type === 'device_code') Object.assign(flow, { via: 'code', code: e.userCode, url: e.verificationUri, expiresAt: e.expiresInSeconds ? Date.now() + e.expiresInSeconds * 1000 : undefined });
        if (flow.url) flow.shown?.();
        this.onChange?.(member, key);
      },
    });
    const timer = setTimeout(() => { flow.timedOut = true; flow.abort.abort(); }, this.opts.signInMs ?? 15 * 60_000);
    const stuck = setTimeout(() => this.toCode(flow), this.opts.redirectMs ?? 3 * 60_000);
    // Listen where the provider sends the browser back (the engine then finds the port taken and waits to be handed the address).
    const port = p.callbackPort && (this.opts.callbackPort ?? p.callbackPort);
    const catcher = port && body.via !== 'code' && this.platform.loopback ? await this.catchRedirect(this.platform.loopback, flow, p.name, port).catch(() => null) : undefined;
    try {
      if (catcher === null) throw Object.assign(new Error('port busy'), { why: 'busy' as const });
      try { await attempt(body.via ?? (catcher ? 'browser' : undefined)); } catch (e) {
        // The code instead: asked for, or the page never came back. Also when a browser sign-in could not return here at all.
        if (!flow.toCode && (catcher || body.via === 'code' || !codeOffered || flow.abort.signal.aborted)) throw e;
        Object.assign(flow, { url: undefined, code: undefined, via: 'code' });
        catcher?.close();
        await attempt('code');
      }
      if (flow.generation !== (this.generations.get(id) ?? 0) || flow.state !== 'waiting') return;
      if (!(await rt.checkAuth(p.pi).catch(() => undefined))) { await rt.logout(p.pi).catch(() => {}); throw new Error('no usable credential'); }
      if (flow.generation !== (this.generations.get(id) ?? 0) || flow.state !== 'waiting') return;
      flow.state = 'done';
      this.ready.set(id, true);
      for (const s of [this.lapsed, this.without]) s.delete(id);
      this.rests.delete(id);
      this.onSignedIn?.(member, key);
    } catch (e: any) {
      if (flow.state !== 'waiting') return; // cancelled: already settled
      const error = String(e?.message ?? e);
      console.error(`sign-in ${key} for member ${member}:`, error);
      const why: Why = e?.why ?? (flow.timedOut ? 'tooLong' : failure(error));
      Object.assign(flow, { state: 'failed', url: undefined, code: undefined, expiresAt: undefined, why,
        error: why === 'busy' || why === 'tooLong' ? say(`signIn.${why}`, { name: p.name }) : signInError(p.name, error) });
    } finally {
      clearTimeout(timer);
      clearTimeout(stuck);
      catcher?.close();
      this.onChange?.(member, key);
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
    const f = this.flows.get(`${member}:${key}`);
    if (f?.state !== 'waiting' || !f.paste) throw Object.assign(new Error('no sign-in is waiting'), { status: 409 });
    f.paste(text.trim());
  }

  /** Stop a sign-in and forget it; nothing it started is kept. */
  cancel(member: M, key: string) {
    const f = this.flows.get(`${member}:${key}`);
    if (f?.state === 'waiting') { f.state = 'failed'; f.abort.abort(); f.refuse?.(new Error('cancelled')); }
    this.flows.delete(`${member}:${key}`);
    this.onChange?.(member, key);
  }

  private async refreshed(member: M, key: string, minOAuthValidityMs: number) {
    const pi = this.offer(key).pi;
    return (await this.runtime(member)).getAuth(pi, { minOAuthValidityMs }).then(Boolean, async (e: Error) => {
      if (offline(e)) return true;
      if (e?.message !== `OAuth refresh returned a token that expires too soon for ${pi}`) return false;
      const c = await this.store(member).read(pi);
      return c?.type === 'oauth' && c.expires > Date.now();
    });
  }

  /** Refresh every signed-in account an hour ahead of expiry (call it now and then), so a sign-in never lapses while
   *  nobody is looking. Only the provider refusing signs it out, and `onExpired` says so once; a network hiccup doesn't. */
  async keepFresh(members: readonly M[]) {
    for (const m of members) for (const p of this.providers) {
      if (this.ready.get(`${m}:${p.key}`) !== true) continue;
      const ok = await this.refreshed(m, p.key, 60 * 60_000);
      if (!ok) { this.forget(m, p.key); this.onExpired?.(m, p.key); }
    }
  }

  /** After the account turned a request away: true if its sign-in still refreshes; if not, it is signed out for good. */
  async recheck(member: M, key: string) {
    const ok = await this.refreshed(member, key, 365 * 86_400_000);
    if (!ok) { await this.logout(member, key).catch(() => {}); this.forget(member, key); }
    return ok;
  }

  /** Signs out here, and at the provider too where it can end a sign-in (ChatGPT), best effort: the sign-in is deleted
   *  here whatever the provider answers. */
  async logout(member: M, key: string) {
    const p = this.offer(key);
    const id = `${member}:${key}`;
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.cancel(member, key);
    const work = (async () => {
      const rt = await this.runtime(member);
      let error: unknown;
      try {
        if (p.revoke) await rt.credentialStore.signOut(p.pi, p);
        else await rt.logout(p.pi);
      } catch (e) { error = e; }
      this.ready.set(id, false);
      this.onChange?.(member, key);
      if (error) throw error;
    })();
    this.signingOut.set(id, work);
    try { await work; } finally { if (this.signingOut.get(id) === work) this.signingOut.delete(id); }
  }

  view(member: M, key: string): SignIn | null {
    const f = this.flows.get(`${member}:${key}`);
    return f ? { state: f.state, via: f.via, url: f.url, code: f.code, expiresAt: f.state === 'waiting' ? f.expiresAt : undefined, error: f.error, why: f.why } : null;
  }

  stop() { for (const f of this.flows.values()) f.abort.abort(); }
}
