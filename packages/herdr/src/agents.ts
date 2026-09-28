// Agent helpers: placements, prompt receipts, waits and reads (docs/runtime-kits.md 6.4).
// Exact param spellings come from the generated v0.9.1 table (6.7); where muxr and the schema
// disagree the schema wins, and H5 records the divergences here: `pane.split` takes
// `target_pane_id` (muxr sends `pane_id`), and `agent.start` has no `env` param — a start's env
// belongs to the placement create/split call (src/generated/methods.ts).
import { accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { HerdrKit } from './kit.ts';
import type { AgentRef, AgentStatus, HerdrSnapshot, PromptReceipt, StartAgent } from './types.ts';

export type Call = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

type Raw = Record<string, any>;
type AgentRecord = HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent'];

const PROMPTABLE: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done'];
const DEFAULT_TIMEOUT_MS = 60_000;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function agentOf(snapshot: HerdrSnapshot, paneId: string): AgentRecord {
  for (const w of snapshot.workspaces) for (const t of w.tabs) for (const p of t.panes) {
    if (p.id === paneId) return p.agent;
  }
  return undefined;
}

// `agent.start` requires a name matching /^[a-z][a-z0-9_-]{0,31}$/; derive one from the kind when absent.
function agentName(o: StartAgent): string {
  const slug = (o.name ?? o.kind).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_0-9]+/, '').slice(0, 32);
  return /^[a-z]/.test(slug) ? slug : `a-${slug}`.slice(0, 32);
}

function rootPaneOf(result: unknown): string | undefined {
  const pane = isObj(result) ? result.root_pane : undefined;
  return isObj(pane) && typeof pane.pane_id === 'string' ? pane.pane_id : undefined;
}

export function createAgents(ctx: { call: Call; snapshot(): HerdrSnapshot }): Pick<HerdrKit,
  'startAgent' | 'prompt' | 'sendKeys' | 'wait' | 'read' | 'agentKinds' | 'installedAgentKinds'> {
  const call = ctx.call;

  // Every placement takes its pane id from the server's answer, never a prediction (6.4).
  async function startAgent(o: StartAgent): Promise<AgentRef> {
    const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = o.env === undefined ? {} : { env: o.env };
    let paneId: string | undefined;
    if (o.worktree !== undefined) {
      const made = await call('worktree.create', { cwd: o.cwd, branch: o.worktree.branch,
        ...(o.worktree.base === undefined ? {} : { base: o.worktree.base }) }) as Raw;
      const worktree = isObj(made?.worktree) ? made.worktree : undefined;
      const checkout = typeof worktree?.checkout_path === 'string' ? worktree.checkout_path
        : typeof worktree?.path === 'string' ? worktree.path : o.cwd;
      // The pinned schema's worktree.create carries the fresh root pane; a server that leaves the
      // new workspace empty gets its first tab opened in the checkout instead.
      paneId = rootPaneOf(made) ?? rootPaneOf(await call('tab.create', {
        workspace_id: made?.workspace?.workspace_id, cwd: checkout, focus: false, ...env,
      }));
    } else if ('workspace' in o.place) {
      paneId = rootPaneOf(await call('workspace.create', { cwd: o.cwd,
        ...(o.place.label === undefined ? {} : { label: o.place.label }), focus: false, ...env }));
    } else if ('tab' in o.place) {
      paneId = rootPaneOf(await call('tab.create', { workspace_id: o.place.workspaceId, cwd: o.cwd,
        ...(o.place.label === undefined ? {} : { label: o.place.label }), focus: false, ...env }));
    } else if ('split' in o.place) {
      const made = await call('pane.split', { target_pane_id: o.place.split,
        direction: o.place.direction, focus: false, ...env }) as Raw;
      paneId = typeof made?.pane?.pane_id === 'string' ? made.pane.pane_id : undefined;
    } else {
      paneId = o.place.pane;
    }
    if (paneId === undefined) throw new Error('herdr: the placement answered no pane id');
    const name = agentName(o);
    await call('agent.start', { pane_id: paneId, kind: o.kind, name,
      ...(o.args === undefined ? {} : { args: o.args }), timeout_ms: timeout }, timeout + 5000);
    return { paneId, name };
  }

  async function prompt(target: AgentRef, text: string,
    o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt> {
    // The readiness gate reads the kit's own tree: a not-promptable agent is refused with no socket call.
    const agent = agentOf(ctx.snapshot(), target.paneId);
    if (agent === undefined || agent.launchPending === true || agent.interactiveReady === false
      || !PROMPTABLE.includes(agent.status)) {
      throw fail('agent-not-ready', 'That agent is not ready for a prompt yet.');
    }
    const wait = o?.wait === undefined ? undefined
      : { timeout_ms: o.wait.timeoutMs, ...(o.wait.until === undefined ? {} : { until: o.wait.until }) };
    let receipt: unknown;
    try {
      receipt = await call('agent.prompt', { target: target.paneId, text,
        ...(wait === undefined ? {} : { wait }) });
    } catch (error) {
      if ((error as { code?: unknown } | null | undefined)?.code === 'agent_blocked') {
        throw fail('agent-blocked', 'That agent is blocked and needs an answer before a new prompt.');
      }
      throw error;
    }
    const body = isObj(receipt) ? receipt : undefined;
    const a = isObj(body?.agent) ? body.agent : undefined;
    if (body?.type !== 'agent_prompted' || a === undefined
      || typeof a.terminal_id !== 'string' || typeof a.agent_status !== 'string'
      || typeof a.workspace_id !== 'string' || typeof a.tab_id !== 'string'
      || typeof a.pane_id !== 'string' || typeof a.focused !== 'boolean'
      || typeof a.revision !== 'number' || !Number.isSafeInteger(a.revision) || a.revision < 0
      || a.pane_id !== target.paneId) {
      throw new Error('Herdr did not queue the prompt.');
    }
    return { paneId: a.pane_id, terminalId: a.terminal_id, revision: a.revision, status: a.agent_status as AgentStatus };
  }

  async function wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus> {
    const made = await call('agent.wait', { target: target.paneId,
      ...(o.until === undefined ? {} : { until: o.until }), timeout_ms: o.timeoutMs }) as Raw;
    // The fake answers `{ agent }`; the pinned schema wraps the status event in `event.data` — both unwrap.
    return (made?.agent?.agent_status ?? made?.event?.data?.agent_status ?? 'unknown') as AgentStatus;
  }

  async function read(paneId: string,
    o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }):
    Promise<{ text: string; truncated: boolean }> {
    const made = await call('pane.read', { pane_id: paneId, source: o?.source ?? 'recent',
      ...(o?.lines === undefined ? {} : { lines: o.lines }),
      ...(o?.ansi === true ? { format: 'ansi' } : {}) }) as Raw;
    const body = isObj(made?.read) ? made.read : undefined;
    return { text: typeof body?.text === 'string' ? body.text : '', truncated: body?.truncated === true };
  }

  async function sendKeys(target: AgentRef, keys: string[]): Promise<void> {
    await call('agent.send_keys', { target: target.paneId, keys });
  }

  async function agentKinds(): Promise<string[]> {
    const made = await call('server.agent_manifests', {}) as Raw;
    const manifests = Array.isArray(made?.manifests) ? made.manifests : [];
    return manifests.map((m: Raw) => (typeof m?.agent === 'string' ? m.agent : '')).filter((kind: string) => kind !== '');
  }

  function installedAgentKinds(kinds: readonly string[], o: { path: string[] }): string[] {
    const installed: string[] = [];
    for (const kind of kinds) {
      if (o.path.some((dir) => {
        try { accessSync(join(dir, kind), fsConstants.X_OK); return true; } catch { return false; }
      })) installed.push(kind);
    }
    return installed;
  }

  return { startAgent, prompt, sendKeys, wait, read, agentKinds, installedAgentKinds };
}
