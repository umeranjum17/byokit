// The kit's public types (docs/runtime-kits.md 6.2). H1 freezes these signatures; the generated method table (H2)
// replaces the placeholder pass-through types below without changing any signature.

export type HerdrState = {
  phase: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'needs-update' | 'missing' | 'failed';
  why?: 'binary' | 'socket' | 'version' | 'server-exited';
};

export type HerdrKitOptions =
  | { mode: 'adopt'; bin: string; socketPath: string; transport?: HerdrTransport; onState?: (s: HerdrState) => void }
  | { mode: 'own'; bin: string; stateDir: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; onState?: (s: HerdrState) => void };

export interface HerdrTransport {                        // socket.ts implements it; the fake does too
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  subscribe(subs: { type: string; [k: string]: unknown }[], on: (e: HerdrEvent) => void,
            onError: (code: string, message: string) => void): () => void;   // own socket per call
  close(): void;
}

export type HerdrEvent = { type: string; [k: string]: unknown };

// Pass-through typing (docs/runtime-kits.md 4.6). Until H2 generates the table from the pinned schema snapshot,
// every method is typed `unknown`; `call` and `subscribe` already use these names, so H2 changes nothing else.
export type HerdrMethods = Record<string, { params: unknown; result: unknown }>;
export type HerdrMethod = keyof HerdrMethods;
export type HerdrParams<M extends HerdrMethod> = HerdrMethods[M]['params'];
export type HerdrResult<M extends HerdrMethod> = HerdrMethods[M]['result'];
export type HerdrEventName = string;
export type HerdrEventOf<E extends HerdrEventName> = HerdrEvent;
export type HerdrSubscription<E extends HerdrEventName = HerdrEventName> = { type: E; [k: string]: unknown };

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type AgentRef = { paneId: string; name?: string };
export type StartAgent = {
  kind: string; cwd: string; name?: string;             // name: /^[a-z][a-z0-9_-]{0,31}$/
  place: { workspace: 'new'; label?: string } | { tab: 'new'; workspaceId: string; label?: string }
       | { split: string; direction: 'right' | 'down' } | { pane: string };
  worktree?: { branch: string; base?: string };
  args?: string[]; env?: Record<string, string>; timeoutMs?: number;   // default 60_000
};
export type PromptReceipt = { paneId: string; terminalId: string; revision: number; status: AgentStatus };
export type BlockedAgent = { paneId: string; workspaceId: string; tabId: string; kind?: string; revision: number; prompt: string; since: number };
export type HerdrSnapshot = {
  connected: boolean;
  workspaces: { id: string; label: string; tabs: { id: string; label: string; panes: {
    id: string; cwd?: string;
    agent?: { kind?: string; name?: string; status: AgentStatus; revision: number; launchPending?: boolean; interactiveReady?: boolean };
  }[] }[] }[];
};
export type TerminalSession = {
  ready: Promise<void>; onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
  exited: Promise<{ code: number | null; stderrTail: string }>;
};
