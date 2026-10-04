// Browser sign-in handoff and live view: the portable typed interface (docs/runtime-kits.md 5.17, D20).
// Types only, no runtime: the broker, host, kit wiring, link ops and device client are built by O18-O25 against these
// shapes. Handoff stays refused (BrowserState why 'handoff-unprotected') until parked sessions are protected (5.17).

import type { Member } from './types.ts';

// ---------------------------------------------------------------------------------------------
// 1. Browser identity and state (portable)
// ---------------------------------------------------------------------------------------------

/** What a live view shows. A browser source never claims to be a whole computer. */
export type LiveSource =
  | { kind: 'browser'; member: Member } // the member's kit-owned browser: its active agent tab, or the private sign-in tab
  | { kind: 'desktop'; member: Member; source: 'host' | 'node' | 'environment' }; // engine desktop.observe pass-through;
  // whole screen, needs a display + engine opt-in, NO agent lock: never offers sign-in takeover.

/** One member's kit-owned browser: one Chromium process + one profile per member, inside one kit (one person). */
export type BrowserState = {
  member: Member;
  phase: 'off' | 'starting' | 'ready' | 'recovering' | 'fenced' | 'blocked';
  // fenced: a sign-in request is waiting/held/checking; the agent is fenced at the tool pre-gate AND the CDP broker.
  why?: 'no-browser' | 'recovery-exhausted' | 'engine-detached' | 'unsafe-tools' | 'gate-off' | 'handoff-unprotected';
  // handoff-unprotected: browser and live view run, but sign-in handoff is refused (no NeedSignIn is raised, no session
  // is parked) until parked sessions are protected: R1's O17 opt-out landed and qualified, or the kit's
  // before_agent_run recovery refusal proven. An `indeterminate` label alone does not stop a recovery turn.
  // unsafe-tools: SOME agent sharing this engine/OS user (any member, account agent, subagent/delegate or plugin
  // agent, browser member or not) can reach a tool outside the kit's closed safe set; unknown/custom tools count as
  // unsafe. The kit refuses every browser in the kit. Separate-OS-user sandboxing is not accepted as a claim in v1.
  // gate-off: KitOptions.gateBuiltins === false with browser on; refused at construction.
  recovery?: { attempt: number; of: number; nextAt?: number }; // bounded: of <= 3
};

// ---------------------------------------------------------------------------------------------
// 2. Need sign-in (capability A)
// ---------------------------------------------------------------------------------------------

/** Display hints read from the page by the host (button text, input types). Never from the model. */
export type SignInMethodHint = 'password' | 'google' | 'microsoft' | 'apple' | 'sso' | 'passkey' | 'code' | 'other';

export type SignInReason =
  | 'redirected-to-login' // the agent tab's main-frame redirect chain ended on a login-looking page
  | 'password-field' // a visible password input in the agent tab's main frame
  | 'http-401' // the main-frame document answered 401/407
  | 'agent-asked' // the agent called request_sign_in (its note is shown only as quoted agent text)
  | 'session-expired'; // an origin in the member's verified set redirected to its login again

export type SignInChoice =
  | { kind: 'takeover' } // the person signs in on the real site in a private tab streamed only to them
  | { kind: 'not-now' } // park: task stays needs_you, the agent is not resumed, nothing polls
  | { kind: 'cancel' }; // settle 'cancelled'

export type SettledState = 'verified' | 'entered-unverified' | 'cancelled' | 'expired' | 'failed';
export type SettledReason =
  | 'still-signed-out' | 'origin-mismatch' | 'browser-gone' | 'superseded' | 'check-timeout' | 'run-replaced'
  | 'no-verifier'; // no host SiteVerifier for this exact origin: a clean page is NOT proof, so entered-unverified

/** Resume bookkeeping for a verified request. Persisted BEFORE dispatch; never claims exactly-once. */
export type ResumeState = {
  key: string; // unique action key `signin:<id>:resume:<attempt>:<uuid>`, passed as RunSpec.idempotencyKey (= engine runId)
  attempt: number; // 1-based; a new attempt only by an explicit person action, or by the gated rule below
  state: 'pending' | 'accepted' | 'submitted' | 'indeterminate' | 'failed';
  // pending:       key/session/attempt persisted; dispatch not acknowledged. A transport-unknown outcome becomes
  //                indeterminate even if the engine process is alive: the R2 cache is evictable, liveness is not proof.
  // accepted:      the engine answered accepted for this key.
  // submitted:     UNBUILT SEAM: the kit plugin's before_agent_run gate durably recorded this exact runId reaching
  //                model submission on sessionKey (and blocks every other run on that session while resume is open).
  // indeterminate: a crash/restart left pending/accepted without proof either way. Surfaced as needs_you; the kit
  //                NEVER redispatches automatically unless the submitted seam is proven (the engine's dedupe cache is
  //                in-memory, evictable and dies with its process).
  // failed:        the engine refused before acceptance (definite); needs_you with a person-driven retry.
};

export type NeedSignIn = {
  id: string; // kit-minted, 128-bit, url-safe
  gen: number; // bumps on reopen/lapse/rebind; every action echoes it; stale => refused 'stale' (SignInRefusedWhy)
  prev?: string; // id of the settled request this one retries
  member: Member;
  sessionKey: string; // the single session the request parks and (on verified) resumes
  origin: string; // scheme://host[:port] read by the host from the agent tab at raise; the ONLY location devices see
  site: string; // registrable domain ("example.com"); the host itself for IP/localhost origins
  secure: boolean; // https or loopback; a non-https non-loopback origin offers no takeover (refused 'insecure-remote')
  firstTime: boolean; // site not in the member's verified set: the person must type/pick the site to take over
  reasons: SignInReason[];
  agentNote?: string; // <= 140 chars plain text; render only as quoted agent words, never as title/method/button
  hints: SignInMethodHint[];
  choices: SignInChoice[]; // takeover omitted when no control is possible (blocked browser, desktop source)
  state: 'waiting' | 'held' | 'checking' | 'parked' | 'settled';
  // waiting:  raised; bound session aborted and parked (0 model calls in THAT session); agent fenced member-wide.
  // held:     the lease holder signs in in a private tab no fenced client can see or attach; others see 'private'.
  // checking: Done pressed; controller closed; host verifies (bounded, checkMs); agent still fenced.
  // parked:   Not now. Private tab(s) closed BEFORE the fence lifts; reopen() re-runs the full raise sequence.
  // settled:  terminal, exactly once, persisted; private tab(s) closed BEFORE the fence lifts.
  settled?: { state: SettledState; reason?: SettledReason; at: number; resume?: ResumeState };
  // resume only for verified (positive SiteVerifier proof). See ResumeState and report §6.3.
  at: number;
  expires: number; // waiting/held TTL (default 30 min; reset by reopen/retry); expiry => settled 'expired', no resume
};
// Host-only, never on the wire: checkUrl (the full URL the agent was trying to reach, pre-redirect), agentTargetId,
// privateTargetIds, verified-site set, confirmed-origin set for the current lease.

/** The single controlling viewer's lease. Bound to the grant that took it. */
export type TakeoverLease = {
  requestId: string;
  gen: number;
  epoch: number; // per member browser, monotonic; stale epochs refused everywhere
  nonce: string; // 128-bit; never logged or evented
  expires: number; // 10 min, renewed by the live stream keepalive
  claimMs: number; // first-attach window (default 60 s) after takeover()
  graceMs: number; // reattach window after a drop (default 30 s)
  // Claim/grace lapse: private tab(s) closed, request -> waiting with gen+1, agent STAYS fenced.
};

// ---------------------------------------------------------------------------------------------
// 3. Live view (capability B)
// ---------------------------------------------------------------------------------------------

export type LiveViewState = {
  source: LiveSource;
  phase: 'connecting' | 'live' | 'reconnecting' | 'private' | 'ended' | 'failed';
  // private: a sign-in is waiting/held/checking for this member and this viewer is not the lease holder.
  mode: 'observe' | 'control';
  origin?: string; // current main-frame origin of what is shown, updated on every navigation
  secure?: boolean;
  offOrigin?: boolean; // control: main frame on an origin not exactly equal to the bound origin, an exact knownIdps
  // entry or an exact origin confirmed for this lease; input paused until confirmOrigin. The displayed origin is a
  // fact about the address bar, never proof that the site is legitimate.
  leaseExpires?: number;
  why?: 'revoked' | 'expired' | 'stale-epoch' | 'superseded' | 'browser-gone' | 'unsupported';
};

/** JPEG frame on the link stream. Never written to disk, logs, transcripts, relay jobs or telemetry. */
export type LiveFrame = { seq: number; w: number; h: number; at: number; jpeg: Uint8Array };

/** Lease holder only, private tab only. Never logged; never in errors or events. */
export type LiveInput =
  | { kind: 'pointer'; type: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; button?: 'left' | 'right' | 'middle'; dx?: number; dy?: number }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code?: string; modifiers?: number }
  | { kind: 'text'; text: string }
  | { kind: 'nav'; action: 'back' | 'forward' | 'reload' };

export type ThumbnailResult = { state: 'ok'; frame: LiveFrame } | { state: 'private' | 'off' | 'unsupported' };

export type SignInRefusedWhy =
  | 'stale' | 'not-found' | 'held-by-other' | 'lease-expired' | 'not-control' | 'not-lease-holder'
  | 'confirm-site' | 'already-open' | 'insecure-remote' | 'unsupported';

// ---------------------------------------------------------------------------------------------
// 4. Host API (`.`, Node only)
// ---------------------------------------------------------------------------------------------

export type BrowserOptions = {
  executablePath: string; // explicit Chromium/Chrome; no downloads, no discovery of the person's browser
  members: Member[] | 'all';
  requestTtlMs?: number; // 30 min
  leaseTtlMs?: number; // 10 min
  claimMs?: number; // 60 s
  graceMs?: number; // 30 s
  checkMs?: number; // 30 s
  recovery?: { attempts: number; backoffMs: number[] }; // 3, [1000, 5000, 15000]
  knownIdps?: string[]; // EXACT origins (scheme://host[:port]) that do not pause input; no wildcard, no registrable-
  // domain or tenant trust. Default: https://accounts.google.com, https://login.microsoftonline.com,
  // https://login.live.com, https://appleid.apple.com, https://github.com. Tenant IdPs (Okta, Auth0, ...) need
  // an exact entry or a per-lease confirmOrigin.
  verifiers?: SiteVerifier[]; // without one for the bound origin, done() settles entered-unverified ('no-verifier')
};

/** Host-only positive proof that the browser session is signed in. Run by the host in a host-only tab after Done;
 * the result is a boolean plus a reason code. No page text, cookie, header or value leaves it; never evented,
 * logged or shown to a model. A login-free page or a clean 200 alone never counts. */
export type SiteVerifier = {
  origin: string; // exact origin it applies to
  url: string; // same-origin URL loaded in the host-only tab
  // all present conditions must hold, and the final URL must stay on `origin`:
  status?: number; // e.g. an authenticated JSON endpoint answering 200 (and the anonymous form answering 401)
  selector?: string; // CSS selector that exists only when signed in (account menu, avatar)
  check?: (probe: { url: string; status: number; exists(selector: string): Promise<boolean> }) => Promise<boolean>; // host code
};
// Preconditions checked at start (else BrowserState.blocked for every member): gateBuiltins !== false; the effective
// tool policy of EVERY agent the engine can run (all members and account agents, subagents/delegates, plugin
// agents; browser or not) is a subset of the kit's closed safe set (browser, request_sign_in, the app's bridge tools,
// and engine tools the kit lists as file/exec/network-free); any unknown or custom tool fails closed. The pre-gate also
// denies exec/process/code_execution/bash/terminal/read/write/edit/apply_patch/gateway for every agent while the
// browser feature is on. The trusted host/operator (the app's own code holding typed pass-through) stays outside this
// model-facing boundary.

export interface BrowserHost {
  state(member: Member): BrowserState;
  signIns(member?: Member): NeedSignIn[];
  takeover(id: string, gen: number, by: { grant: string; confirmSite?: string }): Promise<TakeoverLease>;
  confirmOrigin(lease: Pick<TakeoverLease, 'requestId' | 'epoch' | 'nonce'>, origin: string): void;
  done(lease: Pick<TakeoverLease, 'requestId' | 'epoch' | 'nonce'>): Promise<NeedSignIn>; // -> checking -> settled
  notNow(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn>; // lease holder only while held
  reopen(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn>; // parked -> waiting (full raise sequence)
  retry(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn>; // settled non-verified -> new request (prev)
  cancel(id: string, gen: number, by: { grant: string }): Promise<NeedSignIn>; // lease holder only while held
  thumbnail(source: LiveSource, by: { grant: string }): Promise<ThumbnailResult>;
  live(source: LiveSource, o: { grant: string; lease?: TakeoverLease; maxWidth?: number },
    on: { state(s: LiveViewState): void; frame(f: LiveFrame): void }): { input(i: LiveInput): void; close(): void };
  forget(member: Member, site: string | 'all', by: { grant: string }): Promise<void>; // clear site data; drop from verified set
}
// Kit: `new OpenClawKit({ ..., browser?: BrowserOptions })`, `kit.browser?: BrowserHost`; kit.onEvent gets
// { event: 'byokit.browser', payload: { member, kind: 'state' | 'signin' } } emitted by the kit itself
// (invalidation ping only: no origin, no URL).

// ---------------------------------------------------------------------------------------------
// 5. Link ops (`./link`) and device client (`./device`)
// ---------------------------------------------------------------------------------------------
// view:    oc.browser.state, oc.browser.signins, oc.browser.thumb, stream oc.browser.live {mode:'observe'}
// control: oc.browser.{takeover, confirmorigin, done, notnow, reopen, retry, cancel, forget},
//          stream oc.browser.live {mode:'control', lease} (lease minted for this grant; the stream is the keepalive)
// All member-checked via memberOf(grant); revoke closes streams and lapses leases at once.
// With browser on, ./link refuses oc.call for browser.request, terminal.*, tools.invoke whatever passThrough says.
// Push: a sealed notice {id, gen, member, site} (notice source 'signin'); never authorization.

export type BrowserDevice = {
  state(member: Member): Promise<BrowserState>;
  signIns(): Promise<NeedSignIn[]>;
  takeover(id: string, gen: number, o?: { confirmSite?: string }): Promise<TakeoverLease>;
  confirmOrigin(lease: TakeoverLease, origin: string): Promise<void>;
  done(lease: TakeoverLease): Promise<NeedSignIn>;
  notNow(id: string, gen: number): Promise<NeedSignIn>;
  reopen(id: string, gen: number): Promise<NeedSignIn>;
  retry(id: string, gen: number): Promise<NeedSignIn>;
  cancel(id: string, gen: number): Promise<NeedSignIn>;
  forget(member: Member, site: string | 'all'): Promise<void>;
  thumbnail(source: LiveSource): Promise<ThumbnailResult>;
  live(source: LiveSource, o?: { lease?: TakeoverLease; maxWidth?: number }): {
    states: AsyncIterable<LiveViewState>; frames: AsyncIterable<LiveFrame>; input(i: LiveInput): void; close(): void;
  };
};

