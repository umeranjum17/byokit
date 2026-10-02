// Internal host runtime (5.17). Production handoff is deliberately unprotected until W7/O17 qualification.
import { randomBytes } from 'node:crypto';
import type { BrowserHost, BrowserOptions, BrowserState, LiveFrame, LiveInput, LiveSource, LiveViewState, NeedSignIn,
  SignInReason, SignInMethodHint, SignInRefusedWhy, TakeoverLease, ThumbnailResult } from '../browser.ts';
import type { Member } from '../types.ts';
import { BrowserStoreError, checkUrl, validOrigin, type SignInData, type SignInStore } from './store.ts';
import { validateVerifiers, verifySignIn, type Probe } from './verify.ts';
import { dispatchResume, newResume, recoverResume, type ResumeDispatch } from './resume.ts';

// Exact accepted internal Broker seam from handoff.md; structural so W1 can implement independently.
export type HostBroker = {
  endpoint(): { cdpUrl: string };
  fence(on: boolean): Promise<void>;
  agentTab(): string | undefined;
  originOf(targetId: string): Promise<string>;
  openPrivate(url: string): Promise<string>;
  closePrivate(): Promise<void>;
  probe(url: string, verify: (p: Probe) => Promise<boolean>, timeoutMs: number): Promise<'ok' | 'fail' | 'timeout'>;
  attachViewer(o: { lease?: { epoch: number; nonce: string } }): { frames: AsyncIterable<LiveFrame>; states: AsyncIterable<{ origin: string; secure: boolean; offOrigin: boolean }>; input(i: LiveInput): void; close(): void };
  bindLease(l: { epoch: number; nonce: string; origin: string; knownIdps: string[] } | null): void;
  confirmOrigin(l: { epoch: number; nonce: string }, origin: string): boolean;
  privateState(): { origin: string; secure: boolean; offOrigin: boolean } | undefined;
  clearSite(origins: string[]): Promise<void>;
  navigateAgent(url: string | 'reload'): Promise<void>;
  close(): Promise<void>;
};
export class SignInRefused extends Error {
  readonly why: SignInRefusedWhy;
  constructor(why: SignInRefusedWhy) { super(`sign-in refused: ${why}`); this.why = why; }
}
export class HandoffUnprotected extends Error {
  readonly why = 'handoff-unprotected';
  constructor() { super('browser sign-in handoff unavailable'); }
}
export type RaiseSignIn = { member: Member; sessionKey: string; checkUrl: string; targetId?: string;
  reasons: SignInReason[]; hints?: SignInMethodHint[] };
export type BrowserHostServices = {
  brokers: ReadonlyMap<Member, HostBroker>;
  store: SignInStore;
  options: BrowserOptions;
  authorize(grant: string, member: Member, control: boolean): boolean;
  park(member: Member, sessionKey: string): Promise<void>;
  resume: ResumeDispatch;
  // Host's PSL-aware site resolver, not model/device input. No last-two-label domain guessing.
  siteOf(origin: string): string;
  // No capability flag enables production handoff here: W7/O17 remains kit-owned and unqualified.
  ping?: (member: Member, kind: 'state' | 'signin') => void;
  now?: () => number;
  // Launch only another kit-owned broker; no engine/model dispatch during recovery.
  restart?: (member: Member, attempt: number) => Promise<HostBroker | undefined>;
};
type LeaseRef = Pick<TakeoverLease, 'requestId' | 'epoch' | 'nonce'>;
type Lease = { value: TakeoverLease; grant: string; target: string; attached: boolean; deadline: number; timer?: ReturnType<typeof setTimeout> };
type Stream = { member: Member; grant: string; control: boolean; close(why?: LiveViewState['why']): void };
const open = (r: NeedSignIn) => ['waiting', 'held', 'checking'].includes(r.state);
const mint = () => randomBytes(16).toString('base64url');
export function secureOrigin(origin: string): boolean {
  const u = new URL(validOrigin(origin));
  return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(u.hostname);
}

export interface BrowserHostController extends BrowserHost {
  raise(input: RaiseSignIn): Promise<NeedSignIn>;
  revokeGrant(grant: string): Promise<void>;
  sweep(): Promise<void>;
  browserGone(member: Member, expected?: HostBroker): Promise<void>;
  beforeRun(member: Member, sessionKey: string): Promise<boolean>;
  // Internal: caller supplies an owned broker; publish its engine endpoint only after resolution.
  attachBroker(member: Member, broker: HostBroker, previous?: HostBroker): Promise<void>;
  close(): Promise<void>;
}
export async function createBrowserHost(services: BrowserHostServices): Promise<BrowserHostController> {
  return startHost(services, false);
}
// TEST ONLY. Requires loopback-only synthetic brokers; never imported by kit wiring. No production enable flag.
export async function fixtureBrowserHost(services: BrowserHostServices): Promise<BrowserHostController> {
  for (const broker of services.brokers.values()) {
    const target = broker.agentTab();
    if (!target) throw new Error('fixture browser required');
    const origin = await broker.originOf(target);
    if (!secureOrigin(origin) || new URL(origin).protocol !== 'http:') throw new Error('loopback fixture required');
  }
  return startHost(services, true);
}
async function startHost(services: BrowserHostServices, fixture: boolean): Promise<BrowserHostController> {
  const host = new Host(services, fixture);
  await host.restore();
  return host;
}
class Host implements BrowserHostController {
  private readonly s: BrowserHostServices;
  private readonly fixture: boolean;
  private data: SignInData;
  private committed: SignInData;
  private readonly brokers: Map<Member, HostBroker>;
  private readonly attaching = new Set<Member>;
  private readonly recovery = new Map<Member, NonNullable<BrowserState['recovery']>>();
  private readonly exhausted = new Set<Member>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly leases = new Map<string, Lease>();
  private readonly epochs = new Map<Member, number>();
  private readonly streams = new Set<Stream>();
  private readonly unavailable = new Set<Member>();
  private readonly closing = new Set<string>();
  private readonly revoked = new Set<string>();
  private readonly thumbs = new Map<Member, { at: number; frame: LiveFrame }>();
  private ttl?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failed = false;
  constructor(services: BrowserHostServices, fixture: boolean) {
    this.s = services;
    this.fixture = fixture;
    validateVerifiers(services.options.verifiers ?? []);
    for (const origin of services.options.knownIdps ?? []) validOrigin(origin);
    for (const n of ['requestTtlMs', 'leaseTtlMs', 'claimMs', 'graceMs', 'checkMs'] as const) {
      const value = services.options[n];
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) throw new Error('invalid browser timeout');
    }
    const recovery = services.options.recovery;
    if (recovery && (!Number.isInteger(recovery.attempts) || recovery.attempts < 0 || recovery.attempts > 3
      || recovery.backoffMs.some(n => !Number.isSafeInteger(n) || n < 0 || n > 60_000))) throw new Error('invalid browser recovery');
    this.brokers = new Map(services.brokers);
    this.data = services.store.read();
    this.committed = structuredClone(this.data);
  }
  private now() { return this.s.now?.() ?? Date.now(); }
  private broker(member: Member): HostBroker {
    const broker = this.brokers.get(member);
    if (!broker || this.unavailable.has(member)) throw new SignInRefused('unsupported');
    return broker;
  }
  private currentBroker(member: Member, broker: HostBroker): void {
    if (this.stopped || this.failed || this.unavailable.has(member) || this.brokers.get(member) !== broker) throw new SignInRefused('stale');
  }
  attachBroker(member: Member, next: HostBroker, previous?: HostBroker): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(member) || (this.s.options.members !== 'all' && !this.s.options.members.includes(member))
      || this.stopped || this.failed) return Promise.reject(new SignInRefused('unsupported'));
    if (this.attaching.has(member)) return Promise.reject(new SignInRefused('held-by-other'));
    const old = this.brokers.get(member);
    if (old !== previous) return Promise.reject(new SignInRefused('stale'));
    if (old === next) return Promise.resolve();
    this.attaching.add(member); this.unavailable.add(member); this.thumbs.delete(member);
    this.recovery.delete(member);
    this.epochs.set(member, (this.epochs.get(member) ?? 0) + 1);
    const requests = this.data.requests.filter(r => r.member === member);
    // No await before old capabilities are invalidated. New endpoint is not yet published to the engine.
    try {
      for (const r of requests) { this.closing.add(r.id); this.drop(r); }
      old?.bindLease(null);
    } catch { this.failed = true; }
    for (const s of this.streams) if (s.member === member) s.close('browser-gone');
    // ponytail: one host-wide queue keeps the single durable file atomic; split per member if latency matters.
    return this.serial(async () => {
      try {
        if (this.brokers.get(member) !== old) throw new SignInRefused('stale');
        await next.fence(true);
        if (old) { await old.fence(true); await old.closePrivate(); await old.close(); }
        if (this.stopped || this.failed) throw new SignInRefused('unsupported');
        for (const r of this.data.requests.filter(r => r.member === member)) {
          recoverResume(r);
          if (r.state === 'held' || r.state === 'checking') {
            r.state = 'settled'; r.settled = { state: 'failed', reason: 'browser-gone', at: this.now() };
          } else if (r.state === 'waiting' || r.state === 'parked') r.gen++;
        }
        this.commit();
        await next.fence(this.data.requests.some(r => r.member === member && open(r)));
        if (this.stopped || this.failed || this.brokers.get(member) !== old) throw new SignInRefused('stale');
        this.brokers.set(member, next); this.unavailable.delete(member); this.exhausted.delete(member);
        for (const r of requests) { this.closing.delete(r.id); this.ping(r); }
        try { this.s.ping?.(member, 'state'); } catch { /* advisory */ }
      } catch {
        this.exhausted.add(member);
        for (const r of requests) if (r.state !== 'settled') {
          r.state = 'settled'; r.settled = { state: 'failed', reason: 'browser-gone', at: this.now() };
        }
        if (!this.failed) this.commit();
        throw new SignInRefused('unsupported');
      }
    }).catch(async e => { try { await next.close(); } catch { /* never expose endpoint details */ } throw e; })
      .finally(() => { this.attaching.delete(member); });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.failed || this.stopped) throw new SignInRefused('unsupported');
      try { return await fn(); }
      catch (e) {
        if (e instanceof SignInRefused || e instanceof BrowserStoreError || e instanceof HandoffUnprotected) throw e;
        throw new Error('browser action unavailable');
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private commit() {
    try { this.s.store.write(this.data); this.committed = structuredClone(this.data); }
    catch { this.data = structuredClone(this.committed); this.failed = true; this.streams.forEach(s => s.close('browser-gone')); throw new Error('browser state unavailable'); }
    this.arm();
  }
  private ping(r: NeedSignIn) { try { this.s.ping?.(r.member, 'signin'); } catch { /* invalidation is advisory */ } }
  private arm() {
    clearTimeout(this.ttl);
    const expires = this.data.requests.filter(r => r.state === 'waiting' || r.state === 'held').map(r => r.expires);
    if (!expires.length) return;
    this.ttl = setTimeout(() => { void this.sweep().catch(() => {}); }, Math.max(1, Math.min(...expires) - this.now()));
    this.ttl.unref?.();
  }
  async restore() {
    for (const r of this.data.requests) {
      recoverResume(r);
      if (r.state === 'held' || r.state === 'checking') {
        r.state = 'settled'; r.settled = { state: 'failed', reason: 'browser-gone', at: this.now() };
      } else if (r.state === 'waiting' || r.state === 'parked') r.gen++;
      if (open(r)) await this.broker(r.member).fence(true);
    }
    // No dispatch on restore, regardless of gateway process/cache state or submission marker.
    this.commit();
  }
  state(member: Member): BrowserState {
    if (this.attaching.has(member)) return this.brokers.has(member)
      ? { member, phase: 'blocked', why: 'engine-detached' } : { member, phase: 'starting' };
    if (!this.brokers.has(member)) return { member, phase: 'off', why: 'no-browser' };
    const recovery = this.recovery.get(member);
    if (recovery) return { member, phase: 'recovering', recovery: { ...recovery } };
    if (this.exhausted.has(member)) return { member, phase: 'blocked', why: 'recovery-exhausted' };
    if (this.failed || this.stopped || this.unavailable.has(member)) return { member, phase: 'blocked', why: 'engine-detached' };
    if (this.data.requests.some(r => r.member === member && open(r))) return { member, phase: 'fenced' };
    return this.fixture ? { member, phase: 'ready' } : { member, phase: 'blocked', why: 'handoff-unprotected' };
  }
  signIns(member?: Member): NeedSignIn[] { return structuredClone(this.data.requests.filter(r => !member || r.member === member)); }
  private request(id: string, gen?: number) {
    const r = this.data.requests.find(r => r.id === id);
    if (!r) throw new SignInRefused('not-found');
    if (gen !== undefined && gen !== r.gen) throw new SignInRefused('stale');
    return r;
  }
  private access(grant: string, member: Member, control: boolean) {
    let allowed = false;
    try { allowed = !this.revoked.has(grant) && this.s.authorize(grant, member, control); } catch { /* fail closed */ }
    if (!allowed) throw new SignInRefused(control ? 'not-control' : 'not-found');
  }
  private held(r: NeedSignIn, grant: string) {
    this.access(grant, r.member, true);
    if (r.state === 'held') {
      const l = this.leases.get(r.id);
      if (l?.grant !== grant) throw new SignInRefused('not-lease-holder');
      this.lease(l.value);
    }
    if (['waiting', 'held'].includes(r.state) && this.now() >= r.expires) throw new SignInRefused('lease-expired');
  }
  private lease(ref: LeaseRef): { r: NeedSignIn; l: Lease } {
    if (this.failed || this.stopped) throw new SignInRefused('stale');
    const r = this.request(ref.requestId);
    if (this.unavailable.has(r.member)) throw new SignInRefused('stale');
    const l = this.leases.get(r.id);
    if (!l || l.value.epoch !== ref.epoch || l.value.nonce !== ref.nonce || l.value.gen !== r.gen
      || this.epochs.get(r.member) !== ref.epoch || !['held', 'checking'].includes(r.state)) throw new SignInRefused('stale');
    this.access(l.grant, r.member, true);
    if (r.state !== 'checking' && this.now() >= Math.min(l.value.expires, l.deadline, r.expires)) throw new SignInRefused('lease-expired');
    return { r, l };
  }
  private drop(r: NeedSignIn) {
    const l = this.leases.get(r.id);
    clearTimeout(l?.timer);
    this.brokers.get(r.member)?.bindLease(null);
    this.leases.delete(r.id);
    this.epochs.set(r.member, (this.epochs.get(r.member) ?? 0) + 1);
    for (const s of this.streams) if (s.member === r.member) s.close('superseded');
  }
  private leaseTimer(r: NeedSignIn, l: Lease) {
    clearTimeout(l.timer);
    l.timer = setTimeout(() => { void this.sweep().catch(() => {}); }, Math.max(1, Math.min(l.deadline, l.value.expires) - this.now()));
    l.timer.unref?.();
  }
  async raise(input: RaiseSignIn): Promise<NeedSignIn> {
    if (!this.fixture) throw new HandoffUnprotected();
    return this.serial(() => this.raiseLocked(input));
  }
  private async raiseLocked(input: RaiseSignIn, prev?: string) {
    const broker = this.broker(input.member);
    if (this.data.requests.some(r => r.member === input.member && r.state !== 'settled')) throw new SignInRefused('already-open');
    if (!input.sessionKey) throw new SignInRefused('unsupported');
    const target = input.targetId ?? broker.agentTab();
    if (!target) throw new SignInRefused('unsupported');
    const origin = validOrigin(await broker.originOf(target));
    this.currentBroker(input.member, broker);
    const url = checkUrl(input.checkUrl);
    const site = this.s.siteOf(origin);
    if (!site || /[\s/<>]/.test(site)) throw new SignInRefused('unsupported');
    const r: NeedSignIn = { id: mint(), gen: 1, ...(prev ? { prev } : {}), member: input.member, sessionKey: input.sessionKey,
      origin, site, secure: secureOrigin(origin), firstTime: !(Object.hasOwn(this.data.verified, input.member) && this.data.verified[input.member].includes(site)),
      reasons: [...new Set(input.reasons)], hints: [...new Set(input.hints ?? [])],
      choices: [...(secureOrigin(origin) ? [{ kind: 'takeover' as const }] : []), { kind: 'not-now' }, { kind: 'cancel' }],
      state: 'waiting', at: this.now(), expires: this.now() + (this.s.options.requestTtlMs ?? 1_800_000) };
    this.thumbs.delete(r.member);
    this.data.requests.push(r);
    this.data.host[r.id] = { checkUrl: url, confirmed: [] };
    this.commit();
    this.streams.forEach(s => { if (s.member === r.member) s.close('superseded'); });
    await broker.fence(true);
    await this.s.park(r.member, r.sessionKey);
    this.ping(r);
    return structuredClone(r);
  }
  takeover(id: string, gen: number, by: { grant: string; confirmSite?: string }): Promise<TakeoverLease> {
    if (!this.fixture) return Promise.reject(new HandoffUnprotected());
    if (this.closing.has(id)) return Promise.reject(new SignInRefused('held-by-other'));
    return this.serial(async () => {
      const r = this.request(id, gen);
      this.access(by.grant, r.member, true);
      if (r.state === 'held' || this.closing.has(r.id)) throw new SignInRefused('held-by-other');
      if (r.state !== 'waiting') throw new SignInRefused('stale');
      if (this.now() >= r.expires) throw new SignInRefused('lease-expired');
      if (!r.secure) throw new SignInRefused('insecure-remote');
      if (r.firstTime && by.confirmSite !== r.site) throw new SignInRefused('confirm-site');
      const broker = this.broker(r.member);
      await broker.fence(true);
      const epoch = (this.epochs.get(r.member) ?? 0) + 1;
      this.epochs.set(r.member, epoch);
      const value: TakeoverLease = { requestId: r.id, gen: r.gen, epoch, nonce: mint(), expires: this.now() + (this.s.options.leaseTtlMs ?? 600_000),
        claimMs: this.s.options.claimMs ?? 60_000, graceMs: this.s.options.graceMs ?? 30_000 };
      broker.bindLease({ epoch, nonce: value.nonce, origin: r.origin, knownIdps: this.knownIdps() });
      let target: string;
      try {
        target = await broker.openPrivate(this.data.host[r.id].checkUrl);
        // Revocation during openPrivate cannot grant a new controller.
        this.access(by.grant, r.member, true);
        this.currentBroker(r.member, broker);
      } catch {
        broker.bindLease(null);
        try { await broker.closePrivate(); } catch { this.unavailable.add(r.member); }
        throw new SignInRefused('stale');
      }
      const l: Lease = { value, grant: by.grant, target, attached: false, deadline: this.now() + value.claimMs };
      this.leases.set(r.id, l);
      r.state = 'held'; this.data.host[r.id].confirmed = [];
      this.commit(); this.leaseTimer(r, l); this.ping(r);
      return structuredClone(value);
    });
  }
  confirmOrigin(ref: LeaseRef, origin: string): void {
    const { r } = this.lease(ref);
    if (r.state !== 'held') throw new SignInRefused('stale');
    const exact = validOrigin(origin);
    if (!secureOrigin(exact)) throw new SignInRefused('insecure-remote');
    let confirmed = false;
    try { confirmed = this.broker(r.member).confirmOrigin({ epoch: ref.epoch, nonce: ref.nonce }, exact); } catch { /* fail closed */ }
    if (!confirmed) throw new SignInRefused('stale');
    if (!this.data.host[r.id].confirmed.includes(exact)) this.data.host[r.id].confirmed.push(exact);
    this.commit();
  }
  done(ref: LeaseRef): Promise<NeedSignIn> {
    return this.serial(async () => {
      const { r, l } = this.lease(ref);
      if (r.state !== 'held') throw new SignInRefused('stale');
      const broker = this.broker(r.member);
      r.state = 'checking'; clearTimeout(l.timer);
      for (const s of this.streams) if (s.member === r.member) s.close('superseded');
      this.commit(); this.ping(r);
      const privateState = broker.privateState();
      const origin = privateState ? validOrigin(privateState.origin) : undefined;
      broker.bindLease(null);
      const allowed = !!origin && (origin === r.origin || this.knownIdps().includes(origin) || this.data.host[r.id].confirmed.includes(origin));
      const result = allowed && origin && secureOrigin(origin)
        ? await verifySignIn(broker, r.origin, this.s.options.verifiers ?? [], this.s.options.checkMs ?? 30_000)
        : { state: 'failed' as const, reason: 'origin-mismatch' as const };
      // Revocation/reconnect epochs can change while verification is in flight.
      this.lease(ref);
      await this.settle(r, result.state, 'reason' in result ? result.reason : undefined);
      if (r.settled?.state === 'verified') {
        if (this.stopped || this.failed || this.unavailable.has(r.member)) throw new SignInRefused('unsupported');
        r.settled.resume = newResume(r);
        this.commit(); // action key/session/attempt durable BEFORE calling the gateway
        r.settled.resume.state = await dispatchResume(r, this.s.resume);
        this.commit(); this.ping(r);
      }
      return structuredClone(r);
    });
  }
  private async settle(r: NeedSignIn, state: NonNullable<NeedSignIn['settled']>['state'], reason?: NonNullable<NeedSignIn['settled']>['reason']) {
    if (r.state === 'settled') throw new SignInRefused('stale');
    const broker = this.broker(r.member);
    this.drop(r);
    await this.closePrivate(r); // never lift before held targets (including probes/popups) are destroyed
    r.state = 'settled'; r.settled = { state, ...(reason ? { reason } : {}), at: this.now() };
    if (state === 'verified') {
      const sites = Object.hasOwn(this.data.verified, r.member) ? this.data.verified[r.member] : (this.data.verified[r.member] = []);
      if (!sites.includes(r.site)) sites.push(r.site);
    }
    this.commit();
    await broker.fence(false);
    await broker.navigateAgent(state === 'verified' ? this.data.host[r.id].checkUrl : 'reload');
    this.ping(r);
  }
  cancel(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn> {
    return this.serial(async () => {
      const r = this.request(id, gen); this.held(r, by.grant);
      if (!['waiting', 'held', 'parked'].includes(r.state)) throw new SignInRefused('stale');
      await this.settle(r, 'cancelled'); return structuredClone(r);
    });
  }
  notNow(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn> {
    return this.serial(async () => {
      const r = this.request(id, gen); this.held(r, by.grant);
      if (!['waiting', 'held'].includes(r.state)) throw new SignInRefused('stale');
      this.drop(r); const broker = this.broker(r.member);
      await this.closePrivate(r);
      r.state = 'parked'; this.data.host[r.id].confirmed = []; this.commit();
      await broker.fence(false); await broker.navigateAgent('reload'); this.ping(r);
      return structuredClone(r);
    });
  }
  reopen(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn> {
    if (!this.fixture) return Promise.reject(new HandoffUnprotected());
    return this.serial(async () => {
      const r = this.request(id, gen); this.access(by.grant, r.member, true);
      if (r.state !== 'parked') throw new SignInRefused('stale');
      r.state = 'waiting'; r.gen++; r.expires = this.now() + (this.s.options.requestTtlMs ?? 1_800_000);
      this.commit(); await this.broker(r.member).fence(true); await this.s.park(r.member, r.sessionKey); this.ping(r);
      return structuredClone(r);
    });
  }
  retry(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn> {
    if (!this.fixture) return Promise.reject(new HandoffUnprotected());
    return this.serial(async () => {
      const r = this.request(id, gen); this.access(by.grant, r.member, true);
      if (r.state !== 'settled' || r.settled?.state === 'verified') throw new SignInRefused('stale');
      return this.raiseLocked({ member: r.member, sessionKey: r.sessionKey, checkUrl: this.data.host[r.id].checkUrl,
        reasons: r.reasons, hints: r.hints }, r.id);
    });
  }
  async sweep(): Promise<void> {
    await this.serial(async () => {
      for (const r of this.data.requests) {
        if (['waiting', 'held'].includes(r.state) && this.now() >= r.expires) { await this.settle(r, 'expired'); continue; }
        const l = this.leases.get(r.id);
        if (l && r.state === 'held' && this.now() >= Math.min(l.deadline, l.value.expires)) await this.lapse(r);
      }
    });
  }
  private async closePrivate(r: NeedSignIn): Promise<void> {
    this.closing.add(r.id);
    const broker = this.broker(r.member);
    try { await broker.closePrivate(); }
    catch {
      r.state = 'settled'; r.settled = { state: 'failed', reason: 'browser-gone', at: this.now() };
      this.unavailable.add(r.member); this.commit(); this.ping(r);
      void this.recover(r.member);
      throw new SignInRefused('unsupported');
    }
    this.currentBroker(r.member, broker); this.closing.delete(r.id);
  }
  private async lapse(r: NeedSignIn) {
    this.drop(r); await this.closePrivate(r);
    r.state = 'waiting'; r.gen++; this.data.host[r.id].confirmed = [];
    this.commit(); this.ping(r); // fence stays on
  }
  revokeGrant(grant: string): Promise<void> {
    this.revoked.add(grant);
    const requests = [...this.leases.entries()].filter(([, l]) => l.grant === grant).map(([id]) => this.request(id));
    // Before any await: revoke every capability, detach input and close streams. No grace on revoke.
    for (const r of requests) { this.closing.add(r.id); this.drop(r); }
    for (const s of this.streams) if (s.grant === grant) s.close('revoked');
    return this.serial(async () => {
      for (const r of requests) {
        if (r.state === 'settled') continue;
        try {
          await this.broker(r.member).closePrivate();
          r.state = 'waiting'; r.gen++; this.data.host[r.id].confirmed = [];
          this.commit(); this.closing.delete(r.id); this.ping(r);
        } catch {
          // A possibly-open private target cannot be reused. Fence remains held; no new lease.
          r.state = 'settled'; r.settled = { state: 'failed', reason: 'browser-gone', at: this.now() };
          this.unavailable.add(r.member); this.commit(); this.ping(r);
        }
      }
    }).then(async () => { for (const member of new Set(requests.map(r => r.member))) if (this.unavailable.has(member)) await this.recover(member); });
  }
  browserGone(member: Member, expected = this.brokers.get(member)): Promise<void> {
    // An old endpoint's delayed onExit must not tear down its replacement.
    if (!expected || this.brokers.get(member) !== expected || this.attaching.has(member)) return Promise.resolve();
    this.streams.forEach(s => { if (s.member === member) s.close('browser-gone'); });
    this.epochs.set(member, (this.epochs.get(member) ?? 0) + 1);
    return this.serial(async () => {
      if (this.brokers.get(member) !== expected || this.attaching.has(member)) return;
      for (const r of this.data.requests.filter(r => r.member === member)) {
        this.drop(r); recoverResume(r);
        if (r.state === 'held' || r.state === 'checking') { r.state = 'settled'; r.settled = { state: 'failed', reason: 'browser-gone', at: this.now() }; }
        else if (r.state === 'waiting' || r.state === 'parked') r.gen++;
      }
      this.unavailable.add(member); this.commit(); this.s.ping?.(member, 'state');
    }).then(() => this.recover(member));
  }
  private async recover(member: Member): Promise<void> {
    if (this.stopped || this.failed || this.recovery.has(member) || this.attaching.has(member)) return;
    const old = this.brokers.get(member);
    const epoch = this.epochs.get(member) ?? 0;
    const current = () => !this.stopped && !this.failed && !this.attaching.has(member)
      && this.brokers.get(member) === old && (this.epochs.get(member) ?? 0) === epoch;
    const attempts = this.s.restart ? this.s.options.recovery?.attempts ?? 3 : 0;
    // Close the old kit-owned endpoint before replacing its map entry; otherwise its server is orphaned.
    try { await old?.close(); }
    catch { if (current()) { this.exhausted.add(member); this.s.ping?.(member, 'state'); } return; }
    if (!current()) return;
    for (let attempt = 1; attempt <= attempts && current(); attempt++) {
      const delay = this.s.options.recovery?.backoffMs[attempt - 1] ?? [1_000, 5_000, 15_000][attempt - 1];
      this.recovery.set(member, { attempt, of: attempts, nextAt: this.now() + delay }); this.s.ping?.(member, 'state');
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (!current()) return;
      try {
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const launch = this.s.restart!(member, attempt).then(async broker => {
          if (expired || !current()) { try { await broker?.close(); } catch { /* owned stale candidate only */ } return undefined; }
          return broker;
        });
        let broker: HostBroker | undefined;
        try {
          broker = await Promise.race([launch, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 30_000); })]);
        } finally { expired = true; clearTimeout(timer); }
        if (!broker) continue;
        if (!current()) { await broker.close(); return; }
        // Waiting requests remain fenced before the replacement can be used. Never redispatch a resume.
        if (this.data.requests.some(r => r.member === member && open(r))) await broker.fence(true);
        if (!current()) { await broker.close(); return; }
        this.brokers.set(member, broker); this.unavailable.delete(member); this.recovery.delete(member);
        this.s.ping?.(member, 'state'); return;
      } catch { /* bounded retries; details may contain endpoint credentials, never surface them */ }
    }
    if (current()) { this.recovery.delete(member); this.exhausted.add(member); this.s.ping?.(member, 'state'); }
  }
  beforeRun(member: Member, sessionKey: string): Promise<boolean> {
    return this.serial(async () => {
      const r = this.data.requests.find(r => r.member === member && r.sessionKey === sessionKey && r.state !== 'settled');
      if (!r) return true;
      if (r.state !== 'parked') return false;
      await this.settle(r, 'cancelled', 'run-replaced'); return true;
    });
  }
  thumbnail(source: LiveSource, by: { grant: string }): Promise<ThumbnailResult> {
    this.access(by.grant, source.member, false);
    if (source.kind !== 'browser') return Promise.resolve({ state: 'unsupported' });
    if (this.data.requests.some(r => r.member === source.member && open(r))) return Promise.resolve({ state: 'private' });
    if (!this.brokers.has(source.member) || this.unavailable.has(source.member) || this.stopped || this.failed) return Promise.resolve({ state: 'off' });
    const cached = this.thumbs.get(source.member);
    if (cached && this.now() - cached.at < 5_000) return Promise.resolve({ state: 'ok', frame: structuredClone(cached.frame) });
    return this.captureThumbnail(source.member);
  }
  private async captureThumbnail(member: Member): Promise<ThumbnailResult> {
    const broker = this.broker(member);
    const viewer = broker.attachViewer({});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([viewer.frames[Symbol.asyncIterator]().next(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2_000); })]);
      // Privacy and endpoint identity are rechecked after awaiting a frame.
      this.currentBroker(member, broker);
      if (this.data.requests.some(r => r.member === member && open(r))) return { state: 'private' };
      if (!result || result.done || result.value.w > 320) return { state: 'unsupported' };
      const frame = structuredClone(result.value);
      this.thumbs.set(member, { at: this.now(), frame });
      return { state: 'ok', frame: structuredClone(frame) };
    } catch { return { state: 'off' }; }
    finally { clearTimeout(timer); viewer.close(); }
  }
  live(source: LiveSource, o: { grant: string; lease?: TakeoverLease; maxWidth?: number }, on: { state(s: LiveViewState): void; frame(f: LiveFrame): void }) {
    this.access(o.grant, source.member, !!o.lease);
    const mode = o.lease ? 'control' as const : 'observe' as const;
    let closed = false;
    let viewer: ReturnType<HostBroker['attachViewer']> | undefined;
    let l: Lease | undefined;
    let r: NeedSignIn | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const emit = (s: Partial<LiveViewState> & Pick<LiveViewState, 'phase'>) => on.state({ source, mode, ...s });
    const stream: Stream = { member: source.member, grant: o.grant, control: !!o.lease, close: why => {
      if (closed) return; closed = true; clearInterval(heartbeat); viewer?.close(); this.streams.delete(stream);
      if (!this.stopped && !this.failed && l && r && this.leases.get(r.id) === l && r.state === 'held') {
        l.attached = false; l.deadline = this.now() + l.value.graceMs; this.leaseTimer(r, l);
      }
      emit({ phase: 'ended', ...(why ? { why } : {}) });
    } };
    const inert = { input: (_i: LiveInput) => { throw new SignInRefused('not-control'); }, close: () => stream.close() };
    if (source.kind !== 'browser') { emit({ phase: 'failed', why: 'unsupported' }); return inert; }
    if (this.stopped || this.failed || this.unavailable.has(source.member)) { emit({ phase: 'failed', why: 'browser-gone' }); return inert; }
    if (o.lease) {
      const bound = this.lease(o.lease); r = bound.r; l = bound.l;
      if (r.member !== source.member || l.grant !== o.grant) throw new SignInRefused('not-lease-holder');
      if (r.state !== 'held' || l.attached) throw new SignInRefused('held-by-other');
      l.attached = true; l.deadline = l.value.expires; this.leaseTimer(r, l);
    } else if (this.data.requests.some(r => r.member === source.member && open(r))) { emit({ phase: 'private' }); return inert; }
    const broker = this.broker(source.member);
    viewer = broker.attachViewer({ ...(l ? { lease: { epoch: l.value.epoch, nonce: l.value.nonce } } : {}) });
    this.streams.add(stream); emit({ phase: 'connecting' });
    if (l && r) heartbeat = setInterval(() => {
      try {
        this.lease(l!.value);
        if (r!.state !== 'held') { stream.close('superseded'); return; }
        l!.value.expires = this.now() + (this.s.options.leaseTtlMs ?? 600_000);
        l!.deadline = l!.value.expires; this.leaseTimer(r!, l!);
      } catch { stream.close('expired'); }
    }, Math.max(1, Math.min(30_000, (this.s.options.leaseTtlMs ?? 600_000) / 3)));
    heartbeat?.unref?.();
    // Origins and the atomic input pause come from the broker, not frame contents or device input.
    if (l && r) void (async () => {
      try {
        for await (const state of viewer!.states) {
          if (closed) break;
          this.lease(l!.value);
          emit({ phase: 'live', ...state, leaseExpires: l!.value.expires });
        }
      } catch { stream.close('browser-gone'); }
    })();
    void (async () => {
      try {
        for await (const frame of viewer!.frames) {
          if (closed) break;
          if (l && r) {
            this.lease(l.value);
            const state = broker.privateState();
            if (!state) throw new SignInRefused('stale');
            l.value.expires = this.now() + (this.s.options.leaseTtlMs ?? 600_000);
            l.deadline = l.value.expires; this.leaseTimer(r, l);
            emit({ phase: 'live', ...state, leaseExpires: l.value.expires });
          } else {
            if (this.data.requests.some(r => r.member === source.member && open(r))) { stream.close('superseded'); break; }
            emit({ phase: 'live' });
          }
          if (!closed) on.frame(frame);
        }
        stream.close();
      } catch { stream.close('browser-gone'); }
    })();
    return { input: (i: LiveInput) => {
      if (closed) throw new SignInRefused('stale');
      if (!l || !r) throw new SignInRefused('not-control');
      this.lease(l.value);
      if (r.state !== 'held') throw new SignInRefused('stale');
      viewer!.input(i); // Broker enforces exact bound origin, target, epoch and nonce at injection.
    }, close: () => stream.close() };
  }
  forget(member: Member, site: string | 'all', by: { grant: string }): Promise<void> {
    return this.serial(async () => {
      this.access(by.grant, member, true);
      if (this.data.requests.some(r => r.member === member && r.state !== 'settled')) throw new SignInRefused('already-open');
      if (site === 'all') throw new SignInRefused('unsupported');
      const requests = this.data.requests.filter(r => r.member === member && r.site === site);
      const origins = [...new Set(requests.flatMap(r => [r.origin, ...this.data.host[r.id].confirmed]))];
      if (!origins.length) throw new SignInRefused('unsupported');
      await this.broker(member).clearSite(origins);
      this.data.verified[member] = (Object.hasOwn(this.data.verified, member) ? this.data.verified[member] : []).filter(s => s !== site);
      this.commit(); this.s.ping?.(member, 'state');
    });
  }
  private knownIdps(): string[] {
    return this.s.options.knownIdps ?? ['https://accounts.google.com', 'https://login.microsoftonline.com', 'https://login.live.com', 'https://appleid.apple.com', 'https://github.com'];
  }
  async close(): Promise<void> {
    // Invalidate synchronously before waiting on outstanding operations.
    this.stopped = true; clearTimeout(this.ttl);
    for (const l of this.leases.values()) clearTimeout(l.timer);
    this.streams.forEach(s => s.close('browser-gone'));
    this.epochs.forEach((n, member) => this.epochs.set(member, n + 1));
    await this.queue;
    for (const broker of this.brokers.values()) await broker.close();
  }
}
