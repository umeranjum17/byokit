// Host-side link adapter (7.1): typed, member-checked ops over @byokit/link, sealed approval push
// via the relay (7.3). Node only.
import { randomUUID } from 'node:crypto';
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
import { reach, type ServeIngress, type Via } from '@byokit/reach';
import type { PushAction, RelayClient } from '@byokit/relay';
import { ENGINE_VERSION } from './constants.ts';
import type { OpenClawKit } from './kit.ts';
import { b64urlDecode, sealNotice } from './notices.ts';
import { routeFor } from './routes.ts';
import { signedInProviders } from './runs.ts';
import type { Approval, Member, RunSpec, SignInView } from './types.ts';
import { stateWords, words } from './words.ts';

const VIEW_OPS = new Set(['oc.state', 'oc.routes', 'oc.signin.view', 'oc.sessions', 'oc.approvals', 'oc.events']);

// This kit's own version, read once from its package.json (beside src/ and dist/ alike).
const KIT_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const THINKING = new Set(['off', 'low', 'medium', 'high']);

const refused = () => new PublicLinkError(words('link.notAllowed'));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  const { message, model, system, images, thinking, tools } = args;
  const ok = typeof message === 'string'
    && (model === undefined || typeof model === 'string')
    && (system === undefined || typeof system === 'string')
    && (images === undefined || (Array.isArray(images) && images.every((i) =>
      isRecord(i) && typeof i.data === 'string' && typeof i.mimeType === 'string')))
    && (thinking === undefined || (typeof thinking === 'string' && THINKING.has(thinking)))
    && (tools === undefined || (Array.isArray(tools) && tools.every((t) => typeof t === 'string')));
  if (!ok) throw new Error('oc.run needs { message, sessionKey?, model?, system?, images?, thinking?, tools? }');
  return {
    message: message as string,
    ...(model === undefined ? {} : { model: model as string }),
    ...(system === undefined ? {} : { system: system as string }),
    ...(images === undefined ? {} : { images: (images as { data: string; mimeType: string }[])
      .map((i) => ({ data: i.data, mimeType: i.mimeType })) }),
    ...(thinking === undefined ? {} : { thinking: thinking as RunSpec['thinking'] }),
    ...(tools === undefined ? {} : { tools: [...(tools as string[])] }),
  };
}

type SignInDrive = { paste(text: string): void; cancel(): void };

export function openclawLink(
  kit: OpenClawKit,
  o: {
    memberOf: (grant: Grant) => Member | undefined; // which member a device acts for (e.g. grant.meta.member)
    passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
    relay?: RelayClient; // sealed approval push (7.3)
  },
): Pick<HostOptions, 'handle' | 'stream' | 'allow'> & { onAction(a: PushAction): Promise<unknown> } {
  const passThrough = o.passThrough ?? (() => false);
  // Grants that have called, so sealed pushes and push actions can check the member (7.3).
  const seen = new Map<string, Grant>();
  // Devices that registered a box key, by grant id.
  const boxes = new Map<string, Uint8Array>();
  // One sign-in drive per member+provider, plus the latest view even after it ends.
  const drives = new Map<string, SignInDrive>();
  const latest = new Map<string, SignInView>();

  const memberOf = (grant: Grant): Member => {
    seen.set(grant.id, grant);
    const member = o.memberOf(grant);
    if (member === undefined) throw refused();
    return member;
  };

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

  const signIns = async (member: Member): Promise<string[] | undefined> => {
    try {
      const { agentId } = await kit.ensureMember(member);
      const status = await (kit.call as (method: string, params: unknown, o: { timeoutMs: number }) => Promise<unknown>)(
        'models.authStatus', { agentId }, { timeoutMs: 5_000 });
      return signedInProviders(status);
    } catch {
      return undefined;
    }
  };

  const handle = async (req: LinkRequest, grant: Grant): Promise<unknown> => {
    const member = memberOf(grant);
    if (grant.role === 'view' && !VIEW_OPS.has(req.op)) throw refused();
    const args = isRecord(req.args) ? req.args : {};
    switch (req.op) {
      case 'oc.state': {
        // signedIn: the providers the device member is usably signed in to (an expired or unfinished sign-in is not),
        // only while the engine can say: absent is unknown, never "none".
        const signedIn = kit.state.phase === 'ready' ? await signIns(member) : undefined;
        return { state: kit.state, words: stateWords(kit.state), version: KIT_VERSION, engine: ENGINE_VERSION,
          ...(signedIn ? { signedIn } : {}) };
      }
      case 'oc.routes':
        return kit.routes().filter((route) => route.offer);
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
        if (typeof args.sessionKey !== 'string' || typeof args.text !== 'string')
          throw new Error('oc.steer needs { sessionKey, text }');
        if (!memberKey(member, args.sessionKey)) throw refused();
        await kit.steer(args.sessionKey, args.text);
        return null;
      }
      case 'oc.abort': {
        if (typeof args.sessionKey !== 'string') throw new Error('oc.abort needs { sessionKey }');
        if (!memberKey(member, args.sessionKey)) throw refused();
        await kit.abort(args.sessionKey);
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
        if (!passThrough(args.method, grant)) throw refused();
        return await (kit.call as (method: string, params: unknown) => Promise<unknown>)(args.method, args.params);
      }
      default:
        throw refused();
    }
  };

  const stream = async (s: LinkStream, req: LinkRequest, grant: Grant): Promise<void> => {
    const member = memberOf(grant);
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

  return { handle, stream, allow: () => true, onAction };
}

// ponytail: this ~40-line serve() wiring is deliberately duplicated per runtime kit (D3);
// extract it into a shared package when a third runtime kit appears.
export async function serve(o: {
  host: Host;
  port: number;
  via?: Via;
  previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void;
}): Promise<{ urls: string[]; ingress?: ServeIngress; close(): Promise<void> }> {
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
