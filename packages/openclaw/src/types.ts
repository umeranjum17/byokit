// Public types for the OpenClaw runtime kit (docs/runtime-kits.md 5.2). Types only; behavior lives in the modules.

export type Member = string; // /^[a-z][a-z0-9-]{0,31}$/, = OpenClaw agentId (D9)

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object; // JSON Schema object
}

export interface RunRef {
  sessionKey: string;
  member: Member;
  meta?: unknown;
}

export type GateResult =
  | { allow: true }
  | { allow: false; reason: string }
  | { ask: { summary: string } }; // kit parks the call as an Approval

export interface ToolHost {
  gate(run: RunRef, tool: string, input: Record<string, unknown>): Promise<GateResult>;
  call(run: RunRef, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface RunSpec extends RunRef {
  message: string;
  system?: string;
  images?: { data: string; mimeType: string }[];
  thinking?: 'off' | 'low' | 'medium' | 'high';
  register?: boolean; // default true: the bridge recognizes this run
}

export type RunEvent =
  | { type: 'text'; text: string } // cumulative assistant text
  | { type: 'tool'; name: string; phase: 'start' | 'end' };

export type RunEnd =
  | { ok: true; text: string }
  | { ok: false; aborted: true }
  | { ok: false; kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number; message: string };

export type SignInView = {
  state: 'waiting' | 'done' | 'failed';
  via: 'browser' | 'code';
  url?: string;
  code?: string;
  error?: string;
  why?: 'busy' | 'declined' | 'expired' | 'failed';
};

export type Approval = {
  id: string; // kit-minted, url-safe
  source: 'gate' | 'exec' | 'plugin' | 'question';
  member: Member;
  sessionKey?: string;
  tool?: string;
  summary: string;
  input?: unknown;
  at: number;
  expires: number;
};

export type Decision = { allow: boolean; reason?: string; answer?: unknown }; // answer: question.* only

export type KitState = {
  phase: 'stopped' | 'installing' | 'starting' | 'repairing' | 'ready' | 'restarting' | 'failed' | 'needs-update';
  why?: 'install' | 'handshake' | 'exited' | 'port' | 'version';
  retryAt?: number;
};

export type Hello = { protocol: number; server: { version: string }; methods: string[]; events: string[] };

export type Route = {
  choice: string;
  provider: string;
  plugin: string; // the bundled openclaw.plugin.json id that owns the choice; '' for a core static choice
  billing: 'subscription' | 'api' | 'local';
  via: 'browser' | 'code';
  prerequisite: string | null;
  offer: boolean;
  reason: string;
  source: string;
};

export interface GatewayTransport {
  start(): Promise<Hello>;
  request(method: string, params?: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  onEvent(fn: (e: { event: string; payload?: unknown }) => void): () => void;
  onClose(fn: (why: string) => void): () => void;
  stop(): Promise<void>;
}

export type CallOptions = { timeoutMs?: number; signal?: AbortSignal };

// Pass-through typing (4.6): re-exports of the generated method/event tables (O2 fills the tables, these names are
// frozen by 5.3).
export type { GatewayMethod, GatewayParams, GatewayResult } from './generated/methods.ts';
export type { GatewayEventName, GatewayEventPayload } from './generated/events.ts';
