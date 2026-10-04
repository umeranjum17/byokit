// Offline, synthetic browser fixture. Does not launch Chromium, use a profile or qualify production handoff.
import type { BrowserHost, BrowserOptions, LiveFrame, LiveInput, NeedSignIn, SiteVerifier } from '../browser.ts';
import { fixtureBrowserHost, secureOrigin, type BrowserHostController, type HostBroker } from '../browser/host.ts';
import { emptySignIns, validateSignIns, type SignInStore } from '../browser/store.ts';
import type { Probe } from '../browser/verify.ts';

function channel<T>() {
  let pending: ((value: IteratorResult<T>) => void) | undefined;
  let value: T | undefined;
  let ended = false;
  return {
    push(next: T) { if (ended) return; if (pending) { const resolve = pending; pending = undefined; resolve({ done: false, value: next }); } else value = next; },
    close() { ended = true; value = undefined; pending?.({ done: true, value: undefined }); pending = undefined; },
    iterable: { [Symbol.asyncIterator]() { return {
      next(): Promise<IteratorResult<T>> {
        if (value !== undefined) { const next = value; value = undefined; return Promise.resolve({ done: false, value: next }); }
        if (ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => { pending = resolve; });
      },
      return(): Promise<IteratorResult<T>> { ended = true; pending?.({ done: true, value: undefined }); return Promise.resolve({ done: true, value: undefined }); },
    }; } },
  };
}
export function memorySignInStore(): SignInStore {
  let data = emptySignIns();
  return { read: () => structuredClone(data), write: next => { data = validateSignIns(next); } };
}
type Private = { origin: string; secure: boolean; offOrigin: boolean };
type Viewer = { frames: ReturnType<typeof channel<LiveFrame>>; states: ReturnType<typeof channel<Private>>; lease?: { epoch: number; nonce: string }; close(): void };
export type BrowserFixture = {
  /** Set the synthetic address bar; no network call. */
  navigate(member: string, origin: string): void;
  authenticated(member: string, value: boolean): void;
  frame(member: string, frame?: LiveFrame): void;
  dropStreams(member: string): void;
  advance(ms: number): Promise<void>;
  resumeOutcome(value: 'accepted' | 'refused' | 'unknown' | 'throw'): void;
  closePrivate(member: string, fn: (() => Promise<void>) | undefined): void;
  probe(member: string, fn: ((p: Probe) => Promise<'ok' | 'fail' | 'timeout'>) | undefined): void;
  readonly dispatches: { member: string; sessionKey: string; idempotencyKey: string; message: string }[];
  readonly parked: { member: string; sessionKey: string }[];
  readonly calls: string[];
  broker(member: string): HostBroker;
  inputCount(member: string): number;
  privateOpen(member: string): boolean;
  fenced(member: string): boolean;
};
export type FakeBrowserHost = BrowserHostController & { readonly fixture: BrowserFixture };
export type FakeBrowserHostOptions = {
  members?: string[]; options?: Partial<BrowserOptions>; store?: SignInStore;
  authorize?: (grant: string, member: string, control: boolean) => boolean;
  ping?: (member: string, kind: 'state' | 'signin') => void;
};

export async function fakeBrowserHost(o: FakeBrowserHostOptions = {}): Promise<FakeBrowserHost> {
  const members = o.members ?? ['ada'];
  const states = new Map(members.map(member => [member, { origin: 'http://127.0.0.1:2820', privateOrigin: undefined as string | undefined,
    fenced: false, signedIn: false, binding: undefined as Parameters<HostBroker['bindLease']>[0] | undefined,
    confirmed: new Set<string>(), viewers: new Set<Viewer>(), inputs: 0,
    closer: undefined as (() => Promise<void>) | undefined, prober: undefined as ((p: Probe) => Promise<'ok' | 'fail' | 'timeout'>) | undefined }]));
  const get = (member: string) => { const s = states.get(member); if (!s) throw new Error('unknown fixture member'); return s; };
  const privateState = (member: string): Private | undefined => {
    const s = get(member);
    return s.privateOrigin ? { origin: s.privateOrigin, secure: secureOrigin(s.privateOrigin), offOrigin: !s.binding
      || !(s.privateOrigin === s.binding.origin || s.binding.knownIdps.includes(s.privateOrigin) || s.confirmed.has(s.privateOrigin)) } : undefined;
  };
  const calls: string[] = [];
  const dispatches: BrowserFixture['dispatches'] = [];
  const parked: BrowserFixture['parked'] = [];
  let now = Date.now();
  let outcome: 'accepted' | 'refused' | 'unknown' | 'throw' = 'accepted';
  let seq = 0;
  const frame = (): LiveFrame => ({ seq: ++seq, at: now, w: 1, h: 1, jpeg: Uint8Array.of(255, 216, 255, 217) });
  const brokers = new Map<string, HostBroker>(members.map(member => {
    const s = get(member);
    return [member, {
      endpoint: () => ({ cdpUrl: 'ws://127.0.0.1:2820/devtools/browser?token=synthetic' }),
      async fence(on) { calls.push(`${member}:fence:${on}`); s.fenced = on; },
      agentTab: () => 'agent',
      async originOf(target) { return target === 'private' ? s.privateOrigin ?? s.origin : s.origin; },
      async openPrivate(url) { calls.push(`${member}:open`); s.privateOrigin = new URL(url).origin; return 'private'; },
      async closePrivate() { calls.push(`${member}:close`); await s.closer?.(); s.privateOrigin = undefined; },
      async probe(url, verify) {
        calls.push(`${member}:probe`);
        const p: Probe = { url, status: s.signedIn ? 200 : 401, exists: async () => s.signedIn };
        return s.prober ? s.prober(p) : await verify(p) ? 'ok' : 'fail';
      },
      attachViewer({ lease }) {
        const frames = channel<LiveFrame>(); const liveStates = channel<Private>();
        const v: Viewer = { frames, states: liveStates, lease, close: () => { frames.close(); liveStates.close(); s.viewers.delete(v); } };
        s.viewers.add(v); frames.push(frame());
        const state = privateState(member); if (lease && state) liveStates.push(state);
        return { frames: frames.iterable, states: liveStates.iterable,
          input(_i: LiveInput) {
            // Do not retain, log, event or echo input values, even in this fixture.
            const state = privateState(member);
            if (lease && s.binding?.epoch === lease.epoch && s.binding.nonce === lease.nonce && state?.secure && !state.offOrigin) s.inputs++;
          }, close: v.close };
      },
      async navigateAgent(url) { calls.push(`${member}:navigate`); if (url !== 'reload') s.origin = new URL(url).origin; },
      async close() { s.viewers.forEach(v => v.close()); s.privateOrigin = undefined; },
      bindLease(l) { calls.push(`${member}:bind:${l ? 'on' : 'off'}`); s.binding = l; s.confirmed.clear(); },
      confirmOrigin(l, origin) {
        if (s.binding?.epoch !== l.epoch || s.binding.nonce !== l.nonce || s.privateOrigin !== origin) return false;
        s.confirmed.add(origin); const state = privateState(member); if (state) s.viewers.forEach(v => v.states.push(state)); return true;
      },
      privateState: () => privateState(member),
      async clearSite(origins) { if (s.fenced) throw new Error('fixture fenced'); calls.push(`${member}:clear:${origins.length}`); s.signedIn = false; },
    }];
  }));
  const defaultVerifier: SiteVerifier = { origin: 'http://127.0.0.1:2820', url: 'http://127.0.0.1:2820/account', status: 200, selector: '#signed-in' };
  const host = await fixtureBrowserHost({ brokers, store: o.store ?? memorySignInStore(),
    options: { executablePath: '/synthetic/chromium', members, verifiers: [defaultVerifier], ...o.options },
    authorize: o.authorize ?? ((grant, member, control) => members.includes(member) && (grant === 'control' || grant === 'other' || (!control && grant === 'view'))),
    ping: o.ping,
    park: async (member, sessionKey) => { parked.push({ member, sessionKey }); },
    resume: async input => { dispatches.push(input); if (outcome === 'throw') throw new Error('synthetic transport drop'); return outcome; },
    siteOf: origin => new URL(origin).hostname,
    now: () => now,
  });
  const fixture: BrowserFixture = {
    navigate(member, origin) {
      const s = get(member); const exact = new URL(origin).origin;
      if (s.privateOrigin) s.privateOrigin = exact; else s.origin = exact;
      const state = privateState(member); if (state) s.viewers.forEach(v => v.states.push(state));
    },
    authenticated(member, value) { get(member).signedIn = value; },
    frame(member, value) { get(member).viewers.forEach(v => v.frames.push(value ?? frame())); },
    dropStreams(member) { get(member).viewers.forEach(v => v.close()); },
    async advance(ms) { now += ms; await host.sweep(); },
    resumeOutcome(value) { outcome = value; },
    closePrivate(member, fn) { get(member).closer = fn; },
    probe(member, fn) { get(member).prober = fn; },
    dispatches, parked, calls,
    broker: member => { const broker = brokers.get(member); if (!broker) throw new Error('unknown fixture member'); return broker; },
    inputCount: member => get(member).inputs,
    privateOpen: member => !!get(member).privateOrigin,
    fenced: member => get(member).fenced,
  };
  return Object.assign(host, { fixture });
}
export const createBrowserHostFake = fakeBrowserHost;

/** Reusable public-host contract, fixture controls kept outside BrowserHost. Runs against any host adapter. */
export async function browserHostContract(f: { host: BrowserHost; raise(): Promise<NeedSignIn>; signedIn(): void; dispatches(): number }): Promise<void> {
  const require = (value: boolean) => { if (!value) throw new Error('browser host contract failed'); };
  const r = await f.raise();
  require(r.state === 'waiting');
  require((await f.host.thumbnail({ kind: 'browser', member: r.member }, { grant: 'view' })).state === 'private');
  const lease = await f.host.takeover(r.id, r.gen, { grant: 'control', confirmSite: r.site });
  f.signedIn();
  const settled = await f.host.done(lease);
  require(settled.state === 'settled' && settled.settled?.state === 'verified' && !!settled.settled.resume?.key);
  require(f.dispatches() === 1);
  try { await f.host.done(lease); } catch { return; }
  throw new Error('browser host contract failed');
}
