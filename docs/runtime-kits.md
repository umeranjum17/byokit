# Runtime kits: `@byokit/openclaw` and `@byokit/herdr`

Foundation spec and builder breakdown. Status: **design approved for build; nothing here is implemented yet.**
Direction: the captain's 2026-09-28 afternoon clarification and confirmation (firstmate `data/byokit/direction.md`).
This document is the single source of truth for the build lanes. A builder follows it literally; where it is silent,
the builder stops and asks rather than designs. Section 11 is the work-package list.

Contents: [1 Goal](#1-goal) · [2 Decisions](#2-decisions) · [3 Sources and path drift](#3-sources-and-path-drift) ·
[4 Shared conventions](#4-shared-conventions) · [5 `@byokit/openclaw`](#5-byokitopenclaw) ·
[6 `@byokit/herdr`](#6-byokitherdr) · [7 Connection adapters](#7-connection-adapters) ·
[8 Example apps](#8-example-apps) · [9 Tests, CI and isolation](#9-tests-ci-and-isolation) ·
[10 Extraction and adoption order](#10-extraction-and-adoption-order) · [11 Work packages](#11-work-packages) ·
[12 Known facts builders must not re-derive](#12-known-facts-builders-must-not-re-derive)

## 1. Goal

BYOKit gains two **runtime kits**, one per aggregator. Each owns "use the customer's subscriptions through this
aggregator" and exposes the aggregator's **full** power:

- **`@byokit/openclaw`** supervises a pinned OpenClaw engine in an app-owned isolated state directory, talks to its
  Gateway through the public `@openclaw/gateway-client`/`@openclaw/gateway-protocol` packages, drives OpenClaw's own
  subscription sign-in (subscription and API billing kept distinct, retained logins migrated), runs agent sessions with
  streaming, and bridges app tools, approvals and member boundaries. Extracted from Crewhouse's proven adapter.
- **`@byokit/herdr`** connects to (or owns) a Herdr server: workspaces, tabs, panes, agents, agent state, prompt
  delivery with receipts, output and terminal streaming, blocked-agent approvals. Each coding agent in Herdr keeps its
  own subscription login. Extracted from muxr's Herdr integration.

Both kits: typed helpers for the common paths **plus** a first-class typed pass-through to the complete supported
surface (OpenClaw Gateway operator protocol; Herdr socket API and CLI), so no consumer forks or bypasses the kit.
They share connection adapters (`link`, `relay`, `reach`, `seal`, `ui-core`) and conventions, never a
lowest-common-denominator interface. `@byokit/accounts` is unchanged (direct-provider apps, including Ownvoice).

Out of scope for the build phase: releasing (firstmate/owner runs `release.yml`), muxr adoption (section 10), any
operated service, and any change to `@byokit/accounts`, `link`, `relay`, `reach`, `seal`, `decide` or `ui-core`
source.

## 2. Decisions

These close every design call. Builders do not reopen them; a reviewer who disagrees raises it with firstmate.

| # | Decision |
|---|---|
| D1 | Package names `@byokit/openclaw` and `@byokit/herdr`, in `packages/openclaw` and `packages/herdr`, Apache-2.0, ESM, Node ≥ 22.18, same source rules as the rest of the repo (type-stripped TS, `.ts` imports, no enums/namespaces/parameter properties). |
| D2 | Entries per kit: `.` (Node host side), `./device` (portable: browsers, React Native, Node; no `node:*` or Node-only imports), `./link` (Node host-side link/relay/seal adapter), `./testing` (fakes, contract suites, scripted model). No other entries. |
| D3 | Connection adapters ship **inside each kit** (`./link`, `./device`). No new shared glue package; the ~40 lines of `serve()` wiring are deliberately duplicated per kit (`ponytail:` comment naming the upgrade path: extract when a third runtime kit appears). |
| D4 | OpenClaw engine pin stays **`openclaw@2026.8.1`** with `@openclaw/gateway-client@2026.8.1` and `@openclaw/gateway-protocol@2026.8.1` pinned exactly (Crewhouse parity; protocol version 4). Upgrades follow [5.12](#512-version-pin-and-upgrades). |
| D5 | Herdr pin is **v0.9.1** (latest release on 2026-09-28). The kit bundles that release's `herdr api schema --json` snapshot; a server whose reported protocol differs from the snapshot's is state `needs-update`. muxr, which requires ≥ 0.8.0 today, must move to the kit's pin as a precondition of its later adoption. |
| D6 | "Complete supported surface", OpenClaw: every Gateway method in the pinned engine's method table for the **operator** role (382 in 2026.8.1, including the 12 core methods whose scope is resolved `dynamic`), every Gateway event (55), plus a typed-`unknown` `callDynamic` for names **not** in the table (plugin/channel-registered methods). The 11 `node`-role methods are the other side of the node protocol and are excluded from `call` (listed in the generated table with `role: 'node'`). The kit connects with all seven operator scopes: `operator.read`, `operator.write`, `operator.admin`, `operator.approvals`, `operator.questions`, `operator.pairing`, `operator.talk`. |
| D7 | "Complete supported surface", Herdr: every request method and event in the pinned schema (typed `call`, typed `subscribe`), the raw CLI as `cli(argv)` (complete by construction), and a typed wrapper for the one CLI-only surface the socket lacks (`terminal session control|observe`). |
| D8 | Host-side kit APIs are full-power. Over a link, the pass-through (`oc.call`, `hd.call`) is **denied by default**; an app opts in with a `passThrough(method, grant)` predicate. Typed link ops are always member/scope-checked. |
| D9 | Members. OpenClaw: a member is an app-chosen id matching `/^[a-z][a-z0-9-]{0,31}$/`, used verbatim as the OpenClaw `agentId`; every session key must start `agent:<member>:`; sign-ins are per member (OpenClaw per-agent auth). Herdr: no member concept upstream; a link grant carries `meta.scope = { workspaces: 'all' \| string[] }`. |
| D10 | Approvals. OpenClaw: (a) the kit's fail-closed tool bridge (Crewhouse's plugin hook → unix socket → app `gate()`), extended with a parked `ask` result; (b) OpenClaw's native `exec.approval.*`, `plugin.approval.*`, `question.*` surfaced through the same `Approval` shape. Herdr: an agent in `blocked` state is an approval; the answer is keys sent to that exact pane occupant (revision-checked). |
| D11 | Sign-in. OpenClaw: the kit drives OpenClaw's own `openclaw.setup.auth.start` + `wizard.next` loop and holds the ChatGPT callback port during a browser sign-in; credentials never pass through kit or app. Herdr: each agent CLI's own login, done by the person inside that agent's pane (terminal stream); the kit never runs a login command, never copies credentials between homes, and never reads a CLI's credential files. |
| D12 | Route policy is data, not code: `packages/openclaw/src/routes.json` labels every pinned auth choice (`subscription` / `api` / `local`, prerequisite, `offer`). The kit **labels and never decides for an app** (CONTRIBUTING): `signIn` accepts any pinned auth choice, while the ready-made `./link` and example UI list only `offer: true` routes. Claude-plan routes (`anthropic-cli`, `setup-token`) are `billing: 'subscription'`, `offer: false` with reason "byokit never adds Claude plan sign-in"; an app may still pass them explicitly, though the 2026.8.1 Gateway does not offer them through `openclaw.setup.auth.start`. |
| D13 | Library code reads no environment variables except `PATH`, and only to locate `npm` for the engine install when `npmPath` is not given. Every spawned process gets an explicit env; `process.env` is never inherited. The Herdr binary path is always an explicit option. |
| D14 | `npm test` stays network-free. Tests needing the real engine (network `npm ci` of the pin, loopback only afterwards) run under `npm run test:engine` in a separate CI job `openclaw-engine`. Real-Herdr contract runs happen only in an isolated lab under a `--herdr-lab` brief, never in CI and never against a person's Herdr. |
| D15 | Retained-login migration source for OpenClaw is a Pi `auth.json`-shaped record (`{ [provider]: credential }`): a file path (Crewhouse's legacy engine) or an in-memory record (an app moving from `@byokit/accounts`' `fileStore`/`secureStore`). Retire only after the Gateway itself reports the member signed in to every provider in the source. |
| D16 | Crewhouse adopts first with behavior parity; muxr adopts later in a separate muxr change after the Herdr kit is published and muxr's byokit cutover allows it. Neither adoption is part of the byokit PRs. |

## 3. Sources and path drift

Read-only references, at the commits read for this spec:

| Consumer | Checkout | Commit |
|---|---|---|
| Crewhouse | `umeranjum17/crewhouse` | `a9ca74e` |
| muxr (pockit) | `umeranjum17/muxr` | `c9b790f66` |
| byokit | this repo | `c6c618c` |

### 3.1 Crewhouse OpenClaw adapter

The brief names `src/openclaw/{gateway,runtime,bridge,policy,plugin}`. Actual layout, and what else the adapter needs:

| Brief path | Actual | Lines | Goes to |
|---|---|---|---|
| `gateway` | `src/openclaw/gateway.ts` | 255 | kit `engine.ts`, `config.ts`, `transport.ts` |
| `runtime` | `src/openclaw/runtime.ts` | 360 | kit `signin.ts`, `migrate.ts`, `runs.ts`, `members.ts`; product parts stay in Crewhouse |
| `bridge` | `src/openclaw/bridge.ts` | 95 | kit `bridge.ts` |
| `policy` | **`src/openclaw/policy.mjs`** (not `.ts`) | 52 | kit `policy/policy.mjs`, generalized |
| `plugin` | **directory** `src/openclaw/plugin/` = `index.js` (87), `openclaw.plugin.json` (10), `package.json` (1) | 98 | kit `plugin/`, with tool schemas moved to the app |
| (not named) | `src/openclaw/trusted-skills.json` | 11 | stays in Crewhouse (app data, passed to the kit) |
| (not named) | `src/openclaw/files.ts` (pinned-dirfd file tools) | 74 | stays in Crewhouse (product tool implementation) |
| (not named) | `src/openclaw/bots_git.ts` → `src/bots.ts` `commit` | 3 | stays in Crewhouse (learned-skill capture) |
| (outside) | `src/runtime.ts` `AgentRuntime`/`ToolHost`/`RunSpec`/`RunEvent`/`RunEnd`/`SignInStep` | 45 | kit `types.ts` (generalized) |
| (outside) | `src/failures.ts` `classifyText` | 17 | kit `classify.ts` |
| (outside) | `src/accounts.ts` `holdCallbackPort` (1455 listener, paste) and `src/callback-port.ts` | ~30 | kit `signin.ts` |
| (outside) | `src/crew.ts` `migrateMembers`/`confirmMigrations` orchestration | ~30 | kit `migrate.ts` exposes the steps; ordering stays with the app |
| (outside) | `runtime/openclaw/package.json` + lock (the pin, installed scripts-off) | — | kit `engine/package.json` + lock |
| (outside) | `test/openclaw-stub.ts` (scripted OpenAI-compatible model) | 144 | kit `testing/model-stub.ts` |
| (outside) | `src/stub-runtime.ts` (product-rule `AgentRuntime` stub) | 105 | stays in Crewhouse |

Tests that define parity (Crewhouse `test/`): `openclaw.test.ts` (isolation, loopback, no Control UI, memory search
never paid), `openclaw-run.test.ts` (real Gateway tool call crosses the fail-closed gate), `openclaw-bridge.test.ts`
(unknown run and ungated call fail closed; permit works once), `openclaw-wizard.test.ts` (step pulling, cancel frees
setup admission), `openclaw-migrate.test.ts` (canonical provider ids, retained sign-in survives, failed import stays
recoverable), `policy-install.test.ts`, `openclaw-tools.test.ts`, `openclaw-curation.test.ts`,
`openclaw-learn.test.ts`, `openclaw-files.test.ts`.

The public `@openclaw/gateway-protocol@2026.8.1` exports TypeBox schemas and their TS types (`ProtocolSchemas`,
`WizardNextParams`, `ModelsAuthStatusParams`, …) and `PROTOCOL_VERSION = 4`, but **no method → schema table**. The
method list exists only inside the MIT `openclaw@2026.8.1` tarball: `dist/method-scopes-*.js`
`CORE_GATEWAY_METHOD_SPEC_LIST` (393 entries `[name, group, scope, since]`; scopes: 126 `operator.read`, 76
`operator.write`, 119 `operator.admin`, 16 `operator.approvals`, 5 `operator.questions`, 14 `operator.pairing`, 14
`operator.talk`, 12 `dynamic`, 11 `node`; 382 non-node), `dist/server-methods-list-*.js` `GATEWAY_AUX_METHODS` (24,
all already in the core list) and `GATEWAY_EVENTS` (52 literals + 3 named constants = 55). The hashed file names change per release; the generator finds them by content. At runtime the
Gateway advertises `hello-ok.features.methods` and `.events`, which the kit cross-checks.

### 3.2 muxr Herdr integration

| Brief path | Actual | Lines | Goes to |
|---|---|---|---|
| `apps/host/src/agent/infrastructure/herdrSessionSource.ts` | as named | 3045 | kit `agents.ts`, `close.ts`, `approvals.ts` (the herdr-facing parts only; muxr's `SessionSource` domain stays in muxr) |
| `apps/host/src/requests/infrastructure/runHerdrCli.ts` | as named | 35 | kit `cli.ts` (minus its `HERDR_BIN` env read, D13) |
| `scripts/setup/infrastructure/herdr.mjs` | as named | 528 | kit takes only `parseVersion`/compatibility and the plugin-list validation shape; install (`curl … install.sh`), integration and bundled-plugin setup stay in muxr |
| `perf/fake-herdr/` | `bin.mjs` 398, `server.mjs` 780, `world.mjs` 179, `smoke.mjs` 139, `stack.smoke.mjs` 218 | 1714 | kit `testing/fake-herdr/` (TS port, muxr UI plugins and perf churn removed) |
| (not named) | `apps/host/src/agent/infrastructure/socketClient.ts` `HerdrClient` | 278 | kit `socket.ts` — this, not `herdrSessionSource.ts`, holds the socket protocol |
| (not named) | `apps/host/src/agent/infrastructure/terminalManager.ts` | 493 | kit `terminal.ts` (the `herdr terminal session control|observe` process only; muxr's relay/crypto framing stays) |
| (not named) | `apps/host/src/agent/application/sessionSource.ts` | 197 | reference for helper coverage; not extracted |

Facts from those sources the kit keeps (details in [section 12](#12-known-facts-builders-must-not-re-derive)): one
request per connection; `events.subscribe` holds its socket; a rejected subscribe answers with `id: ""`; one bad
kind rejects the whole batch; `pane.agent_status_changed` needs `pane_id` so it rides its own socket; event frames are
`{event, data}` with older frames carrying `data.type`; result payloads nest under a per-method key; `agent.prompt`
receipt shape; exact-close guards refusing widening closes. `herdr api schema --json` prints the full request,
response, error and event schema bundled in the binary; that snapshot, not muxr's usage, defines the typed surface.

No checkout for Herdr itself was read; its surface for this spec comes from herdr.dev's Socket API page and muxr's
verified notes. H2 captures the real v0.9.1 schema in a lab.

## 4. Shared conventions

### 4.1 Layers

```
app (niche workflow + UI)
  │ uses                       │ uses
  ▼                            ▼
@byokit/openclaw  or  @byokit/herdr        ← runtime kit: aggregator's full power + helpers
  │ ./link adapter (host)      ▲ ./device client (phone/web)
  ▼                            │
@byokit/link · relay · reach · seal · ui-core   ← unchanged connection kits
```

### 4.2 State and isolation

- The app passes `stateDir`. OpenClaw kit writes only under `join(stateDir, 'openclaw')` and `join(stateDir, 'logs')`
  (Crewhouse's existing layout, so its state carries over byte-for-byte). Herdr kit in `own` mode writes only under
  `join(stateDir, 'herdr')`; in `adopt` mode it writes nothing.
- Folders 0700, secret files 0600, atomic writes (temp + rename), as `@byokit/link/node` does.
- Never read or write `~/.pi`, `~/.openclaw`, `~/.clawdbot`, `~/.codex`, `~/.claude`, `~/.config/herdr` or any
  person-level path; `adopt` mode talks only to the socket path the app passes.
- Spawned processes: explicit env only (D13).

### 4.3 States and plain words

Each kit has one `state` object and emits `onState`. Every state and failure a person can see has a sentence in the
kit's `src/words.json`, tested against the repo's banned-jargon expression (copy of
`packages/accounts/test/units.test.ts` line 59). UI code shows `words(state)`; it never builds sentences from ids.

### 4.4 Link op naming

Ops are `oc.*` (OpenClaw) and `hd.*` (Herdr). Requests return JSON; streams send newline-delimited JSON frames
(`LinkStream.write(JSON.stringify(frame) + '\n')`). Errors a person sees are `PublicLinkError` with a `words.json`
sentence. View-role devices get only ops marked *view* below.

### 4.5 Fake runtime rule

Each kit's `./testing` ships a fake and a **contract suite** (`openclawContract(make)`, `herdrContract(make)`): the
same assertions run against the fake in `npm test` and against the real pinned runtime in the engine job (OpenClaw)
or the lab (Herdr). A behavior the fake has and the contract does not assert is not relied on by any kit test.

### 4.6 Pass-through typing pattern

Both kits use the same typing shape so apps learn it once:

```ts
type MethodName = keyof Methods;                       // generated
type ParamsOf<M extends MethodName> = Methods[M]['params'];
type ResultOf<M extends MethodName> = Methods[M]['result'];
call<M extends MethodName>(method: M, params: ParamsOf<M>, o?: CallOptions): Promise<ResultOf<M>>;
```

`Methods` entries whose schema type could not be matched are `{ params: unknown; result: unknown }` and are listed in
the generated `report.json`.

## 5. `@byokit/openclaw`

### 5.1 Files

```
packages/openclaw/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  engine/package.json  engine/package-lock.json      # { "dependencies": { "openclaw": "2026.8.1" } }, integrity-locked
  plugin/index.js  plugin/package.json               # bridge plugin; manifest generated at prepare
  policy/policy.mjs                                  # operator install policy (OpenClaw security.installPolicy, protocol 1)
  scripts/gen-methods.ts  scripts/method-types.json  # O2 generator + its override map
  src/index.ts  src/constants.ts  src/types.ts
  src/generated/methods.ts  src/generated/events.ts  src/generated/report.json
  src/engine.ts  src/config.ts  src/transport.ts  src/kit.ts
  src/bridge.ts  src/approvals.ts
  src/signin.ts  src/routes.json  src/routes.ts  src/migrate.ts
  src/runs.ts  src/classify.ts  src/members.ts
  src/words.json  src/words.ts
  src/link.ts  src/device.ts  src/notices.ts
  src/testing/index.ts  src/testing/fake-gateway.ts  src/testing/contract.ts  src/testing/model-stub.ts
  test/*.test.ts
```

`package.json`: `exports` `.` → `dist/index.js`, `./device` → `dist/device.js` (with `react-native` and `browser`
conditions pointing at the same file), `./link` → `dist/link.js`, `./testing` → `dist/testing/index.js`; `files`:
`dist`, `engine`, `plugin`, `policy`, `README.md`, `LICENSE`. Dependencies (exact): `@openclaw/gateway-client`
`2026.8.1`, `@openclaw/gateway-protocol` `2026.8.1`, `@byokit/link` (current `0.3.1`), `@byokit/relay` (current
`0.1.3`), `@byokit/reach` (current `0.2.0`), `@byokit/seal` (current `0.1.0`), `ws` `8.21.3`. Dev: `@byokit/ui-core`
(assignability test only).

### 5.2 Public types (`src/types.ts`)

```ts
export type Member = string;                                   // /^[a-z][a-z0-9-]{0,31}$/, = OpenClaw agentId
export interface ToolSpec { name: string; description: string; parameters: object }   // JSON Schema object
export interface RunRef { sessionKey: string; member: Member; meta?: unknown }
export type GateResult =
  | { allow: true }
  | { allow: false; reason: string }
  | { ask: { summary: string } };                              // kit parks the call as an Approval
export interface ToolHost {
  gate(run: RunRef, tool: string, input: Record<string, unknown>, info: { builtin: boolean }): Promise<GateResult>;
  // every tool call, engine builtins (builtin: true, never passed to call) included, unless gateBuiltins is false
  call(run: RunRef, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}
export interface RunSpec extends RunRef {
  message: string; system?: string;
  images?: { data: string; mimeType: string }[];
  thinking?: 'off' | 'low' | 'medium' | 'high';
  register?: boolean;                                          // default true: the bridge recognizes this run
}
export type RunEvent =
  | { type: 'text'; text: string }                             // cumulative assistant text
  | { type: 'tool'; name: string; phase: 'start' | 'end' };
export type RunEnd =
  | { ok: true; text: string }
  | { ok: false; aborted: true }
  | { ok: false; kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number; message: string };
export type SignInView = {
  state: 'waiting' | 'done' | 'failed'; via: 'browser' | 'code';
  url?: string; code?: string; error?: string;
  why?: 'busy' | 'declined' | 'expired' | 'failed';
};
export type Approval = {
  id: string;                                                  // kit-minted, url-safe
  source: 'gate' | 'exec' | 'plugin' | 'question';
  member: Member; sessionKey?: string; tool?: string;
  summary: string; input?: unknown; at: number; expires: number;
};
export type Decision = { allow: boolean; reason?: string; answer?: unknown };   // answer: question.* only
export type KitState = {
  phase: 'stopped' | 'installing' | 'starting' | 'repairing' | 'ready' | 'restarting' | 'failed' | 'needs-update';
  why?: 'install' | 'handshake' | 'exited' | 'port' | 'version';
  retryAt?: number;
};
export type Hello = { protocol: number; server: { version: string }; methods: string[]; events: string[] };
export type Route = {
  choice: string; provider: string; plugin: string; billing: 'subscription' | 'api' | 'local'; via: 'browser' | 'code';
  prerequisite: string | null; offer: boolean; reason: string; source: string;
};
export interface GatewayTransport {
  start(): Promise<Hello>;
  request(method: string, params?: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  onEvent(fn: (e: { event: string; payload?: unknown }) => void): () => void;
  onClose(fn: (why: string) => void): () => void;
  stop(): Promise<void>;
}
```

### 5.3 `OpenClawKit` (`src/kit.ts`, exported from `.`)

```ts
export type KitOptions = {
  stateDir: string;
  engineDir?: string;                    // default join(stateDir, 'openclaw', 'engine')
  npmPath?: string;                      // default: 'npm' found on PATH (the only env read, D13)
  enginePath?: string[];                 // extra dirs appended to the engine's PATH ('/usr/bin:/bin')
  plugin?: { id?: string };              // default 'byokit'
  bridge?: { socketName?: string; paramPrefix?: string };   // defaults 'bridge.sock' / '__byokit' (validated)
  tools?: ToolSpec[];                    // app tools registered by the bridge plugin; names /^[a-z][a-z0-9_]*$/,
                                         // not bash or cron (the engine renames those before the gate hook)
  host?: ToolHost;                       // required when tools is non-empty
  permitted?: (tool: string) => boolean; // tools needing a one-use permit from their gate; default () => true
  gateBuiltins?: boolean;                // default true: engine builtins go through host.gate too (no host: blocked);
                                         // false gates only `tools` and lets builtins run ungated
  config?: object;                       // app OpenClaw config, deep-merged UNDER the invariants (5.6)
  installPolicy?: { trustedSkills: string; ownRoots: string[] };   // trusted-skills JSON path, own content roots
  callbackPort?: number;                 // default 1455
  approvalTimeoutMs?: number;            // default 180_000
  transport?: (ctx: { port: number; token: string; identityPath: string; bridgeSock: string }) => GatewayTransport;  // tests
  spawnEngine?: boolean;                 // default true; false skips install, doctor and spawn (layout, token,
                                         // port, config, plugin and bridge still happen)
  onState?: (s: KitState) => void;
  log?: (line: string) => void;
};

export class OpenClawKit {
  constructor(o: KitOptions);
  readonly state: KitState;
  prepare(): Promise<void>;              // install + layout + config, no launch; idempotent
  start(): Promise<void>;                // prepare, launch, handshake, bridge up; resolves at 'ready'
  stop(): Promise<void>;
  // complete pass-through (D6)
  call<M extends GatewayMethod>(method: M, params: GatewayParams<M>, o?: CallOptions): Promise<GatewayResult<M>>;
  callDynamic(method: string, params?: unknown, o?: CallOptions): Promise<unknown>;
  readonly hello?: Hello;
  onEvent<E extends GatewayEventName>(event: E | '*', fn: (payload: GatewayEventPayload<E>, event: E) => void): () => void;
  // members
  ensureMember(member: Member): Promise<{ agentId: string; workspace: string }>;
  // sign-in (5.7)
  routes(): Route[];
  providers(member: Member): Promise<string[]>;
  signedIn(member: Member, provider: string): Promise<boolean>;
  signIn(member: Member, o: { authChoice: string; via?: 'browser' | 'code' }, on: (v: SignInView) => void):
    { paste(text: string): void; cancel(): void; done: Promise<SignInView> };
  signOut(member: Member, provider: string): Promise<void>;
  migrateRetainedLogin(member: Member, source: RetainedLogin): Promise<'staged' | 'nothing' | 'failed'>;
  confirmRetainedLogin(member: Member, source: RetainedLogin): Promise<boolean>;
  // runs (5.8)
  run(spec: RunSpec, on?: (e: RunEvent) => void): Promise<RunEnd>;
  steer(sessionKey: string, text: string): Promise<void>;
  abort(sessionKey: string): Promise<void>;
  // approvals (5.9)
  approvals(member?: Member): Approval[];
  onApproval(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void;
  decide(id: string, d: Decision): Promise<void>;
  allowOnce(rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean }, ms: number): void;
  disallowOnce(): void;
  // config
  patchConfig(patch: object, o?: { agentId?: string }): Promise<void>;   // config.get hash + config.patch
  memoryLimited(member: Member): boolean;
  doctorContext(): { entry: string; env: Record<string, string> };
}
export type RetainedLogin = { path: string } | { record: Record<string, unknown> };
export const ENGINE_VERSION = '2026.8.1';
export const PROTOCOL_VERSION = 4;
```

`GatewayMethod`, `GatewayParams`, `GatewayResult`, `GatewayEventName`, `GatewayEventPayload` come from
`src/generated/*` (O2). `CallOptions = { timeoutMs?: number; signal?: AbortSignal }`.

### 5.4 Lifecycle and supervision (`src/engine.ts`)

Extracted from Crewhouse `gateway.ts` with these exact behaviors:

1. **prepare()**: create `openclaw/home`, `openclaw/state`, `openclaw/tmp`, `logs`. If `engineDir/node_modules/openclaw/openclaw.mjs`
   is missing: copy the kit's `engine/package.json` and `engine/package-lock.json` into `engineDir`, run
   `npm ci --ignore-scripts --no-audit --no-fund --prefix <engineDir>` with env `{ PATH, HOME: openclaw/install-home,
   npm_config_cache: openclaw/npm-cache, OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: '1' }`, timeout 300 s; state
   `installing`; failure → `failed/install`. Then verify `engineDir/node_modules/openclaw/package.json` version equals
   `ENGINE_VERSION`, else `needs-update/version` (never silently run another version). Token file `openclaw/token`
   (32 random bytes hex, 0600, created once). Port file `openclaw/port` (free loopback port chosen once; refuse 18789
   → `failed/port`). Write the bridge plugin (5.9) and reconcile config (5.6).
2. **start()**: kill a stale engine only if `openclaw/gateway.pid`'s `/proc/<pid>/cmdline` contains both the engine
   entry and `gateway` (never another app's pid); spawn `process.execPath <entry> gateway --port <port>` detached,
    cwd = isolated HOME, env = 5.5, stdout/stderr appended to `logs/openclaw.log` (0600); write the pidfile. Device
    identity `openclaw/device.json` (ed25519, created once when missing, 0600; the transport reads both the kit's
    `{ privateKey, publicKey }` shape and the Crewhouse legacy `{ deviceId, publicKeyPem, privateKeyPem }` shape, and
    never rewrites an existing file so an upgraded house keeps its keys). Connect the transport; wait up to 90 s for
   hello-ok, polling the child every 200 ms. Exit code 78 once → run `doctor --fix --yes --non-interactive` (60 s)
   with state `repairing`, relaunch. Other exit → `failed/exited`. Timeout → `failed/handshake`. Protocol ≠ 4 →
   `needs-update/version`. Then start the bridge socket; state `ready`.
3. **Crash**: on child exit while not stopping: drop the transport, state `restarting` with
   `retryAt = now + min(30 s, 1 s × 2^failures)`, then `start()` again; failures reset on a successful handshake.
4. **stop()**: stop transport; SIGTERM the process group; wait 3 s; SIGKILL; wait 3 s; await exit; close the bridge
   socket and delete it. State `stopped`.
5. `doctorContext()` returns the entry and isolated env for an offline doctor run (migration).

### 5.5 Isolated engine env

Exactly Crewhouse's `isolatedEnv`, with `CREWHOUSE_SOCK` renamed and PATH extensible:

```
PATH=/usr/bin:/bin[:enginePath…]  LANG=C.UTF-8  HOME=<root>/home  OPENCLAW_HOME=<root>/home
OPENCLAW_STATE_DIR=<root>/state  OPENCLAW_CONFIG_PATH=<root>/openclaw.json
XDG_CONFIG_HOME=<home>/.config  XDG_CACHE_HOME=<home>/.cache  XDG_DATA_HOME=<home>/.local/share
XDG_STATE_HOME=<home>/.local/state  CODEX_HOME=<home>/.codex  CLAUDE_CONFIG_DIR=<home>/.claude  TMPDIR=<root>/tmp
OPENCLAW_NO_RESPAWN=1  OPENCLAW_SKIP_CHANNELS=1  OPENCLAW_DISABLE_BONJOUR=1  OPENCLAW_EXEC_SHELL_SNAPSHOT=0
OPENCLAW_LOAD_SHELL_ENV=0  OPENCLAW_GATEWAY_TOKEN=<token>  BYOKIT_BRIDGE_SOCK=<root>/bridge.sock
```

`<root>` = `join(stateDir, 'openclaw')`. The socket file name is `bridge.socketName` (default `bridge.sock`); an
app that already has a socket name in the wild passes it explicitly (Crewhouse passes `crewd.sock`).

### 5.6 Config invariants (`src/config.ts`)

`prepare()` builds `defaults ⊕ app config`, then **forces** the invariants on every run (new or existing file),
writing only if bytes change (0600):

- `gateway`: `mode: 'local'`, `bind: 'loopback'`, `port`, token auth from env `OPENCLAW_GATEWAY_TOKEN`,
  `controlUi.enabled: false`, `tailscale.mode: 'off'`; `discovery.mdns.mode: 'off'`; `env.shellEnv.enabled: false`;
  `update.checkOnStart: false`, `update.auto.enabled: false`; `telemetry.enabled: false`;
  `models.catalogRefresh.enabled: false`; `logging.file: <stateDir>/logs/openclaw-events.log`; `channels` kept `{}`
  unless the app config sets them.
- Subscription runtime: `agents.defaults.models['openai/*'].agentRuntime = { id: 'openclaw' }`; if
  `agents.defaults.modelPolicy.allow` is non-empty it gains `'openai/*'`.
- **No silent API billing** (Crewhouse #138): top-level and every `agents.entries[*].memory.search` →
  `provider` stays only if in `none|local|ollama|lmstudio|github-copilot` and, for ollama/lmstudio, `remote.baseUrl`
  host is loopback with no `remote.apiKey`; else `'none'`; `fallback: 'none'` always.
- Plugins: `plugins.load.paths` contains `<root>/plugin` (and no stale kit plugin path); `plugins.allow` contains the
  plugin id and the kit adds no other id; `plugins.entries[id].hooks.timeouts.before_tool_call = 200_000`. The pinned
  engine treats a non-empty `plugins.allow` as a restrictive allowlist: a provider sign-in, and that provider's runs,
  need the bundled plugin that owns the route's auth choice (`Route.plugin`) in it, else the wizard ends
  `<label> is disabled (blocked by allowlist)`. An app lists exactly the `plugin` ids of the routes it signs in with
  through `config.plugins.allow` (merged with the kit's id; 2026.8.1: `openai` for `openai`/`openai-device-code`,
  `xai` for `xai-oauth`, `github-copilot` for `github-copilot`/`github-copilot-enterprise`, `openrouter` for
  `openrouter-oauth`, `minimax` for `minimax-global-oauth`/`minimax-cn-oauth`); Crewhouse passes
  `['crewhouse', 'memory-core', 'openai']`. The kit never writes an empty or wider list. A provider plugin also
  carries that provider's key-entry choices; the Gateway's `openclaw.setup.auth.start` refuses those in 2026.8.1, and
  the memory-search invariant above keeps the plugin from billing embeddings.
- Install policy when `installPolicy` is given: `security.installPolicy = { enabled: true, exec: { source: 'exec',
  command: process.execPath, args: [<kit>/policy/policy.mjs], trustedDirs: [dirname(process.execPath),
  <kit>/policy], timeoutMs: 10_000, passEnv: ['OPENCLAW_STATE_DIR'], env: { BYOKIT_TRUSTED_SKILLS: <path>,
  BYOKIT_OWN_ROOTS: JSON.stringify(ownRoots) } } }`. Without it: `enabled: true` with a policy that blocks every
  install except the `@openclaw/` scope.

Crewhouse's product choices (tool profile and deny list, `skills.allowBundled`, workshop, `agents.defaults.sandbox`,
`codex: { enabled: false }`, `memory-core` dreaming off) move into Crewhouse's `config` option unchanged.
`memoryLimited(member)` = the member's (else top-level) `memory.search.provider === 'none'`.

### 5.7 Sign-in, routes and retained-login migration

**Routes** (`src/routes.json`, O6): one entry per auth choice in the pinned tarball's provider contracts:
`{ "choice": "openai-device-code", "provider": "openai", "plugin": "openai", "billing": "subscription", "via": "code",
"prerequisite": null, "offer": true, "reason": "…", "source": "dist/provider-contract-api-*.js (2026.8.1)" }`.
Seeded from Crewhouse `docs/supported-subscriptions.md`: subscription routes `openai`, `openai-device-code`,
`xai-oauth`, `github-copilot`, `github-copilot-enterprise`, `minimax-global-oauth`, `minimax-cn-oauth`
(`offer: true`), `anthropic-cli`, `setup-token` (`offer: false`, D12); the seed's other Grok route
`xai-device-code` is `offer: false` (manual-only upstream), and its `openrouter-oauth` is `offer: false` too (below);
API routes listed there (`billing: 'api'`, `offer: false`, reason "API billing, not a subscription; shown only when
an app asks"). `openrouter-oauth` is `billing: 'api'`, `offer: false` (upstream OAuth yields a credit-billed key, not
a plan; no silent API billing). O6 verifies every choice id against the tarball and adds any the doc missed. Each
entry's `plugin` is the `id` of the bundled `openclaw.plugin.json` whose `providerAuthChoices` lists the choice;
`via` is `code` when that choice's `appGuidedAuth` is `device-code`, else `browser`. A choice the pinned Gateway does
not offer through `openclaw.setup.auth.start` (`assistantVisibility: "manual-only"`, or no `appGuidedAuth`) is
`offer: false`. The engine job asserts both directions (every route is a pinned choice, every pinned choice is a
route) and that every `offer: true` route starts (first `wizard.next` without `not available` or
`blocked by allowlist`) with only its `plugin` added to `plugins.allow`. `routes()` returns the
table; `routeFor(provider, via)` picks the offered route.

**signIn(member, { authChoice, via }, on)** — Crewhouse `runtime.ts` `signIn` loop, unchanged in behavior:
`ensureMember`; `openclaw.setup.auth.start { sessionId: 'byokit-' + uuid, agentId, authChoice }` (60 s); pull steps
only with `wizard.next` (120 s each, max 200 turns; never `wizard.status`); a `deviceCode` step → view
`{ code, url }` then acknowledge `{ stepId }`; a non-sensitive `text` step → wait for `paste` (15 min) then answer
`{ stepId, value }`; `note|confirm|select|action` → surface `externalUrl`, acknowledge; `progress` → pull again.
Every exit short of done calls `wizard.cancel { sessionId }` for **its own** session. For `via: 'browser'` with
`authChoice` `openai`, the kit holds `127.0.0.1:<callbackPort>` for the sign-in's life: any request pastes
`http://<host><url>` into the wizard and answers a plain page (words key `signin.returned`); if the port is taken
the view fails with `why: 'busy'`. Mapping to `SignInView.why`: setup-admission-busy error → `busy`; person cancel →
`declined`; 200 turns or 15 min → `expired`; else `failed`. Errors are cut to 200 chars.

**signedIn / providers**: `models.authStatus { agentId }` (20 s); a provider entry is a string or `{ provider }`.
**signOut**: `models.authLogout { provider, agentId }`.

**Retained-login migration** (D15), Crewhouse `migrate`/`confirm` generalized:

- `migrateRetainedLogin(member, source)` must run **before** `start()` (doctor refuses while a Gateway owns the
  state). Source path: use `path`, else `path + '.moved-to-engine'` when no `.canonicalized` marker exists; nothing →
  `'nothing'`. `prepare()` first (never import without the engine). Stage `state/agents/<member>/agent/auth-profiles.json`
  (0600) as `{ version: 1, profiles: { '<provider>:default': credential } }` unless already staged; a `.moved-to-engine`
  source without `openai-codex` → `'nothing'`. Run doctor `--fix --yes --non-interactive` (120 s). Non-zero → delete
  the staging, return `'failed'` (the original stays byte-identical). Zero → `'staged'`.
- `confirmRetainedLogin(member, source)` after `ready`: wanted providers = source keys mapped `openai-codex → openai`,
  else the provider map, else lower-case key; empty → `false`. Up to 3 × (`models.authStatus { agentId, refresh: true }`,
  1.5 s apart); all present → for a path source rename `path → path.moved-to-engine` (if not already) and write the
  empty `.canonicalized` marker, return `true`. Record sources return `true` and the app deletes its own copy.
  Anything else → `false`, nothing moves; the next boot retries without a second sign-in.

### 5.8 Runs, members and streams

- `ensureMember(member)`: validate the id (D9); `agents.list`; if absent `agents.create { name: member, workspace:
  <root>/workspaces/<member> }`; cache.
- `run(spec, on)`: reject a `sessionKey` not starting `agent:<member>:` (member boundary). Register with the bridge
  unless `register === false`. Subscribe to Gateway `agent` events filtered by `runId`: `stream === 'assistant'` with
  string `data.text` → `{ type: 'text', text }`; `stream === 'tool'` with string `data.name` → `{ type: 'tool', name,
  phase: data.phase === 'end' ? 'end' : 'start' }`. Request `agent { agentId, sessionKey, message, extraSystemPrompt,
  idempotencyKey: uuid, attachments?, thinking? }`, then `agent.wait { runId, timeoutMs: 3_600_000 }` (client timeout
  3_610_000). `status === 'ok'` → final text event and `{ ok: true, text: terminalReply.text ?? last }`;
  `stopReason === 'aborted'` → `{ ok: false, aborted: true }`; else `{ ok: false, ...classify(message) }`.
  Always unsubscribe and unregister.
- `classify(message)` (`src/classify.ts`) = Crewhouse `classifyText` mapped `rate_limit|overloaded → resting`,
  `signed_out → signed-out`, `not_included → plan`, `network → network`, `null → other`, with `until` carried.
- `steer` → `sessions.steer { sessionKey, message }`; `abort` → `chat.abort { sessionKey }`.
- Streams: `onEvent` delivers every Gateway event (typed); the link adapter filters by member (7.1).

### 5.9 Tools, approvals and the bridge

**Plugin** (`plugin/index.js`, written to `<root>/plugin/` at prepare with a generated `openclaw.plugin.json`
`{ id, name: 'BYOKit bridge', activation: { onStartup: true }, contracts: { tools: <tool names> }, configSchema:
{ type: 'object', additionalProperties: false } }` and `tools.json` = the app's `ToolSpec[]`). Behavior = Crewhouse
`plugin/index.js` with schemas/descriptions read from `tools.json` instead of hard-coded: `before_tool_call` sends
`{ kind: 'gate', key: sessionKey, tool, input }` over `BYOKIT_BRIDGE_SOCK` (newline-framed JSON, one request per
connection, 1 MB cap, 195 s timeout, abort-aware) for every tool call, engine builtins (`web_fetch`, `web_search`,
memory and skill tools, any name not in `tools.json`) included; `tools.json` carries `gateBuiltins` (from
`KitOptions.gateBuiltins`, absent reads as true) and only `false` lets a builtin skip the hook. A non-allow blocks with
the reason; an allowed builtin passes through unchanged (it runs in the engine and never calls back); an allow for a
permitted app tool injects `<paramPrefix>_run`/`<paramPrefix>_permit` params (`paramPrefix` from `bridge`, default
`__byokit`); `execute` strips them, requires both for permitted tools, sends
`{ kind: 'call', key, permit, tool, input }`, returns the text. Any failure blocks ("can't check this action right
now"). Crewhouse passes `__crewhouse` explicitly, so its injected names are unchanged.

**Bridge** (`src/bridge.ts`) = Crewhouse `ToolBridge`: unix socket at `BYOKIT_BRIDGE_SOCK`, `register`/`unregister`
runs by session key, one-use permits bound to key + tool + exact JSON input, unknown run fails closed, any error
answers `{ allow: false }`. The bridge knows the app's tool names: a builtin reaches `host.gate` with `{ builtin: true }`
and an allow gets neither permit nor ticket, and a `call` for a name outside `tools` is refused. `prepare` rewrites
the shipped `plugin/index.js` whenever it differs, so a state dir from an older kit never keeps an older gate. Generalizations: `permitted(tool)` replaces the `crew_` prefix test (Crewhouse passes
`t => t.startsWith('crew_')`); `allowOnce`/`disallowOnce` replace `armCuration` (one call, key prefix + tool + input
predicate, expires after `ms`, consumed on first match). A gate result `{ ask }` creates an `Approval`
(`source: 'gate'`, `expires = now + approvalTimeoutMs`) and holds the socket until `decide(id)` or expiry (expiry →
deny, reason words key `approval.expired`); 180 s < plugin 195 s < hook 200 s so the deny always reaches the engine.
A `call` aborts the `AbortSignal` handed to `host.call` when that call's plugin socket closes or errors before the
reply is written (run abort, hook timeout), so an aborted run never leaves the sandboxed command running; the
listener is removed after a normal reply.

**Native approvals** (`src/approvals.ts`): on `exec.approval.requested`, `plugin.approval.requested`,
`question.requested` events, add an `Approval` (`source` = `exec|plugin|question`, member from the payload's agent or
session key); on `*.resolved`, remove it. `decide` calls `exec.approval.resolve` / `plugin.approval.resolve` /
`question.resolve` with the protocol's params (O5 reads the exact param names from the generated types). All four
sources share `approvals()`/`onApproval()`.

**Install policy** (`policy/policy.mjs`) = Crewhouse `policy.mjs` with `trusted-skills.json` read from
`BYOKIT_TRUSTED_SKILLS`, own roots from `BYOKIT_OWN_ROOTS` (JSON array), everything else unchanged (fail closed,
any request kind containing `depend` blocked even under an own root, dependency installers blocked, exact id +
version + SKILL.md sha256 for listed skills where the version is `request.origin.version` when present and the
SKILL.md frontmatter version otherwise). A plugin install claiming
the `@openclaw/` scope is allowed only with engine proof of registry origin: `source.kind === 'npm'` and the
operator-requested `request.requestedSpecifier` starts with `@openclaw/`. The candidate's own `plugin.packageName`
is never sufficient: on the pinned engine it is the package manifest's self-declared `name`, and npm installs
always carry `source.authority 'third-party'`, so authority is not the check. Any other claimant of the scope
(local, archive, git or file source, missing source, non-scope specifier) blocks.

### 5.10 Pass-through generation (`scripts/gen-methods.ts`, O2)

Input: the pinned tarball installed under a temp dir (`npm pack openclaw@2026.8.1` + extract, network allowed at
generation time only) and the installed `@openclaw/gateway-protocol` types. Steps: locate the file containing
`const CORE_GATEWAY_METHOD_SPEC_LIST = [` and evaluate only that array literal; locate `GATEWAY_AUX_METHODS` and
`GATEWAY_EVENTS` the same way (constant entries only; non-literal entries such as `GATEWAY_EVENT_UPDATE_AVAILABLE`
are resolved from their `const X = "…"` definitions in the tarball). For each method try, in order: `scripts/method-types.json`
override, `Pascal(method) + 'Params'|'Result'` (e.g. `models.authStatus` → `ModelsAuthStatusParams`),
`Pascal(group) + Pascal(last segment)`; accept only names exported by `@openclaw/gateway-protocol` (checked by
compiling a probe file). Events: `Pascal(event) + 'Event'` or override. Union patch-up: the installed
`@openclaw/gateway-protocol` package's `protocol.schema.json` is the authority for params shapes, since the
published type declarations drop properties from anyOf/oneOf branches; every matched type whose schema carries
a top-level anyOf/oneOf is re-emitted into `src/generated/params.ts` under its own name, with each branch's
full property set (branch properties plus the properties declared beside the union on the parent schema, and
the union of the parent and branch required lists; presence-exclusions from `not` spell as `prop?: never`).
The tables reference the local name instead of the protocol export. Output `src/generated/methods.ts`
(`export interface GatewayMethods { 'agents.create': { params: AgentsCreateParams; result: unknown; scope:
'operator.admin'; role: 'operator' }; … }`, `import type` only), `events.ts`, `params.ts`, and `report.json`
(`{ engine, protocol, methods: n, matchedParams, matchedResults, patchedTypes: [...], unmatched: [...] }`). Output is committed and
formatted deterministically (sorted). `npm run gen:openclaw` re-runs it; a test fails when the committed output
differs from a fresh run against the pinned tarball in the engine job.

### 5.11 Fake runtime contract (`./testing`, O7)

- `fakeGateway(script?)` returns `{ factory: KitOptions['transport'], calls: {method, params}[], emit(event, payload),
  failNext(method, message), drop(why), handle(method, fn) }`; use as `new OpenClawKit({ transport: fake.factory,
  spawnEngine: false, … })`. The factory captures `bridgeSock` so scripted tool calls reach the real bridge,
  split as the plugin splits them: it reads the kit's `plugin/tools.json` beside the socket, gates a builtin unless
  `gateBuiltins` is false and never calls one back (no table: every tool counts as the app's). `start()` resolves a hello with `protocol: 4`,
  `server.version: '2026.8.1'`, and methods/events from the generated tables. Unknown method → rejects
  `unknown method: <m>`.
- Default handlers: `health`; `agents.list`/`agents.create` (in-memory); `models.authStatus`/`models.authLogout`
  (in-memory per agent); `openclaw.setup.auth.start` + `wizard.next` + `wizard.cancel` running the device-code script
  from Crewhouse's `openclaw-wizard.test.ts` (`DEVICE_STEP`, then progress, then done) and marking the agent signed in
  to `openai`; `agent` (returns `runId`, emits `agent` events: one assistant text `fake: <message>` and, for a message
  `[tool NAME {json}]`, a tool start/end pair after calling the kit's bridge like the plugin does);
  `agent.wait` (resolves `{ status: 'ok', terminalReply: { text } }`); `sessions.steer`; `chat.abort` (makes the
  pending wait resolve `{ stopReason: 'aborted' }`); `config.get`/`config.patch` (hash check);
  `exec.approval.resolve`/`plugin.approval.resolve`/`question.resolve` (emit the matching `*.resolved`).
- `openclawContract(make: () => Promise<{ kit: OpenClawKit; model?: ModelStub }>)`: registers `node:test` cases for
  hello/method cross-check, member creation, member boundary refusal, device-code sign-in happy path and cancel,
  a run with text streaming, a tool call gated `ask` → approve → result, gated deny, abort, native exec approval
  round-trip, `call` pass-through for `health`, config invariants after `patchConfig`.
- `startModelStub(script, o?)` = Crewhouse `test/openclaw-stub.ts` (script grammar unchanged: `[tool NAME {json}]`,
  `hit the limit`, `no helpers in plan`, `sign me out`, `ask permission`, `[route ID]`) plus `useModelStub(kit, stub)` =
  Crewhouse `configureModelProvider` (provider id `byokit-stub`, model `test`). The bot id the stub reports comes
  from `o.idPattern` (default `/Your id is ([a-z0-9-]+)\./`) and routing requests start with `o.routingMarker`
  (default `'[routing]'`); Crewhouse passes its own grammar explicitly.

### 5.12 Version pin and upgrades

The pin is `ENGINE_VERSION` + `engine/package-lock.json` + exact client/protocol deps. An upgrade is one PR in
byokit: bump all four, re-run `npm run gen:openclaw`, review `report.json` and the method/event diff (listed in the
PR), re-verify `routes.json` choice ids, run `npm run test:engine` green, bump the kit's minor version, CHANGELOG
lists added/removed methods. Consumers upgrade the kit, never the engine directly. An installed engine whose version
differs from `ENGINE_VERSION` is `needs-update`; `prepare()` then reinstalls into `engineDir` (delete
`engineDir/node_modules` and `npm ci`), never touching `openclaw/state`.

### 5.13 Internal module seams (stub signatures for O1)

```ts
// engine.ts (O3)
export type EngineOptions = Pick<KitOptions, 'stateDir' | 'engineDir' | 'npmPath' | 'enginePath' | 'config' | 'installPolicy' | 'log' | 'bridge'>
  & { pluginId: string; tools: ToolSpec[]; spawnEngine: boolean; onState(s: KitState): void; onExit(code: number | null): void };
export class Engine {
  constructor(o: EngineOptions); readonly root: string; readonly bridgeSock: string;
  prepare(): Promise<void>;
  start(): Promise<{ port: number; token: string; identityPath: string }>;   // spawned (or not) and port known
  stop(): Promise<void>;
  doctor(timeoutMs: number): { status: number | null };                      // offline doctor --fix run
  doctorContext(): { entry: string; env: Record<string, string> };
}
// config.ts (O3)
export function reconcileConfig(saved: object | undefined, o: { root: string; stateDir: string; port: number;
  pluginId: string; pluginDir: string; policyPath: string; app?: object; installPolicy?: KitOptions['installPolicy'] }): object;
export function memoryLimited(config: object, member: Member): boolean;
// transport.ts (O4)
export function gatewayTransport(ctx: { port: number; token: string; identityPath: string; bridgeSock: string }): GatewayTransport;
// members.ts (O4)
export const MEMBER_ID: RegExp;
export function createMembers(ctx: { request: GatewayTransport['request']; root: string }): { ensure(member: Member): Promise<{ agentId: string; workspace: string }> };
// bridge.ts (O5)
export function resolveBridge(o?: { socketName?: string; paramPrefix?: string }): { socketName: string; paramPrefix: string };
export function writePlugin(dir: string, o: { id: string; tools: ToolSpec[]; paramPrefix: string;
  gateBuiltins: boolean }): void;
export class Bridge {
  constructor(o: { path: string; host?: ToolHost; tools: ReadonlySet<string>; permitted: (tool: string) => boolean; approvalTimeoutMs: number;
    onAsk(a: Approval): void; onAskGone(id: string): void });
  start(): Promise<void>; stop(): void;
  register(run: RunRef): void; unregister(sessionKey: string): void;
  allowOnce(rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean }, ms: number): void;
  disallowOnce(): void;
  resolveAsk(id: string, d: Decision): boolean;
}
// approvals.ts (O5)
export class Approvals {
  constructor(o: { request: GatewayTransport['request']; bridge: Pick<Bridge, 'resolveAsk'> });
  handleEvent(e: { event: string; payload?: unknown }): void; add(a: Approval): void; remove(id: string): void;
  list(member?: Member): Approval[]; on(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void;
  decide(id: string, d: Decision): Promise<void>;
}
// signin.ts (O6)
export type SignInCtx = { request: GatewayTransport['request']; ensure(member: Member): Promise<{ agentId: string }>; callbackPort: number };
export function signIn(ctx: SignInCtx, member: Member, o: { authChoice: string; via?: 'browser' | 'code' },
  on: (v: SignInView) => void): { paste(text: string): void; cancel(): void; done: Promise<SignInView> };
export function providers(ctx: SignInCtx, member: Member, refresh?: boolean): Promise<string[]>;
export function signOut(ctx: SignInCtx, member: Member, provider: string): Promise<void>;
// routes.ts (O6)
export function routes(): Route[]; export function routeFor(provider: string, via: 'browser' | 'code'): Route | undefined;
// migrate.ts (O6)
export type DoctorRunner = () => { status: number | null };
export function migrateRetainedLogin(ctx: { root: string; prepare(): Promise<void>; doctor: DoctorRunner }, member: Member,
  source: RetainedLogin): Promise<'staged' | 'nothing' | 'failed'>;
export function confirmRetainedLogin(ctx: SignInCtx, member: Member, source: RetainedLogin): Promise<boolean>;
// runs.ts (O8)
export function createRuns(ctx: { request: GatewayTransport['request']; onEvent: GatewayTransport['onEvent'];
  ensure(member: Member): Promise<{ agentId: string }>; bridge: Pick<Bridge, 'register' | 'unregister'> }):
  { run(spec: RunSpec, on?: (e: RunEvent) => void): Promise<RunEnd>; steer(k: string, t: string): Promise<void>; abort(k: string): Promise<void> };
// classify.ts (O8)
export function classify(message: string): { kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number };
// words.ts (O10)
export function words(key: WordKey, vars?: Record<string, string>): string;
export function stateWords(s: KitState): string;
export function toAccountView(view: SignInView | null, ready: boolean): AccountView;   // AccountView = ui-core's shape, declared locally
// notices.ts (O9; portable)
export function sealNotice(a: Approval, boxPublicKey: Uint8Array): { v: 1; sealed: string };
export function openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null;
```

### 5.14 Words (`src/words.json`, O10)

| Key | Sentence |
|---|---|
| `engine.installing` | Getting things ready on this computer. The first time takes a few minutes. |
| `engine.starting` | Starting up… |
| `engine.repairing` | Fixing a small problem with the setup. This takes a moment. |
| `engine.ready` | Ready. |
| `engine.restarting` | Something stopped. Starting it again by itself. |
| `engine.failed` | This computer couldn't start the helper. Restart the app to try again. |
| `engine.needsUpdate` | This app needs an update to keep working. |
| `member.signedOut` | Sign in with {name} to start. |
| `member.resting` | {name} needs a break until {time}. |
| `member.plan` | Your {name} plan doesn't include this. |
| `member.network` | Can't reach {name} right now. This keeps trying by itself. |
| `signin.returned` | Thanks. Finishing the sign-in — you can go back to the app now. |
| `signin.busy` | Another sign-in is already in progress. Finish or cancel it, then try again. |
| `signin.expired` | The sign-in took too long. Start it again. |
| `approval.ask` | {helper} wants to {summary}. Allow it? |
| `approval.expired` | Nobody answered in time, so this wasn't allowed. |
| `approval.notice` | Something is waiting for your yes. |
| `link.notAllowed` | This device can't do that. Ask the person at the computer. |

`words(key, vars)` fills `{name}`, `{time}`, `{helper}`, `{summary}`; `stateWords(state: KitState)`;
`toAccountView(view: SignInView | null, ready: boolean): AccountView` produces `@byokit/ui-core`'s `AccountView`
shape so `useSignIn`/`phaseOf` work unchanged (`why` maps 1:1; `busy`, `declined`, `expired` are ui-core's).

## 6. `@byokit/herdr`

### 6.1 Files

```
packages/herdr/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  schema/herdr-api-0.9.1.json  schema/SOURCE.md          # snapshot + where/how it was captured, sha256
  scripts/gen-types.ts
  src/index.ts  src/constants.ts  src/types.ts
  src/generated/methods.ts  src/generated/events.ts  src/generated/report.json
  src/socket.ts  src/supervise.ts  src/kit.ts  src/cli.ts  src/terminal.ts
  src/agents.ts  src/close.ts  src/approvals.ts
  src/words.json  src/words.ts
  src/link.ts  src/device.ts  src/notices.ts
  src/testing/index.ts  src/testing/fake-herdr/{server.ts,world.ts,bin.ts}  src/testing/contract.ts
  test/*.test.ts
```

Exports as D2 (`./device` with `react-native`/`browser` conditions). Dependencies (exact): `@byokit/link`,
`@byokit/relay`, `@byokit/reach`, `@byokit/seal` (current versions as 5.1), `ws` `8.21.3`. Dev (root):
`json-schema-to-typescript` pinned exactly (used by `gen-types.ts` only). Herdr itself is **not** an npm dependency
(a native binary); the app installs it (README: `https://herdr.dev/install.sh` or the GitHub release) and passes `bin`.

### 6.2 Public API (`src/kit.ts`, exported from `.`)

```ts
export const HERDR_VERSION = '0.9.1';
export const HERDR_PROTOCOL: number;                     // from the snapshot (H2)
export type HerdrState = {
  phase: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'needs-update' | 'missing' | 'failed';
  why?: 'binary' | 'socket' | 'version' | 'server-exited';
};
export type HerdrKitOptions =
  | { mode: 'adopt'; bin: string; socketPath: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; onState?: (s: HerdrState) => void }
  | { mode: 'own'; bin: string; stateDir: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; onState?: (s: HerdrState) => void };
export interface HerdrTransport {                        // socket.ts implements it; the fake does too
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  subscribe(subs: { type: string; [k: string]: unknown }[], on: (e: HerdrEvent) => void,
            onError: (code: string, message: string) => void): () => void;   // own socket per call
  close(): void;
}
export type HerdrEvent = { type: string; [k: string]: unknown };

export class HerdrKit {
  constructor(o: HerdrKitOptions);
  readonly state: HerdrState;
  start(): Promise<void>;        // own: spawn server; both: connect, version gate, event socket, bootstrap
  stop(): Promise<void>;         // own: server.stop then signals; adopt: close sockets only
  // complete pass-through (D7)
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>, o?: { timeoutMs?: number }): Promise<HerdrResult<M>>;
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void,
            onError?: (code: string, message: string) => void): () => void;   // onError: Herdr rejected the batch
  cli(args: string[], o?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession;
  // live tree
  snapshot(): HerdrSnapshot;     // workspaces → tabs → panes → agents, kept current by events
  onChange(fn: (s: HerdrSnapshot) => void): () => void;
  // helpers
  startAgent(o: StartAgent): Promise<AgentRef>;
  prompt(target: AgentRef, text: string, o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt>;
  sendKeys(target: AgentRef, keys: string[]): Promise<void>;
  wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus>;
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }): Promise<{ text: string; truncated: boolean }>;
  blocked(): BlockedAgent[];
  onBlocked(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void;
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void>;
  closePane(paneId: string): Promise<void>;       // refuses when it would close the tab
  closeTab(tabId: string): Promise<void>;         // refuses when it would close the workspace
  closeWorkspace(workspaceId: string): Promise<void>;   // refuses parent-worktree group widening
  agentKinds(): Promise<string[]>;                // server.agent_manifests
  installedAgentKinds(kinds: readonly string[], o: { path: string[]; aliases?: Record<string, string[]> }): string[];   // executable lookup, explicit path; aliases maps a kind to extra binary names that also count as installed
}
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
  pause(): void; resume(): void;
  exited: Promise<{ code: number | null; stderrTail: string }>;
};
```

Internal seams (stub signatures for H1):

```ts
// socket.ts (H3)
export function socketTransport(socketPath: string): HerdrTransport;
// supervise.ts (H3)
export class Supervisor {
  constructor(o: HerdrKitOptions, onState: (s: HerdrState) => void);
  env(): Record<string, string>;                 // env for cli/terminal/server per 6.3/6.5
  start(): Promise<HerdrTransport>; stop(): Promise<void>;
}
// cli.ts (H4)
export function runCli(bin: string, env: Record<string, string>, args: string[], timeoutMs?: number):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
// terminal.ts (H4)
export function openTerminal(bin: string, env: Record<string, string>, paneId: string,
  o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession;
// agents.ts (H5)
export type Call = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
export function createAgents(ctx: { call: Call; snapshot(): HerdrSnapshot }): Pick<HerdrKit,
  'startAgent' | 'prompt' | 'sendKeys' | 'wait' | 'read' | 'agentKinds' | 'installedAgentKinds'>;
// close.ts (H5)
export function closePane(call: Call, paneId: string): Promise<void>;
export function closeTab(call: Call, tabId: string): Promise<void>;
export function closeWorkspace(call: Call, workspaceId: string): Promise<void>;
// approvals.ts (H5)
export class Blocked {
  constructor(ctx: { call: Call });
  update(paneId: string, agent: HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent'], where: { workspaceId: string; tabId: string }): void;
  list(): BlockedAgent[]; on(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void;
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void>;
}
// words.ts (H8): words(key, vars?), stateWords(s: HerdrState), agentWords(s: AgentStatus | 'starting')
// notices.ts (H7; portable): sealNotice(b: BlockedAgent, boxPublicKey), openNotice(data, seed): BlockedAgent | null
```

### 6.3 Supervision and connection (`src/supervise.ts`, `src/socket.ts`)

- `own` mode: refuse unless `bin` is an absolute path to an executable (`missing/binary`). Env =
  `{ HOME: <stateDir>/herdr/home, XDG_CONFIG_HOME: <home>/.config, XDG_STATE_HOME: <home>/.local/state,
  XDG_CACHE_HOME: <home>/.cache, HERDR_SOCKET_PATH: <stateDir>/herdr/herdr.sock, PATH: path.join(':') || '/usr/bin:/bin',
  LANG: 'C.UTF-8', ...env }`; spawn `bin server` detached with that env, logs to `<stateDir>/herdr/server.log`,
  pidfile with the same cmdline check as 5.4; wait for the socket to answer `ping` (250/500/1000/2000 ms backoff,
  then fail `failed/socket`). Server exit while not stopping → `reconnecting`, respawn with the 5.4 backoff.
  `stop()`: `server.stop`, wait 3 s, SIGTERM group, 3 s, SIGKILL.
- `adopt` mode: never spawns or stops anything; `socketPath` is required.
- Both: version gate — `ping` result (and `session.snapshot` version/protocol metadata) must report
  `protocol === HERDR_PROTOCOL`, else `needs-update/version`. Then the event socket and bootstrap.
- **Socket** (`socket.ts`) = muxr `HerdrClient`: fresh connection per request (`{id, method, params}` + `\n`; answer
  matched by id; error → `Error('herdr: <code>: <message>')` with `code` property), default timeout 15 s,
  per-call override (`agent.wait`, `agent.prompt` with wait: timeout + 5 s). Event socket: one long-lived
  subscription for unfiltered kinds; `pane.agent_status_changed` per pane on its own socket (filtered kind);
  frames parsed as `{event, data}` or legacy `data.type`; an error frame with `id: ""` is a rejected subscription:
  report it via `onError` and do **not** retry that subscription; other closes reconnect after 1 s (event socket) or
  2 s (per-pane). Start retries 250/500/1000/2000 ms, then the 1 s loop; the kit stays up (`reconnecting`).
- **Bootstrap** (Herdr docs): open `events.subscribe`, wait for its ack, buffer events, call `session.snapshot`,
  install it, apply buffered events in order, continue. Re-bootstrap after every event-socket reconnect. Unfiltered
  kinds subscribed: `pane.agent_detected`, `pane.created`, `pane.closed`, `pane.moved`, `pane.exited`,
  `pane.updated`, `workspace.created`, `workspace.closed`, `workspace.renamed`, `workspace.updated`, `tab.created`,
  `tab.closed`, `tab.renamed` (muxr's verified list); per-pane `pane.agent_status_changed` for every pane with an agent.
  Agent records merge partial events (`{ ...current, ...incoming }`).

### 6.4 Helpers (`src/agents.ts`, `src/close.ts`, `src/approvals.ts`)

- `startAgent`: `worktree` → `worktree.create { cwd, branch, base? }` and use its checkout as `cwd`. Placement:
  `workspace.create { cwd, label, focus: false }` → `result.root_pane.pane_id`; `tab.create { workspace_id, cwd,
  label, focus: false }` → `result.root_pane.pane_id`; `pane.split { pane_id, direction, focus: false }` →
  `result.pane.pane_id`; `pane` → as given. Then `agent.start { pane_id, kind, name?, args?, env?, timeout_ms }`
  with call timeout `timeoutMs + 5 s`. Returns `{ paneId, name }`. Exact param spellings come from the generated
  types; where muxr and the schema disagree, the schema wins and H5 records it in `report.json`.
- `prompt`: refuse unless the agent is promptable (`launch_pending !== true`, `interactive_ready !== false`, status in
  idle/working/blocked/done) → `PublicLinkError`-compatible error code `agent-not-ready`. Call `agent.prompt
  { target: paneId, text, wait? }`; accept only a receipt with `type === 'agent_prompted'`, string `terminal_id`,
  `agent_status`, `workspace_id`, `tab_id`, `pane_id === target`, boolean `focused`, non-negative safe-integer
  `revision`; else throw `Herdr did not queue the prompt.` (muxr `promptHerdrAgent`). `agent_blocked` → error code
  `agent-blocked`.
- `wait` → `agent.wait { target, until, timeout_ms }` (always a timeout). `read` → `pane.read` and unwrap
  `result.read`. `sendKeys` → `agent.send_keys { target, keys }`.
- Close guards = muxr `closeExactPane`/`closeExactTab`/`closeExactWorkspace`: look up the parent counts first and
  refuse with codes `pane-close-would-widen`, `tab-close-would-widen`, `workspace-close-would-widen`; not-found →
  `pane-unavailable`/`tab-unavailable`/`workspace-unavailable`.
- Blocked approvals: when an agent's status becomes `blocked`, read `pane.read { source: 'detection' }` (plain text,
  last 40 lines) as `prompt` and add a `BlockedAgent` with the pane's current `revision`; leaving `blocked` resolves
  it. `answer(paneId, keys, { revision })`: `pane.get`; refuse unless still `blocked` and `revision` equals the
  pane's (`approval-stale`); then `agent.send_keys`. The kit never interprets the agent's TUI.

### 6.5 Terminal stream (`src/terminal.ts`)

`terminal(paneId, { mode, cols, rows })` spawns `bin terminal session <control|observe> <paneId> [--takeover]
--cols <cols> --rows <rows>` (`--takeover` only for `control`). Env: in `own` mode the 6.3 server env; in `adopt`
mode `{ HERDR_SOCKET_PATH: socketPath, PATH: path.join(':') || '/usr/bin:/bin', LANG: 'C.UTF-8', ...env }` so the
CLI reaches the same server (never the host process's env; the app passes `HOME`, `HERDR_CLIENT_SOCKET_PATH`,
`HERDR_SESSION` or a wider `PATH` explicitly when its Herdr needs them). `cli()` uses the same env rule. Returns
`{ ready: Promise<void>; onFrame(fn: (line: string) => void); send(line: string); close(); pause(); resume();
exited: Promise<{ code: number | null; stderrTail: string }> }`. `pause()` stops delivering frames and stops reading
the child's stdout, so a slow consumer backs up into the pipe and Herdr blocks (the kit holds a fixed backlog, not
the stream); `resume()` delivers the held frames in order and reads on. Frames are
Herdr's own NDJSON terminal protocol, passed through untouched; `ready` resolves on the first stdout line, rejects on
spawn error (ENOENT → `missing/binary`) or exit before output. stderr keeps a 4 KB tail for diagnostics only.

### 6.6 Sign-in and retained login (D11)

Herdr has no sign-in API; each agent CLI owns its login. The kit's "sign in" is: `startAgent({ kind, … })` and the
person completes that agent's own first-run login in the pane over `terminal()` (link stream `hd.terminal`).
`adopt` mode keeps the person's existing CLI logins because those CLIs read their own homes; the kit reads nothing.
`own` mode is a fresh home: each CLI logs in once there, and that home is the product's one retained signed-in home.
No credential is ever copied between homes. Words key `agent.signIn`.

### 6.7 Generation (`scripts/gen-types.ts`, H2)

Input `schema/herdr-api-0.9.1.json`. Request methods are the `const` values of the request schema's `method`
property per variant; params/result/error/event types via `json-schema-to-typescript` on each `$defs` entry the
variant references. Output `src/generated/methods.ts` (`export interface HerdrMethods { 'pane.read': { params: …;
result: … }; … }`), `events.ts` (event name → payload; filtered kinds carry their filter fields in
`HerdrSubscription`), `report.json` (`{ herdr, protocol, schemaVersion, methods, events, unmatched }`). Committed,
sorted, deterministic; a test regenerates and compares.

### 6.8 Fake runtime contract (`./testing`, H6)

- `startFakeHerdr({ dir, world? })` → `{ socketPath, bin, world, emit(event), setStatus(paneId, status), stop() }`:
  NDJSON over a unix socket, one request per connection, `events.subscribe` held open with an ack
  `{ id, result: { type: 'subscribed' } }` then `{ event, data }` frames; a batch containing a filtered kind without
  its filter answers `{ id: '', error: { code: 'invalid_subscription', … } }`; unknown method →
  `{ code: 'unknown_method' }`. World: 1 workspace, 1 tab, 2 panes (`w1:p1` shell, `w1:p2` agent `pi`), ids in the
  live `w1:p1` shape, deterministic revisions. Implements at least: `ping`, `session.snapshot`, `workspace.*`
  (`create|list|get|focus|close`), `tab.*` (`create|list|get|focus|close`), `pane.*` (`get|split|read|close|focus|
  send_keys|report_metadata|zoom|layout`), `agent.*` (`start|prompt|wait|send_keys|list|get`), `worktree.create`,
  `server.agent_manifests`, `server.stop`, `events.subscribe`. `agent.prompt` returns the receipt shape of 6.4 and
  moves the agent `working` → `idle` after 50 ms, appending `fake <kind>: <text>` to its pane text; a prompt text
  `ask permission` moves it to `blocked` with detection text `Allow this? (y/n)` until keys `y`/`n` arrive.
- `bin` is a Node shim script (shebang pins the running Node binary, 0700) answering `--version` (`herdr 0.9.1`), `api schema
  --json` (the snapshot), `server` (runs `startFakeHerdr` at `HERDR_SOCKET_PATH` until SIGTERM or `server.stop`),
  JSON CLI verbs by forwarding to the fake socket, and `terminal session control|observe` (emits one ready frame and
  echoes `send` lines as output frames; a `{"type":"fake.stream",count,size,progress}` line streams numbered frames
  as fast as the pipe takes them, recording the count written to `progress`, for backpressure tests).
- `herdrContract(make)`: ping/protocol gate, bootstrap ordering with an event racing the snapshot, rejected
  subscription surfaced once and not retried, per-pane status watch, startAgent in each placement, prompt receipt
  validation (a malformed receipt fails), wait with timeout, read unwrap, blocked → answer with stale revision
  refused → correct revision accepted, each close guard, `cli(['--version'])`, terminal ready + echo.

### 6.9 Words (`src/words.json`, H8)

| Key | Sentence |
|---|---|
| `herdr.missing` | This computer needs Herdr installed first. |
| `herdr.connecting` | Connecting to Herdr… |
| `herdr.ready` | Connected to Herdr. |
| `herdr.reconnecting` | Herdr isn't answering. Trying again by itself. |
| `herdr.needsUpdate` | Herdr on this computer needs an update to work with this app. |
| `herdr.failed` | Herdr couldn't start on this computer. Restart the app to try again. |
| `agent.starting` | Starting… |
| `agent.idle` | Ready for you. |
| `agent.working` | Working. |
| `agent.blocked` | Waiting for your answer. |
| `agent.done` | Finished. |
| `agent.unknown` | Running. |
| `agent.signIn` | Sign in inside {agent}: follow its own steps on the screen. |
| `agent.notReady` | This helper isn't ready yet. Try again in a moment. |
| `approval.stale` | That question already changed. Look again before answering. |
| `close.wouldWiden` | Closing this would close more than you picked. Close the bigger one instead. |
| `link.notAllowed` | This device can't do that. Ask the person at the computer. |

## 7. Connection adapters

Same shape in both kits; names below use `oc`/`hd`.

### 7.1 Host side (`./link`)

```ts
export function openclawLink(kit: OpenClawKit, o: {
  memberOf: (grant: Grant) => Member | undefined;          // which member a device acts for (e.g. grant.meta.member)
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: RelayClient;                                     // sealed approval push (7.3)
}): Pick<HostOptions, 'handle' | 'stream' | 'allow'>;
export function serve(o: { host: Host; port: number; via?: Via; previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void }): Promise<{ urls: string[]; ingress?: ServeIngress; close(): Promise<void> }>;
```

`serve` = `reach({ port, via, previous })` → `node:http` server on `bind:port` (answering `http` when given, else
404) with a `ws` `WebSocketServer({ server })` → `host.accept(ws, { peer: req.socket.remoteAddress })`; returns
`urls` for `host.offer({ urls, role })` and the `ingress` to persist. `herdrLink(kit, { scopeOf: (grant) =>
{ workspaces: 'all' | string[] }, passThrough?, relay? })` mirrors it.

OpenClaw ops (`handle` unless marked stream; *view* = allowed for view-role grants; all others need `control`;
every op is refused with `link.notAllowed` when `memberOf(grant)` is undefined):

| Op | Args | Returns |
|---|---|---|
| `oc.state` *view* | — | `{ state: KitState, words: string }` |
| `oc.routes` *view* | — | offered routes only (`offer: true`) |
| `oc.signin.start` | `{ provider, via }` | `SignInView` (kit picks `routeFor(provider, via)`) |
| `oc.signin.view` *view* | `{ provider }` | `{ ready, view: SignInView \| null }` for `toAccountView` |
| `oc.signin.paste` | `{ provider, text }` | `null` |
| `oc.signin.cancel` | `{ provider }` | `null` |
| `oc.signout` | `{ provider }` | `null` |
| `oc.sessions` *view* | — | `sessions.list` filtered to `agent:<member>:` keys |
| `oc.run` (stream) | `{ sessionKey?, message }` | frames `RunEvent` then `{ type: 'end', end: RunEnd }`; key defaults to `agent:<member>:link:<uuid>` |
| `oc.steer` | `{ sessionKey, text }` | `null` (key must be the member's) |
| `oc.abort` | `{ sessionKey }` | `null` (key must be the member's) |
| `oc.approvals` *view* | — | the member's `Approval[]` |
| `oc.decide` | `{ id, allow, reason?, answer? }` | `null` (approval must be the member's) |
| `oc.events` (stream) *view* | — | Gateway events whose `agentId`/`sessionKey` is the member's, plus `approval` add/resolve frames |
| `oc.notices.register` | `{ boxPublicKey }` (b64url, 32 bytes) | `null`; stored with `host.setMeta(grant.id, { ...meta, box })` |
| `oc.call` | `{ method, params }` | pass-through result, only if `passThrough(method, grant)` |

Herdr ops (*view* as above; scope = `scopeOf(grant)`; any pane/tab/workspace outside scope → `link.notAllowed`):
`hd.state` *view*, `hd.tree` *view* (snapshot filtered to scope), `hd.kinds` *view* → `agentKinds()` (the kind
picker's list; no scope applies), `hd.agent.start { kind, cwd, place }`, `hd.prompt { paneId, text }` →
`PromptReceipt`, `hd.keys { paneId, keys }`, `hd.wait { paneId, until?, timeoutMs }` → `AgentStatus` (control;
`timeoutMs` a positive finite number), `hd.read { paneId, source?, lines? }` *view*, `hd.blocked` *view*,
`hd.answer { paneId, keys, revision }`, `hd.close { pane | tab | workspace }`, `hd.events` (stream) *view* (frames
`HerdrLinkEvent`: `{ type: 'snapshot', snapshot }` in scope + `{ type: 'blocked', change, blocked }`),
`hd.subscribe` (stream) *view* `{ subs: HerdrSubscription[] }` (`kit.subscribe` over the link, one frame per
event; a filter's `pane_id` must be in scope; a grant scoped to a workspace list gets only events every workspace
id of which — any `*workspace_id` field or `workspace_ids` entry, else the workspace holding the event's `pane_id` —
is in scope; a subscribe the kit cannot open or Herdr rejects, and a kit disconnect, end the stream), `hd.terminal` (stream) `{ paneId, mode, cols, rows }`
(`control` needs the control role; view grants get `observe` only; frames are Herdr's terminal NDJSON both ways),
`hd.notices.register`, `hd.call` (pass-through, D8).

### 7.2 Device side (`./device`, portable)

The typed pass-through uses the 4.6 tables (`import type` only, so `./device` stays portable) and `./device`
re-exports them with the frame types below.

```ts
export type OpenClawLinkEvent =                             // oc.events frames
  | { [E in GatewayEventName]: { event: E; payload: GatewayEventPayload<E> } }[GatewayEventName]
  | { event: 'approval'; change: 'added' | 'resolved'; approval: Approval };
export type SessionRow = { sessionKey: string; [k: string]: unknown };
export function openclawDevice(link: DeviceLink): {
  state(): Promise<{ state: KitState; words: string }>;
  routes(): Promise<Route[]>;
  signIn: { start(p: string, via: 'browser' | 'code'): Promise<SignInView>; view(p: string): Promise<AccountView>;
            paste(p: string, t: string): Promise<void>; cancel(p: string): Promise<void> };
  signOut(p: string): Promise<void>;                        // oc.signout
  sessions(): Promise<SessionRow[]>;                        // oc.sessions
  run(message: string, o?: { sessionKey?: string }): AsyncIterable<RunEvent | { type: 'end'; end: RunEnd }>;
  steer(k: string, t: string): Promise<void>; abort(k: string): Promise<void>;
  approvals(): Promise<Approval[]>; decide(id: string, d: Decision): Promise<void>;
  events(): AsyncIterable<OpenClawLinkEvent>;
  registerNotices(seed: Uint8Array): Promise<void>;         // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null;
  call<M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>>;
};

export type HerdrLinkEvent =                                // hd.events frames
  | { type: 'snapshot'; snapshot: HerdrSnapshot }
  | { type: 'blocked'; change: 'added' | 'resolved'; blocked: BlockedAgent }
  | { type: 'raw'; line: string };                          // a line that was not JSON
export type DeviceTerminal = {
  ready: Promise<void>;                                     // first frame; rejects when the stream ends before one
  exited: Promise<{ reason: string | null }>;               // stream end; reason = the host's words, null when clean
  onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
};
export function herdrDevice(link: DeviceLink): {
  state(): Promise<{ state: HerdrState; words: string }>;
  tree(): Promise<HerdrSnapshot>;
  agentKinds(): Promise<string[]>;                          // hd.kinds
  startAgent(o: StartAgent): Promise<AgentRef>;
  prompt(paneId: string, text: string): Promise<PromptReceipt>;
  keys(paneId: string, keys: string[]): Promise<void>;
  wait(paneId: string, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus>;   // hd.wait
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }):
    Promise<{ text: string; truncated: boolean }>;
  blocked(): Promise<BlockedAgent[]>;
  answer(paneId: string, keys: string[], revision: number): Promise<void>;
  close(o: { pane?: string; tab?: string; workspace?: string }): Promise<void>;
  events(): AsyncIterable<HerdrLinkEvent>;
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void,
    onError?: (message: string) => void): () => void;       // hd.subscribe; the returned function stops it
  registerNotices(seed: Uint8Array): Promise<void>;
  openNotice(data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null;
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>): Promise<HerdrResult<M>>;
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): DeviceTerminal;
};
```

`terminal` returns synchronously over `link.stream`; sends made before the stream opens queue until it does.
The host's exit code and stderr tail stay host-side (diagnostics, 6.5). `signIn.view` returns the `AccountView` shape `useSignIn({ read, start, cancel })` expects, so a
React or React Native sign-in sheet is `useSignIn({ read: () => oc.signIn.view('openai'), start: () =>
oc.signIn.start('openai', 'code'), cancel: () => oc.signIn.cancel('openai') })`; `pairingView`, `consentWords`,
`linkWords`, `qrMatrix` from `@byokit/ui-core` cover pairing unchanged.

### 7.3 Relay, reach and seal

- **reach**: used only inside `serve()` (7.1); nothing kit-specific.
- **relay**: when `relay` is passed, each new `Approval`/`BlockedAgent` sends `relay.notify({ id: <approval id>,
  title: words('approval.notice'), data: { v: 1, sealed: b64url(sealBox(JSON.stringify(approval),
  box)) }, to: [grant.id], actions: ['allow', 'deny'] (OpenClaw) / none (Herdr), urgency: 'high' }, {
  includeContent: true })` once per device that registered a box key and may see it; the relay reads only the
  generic title. `onAction` for `allow`/`deny` calls `kit.decide(id, …)` after the same member check. Devices
  without a box key get the generic title only (`includeContent: false`).
- **seal**: `src/notices.ts` holds `sealNotice(approval, boxPublicKey)` and (portable, re-exported by `./device`)
  `openNotice(data, seed)` → `openBox` → JSON → shape-checked `Approval` or `null`.
- **ui-core**: 5.14 `toAccountView`; `stateWords`; ui-core itself unchanged.

## 8. Example apps

Two standalone apps that install **published** packages only (no workspace links, no Crewhouse or muxr source):

```
examples/openclaw-kit/  package.json  host.ts  web/index.html  web/app.ts  README.md  e2e.test.ts  LIVE.md
examples/herdr-kit/     package.json  host.ts  web/index.html  web/app.ts  README.md  e2e.test.ts  LIVE.md
```

- `package.json`: `"private": true`, dependencies on the kit and `@byokit/link`, `@byokit/reach`, `@byokit/ui-core`,
  `@byokit/seal` at exact published versions, `esbuild` (dev) to bundle `web/app.ts`. Scripts: `start` (`node
  host.ts`), `build:web`, `test` (`node --test e2e.test.ts`). Not part of the root workspaces.
- `host.ts` (OpenClaw): `new OpenClawKit({ stateDir: './.state', tools: [demo_note], host,
  config: { plugins: { allow: ['openai'] } } })` where `demo_note`
  (`{ text: string }`) is gated `{ ask: { summary: 'save a note' } }` and appends to `./.state/notes.txt`;
  `hostKeyFile('./.state/link-key.json')`; link `Host` with `openclawLink(kit, { memberOf: () => 'me' })`, grants
  in `./.state/grants.json`; `serve({ host, port: 7310 })`; also serves `web/` over plain HTTP on the same port;
  prints the offer as a terminal QR from `qrMatrix` and asks `Pair <name>? (y/n)` on stdin for `confirm`.
  Herdr: `new HerdrKit({ mode: 'own', bin: <from --herdr flag, absolute>, stateDir: './.state' })`, grants carry
  `meta.scope = { workspaces: 'all' }`, same link wiring with `herdrLink`.
- `web/app.ts`: pair (typed code or scanned offer text pasted), then OpenClaw: sign-in sheet driven by
  `phaseOf(toAccountView…)`, a message box streaming `oc.run`, an approvals list with Allow/Deny; Herdr: tree, "Start
  agent" (kind picker from `hd.agentKinds()`, op `hd.kinds`), prompt box, pane text via `hd.read` refreshed on
  `hd.events`, blocked list with key buttons `Enter`, `y`, `n`, `Esc`. Plain DOM, no framework. Works in a phone browser over LAN/Tailscale.
- `README.md`, minutes to working: prerequisites (Node 22.18; Herdr example: Herdr 0.9.1 installed; OpenClaw example:
  the first start downloads and installs the pinned engine, a few minutes, then runs offline except for the model),
  `npm i`, `npm start`, open the printed address on the phone, pair, sign in (OpenClaw: "Sign in with ChatGPT" device code;
  Herdr: log in inside the agent's pane), send a message, approve. Includes a troubleshooting table keyed by the
  words sentences.
- `e2e.test.ts` (CI, `browser` job): packs the workspace packages (`npm pack -w …`), installs the tarballs into a temp
  copy of the example (proving the published shape), starts `host.ts` with the kit's fake (`BYOKIT_EXAMPLE_FAKE=1`
  switches to `fakeGateway()` / `startFakeHerdr()` — the only env read, in example code, not library code), drives
  headless Chromium through pair → sign in (fake device code) → run with streamed text → approval Allow → result
  (Herdr: pair → start agent → prompt → receipt → `ask permission` blocked → answer `y` → idle), and asserts the
  person-visible text equals `words.json` sentences.
- `LIVE.md`: the manual end-to-end proof, run once per kit release in the isolated lab: real engine (OpenClaw) with a
  real ChatGPT sign-in in the lab's retained test home, phone pairing over Tailscale, run + approval; real Herdr
  v0.9.1 in `own` mode (under a `--herdr-lab` brief) with one agent CLI signed in inside the lab home. Record date,
  versions and screenshots path in the PR.

## 9. Tests, CI and isolation

- Every kit test runs under `scripts/test.sh` (throwaway HOME, `~/.pi` byte check, temp-dir leak check, an egress
  guard that blocks non-loopback connects and datagrams in every node of the run); temp dirs
  use the `byokit-` prefix helper in `packages/test-support.ts`.
- Portability: `packages/openclaw/test/portable.test.ts` and `packages/herdr/test/portable.test.ts` bundle
  `./device` for `browser` and `react-native` conditions with esbuild and fail on any `node:*` or Node-only import
  (same approach as `packages/accounts/test/portable.test.ts`).
- Isolation: a kit test runs the fake runtime with a decoy HOME containing `.pi`, `.openclaw`, `.codex`, `.claude`,
  `.config/herdr` canaries (`packages/accounts/src/testing`) and asserts they are untouched and never opened.
- `npm run test:engine` (new root script) = `sh scripts/test.sh 'packages/openclaw/test/engine/*.test.ts'`. CI job
  `openclaw-engine` (Node 24, 20 min, `actions/cache` on `~/.npm`) runs it after build.
- Herdr: no CI job touches a real Herdr. The H9 lab run uses `herdrContract` against v0.9.1 in `own` mode inside a
  task-owned HOME.
- Release: `release.yml` `options` gain `openclaw` and `herdr`.

## 10. Extraction and adoption order

1. byokit builds `@byokit/openclaw` (O1–O12) and `@byokit/herdr` (H1–H10) in parallel lanes; each merged PR keeps
   `npm test` green; nothing is published until a kit's O11/H9 proof is green. Until then each kit's
   package.json carries "private": true (the release command skips private packages); the PR that lands
   O12 (openclaw) / H10 (herdr) removes it.
2. Owner publishes `@byokit/openclaw` 0.1.0 via `release.yml`.
3. **Crewhouse adopts** (O13), one Crewhouse PR: depend on `@byokit/openclaw` exactly; replace
   `src/openclaw/{gateway.ts,bridge.ts,plugin/,policy.mjs}` and the engine/sign-in/migration/run parts of
   `runtime.ts` with a thin `OpenClawRuntime implements AgentRuntime` over the kit; keep product parts (tool schemas
   and descriptions, `trusted-skills.json`, `files.ts`, curation/learned-skills git, `learned`/`forget`/
   `runCollectionReview`/`setLearning`) in Crewhouse, implemented with `kit.call`/`kit.patchConfig`/`kit.allowOnce`.
   Parity settings: `plugin.id: 'crewhouse'`, `bridge: { socketName: 'crewd.sock', paramPrefix: '__crewhouse' }`,
   member `m<N>`, `permitted: t => t.startsWith('crew_')`,
   `installPolicy: { trustedSkills: src/openclaw/trusted-skills.json, ownRoots: [repo, crewDir] }`, the exact
   Crewhouse `config`, callback port from `CREWHOUSE_CALLBACK_PORT`/1455, `RunEnd` mapped back to Crewhouse's
   `kind: 'other'` with the original message (crew.ts keeps classifying). `runtime/openclaw/` is deleted; the first
   boot after upgrade reinstalls the engine into `<stateDir>/openclaw/engine` (state untouched). Tests that reached
   into `runtime.client` inject the kit's `transport` option instead; every assertion otherwise unchanged. Proof:
   Crewhouse `npm test` green including the real-engine files, plus one real journey (sign-in retained across the
   upgrade, a run with a gated tool, an approval from the phone) recorded in the PR.
4. Owner publishes `@byokit/herdr` 0.1.0.
5. **muxr adopts later and separately** (H11, not scheduled here): only after `@byokit/herdr` is published and
   muxr's byokit cutover allows it; muxr first requires Herdr ≥ the kit's pin; the swap is behind muxr's own
   acceptance and must not change muxr behavior; muxr stability wins every conflict.

## 11. Work packages

Builders: **Sol** = `openai-codex/gpt-6-sol`, thinking medium (judgment-heavy: supervision, auth, approvals, link,
extraction seams). **Flash** = `zai/glm-5.3-flash`, thinking medium (mechanical: scaffolds, generated types,
fakes, words, examples, tests). Each package is one direct PR to byokit (except O13), commits only its listed files
(plus lockfile), keeps `npm run build`, `npm run check`, `npm test` green, and does not edit files owned by another
package except where listed. Sol packages may wait for quota; Flash packages never depend on an unmerged Sol
package unless the table says so.

Stubs rule: O1/H1 create **every** `src/*.ts` file listed in 5.1/6.1 with the exact exported signatures from this
document and bodies `throw new Error('not built: <package id>')`. Later packages replace bodies only; a signature
change is a spec change (stop and ask).

### 11.1 Dependency graph

```
Flash now:  O1 ─┬─ O2 ─────────────┐                 H1 ─┬─ H2* ─────────┐
                ├─ O7 ─┬─ O8        │                     ├─ H4            │
                │      └──────────┐ │                     ├─ H6 ─────────┐ │
                └─ O10            │ │                     └─ H8          │ │
Sol:            O3 (O1)           │ │                 H3 (H1,H2,H6)      │ │
                O4 (O1,O2)        │ │                 H5 (H3,H6)         │ │
                O5 (O1,O7)        │ │                 H7 (H3,H4,H5,H8)   │ │
                O6 (O1,O7)        │ │
                O9 (O4,O5,O6,O8,O10)
                O11 (O3,O4,O5,O6,O8)                  H9* Flash (H3,H5,H7) lab
Flash last: O12 (O9,O11)                              H10 Flash (H7,H9)
Sol after publish: O13 (crewhouse repo)               H11 later, muxr repo (not scheduled)
* needs a --herdr-lab brief
```

Parallel boundaries: OpenClaw and Herdr lanes share no files except root `package.json` (build list and scripts),
`tsconfig.json`, `.github/workflows/*.yml`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md` — touched only by O1, O11,
H1, and O12/H10 (README example rows); later merges rebase.

### 11.2 OpenClaw lane

**O1 — scaffold and stubs** · Flash · deps: none
- Files: `packages/openclaw/{package.json,tsconfig.json,README.md,CHANGELOG.md,LICENSE}`, all `src/*.ts` stubs
  (5.1) with 5.2/5.3/5.13/7.1/7.2 signatures, `src/constants.ts` (`ENGINE_VERSION`, `PROTOCOL_VERSION`, `OPERATOR_SCOPES`
  per D6), `engine/package.json` + `engine/package-lock.json` (`npm install --package-lock-only openclaw@2026.8.1`,
  scripts off), `plugin/package.json` (`{"name":"byokit-openclaw-bridge","version":"0.1.0","type":"module",
  "openclaw":{"extensions":["./index.js"]}}`), empty `plugin/index.js` and `policy/policy.mjs` placeholders
  exporting nothing; root `package.json` build list gains `packages/openclaw`; `release.yml` options gain `openclaw`;
  `README.md` package table row (State: "in development").
- Acceptance: `npm run build && npm run check && npm test` green; new `packages/openclaw/test/portable.test.ts`
  (section 9) passes on the stubs; `test/exports.test.ts` imports each entry and asserts the exported names listed in
  5.3/7.1/7.2 exist.

**O2 — method and event tables** · Flash · deps: O1
- Files: `scripts/gen-methods.ts`, `scripts/method-types.json`, `src/generated/{methods,events}.ts`,
  `src/generated/report.json`, root script `gen:openclaw`; `src/types.ts` gains `GatewayMethod`, `GatewayParams`,
  `GatewayResult`, `GatewayEventName`, `GatewayEventPayload` re-exports.
- Procedure: 5.10 exactly. Fill `method-types.json` by searching exported names for every method still unmatched
  after rules 2–3 (mechanical); leave truly absent types as `unknown`.
- Acceptance (`test/generated.test.ts`): exactly 382 operator methods and 11 node methods (393 total; the 24 aux
  names are already in the core list) and 55 events, recorded in `report.json`; node methods present with
  `role: 'node'` and absent from `GatewayMethod`; the methods Crewhouse calls or tests plus the approval resolvers
  (`agents.list`, `agents.create`, `models.authStatus`,
  `models.authLogout`, `openclaw.setup.auth.start`, `wizard.next`, `wizard.cancel`, `wizard.status`, `config.get`,
  `config.patch`, `agent`, `agent.wait`, `sessions.steer`, `chat.abort`, `health`, `skills.proposals.list`,
  `skills.proposals.reject`, `skills.proposals.quarantine`, `skills.curator.status`, `cron.list`, `cron.run`,
  `cron.runs`, `exec.approval.resolve`, `plugin.approval.resolve`, `question.resolve`, `sessions.list`; all verified
  present in 2026.8.1 while writing this spec) are in the table; events include `agent`, `exec.approval.requested`,
  `plugin.approval.requested`, `question.requested` and their `.resolved`; a type-level test file compiles
  `call('models.authStatus', { agentId: 'm1' })` and fails to compile `call('node.invoke.result', …)`.

**O3 — engine supervisor and config invariants** · Sol · deps: O1
- Files: `src/engine.ts`, `src/config.ts`, `test/config.test.ts`, `test/engine-unit.test.ts`,
  `test/engine/isolation.test.ts`; root `package.json` script `test:engine`; `.github/workflows/ci.yml` job
  `openclaw-engine`.
- Behavior: 5.4, 5.5, 5.6.
- Acceptance: `config.test.ts` (no engine): fresh config has every invariant; an existing config with
  `memory.search { provider: 'auto', fallback: 'openai' }` and `agents.entries.m9.memory.search.provider: 'openai'`
  comes out `none`/`none`/`none`; a loopback ollama without key stays; app `config` cannot override `gateway.bind`,
  `controlUi`, `tailscale`, `mdns`; unchanged input writes nothing (mtime stable). `engine-unit.test.ts` with a fake
  engine entry (a Node script the test writes that exits 78 once then serves nothing): doctor repair runs once,
  stale pidfile of an unrelated process is not signalled, state sequence `installing?→starting→repairing→failed`
  observed. `engine/isolation.test.ts` (engine job) = Crewhouse `openclaw.test.ts` ported: decoy HOME canaries
  untouched, env has no `OPENAI_API_KEY`/`.pi`, `OPENCLAW_SKIP_CHANNELS=1`, only loopback listeners, port ≠ 18789,
  plugin loaded, memory invariants.

**O4 — transport, facade and pass-through** · Sol · deps: O1, O2
- Files: `src/transport.ts`, `src/kit.ts`, `src/members.ts`, `test/kit.test.ts`, `test/transport.test.ts`.
- Behavior: real `GatewayTransport` over `GatewayClient` (url `ws://127.0.0.1:<port>`, token, role `operator`,
  `OPERATOR_SCOPES`, `clientName: 'cli'`, device identity + `hostDeps` signing as Crewhouse, `caps: ['tool-events']`);
  hello → `kit.hello`; warn (via `log`) for generated methods missing from `hello.features.methods` and vice versa;
  `call` = `transport.request`; `callDynamic` refuses names present in the generated operator table (use `call`) and
  node-role names; `onEvent` fan-out; `ensureMember` (5.8); `patchConfig`; `memoryLimited`; facade delegates every
  other method to its module (stubs until built). `spawnEngine: false` + `transport` factory skips engine.
- Acceptance (`kit.test.ts`, fake transport from a minimal in-test double until O7 lands, then `fakeGateway`):
  `call` forwards method/params/options; `callDynamic('health')` rejects; member id `M1` and `a`×33 rejected;
  `ensureMember` creates once, cached; events reach `onEvent('*')` and typed listeners; transport close during
  `ready` moves state to `restarting` when the engine is supervised, `failed/handshake` when not.

**O5 — bridge, plugin, policy and approvals** · Sol · deps: O1, O7
- Files: `src/bridge.ts`, `src/approvals.ts`, `plugin/index.js`, `policy/policy.mjs`, plugin manifest writer in
  `src/bridge.ts` (`writePlugin(root, id, tools)`), `test/bridge.test.ts`, `test/policy.test.ts`,
  `test/approvals.test.ts`.
- Behavior: 5.9.
- Acceptance: `bridge.test.ts` = Crewhouse `openclaw-bridge.test.ts` ported (unknown run fails closed; call without
  gate fails; permit works once; permit bound to exact input) plus: `permitted` false tool needs no permit;
  `allowOnce` admits exactly one matching unregistered call inside the window and none after, none for another key
  prefix/tool/input; `{ ask }` parks until `decide` allow → `{ allow: true, permit }`; deny → reason; expiry at
  `approvalTimeoutMs` → deny with `approval.expired` words; a garbage frame → `{ allow: false }`.
  `policy.test.ts` = Crewhouse `policy-install.test.ts` ported to env inputs. `approvals.test.ts` with
  `fakeGateway`: `exec.approval.requested` → `approvals()` has it with `source: 'exec'`; `decide` calls
  `exec.approval.resolve`; `.resolved` removes it; same for plugin and question; member attribution from
  `agent:<member>:` keys. Plugin manifest written with the given tool names; rewriting with the same tools leaves
  bytes identical.

**O6 — sign-in, routes and retained-login migration** · Sol · deps: O1, O7
- Files: `src/signin.ts`, `src/routes.json`, `src/routes.ts`, `src/migrate.ts`, `test/signin.test.ts`,
  `test/routes.test.ts`, `test/migrate.test.ts`, `test/engine/signin.test.ts`, `test/engine/migrate.test.ts`.
- Behavior: 5.7.
- Acceptance: `signin.test.ts` = Crewhouse `openclaw-wizard.test.ts` non-engine cases ported (code pulled and shown,
  finishes with the engine; giving up cancels its own session; person cancel cancels) plus: browser route holds the
  callback port and pastes the redirect; port taken → `why: 'busy'`; `wizard.status` never called.
  `routes.test.ts`: every choice id in `routes.json` exists in the pinned tarball (engine job reads it; the non-engine
  test checks shape: billing ∈ {subscription, api, local}, `offer` boolean, reason non-empty); no `anthropic-*`
  route has `offer: true`. `migrate.test.ts` (no engine, doctor stubbed via an injected runner): staging shape
  `{ version: 1, profiles: { 'openai-codex:default': … } }`, 0600; failed doctor removes staging and leaves source
  bytes identical; confirm renames only when all providers are present, writes the marker, never on empty source;
  record source returns true and touches no file. `engine/*` = Crewhouse `openclaw-wizard.test.ts` real-gateway case
  and `openclaw-migrate.test.ts` real cases ported.

**O7 — fake gateway, contract suite, model stub** · Flash · deps: O1
- Files: `src/testing/{index,fake-gateway,contract,model-stub}.ts`, `test/fake.test.ts`.
- Behavior: 5.11. The contract suite may reference kit methods still stubbed; its cases are only *run* by O11.
- Acceptance: `fake.test.ts` exercises every default handler directly through `transport.request` (not through the
  kit); `failNext` and `drop` behave as documented; `startModelStub` answers the Crewhouse script grammar (port its
  unit cases from Crewhouse `openclaw-stub.ts` behavior: tool calls with nested JSON, `hit the limit` error text).

**O8 — runs, classification, sessions** · Flash · deps: O1, O7
- Files: `src/runs.ts`, `src/classify.ts`, `test/runs.test.ts`, `test/classify.test.ts`.
- Behavior: 5.8 (run/steer/abort/classify).
- Acceptance: `classify.test.ts` covers each regex branch of Crewhouse `classifyText` and the kind mapping with
  `until`; `runs.test.ts` with `fakeGateway`: a run streams text events in order and ends ok; a foreign session key
  (`agent:m2:` for member `m1`) is refused before any request; `register: false` skips bridge registration; abort
  mid-run ends `{ aborted: true }`; an `agent.wait` error message `usage limit, try again in 5 min` ends
  `{ kind: 'resting', until: ≈now+5 min }`; listeners are removed after the run (no leak across 100 runs).

**O9 — link adapter, device client, sealed notices** · Sol · deps: O4, O5, O6, O8, O10
- Files: `src/link.ts`, `src/device.ts`, `src/notices.ts`, `test/link.test.ts`, `test/device.test.ts`.
- Behavior: 7.1–7.3 for OpenClaw.
- Acceptance: over a real `Host` + `DeviceLink` pair on loopback (as `packages/link/test` do) with `fakeGateway`:
  every op in the 7.1 table round-trips; view grant refused on every non-*view* op with `link.notAllowed`; device of
  member `a` cannot see/decide/steer member `b`'s sessions or approvals; `oc.call` refused by default and allowed by
  predicate; `oc.run` stream frames end with `end`; `oc.events` filtered; `registerNotices` + an approval produces a
  relay `notify` (fake `RelayClient` recorder) with only the generic title in clear and `openNotice` recovering the
  approval with the right seed and `null` with a wrong one; push action `allow` decides it; `serve()` binds per
  `reach` result (inject `interfaces`, no Tailscale). `device.test.ts`: `./device` bundle portability (from O1)
  still green; `signIn.view` output passes `phaseOf` to `waiting`/`code`/`done` for the matching views.

**O10 — words and ui mapping** · Flash · deps: O1
- Files: `src/words.json`, `src/words.ts`, `test/words.test.ts`.
- Behavior: 5.14 table verbatim; `words`, `stateWords`, `toAccountView`.
- Acceptance: every key present with the exact sentence; banned-jargon regex (4.3) passes; every `KitState.phase`
  has a sentence; `toAccountView` result is assignable to `@byokit/ui-core`'s `AccountView` (type test) and
  `phaseOf` yields `opening`, `waiting`, `code`, `done`, `busy`, `cancelled`, `expired`, `failed` for the matching
  inputs.

**O11 — real-engine integration** · Sol · deps: O3, O4, O5, O6, O8 (O7 merged)
- Files: `test/engine/contract.test.ts`, `test/engine/run.test.ts`, `test/engine/generated.test.ts`, fixes inside
  O3–O8 files only where the real engine disagrees with the fake (each fix also updates the fake and contract).
- Acceptance: `openclawContract` passes against `fakeGateway` (in `npm test`) **and** against the real pinned engine
  with `startModelStub` (engine job); `run.test.ts` = Crewhouse `openclaw-run.test.ts` ported (real tool call crosses
  the fail-closed gate; keyword-only memory never requests embeddings; no `/v1/embeddings` call); `generated.test.ts`
  regenerates the tables from the pinned tarball and diffs the committed ones; `hello.features.methods` ⊇ every
  generated operator method (else list them in `report.json` and fail); every `offer: true` route starts on the real
  engine with only its `plugin` allowed; `exec.approval.requested`/`plugin.approval.requested` from the real engine
  carry the requesting member in `Approval.member`.

**O12 — example app** · Flash · deps: O9, O11
- Files: `examples/openclaw-kit/*` (section 8), root `README.md` examples line, CI `browser` job step running
  `examples/openclaw-kit/e2e.test.ts`.
- Acceptance: `e2e.test.ts` green in CI against the fake; README steps followed verbatim in a clean temp dir with
  packed tarballs work (the test does exactly this); `LIVE.md` present with the procedure (the live run itself is a
  lab task for firstmate, recorded later).

**O13 — Crewhouse adoption** · Sol · deps: `@byokit/openclaw` published · repo: Crewhouse
- Files: Crewhouse `package.json`, `src/openclaw/runtime.ts` (thin adapter), `src/openclaw/tools.ts` (schemas and
  descriptions moved from `plugin/index.js`), delete `src/openclaw/{gateway.ts,bridge.ts,plugin/,policy.mjs}`,
  `runtime/openclaw/`, `test/openclaw-stub.ts` (use the kit's), test injection seams.
- Behavior and acceptance: section 10 step 3. Parity checklist in the PR: plugin loaded as `crewhouse` with
  `bridge: { socketName: 'crewd.sock', paramPrefix: '__crewhouse' }` passed explicitly; same
  `openclaw.json` bytes after prepare on an existing state except kit-owned plugin path/env names; sign-in flows;
  migration; bridge permits; curation window; memory never paid; latency of a first token within ±10 % of before on
  the stub model (measured by Crewhouse's existing timing, if any, else recorded).

### 11.3 Herdr lane

**H1 — scaffold and stubs** · Flash · deps: none
- Files: `packages/herdr/{package.json,tsconfig.json,README.md,CHANGELOG.md,LICENSE}`, all `src/*.ts` stubs (6.1)
  with 6.2/7.1/7.2 signatures, `src/constants.ts` (`HERDR_VERSION = '0.9.1'`, `HERDR_PROTOCOL` placeholder `0` with
  a test that fails until H2 sets it — marked `todo` in `node:test`), root build list, `release.yml` option `herdr`,
  README package row; `README.md` and `CONTRIBUTING.md` isolation sentences amended: "Runtime kits drive only the
  aggregator the app names explicitly (the OpenClaw engine the kit installs, the Herdr binary and socket the app
  passes); byokit tests use fakes and never a person's Herdr."; `AGENTS.md` line pointing at this document.
- Acceptance: build/check/test green; `test/portable.test.ts`; `test/exports.test.ts` as O1.

**H2 — schema snapshot and types** · Flash · deps: H1 · **needs a `--herdr-lab` brief**
- Files: `schema/herdr-api-0.9.1.json`, `schema/SOURCE.md`, `scripts/gen-types.ts`, `src/generated/*`,
  `src/constants.ts` (`HERDR_PROTOCOL`), root script `gen:herdr`, root devDependency `json-schema-to-typescript`.
- Procedure: in the lab, install Herdr v0.9.1 from the GitHub release into a task-owned dir, record the asset URL and
  sha256; with `HOME` set to a task-owned empty dir run `herdr api schema --output schema/herdr-api-0.9.1.json`
  (prints the bundled schema; starts no server); record `herdr --version`. If the tagged source tree carries the
  schema file, use that instead and record its URL + sha256. Then 6.7.
- Acceptance (`test/generated.test.ts`): regeneration from the snapshot equals committed output; every method muxr
  calls (section 3.2 list: `pane.close|get|read|split|send_keys|report_metadata|focus_direction|focus|zoom|layout`,
  `workspace.list|get|close|focus|create`, `tab.get|close|list|focus|create`, `plugin.list|log.list|action.invoke`,
  `session.snapshot`, `layout.export|apply`, `agent.start|prompt|send_keys|wait`, `worktree.create`,
  `server.agent_manifests`, `events.subscribe`, `ping`) is present, or is listed in `report.json` `missing` and the
  package reports `blocked` to firstmate instead of merging.

**H3 — socket, supervision, bootstrap, facade** · Sol · deps: H1, H2, H6
- Files: `src/socket.ts`, `src/supervise.ts`, `src/kit.ts`, `test/socket.test.ts`, `test/supervise.test.ts`.
- Behavior: 6.3; facade delegates helpers to their modules.
- Acceptance with `startFakeHerdr`: request per connection; error frames → coded errors; timeouts; rejected
  subscription (bad batch) surfaced once, not retried; per-pane status socket; event socket drop → re-bootstrap
  with an event emitted between subscribe-ack and snapshot applied after the snapshot, no duplicate; protocol
  mismatch → `needs-update`; `adopt` never spawns (spy) and `stop()` leaves the fake running; `own` mode spawns the
  fake bin's `server` verb with the exact env of 6.3 and nothing from `process.env` (the fake records its env; the
  test compares); relative `bin` refused (`missing/binary`); server exit → `reconnecting` then respawn.

**H4 — CLI runner and terminal process** · Flash · deps: H1
- Files: `src/cli.ts`, `src/terminal.ts`, `src/kit.ts` (`cli`/`terminal` wiring to `runCli`/`openTerminal`
  per the 6.5 env rule), `test/cli.test.ts`, `test/terminal.test.ts`, `test/contract.test.ts` (`herdrContract`
  against `startFakeHerdr`).
- Behavior: `cli` = muxr `runHerdrCli` with `bin` from options (no env read), same validation (non-empty string
  array, no NUL), timeout clamp 1 s–5 min, 8 MB buffer, env per 6.5; `terminal` per 6.5.
- Acceptance with a test-written shim script: argv passed one-per-arg (an arg with spaces and quotes survives);
  NUL rejected; timeout reports `timedOut: true`; terminal `control` passes `--takeover`, `observe` does not; `ready`
  rejects on ENOENT with `missing/binary` and on exit-before-output with the stderr tail; frames pass through
  byte-identical.

**H5 — agent helpers, close guards, blocked approvals** · Sol · deps: H3, H6
- Files: `src/agents.ts`, `src/close.ts`, `src/approvals.ts`, `test/agents.test.ts`, `test/close.test.ts`,
  `test/approvals.test.ts`.
- Behavior: 6.4.
- Acceptance with `startFakeHerdr`: `startAgent` in all four placements plus worktree returns the new pane id taken
  from the response, never predicted; prompt receipt validation (each malformed field variant from muxr's check
  rejected); not-promptable agent refused without a socket call; `agent_blocked` mapped; each close guard refuses
  widening and maps not-found; blocked → `onBlocked` added with detection text and revision; `answer` with stale
  revision refused (`approval-stale`), with current revision sends keys and the agent resolves.

**H6 — fake Herdr and contract suite** · Flash · deps: H1 (types from H2 when merged; uses string methods until then)
- Files: `src/testing/{index.ts,contract.ts}`, `src/testing/fake-herdr/{server,world,bin}.ts`, `test/fake.test.ts`.
- Behavior: 6.8, ported from muxr `perf/fake-herdr/{server,world,bin}.mjs` with muxr UI plugins, title churn and
  perf byte rates removed.
- Acceptance: `fake.test.ts` hits every listed method directly over the socket and every bin verb via
  `execFile`; subscribe semantics (ack, frames, empty-id rejection); `ask permission` blocked flow; `stop()` removes
  the socket and leaves no temp dirs.

**H7 — link adapter, device client, terminal over link, notices** · Sol · deps: H3, H4, H5, H8
- Files: `src/link.ts`, `src/device.ts`, `src/notices.ts`, `test/link.test.ts`, `test/device.test.ts`.
- Behavior: 7.1–7.3 for Herdr.
- Acceptance: as O9 with Herdr ops: scope enforcement per workspace list; view grant gets `observe` terminal only
  and cannot prompt/keys/answer/close; `hd.terminal` round-trips frames both ways against the fake bin; blocked agent
  produces a sealed notice; `hd.call` default-denied.

**H8 — words and states** · Flash · deps: H1
- Files: `src/words.json`, `src/words.ts`, `test/words.test.ts`.
- Acceptance: 6.9 table verbatim; jargon regex (4.3); every `HerdrState.phase` and
  `AgentStatus` has a sentence; `stateWords`/`agentWords` helpers typed.

**H9 — lab contract run against real Herdr** · Flash · deps: H3, H5, H7 · **needs a `--herdr-lab` brief**
- Files: `packages/herdr/test/lab/contract.lab.ts` (not matched by `npm test`'s glob), `schema/LAB.md` result log.
- Procedure: task-owned HOME; Herdr v0.9.1 from H2's recorded asset; `HerdrKit({ mode: 'own', bin, stateDir })`;
  run `herdrContract` excluding cases that need a signed-in agent CLI (start `pi`-kind agent only if the lab home has
  one; otherwise the agent cases use a `bash` custom kind if the schema supports it, else they are recorded as
  skipped with the reason). Any fake/real disagreement is fixed in the fake and the contract (PR), never by
  loosening a kit check.
- Acceptance: `LAB.md` lists every contract case pass/skip with reasons, Herdr version and sha256; zero failures.

**H10 — example app** · Flash · deps: H7, H9
- Files: `examples/herdr-kit/*` (section 8), README examples line, CI `browser` job step.
- Acceptance: as O12 against `startFakeHerdr` (the example's `--herdr` flag points at the fake bin in the test).

**H11 — muxr adoption** · Sol · later, separate · repo: muxr
- Not scheduled by this foundation. Preconditions in section 10 step 5. Recorded so nobody starts it early.

## 12. Known facts builders must not re-derive

OpenClaw (pinned 2026.8.1, verified in Crewhouse at `a9ca74e`):
- The wizard hands out steps only when pulled with `wizard.next`; `wizard.status` answers `{ status, error }` and
  never carries a step. A running session holds the engine's single setup admission; always cancel your own.
- The engine cannot bind ChatGPT's 1455 callback first; the host holds it and pastes the redirect.
- Doctor refuses to run while a Gateway owns the state dir; it exits 0 even when it imports nothing, so only the
  Gateway's `models.authStatus` confirms an import. Staging `auth.json` instead of `auth-profiles.json` imports the
  old provider id as-is (looks signed in, cannot authenticate `openai/*`).
- `openai/*` must use `agentRuntime: { id: 'openclaw' }`; an explicit `modelPolicy.allow` must include `openai/*`.
- Unset/auto memory search defaults to API-billed OpenAI embeddings; force `none` (or local) and `fallback: 'none'`.
- Exit code 78 at start is repaired by one doctor `--fix` run.
- Plugin `before_tool_call` hook timeout must exceed the bridge relay timeout (200 s > 195 s).

Herdr (muxr notes verified on 0.8.0; H2/H9 re-verify on 0.9.1):
- One request per connection; the server closes after answering; only `events.subscribe` stays open.
- A rejected subscribe answers `id: ""`; one invalid kind rejects the whole batch; `pane.agent_status_changed` is a
  filtered kind needing `pane_id`.
- Event frames are `{ "data": {…}, "event": "pane.x" }`; older frames carry `data.type`.
- Results nest under per-method keys (`pane.read` → `result.read.text`, `pane.split` → `result.pane.pane_id`,
  `workspace.create` → `result.workspace` / `result.root_pane`, `pane.zoom` → `result.zoom`).
- `agent.start` needs the pane at a shell prompt and blocks until detection (pass a generous timeout). Waits have no
  default timeout. `agent.prompt` with `wait` needs a state change within 5 s or returns `agent_prompt_stalled`; a
  `blocked` agent returns `agent_blocked` without sending input.
- Alternate-screen agents keep no Herdr scrollback (`max_offset_from_bottom: 0`); read with `recent`/`recent_unwrapped`.
- Socket path resolution: `--session` > `HERDR_SOCKET_PATH` > `HERDR_SESSION` > default; on Windows it is a named
  pipe (Node `net.connect` accepts the pipe path).
