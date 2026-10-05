// O9 acceptance: the link adapter over a real Host + DeviceLink pair on loopback with fakeGateway —
// every op round-trips, view grants and foreign members are refused with link.notAllowed, oc.call is
// default-refused, notices are sealed with title-only relay, and serve() binds per reach.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scratchDir } from '../../test-support.ts';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  DeviceLink,
  Host,
  PublicLinkError,
  keyPair,
  pairWithOffer,
  type DeviceGrant,
  type Grant,
} from '@byokit/link';
import type { PushAction, RelayClient } from '@byokit/relay';
import { OpenClawKit } from '../src/kit.ts';
import { openclawLink, serve } from '../src/link.ts';
import { openclawDevice, LinkRefused } from '../src/device.ts';
import { openNotice } from '../src/notices.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { words } from '../src/words.ts';
import type { RunEvent } from '../src/types.ts';
import { phaseOf } from '@byokit/ui-core';

const NOT_ALLOWED = words('link.notAllowed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const value = await fn();
    if (value) return value;
  }
  throw new Error('timed out');
}

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

type World = {
  kit: OpenClawKit;
  fake: ReturnType<typeof fakeGateway>;
  api: ReturnType<typeof openclawLink>;
  host: Host;
  url: string;
  relayCalls: { n: Record<string, unknown>; o: { includeContent?: boolean } }[];
  stop(): void;
};

async function world(o: { passThrough?: (method: string, grant: Grant) => boolean; relay?: boolean; tools?: boolean; reply?: () => string } = {}): Promise<World> {
  const fake = fakeGateway();
  const stateDir = scratchDir('o9');
  // tools: two app tools, every call allowed and answered with its own name.
  const kit = new OpenClawKit({ stateDir, transport: (ctx) => {
    const t = fake.factory(ctx);
    return { ...t, request: async (method, params, options) => {
      const result = await t.request(method, params, options);
      if (method === 'agent' && o.reply) return { ...(result as object),
        result: { ...(result as { result: object }).result, payloads: [{ text: o.reply() }] } };
      return method === 'agent.wait' && o.reply
        ? { ...(result as object), terminalReply: { text: o.reply() } } : result;
    } };
  }, spawnEngine: false, ...(o.tools ? {
    tools: ['report', 'lookup'].map((name) => ({ name, description: name, parameters: { type: 'object' } })),
    host: { gate: async () => ({ allow: true as const }), call: async (_run, tool) => `${tool} done` },
  } : {}) });
  await kit.start();
  const relayCalls: World['relayCalls'] = [];
  const relay = (o.relay ?? true
    ? ({ notify: async (n: Record<string, unknown>, options: { includeContent?: boolean } = {}) => {
        relayCalls.push({ n, o: options });
        return { sent: 1 };
      } } as unknown as RelayClient)
    : undefined);
  const api = openclawLink(kit, {
    memberOf: (grant) => (grant.meta as { member?: string } | undefined)?.member,
    ...(o.passThrough ? { passThrough: o.passThrough } : {}),
    ...(relay ? { relay } : {}),
  });
  const host = await Host.open({ keys: keyPair(), name: 'test computer', confirm: () => true, ...api });
  const sockets: WsSocket[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    host.accept(ws);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  const stop = () => {
    host.close();
    for (const s of sockets) s.terminate();
    wss.close();
    server.close();
    void kit.stop().then(() => rmSync(stateDir, { recursive: true, force: true }));
  };
  closers.push(stop);
  return { kit, fake, api, host, url, relayCalls, stop };
}

async function device(w: World, member: string | undefined, role: 'control' | 'view' = 'control') {
  const { text } = w.host.offer({ role, urls: [w.url], ...(member === undefined ? {} : { meta: { member } }) });
  const grant: DeviceGrant = await pairWithOffer(text, { name: `${member ?? 'nobody'}-phone`, onWords: () => {} });
  const store = { g: grant as DeviceGrant | null, save(g: DeviceGrant) { this.g = g; }, clear() { this.g = null; } };
  let online = false;
  const link = new DeviceLink(grant, { store, onStatus: (s) => { online = s === 'online'; } });
  closers.push(() => link.stop());
  // Requests wait through reconnects, but streams need a live connection now.
  await until(() => (online ? true : undefined));
  return { oc: openclawDevice(link), link, grant };
}

const rejectsNotAllowed = (p: Promise<unknown>) =>
  assert.rejects(p, (e: unknown) => e instanceof PublicLinkError && e.message === NOT_ALLOWED);

test('state, routes and member gating round-trip', async () => {
  const w = await world();
  const a = await device(w, 'a');
  const st = await a.oc.state();
  assert.equal(st.state.phase, 'ready');
  assert.equal(st.words, words('engine.ready'));
  const routes = await a.oc.routes();
  assert.equal(routes.length, 96);
  assert.equal(routes.filter(route => route.choice).length, 91);
  assert.ok(routes.some(route => route.readiness === 'needs_plugin' && !route.offer));
  assert.ok(routes.some(route => route.readiness === 'no_upstream_flow' && !route.offer));
  for (const route of routes.filter(route => route.offer)) {
    assert.equal(route.billing, 'subscription');
    assert.equal(route.offerPolicy, 'default');
    assert.equal(route.readiness, 'ready');
  }
  const calls = w.fake.calls.length;
  for (const provider of ['openrouter', 'chutes', 'kimi', 'google-gemini-cli', 'ollama', 'custom']) {
    await rejectsNotAllowed(a.oc.signIn.start(provider, 'browser'));
  }
  assert.equal(w.fake.calls.length, calls, 'listed explicit/unavailable routes do not trigger an engine auth call');

  const nobody = await device(w, undefined);
  await rejectsNotAllowed(nobody.oc.state());
  await rejectsNotAllowed(nobody.link.request('oc.call', { method: 'health' }));
});

test('view grant refused on every non-view op with link.notAllowed', async () => {
  const w = await world();
  const v = await device(w, 'a', 'view');
  await v.oc.state();
  assert.deepEqual(await v.oc.approvals(), []);
  // A stream refusal arrives after the host accepts the open, so the portable client raises its
  // link twin with the same words (device.ts cannot import link's class without breaking portability).
  await assert.rejects(async () => { for await (const _ of v.oc.run('hello')) void _; },
    (e: unknown) => e instanceof LinkRefused && (e as Error).message === NOT_ALLOWED);
  await rejectsNotAllowed(v.oc.steer('agent:a:x', 'hi'));
  await rejectsNotAllowed(v.oc.abort('agent:a:x'));
  await rejectsNotAllowed(v.oc.decide('nope', { allow: true }));
  await rejectsNotAllowed(v.oc.call('health', {}));
  await rejectsNotAllowed(v.oc.signOut('openai'));
  // sessions is a view op.
  w.fake.handle('sessions.list', () => ({ sessions: [{ sessionKey: 'agent:a:x' }] }));
  assert.deepEqual(await v.oc.sessions(), [{ sessionKey: 'agent:a:x' }]);
  // View streams still open: events (no frames yet, so just open and close).
  const it = v.oc.events()[Symbol.asyncIterator]();
  await it.return?.();
});

test('member isolation: sessions, steer, approvals and decide', async () => {
  const w = await world();
  w.fake.handle('sessions.list', () => ({ sessions: [{ sessionKey: 'agent:a:x' }, { sessionKey: 'agent:b:y' }] }));
  const a = await device(w, 'a');
  const b = await device(w, 'b');

  const frames: unknown[] = [];
  for await (const f of a.oc.run('hello', { sessionKey: 'agent:a:x' })) frames.push(f);
  assert.equal((frames.at(-1) as { end: { ok: boolean } }).end.ok, true);

  await rejectsNotAllowed(b.oc.steer('agent:a:x', 'hijack'));
  await rejectsNotAllowed(b.oc.abort('agent:a:x'));
  // Each member's sessions list shows only its own keys.
  assert.deepEqual(await b.oc.sessions(), [{ sessionKey: 'agent:b:y' }]);

  await w.kit.call('exec.approval.request', { id: 'a1', command: 'restart radio', agentId: 'a', sessionKey: 'agent:a:x' });
  await until(() => (a.oc.approvals() as Promise<{ id: string }[]>).then((l) => (l.some((x) => x.id === 'a1') ? true : undefined)));
  assert.deepEqual(await b.oc.approvals(), []);
  await rejectsNotAllowed(b.oc.decide('a1', { allow: true }));
  await a.oc.decide('a1', { allow: true });
  await until(() => a.oc.approvals().then((l) => (l.length === 0 ? true : undefined)));

  assert.deepEqual(await a.oc.sessions(), [{ sessionKey: 'agent:a:x' }]);
});

test('signOut signs out the device member only', async () => {
  const w = await world();
  const logouts: unknown[] = [];
  w.fake.handle('models.authLogout', (p) => { logouts.push(p); return {}; });
  const a = await device(w, 'a');
  await a.oc.signOut('openai');
  assert.deepEqual(logouts, [{ provider: 'openai', agentId: 'a' }]);
  const nobody = await device(w, undefined);
  await rejectsNotAllowed(nobody.oc.signOut('openai'));
  assert.equal(logouts.length, 1);
});

test('oc.call refused by default, allowed by predicate', async () => {
  const denied = await world();
  const a = await device(denied, 'a');
  await rejectsNotAllowed(a.oc.call('health', {}));

  const allowed = await world({ passThrough: (method) => method === 'health' });
  const c = await device(allowed, 'a');
  assert.deepEqual(await c.oc.call('health', {}), { ok: true, plugins: { loaded: [] } });
  await rejectsNotAllowed(c.oc.call('sessions.list', {}));
});

test('oc.run streams text frames then end', async () => {
  const w = await world();
  const a = await device(w, 'a');
  const frames: unknown[] = [];
  for await (const f of a.oc.run('hello')) frames.push(f);
  const texts = frames.filter((f): f is { type: string; text: string } => (f as { type?: string }).type === 'text');
  assert.ok(texts.length >= 2, 'assistant stream plus the final cumulative text');
  assert.ok(texts.every((t) => t.text === 'fake: hello'));
  assert.deepEqual(frames.at(-1), { type: 'end', end: { ok: true, text: 'fake: hello',
    usage: { input: 5, output: 11, total: 16 } } });
});

test('oc.run carries a picked account to the kit run', async () => {
  const w = await world();
  w.fake.handle('models.authStatus', () => ({ providers: [{ provider: 'openai', status: 'ok' }] }));
  const a = await device(w, 'a');
  const frames: unknown[] = [];
  for await (const f of a.oc.run('hello', { model: 'openai/gpt-5.1' })) frames.push(f);
  assert.deepEqual(frames.at(-1), { type: 'end', end: { ok: true, text: 'fake: hello', usage: { input: 5, output: 11, total: 16 } } });
  const call = w.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.deepEqual([call.provider, call.model], ['openai', 'gpt-5.1']);
});

test('oc.run forwards system, images and thinking, and checks each option', async () => {
  const w = await world();
  const a = await device(w, 'a');
  const images = [{ data: 'aGk=', mimeType: 'image/png' }];
  for await (const _ of a.oc.run('look', { system: 'be brief', images, thinking: 'high' })) void _;
  const call = w.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.equal(call.extraSystemPrompt, 'be brief');
  assert.deepEqual(call.attachments, [{ mimeType: 'image/png', content: 'aGk=' }]);
  assert.equal(call.thinking, 'high');
  for (const bad of [{ thinking: 'max' }, { system: 1 }, { images: [{ data: 'x' }] }, { images: 'x' }, { tools: [1] }]) {
    await assert.rejects(async () => { for await (const _ of a.oc.run('x', bad as never)) void _; }, LinkRefused);
  }
  assert.equal(w.fake.calls.filter((c) => c.method === 'agent').length, 1);
});

test('oc.run tool subset: only named kit tools run, an unknown name is refused, frames carry id, input and output', async () => {
  const w = await world({ tools: true });
  const a = await device(w, 'a');
  await assert.rejects(async () => { for await (const _ of a.oc.run('x', { tools: ['report', 'shell'] })) void _; },
    (e: unknown) => e instanceof LinkRefused && (e as Error).message === NOT_ALLOWED);
  const frames: RunEvent[] = [];
  for await (const f of a.oc.run('[tool report {"text":"hi"}] [tool lookup {"q":"x"}]', { tools: ['report'] }))
    if (f.type === 'tool') frames.push(f);
  assert.deepEqual(frames, [
    { type: 'tool', name: 'report', phase: 'start', id: 'call-1', input: { text: 'hi' } },
    { type: 'tool', name: 'report', phase: 'end', id: 'call-1', output: { content: [{ type: 'text', text: 'report done' }] }, error: false },
    { type: 'tool', name: 'lookup', phase: 'start', id: 'call-2', input: { q: 'x' } },
    { type: 'tool', name: 'lookup', phase: 'end', id: 'call-2',
      output: { content: [{ type: 'text', text: 'this tool is not available in this run' }] }, error: true },
  ]);
  // Without a subset every kit tool runs.
  const all: RunEvent[] = [];
  for await (const f of a.oc.run('[tool lookup {"q":"x"}]')) if (f.type === 'tool') all.push(f);
  assert.equal((all.at(-1) as { error?: boolean }).error, false);
});

test('oc.state carries the kit and engine versions and the member\'s sign-ins', async () => {
  const w = await world();
  const a = await device(w, 'a');
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  assert.deepEqual(await a.oc.state(), { state: { phase: 'ready' }, words: words('engine.ready'), version, engine: '2026.8.33', signedIn: [] });
  // Only a usable sign-in counts: an expired or unfinished one (the pin lists both) is not signed in.
  w.fake.handle('models.authStatus', (p) => ({ providers: p.agentId === 'a' ? [{ provider: 'openai', status: 'ok' },
    { provider: 'xai', status: 'expired', profiles: [{ status: 'expired' }] }, { provider: 'minimax', status: 'missing' }] : [] }));
  assert.deepEqual((await a.oc.state()).signedIn, ['openai']);
  w.fake.handle('openclaw.setup.detect', (p) => ({ candidates: p.agentId === 'a' ? [{ kind: 'claude-cli', credentials: true }] : [] }));
  assert.deepEqual((await a.oc.state()).signedIn, ['openai', 'claude-cli']);
  assert.equal(await w.kit.signedIn('a', 'claude-cli'), true);
  w.fake.handle('openclaw.setup.detect', () => ({ candidates: [] }));
  w.fake.handle('models.authStatus', () => ({ providers: [], unavailable: { code: 'PREPARED_MODEL_AUTH_UNAVAILABLE' } }));
  assert.equal((await a.oc.state()).signedIn, undefined, 'no prepared status is unknown, not none');
  w.fake.handle('models.authStatus', (p) => ({ providers: p.agentId === 'a' ? [{ provider: 'openai', status: 'ok' }] : [] }));
  const b = await device(w, 'b', 'view');
  assert.deepEqual((await b.oc.state()).signedIn, []);
  // While the engine can't say, signedIn is absent, never empty.
  await w.kit.stop();
  const stopped = await a.oc.state();
  assert.equal(stopped.signedIn, undefined);
  assert.equal(stopped.version, version);
});

test('oc.events carries only the member’s gateway events plus approval frames', async () => {
  const w = await world();
  const a = await device(w, 'a');
  const seen: unknown[] = [];
  const it = a.oc.events()[Symbol.asyncIterator]();
  const pump = (async () => {
    for await (const f of { [Symbol.asyncIterator]: () => it }) seen.push(f);
  })();
  void pump;
  // Another member's event never arrives.
  w.fake.emit('agent', { agentId: 'b', runId: 'r-b', stream: 'assistant', data: { text: 'nope' } });
  await sleep(150);
  assert.equal(seen.length, 0);
  w.fake.emit('agent', { agentId: 'a', runId: 'r-a', stream: 'assistant', data: { text: 'mine' } });
  const mine = await until(() => seen[0]);
  assert.equal((mine as { event: string }).event, 'agent');
  await w.kit.call('exec.approval.request', { id: 'ev1', command: 'tune antenna', agentId: 'a', sessionKey: 'agent:a:x' });
  const approval = await until(() => seen.find((f) => (f as { event?: string }).event === 'approval'));
  assert.equal((approval as { change: string }).change, 'added');
  assert.equal((approval as { approval: { id: string } }).approval.id, 'ev1');
  await it.return?.();
});

test('registerNotices seals the approval; title-only relay; push action decides', async () => {
  const w = await world();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const a = await device(w, 'a');
  const a2 = await device(w, 'a'); // boxless: generic title only
  await a2.oc.state(); // the adapter knows grants that have called (it has no host grant list)
  await a.oc.registerNotices(seed);

  await w.kit.call('exec.approval.request', { id: 'n1', command: 'erase /tmp/noticeme', agentId: 'a', sessionKey: 'agent:a:x' });
  const sealed = await until(() => w.relayCalls.find((c) => c.o.includeContent && (c.n.to as string[] | undefined)?.includes(a.grant.device.id)));
  assert.equal(sealed.n.title, words('approval.notice'));
  assert.equal(typeof (sealed.n.data as { sealed?: unknown }).sealed, 'string');
  assert.doesNotMatch(JSON.stringify(sealed.n), /noticeme/, 'the relay reads only the generic title');
  const generic = await until(() => w.relayCalls.find((c) => !c.o.includeContent && (c.n.to as string[] | undefined)?.includes(a2.grant.device.id)));
  assert.equal(generic.n.title, words('approval.notice'));
  assert.equal(generic.n.data, undefined);

  const opened = openNotice(sealed.n.data as Record<string, unknown>, seed);
  assert.equal(opened?.id, 'n1');
  assert.equal(opened?.member, 'a');
  assert.equal(opened?.summary, 'run erase /tmp/noticeme');
  assert.equal(openNotice(sealed.n.data as Record<string, unknown>, crypto.getRandomValues(new Uint8Array(32))), null);

  // Push action allow decides it; a foreign device's action is refused.
  const b = await device(w, 'b');
  const action: PushAction = { device: a.grant.device.id, event: 'n1', action: 'allow' };
  await assert.rejects(w.api.onAction({ ...action, device: b.grant.device.id }), (e: unknown) => e instanceof PublicLinkError);
  const viewer = await device(w, 'a', 'view');
  await viewer.oc.state(); // remembered grant, same member, but no authority to decide
  await assert.rejects(w.api.onAction({ ...action, device: viewer.grant.device.id }), (e: unknown) => e instanceof PublicLinkError);
  assert.ok((await a.oc.approvals()).some((approval) => approval.id === 'n1'), 'a refused push action leaves the approval pending');
  await w.api.onAction(action);
  await until(() => a.oc.approvals().then((l) => (l.length === 0 ? true : undefined)));
});

test('sign-in over the link: device code to done', async () => {
  const w = await world();
  // Gate the fake wizard so the code stage stays up until the test releases it: the real script
  // finishes in milliseconds and the transient view would otherwise be missed.
  w.fake.handle('openclaw.setup.auth.start', () => ({ sessionId: 'link-test', done: false, status: 'running' }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let authed = false;
  const deviceStep = { id: 'step-device', type: 'note', deviceCode: { code: 'CREW-2026' }, externalUrl: 'https://auth.openai.com/codex/device' };
  const progressStep = { id: 'step-wait', type: 'progress' };
  let pulls = 0;
  w.fake.handle('wizard.next', async (p) => {
    const params = p as { answer?: unknown };
    if (params.answer) return { done: false, step: progressStep };
    if (++pulls <= 2) return { done: false, step: pulls === 1 ? deviceStep : progressStep };
    await gate;
    authed = true;
    return { done: true, status: 'done' };
  });
  w.fake.handle('models.authStatus', () => ({ providers: authed ? [{ provider: 'openai' }] : [] }));
  const a = await device(w, 'a');
  const first = await a.oc.signIn.start('openai', 'code');
  assert.equal(first.state, 'waiting');
  const code = await until(async () => {
    const v = await a.oc.signIn.view('openai');
    return v.signIn && 'code' in v.signIn && v.signIn.code ? v : undefined;
  });
  assert.equal((code.signIn as { code: string }).code, 'CREW-2026');
  assert.equal(code.ready, false, 'not signed in yet: the engine being ready is not the account');
  assert.equal(phaseOf(code), 'code');
  release();
  const done = await until(async () => {
    const v = await a.oc.signIn.view('openai');
    return v.signIn?.state === 'done' ? v : undefined;
  });
  assert.equal(done.ready, true);
  assert.equal(await w.kit.signedIn('a', 'openai'), true);
  // Signed out anywhere (here: on the computer, not over the link): no finished sign-in is left to show.
  authed = false;
  assert.deepEqual(await a.oc.signIn.view('openai'), { ready: false, signIn: null }, 'signed out: no finished sign-in left to show');
});

test('serve binds per reach and pairs over its urls', async () => {
  const w = await world();
  const free = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
  const served = await serve({ host: w.host, port: free, via: 'lan' });
  closers.push(() => void served.close());
  assert.ok(served.urls.length > 0 && served.urls.every((u) => u.startsWith('ws://')));
  // The egress guard (scripts/test.sh, CI) blocks non-loopback dials, so pair over loopback: serve
  // binds 0.0.0.0 for lan, which still answers 127.0.0.1. The LAN urls themselves are reach's job.
  const loopback = served.urls.map((u) => {
    const url = new URL(u);
    url.hostname = '127.0.0.1';
    return url.toString();
  });
  const { text } = w.host.offer({ role: 'control', urls: loopback, meta: { member: 'a' } });
  const grant: DeviceGrant = await pairWithOffer(text, { name: 'served-phone', onWords: () => {} });
  const link = new DeviceLink(grant, { store: { save: () => {}, clear: () => {} } });
  closers.push(() => link.stop());
  const oc = openclawDevice(link);
  assert.equal((await oc.state()).state.phase, 'ready');
  await served.close();
});

test('native CLI legacy browser sign-in survives full discovery and guards activation', async () => {
  const w = await world();
  let loggedIn = true;
  w.fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', credentials: loggedIn }] }));
  w.fake.handle('openclaw.setup.activate', (params) => {
    assert.deepEqual(params, { agentId: 'a', kind: 'claude-cli' });
    return { ok: true };
  });
  const a = await device(w, 'a');
  const native = (await a.oc.routes()).find(route => route.choice === 'anthropic-cli');
  assert.equal(native?.provider, 'anthropic', 'discovery uses the manifest provider, not its CLI backend');
  assert.equal(native?.via, 'cli');
  assert.equal(native?.offer, false, 'unknown binary availability is not a default claim');
  assert.equal(native?.readiness, 'needs_binary');
  await a.oc.signIn.start('claude-cli', 'browser');
  const view = await until(async () => {
    const next = await a.oc.signIn.view('claude-cli');
    return next.signIn?.state === 'done' ? next : undefined;
  });
  assert.equal(view.ready, true);
  assert.deepEqual((await a.oc.state()).signedIn, ['claude-cli']);
  loggedIn = false;
  assert.deepEqual(await a.oc.signIn.view('claude-cli'), { ready: false, signIn: null });
  assert.deepEqual((await a.oc.state()).signedIn, []);
  const activations = w.fake.calls.filter(call => call.method === 'openclaw.setup.activate').length;
  await a.oc.signIn.start('claude-cli', 'browser');
  const unavailable = await until(async () => {
    const next = await a.oc.signIn.view('claude-cli');
    return next.signIn?.state === 'failed' ? next : undefined;
  });
  assert.equal(unavailable.ready, false);
  assert.equal(w.fake.calls.filter(call => call.method === 'openclaw.setup.activate').length, activations,
    'explicit legacy native selection still requires engine detection before activation');
});


test('a device schema run validates on the host and returns typed data over the real sealed link', async () => {
  let text = '{"summary":"Ready"}';
  const w = await world({ reply: () => text });
  const a = await device(w, 'a');
  const schema = { type: 'object', properties: { summary: { type: 'string' } },
    required: ['summary'], additionalProperties: false } as const;

  let returned = false;
  for await (const frame of a.oc.run('report', { schema, system: 'Be brief.' })) {
    if (frame.type !== 'end') continue;
    assert.ok(frame.end.ok && frame.end.data);
    const summary: string = frame.end.data.summary;
    assert.equal(summary, 'Ready');
    assert.equal(frame.end.text, text);
    assert.ok(frame.end.usage);
    returned = true;
  }
  assert.ok(returned);
  const params = w.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.ok(String(params.extraSystemPrompt).startsWith('Be brief.\n\nReturn only one JSON value'));
  assert.ok(String(params.extraSystemPrompt).endsWith(JSON.stringify(schema)));
  text = '{"summary":123}';
  for await (const frame of a.oc.run('report', { schema })) {
    if (frame.type === 'end') assert.deepEqual(frame.end,
      { ok: false, kind: 'output', message: 'The answer did not match the requested format.' });
  }
  const before = w.fake.calls.length;
  await assert.rejects(async () => {
    for await (const _ of a.oc.run('report', { schema: { properties: { summary: { format: 'email' } } } } as never)) void _;
  }, LinkRefused);
  assert.equal(w.fake.calls.length, before);
  w.stop();
});
