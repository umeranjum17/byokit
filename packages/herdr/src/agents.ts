// Agent helpers: placements, prompt receipts, waits and reads (docs/runtime-kits.md 6.4).
// Exact param spellings come from the generated v0.9.1 table (6.7); where muxr and the schema
// disagree the schema wins. `pane.split` takes `target_pane_id` (muxr agrees), and `agent.start`
// has no `env` param — a start's env belongs to the placement create/split call (src/generated/methods.ts).
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { HerdrKit } from './kit.ts';
import type { AgentCliSignIn, AgentInstallProbe, AgentInstallState, AgentLaunchFailureReason,
  AgentReadiness, AgentStartEvent, AgentStatusOptions,
  AgentStatusRunner, AgentRef, AgentStatus, HerdrSnapshot, PromptReceipt, StartAgent } from './types.ts';
import { words } from './words.ts';
import { prepareLaunchEnv, type LaunchEnvironment } from './launch-env.ts';
import { museNative, MUSE_INSTALL_URL } from './muse.ts';

export type Call = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

type Raw = Record<string, any>;
type AgentRecord = HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent'];

const PROMPTABLE: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done'];
const DEFAULT_TIMEOUT_MS = 60_000;

// `agent.start` lands while the fresh pane is still at its shell prompt: the server answers
// `agent_pane_busy`/`agent_pane_unavailable` until the pane is ready. The kit retries those for a
// bounded 5 s, then rolls the pane it created back with `pane.close` like any other start failure.
const START_RETRYABLE = new Set(['agent_pane_busy', 'agent_pane_unavailable']);
const START_RETRY_BUDGET_MS = 5_000;
const START_RETRY_DELAY_MS = 100;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return code;
  return /herdr: ([a-z0-9_]+):/i.exec(error instanceof Error ? error.message : String(error))?.[1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

export function createAgents(ctx: { call: Call; snapshot(): HerdrSnapshot; reread(paneId: string): Promise<void>; emitStart?(e: AgentStartEvent): void; launchEnv?(): Record<string, string> | undefined }): Pick<HerdrKit,
  'startAgent' | 'prompt' | 'sendKeys' | 'wait' | 'read' | 'agentKinds' | 'installedAgentKinds' | 'agentStatus'> {
  const call = ctx.call;
  const emitStart = (e: AgentStartEvent): void => {
    try { ctx.emitStart?.(e); } catch { /* a listener never breaks a start */ }
  };

  // Every placement takes its pane id from the server's answer, never a prediction (6.4).
  // Placements that make a pane (every path but `pane`) roll it back with `pane.close` when the
  // start fails, so a failed start leaves no extra pane behind.
  async function startAgent(o: StartAgent): Promise<AgentRef> {
    const emit = (e: AgentStartEvent): void => {
      try { o.onEvent?.(e); } catch { /* a listener never breaks a start */ }
      emitStart(e);
    };
    let installExpected = false;
    let stage: 'placement' | 'start' = 'placement';
    try {
      if (o.kind === 'muse') {
        const replacement = o.env && typeof o.env.env === 'object' && Array.isArray(o.env.unset)
          ? o.env as LaunchEnvironment : undefined;
        const existingPane = 'pane' in o.place && o.worktree === undefined;
        // An ordinary env overlay cannot replace an existing shell's environment.
        if (existingPane && !replacement && Object.keys(o.env ?? {}).length > 0) {
          throw fail('env_mismatch', 'This pane needs to be opened again to use that sign-in.');
        }
        const effective = replacement?.env ?? (existingPane ? undefined
          : { ...ctx.launchEnv?.(), ...o.env as Record<string, string> | undefined });
        // No controller/global extras and no probe override when the effective PATH is known.
        // Existing unobserved panes remain unknown; the exact RPC pass-through remains available.
        const path = effective?.PATH?.split(delimiter).filter(isAbsolute);
        const probe = path === undefined ? (existingPane ? undefined : o.installProbe) : { path };
        if (probe && agentInstallState('muse', probe).state === 'missing') {
          throw fail('agent_not_installed', words('agent.notInstalled'));
        }
      } else {
        try { installExpected = agentInstallState(o.kind, o.installProbe).state === 'installs-on-first-start'; }
        catch { installExpected = false; }
      }
      if (installExpected) emit({ phase: 'installing', kind: o.kind, message: words('agent.installing', { agent: o.kind }) });
      const ref = await startAgentInner(o, () => { stage = 'start'; });
      emit({ phase: 'ready', kind: o.kind, ref });
      return ref;
    } catch (error) {
      const reason = classifyStartFailure(error, { installExpected, stage });
      emit({ phase: 'launchFailed', kind: o.kind, reason, message: launchFailureWords(reason, o.kind) });
      if (codeOf(error) === 'agent_not_installed') throw error;
      if (o.env && typeof o.env.env === 'object') throw fail(codeOf(error) === 'env_mismatch' ? 'env_mismatch' : 'start_failed', words('agent.notReady'));
      throw error;
    }
  }

  async function startAgentInner(o: StartAgent, onStartPhase?: () => void): Promise<AgentRef> {
    const launch = o.env && typeof o.env.env === 'object' && Array.isArray(o.env.unset)
      ? o.env as LaunchEnvironment : undefined;
    if (!launch && 'pane' in o.place && Object.keys(o.env ?? {}).length > 0) {
      throw fail('env_mismatch', 'This pane needs to be opened again to use that sign-in.');
    }
    const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = o.env === undefined || launch ? {} : { env: o.env };
    let paneId: string | undefined;
    let created = false;
    if (o.worktree !== undefined) {
      const made = await call('worktree.create', { cwd: o.cwd, focus: false, ...env,
        ...(o.worktree.branch === undefined ? {} : { branch: o.worktree.branch }),
        ...(o.worktree.base === undefined ? {} : { base: o.worktree.base }) }) as Raw;
      const worktree = isObj(made?.worktree) ? made.worktree : undefined;
      const checkout = typeof worktree?.checkout_path === 'string' ? worktree.checkout_path
        : typeof worktree?.path === 'string' ? worktree.path : o.cwd;
      // The pinned schema's worktree.create carries the fresh root pane; a server that leaves the
      // new workspace empty gets its first tab opened in the checkout instead.
      paneId = rootPaneOf(made) ?? rootPaneOf(await call('tab.create', {
        workspace_id: made?.workspace?.workspace_id, cwd: checkout, focus: false, ...env,
      }));
      created = true;
    } else if ('workspace' in o.place) {
      paneId = rootPaneOf(await call('workspace.create', { cwd: o.cwd,
        ...(o.place.label === undefined ? {} : { label: o.place.label }), focus: false, ...env }));
      created = true;
    } else if ('tab' in o.place) {
      paneId = rootPaneOf(await call('tab.create', { workspace_id: o.place.workspaceId, cwd: o.cwd,
        ...(o.place.label === undefined ? {} : { label: o.place.label }), focus: false, ...env }));
      created = true;
    } else if ('split' in o.place) {
      const made = await call('pane.split', { target_pane_id: o.place.split,
        direction: o.place.direction, focus: false, ...env }) as Raw;
      paneId = typeof made?.pane?.pane_id === 'string' ? made.pane.pane_id : undefined;
      created = true;
    } else {
      paneId = o.place.pane;
    }
    if (paneId === undefined) throw new Error('herdr: the placement answered no pane id');
    if (launch) {
      try { await prepareLaunchEnv(call, paneId, launch, timeout); }
      catch (error) {
        if (created) { try { await call('pane.close', { pane_id: paneId }); } catch { /* best effort */ } }
        throw error;
      }
    }
    onStartPhase?.();
    const name = agentName(o);
    const params = { pane_id: paneId, kind: o.kind, name,
      ...(o.args === undefined ? {} : { args: o.args }), timeout_ms: timeout };
    const deadline = Date.now() + START_RETRY_BUDGET_MS;
    for (;;) {
      try {
        await call('agent.start', params, timeout + 5000);
        return { paneId, name };
      } catch (error) {
        if (START_RETRYABLE.has(codeOf(error) ?? '') && Date.now() < deadline) {
          await sleep(START_RETRY_DELAY_MS);
          continue;
        }
        if (created) {
          try { await call('pane.close', { pane_id: paneId }); } catch { /* rollback is best-effort */ }
        }
        if (launch) throw fail('start_failed', words('agent.notReady'));
        throw error;
      }
    }
  }

  async function prompt(target: AgentRef, text: string,
    o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt> {
    // The readiness gate reads the kit's own tree, re-read once before a refusal: `launch_pending`
    // rides reads only, so a snapshot taken mid-launch goes stale. `interactive_ready` is not gated:
    // Herdr sets it only for agents its own `agent.start` settled, and its `agent.prompt` accepts the
    // rest. A refusal never sends `agent.prompt`.
    const ready = (): boolean => {
      const agent = agentOf(ctx.snapshot(), target.paneId);
      return agent !== undefined && agent.launchPending !== true && PROMPTABLE.includes(agent.status);
    };
    if (!ready()) {
      await ctx.reread(target.paneId);
      if (!ready()) throw fail('agent-not-ready', 'That agent is not ready for a prompt yet.');
    }
    const wait = o?.wait === undefined ? undefined
      : { timeout_ms: o.wait.timeoutMs, ...(o.wait.until === undefined ? {} : { until: o.wait.until }) };
    let receipt: unknown;
    try {
      receipt = await call('agent.prompt', { target: target.paneId, text,
        ...(wait === undefined ? {} : { wait }) });
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code;
      if (code === 'agent_blocked') {
        throw fail('agent-blocked', 'That agent is blocked and needs an answer before a new prompt.');
      }
      // Herdr's own gate (unknown agent kind, launch pending, not the pane's foreground process).
      if (code === 'agent_not_ready') {
        throw fail('agent-not-ready', 'That agent is not ready for a prompt yet.');
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
    const session = a.agent_session;
    const agentSession = isObj(session) && typeof session.source === 'string'
      && typeof session.agent === 'string' && typeof session.kind === 'string' && typeof session.value === 'string'
      ? { source: session.source, agent: session.agent, kind: session.kind, value: session.value } : undefined;
    return { paneId: a.pane_id, terminalId: a.terminal_id, revision: a.revision, status: a.agent_status as AgentStatus,
      ...(agentSession === undefined ? {} : { agentSession }) };
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

  function installedAgentKinds(kinds: readonly string[], o: { path: string[]; aliases?: Record<string, string[]> }): string[] {
    return kinds.filter((kind) => resolveAgentBinary(kind, o).path !== undefined);
  }

  async function agentStatus(kinds: readonly string[], o?: AgentStatusOptions): Promise<AgentReadiness[]> {
    const path = o?.path ?? ctx.launchEnv?.()?.PATH?.split(delimiter) ?? agentProbePath();
    const run = o?.run ?? runStatusCommand;
    const timeoutMs = o?.timeoutMs ?? STATUS_TIMEOUT_MS;
    const probe = { path, ...(o?.aliases === undefined ? {} : { aliases: o.aliases }),
      ...(o?.readFile === undefined ? {} : { readFile: o.readFile }) };
    return Promise.all(kinds.map(async (kind): Promise<AgentReadiness> => {
      const install = agentInstallState(kind, probe);
      const binary = o?.aliases?.[kind]?.[0] ?? kind;
      const installHint = kind === 'muse' ? `Install Muse explicitly from ${MUSE_INSTALL_URL} into the private launch environment.`
        : kind === 'pi' ? PI_INSTALL_HINT : `Install the ${binary} command, then check again.`;
      // Muse missing/launcher-only stays missing; legacy kinds retain their shim readiness.
      // Install state never proves account or catalog readiness.
      if (install.state !== 'installed') return { kind, installed: false, installState: install.state, signedIn: 'unknown', installHint };
      const statusProbe = STATUS_PROBES[kind];
      if (statusProbe === undefined) return { kind, installed: true, installState: 'installed', signedIn: 'unknown', installHint };
      let answer: { stdout: string } | undefined;
      try { answer = await run(statusProbe.command, statusProbe.args, { ...(statusProbe.stdin === undefined ? {} : { stdin: statusProbe.stdin }), timeoutMs }); }
      catch { answer = undefined; }
      const signedIn: AgentCliSignIn = answer === undefined ? 'unknown' : statusProbe.parse(answer.stdout);
      return { kind, installed: true, installState: 'installed', signedIn, installHint,
        ...(signedIn === 'yes' ? {} : { signInHint: SIGNIN_HINTS[kind] ?? `Sign in to ${kind} on this computer, then check again.` }) };
    }));
  }

  return { startAgent, prompt, sendKeys, wait, read, agentKinds, installedAgentKinds, agentStatus };
}

// One source of truth for install detection (B5's probe plus the shim layer below): the first
// executable file named for the kind across the probe path, with its absolute path.
export function resolveAgentBinary(kind: string,
  o: { path: string[]; aliases?: Record<string, string[]> }): { binary: string; path?: string } {
  const names = [kind, ...(o.aliases?.[kind] ?? [])];
  for (const name of names) {
    for (const dir of o.path) {
      if (dir === '') continue;
      const file = join(dir, name);
      try { accessSync(file, fsConstants.X_OK); return { binary: name, path: file }; }
      catch { /* keep looking */ }
    }
  }
  return { binary: o.aliases?.[kind]?.[0] ?? kind };
}

// Bounded head read for the shim sniff: the first 2 KiB as text, undefined when unreadable.
function readHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(2048);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ } }
}

// A mise-style auto-install launcher reads as a shell script that execs through mise — the
// found "binary" runs, but the first run installs the agent instead. Real binaries (ELF,
// Mach-O) never match: the shebang gate keeps a stray "mise" substring ("promise", …) out.
export function isAutoInstallShim(file: string,
  readFile: (file: string) => string | undefined = readHead): boolean {
  let head: string | undefined;
  try { head = readFile(file); } catch { return false; }
  return head !== undefined && head.startsWith('#!') && head.includes('mise');
}

// Muse has no absent-CLI auto-installer in stock Herdr. Its official launcher needs the
// selected native release too. Other kinds retain their legacy shim classification.
export function agentInstallState(kind: string,
  o?: AgentInstallProbe): { kind: string; state: AgentInstallState; path?: string } {
  const path = o?.path ?? agentProbePath();
  const found = resolveAgentBinary(kind, { path, ...(o?.aliases === undefined ? {} : { aliases: o.aliases }) });
  if (found.path === undefined) return { kind, state: kind === 'muse' ? 'missing' : 'installs-on-first-start' };
  if (kind === 'muse') {
    try { if (!statSync(found.path).isFile()) return { kind, state: 'missing', path: found.path }; }
    catch { return { kind, state: 'missing', path: found.path }; }
    const head = (o?.readFile ?? readHead)(found.path);
    if (head?.startsWith('#!') && (head.includes('mise') || (head.includes('MUSE_CHANNEL') && !museNative(found.path)))) {
      return { kind, state: 'missing', path: found.path };
    }
    return { kind, state: 'installed', path: found.path };
  }
  const shim = isAutoInstallShim(found.path, o?.readFile);
  return shim ? { kind, state: 'installs-on-first-start', path: found.path }
    : { kind, state: 'installed', path: found.path };
}

// Typed launch failure for the `launchFailed` event. The rejection itself is unchanged — this
// only classifies it: a busy pane that outlasted the retry budget, an install that never
// finished, a placement that made no pane, or any other rejected start.
export function classifyStartFailure(error: unknown,
  o?: { installExpected?: boolean; stage?: 'placement' | 'start' }): AgentLaunchFailureReason {
  const code = codeOf(error);
  if (code === 'agent_not_installed') return 'not-installed';
  if (code !== undefined && START_RETRYABLE.has(code)) return 'pane-busy';
  if (o?.stage === 'placement') return 'placement-failed';
  if (o?.installExpected === true) return 'install-failed';
  return 'start-rejected';
}

function launchFailureWords(reason: AgentLaunchFailureReason, kind: string): string {
  if (reason === 'not-installed') return words('agent.notInstalled');
  if (reason === 'pane-busy') return words('agent.notReady');
  if (reason === 'install-failed') return words('agent.installFailed', { agent: kind });
  return words('agent.launchFailed');
}

// Extra install dirs muxr's `executableOnPath`
// (`apps/host/src/agent/infrastructure/herdrSessionSource.ts`) probes past PATH: user-install
// dirs a service or GUI daemon's inherited PATH omits — mise shims (Herdr installs Pi through
// mise), `~/.local/bin`, npm-global, Homebrew and the system dirs.
export function extraPathDirs(home: string = homedir()): string[] {
  return [join(home, '.local', 'bin'), join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
}

// The full install probe: the host's own PATH plus the extra dirs, de-duplicated.
export function agentProbePath(path: string[] = (process.env.PATH ?? '').split(delimiter),
  home: string = homedir()): string[] {
  return [...new Set([...path, ...extraPathDirs(home)])].filter((dir) => dir !== '');
}

const STATUS_TIMEOUT_MS = 10_000;
const PI_INSTALL_HINT = 'installs on first start';

const SIGNIN_HINTS: Record<string, string> = {
  claude: 'On this computer run `claude`, sign in, then come back.',
  codex: 'On this computer run `codex`, sign in, then come back.',
};

type StatusProbe = {
  command: string; args: string[]; stdin?: string;
  parse(stdout: string): AgentCliSignIn;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Per-kind CLI status commands (see the README table for why each one). Every probe asks the
// CLI itself and keeps only the signed-in boolean — email, plan and everything secret stays out.
// A kind with no documented non-secret status command has no entry and reads 'unknown'.
const STATUS_PROBES: Record<string, StatusProbe> = {
  // `claude auth status` prints JSON with `loggedIn` (muxr's planIdentity reads the same);
  // a signed-out CLI still prints its JSON, so only an empty answer means 'unknown'.
  claude: { command: 'claude', args: ['auth', 'status'], parse: (stdout) => {
    let status: unknown;
    try { status = JSON.parse(stdout); } catch { return 'unknown'; }
    if (!isRecord(status)) return 'unknown';
    return status.loggedIn === true ? 'yes' : 'no';
  } },
  // Codex exposes sign-in only over its app-server protocol, so the probe pipes a pipelined
  // `initialize` + `account/read` round (same method muxr's planIdentity uses) and reads the
  // second answer: a record `account` means signed in, its absence means signed out.
  codex: { command: 'codex', args: ['app-server'],
    stdin: '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"byokit","version":"1"}}}\n{"id":2,"method":"account/read","params":{}}\n',
    parse: (stdout) => {
      for (const line of stdout.split('\n')) {
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (isRecord(message) && message.id === 2) {
          return isRecord(message.result) && isRecord(message.result.account) ? 'yes' : 'no';
        }
      }
      return 'unknown';
    } },
};

// Default runner: one bounded spawn per probe, stdin piped when the protocol needs it (codex).
// Failures (missing binary, timeout, non-empty stderr, empty stdout) read as no answer — never throw.
export async function runStatusCommand(command: string, args: string[],
  o?: { stdin?: string; timeoutMs?: number }): Promise<{ stdout: string } | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { stdout: string } | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: o?.timeoutMs ?? STATUS_TIMEOUT_MS });
    } catch { finish(undefined); return; }
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(undefined); }, (o?.timeoutMs ?? STATUS_TIMEOUT_MS) + 500);
    child.on('error', () => finish(undefined));
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) { finish(undefined); return; }
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > 64 * 1024) { child.kill('SIGKILL'); finish(undefined); }
    });
    child.on('close', () => finish(out.trim() === '' ? undefined : { stdout: out.slice(0, 64 * 1024) }));
    stdin.on('error', () => { /* the close handler settles */ });
    try {
      if (o?.stdin !== undefined) stdin.write(o.stdin);
      stdin.end();
    } catch { /* a dead stdin settles through close/error */ }
  });
}
