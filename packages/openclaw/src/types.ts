// Public types for the OpenClaw runtime kit (docs/runtime-kits.md 5.2). Types only; behavior lives in the modules.
import type { OutputSchema } from './output.ts';
import type { GatewayEventName, GatewayEventPayload } from './generated/events.ts';
export type { OutputSchema, SchemaOutput } from './output.ts';

export type Member = string; // /^[a-z][a-z0-9-]{0,31}$/, = OpenClaw agentId (D9)

/** The engine's learning mode: config key `skills.workshop.autonomous.mode` (5.6). */
export type LearningMode = 'off' | 'propose' | 'auto';

/** Exactly what `learning()` saw: absence is a value, not "probably default" (5.6). */
export type LearningCapture = { present: false } | { present: true; mode: LearningMode };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object; // JSON Schema object
}

export interface RunRef {
  sessionKey: string;
  member: Member;
  // A helper of `member` (5.8.3): on a RunSpec, the ensured helper the run speaks as (its persona is the system text,
  // its key `agent:<member>:h-<helper>:…`); on a gated or called RunRef, the helper the run belongs to. Absent: the member.
  helper?: string;
  meta?: unknown;
  runId?: string;
  agentId?: string;
  parent?: { sessionKey: string; runId: string };
  root?: { sessionKey: string; runId: string };
}

/** One of a member's helpers (5.8.3): its own persona and sessions (`sessionPrefix`) on `account`, run by `agentId`, the
 * engine agent already holding that sign-in. */
export type Helper = { member: Member; helper: string; account: AccountId; agentId: string; sessionPrefix: string };

export type DelegatedRun = RunRef & Required<Pick<RunRef, 'runId' | 'agentId' | 'parent' | 'root'>>;
export type DelegatedEvent = { type: 'admitted' | 'event' | 'ended'; run: DelegatedRun;
  reason?: 'terminal' | 'cancelled'; event?: { stream: string; data?: Record<string, unknown> } };

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
  /** Stable per-dispatch action key; omit for a fresh UUID. Gateway-wide across agents/sessions for `agent`.
   * Reuse only for the same input/attempt. In-memory bounded cache, not exactly-once across engine restarts. */
  idempotencyKey?: string;
  schema?: S; // JSON Schema subset: locally validated; unsupported keywords refused before a run
  system?: string;
  images?: { data: string; mimeType: string }[];
  thinking?: 'off' | 'low' | 'medium' | 'high';
  // `provider/model` (e.g. 'openai/gpt-5.1'): the member's signed-in account and model this run calls and bills,
  // this run only. `provider` is the id `providers(member)` reports; one not signed in ends `signed-out` before any
  // call. Absent: the engine's own selection.
  model?: string;
  // 5.15: the account this run uses ('auto' ranks by room, 'default' is the saved default); with it, `model` is a
  // model of that account. `needs`: every other 'provider/model' the run may call; alone it resolves as 'default'.
  // Both absent: exactly the member agent's run it was before.
  account?: AccountRef | 'default' | 'auto';
  needs?: string[];
  /** Explicit paid key choice. Uses a separate member-owned agent and separate session history. */
  auth?: 'apiKey';
  // The app tools (KitOptions.tools names) this run may call; any other app tool is refused at the gate before
  // ToolHost.gate. Engine builtins are unaffected. A name the kit does not register is refused before any request.
  // Absent: every app tool.
  tools?: string[];
  /** Exact target engine agent IDs and their app-tool subsets; does not share credentials. */
  delegates?: Record<string, string[]>;
  /** The member's ensured helpers (5.8.3) this run may hand work to, and their app-tool subsets: an exact native send to
   * `agent:<the helper's agent>:h-<helper>:<rest>` is admitted as that helper's run (RunRef.helper). */
  helperDelegates?: Record<string, string[]>;
  register?: boolean; // default true: the bridge recognizes this run
}

export type RunEvent = { seq: number } & (
  | { type: 'started' } // the Gateway accepted the run, not answer completion
  | { type: 'thinking'; tokens: number } // actual engine progressTokens, not text or estimated usage
  | { type: 'account'; account: AccountId; model: string; sessionKey: string; // 5.15: first event of a run on an
    how: 'chosen' | 'default' | 'auto'; why: PickWhy; considered: Considered[] } // account, before the `agent` request
  | { type: 'text'; text: string } // cumulative assistant text
  | {
    type: 'tool';
    name: string;
    phase: 'start' | 'end';
    id?: string; // the engine's toolCallId: pairs a start with its end
    input?: Record<string, unknown>; // start: the call's arguments as the engine reports them (strings redacted)
    output?: unknown; // end: the engine's tool result (text content capped by the engine)
    error?: boolean; // end: the engine counts the call failed (a gate deny included)
  });

export type RunFrame = RunEvent | { type: 'end'; seq: number; end: RunEnd }
  | { type: 'truncated'; reason: 'truncated' | 'not-found'; firstSeq?: number };

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

/** Thinking levels a run may ask for (`RunSpec.thinking`) and the level the kit actually sent. */
export type ThinkingAsked = 'off' | 'low' | 'medium' | 'high';
export type ThinkingUsed = ThinkingAsked | 'minimal' | 'xhigh' | 'max';
export type ThinkingReport = { asked: ThinkingAsked; used: ThinkingUsed };

export type RunEnd<T = unknown> =
  | { ok: true; text: string; data?: T; usage?: RunUsage; planWindow?: PlanWindow; // data: validated schema; usage/window: engine reports
    account?: AccountId; model?: string; // both exactly when the run used an account (5.15); model '' only when neither the pick nor the engine names one
    thinking?: ThinkingReport } // present when the run asked for a thinking level; used may be clamped to the catalog
  | { ok: false; aborted: true }
  | { ok: false; kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other' | 'output'; until?: number; message: string };

export type SignInOptions = { authChoice: string; via?: 'browser' | 'code'; signal?: AbortSignal };

export type SignInView = {
  state: 'waiting' | 'done' | 'failed';
  via: 'browser' | 'code';
  url?: string;
  code?: string;
  expiresAt?: number; // epoch ms when `code` expires, when the engine says
  message?: string; // the engine's instructions shown with `code`
  prompt?: string; // what a waiting text step asks, answered through paste: the engine's question, or a fixed label once sensitive; never a value
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
  why?: 'install' | 'handshake' | 'exited' | 'port' | 'version' | 'engine-already-running' | 'engine-patch' | 'sign-in-reset' | 'auth-store-unreadable' | 'auth-store-seal-size';
  retryAt?: number;
  sealSize?: { size: number; cap: number; file?: string }; // bytes; with why 'auth-store-seal-size', size is a lower bound, and file names an over-cap engine store
  patchSet?: string | null; // verified bundled set; null = unknown provenance
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
  /** @deprecated This route's `provider` before 0.7.0 (`anthropic` on `anthropic-cli`); use `provider` (`claude-cli`).
   * Discovery data only, never a sign-in or `signedIn` id. Removed in 0.9.0, when that route's id becomes
   * `claude-cli:cli:anthropic-cli`. */
  deprecatedProvider?: string;
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

/** A chat on a channel the kit turned on (5.18): `id` is the channel's own chat id. `kit.reply` takes it back. */
export type ChannelChat = { channel: 'telegram'; id: string };
/** One inbound channel message. The kit claims it before the engine dispatches, so no agent runs from a channel. */
export type ChannelMessage = { chat: ChannelChat; from: string; text: string };
/** `KitOptions.channels.telegram` (5.18): a bot's direct messages from listed people, handed to the app only. */
export type TelegramChannel = {
  token: string; // the bot's BotFather token: the engine gets it as process env, never config, disk or logs
  allowFrom: readonly string[]; // numeric Telegram user ids allowed to message the bot; every other sender is dropped
  member: Member; // the member the app answers as: kit.reply sends as its agent (in Crewhouse, Chief's member)
  apiRoot?: string; // Bot API root, default https://api.telegram.org (a self-hosted Bot API server, or a test fake)
  onMessage(message: ChannelMessage): void;
};

/** Kit-owned invalidation only: no origin, URL, input value or lease secret. */
export type BrowserPing = { member: Member; kind: 'state' | 'signin' };
export type KitEventName = GatewayEventName | 'byokit.browser' | 'byokit.delegated';
export type KitEventPayload<E extends KitEventName> = E extends 'byokit.delegated' ? DelegatedEvent
  : E extends 'byokit.browser' ? BrowserPing
  : GatewayEventPayload<Extract<E, GatewayEventName>>;

// Pass-through typing (4.6): re-exports of the generated method/event tables (O2 fills the tables, these names are
// frozen by 5.3).
export type { GatewayMethod, GatewayParams, GatewayResult } from './generated/methods.ts';
export type { GatewayEventName, GatewayEventPayload } from './generated/events.ts';

// Account types (5.15), restated structurally from `@byokit/accounts` `multi.ts`, never imported (D3). `AccountPick`
// is `@byokit/accounts`' `Pick`, renamed here because this kit's modules use TypeScript's `Pick<T, K>`.
export type AccountId = string;      // '<provider>': the member agent's sign-in; '<provider>.<hex6>': agent '<member>--<hex6>'
export type AccountRef = AccountId;  // always starts with a provider id, so never 'default' or 'auto'
export type SignInState = 'ready' | 'signing' | 'resting' | 'signed_out' | 'needs_again' | 'not_included';
export type Account = { id: AccountId; provider: string; route: string;        // route = Route.choice it signed in with
  name: string;                      // the person's name for it ("Work"); renameAccount sets it
  label: string;                     // the provider's display name ("ChatGPT")
  email?: string; plan?: string;     // live from models.authStatus usage when reported; never stored by the kit
  billing: 'subscription' | 'api'; state: SignInState; until?: number; addedAt: number };
export type RoomSpan = 'session' | 'week' | 'month' | 'tightest';
export type Room = { left: number; span: RoomSpan; resetsAt?: number; at?: number } | { left: 'unknown'; at?: number };
                                     // left: percent of the tightest applying window left, 0-100; times epoch ms;
                                     // at: when the source read it; absent = age unknown, never a receipt time
export type ModelInfo = { id: string; name: string; tier?: 'strong' | 'fast'; available: boolean;
  why?: 'plan' | 'resting' | 'signed_out'; until?: number };                   // id = 'provider/model'
export type RunSelection = { account: AccountRef | 'default' | 'auto'; model?: string;
  needs?: string[];                  // every other 'provider/model' the run may call (subagents, fallbacks)
  provider?: string };               // limits the choice to one provider; absent = the saved default's provider
export type Defaults = { account?: AccountId; model?: string; auto?: boolean };
export type Considered = { id: AccountId;
  out?: 'state' | 'resting' | 'billing' | 'model' | 'provider' | 'bound';   // why it is not a candidate; absent = one
  until?: number;                                      // out 'resting': until when
  missing?: string;                                    // out 'model': the first demanded 'provider/model' it lacks
  tier?: 'room' | 'unknown' | 'exhausted';            // candidates only: Choosing's tier A, B or C
  left: number | 'unknown'; span?: RoomSpan; resetsAt?: number;
  age: number | 'unknown';                            // ms from the reading's `at` to nowMs
  confidence: 'known' | 'stale' | 'unknown';             // known timestamp, older than 24h, or unmeasured/undated
  reason: PickWhy | 'state' | 'resting' | 'billing' | 'model' | 'provider' | 'bound' };
export type PickWhy = 'chosen' | 'default' | 'first_ready' | 'only' | 'most_room' | 'earlier_reset' | 'list_order' |
  'no_reading' | 'refills_first';
export type AccountPick =
  | { ok: true; account: Account; model: string; how: 'chosen' | 'default' | 'auto'; why: PickWhy; reason: string;
      considered: Considered[] }
  | { ok: false; code: 'none' | 'not_included' | 'unknown_account' | 'bound' | 'paid'; reason: string;
      considered: Considered[] }         // bound/paid: Runs step 2's refusals, reason its `account.*` words
  | { ok: false; code: 'resting'; account: AccountId; until?: number; reason: string; considered: Considered[] };
export type MoveResult = { ok: true; session: string } | { ok: false; code: 'too_early' | 'busy' | 'unsupported' |
  'env_mismatch' | 'close_failed' | 'start_failed'; message: string; live?: string };   // shared with @byokit/herdr
