# Runtime kit: `@byokit/herdr`

Foundation spec and builder breakdown. Status: **built; `@byokit/herdr` 0.1.0 is published.** Capability kits have their own spec:
[docs/capability-kits.md](capability-kits.md).
Direction: the maintainer's 2026-09-28 clarification.
This document is the single source of truth for the build lanes. A builder follows it literally; where it is silent,
the builder stops and asks rather than designs. Section 11 is the work-package list.

Contents: [1 Goal](#1-goal) · [2 Decisions](#2-decisions) · [3 Sources and path drift](#3-sources-and-path-drift) ·
[4 Shared conventions](#4-shared-conventions) ·
[6 `@byokit/herdr`](#6-byokitherdr) · [7 Connection adapters](#7-connection-adapters) ·
[8 Example apps](#8-example-apps) · [9 Tests, CI and isolation](#9-tests-ci-and-isolation) ·
[10 Extraction and adoption order](#10-extraction-and-adoption-order) · [11 Work packages](#11-work-packages) ·
[12 Known facts builders must not re-derive](#12-known-facts-builders-must-not-re-derive)

## 1. Goal

BYOKit gains a **runtime kit** for the Herdr aggregator. It owns "use the customer's subscriptions through this
aggregator" and exposes the aggregator's **full** power:

- **`@byokit/herdr`** connects to (or owns) a Herdr server: workspaces, tabs, panes, agents, agent state, prompt
  delivery with receipts, output and terminal streaming, blocked-agent approvals. Each coding agent in Herdr keeps its
  own subscription login. Extracted from muxr's Herdr integration.

`@byokit/endpoint` sits beside it as a small second runtime kit: it is not an aggregator for subscriptions, but runs the
checksum-pinned CLIProxyAPI on loopback for one API key (key routes only, no sign-in, no pool) and serves it as one local address.

`@byokit/pi` runs one exactly pinned Pi process per bot, each in its own Pi home, session folder and extension list. Its public API is
the app's port: only `packages/pi/src/transport.ts` knows Pi, so no Pi type or record reaches an app. A bot's optional `launch` maps the
command the kit would run to the command it runs, so an app can wall the whole process; a `launch` that fails starts nothing.

The aggregator kit: typed helpers for the common paths **plus** a first-class typed pass-through to the complete supported
surface (Herdr socket API and CLI), so no consumer forks or bypasses the kit.
It uses the connection adapters (`link`, `relay`, `discover`, `seal`, `ui`) and conventions. `@byokit/accounts` keeps serving direct-provider apps (including Ownvoice); CLI sign-in status lives in `@byokit/herdr` `agentStatus` (B5) and, for its managed Claude/Codex/Pi folders, `@byokit/accounts/cli` `status`; 6.6 names which one gates a move (MS-S2). Native CLI sign-in (`anthropic-cli`) is the only other accounts use: `cliAccounts` and `remoteCliHost`, named below.

Out of scope for the build phase: releasing (the maintainer runs `release.yml`), muxr adoption (section 10), any
operated service, and any change to `@byokit/accounts`, `link`, `relay`, `discover`, `seal`, `decide` or `ui`
source, except `@byokit/accounts/cli` `launch` (MS-S2, 6.6) and the native sign-in surface (`managedFolders`, `folderOf`, `remoteCliHost`, `signInLock`).

## 2. Decisions

These close every design call. Builders do not reopen them; a reviewer who disagrees raises it with the maintainer.

| # | Decision |
|---|---|
| D1 | Package name `@byokit/herdr`, in `packages/herdr`, Apache-2.0, ESM, Node ≥ 22.18, same source rules as the rest of the repo (type-stripped TS, `.ts` imports, no enums/namespaces/parameter properties). |
| D2 | Entries: `.` (Node host side), `./device` (portable: browsers, React Native, Node; no `node:*` or Node-only imports), `./link` (Node host-side link/relay/seal adapter), `./testing` (fakes, contract suites, scripted model). No other entries. |
| D3 | Connection adapters ship **inside the kit** (`./link`, `./device`). No new shared glue package; the ~40 lines of `serve()` wiring stay in the kit (`ponytail:` comment naming the upgrade path: extract when a second runtime kit appears). |
| D5 | Herdr pin is **v0.9.1** (latest release on 2026-09-28). The kit bundles that release's `herdr api schema --json` snapshot; a server whose reported protocol differs from the snapshot's is state `needs-update`. muxr, which requires ≥ 0.8.0 today, must move to the kit's pin as a precondition of its later adoption. |
| D7 | "Complete supported surface", Herdr: every request method and event in the pinned schema (typed `call`, typed `subscribe`), the raw CLI as `cli(argv)` (complete by construction), and a typed wrapper for the one CLI-only surface the socket lacks (`terminal session control|observe`). |
| D8 | Host-side kit APIs are full-power. Over a link, the pass-through (`hd.call`) is **denied by default**; an app opts in with a `passThrough(method, grant)` predicate. Typed link ops are always member/scope-checked. |
| D9 | Members. Herdr: no member concept upstream; a link grant carries `meta.scope = { workspaces: 'all' \| string[] }`. |
| D10 | Approvals. Herdr: an agent in `blocked` state is an approval; the answer is keys sent to that exact pane occupant, refused when the question it names is gone (kit-issued revision plus the question text read back; the pane revision alone is not the identity). |
| D11 | Sign-in: sign in once. Herdr: each agent CLI's own login, done by the person inside an account-specific pane (terminal stream); `openSignInTab` opens that CLI in a new tab with the host's explicit account environment. Without the person's consent the kit never runs a login command, copies credentials between homes, or reads a CLI's credential files. |
| D12 | Route policy is data: subscription routes are offered by default with plain sign-in; API-billed routes are app opt-in only. Proxy routes, compatibility aliases and local runtimes are listed in discovery and used only when named (D18). Native login is completed in the agent CLI, or adopted from the machine's existing Claude/Codex login with the person's consent (D11). No consent screen or terms gate is added. |
| D13 | Library code reads no environment variables except `PATH`. Every spawned process gets an explicit env; `process.env` is never inherited. The Herdr binary path is always an explicit option. |
| D14 | `npm test` stays network-free. Real-Herdr contract runs happen only in an isolated lab under a `--herdr-lab` brief, never in CI and never against a person's Herdr. |
| D16 | muxr adopts in a separate muxr change after the Herdr kit is published and muxr's byokit cutover allows it. The adoption is not part of the byokit PRs. |
| D18 | Account routes ([2.1](#21-account-routes-d18)). Every sign-in method a kit's pinned upstream supports is one data row in one shared vocabulary owned by `fixtures/conformance/account-routes-typescript.json`; each kit restates the shapes structurally (D3). Discovery lists every row, unavailable ones with a plain reason. Subscription rows are offered by default; every other billing is used only when the app or person names it. Billing is pinned upstream metadata or explicit host input, never inferred from an address. Credential import, pooling proxies, per-request or mid-run rotation, and tokens leaving the device never become routes. The one exception is adopting the machine's existing Claude/Codex login with the person's consent (D11). |

### 2.1 Account routes (D18)

One vocabulary covers every account mechanism on every surface: `@byokit/accounts` (the pinned pi-ai providers,
auth modules and `createProvider`) and `@byokit/herdr` (the pinned agent kinds). Each kit restates
these shapes; `packages/ui/test/account-routes.test.ts` checks the fixture and that today's shapes fit.

```ts
type Billing = 'subscription' | 'api' | 'local' | 'free' | 'unknown';
type Via = 'browser' | 'code' | 'paste' | 'key' | 'session'                       // today's accounts Via
  | 'setup_token' | 'cli' | 'plan_key' | 'cloud' | 'local' | 'endpoint';
type Support = 'yes' | 'host' | 'no';     // host: needs the app's host side (forwarder, engine or link)
type Readiness = 'ready' | 'needs_binary' | 'needs_plugin' | 'needs_host' | 'needs_client'
  | 'unsupported_platform' | 'no_upstream_flow';
type Route = {
  id: string;                              // '<provider>:<via>[:<variant>]'
  provider: string; name: string; company: string; label: string; aliases?: string[];
  via: Via; billing: Billing; billingFrom: 'source' | 'host'; offer: 'default' | 'explicit';
  platforms: { node: Support; browser: Support; rn: Support };
  needs?: { binary?: string; plugin?: string; client?: string };
  folderVar?: string; move?: boolean;      // herdr kinds
  upstream: { surface: 'accounts' | 'herdr'; id: string; method?: string; revision: string; flow: 'present' | 'absent' };
};
type RouteView = Route & { readiness: Readiness; why?: string };   // computed, never stored
```

| Upstream mechanism | `via` |
|---|---|
| OAuth with a loopback callback | `browser` |
| OAuth where the person pastes the code or URL back | `paste` |
| Device code (RFC 8628) | `code` |
| Setup or environment token | `setup_token` for a plan, `key` for API billing |
| The agent CLI's own login | `cli` |
| API key | `key` |
| Key bound to a plan | `plan_key` (billing `subscription`) |
| Cloud credentials: a profile, ADC, a service-account file the person picks, Entra | `cloud` |
| Local runtime preset | `local` |
| Any OpenAI- or Anthropic-compatible base URL | `endpoint` |

Excluded, never routes: credential import (another tool's files, keychain entries or CLI logins), pooling proxies,
per-request or mid-run rotation, and tokens leaving the device. The one exception is adopting the machine's
existing Claude/Codex login with the person's consent (D11).

1. **Data.** Each surface generates its table from its pin; no provider is special-cased in code. The `id` names
   the provider and `via`. `upstream` names the pinned source; `flow: 'absent'` lists a row the pin cannot sign in.
2. **Billing is fixed.** `billingFrom: 'source'` is pinned metadata; `'host'` is what the person or app chose when
   adding it. Endpoint rows are always `host`. An address never decides billing: a loopback proxy can charge a remote
   API. `unknown` is valid and explicit.
3. **Offer.** `default` exactly when billing is `subscription`, plan keys included; `api`, `local`, `free` and
   `unknown` rows are explicit. Auto and Default keep refusing anything that is not a subscription (`multi.ts`).
4. **Labels.** API rows say billed per use and by whom; no other row does. The one README terms line stays; there
   is no consent screen, terms gate or legal assurance.
5. **Discovery and readiness.** `routes()` returns every row with its readiness; `offered()` is default and ready.
   Readiness is computed from the route and host facts only, before any credential is read, in this order:
   `no_upstream_flow`, `unsupported_platform`, `needs_host`, `needs_binary`, `needs_plugin`, `needs_client`,
   `ready`. `needs_binary` generalizes the CLI `not_included` result, which stays. A missing client registration or
   endpoint is an availability fact, not an approval gate.
6. **Never in a route:** secrets, stored readiness, live qualification, a fallback. An account signed in on a route
   carries that route's billing; a run uses only the selected account; a plan sign-in never becomes API-billed.
7. **Complete pass-through.** accounts: `routes()` and `add(member, provider, { via, … })` with typed inputs per
   method (key, base URL, region, profile, key file, chosen billing). herdr: `cli(argv)` (D7) and the kind table.
8. **Preserved.** Multi-account identity replacement, defaults and the provider guard; the native Pi launch
   descriptor stays separate from managed sign-in and readiness; Herdr native-session, resume, queue and
   confirmed-move qualification stay main-owned, and a folder or readiness never declares a move proven (6.6); the
   phone ChatGPT path is unchanged.
9. **One method, one route.** A custom endpoint never stands in for a missing OAuth, device-code or cloud method;
   each upstream method keeps its own row and work package (11.4). Catalogues from other open agent projects enter
   only as exact release snapshots read by a generator, never as runtime dependencies.

## 3. Sources and path drift

Read-only references, at the commits read for this spec:

| Consumer | Checkout | Commit |
|---|---|---|
| muxr (pockit) | `umeranjum17/muxr` | `c9b790f66` |
| byokit | this repo | `c6c618c` |

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

Names, codes, errors, state, events, construction, options, words and export names follow
[kit-conventions.md](kit-conventions.md); this section adds only what is specific to the runtime kits. Where this
spec's binding sections prescribe a different shape, the spec wins until it is amended (kit-conventions Precedence).

### 4.1 Layers

```
app (niche workflow + UI)
  │ uses                       │ uses
  ▼                            ▼
@byokit/herdr                              ← runtime kit: aggregator's full power + helpers
  │ ./link adapter (host)      ▲ ./device client (phone/web)
  ▼                            │
@byokit/pair · relay · discover · seal · ui   ← unchanged connection kits
```

### 4.2 State and isolation

- The app passes `stateDir`. The Herdr kit in `own` mode writes only under
  `join(stateDir, 'herdr')`; in `adopt` mode it writes nothing.
- Folders 0700, secret files 0600, atomic writes (temp + rename), as `@byokit/pair/node` does.
- The kit never reads or writes `~/.pi`, `~/.codex`, `~/.claude`, `~/.config/herdr` or any
  person-level path itself; `adopt` mode talks only to the socket path the app passes.
- Spawned processes: explicit env only (D13).

### 4.3 States and plain words

Each kit has one `state` object and emits `onState`, and every state and failure a person can see has a sentence in
the kit's `src/words.json` ([kit-conventions.md](kit-conventions.md) §5 and §9).

### 4.4 Link op naming

Ops are `hd.*`. Requests return JSON; streams send newline-delimited JSON frames
(`LinkStream.write(JSON.stringify(frame) + '\n')`). Errors a person sees are `PublicLinkError` with a `words.json`
sentence. View-role devices get only ops marked *view* below.

### 4.5 Fake runtime rule

The kit's `./testing` ships a fake and a **contract suite** (`herdrContract(make)`): the
same assertions run against the fake in `npm test` and against the real pinned runtime in the lab. A behavior the fake has and the contract does not assert is not relied on by any kit test.

### 4.6 Pass-through typing pattern

The kit's pass-through uses this typing shape:

```ts
import type { HerdrMethod, HerdrParams, HerdrResult } from '@byokit/herdr';
declare function call<M extends HerdrMethod>(method: M, params: HerdrParams<M>, o?: { timeoutMs?: number }): Promise<HerdrResult<M>>;
```

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
  src/binary.ts                                             # opt-in pinned fetch (G11): ensureHerdr/fetchHerdr
  src/testing/index.ts  src/testing/fake-herdr/{server.ts,world.ts,bin.ts}  src/testing/contract.ts
  test/*.test.ts
```

Exports as D2 (`./device` with `react-native`/`browser` conditions, plus a Node-only `./binary`). Dependencies (exact): `@byokit/pair`,
`@byokit/relay`, `@byokit/discover`, `@byokit/seal` (current versions), `ws` `8.21.3`. Dev (root):
`json-schema-to-typescript` pinned exactly (used by `gen-types.ts` only). Herdr itself is **not** an npm dependency
(a native binary); the app installs it (README: `https://herdr.dev/install.sh` or the GitHub release) and passes `bin`.
The opt-in helper `ensureHerdr({ dir, platform? })` (`src/binary.ts`, `./binary`, also spelled `fetchHerdr`)
downloads the pinned v0.9.1 asset for the current platform into an app-owned `dir` only when called, verifies it
against a committed per-platform sha256 table (linux x64/arm64, darwin x64/arm64; each hash recomputed over the
official release asset), writes atomically, marks executable, and returns the absolute `own`-mode `bin` — never
PATH, never `~/.local/bin`, nothing on install or import. A hash mismatch or unsupported platform fails plainly.

### 6.2 Public API (`src/kit.ts`, exported from `.`)

```ts
import type { HerdrEventName, HerdrEventOf, HerdrMethod, HerdrParams, HerdrResult, HerdrSubscription } from '@byokit/herdr';
export const HERDR_VERSION = '0.9.1';
export declare const HERDR_PROTOCOL: number;                     // from the snapshot (H2)
export type HerdrState = {
  phase: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'needs-update' | 'missing' | 'failed';
  why?: 'binary' | 'socket' | 'version' | 'server-exited';
};
export type HerdrProtocolRange = { min?: number; max?: number };   // each defaults to HERDR_PROTOCOL
export type HerdrKitOptions =
  | { mode: 'adopt'; bin: string; socketPath: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; protocolRange?: HerdrProtocolRange; livenessTimeoutMs?: number; ackTimeoutMs?: number;
      onState?: (s: HerdrState) => void;
      onLog?: (message: string) => void }
  | { mode: 'own'; bin: string; stateDir: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; protocolRange?: HerdrProtocolRange; livenessTimeoutMs?: number; ackTimeoutMs?: number;
      onState?: (s: HerdrState) => void;
      onLog?: (message: string) => void };
// A live subscription: call to unsubscribe. `ready` resolves true on the server ack and false on a
// rejected batch (reported via `onError`, never retried); a subscription that is stopped, refused
// or never acknowledged also settles `ready` false, so no caller waits on it forever; the
// reconnect hooks fire only on later drops of an acknowledged socket. The kit's own watches log
// subscription failures to `onLog`.
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

export declare class HerdrKit {
  constructor(o: HerdrKitOptions);
  readonly state: HerdrState;
  start(): Promise<void>;        // own: spawn server; both: connect, version gate, event socket, bootstrap
  stop(): Promise<void>;         // own: server.stop then signals; adopt: close sockets only
  // complete pass-through (D7)
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>, o?: { timeoutMs?: number }): Promise<HerdrResult<M>>;
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void,
            onError?: (code: string, message: string) => void): HerdrSubscribeStop;   // onError: Herdr rejected the batch
  cli(args: string[], o?: { timeoutMs?: number; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession;
  // live tree
  snapshot(): HerdrSnapshot;     // workspaces → tabs → panes → agents, kept current by events; `revision` moves only on a tree change
  onChange(fn: (s: HerdrSnapshot, changed: string[]) => void): () => void;   // changed: pane ids whose agent status moved in this revision ([] for a title-only one)
  // helpers
  startAgent(o: StartAgent): Promise<AgentRef>;
  place(o: PlaceRequest): Promise<PlaceRef>;   // agentless: same ladder, no launch (6.4)
  openSignInTab(o: OpenSignInTab): Promise<AgentRef>;
  move(o: Move): Promise<MoveResult>;
  moveToAccount(target: AgentRef, o: MoveToAccount): Promise<MoveToAccountResult>;
  prompt(target: AgentRef, text: string, o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt>;
  sendKeys(target: AgentRef, keys: string[]): Promise<void>;
  wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus>;
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }): Promise<{ text: string; truncated: boolean }>;
  blocked(): BlockedAgent[];
  onBlocked(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void;
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void>;
  closePane(paneId: string): Promise<void>;       // refuses when it would close the tab
  closeTab(tabId: string): Promise<void>;         // refuses when it would close the workspace
  closeWorkspace(workspaceId: string, o?: { confirmed?: { scope: 'worktreeGroup'; id: string } }): Promise<void>;   // refuses worktree-group widening; a confirmed group close sends close_group: true
  closePlan(paneId: string): Promise<ClosePlan>;  // live reads for a close sentence: where the pane sits and the group its workspace would widen to (6.4)
  // typed edits: the herdrDevice shapes (7.2); exactly one target, else a rejection before any call; Herdr's refusal keeps its code
  rename(o: HerdrRename): Promise<void>;          // pane.rename / tab.rename / workspace.rename
  focus(o: HerdrTarget): Promise<void>;           // pane.focus / tab.focus / workspace.focus
  layout(o: HerdrLayout): Promise<HerdrResult<'layout.apply'>>;   // layout.apply, every option passed through as given
  agentKinds(): Promise<string[]>;                // server.agent_manifests
  installedAgentKinds(kinds: readonly string[], o: { path: string[]; aliases?: Record<string, string[]> }): string[];   // executable lookup, explicit path; aliases maps a kind to extra binary names that also count as installed
}
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type HerdrTarget = { pane?: string; tab?: string; workspace?: string };
export type HerdrRename = HerdrTarget & { label: string };
export type HerdrLayout = { root: HerdrParams<'layout.apply'>['root']; focus?: boolean; tabId?: string; tabLabel?: string; workspaceId?: string };
export type AgentRef = { paneId: string; name?: string; created?: boolean };   // created: set by startAgent only
export type PlaceRef = { paneId: string; tabId: string; workspaceId: string };   // where a placement landed
export type ClosePlan = { paneId: string; tabId: string; workspaceId: string; workspaceLabel: string;
  group?: { label: string; size: number } };   // group: set when closing the workspace widens to its worktree group (6.4)
export type PlaceTarget = { workspace: 'new'; label?: string } | { workspace: string; label?: string }   // any other workspace string is a label (6.4)
  | { tab: 'new'; workspaceId: string; label?: string }
  | { split: string; direction: 'right' | 'down' } | { pane: string };
export type PlaceRequest = { cwd?: string; place: PlaceTarget;   // agentless placement (6.4)
  worktree?: { branch?: string; base?: string };   // a linked checkout first, as startAgent (6.4)
  env?: Record<string, string> | { overlay: Record<string, string>; unset?: string[] } };
export type StartAgent = {
  kind: string; cwd: string; name?: string;             // name: /^[a-z][a-z0-9_-]{0,31}$/
  place: PlaceTarget;
  worktree?: { branch?: string; base?: string };
  args?: string[]; env?: Record<string, string> | { env: Record<string, string>; unset: string[] } | { overlay: Record<string, string>; unset?: string[] }; timeoutMs?: number;   // default 60_000
};
export type OpenSignInTab = Omit<StartAgent, 'place' | 'worktree'> & { workspaceId: string; label?: string };
export type BusyHandoff =
  | { busy?: 'refuse' }
  | { busy: 'wait'; confirmed: { session: string; terminalId: string }; waitMs: number }
  | { busy: 'interrupt'; confirmed: { session: string; terminalId: string; seq: number } };
export type MoveToAccount = {
  provider: string; folder: string; env?: Record<string, string>; name?: string;   // name: words only (MS-S2)
  direction?: 'right' | 'down'; timeoutMs?: number; whenBusy?: BusyHandoff;
};
export type MoveToAccountResult = { ok: true; session: string } | {
  ok: false; code: 'too_early' | 'busy' | 'unsupported' | 'env_mismatch' | 'close_failed' | 'start_failed'
    | 'blocked' | 'changed' | 'interrupt_unsupported' | 'signed_out';   // signed_out: moveToAccount only (6.6)
  message: string; live?: string;
};
export type Move = {
  paneId: string; kind: string; args: string[]; set: Record<string, string>; unset?: string[];
  onStaged?(newPaneId: string): void; onReplaced?(newPaneId: string): void; timeoutMs?: number; whenBusy?: BusyHandoff;
};
export type MoveResult = { ok: true; paneId: string } | Extract<MoveToAccountResult, { ok: false }>;
export type PromptReceipt = { paneId: string; terminalId: string; revision: number; status: AgentStatus;
  agentSession?: AgentSessionRef }; // from the prompt response only; absent when Herdr omits it
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
  // Pane-level agent fields Herdr reports on every pane, shell or agent; an agent pane also carries
  // them inside `agent`, a shell with no agents record keeps them here.
  agentStatus?: AgentStatus; displayAgent?: string; foregroundCwd?: string;
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
  pause(): void; resume(): void;
  exited: Promise<{ code: number | null; stderrTail: string }>;
};
```

Internal seams (stub signatures for H1):

```ts
import type { BlockedAgent, HerdrKit, HerdrKitOptions, HerdrSnapshot, HerdrState, HerdrTransport, TerminalSession } from '@byokit/herdr';
// socket.ts (H3)
export declare function socketTransport(socketPath: string): HerdrTransport;
// supervise.ts (H3)
export declare class Supervisor {
  constructor(o: HerdrKitOptions, onState: (s: HerdrState) => void);
  env(): Record<string, string>;                 // env for cli/terminal/server per 6.3/6.5
  start(): Promise<HerdrTransport>; stop(): Promise<void>;
}
// cli.ts (H4)
export declare function runCli(bin: string, env: Record<string, string>, args: string[], timeoutMs?: number):
  Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
// terminal.ts (H4)
export declare function openTerminal(bin: string, env: Record<string, string>, paneId: string,
  o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession;
// agents.ts (H5)
export type Call = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
export declare function createAgents(ctx: { call: Call; snapshot(): HerdrSnapshot }): Pick<HerdrKit,
  'startAgent' | 'prompt' | 'sendKeys' | 'wait' | 'read' | 'agentKinds' | 'installedAgentKinds'>;
// close.ts (H5)
export declare function closePane(call: Call, paneId: string): Promise<void>;
export declare function closeTab(call: Call, tabId: string): Promise<void>;
export declare function closeWorkspace(call: Call, workspaceId: string): Promise<void>;
export declare function closePlan(call: Call, paneId: string): Promise<ClosePlan>;
// approvals.ts (H5)
export declare class Blocked {
  constructor(ctx: { call: Call });
  update(paneId: string, agent: HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent'], where: { workspaceId: string; tabId: string }): void;
  list(): BlockedAgent[]; on(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void;
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void>;
}
// words.ts (H8): words(key, vars?), stateWords(s: HerdrState), agentWords(s: AgentStatus | 'starting')
// notices.ts (H7; portable): sealNotice(b: BlockedAgent, boxPublicKey), openNotice(data, seed): BlockedAgent | null
```

### 6.2.1 Turn results

`runTurn<T>(target, options): Promise<AgentTurnEnd<T>>` adds host-side turn tracking to an existing
agent; it neither starts a CLI nor changes its subscription. `options` supplies `prompt`, an absolute
app-owned `cwd`, optional `timeoutMs` (default 300000), `signal`, `onEnd`, file policy (`exclude`,
`maxFiles`, `maxBytes`, or `false` to skip the scan so `changedFiles` is always empty), and optional
result policy `{ schema, validate, maxBytes }`. `schema` is an
app-supplied JSON Schema sent as instructions; `validate(unknown): value is T` is the app's schema
validator. No provider API or additional billing path is introduced. `onTurnEnd(fn)` subscribes
app-wide; `onEnd` and the promise carry the same completed turn, exactly once.

Before delivery, the kit acknowledges a pane-specific Herdr status subscription, checks that the
agent is idle or already `done` and its working directory matches, and snapshots that directory (or
skips the snapshot when the file policy is `false`). Completion requires
an observed `working` followed by `idle` or `done` after delivery starts; initial idle, blocked,
unknown and prompt receipts alone never end a turn. It buffers a completion arriving before the
prompt receipt. Rejected delivery, watch loss, pane replacement/closure, cancellation, timeout and
kit stop reject and clean up without emitting completion. They do not stop the agent. Apps retain
their existing blocked-agent approval flow. Herdr's status detection is the end signal, not proof
that the requested work succeeded; no native semantic run-result API exists in the pinned schema.

With result policy, the prompt asks the agent to write a fresh, turn-specific JSON file directly in
`cwd`, containing `{ turnId, result }`, before it finishes. The kit reads only that bounded regular
file without following symlinks, checks the id, parses JSON, and calls the supplied validator. The
end object carries `id`, `target`, `receipt`, terminal `status`, sorted `changedFiles` (relative paths
and `added`/`modified`/`deleted`), and a result discriminant: `not-requested`, `missing`, `invalid`
(reason `format`/`schema`/`too-large`/`unsafe-file`), or `valid` with the typed value. Invalid bytes
are never returned or logged. The kit removes its result file; it is excluded from changed files.

File snapshots compare content, executable/permission modes and symlink targets, including
untracked files and existing dirty edits; they do not depend on Git or timestamps. `.git` is always
excluded, directories are pruned by the app's `exclude(relativePath)` policy, symlinks are recorded
without traversing them, and special files are ignored. Defaults bound each scan to 10000 entries
and 128 MiB of regular-file content; exceeding a bound or an unreadable/racing tree rejects instead
of returning a partial list. Files changed and restored between snapshots do not appear. Apps must
reserve the pane and directory exclusively for the turn: the kit prevents overlapping turns in
its own instance, but cannot attribute writes by other clients/processes. Branching, applying,
rollback, task success and device authorization remain app policy. This host-only helper grants
no new link/device operation; apps forward the result through their authorized job channel.

### 6.3 Supervision and connection (`src/supervise.ts`, `src/socket.ts`)

- `own` mode: refuse unless `bin` is an absolute path to an executable (`missing/binary`). Env =
  `{ HOME: <stateDir>/herdr/home, XDG_CONFIG_HOME: <home>/.config, XDG_STATE_HOME: <home>/.local/state,
  XDG_CACHE_HOME: <home>/.cache, HERDR_SOCKET_PATH: <stateDir>/herdr/herdr.sock, PATH: path.join(':') || '/usr/bin:/bin',
  LANG: 'C.UTF-8', ...env }`; spawn `bin server` detached with that env, logs to `<stateDir>/herdr/server.log`,
  pidfile with a cmdline check; wait for the socket to answer `ping` (250/500/1000/2000 ms backoff,
  then fail `failed/socket`). Server exit while not stopping → `reconnecting`, respawn with the same backoff.
  `stop()`: `server.stop`, wait 3 s, SIGTERM group, 3 s, SIGKILL.
- `adopt` mode: never spawns or stops anything; `socketPath` is required.
- Both: version gate — `ping` result (and `session.snapshot` version/protocol metadata) against the
  declared `protocolRange` (`{ min?, max? }`, each defaulting to `HERDR_PROTOCOL`): below the floor fails
  closed with `needs-update/version`; above the ceiling connects anyway with the steady state
  `needs-update/version` instead of a throw, so a Herdr protocol bump does not take the host down
  before the kit's pin moves. Then the event socket and bootstrap.
- **Socket** (`socket.ts`) = muxr `HerdrClient`: fresh connection per request (`{id, method, params}` + `\n`; answer
  matched by id; error → `Error('herdr: <code>: <message>')` with `code` property), default timeout 15 s,
  per-call override (`agent.wait`, `agent.prompt` with wait: timeout + 5 s). Event socket: one long-lived
  subscription for unfiltered kinds; `pane.agent_status_changed` per pane on its own socket (filtered kind);
  frames parsed as `{event, data}` or legacy `data.type`; an error frame answers the one request its socket
  carries, so one with no id of its own (`""`, null, absent) **or with an id derived from the request id**
  (Herdr's per-subscription probe answers `<id>:sub:0:probe`) is that request's refusal: report it via
  `onError` and do **not** retry that subscription; other closes reconnect after 1 s (event socket) or
  2 s (per-pane). Start retries 250/500/1000/2000 ms, then the 1 s loop; the kit stays up (`reconnecting`).
  A subscription's readiness always settles: the server's ack (`true`), a refusal, a stop, a closed transport
  or the acknowledgement deadline (`ackTimeoutMs`, default 15 s — the request timeout) settle it `false`, so no
  caller and no bootstrap barrier waits on an acknowledgement that never comes.
- **Bootstrap** (Herdr docs): open `events.subscribe`, wait for its ack, buffer events, call `session.snapshot`,
  install it, apply buffered events in order, continue. The buffered events are bounded in count and bytes
  (512 events, 2 MiB): a bootstrap that parks (a status watch that is never acknowledged) must not retain
  every event that arrives. Past the cap the backlog is not kept — the tree is re-read from Herdr (a fresh
  snapshot carries the topology, the panes and the statuses), the overflow is reported through `onLog` with
  what the buffer held, and the events that follow are covered by that re-read: nothing is dropped silently.
  The bootstrap's status barrier is bounded the same way: it settles on the watches' acknowledgements, on
  `ackTimeoutMs`, or when the kit stops, and the watches still missing are named through `onLog`.
  Re-bootstrap after every event-socket reconnect. `onState`
  fires only when `phase` or `why` changes: a re-bootstrap (`refresh()`, a structural event) that lands in the state
  the kit already holds emits nothing, while a reconnect still reports `reconnecting` then `ready`. Unfiltered
  kinds subscribed: `pane.agent_detected`, `pane.created`, `pane.closed`, `pane.moved`, `pane.exited`,
  `pane.updated`, `workspace.created`, `workspace.closed`, `workspace.renamed`, `workspace.updated`, `tab.created`,
  `tab.closed`, `tab.renamed` (muxr's verified list); per-pane `pane.agent_status_changed` for every pane with an agent.
  Agent records merge partial events (`{ ...current, ...incoming }`); `pane.updated` titles and labels merge the
  same way with no re-bootstrap. Pane-level `agent_status`/`display_agent`/`foreground_cwd` ride every snapshot
  pane (camelCase `agentStatus`/`displayAgent`/`foregroundCwd`) even with no agents record, and a `pane.updated`
  title tick on a plain shell never invents an agent: `pane.agent` comes only from an agents record or a payload
  naming an agent (`agent` kind or `agent_session`). A per-pane lifecycle epoch keeps a status push that races a
  snapshot read: the push stamps its pane before the read returns, and the install keeps the live status and revision over the read.
  A detected agent with no `agent_session` yet is re-read (`agent.get`, landing status, revision, session and launch flags) when its status watch acks and on each later status push until its session lands, so a session reported with no event of its own reaches the tree and `onChange` without a host re-read. A `refresh()` made while a bootstrap is in flight waits for the one queued follow-up, which every caller arriving before it reads shares, so each `refresh()` resolves with a tree read that started after its call.

### 6.4 Helpers (`src/agents.ts`, `src/close.ts`, `src/approvals.ts`)

- Pi admission: before probes or placement, `startAgent` requires exactly one nonempty `--model` argument (`model_required`) and a complete replacement `env` with absolute `HOME` and `PI_CODING_AGENT_DIR` (`account_required`). No pane/daemon environment inheritance or additive overlay is accepted for Pi. `openSignInTab`, moves and device starts route through this guard; raw `call`/`cli` pass-throughs are caller-owned and need separate qualification. A host that owns the Pi launch contract passes `hostLaunch: true` for Pi: both refusals are skipped, `args` pass through untouched and `env` may be absent, an overlay or a replacement. That host then owes what the guards owed — the model Pi may spend on, and a launch confined to the account it chose. No other kind's start rules change.
- `startAgent`: `worktree` → `worktree.create { cwd, focus: false, env?, branch?, base? }` and use its
  checkout as `cwd` (`branch` optional; absent fields are omitted, never sent null). Placement:
  `workspace.create { cwd, label, focus: false }` → `result.root_pane.pane_id`, then `tab.rename` carries a
  given placement label onto the new root tab; `tab.create { workspace_id, cwd,
  label, focus: false }` → `result.root_pane.pane_id`; `pane.split { pane_id, direction, focus: false }` →
  `result.pane.pane_id`; `pane` → as given. A `place.workspace` that is not `'new'` is a workspace label:
  exactly one workspace with that label gets a new tab (`tab.create { workspace_id, cwd, label, focus: false }`,
  `created: false`); no match creates the workspace with that label (`created: true`) and renames its root tab
  to `place.label` (`tab.rename`) when one is given, so the tab carries the label; two or more matches reject
  with `workspace-ambiguous` and create nothing. The placement `env` rides every create/split call (the pinned
  `agent.start` has no `env` param). The pinned schema's create/split answers carry the pane's `tab_id` and
  `workspace_id` on the pane record (`root_pane`/`pane` are full `PaneInfo`); the kit reads the placed ref from
  them, falling back to one `pane.get` for a `pane` placement or a bare answer. The start lifecycle emits `placed`
  (`{ phase: 'placed', kind, ref: { paneId, tabId, workspaceId } }`) the moment the placement resolved — before
  `agent.start` settles, so an app seeds routes and checks env on the fresh placement while the launch runs; a
  placement that never resolves emits `launchFailed` (`placement-failed`) alone. Then `agent.start { pane_id, kind,
  name?, args?, timeout_ms }` with call timeout `timeoutMs + 5 s`, retrying
  `agent_pane_busy`/`agent_pane_unavailable` inside a bounded 5 s budget. When the start fails, only what the kit
  created is rolled back: the fresh pane with `pane.close`, or the fresh workspace with `workspace.close` when a
  label placement created one (a reused workspace and a caller-owned `pane` placement are never closed). Returns
  `{ paneId, name, created }`. Exact param spellings come from the generated types; where muxr and the schema
  disagree, the schema wins and H5 records it in `report.json`.
- `place` (agentless placement): the same ladder minus the launch — no `agent.start`, nothing watched.
  `place { tab: 'new', workspaceId }` opens a shell or application tab, `place { split, direction }`
  splits a shell pane, `place { workspace: 'new' | label }` creates or reuses a workspace by label (the same
  `workspace-ambiguous` refusal, and a created workspace's root tab takes `place.label` through the same
  `tab.rename`), and `place { pane }` names an existing pane (its ref comes from `pane.get`; any `env` there is
  refused with `env_mismatch`, never dropped). `cwd` and a plain `env` record are optional and ride the
  create/split call verbatim; an `env: { overlay, unset? }` instead lands on the fresh pane's inherited
  environment and is checked there exactly as `startAgent`'s overlay (`env_mismatch` on a miss). A failed
  rename or overlay check rolls back what the placement made, as a failed start does. Resolves
  `{ paneId, tabId, workspaceId }`. `worktree` (`{ branch?, base? }`) is the same first step as
  `startAgent`'s: `worktree.create { cwd, focus: false, env?, branch?, base? }` opens the linked checkout with its
  own root tab and pane, and the shell is that root pane (`cwd` is the checkout). The checkout is the placement,
  so a `place` target given beside it is not used; a failed `worktree.create` creates nothing, and a
  rollback after it closes only the root pane, as a failed `startAgent` does.
- Muse private readiness (additive Node helpers in `src/muse.ts`): `museReadiness(env?)` probes only
  the explicitly supplied effective PATH, returning unknown/missing/launcher-only/installed and always
  `signedIn: 'unknown'`. `installMuse({ home, path, installDir?, signal?, timeoutMs? })` is explicit
  installation authorization: unmodified official `https://dev.meta.ai/install.sh`, private staged
  HOME/XDG/temp, explicit Bash and clean tool PATH, no profiles/login/inherited overrides. Only Linux/macOS
  x64/arm64; refuse escaping/symlink/system/default-home targets. Bound HTTPS redirects/downloads/processes,
  cancel the owned process group, preserve existing installs, and promote only a launcher plus executable
  selected native release. Return a typed prerequisite/failure or receipt (paths, launch env, version and
  hashes), not account/catalog qualification. A working existing install is reused without updates.
  `startAgent` rejects known-missing Muse with `agent_not_installed` and `launchFailed: not-installed`
  before placement/RPC; effective explicit launch env wins, otherwise own-mode new panes use the owned
  supervisor env. Unknown existing/adopted pane environments stay unknown. No auto-install promise for an
  absent Muse CLI; no invented folder/resume capability. Exact typed RPC pass-through stays unchanged.
- `prompt`: refuse unless the agent is promptable (`launch_pending !== true`, status in idle/working/blocked/done)
  → `PublicLinkError`-compatible error code `agent-not-ready`. The tree is re-read once (`agent.get`) before a
  refusal, since `launch_pending` rides reads only; `interactive_ready` is not gated (v0.9.1 sets it only for agents
  its own `agent.start` settled, and its `agent.prompt` accepts the rest; v0.9.1 omits both flags when false, so a
  read without them means false). A refusal never calls `agent.prompt`; Herdr's own `agent_not_ready` maps to
  `agent-not-ready`. Call `agent.prompt
  { target: paneId, text, wait? }`; accept only a receipt with `type === 'agent_prompted'`, string `terminal_id`,
  `agent_status`, `workspace_id`, `tab_id`, `pane_id === target`, boolean `focused`, non-negative safe-integer
  `revision`; else throw `Herdr did not queue the prompt.` (muxr `promptHerdrAgent`). `agent_blocked` → error code
  `agent-blocked`.
- `isPromptable(agent)` is that readiness rule as one exported gate (`agent !== undefined && launch_pending !== true &&
  status in idle/working/blocked/done`); `prompt` uses it and so does `waitPromptable`. `waitPromptable(target, { timeoutMs })`
  waits until a just-started agent can take a prompt: it checks the kit's own snapshot, re-reads (`agent.get`, since
  `launch_pending` rides reads only) and polls until `isPromptable` holds, then resolves. At the deadline it rejects with
  code `agent-not-ready`; when the pane is gone (the snapshot no longer holds it and `agent.get` answers `agent_not_found`)
  it rejects with code `pane-unavailable`, so a wait never hangs.
- `wait` → `agent.wait { target, until, timeout_ms }` (always a timeout). `read` → `pane.read` and unwrap
  `result.read`. `sendKeys` → `agent.send_keys { target, keys }`; a pane with no agent (`agent_not_found`) falls
  back to `pane.send_keys { pane_id, keys }`, so a shell route receives keys too (a gone pane surfaces
  `pane.send_keys`' own `pane_not_found`).
- Close guards = muxr `closeExactPane`/`closeExactTab`/`closeExactWorkspace`: look up the parent counts first and
  refuse with codes `pane-close-would-widen`, `tab-close-would-widen`, `workspace-close-would-widen`; not-found →
  `pane-unavailable`/`tab-unavailable`/`workspace-unavailable`. A would-widen refusal also carries the wider target
  as `{ scope: 'tab' | 'workspace', id, label }`, so the app can offer the bigger close instead: closing a pane
  widens to its tab (scope `tab`, the tab's id and label); closing a tab widens to its workspace (scope `workspace`,
  the workspace's id and label); closing a worktree-group root widens to its group, named by the repo
  (scope `worktreeGroup`, the root's id, the repo name as label, plus the member count as `size`), so the
  confirmation sentence needs no tree read. A rollback close re-runs `closePane(paneId, { confirmed: { scope: 'tab', id } })`
  with the wider target a `pane-close-would-widen` refusal named: the kit verifies the live tree still matches — the
  pane is still that tab's sole pane, else `confirmed-scope-mismatch` — and closes exactly that tab through the exact
  path, whose own widening guard still applies (a sole tab refuses `tab-close-would-widen` naming the workspace), so
  the confirmed close never widens past the confirmed scope. A confirmed group close re-runs
  `closeWorkspace(workspaceId, { confirmed: { scope: 'worktreeGroup', id } })` with the wider target the
  refusal named: the kit verifies the live tree still matches — the id is still that group root with the same
  member count, else `confirmed-scope-mismatch` — and sends one `workspace.close { workspace_id, close_group: true }`,
  which Herdr widens atomically (a plain close on a group root is refused with
  `workspace_group_close_required`); members are never closed one by one. `hd.close` maps all three codes to `PublicLinkError` with the `close.wouldWiden`
  words (6.9), so a device hears plain words instead of a bare failure.
- `closePlan(paneId)` answers the close sentence's topology from the same live reads the guards make, never from
  the kit's tree: `pane.get` (the pane's `tab_id` and `workspace_id`), `workspace.get` (its label and worktree) and
  the group lookup `closeWorkspace` uses (`workspace.list`). It resolves `{ paneId, tabId, workspaceId,
  workspaceLabel, group? }`; `group` is `{ label, size }` exactly as a `workspace-close-would-widen` refusal names
  it (the repo name and member count) and is present only when the workspace is a worktree-group root. A gone pane
  (`pane_not_found`, or its workspace `workspace_not_found` mid-read) rejects `pane-unavailable`; any other failure,
  including an unreachable Herdr, rejects as that socket read does, so a caller keeps its retryable outage mode.
- Blocked approvals: when an agent's status becomes `blocked`, read `pane.read { source: 'detection' }` (plain text,
  last 40 lines) as `prompt` and add a `BlockedAgent` under a `revision` the kit issues, one new value per question
  it publishes; leaving `blocked` resolves it. `answer(paneId, keys, { revision })`: `pane.get`; refuse unless still
  `blocked` and `revision` is the listed question's (`approval-stale`); read the detection text back and refuse the
  same way if the question on the pane is no longer the one listed, publishing the live question under a new
  `revision`; then `agent.send_keys`. The kit never interprets the agent's TUI. The pane's own revision is not the
  identity: the pinned Herdr 0.9.1 reported one revision for four consecutive Cursor questions (H9 lab), so a
  pane-revision check alone would type one question's keys into the next one's dialog.

### 6.5 Terminal stream (`src/terminal.ts`)

`terminal(paneId, { mode, cols, rows })` spawns `bin terminal session <control|observe> <paneId> [--takeover]
--cols <cols> --rows <rows>` (`--takeover` only for `control`). Env: in `own` mode the 6.3 server env; in `adopt`
mode `{ PATH: path.join(':') || '/usr/bin:/bin', LANG: 'C.UTF-8', ...env }` plus `HERDR_SOCKET_PATH: socketPath`
only when the kit names a session socket — an empty `socketPath` passes none, so a spawned `herdr` CLI or agent
keeps its own session resolution (12) instead of reading an empty override — so the
CLI reaches the same server (never the host process's env; the app passes `HOME`, `HERDR_CLIENT_SOCKET_PATH`,
`HERDR_SESSION` or a wider `PATH` explicitly when its Herdr needs them). `cli()` uses the same env rule. Returns
`{ ready: Promise<void>; onFrame(fn: (line: string) => void); send(line: string); close(); pause(); resume();
exited: Promise<{ code: number | null; stderrTail: string }> }`. `pause()` stops delivering frames and stops reading
the child's stdout, so a slow consumer backs up into the pipe and Herdr blocks (the kit holds a fixed backlog, not
the stream); `resume()` delivers the held frames in order and reads on. Frames are
Herdr's own NDJSON terminal protocol, passed through untouched; `ready` resolves on the first stdout line, rejects on
spawn error (ENOENT → `missing/binary`) or exit before output. stderr keeps a 4 KB tail for diagnostics only.

### 6.6 Sign-in and retained login (D11)

Herdr has no sign-in API; each agent CLI owns its login. `openSignInTab({ workspaceId, kind, cwd, env, … })`
opens a new tab and starts that CLI with its explicit account environment; the person completes the CLI's own
first-run login over `terminal()` (link stream `hd.terminal`). It never sends a login command or reads credentials.
The host owns account folders and history sharing. Tokens stay on the device and never enter kit logs or results.
Words key `agent.signIn`. Existing `startAgent.env` travels on placement create/split, never `agent.start`.
Legacy record env on existing panes remains refused. `StartAgent.env` also accepts the accounts launch-env
result `{ env, unset }`. This result is applied in an idle POSIX shell through a host-local private file;
only its path reaches terminal text. The kit disables tracing, verifies assignments and absence without
printing values, and waits for a random success marker before `agent.start`. Unsupported or busy shells
fail closed. Created panes roll back on preparation failure; caller-owned panes remain open. The file is
removed after preparation, including failure. Runtime errors on this path are replaced with generic words.
`openSignInTab` accepts the same result. No credential values enter commands, argv or kit logs.

`StartAgent.env` also accepts the verifying overlay `{ overlay, unset? }`: nothing rides the create calls —
the pane keeps its inherited environment — and the overlay values land on top of it (the named ones removed)
through the same idle-shell private file, verified in the pane before `agent.start`. A mismatch fails closed
with `env_mismatch` and the agent never starts; created panes roll back, caller-owned panes remain open. Unlike
the replacement form above, every other export survives. `openSignInTab` folds its folder variable into either form.

`moveToAccount(target, { provider, folder, env?, name?, direction?, timeoutMs?, whenBusy? })` accepts mapped
managed kinds, including Claude (`CLAUDE_CONFIG_DIR`, `--resume <id>`), Codex (`CODEX_HOME`, `resume <id>`)
and Pi (`PI_CODING_AGENT_DIR`, `--session <id|absolute path>`). Hosts own cross-account history sharing.
Absent/launch-pending conversation → `too_early`; default working/blocked or concurrent move → `busy`;
unsupported agent/session kind → `unsupported`. The source account is never inspected.

**Signed-out target (MS-S2).** `moveToAccount` owns the target's readiness check; `move` has none and never returns
`signed_out` (its caller owns readiness: an `@byokit/accounts` host calls `cliAccounts.launch(id)` and passes its
`set`/`unset`), although its `MoveResult` type still carries the code through the shared union. The account helpers
receive `agentStatus`; the check runs once, after the refusals that need no wait and before any `whenBusy` wait or the
split: `agentStatus([kind], { folders: { [kind]: folder }, env })` for the kind mapped from `provider`, on the kit's
launch PATH, with the probe's own HOME/XDG confinement to the folder (B9), stricter than the replacement shell.
`signedIn: 'no'` returns `{ ok: false, code: 'signed_out' }` with words `move.signed_out` ("Sign in to {name} first.",
`{name}` from `MoveToAccount.name`, else "this account"); nothing is split and `live` names the untouched source.
`'unknown'` proceeds: at 0.9.1 only Claude and Codex have a status probe, so a Pi target (or a timed-out probe) is
never refused here; a host gates Pi with `cliAccounts.launch` and `move`. The check is not a lock and only picks the
words: an account that signs out between the check and the split still never reaches the default login through the
kit, because the replacement starts only after step 2 verifies the target folder variable (plus the caller's `env`;
`moveToAccount` has no `unset`, so a host that must drop inherited provider keys uses `move` with `launch`'s `unset`).
The CLI then shows its own sign-in in the replacement or fails step 3 (`start_failed`, replacement closed); whether a
kind honours its folder variable stays its own behaviour, proven per kind (B9). No path retries without the folder or
falls back to the person's own sign-in.

Both move APIs accept `whenBusy: { busy: 'wait', confirmed: { session, terminalId }, waitMs }`.
Confirmation must match the current published conversation and terminal exactly, and the source must publish
`state_change_seq`. `waitMs` must be finite, positive and at most 300000. Otherwise refuse (`changed` for
stale confirmation, `unsupported` for unavailable evidence/bounds). For working sources, call published
`agent.wait` until idle/done/blocked, then re-read identity and sequence. Timeout → `busy`, approval →
`blocked`, changed identity → `changed`; no replacement is started in these cases. Snapshot immediately
before split. Sequence may advance while the step finishes; it must remain unchanged during replacement staging.
`busy: 'refuse'` preserves the default. `busy: 'interrupt'` with confirmed session/terminal/seq is a typed
`interrupt_unsupported` refusal, never a keypress or lifecycle operation; blocked panes are never keyed.
UI: **Move when this step finishes**. The person may stop the step themselves in the pane; the kit never
claims to interrupt it. Real working-step handoff and native Pi move remain unqualified by offline fixtures.

The move order is **start then close**:
1. Split a new shell with the target account's environment (`CLAUDE_CONFIG_DIR` or `CODEX_HOME` overrides host env).
2. Verify the shell's effective account folder using a random marker and exact whole-line match in unwrapped output; ignore typed
   command echoes and poll up to the timeout. A mismatch or unreadable shell closes the new pane, returns
   `env_mismatch`, and leaves the original untouched. Only the folder variable is echoed, never credentials.
3. Resume in the new pane and wait for a ready agent publishing a conversation. Start/wait failure closes the
   new pane and returns `start_failed` with the original pane as `live`; never close the source first.
4. Immediately before source close, re-read the source. It must still be idle/done with the same conversation
   (agent/kind/value), terminal and published `state_change_seq` as the pre-split snapshot. All moves use this
   guard, including idle moves; without sequence, idle moves compare status/identity/terminal only. On change
   or unavailable read, close the replacement and return `changed`. After cleanup, `live` names only a freshly
   verified surviving conversation; unknown cleanup must not promise the original is open. Never say
   “Nothing was closed”: replacement cleanup itself closes a pane. This observation is not atomic, adds no
   security guarantee, and cannot prevent changes between the final read and close on published Herdr 0.9.1.
   Close the original pane only after this guard passes. A close error can be a lost acknowledgment
   after deletion. Return `close_failed`, and close the replacement only when fresh `agent.get` reads verify
   both original and replacement identities (kind, conversation, and terminal/name when published). If the source
   is absent, changed or unreachable, preserve the replacement. Re-read after rollback, including lost cleanup
   acknowledgments; `live` names a verified surviving conversation and is omitted when neither is verifiable.
   Uncertainty is never success and never fires `onReplaced`. These are bounded observations, not an atomic
   server transaction; the pinned protocol has no conditional close to prevent an independent later mutation.
5. Return the new pane id as `session` (Herdr kit sessions are addressed by pane id, including a new generation).

`move({ paneId, kind, args, set, unset?, onStaged?, onReplaced?, timeoutMs?, whenBusy? })` uses the same transaction and
per-source lock, with caller-supplied resume arguments. It returns `{ ok: true, paneId }`; the existing
`moveToAccount` helper keeps `{ ok: true, session }` as `MoveToAccountResult`. The source must publish a
conversation for the same agent kind. `set` includes that kind's managed account folder variable; it carries
folder paths, never credentials. Environment names must be shell identifiers, values and args cannot contain
NUL or newlines, and a name cannot appear in both `set` and `unset`.

The pinned `agent.start` protocol exposes args, kind and name, but no env or command-prefix field. Therefore
`unset` is applied in the new shell before `agent.start` rather than through an unsupported `env -u` prefix.
The kit verifies the account folder and each unset name's **absence**, without printing credential values. A shell
that cannot unset or retains a variable fails closed as `env_mismatch`. Then the kit waits for the kind, an
idle/done state, `interactive_ready: true`, and a published conversation before closing the source. The default
step timeout is 60 seconds. All post-split failures report the replacement as `live` if rollback close fails.

`onStaged` runs immediately after split, before any env verification or start, so the app can hide the pane and
seed its bookkeeping. A thrown staging hook rolls back. `onReplaced` is a notification after the source closes;
its exception cannot roll back an already completed move and does not change the success result.
`cli(args, { env })` overlays that per-call env on the kit's explicit env, preserving its socket/PATH defaults;
it never inherits `process.env` and does not mutate the env for later calls. An app uses it to install managed
folder hooks with `cli(['integration', 'install', provider], { env: { [folderVariable]: folder } })`.

Move messages are plain words with no caught errors, folders or tokens interpolated. `live` is a pane id. Every
failure before the source closes leaves it live; failed cleanup can leave another pane for host recovery. No real
Herdr lifecycle is exercised by the acceptance tests: fake/contract ports cover ordering, rollback, new generation,
env mismatch (including prefix/echo cases), unsupported/too-early/busy and explicit sign-in-tab env.

**Kinds (D18, WP B9).** `kinds.json` is generated from the pinned Herdr source (agent enum and aliases, account-folder
environment table, resume table): 24 kinds at v0.9.1, 12 with an account-folder variable. `openSignInTab` sets the
kind's folder variable when the host passes a folder. `moveToAccount` and `move` extend only to kinds with both a
folder variable and resume support, under the transaction above and the main-owned native-session and confirmed-move
guards; a folder, a passing readiness check or a fixture never declares a native move proven. That readiness check
is also `moveToAccount`'s signed-out gate (6.6). Kinds without a folder
variable are tab only, labelled one sign-in per computer user, and the kit never reads the person's default CLI
credentials for them. Readiness probes run only with the managed folder's explicit env (D13) and otherwise report
unknown.

### 6.6.1 Conversation bundles (host only)

`HerdrKit.exportConversation(target: AgentRef, { to, maxBytes?, maxFiles?, accountFolder? })` and
`importConversation({ bundle, accountFolder, kind, conversation, overwrite? })` carry conversation data,
not sign-ins. Import is exported from `.` and available on the host kit too. Both resolve typed
`ConversationExport` / `ConversationImport` results: success contains only `ok`, `kind`, the conversation id,
file count, byte count and bundle SHA-256; failure contains `ok: false`, `code` and a plain `words.json` message.
Codes are `unsupported`, `too-large`, `invalid-bundle`, `digest-mismatch`, `unsafe-path`, `exists`,
`write-failed`, and `rollback-failed`. No caught errors, account paths or transcript text enter results or logs.

The first slice supports Pi's documented default JSONL store only: `sessions/<encoded cwd>/<timestamp>_<id>.jsonl`
inside the explicit `PI_CODING_AGENT_DIR`. The adapter table in `src/conversations.ts` cites the tool source.
The exporting kit resolves the folder from the explicit `accountFolder` when it is given, else from the folder it
recorded for a pane it started with an explicit replacement account environment. With `accountFolder` the pane's
`agent_session` is read from Herdr, so an agent this kit instance never started (an overlay launch, or one
running before a host restart) exports too. Either way the pane's agent kind must match its session's kind, the
conversation must be idle, and the folder goes through the same validation `importConversation` applies (absolute,
a real directory, no symlink escape); a folder that does not hold that conversation answers the store's own
refusal code. Custom session stores, unsupported kinds and non-idle conversations refuse with `unsupported`.
Published Pi session ids and paths are resolved inside that folder only; no default HOME is discovered. Claude
and Codex adapters share the same engine and format, not consumer-owned storage handling.

Format one is an opaque binary file: an eight-byte marker, four-byte manifest length, UTF-8 JSON manifest,
then uncompressed file bytes in manifest order. The versioned manifest contains kind, conversation id,
relative file paths, sizes, SHA-256 digests and totals; never absolute account paths. Export checks bounds
before creating its private output file, then renames it in the output directory. Defaults are 256 MiB and
20,000 files; the byte ceiling, including container overhead, is 1 GiB. The file-count ceiling is 20,000;
manifest reads are capped at 16 MiB. Discovery is bounded to 20,000 entries and eight directory levels.

Account roots and bundle parents must be physical, absolute paths. Callers resolve platform directory aliases
when allocating their own folders; the archive never silently follows them. Path safety precedes reading a
source file to measure its size, so an unsafe source is not reclassified as a size refusal.
Import opens regular files without following symlinks, verifies the manifest and every payload digest,
rejects duplicate, absolute, traversal and special-file entries, and stages privately inside an existing
explicit account folder. Existing files for the same conversation id are refused unless overwrite is true.
Overwrite retains originals until all placements succeed. Failure restores originals, verifies their hashes,
removes newly created files/directories and staging, or returns `rollback-failed` if restoration cannot be proven.
Hosts must serialize access to these app-managed folders against external writers while carrying a conversation;
this is not a filesystem-wide lock against a concurrently running CLI. No CLI, agent session or lifecycle action
is started by export or import. A byte-identical fixture restore proves data transport only: real CLI resume on
another computer requires that agent's own sign-in there and belongs to the consumer's next journey.

### 6.7 Generation (`scripts/gen-types.ts`, H2)

Input `schema/herdr-api-0.9.1.json`. Request methods are the `const` values of the request schema's `method`
property per variant; params/result/error/event types via `json-schema-to-typescript` on each `$defs` entry the
variant references. Output `src/generated/methods.ts` (`export interface HerdrMethods { 'pane.read': { params: …;
result: … }; … }`), `events.ts` (event name → payload; filtered kinds carry their filter fields in
`HerdrSubscription`), `report.json` (`{ herdr, protocol, schemaVersion, methods, events, unmatched }`). Committed,
sorted, deterministic; a test regenerates and compares.

### 6.8 Fake runtime contract (`./testing`, H6)

- `startFakeHerdr({ dir, world?, agentStartFaults? })` → `{ socketPath, bin, world, agentStartFaults,
  emit(event), setStatus(paneId, status), stop() }`:
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
  `worktree.create` opens the linked checkout with its root tab and pane like the pinned server. Every placement
  records its env on the fresh pane, where `pane.get` surfaces it. `agentStartFaults` is a live queue of
  `agent.start` failures (consumed FIFO), so a test scripts busy-then-ok or a permanent failure.
- `bin` is a Node shim script (shebang pins the running Node binary, 0700) answering `--version` (`herdr 0.9.1`), `api schema
  --json` (the snapshot), `server` (runs `startFakeHerdr` at `HERDR_SOCKET_PATH` until SIGTERM or `server.stop`),
  JSON CLI verbs by forwarding to the fake socket, and `terminal session control|observe` (emits one ready frame and
  echoes `send` lines as output frames; a `{"type":"fake.stream",count,size,progress}` line streams numbered frames
  as fast as the pipe takes them, recording the count written to `progress`, then one `fake.stream.done` line on
  the same ordered stream, for backpressure tests).
- `herdrContract(make)`: ping/protocol gate (newer server → steady `needs-update`, older → throw;
  declared range accepts newer as ready), bootstrap ordering with an event racing the snapshot, rejected
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
| `agent.notInstalled` | Install this helper in the app first, then try again. |
| `approval.stale` | That question already changed. Look again before answering. |
| `close.wouldWiden` | Closing this would close more than you picked. Close the bigger one instead. |
| `link.notAllowed` | This device can't do that. Ask the person at the computer. |
| `move.too_early` | This conversation has not started yet. Try again in a moment. |
| `move.busy` | Wait for this conversation to finish before moving it. |
| `move.unsupported` | This conversation cannot move between these accounts. |
| `move.env_mismatch` | The new pane did not receive that sign-in. Try again. |
| `move.close_failed` | The move could not be confirmed. Check the remaining panes before trying again. |
| `move.start_failed` | The new account could not take over. Try again. |
| `move.blocked` | This conversation is waiting for your answer. Answer it, then move it. |
| `move.changed` | This conversation changed while moving, so it was not moved. Check your panes, then try again. |
| `move.interrupt_unsupported` | Stopping a step is not available for this agent. Move it when the step finishes. |
| `move.signed_out` | Sign in to {name} first. |
| `turn.failed` | This turn could not be confirmed. Check the helper before trying again. |

## 7. Connection adapters

### 7.1 Host side (`./link`)

```ts
import type { HerdrKit, HerdrScope } from '@byokit/herdr';
import type { Grant, Host, HostOptions } from '@byokit/pair';
import type { RelayClient } from '@byokit/relay';
import type { IncomingMessage, ServerResponse } from 'node:http';
type Via = 'auto' | 'tailscale' | 'tailscale-direct' | 'private' | 'lan';   // @byokit/discover
type ServeIngress = { kind: 'tailscale-serve'; port: number; dnsName: string; proxy: string };   // @byokit/discover
export declare function herdrLink(kit: HerdrKit, o: {
  scopeOf: (grant: Grant) => HerdrScope;                   // which workspaces a device acts in
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: Pick<RelayClient, 'notify'>;                     // sealed approval push (7.3); RelayClient fits
}): Pick<HostOptions, 'handle' | 'stream' | 'allow'>;
export declare function serve(o: { host: Host; port: number; via?: Via; previous?: ServeIngress;
  http?: (req: IncomingMessage, res: ServerResponse) => void }): Promise<{ urls: string[]; ingress?: ServeIngress; close(): Promise<void> }>;
```

`serve` = `reach({ port, via, previous })` → one `node:http` server per `bind` address, plus loopback, each
answering `http` when given, else 404, with a `ws` `WebSocketServer({ server })` →
`host.accept(ws, { peer: req.socket.remoteAddress })`; returns `urls` for `host.offer({ urls, role })` and the
`ingress` to persist. `scopeOf` returns `{ workspaces: 'all' | string[] }`.

Ops (`handle` unless marked stream; *view* = allowed for view-role grants; all others need `control`; scope = `scopeOf(grant)`; any pane/tab/workspace outside scope → `link.notAllowed`):
`hd.state` *view*, `hd.tree` *view* (snapshot filtered to scope), `hd.kinds` *view* → `agentKinds()` (the kind
picker's list; no scope applies), `hd.agent.start { kind, cwd, place }`, `hd.prompt { paneId, text }` →
`PromptReceipt`, `hd.keys { paneId, keys }`, `hd.wait { paneId, until?, timeoutMs }` → `AgentStatus` (control;
`timeoutMs` a positive finite number), `hd.read { paneId, source?, lines? }` *view*, `hd.blocked` *view*,
`hd.answer { paneId, keys, revision }`, `hd.close { pane | tab | workspace }`, `hd.rename
{ pane | tab | workspace, label }`, `hd.focus { pane | tab | workspace }`, `hd.layout
{ root, focus?, tabId?, tabLabel?, workspaceId? }` — all three control and scope-checked like `hd.close` (the one
pane, tab or workspace they name must be in `scopeOf(grant)` or the op is `link.notAllowed` and no Herdr call is
made), and mapped only to the typed calls in the generated table through the kit's own `rename`/`focus`/`layout`, never through `hd.call`: `hd.rename` to
`pane.rename`/`tab.rename`/`workspace.rename` (a tab through its owning workspace, a workspace through itself),
`hd.focus` to `pane.focus`/`tab.focus`/`workspace.focus`, and `hd.layout` to `layout.apply` with exactly one of its
`tabId` (checked through its owning workspace) or `workspaceId` as the scope target — every `pane_id` leaf the layout
names must be in `scopeOf(grant)` too (an unnamed leaf is a new pane and needs no check) — a `view` grant is refused.
`hd.events` (stream) *view* (frames
`HerdrLinkEvent`: `{ type: 'snapshot', snapshot }` in scope + `{ type: 'blocked', change, blocked }`),
`hd.subscribe` (stream) *view* `{ subs: HerdrSubscription[] }` (`kit.subscribe` over the link, one frame per
event; a filter's `pane_id` must be in scope; a grant scoped to a workspace list gets only events every workspace
id of which — any `*workspace_id` field or `workspace_ids` entry, else the workspace holding the event's `pane_id` —
is in scope; a subscribe the kit cannot open or Herdr rejects, and a kit disconnect, end the stream), `hd.terminal` (stream) `{ paneId, mode, cols, rows }`
(`control` needs the control role; view grants get `observe` only; frames are Herdr's terminal NDJSON both ways),
`hd.notices.register`, `hd.call` (pass-through, D8).

### 7.2 Device side (`./device`, portable)

The typed pass-through uses the 4.6 types (`import type` only, so `./device` stays portable) and `./device`
re-exports them with the frame types below.

```ts
import type { DeviceLink } from '@byokit/pair';
import type { AgentRef, AgentStatus, BlockedAgent, HerdrEventName, HerdrEventOf, HerdrMethod, HerdrParams, HerdrResult,
  HerdrSnapshot, HerdrState, HerdrSubscription, PromptReceipt, StartAgent } from '@byokit/herdr';
export type HerdrLinkEvent =                                // hd.events frames
  | { type: 'snapshot'; snapshot: HerdrSnapshot }
  | { type: 'blocked'; change: 'added' | 'resolved'; blocked: BlockedAgent }
  | { type: 'raw'; line: string };                          // a line that was not JSON
export type DeviceTerminal = {
  ready: Promise<void>;                                     // first frame; rejects when the stream ends before one
  exited: Promise<{ reason: string | null }>;               // stream end; reason = the host's words, null when clean
  onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
};
export declare function herdrDevice(link: DeviceLink): {
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
  rename(o: HerdrRename): Promise<void>;          // HerdrKit.rename's shape (6.2)
  focus(o: HerdrTarget): Promise<void>;
  layout(o: HerdrLayout): Promise<HerdrResult<'layout.apply'>>;   // exactly one of tabId/workspaceId
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
The host's exit code and stderr tail stay host-side (diagnostics, 6.5). `pairingView`, `consentWords`,
`linkWords` and `qrMatrix` from `@byokit/ui` cover pairing.

### 7.3 Relay, discover and seal

- **discover**: used only inside `serve()` (7.1); nothing kit-specific.
- **relay**: when `relay` is passed, each new `BlockedAgent` sends `relay.notify({ id: <approval id>,
  title: words('approval.notice'), data: { v: 1, sealed: b64url(sealBox(JSON.stringify(approval),
  box)) }, to: [grant.id], urgency: 'high' }, {
  includeContent: true })` once per device that registered a box key and may see it; the relay reads only the
  generic title. Devices
  without a box key get the generic title only (`includeContent: false`).
- **seal**: each kit's `src/notices.ts` holds `sealNotice(value, boxPublicKey)` and (portable, re-exported by
  `./device`) `openNotice(data, seed)` → `openBox` → JSON → shape-checked `BlockedAgent`, `null` for anything else. The envelope is unpadded base64url of `sealBox` of the
  UTF-8 JSON. Herdr's pair delegates to `@byokit/seal`'s generic `sealNotice`/`openNotice`, turning the device
  seed into the box secret through `boxKeyPairFromSeed`, so one seal opener serves every kit; an envelope sealed by
  an earlier kit still opens, and `seal.openNotice` opens a herdr notice. Each file keeps its base64url helpers
  for box-key registration text (7.1's `hd.notices.register`), because seal exports no
  base64url.
- **ui**: `stateWords`; ui itself unchanged.

## 8. Example apps

A standalone app that installs **published** packages only (no workspace links, no muxr source):

```
examples/herdr-kit/     package.json  host.ts  web/index.html  web/app.ts  README.md  e2e.test.ts  LIVE.md
```

- `package.json`: `"private": true`, dependencies on the kit and `@byokit/pair`, `@byokit/discover`, `@byokit/relay`,
  `@byokit/ui`, `@byokit/seal` at exact published versions, `esbuild` (dev) to bundle `web/app.ts`. Scripts: `start` (`node
  host.ts`), `build:web`, `test` (`node --test e2e.test.ts`). Not part of the root workspaces.
- `host.ts`: `new HerdrKit({ mode: 'own', bin: <from --herdr flag, absolute>, stateDir: './.state' })`, grants carry
  `meta.scope = { workspaces: 'all' }`, link `Host` with `herdrLink`, grants in `./.state/grants.json`; `serve({ host, port: 7310 })`;
  also serves `web/` over plain HTTP on the same port; prints the offer as a terminal QR from `qrMatrix` and asks
  `Pair <name>? (y/n)` on stdin for `confirm`.
  `--relay <url>` (and `--enrol <token>`, first start only) opens a `RelayClient` once the host is open and
  passes the kit `relay: { notify }` reaching it; the offer adds `linkUrl(relay, host.id)`,
  the terminal prints the relay's short code, and op `example.push` hands a device's push address to
  `relay.subscribe(grant.id, …)`. The page takes no push itself; a phone app registers its notice key, sends its
  push address and opens what arrives (7.3).
- `web/app.ts`: pair (typed code or scanned offer text pasted), then a tree, "Start
  agent" (kind picker from `hd.agentKinds()`, op `hd.kinds`), prompt box, pane text via `hd.read` refreshed on
  `hd.events`, blocked list with key buttons `Enter`, `y`, `n`, `Esc`. Plain DOM, no framework. Works in a phone browser over LAN/Tailscale.
- `README.md`, minutes to working: prerequisites (Node 22.18; Herdr 0.9.1 installed),
  `npm i`, `npm start`, open the printed address on the phone, pair, log in inside the agent's pane, send a message, approve. Includes a troubleshooting table keyed by the words sentences.
- `e2e.test.ts` (CI, `browser` job): packs the workspace packages (`npm pack -w …`), installs the tarballs into a temp
  copy of the example (proving the published shape), starts `host.ts` with the kit's fake (`BYOKIT_EXAMPLE_FAKE=1`
  switches to `startFakeHerdr()` — the only env read, in example code, not library code), drives
  headless Chromium through pair → start agent → prompt → receipt → `ask permission` blocked → answer `y` → idle, and asserts the
  person-visible text equals `words.json` sentences. Away from home: a loopback `Relay` whose push `fetch` is a
  recorder, a Node device pairing by `findHost` + `pairWithCode`, registering a notice key and an Expo token; the
  pushed message must carry the generic title, none of the question's text, and open only with the
  device's own seed.
- `LIVE.md`: the manual end-to-end proof, run once per kit release in the isolated lab: real Herdr v0.9.1 in `own` mode (under a `--herdr-lab` brief) with one agent CLI signed in inside the lab home. Record date,
  versions and screenshots path in the PR.

## 9. Tests, CI and isolation

- Every kit test runs under `scripts/test.sh` (throwaway HOME, `~/.pi` byte check, temp-dir leak check, an egress
  guard that blocks non-loopback connects and datagrams in every node of the run); temp dirs
  use the `byokit-` prefix helper in `packages/test-support.ts`.
- Portability: `packages/herdr/test/portable.test.ts` bundles
  `./device` for `browser` and `react-native` conditions with esbuild and fails on any `node:*` or Node-only import
  (same approach as `packages/accounts/test/portable.test.ts`).
- Isolation: a kit test runs the fake runtime with a decoy HOME containing `.pi`, `.codex`, `.claude`,
  `.config/herdr` canaries (`packages/accounts/src/testing`) and asserts they are untouched and never opened.
- Herdr: no CI job touches a real Herdr. The H9 lab run uses `herdrContract` against v0.9.1 in `own` mode inside a
  task-owned HOME.
- Release: `release.yml` `options` gain `herdr`.

## 10. Extraction and adoption order

1. byokit builds `@byokit/herdr` (H1–H10); each merged PR keeps
   `npm test` green; nothing is published until the kit's H9 proof is green. Until then the kit's
   package.json carries "private": true (the release command skips private packages); the PR that lands
   H10 removes it.
2. Owner publishes `@byokit/herdr` 0.1.0.
3. **muxr adopts later and separately** (H11, not scheduled here): only after `@byokit/herdr` is published and
   muxr's byokit cutover allows it; muxr first requires Herdr ≥ the kit's pin; the swap is behind muxr's own
   acceptance and must not change muxr behavior; muxr stability wins every conflict.

## 11. Work packages

Builders: **Sol** = `openai-codex/gpt-6-sol`, thinking medium (judgment-heavy: supervision, auth, approvals, link,
extraction seams). **Flash** = `zai/glm-5.3-flash`, thinking medium (mechanical: scaffolds, generated types,
fakes, words, examples, tests). Each package is one direct PR to byokit, commits only its listed files
(plus lockfile), keeps `npm run build`, `npm run check`, `npm test` green, and does not edit files owned by another
package except where listed. Sol packages may wait for quota; Flash packages never depend on an unmerged Sol
package unless the table says so.

Stubs rule: H1 creates **every** `src/*.ts` file listed in 6.1 with the exact exported signatures from this
document and bodies `throw new Error('not built: <package id>')`. Later packages replace bodies only; a signature
change is a spec change (stop and ask).

### 11.1 Dependency graph

```
Flash now:  H1 ─┬─ H2* ─────────┐
                ├─ H4            │
                ├─ H6 ─────────┐ │
                └─ H8          │ │
Sol:            H3 (H1,H2,H6)      │ │
                H5 (H3,H6)         │ │
                H7 (H3,H4,H5,H8)   │ │
                H9* Flash (H3,H5,H7) lab
Flash last:     H10 Flash (H7,H9)
Later:          H11, muxr repo (not scheduled)
* needs a --herdr-lab brief
```

### 11.3 Herdr lane

**H1 — scaffold and stubs** · Flash · deps: none
- Files: `packages/herdr/{package.json,tsconfig.json,README.md,CHANGELOG.md,LICENSE}`, all `src/*.ts` stubs (6.1)
  with 6.2/7.1/7.2 signatures, `src/constants.ts` (`HERDR_VERSION = '0.9.1'`, `HERDR_PROTOCOL` placeholder `0` with
  a test that fails until H2 sets it — marked `todo` in `node:test`), root build list, `release.yml` option `herdr`,
  README package row; `README.md` and `CONTRIBUTING.md` isolation sentences amended: "Runtime kits drive only the
  aggregator the app names explicitly (the Herdr binary and socket the app
  passes); byokit tests use fakes and never a person's Herdr."; `AGENTS.md` line pointing at this document.
- Acceptance: build/check/test green; `test/portable.test.ts`; `test/exports.test.ts`.

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
  package reports `blocked` to the maintainer instead of merging.

**H3 — socket, supervision, bootstrap, facade** · Sol · deps: H1, H2, H6
- Files: `src/socket.ts`, `src/supervise.ts`, `src/kit.ts`, `test/socket.test.ts`, `test/supervise.test.ts`.
- Behavior: 6.3; facade delegates helpers to their modules.
- Acceptance with `startFakeHerdr`: request per connection; error frames → coded errors; timeouts; rejected
  subscription (bad batch) surfaced once, not retried; per-pane status socket; event socket drop → re-bootstrap
  with an event emitted between subscribe-ack and snapshot applied after the snapshot, no duplicate; older
  protocol → throw, newer → steady `needs-update` (declared range accepts newer as ready); `adopt` never spawns (spy) and `stop()` leaves the fake running; `own` mode spawns the
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
  rejected); not-promptable agent refused without an `agent.prompt` call (one `agent.get` re-read first); `agent_blocked` mapped; each close guard refuses
  widening and maps not-found; blocked → `onBlocked` added with detection text and revision; `answer` with stale
  revision refused (`approval-stale`), with current revision sends keys and the agent resolves; a question that
  changes while the pane stays blocked is refused and republished under a new revision.

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
- Acceptance: scope enforcement per workspace list; view grant gets `observe` terminal only
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
- Acceptance: journey against `startFakeHerdr` (the example's `--herdr` flag points at the fake bin in the test).

**H11 — muxr adoption** · Sol · later, separate · repo: muxr
- Not scheduled by this foundation. Preconditions in section 10 step 5. Recorded so nobody starts it early.

### 11.4 Account routes lane (D18)

Builders: **F0** Opus 5.5 medium (this spec and fixture); **B**, **C** and **X** Sol 6.1 medium (backend, no
frontend code); **U** Opus 5.5 medium (connect view and examples). Each is one direct PR, keeps versions unchanged
and adds changelog fragments. Every in-policy upstream mechanism at the pins (365 tuples: 147 from the wrapped
upstreams, 218 from other open agent projects' catalogues) has a home: 24 are covered today, and each of the other
341 is owned by exactly one package below. The private inventory holds the row list.

| WP | Scope | Owned files | Deps |
|---|---|---|---|
| F0 | D18, this lane, the fixture and its structural test | `docs/runtime-kits.md`, `fixtures/README.md`, `fixtures/conformance/account-routes-typescript.json`, `packages/ui/test/account-routes.test.ts`, README pointers | — |
| B1 | accounts route table generated from the pinned pi-ai; `qwen` and `minimax` leave the default offer until their flows exist | `scripts/gen-accounts-routes.ts`, `packages/accounts/src/{routes.json,catalogue.ts,portable.ts}` | F0 |
| B2 | one key and plan-key path replacing the per-provider special cases; environment tokens become explicit paste rows | `packages/accounts/src/accounts.ts` | B1 |
| B3 | cloud credentials, Node only | `packages/accounts/src/accounts.ts`, `routes.json` | B1 |
| B4 | custom endpoints and local presets over `createProvider`; billing from the person's choice | `packages/accounts/src/accounts.ts` | B1 |
| B5 | remaining pinned sign-in flows (loopback, paste, device) and missing device fixtures | `packages/accounts/src/*`, tests | B1 |
| B9 | herdr kind table, folder per kind, managed-folder readiness | `packages/herdr/src/{kinds.json,accounts.ts,agents.ts}` | F0 |
| B10 | portable device-code engine for every device route; a route whose client registration the host does not supply is `needs_client`. A provider whose device grant yields an intermediate token (Copilot) is one more exchange step as data, not code: `copilot_internal/v2/token` (a GET) with the intermediate as the bearer, re-minted on every refresh; a 401 or 403 there is signed out, never a retry. The portable sign-in stops at the credential and never replicates Pi's best-effort model-policy enable step. | `packages/accounts/src/device.ts`, `fixtures/conformance/device-code-rfc8628-typescript.json` | B1, B5 |
| X3 | usage reads a credentials file only inside a managed folder | `packages/usage/src/providers.ts` | — |
| C1 | named catalogue import: key, plan-key, local, endpoint and cloud rows from exact release snapshots | `scripts/gen-parity-routes.ts`, `packages/accounts/src/routes.json` | B2, B3, B4 |
| C2 | further device-code flows | `packages/accounts/src/flows/*` | B5, B10 |
| C3 | further OAuth browser and paste flows. Google routes: **proceed** — both Google routes (`google-gemini-cli` and `google-antigravity`, browser and paste) kept in scope, plain sign-in, offered once their sign-in flows land (`google-gemini-cli` browser and paste landed with WP6-S3; `google-antigravity` landed with WP6-S5); no terms gate and no approval step. Recorded facts, not offer gates: the Gemini CLI individual-plan sunset (muxr research `pock-multisub-landscape/report.md:79`) and Antigravity's terms naming third-party OAuth as a suspension ground with the mass-ban incident (`:80`, `:81`); the Antigravity CLI's own sign-in stays the supported path (`:611`). Settled: reuse the upstream public client ids, as the upstream implementations do, and use the upstream fresh-sign-in parameter, whichever the parity snapshot (`omp` v18.4.10 `cb0d5295`) uses. Client-id reuse is the parity report's rule-8 fact (`byk-account-parity/report.md` §10.8: `impersonation_ua` reported on 16 tuples, no legal assurance). Routes rows land with the flows, not here. | `packages/accounts/src/flows/*` | B5 |
| C4 | further setup-token, environment-token and free-tier rows | `packages/accounts/src/{accounts.ts,routes.json}` | B2 |
| C5 | non-model service rows: data, adapters, auth tests | `packages/accounts/src/routes.json`, tests | B2, B4 |
| U1 | ui connect view grouping every route (plans, pay per use, on this computer, your own server, cloud, services) | `packages/ui/src/connect.ts`, words | F0, B1, B9 |
| U2 | examples list every route; no hardcoded provider | `examples/*` | U1 |

Acceptance for every package: its fixture rows, mocks and fakes in `npm test`; no live vendor sign-in is required.

**B10 in detail (the exchange step, `needs_client`, and the model-policy question).**
- *Exchange step.* Copilot's RFC 8628 device grant answers an intermediate GitHub token (`/login/oauth/access_token`, grant
  `urn:ietf:params:oauth:grant-type:device_code`), not the credential. The credential is one more `GET` to
  `https://api.{host}/copilot_internal/v2/token` with that intermediate as `Authorization: Bearer`; its answer `{ token,
  expires_at }` becomes the access token, the intermediate is kept as the credential's `refresh`, and every refresh re-mints
  it the same way (`pi-ai github-copilot.js:244-284`). This is `DeviceFlow.exchange` — a URL on the catalogue row, so the
  portable engine needs no Copilot branch. A 401 or 403 on the exchange is a refused grant: signed out, never retried.
- *`needs_client`.* `routeReadiness` (`packages/accounts/src/catalogue.ts`) answers `needs_client` when a Route declares
  `needs.client` and the app's host does not supply it in `host.clients`. That is a Route/host fact, not a property of a
  device descriptor: nothing here maps a missing `DeviceFlow.clientId` to `needs_client`, and the device rows this lane
  defines (Grok, Kimi, Copilot) already carry their client ids. Treating a device row with no client registration as `needs_client`
  is dependent work for the portable engine lane, not something this data-only slice implements.
- *Model policy: not replicated.* Pi, after login, fetches the Copilot model catalog and best-effort POSTs
  `/models/{id}/policy {state:'enabled'}` for `unconfigured` models (`github-copilot.js:289-334`). That is a model-catalog
  step, not a sign-in step, and it is best-effort (a refused policy enable still leaves a usable credential). The portable
  path stops at the credential and makes no policy call; the catalogue's model list stays `pi-ai`'s static table.
- *GHE host templating.* Copilot's `authorization`, `token` and `exchange` URLs carry `{host}`. The portable runtime
  fills it with the person's Enterprise domain per account (`login(member, 'copilot', { enterpriseDomain })`), kept on
  the credential as `enterpriseUrl` so a reloaded account re-mints on the same host; github.com is the default. The
  rule lives in `packages/accounts/src/engine.ts` (`validEnterpriseDomain`).

## 12. Known facts builders must not re-derive

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

## 13. Usage inputs for account Auto

Quota ingestion follows `fixtures/conformance/usage-typescript.json` and
`@byokit/usage`'s `Room`. Structural copies in account/runtime pickers must carry
`limited`, `scope`, `at`, `ageMs`, `freshness` and `poll`; reported percentages
remain separate from eligibility. An authoritative hard block yields zero room,
even without a window or after a cached reset passes. Scoped windows use the
conservative tightest known room until a host supplies every model/surface a run
may use, including subagents and fallbacks. Missing percentage is unknown.

The existing most-room/tie and all-exhausted policies stay unchanged. Numeric
room requires a known observation time within 24 hours; undated, future and older
measurements are unknown. A failed poll retains last-good numbers and their
original age, with its separate attempt/outcome. A 429 or refresh failure is no
evidence of exhaustion or account health and never moves a running account. An
engine without an observation timestamp must expose unknown age; receipt time
cannot replace it. No engine observation-time support is claimed by this change.
