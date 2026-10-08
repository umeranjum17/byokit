// Host-side link adapter (7.1): typed, member-checked ops over @byokit/link, sealed approval push
// via the relay (7.3). Node only.
import { randomUUID } from 'node:crypto';
import { sealBox } from '@byokit/seal';
import type { BrowserHost, LiveInput, LiveSource, TakeoverLease } from './browser.ts';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  PublicLinkError,
  type Grant,
  type Host,
  type HostOptions,
  type LinkRequest,
  type LinkStream,
} from '@byokit/link';
import { reach, type ServeIngress, type Via } from '@byokit/discover';
import type { PushAction, RelayClient } from '@byokit/relay';
import { ENGINE_VERSION } from './constants.ts';
import type { OpenClawKit } from './kit.ts';
import { b64urlDecode, b64urlEncode, sealNotice } from './notices.ts';
import { routeFor } from './routes.ts';
import { outputSchema } from './output.ts';
import type { Approval, Member, RunSpec, SignInView } from './types.ts';
import { stateWords, words } from './words.ts';

const VIEW_OPS = new Set(['oc.state', 'oc.routes', 'oc.signin.view', 'oc.sessions', 'oc.approvals', 'oc.events',
  'oc.browser.state', 'oc.browser.signins', 'oc.browser.thumb']);

// This kit's own version, read once from its package.json (beside src/ and dist/ alike).
const KIT_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const THINKING = new Set(['off', 'low', 'medium', 'high']);

const refused = () => new PublicLinkError(words('link.notAllowed'));
const BROWSER_REFUSALS = new Set(['stale', 'not-found', 'held-by-other', 'lease-expired', 'not-control',
  'not-lease-holder', 'confirm-site', 'already-open', 'insecure-remote', 'unsupported']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const browserTag = (event: string): boolean => event === 'byokit.browser';
const browserEvent = (event: string, payload: unknown): payload is { member: Member; kind: 'state' | 'signin' } =>
  event === 'byokit.browser' && isRecord(payload) && typeof payload.member === 'string'
    && (payload.kind === 'state' || payload.kind === 'signin');

const memberKey = (member: Member, sessionKey: string): boolean =>
  sessionKey.startsWith(`agent:${member}:`);

function memberSessions(result: unknown, member: Member): Record<string, unknown>[] {
  const rows = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.sessions) ? result.sessions : [];
  return (rows as unknown[]).filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) && typeof row.sessionKey === 'string' && memberKey(member, row.sessionKey),
  );
}

/** `oc.run`'s run options, type-checked; the kit's own checks (account, tool names) still apply. */
function runOptions(args: Record<string, unknown>): Omit<RunSpec, 'member' | 'sessionKey' | 'register' | 'meta'> {
  const { message, model, auth, system, images, thinking, tools, schema } = args;
  const ok = typeof message === 'string'
    && (model === undefined || typeof model === 'string')
    && (auth === undefined || auth === 'apiKey')
    && (system === undefined || typeof system === 'string')
    && (images === undefined || (Array.isArray(images) && images.every((i) =>
      isRecord(i) && typeof i.data === 'string' && typeof i.mimeType === 'string')))
    && (thinking === undefined || (typeof thinking === 'string' && THINKING.has(thinking)))
    && (tools === undefined || (Array.isArray(tools) && tools.every((t) => typeof t === 'string')));
  if (!ok) throw new Error('oc.run needs { message, sessionKey?, model?, auth?, system?, images?, thinking?, tools?, schema? }');
  if (schema !== undefined) outputSchema(schema);
  return {
    message: message as string,
    ...(schema === undefined ? {} : { schema: schema as RunSpec['schema'] }),
    ...(model === undefined ? {} : { model: model as string }),
    ...(auth === undefined ? {} : { auth: 'apiKey' as const }),
    ...(system === undefined ? {} : { system: system as string }),
    ...(images === undefined ? {} : { images: (images as { data: string; mimeType: string }[])
      .map((i) => ({ data: i.data, mimeType: i.mimeType })) }),
    ...(thinking === undefined ? {} : { thinking: thinking as RunSpec['thinking'] }),
    ...(tools === undefined ? {} : { tools: [...(tools as string[])] }),
  };
}

function browserInput(value: unknown): value is LiveInput {
  if (!isRecord(value)) return false;
  const finite = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]);
  if (value.kind === 'text') return typeof value.text === 'string' && value.text.length <= 16384;
  if (value.kind === 'nav') return ['back', 'forward', 'reload'].includes(value.action as string);
  if (value.kind === 'key') return ['down', 'up'].includes(value.type as string)
    && typeof value.key === 'string' && value.key.length <= 128
    && (value.code === undefined || (typeof value.code === 'string' && value.code.length <= 128))
    && (value.modifiers === undefined || (Number.isInteger(value.modifiers) && (value.modifiers as number) >= 0 && (value.modifiers as number) <= 15));
  return value.kind === 'pointer' && ['move', 'down', 'up', 'wheel'].includes(value.type as string)
    && finite('x') && finite('y') && (value.button === undefined || ['left', 'right', 'middle'].includes(value.button as string))
    && (value.dx === undefined || finite('dx')) && (value.dy === undefined || finite('dy'));
}

type SignInDrive = { paste(text: string): void; cancel(): void };

/** `openclawLink`'s options: which member a grant acts for, the D8 pass-through predicate, sealed relay push. */
export type OpenClawLinkOptions = {
  memberOf: (grant: Grant) => Member | undefined; // which member a device acts for (e.g. grant.meta.member)
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: Pick<RelayClient, 'notify'>; // sealed approval push (7.3)
};

/** What `openclawLink` hands the link host: its request/stream handlers plus the kit's push entry point. */
export type OpenClawLinkHost =
  Pick<HostOptions, 'handle' | 'stream' | 'allow' | 'onGrantRemoved'> & { onAction(a: PushAction): Promise<unknown> };

export function openclawLink(
  kit: OpenClawKit & { browser?: BrowserHost },
  o: OpenClawLinkOptions,
): OpenClawLinkHost {
  const passThrough = o.passThrough ?? (() => false);
  // The host lifecycle extension is supplied by the browser host. Without it control fails closed.
  const browser = (): BrowserHost => {
    if (!kit.browser) throw refused();
    return kit.browser;
  };
  const leases = new Map<string, { grant: string; lease: TakeoverLease }>();
  const memberSource = (value: unknown, member: Member): LiveSource => {
    if (!isRecord(value) || value.member !== member) throw refused();
    if (value.kind === 'browser') return { kind: 'browser', member };
    if (value.kind === 'desktop' && ['host', 'node', 'environment'].includes(value.source as string))
      return { kind: 'desktop', member, source: value.source as 'host' | 'node' | 'environment' };
    throw refused();
  };
  const control = (): void => {
    if (typeof (kit.browser as BrowserHost & { revokeGrant?: unknown } | undefined)?.revokeGrant !== 'function') throw refused();
  };
  const ownedLease = (value: unknown, member: Member, grant: Grant): TakeoverLease => {
    control();
    if (!isRecord(value) || typeof value.requestId !== 'string') throw refused();
    const held = leases.get(value.requestId);
    if (!held || held.grant !== grant.id || held.lease.nonce !== value.nonce || held.lease.epoch !== value.epoch
      || held.lease.gen !== value.gen || !browser().signIns(member).some(r => r.id === value.requestId)) throw refused();
    return held.lease;
  };
  // Grants that have called, so sealed pushes and push actions can check the member (7.3).
  const seen = new Map<string, Grant>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  // Devices that registered a box key, by grant id.
  const boxes = new Map<string, Uint8Array>();
  // One sign-in drive per member+provider, plus the latest view even after it ends.
  const drives = new Map<string, SignInDrive>();
  const latest = new Map<string, SignInView>();

  const memberOf = (grant: Grant): Member => {
    if (revoked.has(grant.id) || (grant.expires !== undefined && grant.expires <= Date.now())) throw refused();
    seen.set(grant.id, grant);
    clearTimeout(expiry.get(grant.id));
    if (grant.expires !== undefined) {
      const timer = setTimeout(() => {
        const current = seen.get(grant.id);
        if (current?.expires !== undefined && current.expires > Date.now()) memberOf(current);
        else void revoke(grant.id).catch(() => {});
      }, Math.min(grant.expires - Date.now(), 2 ** 31 - 1));
      timer.unref(); expiry.set(grant.id, timer);
    }
    const member = o.memberOf(grant);
    if (member === undefined) throw refused();
    return member;
  };

  const viewers = new Map<string, Set<() => void>>();
  const revoked = new Set<string>();
  const revocations = new Map<string, Promise<void>>();
  const revoke = (grant: string): Promise<void> => {
    const pending = revocations.get(grant);
    if (pending) return pending;
    revoked.add(grant);
    clearTimeout(expiry.get(grant)); expiry.delete(grant);
    for (const [id, held] of leases) if (held.grant === grant) leases.delete(id);
    for (const close of viewers.get(grant) ?? []) close();
    viewers.delete(grant);
    boxes.delete(grant);
    seen.delete(grant);
    let cleanup: Promise<void>;
    try {
      cleanup = (kit.browser as BrowserHost & { revokeGrant?: (grant: string) => Promise<void> } | undefined)?.revokeGrant?.(grant) ?? Promise.resolve();
    } catch { cleanup = Promise.reject(refused()); }
    const result = cleanup.catch(() => { throw refused(); });
    revocations.set(grant, result);
    return result;
  };

  const pushSignIn = async (member: Member): Promise<void> => {
    if (!o.relay || !kit.browser) return;
    for (const request of kit.browser.signIns(member)) {
      if (request.state !== 'waiting') continue;
      for (const [id, box] of boxes) {
        const grant = seen.get(id);
        if (!grant || o.memberOf(grant) !== member || (grant.expires !== undefined && grant.expires <= Date.now())) continue;
        const plain = new TextEncoder().encode(JSON.stringify({ source: 'signin', id: request.id, gen: request.gen, member, site: request.site }));
        try {
          await o.relay.notify({ id: request.id, title: words('browser.signin.notice'), to: [id],
            data: { v: 1, sealed: b64urlEncode(sealBox(plain, box)) } }, { includeContent: true });
        } finally { plain.fill(0); }
      }
    }
  };
  if (o.relay) kit.onEvent('*', (payload, event) => {
    const p = isRecord(payload) ? payload : {};
    if (browserEvent(event, p) && p.kind === 'signin')
      void pushSignIn(p.member).catch(() => {});
  });

  const pushApproval = async (approval: Approval): Promise<void> => {
    if (!o.relay) return;
    const jobs: Promise<unknown>[] = [];
    for (const [id, box] of boxes) {
      const grant = seen.get(id);
      if (!grant || o.memberOf(grant) !== approval.member) continue;
      jobs.push(
        o.relay.notify(
          { id: approval.id, title: words('approval.notice'), data: sealNotice(approval, box),
            to: [id], actions: ['allow', 'deny'], urgency: 'high' },
          { includeContent: true },
        ),
      );
    }
    for (const [id, grant] of seen) {
      if (boxes.has(id) || o.memberOf(grant) !== approval.member) continue;
      jobs.push(
        o.relay.notify(
          { id: approval.id, title: words('approval.notice'), to: [id], actions: ['allow', 'deny'], urgency: 'high' },
          { includeContent: false },
        ),
      );
    }
    await Promise.all(jobs);
  };
  const offPush = o.relay ? kit.onApproval((a, change) => {
    if (change !== 'added') return;
    void pushApproval(a).catch(() => {});
  }) : undefined;
  void offPush;

  const onAction = async (a: PushAction): Promise<unknown> => {
    const grant = seen.get(a.device);
    const member = grant ? o.memberOf(grant) : undefined;
    if (member === undefined || grant?.role === 'view') throw refused();
    if (a.action !== 'allow' && a.action !== 'deny') throw refused();
    if (!kit.approvals(member).some((approval) => approval.id === a.event)) throw refused();
    await kit.decide(a.event, { allow: a.action === 'allow' });
    return null;
  };

  const endReason = (error: unknown): string =>
    error instanceof PublicLinkError ? error.message.slice(0, 200) : 'failed';

  const handle = async (req: LinkRequest, grant: Grant): Promise<unknown> => {
    const member = memberOf(grant);
    if (grant.role === 'view' && !VIEW_OPS.has(req.op)) throw refused();
    const args = isRecord(req.args) ? req.args : {};
    if (req.op.startsWith('oc.browser.')) {
      // Keyed answers may be persisted by @byokit/link. Lease nonces and JPEGs are transient only.
      if (req.key !== undefined) throw refused();
      const host = browser();
      const action = req.op.slice('oc.browser.'.length);
      if (action === 'state') {
        if (args.member !== member) throw refused();
        return host.state(member);
      }
      if (action === 'signins') return host.signIns(member);
      if (action === 'thumb') {
        const source = memberSource(args.source, member);
        if (source.kind === 'desktop') return { state: 'unsupported' };
        const result = await host.thumbnail(source, { grant: grant.id });
        return result.state === 'ok' ? { state: 'ok', frame: { ...result.frame, jpeg: b64urlEncode(result.frame.jpeg) } } : result;
      }
      control();
      if (action === 'done' || action === 'confirmorigin') {
        const lease = ownedLease(args.lease, member, grant);
        if (action === 'done') return host.done(lease);
        if (typeof args.origin !== 'string') throw refused();
        host.confirmOrigin(lease, args.origin);
        return null;
      }
      if (action === 'forget') {
        if (args.member !== member || typeof args.site !== 'string') throw refused();
        await host.forget(member, args.site, { grant: grant.id });
        return null;
      }
      if (typeof args.id !== 'string' || !Number.isSafeInteger(args.gen) || (args.gen as number) < 1) throw refused();
      const request = host.signIns(member).find(r => r.id === args.id);
      if (!request) throw refused();
      if (request.state === 'held' && leases.get(request.id)?.grant !== grant.id) throw refused();
      const by = { grant: grant.id };
      if (action === 'takeover') {
        if (args.confirmSite !== undefined && typeof args.confirmSite !== 'string') throw refused();
        const lease = await host.takeover(args.id, args.gen as number, { ...by,
          ...(typeof args.confirmSite === 'string' ? { confirmSite: args.confirmSite } : {}) });
        memberOf(grant); // revocation during the asynchronous takeover must not publish a new lease
        leases.set(args.id, { grant: grant.id, lease });
        return lease;
      }
      if (action === 'notnow') return host.notNow(args.id, args.gen as number, by);
      if (action === 'reopen') return host.reopen(args.id, args.gen as number, by);
      if (action === 'retry') return host.retry(args.id, args.gen as number, by);
      if (action === 'cancel') return host.cancel(args.id, args.gen as number, by);
      throw refused();
    }
    switch (req.op) {
      case 'oc.state': {
        // signedIn: the providers the device member is usably signed in to (an expired or unfinished sign-in is not),
        // only while the engine can say: absent is unknown, never "none".
        const signedIn = kit.state.phase === 'ready' ? await kit.providerStatus(member).catch(() => undefined) : undefined;
        return { state: kit.state, words: stateWords(kit.state), version: KIT_VERSION, engine: ENGINE_VERSION,
          ...(signedIn ? { signedIn } : {}) };
      }
      case 'oc.routes':
        return kit.routes(); // Discovery is not authorization or default eligibility.
      case 'oc.signin.start': {
        if (typeof args.provider !== 'string' || (args.via !== 'browser' && args.via !== 'code'))
          throw new Error('oc.signin.start needs { provider, via: browser|code }');
        const route = routeFor(args.provider, args.via);
        if (!route) throw refused();
        const key = `${member}:${args.provider}`;
        drives.get(key)?.cancel();
        const view: SignInView = { state: 'waiting', via: args.via };
        latest.set(key, view);
        const drive = kit.signIn(member, { authChoice: route.choice, via: args.via }, (next) => {
          latest.set(key, next);
        });
        drives.set(key, drive);
        void drive.done.then(
          (done) => { latest.set(key, done); if (drives.get(key) === drive) drives.delete(key); },
          () => { if (drives.get(key) === drive) drives.delete(key); },
        );
        return latest.get(key);
      }
      case 'oc.signin.view': {
        if (typeof args.provider !== 'string') throw new Error('oc.signin.view needs { provider }');
        // `ready` is the member's account (signed in to this provider), not the engine: `phaseOf` reads it as done.
        const key = `${member}:${args.provider}`;
        const ready = kit.state.phase === 'ready' && await kit.signedIn(member, args.provider);
        // A finished sign-in whose account is gone since (signed out anywhere, or dropped by the engine) is no
        // sign-in to show: without this the view says done while `ready` says no, which phaseOf reads as opening.
        if (!ready && !drives.has(key) && latest.get(key)?.state === 'done') latest.delete(key);
        return { ready, view: latest.get(key) ?? null };
      }
      case 'oc.signin.paste': {
        if (typeof args.provider !== 'string' || typeof args.text !== 'string')
          throw new Error('oc.signin.paste needs { provider, text }');
        drives.get(`${member}:${args.provider}`)?.paste(args.text);
        return null;
      }
      case 'oc.signin.cancel': {
        if (typeof args.provider !== 'string') throw new Error('oc.signin.cancel needs { provider }');
        drives.get(`${member}:${args.provider}`)?.cancel();
        return null;
      }
      case 'oc.signout': {
        if (typeof args.provider !== 'string') throw new Error('oc.signout needs { provider }');
        await kit.signOut(member, args.provider);
        return null;
      }
      case 'oc.sessions': {
        const result = await (kit.call as (method: string, params: unknown) => Promise<unknown>)('sessions.list', {});
        return memberSessions(result, member);
      }
      case 'oc.steer': {
        if (typeof args.sessionKey !== 'string' || typeof args.text !== 'string' || (args.auth !== undefined && args.auth !== 'apiKey'))
          throw new Error('oc.steer needs { sessionKey, text }');
        if (!memberKey(member, args.sessionKey)) throw refused();
        await kit.steer(args.sessionKey, args.text, args.auth === 'apiKey' ? { auth: 'apiKey' } : undefined);
        return null;
      }
      case 'oc.abort': {
        if (typeof args.sessionKey !== 'string' || (args.auth !== undefined && args.auth !== 'apiKey')) throw new Error('oc.abort needs { sessionKey }');
        if (!memberKey(member, args.sessionKey)) throw refused();
        await kit.abort(args.sessionKey, args.auth === 'apiKey' ? { auth: 'apiKey' } : undefined);
        return null;
      }
      case 'oc.approvals':
        return kit.approvals(member);
      case 'oc.decide': {
        if (typeof args.id !== 'string' || typeof args.allow !== 'boolean')
          throw new Error('oc.decide needs { id, allow }');
        if (!kit.approvals(member).some((approval) => approval.id === args.id)) throw refused();
        await kit.decide(args.id, {
          allow: args.allow,
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
          ...('answer' in args ? { answer: args.answer } : {}),
        });
        return null;
      }
      case 'oc.notices.register': {
        // Per-device box key for sealed pushes. Kept in this adapter (not grant meta: the HostOptions
        // shape gives handle no host for setMeta, and the key is session state devices re-register).
        if (typeof args.boxPublicKey !== 'string') throw new Error('oc.notices.register needs { boxPublicKey }');
        const box = b64urlDecode(args.boxPublicKey);
        if (!box || box.length !== 32) throw new Error('oc.notices.register needs a 32-byte b64url boxPublicKey');
        boxes.set(grant.id, box);
        return null;
      }
      case 'oc.call': {
        if (typeof args.method !== 'string') throw new Error('oc.call needs { method, params }');
        if (kit.browser && (args.method === 'browser.request' || args.method.startsWith('terminal.') || args.method === 'tools.invoke')) throw refused();
        if (args.method === 'byokit.usage.engineStarted') {
          if (!isRecord(args.params) || args.params.agentId !== member) throw refused();
          return await kit.callDynamic(args.method, args.params);
        }
        if (!passThrough(args.method, grant)) throw refused();
        return await (kit.call as (method: string, params: unknown) => Promise<unknown>)(args.method, args.params);
      }
      default:
        throw refused();
    }
  };

  const stream = async (s: LinkStream, req: LinkRequest, grant: Grant): Promise<void> => {
    const member = memberOf(grant);
    if (req.op.startsWith('oc.browser.') && req.op !== 'oc.browser.live') {
      try {
        const value = await handle({ op: req.op, args: req.args }, grant);
        await s.write(`${JSON.stringify({ value })}\n`);
        s.end();
      } catch (error) {
        const why = error instanceof Error && 'why' in error ? error.why : undefined;
        if (typeof why === 'string' && BROWSER_REFUSALS.has(why)) {
          await s.write(`${JSON.stringify({ refused: why })}\n`).catch(() => {});
          s.end();
        } else s.end(words('link.notAllowed'));
      }
      return;
    }
    if (req.op === 'oc.browser.live') {
      const args = isRecord(req.args) ? req.args : {};
      const source = memberSource(args.source, member);
      if (args.mode !== 'observe' && args.mode !== 'control') throw refused();
      if (source.kind === 'desktop') {
        if (args.mode !== 'observe' || args.lease !== undefined) throw refused();
        await s.write(`${JSON.stringify({ state: { source, mode: 'observe', phase: 'failed', why: 'unsupported' } })}\n`);
        s.end(); return;
      }
      const lease = args.mode === 'control' ? (grant.role === 'control' ? ownedLease(args.lease, member, grant) : undefined) : undefined;
      if (args.mode === 'control' && !lease) throw refused();
      if (args.mode === 'observe' && args.lease !== undefined) throw refused();
      if (args.maxWidth !== undefined && (!Number.isSafeInteger(args.maxWidth) || (args.maxWidth as number) < 1 || (args.maxWidth as number) > 4096)) throw refused();
      let ended = false;
      let busy = false;
      let acceptingFrames = false;
      let nextState: unknown;
      let nextFrame: unknown;
      let viewer: ReturnType<BrowserHost['live']> | undefined;
      // One in-flight write + latest state/frame: slow viewers cannot grow a JPEG queue.
      const flush = async (): Promise<void> => {
        if (busy || ended) return;
        busy = true;
        try {
          while (!ended && (nextState !== undefined || nextFrame !== undefined)) {
            const value = nextState ?? nextFrame;
            if (nextState !== undefined) nextState = undefined; else nextFrame = undefined;
            await s.write(`${JSON.stringify(value)}\n`);
            if (isRecord(value) && isRecord(value.state) && ['ended', 'failed'].includes(value.state.phase as string)) {
              close(); s.end();
            }
          }
        } catch { close(); } finally { busy = false; }
      };
      const close = (): void => {
        if (ended) return;
        ended = true;
        nextState = nextFrame = undefined;
        viewer?.close();
      };
      const revokeViewer = (): void => { close(); s.end(words('link.notAllowed')); };
      const active = viewers.get(grant.id) ?? new Set<() => void>();
      active.add(revokeViewer); viewers.set(grant.id, active);
      s.onEnd = () => { close(); active.delete(revokeViewer); };
      let text = '';
      const decoder = new TextDecoder();
      s.onData = (chunk) => {
        if (ended) return;
        try {
          if (!lease || grant.role !== 'control' || (grant.expires !== undefined && grant.expires <= Date.now())) throw refused();
          text += decoder.decode(chunk, { stream: true });
          if (text.length > 65536) throw refused();
          let at: number;
          while ((at = text.indexOf('\n')) >= 0) {
            const input: unknown = JSON.parse(text.slice(0, at));
            text = text.slice(at + 1);
            if (!browserInput(input)) throw refused();
            ownedLease(lease, member, grant);
            viewer?.input(input);
          }
        } catch { close(); s.end(words('link.notAllowed')); }
      };
      try {
        viewer = browser().live(source, { grant: grant.id, ...(lease ? { lease } : {}),
          ...(typeof args.maxWidth === 'number' ? { maxWidth: args.maxWidth } : {}) }, {
          state: state => { if (!ended) { acceptingFrames = state.phase === 'live'; nextState = { state }; nextFrame = undefined; void flush(); } },
          frame: frame => { if (!ended && acceptingFrames) { nextFrame = { frame: { ...frame, jpeg: b64urlEncode(frame.jpeg) } }; void flush(); } },
        });
        if (ended) viewer.close();
      } catch { close(); s.end(words('link.notAllowed')); }
      return;
    }
    if (req.op === 'oc.run') {
      if (grant.role === 'view') throw refused();
      const args = isRecord(req.args) ? req.args : {};
      const options = runOptions(args);
      const sessionKey = args.sessionKey === undefined ? `agent:${member}:link:${randomUUID()}` : args.sessionKey;
      if (typeof sessionKey !== 'string' || !memberKey(member, sessionKey)) throw refused();
      // A tool the kit does not register is not this device's to name.
      const known = new Set(kit.toolNames());
      if (options.tools?.some((tool) => !known.has(tool))) throw refused();
      // Ordered frames over the paced stream: each write waits for the last.
      let tail = Promise.resolve();
      const send = (frame: unknown): void => {
        tail = tail.then(() => s.write(`${JSON.stringify(frame)}\n`)).catch(() => {});
      };
      try {
        const end = await kit.run({ member, sessionKey, ...options }, (e) => send(e));
        send({ type: 'end', end });
        await tail;
        s.end();
      } catch (error) {
        await tail;
        s.end(endReason(error));
      }
      return;
    }
    if (req.op === 'oc.events') {
      const offEvent = kit.onEvent('*', (payload, event) => {
        const record = payload as Record<string, unknown> | undefined;
        if (browserTag(event)) {
          if (browserEvent(event, record) && record.member === member)
            void s.write(`${JSON.stringify({ event: 'byokit.browser', payload: { member, kind: record.kind } })}\n`).catch(() => {});
          return;
        }
        const agent = record?.agentId;
        const key = record?.sessionKey;
        if (agent !== member && !(typeof key === 'string' && memberKey(member, key))) return;
        void s.write(`${JSON.stringify({ event, payload })}\n`).catch(() => {});
      });
      const offApproval = kit.onApproval((approval, change) => {
        if (approval.member !== member) return;
        void s.write(`${JSON.stringify({ event: 'approval', change, approval })}\n`).catch(() => {});
      });
      s.onEnd = () => { offEvent(); offApproval(); };
      return;
    }
    throw refused();
  };

  return { handle, stream, allow: () => true, onAction, onGrantRemoved: grant => revoke(grant.id) };
}

// ponytail: this ~40-line serve() wiring is deliberately duplicated per runtime kit (D3);
// extract it into a shared package when a third runtime kit appears.
/** `serve`'s options: the link host to accept on, and the ingress to publish or replace. */
export type OpenClawServeOptions = {
  host: Host;
  port: number;
  via?: Via;
  previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void;
};
/** The running ingress: its urls, the entry that reaches the engine, and an orderly close. */
export type OpenClawServeHandle = { urls: string[]; ingress?: ServeIngress; close(): Promise<void> };
export async function serve(o: OpenClawServeOptions): Promise<OpenClawServeHandle> {
  const r = await reach({ port: o.port, via: o.via, previous: o.previous });
  const server = createServer(
    o.http ??
      ((_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, r.bind, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const wss = new WebSocketServer({ server });
  const sockets = new Set<WsSocket>();
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
    });
    o.host.accept(ws, { peer: req.socket.remoteAddress });
  });
  return {
    urls: r.urls,
    ...(r.ingress ? { ingress: r.ingress } : {}),
    close: async (): Promise<void> => {
      // Ends device sockets first: the http close below waits for connections.
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
