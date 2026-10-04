// useShareIntent's race and mapping acceptance (docs/capability-kits.md 14, H1-H22), offline: a fake ByokitShare
// whose reads the test resolves in any order, a fake AppState, upstream's real parseShareIntent (fixtures), and a
// small synchronous React stand-in that can replay StrictMode's mount, cleanup, mount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUseShareIntent, type ShareHookDeps } from '../src/hook.ts';
import { createAndroidShareModule, guardIosShareModule } from '../src/adapter.ts';
import { ShareError } from '../src/words.ts';
import { WORDS } from '../src/words.ts';
import { parseShareIntent } from './fixtures/esi-utils.js';
import type { NativeShare, NativeShareRead, ShareIntentModuleLike, ShareIntentOptions, ShareIntentState } from '../src/types.ts';

// --- a synchronous React stand-in: effects run right after render, setState re-renders at once ---
type Effect = { fn: () => void | (() => void); deps: unknown[] | undefined; prev: unknown[] | undefined; cleanup: unknown };
function stubReact(strict = false) {
  type Ctx = { fn: () => unknown; result: unknown; states: unknown[]; refs: { current: unknown }[]; effects: Effect[]; si: number; ri: number; ei: number; live: boolean };
  let ctx: Ctx | undefined;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const flush = (c: Ctx) => {
    for (const e of c.effects) {
      if (e.prev !== undefined && same(e.prev, e.deps)) continue;
      const first = e.prev === undefined;
      e.prev = e.deps;
      if (typeof e.cleanup === 'function') e.cleanup();
      e.cleanup = e.fn();
      if (strict && first) { if (typeof e.cleanup === 'function') e.cleanup(); e.cleanup = e.fn(); }
    }
  };
  const render = (c: Ctx) => { if (!c.live) return; const outer = ctx; ctx = c; c.si = c.ri = c.ei = 0; c.result = c.fn(); ctx = outer; flush(c); };
  const react = {
    useState<S>(init: S): [S, (v: S | ((p: S) => S)) => void] {
      const c = ctx!, i = c.si++;
      if (i >= c.states.length) c.states.push(init);
      return [c.states[i] as S, (v) => { c.states[i] = typeof v === 'function' ? (v as (p: S) => S)(c.states[i] as S) : v; render(c); }];
    },
    useRef<T>(init: T): { current: T } {
      const c = ctx!, i = c.ri++;
      if (i >= c.refs.length) c.refs.push({ current: init });
      return c.refs[i] as { current: T };
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const c = ctx!, i = c.ei++;
      if (i >= c.effects.length) c.effects.push({ fn, deps, prev: undefined, cleanup: undefined });
      else Object.assign(c.effects[i], { fn, deps });
    },
  };
  const mount = <T>(fn: () => T) => {
    const c: Ctx = { fn, result: undefined, states: [], refs: [], effects: [], si: 0, ri: 0, ei: 0, live: true };
    render(c);
    return {
      result: () => c.result as T,
      unmount: () => { c.live = false; for (const e of c.effects) if (typeof e.cleanup === 'function') e.cleanup(); },
    };
  };
  return { react: react as unknown as ShareHookDeps['react'], mount };
}

// --- fakes ---
type Deferred = { resolve(r: NativeShareRead): void; reject(e: unknown): void };
function fakeNative() {
  const log: string[] = [];
  const reads: Deferred[] = [];
  let onShare: (() => void) | null = null;
  const native: NativeShare = {
    read: () => { log.push('read'); return new Promise((resolve, reject) => reads.push({ resolve, reject })); },
    clear: (seq) => { log.push(`clear(${seq})`); },
    hasPending: () => false,
    addListener: (event, f) => { log.push(`addListener(${event})`); onShare = f; return { remove: () => { onShare = null; } }; },
  };
  return { native, log, reads, emitShare: () => onShare?.() };
}
function fakeAppState() {
  const subs = new Set<(s: string) => void>();
  return {
    currentState: 'active',
    addEventListener: (_: 'change', f: (s: string) => void) => { subs.add(f); return { remove: () => { subs.delete(f); } }; },
    emit: (s: string) => { for (const f of [...subs]) f(s); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const text = (seq: number, t: string): NativeShareRead => ({ kind: 'shared', seq, text: t, title: null, files: [], skipReasons: [] });
const A = text(1, 'hello A'), B = text(2, 'hello B');
const NONE: NativeShareRead = { kind: 'none', seq: 0 };

function android(options?: ShareIntentOptions, strict = false) {
  const n = fakeNative(), app = fakeAppState(), r = stubReact(strict);
  const parsed: ShareIntentOptions[] = [];
  const use = createUseShareIntent({
    module: null, native: n.native,
    parse: (v, o) => { parsed.push(o); return parseShareIntent(v, o); },
    getScheme: () => 'app', getShareExtensionKey: () => 'appShareKey',
    react: r.react, appState: app, os: 'android',
  });
  const mount = () => r.mount(() => use(options));
  return { ...n, app, parsed, mount, h: mount() };
}
const shown = (s: ShareIntentState) => s.shareIntent.text;
async function applied1(t: ReturnType<typeof android>) { t.reads[0].resolve(A); await tick(); assert.equal(shown(t.h.result()), 'hello A'); }

test('H1 subscribes to new shares before the first read', () => {
  const t = android();
  assert.deepEqual(t.log.slice(0, 2), ['addListener(onShare)', 'read']);
  assert.equal(t.h.result().isReady, true);
});

test('H2 mount, active and a new share all read: the share applies exactly once', async () => {
  const t = android();
  t.app.emit('active'); t.emitShare();
  t.reads[1].resolve(NONE); t.reads[2].resolve(A); t.reads[0].resolve(A); await tick();
  assert.equal(shown(t.h.result()), 'hello A');
  assert.equal(t.parsed.length, 1);
});

test('H3 an older read resolving last never replaces a newer share', async () => {
  const t = android();
  t.emitShare();
  t.reads[1].resolve(B); await tick(); t.reads[0].resolve(A); await tick();
  assert.equal(shown(t.h.result()), 'hello B');
});

test('H4 a background reset clears the applied seq only, and a new share still lands', async () => {
  const t = android();
  await applied1(t);
  t.app.emit('background');
  t.emitShare(); t.reads[1].resolve(B); await tick();
  assert.deepEqual(t.log.filter((l) => l.startsWith('clear')), ['clear(1)']);
  assert.equal(shown(t.h.result()), 'hello B');
});

test('H5 a reset beats a stale read of the same seq', async () => {
  const t = android();
  await applied1(t);
  t.emitShare(); t.h.result().resetShareIntent(); t.reads[1].resolve(A); await tick();
  assert.equal(t.h.result().hasShareIntent, false);
  assert.ok(t.log.includes('clear(1)'));
});

test('H6 a newer share read across a reset is delivered', async () => {
  const t = android();
  await applied1(t);
  t.emitShare(); t.h.result().resetShareIntent(); t.reads[1].resolve(B); await tick();
  assert.equal(shown(t.h.result()), 'hello B');
});

test('H7 a stale rejection never hides a newer share; a rejection on its own is `failed`', async () => {
  const t = android();
  t.emitShare(); t.reads[1].resolve(B); await tick(); t.reads[0].reject(new Error('x')); await tick();
  assert.equal(shown(t.h.result()), 'hello B');
  assert.equal(t.h.result().errorCode, null);
  const u = android();
  u.reads[0].reject(new Error('x')); await tick();
  assert.equal(u.h.result().errorCode, 'failed');
  assert.equal(u.h.result().error, WORDS['share.failed']);
});

test('H8 nothing applies after unmount; a remount reads the share again', async () => {
  const t = android();
  t.h.unmount(); t.reads[0].resolve(A); await tick();
  assert.equal(t.parsed.length, 0);
  const h = t.mount(); t.reads[1].resolve(A); await tick();
  assert.equal(shown(h.result()), 'hello A');
});

test('H9 a `none` read never clears what is shown', async () => {
  const t = android();
  await applied1(t);
  t.app.emit('active'); t.reads[1].resolve(NONE); await tick();
  assert.equal(shown(t.h.result()), 'hello A');
});

test('H10 disabled: no read, no subscription, and reset does nothing', () => {
  let resets = 0;
  const t = android({ disabled: true, onResetShareIntent: () => { resets++; } });
  t.h.result().resetShareIntent();
  assert.deepEqual(t.log, []);
  assert.equal(resets, 0);
  assert.equal(t.h.result().isReady, false);
  const i = iosHook('myapp://dataUrl=myappShareKey#text', { disabled: true });
  i.h.result().resetShareIntent();
  assert.deepEqual([i.calls, i.clears], [[], []], 'a disabled reset never reaches the module');
});

test('H11 resetOnBackground: false keeps the share through background', async () => {
  const t = android({ resetOnBackground: false });
  await applied1(t);
  t.app.emit('background');
  assert.ok(!t.log.some((l) => l.startsWith('clear')));
  assert.equal(shown(t.h.result()), 'hello A');
});

test('H12 active then inactive resets with the applied seq, as upstream', async () => {
  const t = android();
  await applied1(t);
  t.app.emit('active'); t.reads[1].resolve(NONE); await tick();
  t.app.emit('inactive');
  assert.ok(t.log.includes('clear(1)'));
  assert.equal(t.h.result().hasShareIntent, false);
});

function iosHook(url: string | null, options?: ShareIntentOptions) {
  const calls: string[] = [], clears: string[] = [], r = stubReact(), app = fakeAppState(), link = { url };
  const module = {
    getShareIntent: async (u: string) => { calls.push(u); }, clearShareIntent: async (k: string) => { clears.push(k); },
    addListener: () => ({ remove() {} }),
  } as unknown as ShareIntentModuleLike;
  const use = createUseShareIntent({
    module, useLinkingURL: () => link.url, parse: parseShareIntent, getScheme: () => 'myapp', getShareExtensionKey: () => 'myappShareKey',
    react: r.react, appState: app, os: 'ios',
  });
  return { calls, clears, app, link, h: r.mount(() => use(options)) };
}

test('H13 iOS: the extension link reaches the native module once', () => {
  for (const url of ['myapp://dataUrl=myappShareKey#text', 'myapp://dataUrl=myappShareKey?nonce=1#media']) {
    const t = iosHook(url);
    assert.deepEqual(t.calls, [url]);
    assert.equal(t.h.result().errorCode, null);
  }
});

test('H13 iOS AppState: background resets through the module, active re-reads the current link', () => {
  const t = iosHook(null);
  t.link.url = 'myapp://dataUrl=myappShareKey#text';
  t.app.emit('background');                                // re-renders: the new link is read once
  assert.deepEqual(t.clears, ['myappShareKey']);
  assert.deepEqual(t.calls, [t.link.url]);
  t.app.emit('active');                                    // the same link again (a repeat share) is read again
  assert.deepEqual(t.calls, [t.link.url, t.link.url]);
});

test('H14 onResetShareIntent fires once when a value is reset, never when empty', async () => {
  let resets = 0;
  const t = android({ onResetShareIntent: () => { resets++; } });
  t.h.result().resetShareIntent();
  assert.equal(resets, 0);
  t.reads[0].resolve(A); await tick();
  t.h.result().resetShareIntent(); t.h.result().resetShareIntent();
  assert.equal(resets, 1);
});

test('H15 iOS: a forged share link makes no native call and says so; other links are ignored', () => {
  for (const url of ['myapp://dataUrl=x', 'myapp://dataUrl=myappShareKey', 'myapp://dataUrl=otherShareKey#text']) {
    const t = iosHook(url);
    assert.deepEqual(t.calls, [], url);
    assert.equal(t.h.result().errorCode, 'invalid_share_url', url);
    assert.equal(t.h.result().error, WORDS['share.invalid_link']);
  }
  const t = iosHook('https://example.com/a');
  assert.deepEqual(t.calls, []);
  assert.equal(t.h.result().errorCode, null);
});

test('H16 results map to upstream shapes, words and counts through the real parser', async () => {
  const u = android();
  u.reads[0].resolve({ kind: 'unreadable', seq: 1, skipReasons: ['unreadable', 'own_provider'] }); await tick();
  assert.deepEqual([u.h.result().errorCode, u.h.result().error, u.h.result().skipped], ['unreadable', WORDS['share.unreadable'], 2]);

  const img = (n: string) => ({ contentUri: `content://p/${n}`, filePath: `/cache/byokit-share/1/${n}`, fileName: n, mimeType: 'image/png', fileSize: '10', width: 2, height: 3, duration: null });
  const p = android();
  p.reads[0].resolve({ kind: 'shared', seq: 1, text: null, title: null, files: [img('a.png')], skipReasons: ['too_large'] }); await tick();
  const s = p.h.result();
  assert.deepEqual([s.errorCode, s.error, s.skipped, s.shareIntent.type], ['partial', null, 1, 'media']);
  assert.equal(s.shareIntent.files?.[0].path, 'file:///cache/byokit-share/1/a.png');

  const w = android();
  w.reads[0].resolve(text(1, 'see https://example.com/x')); await tick();
  assert.equal(w.h.result().shareIntent.type, 'weburl');
  assert.equal(w.h.result().shareIntent.webUrl, 'https://example.com/x');
  assert.ok(w.parsed.every((o) => o.debug === false), 'parse always gets merged options');
});

test('H17 the Android ShareIntentModule adapter keeps upstream events, order and listener set', async () => {
  const n = fakeNative(), m = createAndroidShareModule(n.native), seen: string[] = [];
  const offState = m.addListener('onStateChange', (e) => { seen.push(`state:${e.value}`); });
  const onChange = (e: { value: unknown }) => { seen.push(`change:${(e.value as { text: string }).text}`); };
  m.addListener('onChange', onChange);
  assert.equal(m.listenerCount('onChange'), 1);
  const got = m.getShareIntent(''); n.reads[0].resolve(A); await got;
  assert.deepEqual(seen, ['state:pending', 'change:hello A']);
  await m.clearShareIntent('ignored');
  assert.ok(n.log.includes('clear(1)'));
  m.removeListener('onChange', onChange); assert.equal(m.listenerCount('onChange'), 0);
  offState.remove(); assert.equal(m.listenerCount('onStateChange'), 0);
  m.addListener('onError', (e) => { seen.push(`error:${e.value}`); });
  const bad = m.getShareIntent(''); n.reads[1].reject(new Error('x')); await bad;
  assert.equal(seen.at(-1), `error:${WORDS['share.failed']}`);
  m.removeAllListeners('onError'); assert.equal(m.listenerCount('onError'), 0);
});

test('H17 the iOS ShareIntentModule reaches native only for the extension link and delegates the rest', async () => {
  const seen: string[] = [];
  const inner = {
    getShareIntent: async (u: string) => { seen.push(`get:${u}`); }, clearShareIntent: async (k: string) => { seen.push(`clear:${k}`); },
    hasShareIntent: (k: string) => { seen.push(`has:${k}`); return false; },
    addListener: (e: string) => { seen.push(`add:${e}`); return { remove() {} }; }, removeListener: (e: string) => { seen.push(`rm:${e}`); },
    removeAllListeners: (e: string) => { seen.push(`rmall:${e}`); }, emit: (e: string) => { seen.push(`emit:${e}`); },
    listenerCount: (e: string) => { seen.push(`count:${e}`); return 0; },
  } as unknown as ShareIntentModuleLike;
  const m = guardIosShareModule(inner, () => 'myapp');
  await assert.rejects(m.getShareIntent('myapp://dataUrl=x'), (e: unknown) => e instanceof ShareError && e.code === 'invalid_share_url');
  assert.deepEqual(seen, []);
  await m.getShareIntent('myapp://dataUrl=myappShareKey#file');
  const f = () => {};
  await m.clearShareIntent('k'); m.hasShareIntent('k'); m.addListener('onChange', f); m.removeListener('onChange', f);
  m.removeAllListeners('onError'); m.emit('onStateChange', { value: 'none' }); m.listenerCount('onChange');
  assert.deepEqual(seen, ['get:myapp://dataUrl=myappShareKey#file', 'clear:k', 'has:k', 'add:onChange', 'rm:onChange', 'rmall:onError', 'emit:onStateChange', 'count:onChange']);
});

test('H18 StrictMode mount, cleanup, mount still applies a share', async () => {
  const t = android(undefined, true);
  t.reads.at(-1)!.resolve(A); await tick();
  assert.equal(shown(t.h.result()), 'hello A');
});

test('H19 a late older read after a clear stays cleared, across a remount too', async () => {
  const t = android();
  t.emitShare(); t.reads[1].resolve(B); await tick();
  t.h.result().resetShareIntent(); t.reads[0].resolve(A); await tick();
  assert.deepEqual(t.log.filter((l) => l.startsWith('clear')), ['clear(2)']);
  assert.equal(t.h.result().hasShareIntent, false);
  t.h.unmount();                                           // (a) remount: native returns none after its clear (J11)
  const a = t.mount(); t.reads[2].resolve(NONE); await tick();
  assert.equal(a.result().hasShareIntent, false);

  const v = android();                                     // (b) remount before the older read resolves
  v.emitShare(); v.reads[1].resolve(B); await tick();
  v.h.result().resetShareIntent(); v.h.unmount();
  const before = v.parsed.length;
  const b = v.mount(); v.reads[0].resolve(text(3, 'late')); v.reads[2].resolve(NONE); await tick();
  assert.equal(v.parsed.length, before, 'the unmounted run never applies its late read');
  assert.equal(b.result().hasShareIntent, false);
});

test('H20 a read asked before a reset that then fails shows nothing', async () => {
  const t = android();
  await applied1(t);
  t.emitShare(); t.h.result().resetShareIntent(); t.reads[1].reject(new Error('x')); await tick();
  const s = t.h.result();
  assert.deepEqual([s.hasShareIntent, s.errorCode, s.error], [false, null, null]);
});

test('H21 reset and new-share ordering', async () => {
  const a = android();
  await applied1(a);
  a.h.result().resetShareIntent(); a.emitShare(); a.reads[1].resolve(B); await tick();
  assert.equal(shown(a.h.result()), 'hello B');

  const b = android();
  await applied1(b);
  b.h.result().resetShareIntent(); b.emitShare(); b.reads[1].reject(new Error('x')); await tick();
  assert.equal(b.h.result().errorCode, 'failed', 'a read asked after the reset may fail');

  const c = android();
  await applied1(c);
  c.emitShare(); c.emitShare(); c.h.result().resetShareIntent();
  c.reads[2].resolve(B); await tick(); c.reads[1].reject(new Error('x')); await tick();
  assert.equal(shown(c.h.result()), 'hello B');
  assert.equal(c.h.result().errorCode, null);
});

test('H22 a reset before the first delivery clears nothing and the pending share still arrives (L16)', async () => {
  const t = android();
  t.h.result().resetShareIntent(); t.reads[0].resolve(A); await tick();
  assert.ok(!t.log.some((l) => l.startsWith('clear')));
  assert.equal(shown(t.h.result()), 'hello A');
});
