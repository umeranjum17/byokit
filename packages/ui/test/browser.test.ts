// The browser sign-in sheet and live panel: every request state to its sentence, buttons and chip, the kit's own
// types fitting these structurally, and the live store refreshing on sign-in pings only, across a dropped stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveViewState, NeedSignIn } from '../../openclaw/src/browser.ts';
import {
  livePanelView, signInSheetView, signInsStore, type BrowserFrame, type LiveState, type SignInRequest,
} from '../src/kits.ts';

const req = (o: Partial<SignInRequest> = {}): SignInRequest => ({
  id: 'r1', gen: 1, member: 'me', origin: 'https://example.com', site: 'example.com', secure: true, firstTime: false,
  hints: ['password', 'google'], choices: [{ kind: 'takeover' }, { kind: 'not-now' }, { kind: 'cancel' }],
  state: 'waiting', expires: 10_000, ...o,
});
const settled = (state: NonNullable<SignInRequest['settled']>['state'], more: Partial<NonNullable<SignInRequest['settled']>> = {}) =>
  signInSheetView(req({ state: 'settled', settled: { state, ...more } }), { name: 'Sam' });

test('the kit\'s own request and live state fit these views', () => {
  const kit = {} as NeedSignIn;
  const asRequest: SignInRequest = kit;
  const live = {} as LiveViewState;
  const asLive: LiveState = live;
  assert.ok(asRequest && asLive);
});

test('waiting offers takeover and not now, asks for the site the first time, and quotes the helper', () => {
  const v = signInSheetView(req({ firstTime: true, agentNote: 'I need the billing page' }), { name: 'Sam' });
  assert.deepEqual(v.actions, ['takeover', 'notNow']);
  assert.deepEqual(v.line, { key: 'signin.waiting', vars: { site: 'example.com', name: 'Sam', origin: 'https://example.com' } });
  assert.equal(v.confirmSite, true);
  assert.equal(v.note, 'I need the billing page');
  assert.equal(v.needsYou, true);
  assert.equal(v.chip, undefined);
  const plain = signInSheetView(req({ secure: false, choices: [{ kind: 'not-now' }] }), { name: 'Sam' });
  assert.deepEqual(plain.actions, ['notNow'], 'no takeover on an insecure remote site');
  assert.equal(plain.line.key, 'signin.insecureRemote');
});

test('while held, only the lease holder gets buttons; everyone else sees private', () => {
  assert.deepEqual(signInSheetView(req({ state: 'held' }), { name: 'Sam', holder: true }).actions, ['done', 'notNow', 'cancel']);
  const other = signInSheetView(req({ state: 'held' }), { name: 'Sam' });
  assert.deepEqual(other.actions, []);
  assert.equal(other.line.key, 'signin.private');
  assert.equal(other.confirmSite, false);
});

test('checking shows the entered chip, never verified; parked offers reopen', () => {
  const c = signInSheetView(req({ state: 'checking' }), { name: 'Sam' });
  assert.deepEqual([c.line.key, c.chip, c.actions.length, c.needsYou], ['signin.checking', 'entered', 0, true]);
  const p = signInSheetView(req({ state: 'parked' }), { name: 'Sam' });
  assert.deepEqual([p.line.key, p.actions, p.needsYou], ['signin.parked', ['reopen'], true]);
});

test('only a verified sign-in the helper went on from stops needing the person', () => {
  const v = settled('verified', { resume: { state: 'accepted' } });
  assert.deepEqual([v.line.key, v.chip, v.actions, v.needsYou], ['signin.verified', 'verified', [], false]);
  assert.deepEqual([settled('verified', { resume: { state: 'failed' } }).line.key, settled('verified', { resume: { state: 'failed' } }).needsYou],
    ['signin.resumeFailed', true]);
  const unknown = settled('verified', { resume: { state: 'indeterminate' } });
  assert.deepEqual([unknown.line.key, unknown.needsYou, unknown.actions], ['signin.resumeUnknown', true, []], 'never offers a blind retry');
  const cases: [ReturnType<typeof settled>, string, 'entered' | undefined][] = [
    [settled('entered-unverified', { reason: 'no-verifier' }), 'signin.noVerifier', 'entered'],
    [settled('entered-unverified', { reason: 'check-timeout' }), 'signin.noVerifier', 'entered'],
    [settled('entered-unverified', { reason: 'still-signed-out' }), 'signin.stillSignedOut', 'entered'],
    [settled('cancelled'), 'signin.cancelled', undefined],
    [settled('cancelled', { reason: 'run-replaced' }), 'signin.runReplaced', undefined],
    [settled('cancelled', { reason: 'superseded' }), 'signin.superseded', undefined],
    [settled('expired'), 'signin.expired', undefined],
    [settled('failed', { reason: 'origin-mismatch' }), 'signin.originMismatch', undefined],
    [settled('failed', { reason: 'browser-gone' }), 'signin.browserGone', undefined],
  ];
  for (const [v, key, chip] of cases) {
    assert.deepEqual([v.line.key, v.chip, v.actions, v.needsYou], [key, chip, ['retry'], true], key);
  }
});

test('the live panel draws frames only when live, takes input only in control, and pauses off the expected address', () => {
  assert.deepEqual(livePanelView({ phase: 'live', mode: 'observe' }), { showFrames: true, input: false });
  assert.deepEqual(livePanelView({ phase: 'live', mode: 'control' }), { showFrames: true, input: true });
  assert.deepEqual(livePanelView({ phase: 'live', mode: 'control', offOrigin: true, origin: 'https://login.example.net' }),
    { showFrames: true, input: false, line: { key: 'signin.offOrigin' }, confirmOrigin: 'https://login.example.net' });
  for (const phase of ['connecting', 'reconnecting'] as const) {
    assert.deepEqual(livePanelView({ phase, mode: 'control' }), { showFrames: false, input: false, line: { key: 'live.reconnecting' } });
  }
  assert.deepEqual(livePanelView({ phase: 'private', mode: 'observe' }), { showFrames: false, input: false, line: { key: 'signin.private' } });
  assert.deepEqual(livePanelView({ phase: 'ended', mode: 'observe' }), { showFrames: false, input: false });
});

test('the store lists once the stream is open, lists again on sign-in pings only, and reopens after a drop', async () => {
  let listing = [req()];
  let lists = 0;
  const streams: { push(f: BrowserFrame): void; end(): void }[] = [];
  const source = {
    async signIns() { lists++; return listing; },
    events(): AsyncIterable<BrowserFrame> {
      const queue: BrowserFrame[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      streams.push({ push: (f) => { queue.push(f); wake?.(); }, end: () => { done = true; wake?.(); } });
      return {
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<BrowserFrame>> {
            while (!queue.length && !done) await new Promise<void>((r) => { wake = r; });
            return queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true };
          },
          async return() { done = true; return { value: undefined, done: true }; },
        }),
      };
    },
  };
  const s = signInsStore(source, { retryMs: 10 });
  const seen: SignInRequest[][] = [];
  const stop = s.subscribe((v) => seen.push(v));
  const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(ok()); };
  await until(() => s.get().length === 1 && streams.length === 1);
  streams[0]!.push({ event: 'byokit.browser', payload: { member: 'me', kind: 'state' } });
  streams[0]!.push({ event: 'agent', payload: {} });
  listing = [req({ state: 'held' })];
  streams[0]!.push({ event: 'byokit.browser', payload: { member: 'me', kind: 'signin' } });
  await until(() => s.get()[0]?.state === 'held');
  assert.equal(lists, 2, 'state pings and other events do not list again');
  listing = [req({ state: 'parked' })];
  streams[0]!.end();
  await until(() => s.get()[0]?.state === 'parked' && streams.length === 2);
  stop();
  assert.ok(seen.length >= 3);
});
