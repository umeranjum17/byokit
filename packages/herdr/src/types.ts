// The kit's public types (docs/runtime-kits.md 6.2). H1 freezes these signatures; the generated method table (H2)
// replaces the placeholder pass-through types below without changing any signature.

export type HerdrState = {
  phase: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'needs-update' | 'missing' | 'failed';
  why?: 'binary' | 'socket' | 'version' | 'server-exited';
};

// Declared range of accepted Herdr server protocols (K11). Each bound defaults to the kit's
// pinned HERDR_PROTOCOL, so an undeclared range means exactly the pin. A server below `min`
// fails closed (`start()` rejects); a server above `max` connects anyway — `start()` resolves
// and the kit stays usable with the steady state `needs-update`/`version` — so a Herdr protocol
// bump does not take the host down before the kit's pin moves.
export type HerdrProtocolRange = { min?: number; max?: number };

export type HerdrKitOptions =
  | { mode: 'adopt'; bin: string; socketPath: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; protocolRange?: HerdrProtocolRange; onState?: (s: HerdrState) => void;
      onLog?: (message: string) => void }
  | { mode: 'own'; bin: string; stateDir: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; protocolRange?: HerdrProtocolRange; onState?: (s: HerdrState) => void;
      onLog?: (message: string) => void };

// A live subscription: call to unsubscribe. `ready` resolves true on the server ack and false on a
// rejected batch (a rejection is reported via `onError` and never retried); the reconnect hooks
// fire only on later drops of an acknowledged socket.
export type HerdrSubscribeStop = (() => void) & {
  ready: Promise<boolean>;
  onReconnect(fn: () => void): void;
  onDisconnect(fn: () => void): void;
};

export interface HerdrTransport {                        // socket.ts implements it; the fake does too
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  subscribe(subs: { type: string; [k: string]: unknown }[], on: (e: HerdrEvent) => void,
            onError: (code: string, message: string) => void): HerdrSubscribeStop;   // own socket per call
  close(): void;
}

export type HerdrEvent = { type: string; [k: string]: unknown };

// Pass-through typing (docs/runtime-kits.md 4.6): the generated method/event tables from the pinned
// v0.9.1 schema snapshot (H2). Names and shapes are frozen by 6.2; only the tables' contents come
// from the schema.
export type { HerdrMethods, HerdrMethod, HerdrParams, HerdrResult } from './generated/methods.ts';
export type { HerdrEvents, HerdrEventName, HerdrEventOf, HerdrSubscription } from './generated/events.ts';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
// Onboarding readiness (B5): per-kind install + CLI sign-in state. `signedIn` answers only
// what the kind's own CLI status command says — 'unknown' when the kind has no documented
// non-secret status command or the command gives no answer. Credential files are never read.
export type AgentCliSignIn = 'yes' | 'no' | 'unknown';
// Install readiness: a real runnable binary (`installed`), an auto-install launcher or shim
// such as a mise shim that fetches the agent on first start (`installs-on-first-start`), or
// nothing found (`missing`). One source of truth: `agentInstallState` in agents.ts.
export type AgentInstallState = 'installed' | 'installs-on-first-start' | 'missing';
export type AgentInstallProbe = {
  path?: string[]; aliases?: Record<string, string[]>;
  readFile?: (file: string) => string | undefined;
};
export type AgentReadiness = {
  kind: string; installed: boolean; installState: AgentInstallState; signedIn: AgentCliSignIn;
  installHint: string; signInHint?: string;
};
export type AgentStatusRunner = (command: string, args: string[],
  o?: { stdin?: string; timeoutMs?: number }) => Promise<{ stdout: string } | undefined>;
export type AgentStatusOptions = {
  path?: string[]; aliases?: Record<string, string[]>;
  readFile?: (file: string) => string | undefined;
  run?: AgentStatusRunner; timeoutMs?: number;
};
// `startAgent` lifecycle: `installing` fires before the start when the kind needs an install
// (auto-install launcher/shim or nothing on PATH — apps show "Installing …" instead of a blank
// start), `ready` carries the fresh ref, and `launchFailed` carries a typed reason plus plain
// words. Subscribable per call (`StartAgent.onEvent`, no polling) or app-wide (`onStartAgent`).
export type AgentLaunchFailureReason = 'placement-failed' | 'pane-busy' | 'install-failed' | 'start-rejected';
export type AgentStartEvent =
  | { phase: 'installing'; kind: string; message: string }
  | { phase: 'ready'; kind: string; ref: AgentRef }
  | { phase: 'launchFailed'; kind: string; reason: AgentLaunchFailureReason; message: string };
export type AgentRef = { paneId: string; name?: string };
export type StartAgent = {
  kind: string; cwd: string; name?: string;             // name: /^[a-z][a-z0-9_-]{0,31}$/
  place: { workspace: 'new'; label?: string } | { tab: 'new'; workspaceId: string; label?: string }
       | { split: string; direction: 'right' | 'down' } | { pane: string };
  worktree?: { branch?: string; base?: string };
  args?: string[]; env?: Record<string, string>; timeoutMs?: number;   // default 60_000
  onEvent?: (e: AgentStartEvent) => void;   // per-call lifecycle: installing/ready/launchFailed
  installProbe?: AgentInstallProbe;          // install detection overrides (tests use fakes)
};
export type OpenSignInTab = Omit<StartAgent, 'place' | 'worktree'> & { workspaceId: string; label?: string };
export type MoveToAccount = {
  provider: 'claude' | 'codex'; folder: string; env?: Record<string, string>;
  direction?: 'right' | 'down'; timeoutMs?: number;
};
export type MoveResult = { ok: true; session: string } | {
  ok: false; code: 'too_early' | 'busy' | 'unsupported' | 'env_mismatch' | 'close_failed' | 'start_failed';
  message: string; live?: string;
};
export type PromptReceipt = { paneId: string; terminalId: string; revision: number; status: AgentStatus;
  agentSession?: AgentSessionRef };
export type BlockedAgent = { paneId: string; workspaceId: string; tabId: string; kind?: string; revision: number; prompt: string; since: number };
export type AgentSessionRef = { source: string; agent: string; kind: string; value: string };
export type HerdrSnapshotWorktree = {
  repoKey: string; repoName: string; repoRoot: string; checkoutPath: string; isLinkedWorktree: boolean;
};
export type HerdrSnapshotAgent = {
  kind?: string; name?: string; displayAgent?: string; title?: string; status: AgentStatus; revision: number;
  launchPending?: boolean; interactiveReady?: boolean; agentSession?: AgentSessionRef; foregroundCwd?: string;
};
export type HerdrSnapshotPane = {
  id: string; cwd?: string; label?: string; focused: boolean; terminalTitle?: string;
  tokens?: Record<string, string>; agent?: HerdrSnapshotAgent;
};
export type HerdrSnapshotTab = { id: string; label: string; panes: HerdrSnapshotPane[] };
export type HerdrSnapshotWorkspace = {
  id: string; label: string; focused: boolean; number: number;
  tokens?: Record<string, string>; worktree?: HerdrSnapshotWorktree; tabs: HerdrSnapshotTab[];
};
export type HerdrSnapshot = {
  connected: boolean;
  workspaces: HerdrSnapshotWorkspace[];
};
export type TerminalSession = {
  ready: Promise<void>; onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
  pause(): void; resume(): void;   // stop/restart reading the child's stdout: backpressure reaches Herdr
  exited: Promise<{ code: number | null; stderrTail: string }>;
};
