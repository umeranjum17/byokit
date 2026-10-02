// Internal W1/W2 seam. The pipe is the only Chromium debugging transport; agents never own it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage } from 'node:http';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { WebSocket, WebSocketServer } from 'ws';
import type { Member } from '../types.ts';
import type { LiveFrame, LiveInput } from '../browser.ts';

export type BrokerOptions = {
  executablePath: string;
  profileDir: string;
  member: Member;
  onExit(code: number | null): void;
};
export type LeaseBinding = { epoch: number; nonce: string; origin: string; knownIdps: string[] };
export type PrivateState = { origin: string; secure: boolean; offOrigin: boolean } | undefined;
export type Broker = {
  bindLease(l: LeaseBinding | null): void;
  confirmOrigin(l: { epoch: number; nonce: string }, origin: string): boolean;
  privateState(): PrivateState;
  clearSite(origins: string[]): Promise<void>;
  endpoint(): { cdpUrl: string };
  fence(on: boolean): Promise<void>;
  agentTab(): string | undefined;
  originOf(targetId: string): Promise<string>;
  openPrivate(url: string): Promise<string>;
  closePrivate(): Promise<void>;
  probe(url: string, verify: (p: Probe) => Promise<boolean>, timeoutMs: number): Promise<'ok' | 'fail' | 'timeout'>;
  attachViewer(o: { lease?: { epoch: number; nonce: string }; maxWidth?: number }): ViewerSession;
  navigateAgent(url: string | 'reload'): Promise<void>;
  close(): Promise<void>;
};
export type Probe = { url: string; status: number; exists(selector: string): Promise<boolean> };
export type ViewerSession = {
  frames: AsyncIterable<LiveFrame>;
  states: AsyncIterable<NonNullable<PrivateState>>;
  input(i: LiveInput): void;
  close(): void;
};

// CDP is extensible. Values stay inside this host-only module, never in error messages or logs.
type Params = Record<string, any>;
type Message = { id?: number; method?: string; params?: Params; sessionId?: string; result?: Params; error?: unknown };
type Target = { targetId: string; type: string; url: string; title: string; openerId?: string };
type Client = { ws: WebSocket; base: string; sessions: Set<string>; page?: string; control?: boolean; detaching?: Promise<void> };
type Pending = { agent: boolean; resolve(value: Params): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const heldError = { code: -32000, message: 'byokit: browser fenced' };
const refusedError = { code: -32001, message: 'byokit: command refused' };
const boundedMs = 5000;
const structural = new Set(['Target.attachedToTarget', 'Target.detachedFromTarget', 'Target.targetCreated',
  'Target.targetDestroyed', 'Target.targetInfoChanged', 'Target.targetCrashed', 'Page.frameAttached',
  'Page.frameDetached', 'Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameStartedLoading',
  'Page.frameStoppedLoading', 'Page.lifecycleEvent', 'Page.domContentEventFired', 'Page.loadEventFired',
  'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
  'Inspector.detached', 'Inspector.targetCrashed']);
const equal = (a: string, b: string) => {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const failure = () => new Error('byokit: browser command failed');
/** Chromium refused to start without its sandbox (e.g. unprivileged user namespaces disabled). The broker never runs it unsandboxed. */
export class BrowserSandboxUnavailable extends Error {
  readonly reason = 'sandbox-unavailable';
  constructor() { super('byokit: browser sandbox unavailable'); }
}
const origin = (url: string) => { try { return new URL(url).origin; } catch { return 'null'; } };
const exactOrigin = (value: string) => origin(value) !== 'null' && origin(value) === value;
const secureOrigin = (value: string) => {
  try { const u = new URL(value); return u.protocol === 'https:' || ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname); }
  catch { return false; }
};
// Only the newest frame/state is useful to a slow viewer; bounded memory, never replayed to an agent.
function latest<T>() {
  let value: T | undefined, ended = false, wake: (() => void) | undefined;
  return {
    push(item: T) { if (!ended) { value = item; wake?.(); } },
    end() { ended = true; value = undefined; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (value === undefined) await new Promise<void>(resolve => { wake = resolve; });
        if (ended) break;
        if (value !== undefined) { const item = value; value = undefined; yield item; }
      }
    },
  };
}
// JPEG segment lengths include their own two-byte length field. Read the encoded SOF,
// not CDP's unscaled viewport metadata (thumbnails deliberately differ from that viewport).
function jpegSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at++] !== 0xff) return;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2 || at + length > bytes.length) return;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return;
      const h = (bytes[at + 3]! << 8) | bytes[at + 4]!, w = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      return w > 0 && h > 0 ? { w, h } : undefined;
    }
    at += length;
  }
  return;
}
const controlMethods = new Set(['Target.attachToTarget', 'Target.detachFromTarget', 'Page.enable',
  'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck', 'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry', 'Page.reload', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
function validControl(method: string, p: Params): boolean {
  // A method allowlist alone is insufficient: Page.reload can carry a scriptToEvaluateOnLoad.
  if (method === 'Page.reload') return Object.keys(p).every(k => k === 'ignoreCache') && (p.ignoreCache === undefined || typeof p.ignoreCache === 'boolean');
  if (['Page.enable', 'Page.stopScreencast', 'Page.getNavigationHistory'].includes(method)) return Object.keys(p).length === 0;
  if (method === 'Page.navigateToHistoryEntry') return Object.keys(p).every(k => k === 'entryId') && Number.isSafeInteger(p.entryId);
  if (method === 'Page.screencastFrameAck') return Object.keys(p).every(k => k === 'sessionId') && Number.isSafeInteger(p.sessionId) && p.sessionId >= 0;
  if (method === 'Page.startScreencast') return Object.keys(p).every(k => ['format', 'quality', 'maxWidth', 'maxHeight', 'everyNthFrame'].includes(k))
    && (p.format === undefined || p.format === 'jpeg')
    && (p.quality === undefined || Number.isInteger(p.quality) && p.quality >= 0 && p.quality <= 100)
    && ['maxWidth', 'maxHeight'].every(k => p[k] === undefined || Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 2048)
    && (p.everyNthFrame === undefined || Number.isInteger(p.everyNthFrame) && p.everyNthFrame >= 1 && p.everyNthFrame <= 100);
  if (method === 'Target.attachToTarget') return Object.keys(p).every(k => ['targetId', 'flatten'].includes(k)) && typeof p.targetId === 'string';
  if (method === 'Target.detachFromTarget') return Object.keys(p).every(k => k === 'sessionId') && typeof p.sessionId === 'string';
  if (method === 'Input.insertText') return typeof p.text === 'string' && p.text.length <= 65536 && Object.keys(p).every(k => k === 'text');
  if (method === 'Input.dispatchMouseEvent') return ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(p.type)
    && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 100000 && Math.abs(p.y) <= 100000
    && (p.button === undefined || ['left', 'right', 'middle', 'none'].includes(p.button))
    && (p.deltaX === undefined || Number.isFinite(p.deltaX)) && (p.deltaY === undefined || Number.isFinite(p.deltaY))
    && Object.keys(p).every(k => ['type', 'x', 'y', 'button', 'clickCount', 'deltaX', 'deltaY'].includes(k));
  if (method === 'Input.dispatchKeyEvent') return ['keyDown', 'keyUp'].includes(p.type)
    && typeof p.key === 'string' && p.key.length <= 256 && (p.code === undefined || typeof p.code === 'string' && p.code.length <= 256)
    && (p.modifiers === undefined || Number.isInteger(p.modifiers) && p.modifiers >= 0 && p.modifiers <= 15)
    && Object.keys(p).every(k => ['type', 'key', 'code', 'modifiers'].includes(k));
  return true;
}

export async function launchBroker(o: BrokerOptions): Promise<Broker> {
  if (!isAbsolute(o.executablePath) || o.executablePath.includes('\0')) throw failure();
  await mkdir(join(o.profileDir, 'Default'), { recursive: true, mode: 0o700 });
  await chmod(o.profileDir, 0o700);
  await writeFile(join(o.profileDir, 'Default', 'Preferences'), JSON.stringify({
    credentials_enable_service: false, profile: { password_manager_enabled: false },
    autofill: { profile_enabled: false, credit_card_enabled: false },
  }), { mode: 0o600 });
  // Chromium's singleton socket lives under TMPDIR: an arbitrary app profile path can exceed AF_UNIX's limit.
  const privateTemp = await mkdtemp(join(tmpdir(), 'bk-'));
  const chrome = spawn(o.executablePath, ['--headless=new', `--user-data-dir=${o.profileDir}`,
    '--remote-debugging-pipe', '--disable-features=BackForwardCache', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank'], {
    // No inherited HOME, login, proxy, DISPLAY or debugging port. Chromium's profile is app-owned.
    env: { HOME: o.profileDir, TMPDIR: privateTemp },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'], // never inherit the caller's fd9 job lock
  });
  // Startup stderr stays in memory only to classify a sandbox refusal; it is never logged, returned or kept.
  let startup = '';
  const stderr = chrome.stderr!;
  const collect = (b: Buffer) => { if (startup.length < 16_384) startup += b.toString(); };
  stderr.on('data', collect);
  const writer = chrome.stdio[3] as Writable, reader = chrome.stdio[4] as Readable;
  const token = randomBytes(16).toString('hex');
  // Chromium's canonical browser path: the pinned engine strips /devtools/browser/<id> to find /json/* discovery.
  const browserPath = `/devtools/browser/${randomBytes(16).toString('hex')}`;
  const pending = new Map<number, Pending>();
  const clients = new Set<Client>();
  const owners = new Map<string, Client>();
  const sessionTargets = new Map<string, string>();
  const targets = new Map<string, Target>();
  const held = new Set<string>(), hidden = new Set<string>(), hostOnly = new Set<string>();
  const privateRoots = new Map<string, string>();
  const openings = new Set<Promise<string>>();
  const destroyed = new Map<string, Set<() => void>>();
  const listeners = new Set<(m: Message) => void>();
  let sequence = 0, port = 0, buffer = '', fenced = false, drained = false, poisoned = false, closed = false;
  let lastAgent: string | undefined;
  let fenceJob: Promise<void> | undefined, closingPrivate: Promise<void> | undefined;
  const decoder = new StringDecoder('utf8');
  let binding: LeaseBinding | null = null, highestEpoch = 0, activePrivate: string | undefined;
  const confirmed = new Set<string>(), privateOrigins = new Map<string, string>();
  const mainFrames = new Map<string, string>(), navigationEpoch = new Map<string, number>();
  type Viewer = { target?: string; sid?: string; scaleX: number; scaleY: number; hasFrame: boolean; control: boolean; closed: boolean; close(): void; frames: ReturnType<typeof latest<LiveFrame>>; states: ReturnType<typeof latest<NonNullable<PrivateState>>> };
  const viewers = new Set<Viewer>();
  let controller: Client | Viewer | undefined;
  function matches(l: { epoch: number; nonce: string }) {
    return !!binding && !!l && l.epoch === binding.epoch && typeof l.nonce === 'string' && equal(binding.nonce, l.nonce);
  }
  function stateOf(id: string | undefined): PrivateState {
    if (!id || !held.has(id)) return undefined;
    const current = privateOrigins.get(id) ?? 'null';
    return { origin: current, secure: secureOrigin(current), offOrigin: !binding
      || !(current === binding.origin || binding.knownIdps.includes(current) || confirmed.has(current)) };
  }
  function publishPrivate() {
    const state = stateOf(activePrivate);
    if (state) for (const v of viewers) if (v.control && !v.closed) v.states.push(state);
  }
  async function trackPrivate(id: string) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: id, flatten: true });
    sessionTargets.set(sessionId, id);
    await send('Page.enable', {}, sessionId);
    const epoch = navigationEpoch.get(id);
    const tree = await send('Page.getFrameTree', {}, sessionId);
    if (tree.frameTree?.frame?.id && held.has(id) && navigationEpoch.get(id) === epoch) {
      mainFrames.set(id, tree.frameTree.frame.id); privateOrigins.set(id, origin(tree.frameTree.frame.url));
    }
    return sessionId as string;
  }

  function send(method: string, params: Params = {}, sessionId?: string, agent = false): Promise<Params> {
    if (closed || poisoned) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        // Unknown commands (including host target creation/close) may still be running. Never release them.
        poisoned = true; fenced = true;
        reject(failure());
      }, boundedMs);
      pending.set(id, { agent, resolve, reject, timer });
      writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
        if (error) abortPipe();
      });
    });
  }
  function abortPipe() {
    poisoned = true; fenced = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(failure()); }
    pending.clear();
    for (const c of clients) c.ws.terminate();
    for (const v of viewers) v.close();
  }
  chrome.once('error', abortPipe);
  chrome.once('exit', code => { abortPipe(); o.onExit(code); });
  reader.once('end', abortPipe);
  reader.once('error', abortPipe);
  writer.once('error', abortPipe);
  reader.on('data', (data: Buffer) => {
    buffer += decoder.write(data);
    let end: number;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { route(JSON.parse(raw)); } catch { abortPipe(); }
    }
  });
  function own(c: Client, sid: string, target?: string) {
    owners.set(sid, c); c.sessions.add(sid);
    if (target) sessionTargets.set(sid, target);
  }
  function output(c: Client, m: Message) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
  }
  function route(m: Message) {
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(failure()); else p.resolve(m.result ?? {});
      return;
    }
    const info = m.params?.targetInfo as Target | undefined;
    if (info) {
      targets.set(info.targetId, info);
      if (info.openerId && hidden.has(info.openerId) && !hidden.has(info.targetId)) {
        held.add(info.targetId); hidden.add(info.targetId); privateOrigins.set(info.targetId, 'null');
        privateRoots.set(info.targetId, privateRoots.get(info.openerId) ?? info.openerId);
        if (hostOnly.has(info.openerId)) hostOnly.add(info.targetId);
        else if (info.type === 'page') activePrivate = info.targetId;
        // A late child of a closed private target is still private. Never forward it after release.
        if (!fenced) abortPipe();
        void trackPrivate(info.targetId).then(publishPrivate, () => { poisoned = true; fenced = true; });
      }
    }
    if (m.method === 'Target.targetDestroyed') {
      const id = m.params?.targetId as string;
      targets.delete(id); held.delete(id); privateOrigins.delete(id);
      if (activePrivate === id) activePrivate = [...held].find(t => !hostOnly.has(t) && targets.get(t)?.type === 'page');
      publishPrivate();
      for (const notify of destroyed.get(id) ?? []) notify();
      destroyed.delete(id);
    }
    const privateTarget = sessionTargets.get(m.sessionId ?? '');
    if (privateTarget && held.has(privateTarget)) {
      if (m.method === 'Page.frameStartedLoading' && m.params?.frameId === (mainFrames.get(privateTarget) ?? privateTarget)) {
        navigationEpoch.set(privateTarget, (navigationEpoch.get(privateTarget) ?? 0) + 1);
        privateOrigins.set(privateTarget, 'null'); publishPrivate();
      }
      if (m.method === 'Page.frameNavigated' && !m.params?.frame?.parentId) {
        mainFrames.set(privateTarget, m.params!.frame.id);
        navigationEpoch.set(privateTarget, (navigationEpoch.get(privateTarget) ?? 0) + 1);
        privateOrigins.set(privateTarget, origin(m.params!.frame.url)); publishPrivate();
      }
      if (m.method === 'Page.frameStoppedLoading' && m.params?.frameId === (mainFrames.get(privateTarget) ?? privateTarget)) {
        // A denied download has no frameNavigated. Read the committed main frame after it stops;
        // never re-enable input from a query overtaken by another navigation.
        const epoch = navigationEpoch.get(privateTarget);
        void send('Page.getFrameTree', {}, m.sessionId).then(tree => {
          if (held.has(privateTarget) && navigationEpoch.get(privateTarget) === epoch) {
            privateOrigins.set(privateTarget, origin(tree.frameTree.frame.url)); publishPrivate();
          }
        }, () => {});
      }
    }
    for (const listener of listeners) listener(m);
    const c = m.sessionId ? owners.get(m.sessionId) : undefined;
    if (!c) return;
    const target = info?.targetId ?? m.params?.targetId ?? sessionTargets.get(m.sessionId!);
    // No raw nested target channel: inspect the envelope before learning any child session.
    if (!c.control && (hidden.has(target) || (fenced && (!structural.has(m.method ?? '')
      || ![...c.sessions].some(sid => sessionTargets.get(sid) === target))))) return;
    if (c.control && (controller !== c || !held.has(target) || hostOnly.has(target) || !['Page.screencastFrame', ...structural].includes(m.method ?? ''))) return;
    if (m.method === 'Target.attachedToTarget') own(c, m.params!.sessionId, info?.targetId);
    if (m.method === 'Target.detachedFromTarget') {
      const sid = m.params!.sessionId;
      owners.delete(sid); c.sessions.delete(sid); sessionTargets.delete(sid);
    }
    output(c, { ...m, sessionId: m.sessionId === c.base ? undefined : m.sessionId });
  }
  function detach(c: Client): Promise<void> {
    if (c.detaching) return c.detaching;
    clients.delete(c);
    if (controller === c) controller = undefined;
    const sessions = [...c.sessions].reverse(); c.sessions.clear();
    for (const sid of sessions) { owners.delete(sid); sessionTargets.delete(sid); }
    c.detaching = (async () => {
      // Detaching the browser target severs its auto-attach/interception as well as child sessions.
      if (!closed && !poisoned && c.base) await send('Target.detachFromTarget', { sessionId: c.base }, undefined, true);
    })();
    return c.detaching;
  }
  function guarded(c: Client, m: Message): boolean {
    if (!Number.isSafeInteger(m.id) || typeof m.method !== 'string') return false;
    if (m.sessionId && owners.get(m.sessionId) !== c) return false;
    if (m.params?.targetId && held.has(m.params.targetId)) return false;
    if (['Browser.close', 'Browser.crash'].includes(m.method)) return false;
    // Legacy nested CDP must not bypass session ownership, target checks or command denial.
    if (m.method === 'Target.sendMessageToTarget') {
      if (owners.get(m.params?.sessionId) !== c || typeof m.params?.message !== 'string') return false;
      try { return guarded(c, JSON.parse(m.params.message)); } catch { return false; }
    }
    if (m.method === 'Target.detachFromTarget' && m.params?.sessionId && owners.get(m.params.sessionId) !== c) return false;
    return true;
  }
  async function command(c: Client, m: Message) {
    const reply = (value: Message) => output(c, { id: m.id, sessionId: m.sessionId, ...value });
    if (m.method === 'Byokit.claimTakeover') {
      if (c.page || poisoned || !fenced || !drained || !activePrivate || !matches(m.params as { epoch: number; nonce: string })
        || controller && controller !== c) return reply({ error: refusedError });
      c.control = true; controller = c; return reply({ result: { targetId: activePrivate } });
    }
    if (poisoned || fenced && !c.control) return reply({ error: heldError });
    if (c.control) {
      const target = m.params?.targetId ?? sessionTargets.get(m.sessionId ?? c.base);
      if (!binding || controller !== c || !controlMethods.has(m.method ?? '') || !held.has(target) || hostOnly.has(target)
        || !validControl(m.method!, m.params ?? {})
        || (m.method!.startsWith('Input.') || ['Page.reload', 'Page.navigateToHistoryEntry'].includes(m.method!)) && stateOf(target)?.offOrigin
        || m.sessionId && owners.get(m.sessionId) !== c) return reply({ error: refusedError });
    } else if (!guarded(c, m)) return reply({ error: refusedError });
    const target = m.params?.targetId ?? sessionTargets.get(m.sessionId ?? c.base);
    if (target && !held.has(target)) lastAgent = target;
    try {
      // Flattened child sessions keep ownership explicit even for auto-attached workers/iframes.
      const params = m.method === 'Target.attachToTarget' || m.method === 'Target.setAutoAttach'
        ? { ...m.params, flatten: true }
        : m.method === 'Browser.setDownloadBehavior' ? { ...m.params, behavior: 'deny', eventsEnabled: false }
        : m.method === 'Page.setDownloadBehavior' ? { ...m.params, behavior: 'deny' } : m.params;
      const result = await send(m.method!, params, m.sessionId ?? c.base, !c.control);
      if (result.sessionId && m.method!.startsWith('Target.attachTo')) own(c, result.sessionId, target);
      if (poisoned || fenced && !c.control) return reply({ error: heldError });
      if (m.method === 'Target.getTargets') result.targetInfos = (result.targetInfos ?? []).filter((t: Target) => !held.has(t.targetId));
      if (m.method === 'Target.getTargetInfo' && held.has(result.targetInfo?.targetId)) return reply({ error: refusedError });
      reply({ result });
    } catch { reply({ error: fenced ? heldError : refusedError }); }
  }
  function authorized(req: IncomingMessage, url: URL) {
    return req.headers.origin === undefined && req.headers.host === `127.0.0.1:${port}`
      && equal(token, url.searchParams.get('token') ?? '');
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) { res.writeHead(401); res.end(); return; }
    const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const description = (t: Target) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url, description: '',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.targetId}?token=${token}` });
    const match = url.pathname.match(/^\/json\/(list|new|activate|close)(?:\/([^/]+))?\/?$/);
    if (fenced || poisoned) { res.writeHead(409); res.end('byokit: browser fenced'); return; }
    try {
      if (/^\/json\/version\/?$/.test(url.pathname)) {
        const v = await send('Browser.getVersion', {}, undefined, true);
        if (fenced) throw failure();
        json({ Browser: v.product, 'Protocol-Version': v.protocolVersion, 'User-Agent': v.userAgent,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}${browserPath}?token=${token}` }); return;
      }
      if (!match) { res.writeHead(404); res.end(); return; }
      const action = match[1], id = match[2];
      if (id && held.has(id)) { res.writeHead(404); res.end(); return; }
      if (action === 'list') {
        const result = await send('Target.getTargets', {}, undefined, true);
        if (fenced) throw failure();
        json(result.targetInfos.filter((t: Target) => t.type === 'page' && !held.has(t.targetId)).map(description)); return;
      }
      if (action === 'new') {
        const raw = url.search.slice(1).split('&').find(part => !part.startsWith('token=')) ?? '';
        const { targetId } = await send('Target.createTarget', { url: decodeURIComponent(raw.replace(/^url=/, '')) || 'about:blank' }, undefined, true);
        const result = await send('Target.getTargetInfo', { targetId }, undefined, true);
        if (fenced) throw failure();
        lastAgent = targetId; json(description(result.targetInfo)); return;
      }
      if (!id || !targets.has(id)) { res.writeHead(404); res.end(); return; }
      await send(action === 'activate' ? 'Target.activateTarget' : 'Target.closeTarget', { targetId: id }, undefined, true);
      if (fenced) throw failure();
      res.writeHead(200); res.end(action === 'activate' ? 'Target activated' : 'Target is closing');
    } catch { res.writeHead(fenced ? 409 : 500); res.end('byokit: browser command failed'); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const page = url.pathname.match(/^\/devtools\/page\/([^/]+)$/)?.[1];
    if (!authorized(req, url) || (!page && url.pathname !== browserPath) || (page && held.has(page))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (poisoned || fenced && page) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      const c: Client = { ws, base: '', sessions: new Set(), page }; clients.add(c);
      const ready = send(page ? 'Target.attachToTarget' : 'Target.attachToBrowserTarget', page ? { targetId: page, flatten: true } : {}, undefined, !fenced)
        .then(async result => {
          own(c, result.sessionId, page); c.base = result.sessionId;
          if (!clients.has(c)) { ws.terminate(); await detach(c); }
        }, () => ws.terminate());
      ws.on('message', async data => {
        await ready;
        if (!c.base || !clients.has(c) || ws.readyState !== WebSocket.OPEN) return;
        try { await command(c, JSON.parse(data.toString())); } catch { ws.close(1008, 'invalid command'); }
      });
      ws.once('close', () => { void ready.then(() => detach(c)).catch(() => { poisoned = true; fenced = true; }); });
    });
  });

  function waitDestroyed(id: string): Promise<void> {
    if (!held.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { destroyed.get(id)?.delete(done); poisoned = true; reject(failure()); }, boundedMs);
      const list = destroyed.get(id) ?? new Set(); list.add(done); destroyed.set(id, list);
    });
  }
  function closePrivate(): Promise<void> {
    if (closingPrivate) return closingPrivate;
    if (!fenced) return Promise.reject(failure());
    binding = null; confirmed.clear(); controller = undefined;
    for (const v of viewers) if (v.control) v.close();
    for (const c of clients) if (c.control) c.ws.terminate();
    closingPrivate = (async () => {
      // A timed-out probe may still be opening its blank target. It cannot cross the release barrier.
      await Promise.all([...openings]);
      while (held.size) {
        await Promise.all([...held].map(async id => {
          const gone = waitDestroyed(id);
          // Observe both promises, including failure when closeTarget is refused or its result is unknown.
          await Promise.all([send('Target.closeTarget', { targetId: id }), gone]);
        }));
      }
    })();
    void closingPrivate.then(() => { closingPrivate = undefined; }, () => { closingPrivate = undefined; poisoned = true; fenced = true; });
    return closingPrivate;
  }
  function openPrivate(url: string, hostOnlyTab = false): Promise<string> {
    if (!fenced || !drained || poisoned || closingPrivate) return Promise.reject(failure());
    const work = (async () => {
      // Register about:blank before any site can run, navigate or open a popup.
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      held.add(targetId); hidden.add(targetId); privateOrigins.set(targetId, 'null'); privateRoots.set(targetId, targetId);
      if (hostOnlyTab) hostOnly.add(targetId); else activePrivate = targetId;
      const sessionId = await trackPrivate(targetId);
      await send('Page.navigate', { url }, sessionId);
      return targetId as string;
    })();
    openings.add(work);
    void work.then(() => openings.delete(work), () => { openings.delete(work); poisoned = true; fenced = true; });
    return work;
  }
  async function close() {
    if (closed) return;
    fenced = true;
    for (const c of clients) c.ws.terminate();
    for (const v of viewers) v.close();
    sockets.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // A failed spawn has no PID and emits close/error, never exit. Do not await a nonexistent process.
    if (chrome.pid === undefined) { closed = true; abortPipe(); await rm(privateTemp, { recursive: true, force: true }); return; }
    // Closing our pipe-only child never acts on another browser or a shared profile.
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return resolve();
      const timer = setTimeout(() => { chrome.kill('SIGKILL'); }, boundedMs);
      chrome.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    closed = true; abortPipe();
    await rm(privateTemp, { recursive: true, force: true });
  }

  try {
    await send('Browser.getVersion');
    await send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false });
    await send('Target.setDiscoverTargets', { discover: true });
    const result = await send('Target.getTargets');
    for (const t of result.targetInfos as Target[]) targets.set(t.targetId, t);
    lastAgent = (result.targetInfos as Target[]).find(t => t.type === 'page')?.targetId;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    port = (server.address() as { port: number }).port;
  } catch {
    await close();
    if (!stderr.closed) await Promise.race([once(stderr, 'close'), new Promise(resolve => setTimeout(resolve, 1000))]);
    const sandbox = startup.includes('No usable sandbox');
    startup = '';
    throw sandbox ? new BrowserSandboxUnavailable() : failure();
  }
  stderr.off('data', collect); startup = ''; stderr.resume(); // keep draining, keep nothing

  return {
    bindLease(l) {
      if (l === null) {
        binding = null; confirmed.clear(); controller = undefined;
        for (const v of viewers) if (v.control) v.close();
        for (const c of clients) if (c.control) c.ws.terminate();
        publishPrivate(); return;
      }
      if (!fenced || !drained || poisoned || closingPrivate || held.size || !Number.isSafeInteger(l.epoch) || l.epoch <= highestEpoch
        || !/^[A-Za-z0-9_-]{22,64}$/.test(l.nonce) || !exactOrigin(l.origin) || !l.knownIdps.every(exactOrigin)) throw failure();
      binding = { ...l, knownIdps: [...l.knownIdps] }; highestEpoch = l.epoch; confirmed.clear();
    },
    confirmOrigin(l, current) {
      if (!matches(l) || !exactOrigin(current) || stateOf(activePrivate)?.origin !== current) return false;
      confirmed.add(current); publishPrivate(); return true;
    },
    privateState: () => stateOf(activePrivate),
    async clearSite(origins) {
      if (fenced || held.size || poisoned || !origins.every(exactOrigin)) throw failure();
      if (!lastAgent) throw failure();
      // Storage.clearDataForOrigin is a page-domain command in the pinned Chromium, not a root command.
      const { sessionId } = await send('Target.attachToTarget', { targetId: lastAgent, flatten: true });
      try { for (const current of origins) await send('Storage.clearDataForOrigin', { origin: current, storageTypes: 'all' }, sessionId); }
      finally { await send('Target.detachFromTarget', { sessionId }); }
    },
    endpoint: () => ({ cdpUrl: `ws://127.0.0.1:${port}${browserPath}?token=${token}` }),
    async fence(on) {
      if (!on) {
        if (poisoned || closed || held.size || openings.size || fenceJob || closingPrivate) throw failure();
        if (!fenced) return;
        if (!drained) throw failure();
        fenced = false; drained = false; return;
      }
      if (fenceJob) return fenceJob;
      if (fenced && drained) { if (poisoned) throw failure(); return; }
      fenced = true;
      for (const v of viewers) if (!v.control) v.close();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const barrier = (async () => {
        const until = Date.now() + boundedMs;
        while ([...pending.values()].some(p => p.agent)) {
          if (Date.now() >= until || poisoned) { poisoned = true; throw failure(); }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await Promise.all([...clients].map(async c => { c.ws.terminate(); await detach(c); }));
        if (poisoned) throw failure();
        drained = true;
      })();
      fenceJob = Promise.race([barrier, new Promise<void>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => { poisoned = true; fenced = true; reject(failure()); }, boundedMs);
      })]);
      try { await fenceJob; } finally { clearTimeout(deadlineTimer); fenceJob = undefined; }
    },
    agentTab: () => lastAgent,
    async originOf(targetId) {
      const result = await send('Target.getTargetInfo', { targetId });
      try { return new URL(result.targetInfo.url).origin; } catch { return 'null'; }
    },
    openPrivate, closePrivate,
    async probe(url, verify, timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined, active = true, status = 0;
      let sid: string | undefined;
      let loaded!: () => void;
      const load = new Promise<void>(resolve => { loaded = resolve; });
      const observe = (m: Message) => {
        if (m.sessionId !== sid) return;
        const target = sessionTargets.get(sid ?? '');
        if (m.method === 'Network.responseReceived' && m.params?.type === 'Document'
          && m.params.frameId === mainFrames.get(target ?? '')) status = m.params.response.status;
        if (m.method === 'Page.loadEventFired') loaded();
      };
      listeners.add(observe);
      // Retain the opening promise even when the verifier deadline wins: cleanup must see its target.
      const opening = openPrivate('about:blank', true);
      const work = (async () => {
        const targetId = await opening;
        if (!active) return 'timeout' as const;
        const result = await send('Target.attachToTarget', { targetId, flatten: true }); sid = result.sessionId;
        sessionTargets.set(sid!, targetId);
        await send('Network.enable', {}, sid);
        await send('Page.enable', {}, sid);
        if (!active) return 'timeout' as const;
        await send('Page.navigate', { url }, sid);
        await load;
        if (!active) return 'timeout' as const;
        const info = await send('Target.getTargetInfo', { targetId });
        const ok = await verify({ url: info.targetInfo.url, status, async exists(selector) {
          if (!active) throw failure();
          const doc = await send('DOM.getDocument', {}, sid);
          if (!active) throw failure();
          const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, sid);
          return found.nodeId !== 0;
        } });
        return ok ? 'ok' as const : 'fail' as const;
      })();
      try {
        return await Promise.race([work, new Promise<'timeout'>(resolve => { timer = setTimeout(() => { active = false; loaded(); resolve('timeout'); }, Math.max(1, timeoutMs)); })]);
      } catch { return 'fail'; } finally {
        active = false; loaded(); clearTimeout(timer); listeners.delete(observe);
        const targetId = await opening;
        while ([...held].some(id => privateRoots.get(id) === targetId)) {
          await Promise.all([...held].filter(id => privateRoots.get(id) === targetId).map(id => {
            const gone = waitDestroyed(id);
            return Promise.all([send('Target.closeTarget', { targetId: id }), gone]);
          }));
        }
      }
    },
    attachViewer(o) {
      const requestedWidth = o.maxWidth ?? 1280;
      if (!Number.isFinite(requestedWidth) || requestedWidth < 1) throw failure();
      const maxWidth = Math.min(Math.floor(requestedWidth), 1280);
      const control = !!o.lease;
      if (poisoned || closed || control && (!fenced || !drained || !activePrivate || !matches(o.lease!) || controller)
        || !control && (fenced || !lastAgent)) throw failure();
      let seq = 0;
      const v: Viewer = { control, scaleX: 1, scaleY: 1, hasFrame: false, closed: false, frames: latest<LiveFrame>(), states: latest<NonNullable<PrivateState>>(), close() {
        if (v.closed) return;
        v.closed = true; viewers.delete(v); listeners.delete(frame); listeners.delete(change); v.frames.end(); v.states.end();
        if (controller === v) controller = undefined;
        if (v.sid && !closed && !poisoned) void send('Target.detachFromTarget', { sessionId: v.sid }).catch(() => {});
      } };
      if (control) controller = v;
      viewers.add(v);
      const allowed = () => !v.closed && !poisoned && (control ? controller === v && !!binding && matches(o.lease!) : !fenced);
      const target = () => control ? activePrivate : lastAgent;
      const frame = (m: Message) => {
        if (!allowed() || control && v.target !== activePrivate || m.sessionId !== v.sid || m.method !== 'Page.screencastFrame') return;
        // Frames are private memory only, ack even when the consumer is slow.
        void send('Page.screencastFrameAck', { sessionId: m.params!.sessionId }, v.sid).catch(() => v.close());
        const jpeg = new Uint8Array(Buffer.from(m.params!.data, 'base64'));
        const size = jpegSize(jpeg);
        if (!size || size.w > maxWidth || size.h > 960) return v.close();
        v.scaleX = m.params!.metadata.deviceWidth / size.w; v.scaleY = m.params!.metadata.deviceHeight / size.h; v.hasFrame = true;
        v.frames.push({ seq: ++seq, ...size, at: Date.now(), jpeg });
      };
      listeners.add(frame);
      const attach = async () => {
        const id = target();
        if (!allowed() || !id) return v.close();
        if (v.target === id && v.sid) return;
        if (v.sid) await send('Target.detachFromTarget', { sessionId: v.sid });
        const { sessionId } = await send('Target.attachToTarget', { targetId: id, flatten: true });
        if (!allowed()) { await send('Target.detachFromTarget', { sessionId }); return; }
        v.target = id; v.sid = sessionId; v.hasFrame = false; sessionTargets.set(sessionId, id);
        await send('Page.enable', {}, sessionId);
        await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth, maxHeight: 960 }, sessionId);
        const state = stateOf(id); if (control && state) v.states.push(state);
      };
      const ready = attach().catch(() => v.close());
      const change = (m: Message) => {
        if (control && ['Target.targetCreated', 'Target.targetDestroyed'].includes(m.method ?? '')) void ready.then(attach).catch(() => v.close());
      };
      listeners.add(change);
      const closeViewer = () => { listeners.delete(change); v.close(); };
      return { frames: v.frames, states: v.states, close: closeViewer, input(i) {
        if (!control || !allowed() || !v.hasFrame || v.target !== activePrivate || !v.target || !held.has(v.target) || stateOf(v.target)?.offOrigin || !v.sid) return;
        let method: string, params: Params;
        if (i.kind === 'text') { method = 'Input.insertText'; params = { text: i.text }; }
        else if (i.kind === 'key') { method = 'Input.dispatchKeyEvent'; params = { type: i.type === 'down' ? 'keyDown' : i.type === 'up' ? 'keyUp' : '', key: i.key, code: i.code, modifiers: i.modifiers }; }
        else if (i.kind === 'pointer') {
          method = 'Input.dispatchMouseEvent'; params = { type: ({ move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' } as const)[i.type],
            x: i.x * v.scaleX, y: i.y * v.scaleY, button: i.button, ...(i.type === 'down' || i.type === 'up' ? { clickCount: 1 } : {}),
            ...(i.type === 'wheel' ? { deltaX: i.dx ?? 0, deltaY: i.dy ?? 0 } : {}) };
        } else if (i.kind === 'nav') {
          if (i.action === 'reload') { method = 'Page.reload'; params = {}; }
          else {
            if (!['back', 'forward'].includes(i.action)) return;
            void send('Page.getNavigationHistory', {}, v.sid).then(history => {
              if (!allowed() || stateOf(v.target)?.offOrigin) return;
              const entry = history.entries[history.currentIndex + (i.action === 'back' ? -1 : 1)];
              if (entry) return send('Page.navigateToHistoryEntry', { entryId: entry.id }, v.sid);
            }).catch(() => v.close()); return;
          }
        } else return;
        if (!validControl(method, params)) return;
        void send(method, params, v.sid).catch(() => v.close());
      } };
    },
    async navigateAgent(url) {
      if (fenced || !lastAgent || held.size) throw failure();
      const { sessionId } = await send('Target.attachToTarget', { targetId: lastAgent, flatten: true });
      try { await send(url === 'reload' ? 'Page.reload' : 'Page.navigate', url === 'reload' ? {} : { url }, sessionId); }
      finally { await send('Target.detachFromTarget', { sessionId }); }
    },
    close,
  };
}
