// Public types for the OpenClaw runtime kit (docs/runtime-kits.md 5.2). Types only; behavior lives in the modules.
import type { OutputSchema } from './output.ts';
export type { OutputSchema, SchemaOutput } from './output.ts';

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
  // Every tool call reaches gate unless KitOptions.gateBuiltins is false; builtin: the engine's own tool (web_fetch,
  // memory, ...), not one of KitOptions.tools, so it runs in the engine and call is never invoked for it.
  gate(run: RunRef, tool: string, input: Record<string, unknown>, info: { builtin: boolean }): Promise<GateResult>;
  call(run: RunRef, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface RunSpec<S extends OutputSchema | undefined = OutputSchema | undefined> extends RunRef {
  message: string;
  schema?: S; // JSON Schema subset: locally validated; unsupported keywords refused before a run
  system?: string;
  images?: { data: string; mimeType: string }[];
  thinking?: 'off' | 'low' | 'medium' | 'high';
  // `provider/model` (e.g. 'openai/gpt-5.1'): the member's signed-in account and model this run calls and bills,
  // this run only. `provider` is the id `providers(member)` reports; one not signed in ends `signed-out` before any
  // call. Absent: the engine's own selection.
  model?: string;
  /** Explicit paid key choice. Uses a separate member-owned agent and separate session history. */
  auth?: 'apiKey';
  // The app tools (KitOptions.tools names) this run may call; any other app tool is refused at the gate before
  // ToolHost.gate. Engine builtins are unaffected. A name the kit does not register is refused before any request.
  // Absent: every app tool.
  tools?: string[];
  register?: boolean; // default true: the bridge recognizes this run
}

export type RunEvent =
  | { type: 'text'; text: string } // cumulative assistant text
  | {
    type: 'tool';
    name: string;
    phase: 'start' | 'end';
    id?: string; // the engine's toolCallId: pairs a start with its end
    input?: Record<string, unknown>; // start: the call's arguments as the engine reports them (strings redacted)
    output?: unknown; // end: the engine's tool result (text content capped by the engine)
    error?: boolean; // end: the engine counts the call failed (a gate deny included)
  };

/** Token usage of one run as the engine totals it (every model call of the run, compaction included). */
export type RunUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
  costUsd?: number; // only when the engine has a price for the model
};

/** A subscription's quota windows, as the engine last read them from the provider (never estimated by the kit). */
export type PlanWindow = {
  provider: string;
  plan?: string; // e.g. 'plus'
  windows: { label: string; usedPercent: number; resetAt?: number }[]; // usedPercent 0-100; resetAt epoch ms
};

export type RunEnd<T = unknown> =
  | { ok: true; text: string; data?: T; usage?: RunUsage; planWindow?: PlanWindow } // data: validated schema; usage/window: engine reports
  | { ok: false; aborted: true }
  | { ok: false; kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other' | 'output'; until?: number; message: string };

export type SignInOptions = { authChoice: string; via?: 'browser' | 'code'; signal?: AbortSignal };

export type SignInView = {
  state: 'waiting' | 'done' | 'failed';
  via: 'browser' | 'code';
  url?: string;
  code?: string;
  prompt?: string; // a secret-entry label, never its value
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
  phase: 'stopped' | 'installing' | 'starting' | 'repairing' | 'ready' | 'restarting' | 'failed' | 'needs-update' | 'locked';
  why?: 'install' | 'handshake' | 'exited' | 'port' | 'version' | 'engine-already-running';
  retryAt?: number;
};

export type Hello = { protocol: number; server: { version: string }; methods: string[]; events: string[] };

export type Route = {
  choice: string;
  provider: string;
  plugin: string; // the bundled openclaw.plugin.json id that owns the choice; '' for a core static choice
  billing: 'subscription' | 'api' | 'local' | 'free' | 'unknown';
  auth?: 'cli' | 'api_key' | 'token';
  terms?: 'allowed' | 'grey';
  termsUrl?: string;
  via: 'browser' | 'code' | 'paste' | 'key' | 'setup_token' | 'cli' | 'plan_key' | 'cloud' | 'local' | 'endpoint';
  prerequisite: string | null;
  offer: boolean; // compatibility: true only for a ready default subscription route
  id?: string;
  name?: string;
  company?: string;
  aliases?: string[];
  offerPolicy?: 'default' | 'explicit';
  legacy?: { provider: string; via: 'browser' | 'code' }; // retained explicit sign-in selectors
  billingFrom?: 'source' | 'host';
  group?: 'models' | 'services';
  platforms?: { node: 'yes' | 'host' | 'no'; browser: 'yes' | 'host' | 'no'; rn: 'yes' | 'host' | 'no' };
  needs?: { binary?: string; plugin?: string; client?: string };
  install?: { npmSpec?: string; clawhubSpec?: string; minHostVersion?: string };
  upstream?: { surface: 'openclaw'; id: string; method?: string; revision: string; flow: 'present' | 'absent' };
  readiness?: 'ready' | 'needs_binary' | 'needs_plugin' | 'needs_host' | 'needs_client' | 'unsupported_platform' | 'no_upstream_flow';
  why?: string;
  reason: string;
  source: string;
  revision: string;
  checked: string;
  label: string;
  keyEntry: boolean;
  keyErrors: { invalid: 'key.invalid'; not_included: 'key.notIncluded' } | null;
};

export interface GatewayTransport {
  start(): Promise<Hello>;
  // expectFinal: resolve with the method's final response, handing an interim `status: 'accepted'` to onAccepted.
  request(method: string, params?: unknown, o?: {
    timeoutMs?: number | null; signal?: AbortSignal; expectFinal?: boolean; onAccepted?: (payload: unknown) => void;
  }): Promise<unknown>;
  onEvent(fn: (e: { event: string; payload?: unknown }) => void): () => void;
  onClose(fn: (why: string) => void): () => void;
  stop(): Promise<void>;
}

export type CallOptions = { timeoutMs?: number | null; signal?: AbortSignal };

// Pass-through typing (4.6): re-exports of the generated method/event tables (O2 fills the tables, these names are
// frozen by 5.3).
export type { GatewayMethod, GatewayParams, GatewayResult } from './generated/methods.ts';
export type { GatewayEventName, GatewayEventPayload } from './generated/events.ts';
