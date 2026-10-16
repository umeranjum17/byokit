// Host-side link adapter: the hd.* ops over @byokit/pair, and the serve() wiring (duplicated per kit by design,
// D3) — built in H7 (docs/runtime-kits.md 7.1-7.3).
//
// Permission shape: `allow` lets every request through and `handle`/`stream` refuse with the `link.notAllowed`
// words sentence, so a refused device hears the kit's sentence (a bare `allow: false` would surface link's own
// generic `view-only`/`not-allowed` words instead).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type {
  Grant, Host, HostOptions, LinkRequest, LinkStream, Socket,
} from '@byokit/pair';
import type { ServeIngress, Via } from '@byokit/discover';
import type { RelayClient } from '@byokit/relay';
import type { HerdrKit } from './kit.ts';
import type {
  AgentStatus, BlockedAgent, HerdrEvent, HerdrLayout, HerdrSnapshot, HerdrSubscription, HerdrTarget,
} from './types.ts';
import { stateWords, words } from './words.ts';
import { decodeB64Url, sealNotice } from './notices.ts';

// The link peers are optional (package.json peerDependenciesMeta): a cli-only kit never installs
// them, and they load only on this path. A missing peer names itself and the one command that adds
// it — never a bare module-not-found from deep inside the import.
const missingPeer = (id: string, cause: unknown): Error =>
  new Error(`herdr: @byokit/herdr/link needs the optional peer ${id} for this entry — add it to the app: npm install ${id}`, { cause });

// `PublicLinkError` stays @byokit/pair's own class: the pair host `instanceof`-checks refusals so the
// device hears this kit's sentence instead of a bare `failed`.
type PairModule = typeof import('@byokit/pair');
let PublicLinkError: PairModule['PublicLinkError'];
type PublicLinkErrorInstance = InstanceType<PairModule['PublicLinkError']>;
try {
  ({ PublicLinkError } = await import('@byokit/pair'));
} catch (e) {
  throw missingPeer('@byokit/pair', e);
}

export type HerdrScope = { workspaces: 'all' | string[] };

// Ops a view-role grant may open; every other op needs the control role (7.1, *view* marks).
const VIEW_OPS = new Set(['hd.state', 'hd.tree', 'hd.kinds', 'hd.read', 'hd.blocked', 'hd.events', 'hd.subscribe']);

const deny = (): never => {
  throw new PublicLinkError(words('link.notAllowed'));
};

// A refused widening close is the kit's plain sentence for the device, not a bare failure (6.4, 6.9).
const WIDEN_CODES = new Set(['pane-close-would-widen', 'tab-close-would-widen', 'workspace-close-would-widen']);
const widenError = (e: unknown): PublicLinkErrorInstance | undefined =>
  WIDEN_CODES.has((e as { code?: string } | undefined)?.code ?? '') ? new PublicLinkError(words('close.wouldWiden')) : undefined;

type PaneWhere = { workspaceId: string; tabId: string };

const findPane = (snap: HerdrSnapshot, paneId: string): PaneWhere | undefined => {
  for (const w of snap.workspaces) {
    for (const t of w.tabs) {
      if (t.panes.some((p) => p.id === paneId)) return { workspaceId: w.id, tabId: t.id };
    }
  }
  return undefined;
};

const inScope = (scope: HerdrScope, workspaceId: string): boolean =>
  scope.workspaces === 'all' || scope.workspaces.includes(workspaceId);

const filterSnapshot = (snap: HerdrSnapshot, scope: HerdrScope): HerdrSnapshot => {
  if (scope.workspaces === 'all') return snap;
  return { ...snap, workspaces: snap.workspaces.filter((w) => scope.workspaces.includes(w.id)) };
};

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((e) => typeof e === 'string') ? v as string[] : undefined;
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const STATUSES = new Set<string>(['idle', 'working', 'blocked', 'done', 'unknown']);

/**
 * Every workspace an event names (7.1 `hd.subscribe`): any `*workspace_id` field or `workspace_ids` entry at any
 * depth; when it names none, the workspace holding its `pane_id` (e.g. a status event that omits one).
 */
const eventWorkspaces = (e: HerdrEvent, snap: HerdrSnapshot): Set<string> => {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (typeof v !== 'object' || v === null) return;
    for (const [key, value] of Object.entries(v)) {
      if (key.endsWith('workspace_id') && typeof value === 'string') found.add(value);
      else if (key === 'workspace_ids' && Array.isArray(value)) {
        for (const id of value) if (typeof id === 'string') found.add(id);
      } else walk(value);
    }
  };
  walk(e);
  if (found.size === 0 && typeof e.pane_id === 'string') {
    const where = findPane(snap, e.pane_id);
    if (where) found.add(where.workspaceId);
  }
  return found;
};

/** The one pane, tab or workspace a link op names, refused unless it is known and in scope. */
const scopedTarget = (op: string, args: Record<string, unknown>, scope: HerdrScope, snap: HerdrSnapshot): HerdrTarget => {
  const target = { pane: asString(args.pane), tab: asString(args.tab), workspace: asString(args.workspace) };
  if (Object.values(target).filter((v) => v !== undefined).length !== 1) {
    throw new Error(`herdr: ${op} picks exactly one of pane, tab or workspace`);
  }
  const owner = target.pane !== undefined ? findPane(snap, target.pane)?.workspaceId
    : target.tab !== undefined ? snap.workspaces.find((w) => w.tabs.some((t) => t.id === target.tab))?.id
      : snap.workspaces.find((w) => w.id === target.workspace)?.id;
  if (owner === undefined || !inScope(scope, owner)) deny();
  return target;
};

export function herdrLink(kit: HerdrKit, o: {
  scopeOf: (grant: Grant) => HerdrScope;
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: Pick<RelayClient, 'notify'>;                     // sealed approval push (7.3)
}): Pick<HostOptions, 'handle' | 'stream' | 'allow'> {
  if (!kit || typeof o?.scopeOf !== 'function') throw new Error('herdr: herdrLink needs a kit and scopeOf');
  const passThrough = o.passThrough ?? (() => false);
  const boxes = new Map<string, Uint8Array>();   // grant id → registered notice box key
  // The latest grant object per id, refreshed on every request so scopeOf sees current meta.
  const currentGrants = new Map<string, Grant>();
  const scopeOfSafe = (grant: Grant): HerdrScope => {
    const scope = o.scopeOf(grant);
    if (scope && (scope.workspaces === 'all' || Array.isArray(scope.workspaces))) return scope;
    return { workspaces: [] };
  };

  if (o.relay) {
    const relay = o.relay;
    // Herdr pushes carry no actions (7.3): the notice is the question, the answer rides hd.answer.
    // The relay reads only the generic title; the sealed body opens with the device's own seed.
    // (Herdr words have no approval.notice key — the title is the blocked sentence.)
    kit.onBlocked((b: BlockedAgent, change: 'added' | 'resolved') => {
      if (change !== 'added') return;
      for (const [id, box] of boxes) {
        const grant = currentGrants.get(id);
        if (!grant || !inScope(scopeOfSafe(grant), b.workspaceId)) continue;
        const data = sealNotice(b, box);
        void relay.notify({
          id: b.paneId, title: words('agent.blocked'),
          data: { v: 1, sealed: data.sealed }, to: [id], urgency: 'high',
        }, { includeContent: true }).catch(() => {});
      }
    });
  }

  const handle = async (req: LinkRequest, grant: Grant): Promise<unknown> => {
    currentGrants.set(grant.id, grant);
    const scope = scopeOfSafe(grant);
    const args = asRecord(req.args);
    switch (req.op) {
      case 'hd.state': {
        return { state: kit.state, words: stateWords(kit.state) };
      }
      case 'hd.tree': {
        return filterSnapshot(kit.snapshot(), scope);
      }
      case 'hd.kinds': {
        return kit.agentKinds();
      }
      case 'hd.agent.start': {
        if (grant.role !== 'control') deny();
        const place = asRecord(args.place);
        // New workspaces/tabs are creatable; existing anchors must already be in scope.
        const anchorPane = asString(place.split) ?? asString(place.pane);
        if (anchorPane !== undefined) {
          const where = findPane(kit.snapshot(), anchorPane);
          if (!where || !inScope(scope, where.workspaceId)) deny();
        }
        if (place.tab !== undefined && typeof place.tab === 'object' && place.tab !== null) {
          const wid = asString((place.tab as Record<string, unknown>).workspaceId);
          if (!wid || !kit.snapshot().workspaces.some((w) => w.id === wid && inScope(scope, w.id))) deny();
        }
        if (typeof place.workspace === 'string' && place.workspace !== 'new') {
          // A label placement lands its tab in the matching workspace: every match must already
          // be in scope, or the device would reach a workspace its grant never named. No match
          // creates, which stays creatable like a 'new' workspace.
          const label = place.workspace;
          if (kit.snapshot().workspaces.some((w) => w.label === label && !inScope(scope, w.id))) deny();
        }
        return kit.startAgent(args as Parameters<HerdrKit['startAgent']>[0]);
      }
      case 'hd.prompt': {
        if (grant.role !== 'control') deny();
        const paneId = asString(args.paneId);
        if (!paneId) throw new Error('herdr: hd.prompt needs a paneId');
        const where = findPane(kit.snapshot(), paneId);
        if (!where || !inScope(scope, where.workspaceId)) deny();
        try {
          return await kit.prompt({ paneId }, String(args.text ?? ''));
        } catch (e) {
          // Not ready yet, or waiting on an answer: the device hears the kit's sentence, not a bare failure.
          const code = (e as { code?: string } | undefined)?.code;
          if (code === 'agent-not-ready') throw new PublicLinkError(words('agent.notReady'));
          if (code === 'agent-blocked') throw new PublicLinkError(words('agent.blocked'));
          throw e;
        }
      }
      case 'hd.keys': {
        if (grant.role !== 'control') deny();
        const paneId = asString(args.paneId);
        const keys = asStrings(args.keys);
        if (!paneId || !keys) throw new Error('herdr: hd.keys needs a paneId and keys');
        const where = findPane(kit.snapshot(), paneId);
        if (!where || !inScope(scope, where.workspaceId)) deny();
        await kit.sendKeys({ paneId }, keys);
        return null;
      }
      case 'hd.wait': {
        if (grant.role !== 'control') deny();
        const paneId = asString(args.paneId);
        const timeoutMs = asNumber(args.timeoutMs);
        const until = args.until === undefined ? undefined : asStrings(args.until);
        if (!paneId || timeoutMs === undefined || timeoutMs <= 0 || (args.until !== undefined &&
            (!until || !until.every((u) => STATUSES.has(u))))) {
          throw new Error('herdr: hd.wait needs a paneId, a positive timeoutMs and known until statuses');
        }
        const where = findPane(kit.snapshot(), paneId);
        if (!where || !inScope(scope, where.workspaceId)) deny();
        return kit.wait({ paneId }, { timeoutMs, ...(until ? { until: until as AgentStatus[] } : {}) });
      }
      case 'hd.read': {
        const paneId = asString(args.paneId);
        if (!paneId) throw new Error('herdr: hd.read needs a paneId');
        const where = findPane(kit.snapshot(), paneId);
        if (!where || !inScope(scope, where.workspaceId)) deny();
        return kit.read(paneId, {
          ...(typeof args.source === 'string' ? { source: args.source } : {}),
          ...(asNumber(args.lines) !== undefined ? { lines: asNumber(args.lines) } : {}),
        } as Parameters<HerdrKit['read']>[1]);
      }
      case 'hd.blocked': {
        return kit.blocked().filter((b) => inScope(scope, b.workspaceId));
      }
      case 'hd.answer': {
        if (grant.role !== 'control') deny();
        const paneId = asString(args.paneId);
        const keys = asStrings(args.keys);
        const revision = asNumber(args.revision);
        if (!paneId || !keys || revision === undefined) {
          throw new Error('herdr: hd.answer needs paneId, keys and revision');
        }
        const where = findPane(kit.snapshot(), paneId);
        if (!where || !inScope(scope, where.workspaceId)) deny();
        try {
          await kit.answer(paneId, keys, { revision });
        } catch (e) {
          // A stale revision is the question changing under the device, not a refusal.
          if ((e as { code?: string } | undefined)?.code === 'approval-stale') {
            throw new PublicLinkError(words('approval.stale'));
          }
          throw e;
        }
        return null;
      }
      // hd.close and the typed edit ops share one shape (7.1): exactly one target, control only, and the
      // target's owning workspace checked against scope before any Herdr call is made (a tab through its
      // workspace, a workspace through itself). Out of scope — or unknown — is link.notAllowed.
      case 'hd.close': {
        if (grant.role !== 'control') deny();
        const target = scopedTarget('hd.close', args, scope, kit.snapshot());
        try {
          if (target.pane !== undefined) await kit.closePane(target.pane);
          else if (target.tab !== undefined) await kit.closeTab(target.tab);
          else await kit.closeWorkspace(target.workspace!);
        } catch (e) { throw widenError(e) ?? e; }
        return null;
      }
      case 'hd.rename': {
        if (grant.role !== 'control') deny();
        await kit.rename({ ...scopedTarget('hd.rename', args, scope, kit.snapshot()), label: asString(args.label) ?? '' });
        return null;
      }
      case 'hd.focus': {
        if (grant.role !== 'control') deny();
        await kit.focus(scopedTarget('hd.focus', args, scope, kit.snapshot()));
        return null;
      }
      case 'hd.layout': {
        if (grant.role !== 'control') deny();
        const root = args.root;
        if (typeof root !== 'object' || root === null || Array.isArray(root)) {
          throw new Error('herdr: hd.layout needs a root');
        }
        const snap = kit.snapshot();
        const tabId = asString(args.tabId);
        const workspaceId = asString(args.workspaceId);
        // The layout picks exactly one tab or workspace, in scope, before any call.
        if ([tabId, workspaceId].filter((v) => v !== undefined).length !== 1) {
          throw new Error('herdr: hd.layout picks exactly one of tabId or workspaceId');
        }
        if (tabId !== undefined) {
          const owner = snap.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
          if (!owner || !inScope(scope, owner.id)) deny();
        } else if (!snap.workspaces.some((w) => w.id === workspaceId && inScope(scope, w.id))) deny();
        // Every named pane leaf must be known and in scope before any call; an unnamed leaf is a new pane.
        const pending: unknown[] = [root];
        while (pending.length > 0) {
          const node = asRecord(pending.pop());
          if (typeof node.pane_id === 'string') {
            const where = findPane(snap, node.pane_id);
            if (!where || !inScope(scope, where.workspaceId)) deny();
          }
          if (node.first !== undefined) pending.push(node.first);
          if (node.second !== undefined) pending.push(node.second);
        }
        const tabLabel = asString(args.tabLabel);
        return kit.layout({
          root: root as HerdrLayout['root'],
          ...(args.focus === true ? { focus: true } : {}),
          ...(tabId !== undefined ? { tabId } : {}),
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(tabLabel !== undefined ? { tabLabel } : {}),
        });
      }
      case 'hd.notices.register': {
        if (grant.role !== 'control') deny();
        const box = decodeB64Url(asString(args.boxPublicKey) ?? '');
        if (!box || box.length !== 32) throw new Error('herdr: hd.notices.register needs a 32-byte boxPublicKey');
        boxes.set(grant.id, box);
        return null;
      }
      case 'hd.call': {
        const method = asString(args.method);
        if (!method) throw new Error('herdr: hd.call needs a method');
        if (!passThrough(method, grant)) deny();
        return kit.call(method as never, asRecord(args.params) as never);
      }
      default:
        throw new Error(`herdr: unknown link op ${req.op}`);
    }
  };

  const stream = (s: LinkStream, req: LinkRequest, grant: Grant): void => {
    currentGrants.set(grant.id, grant);
    const args = asRecord(req.args);
    if (req.op === 'hd.events') {
      const send = (frame: unknown): void => {
        void s.write(`${JSON.stringify(frame)}\n`).catch(() => {});
      };
      send({ type: 'snapshot', snapshot: filterSnapshot(kit.snapshot(), scopeOfSafe(grant)) });
      const stopTree = kit.onChange((snap) => {
        send({ type: 'snapshot', snapshot: filterSnapshot(snap, scopeOfSafe(currentGrants.get(grant.id) ?? grant)) });
      });
      const stopBlocked = kit.onBlocked((b: BlockedAgent, change: 'added' | 'resolved') => {
        if (inScope(scopeOfSafe(currentGrants.get(grant.id) ?? grant), b.workspaceId)) {
          send({ type: 'blocked', change, blocked: b });
        }
      });
      s.onEnd = () => { stopTree(); stopBlocked(); };
      return;
    }
    if (req.op === 'hd.subscribe') {
      const scope = scopeOfSafe(grant);
      const subs = Array.isArray(args.subs) ? args.subs as unknown[] : undefined;
      if (!subs || subs.length === 0 || !subs.every((sub) => typeof asRecord(sub).type === 'string')) {
        s.end('herdr: hd.subscribe needs subs, each with a type');
        return;
      }
      // A filter naming a pane must name one in scope, like every other pane-addressed op.
      const snap = kit.snapshot();
      for (const sub of subs) {
        const paneId = asRecord(sub).pane_id;
        if (paneId === undefined) continue;
        const where = typeof paneId === 'string' ? findPane(snap, paneId) : undefined;
        if (!where || !inScope(scope, where.workspaceId)) { s.end(words('link.notAllowed')); return; }
      }
      // A rejected batch or a kit that disconnects (stop, restart) ends the stream, so the device hears
      // it through onError and can subscribe again instead of waiting on a dead socket.
      let stop: () => void = () => {};
      let offChange: () => void = () => {};
      let over = false;
      const finish = (reason: string): void => {
        if (over) return;
        over = true;
        stop();
        offChange();
        s.end(reason);
      };
      try {
        stop = kit.subscribe(subs as HerdrSubscription[], (e) => {
          const now = scopeOfSafe(currentGrants.get(grant.id) ?? grant);
          if (now.workspaces !== 'all') {
            const named = eventWorkspaces(e as HerdrEvent, kit.snapshot());
            if (named.size === 0 || ![...named].every((id) => inScope(now, id))) return;
          }
          void s.write(`${JSON.stringify(e)}\n`).catch(() => {});
        }, (code) => { finish(`herdr: subscription rejected (${code})`); });
      } catch (e) {
        finish(e instanceof PublicLinkError ? e.message : 'failed');
        return;
      }
      offChange = kit.onChange((snap) => { if (!snap.connected) finish('herdr: disconnected'); });
      s.onEnd = () => { over = true; stop(); offChange(); };
      return;
    }
    if (req.op === 'hd.terminal') {
      const scope = scopeOfSafe(grant);
      const paneId = asString(args.paneId);
      if (!paneId) { s.end('herdr: hd.terminal needs a paneId'); return; }
      const where = findPane(kit.snapshot(), paneId);
      if (!where || !inScope(scope, where.workspaceId)) { s.end(words('link.notAllowed')); return; }
      // View grants get observe only; control grants get the mode they asked for (7.1).
      const want = args.mode === 'control' ? 'control' : 'observe';
      const mode = grant.role === 'control' ? want : 'observe';
      const cols = asNumber(args.cols) ?? 80;
      const rows = asNumber(args.rows) ?? 24;
      let session: ReturnType<HerdrKit['terminal']>;
      try {
        session = kit.terminal(paneId, { mode, cols, rows });
      } catch (e) {
        s.end(e instanceof PublicLinkError ? e.message : 'failed');
        return;
      }
      const text = new TextDecoder();
      let pending = '';
      session.onFrame((line) => {
        void s.write(`${line}\n`).catch(() => {});
      });
      s.onData = (chunk: Uint8Array) => {
        pending += text.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.length > 0) session.send(line);
        }
      };
      s.onEnd = () => {
        if (pending.length > 0) session.send(pending);
        session.close();
      };
      void session.ready.catch((e: unknown) => {
        s.end(e instanceof Error && (e as { code?: string }).code === 'missing/binary'
          ? words('herdr.missing') : 'failed');
      });
      void session.exited.then(() => s.end());
      return;
    }
    s.end(`herdr: unknown link stream ${req.op}`);
  };

  return {
    handle,
    stream,
    // Every refusal carries the kit's sentence from handle/stream (see the module note).
    allow: () => true,
  };
}

export function serve(o: { host: Host; port: number; via?: Via; previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void }): Promise<{ urls: string[]; ingress?: ServeIngress; close(): Promise<void> }> {
  return (async () => {
    let reach: typeof import('@byokit/discover').reach;
    try {
      ({ reach } = await import('@byokit/discover'));
    } catch (e) {
      throw missingPeer('@byokit/discover', e);
    }
    const r = await reach({ port: o.port, via: o.via, previous: o.previous });
    const server = createServer((req, res) => {
      if (o.http) {
        o.http(req, res);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      o.host.accept(ws as unknown as Socket, { peer: req.socket.remoteAddress });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, r.bind, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return {
      urls: r.urls,
      ...(r.ingress ? { ingress: r.ingress } : {}),
      close: async (): Promise<void> => {
        wss.close();
        await new Promise<void>((resolve, reject) => {
          server.close((e) => (e ? reject(e) : resolve()));
        });
      },
    };
  })();
}
