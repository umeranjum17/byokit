# Runtime kits: `@byokit/openclaw` and `@byokit/herdr`

Foundation spec and builder breakdown. Status: **built; `@byokit/herdr` 0.1.0 is published, and `@byokit/openclaw`
0.1.0 is released from its example PR (O12).** Capability kits have their own spec:
[docs/capability-kits.md](capability-kits.md).
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
They share connection adapters (`link`, `relay`, `discover`, `seal`, `ui`) and conventions, never a
lowest-common-denominator interface. `@byokit/accounts` keeps serving direct-provider apps (including Ownvoice); its
multi-account shapes (`Account`, `Room`, `RunSelection`, `Pick` as `AccountPick`) are restated structurally by this kit (5.15), never
imported. CLI sign-in status lives in `@byokit/herdr` `agentStatus` (B5); `@byokit/accounts` stays app-owned OAuth only and reports no CLI sign-in (B7).

Out of scope for the build phase: releasing (firstmate/owner runs `release.yml`), muxr adoption (section 10), any
operated service, and any change to `@byokit/accounts`, `link`, `relay`, `discover`, `seal`, `decide` or `ui`
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
| D9 | Members. OpenClaw: a member is an app-chosen id matching `/^[a-z](?!.*--)[a-z0-9-]{0,23}$/` (no `--`, at most 24 characters, so every account agent id `<member>--<6 hex>` stays within 32), never `main`, `openclaw`, `crestodian` or starting `byokit-`; an agent that already exists under the older `/^[a-z][a-z0-9-]{0,31}$/` rule and is no member's account agent keeps working with its member agent only (D17), and no new member is created under the old rule. The id is used verbatim as the OpenClaw `agentId` of the member agent; every session key must start `agent:<member>:`, `agent:<member>--<6 hex>:` for an account agent in the member's index (5.15), or (key lane) exactly `agent:byokit-key-<member>:`; each sign-in is granted once and shared across that member's agents as scoped views (D11, D17). Herdr: no member concept upstream; a link grant carries `meta.scope = { workspaces: 'all' \| string[] }`. |
| D10 | Approvals. OpenClaw: (a) the kit's fail-closed tool bridge (Crewhouse's plugin hook → unix socket → app `gate()`), extended with a parked `ask` result; (b) OpenClaw's native `exec.approval.*`, `plugin.approval.*`, `question.*` surfaced through the same `Approval` shape. Herdr: an agent in `blocked` state is an approval; the answer is keys sent to that exact pane occupant (revision-checked). |
| D11 | Sign-in: sign in once. OpenClaw: the kit drives OpenClaw's own `openclaw.setup.auth.start` + `wizard.next` loop and holds the ChatGPT callback port during a browser sign-in; each credential is granted once and shared, and every account agent sees only its scoped view of the grant (`viewStore` in `@byokit/accounts`, `packages/accounts/src/stores.ts`: one credential mapped to scoped slots); an optional host-injected seal sees bytes only to protect the isolated store at rest. With the person's consent, the kit may adopt the machine's existing Claude/Codex login instead of a fresh sign-in, then detect and activate it through the engine. Explicit API-key entry passes a secret only to typed `setup.activate`, never to kit storage, logs or return values (5.15). Herdr: each agent CLI's own login, done by the person inside an account-specific pane (terminal stream); `openSignInTab` opens that CLI in a new tab with the host's explicit account environment. Without the person's consent the kit never runs a login command, copies credentials between homes, or reads a CLI's credential files. |
| D12 | Route policy is data: all subscription routes, including native Claude Code (`anthropic-cli`: reports provider `claude-cli`, the id a Claude Code login is signed in as; manifest provider and plugin `anthropic`), and plan keys, are offered by default with plain sign-in; a choice the pinned Gateway has no app-guided sign-in for (`setup-token` at 2026.8.1) is listed with `flow: 'absent'`, never offered. API-billed routes are app opt-in only. Proxy routes, compatibility aliases, local runtimes and `copilot-proxy` are listed in discovery and used only when named (D18); the 2026.8.1 table shipped today still marks them off until WP B6 regenerates it. Native login is completed in Claude Code, or adopted from the machine's existing Claude/Codex login with the person's consent (D11); the kit asks engine `setup.detect` and `setup.activate`. No consent screen or terms gate is added. |
| D13 | Library code reads no environment variables except `PATH`, and only to locate `npm` for the engine install when `npmPath` is not given. Every spawned process gets an explicit env; `process.env` is never inherited. The Herdr binary path is always an explicit option. |
| D14 | `npm test` stays network-free. Tests needing the real engine (network `npm ci` of the pin, loopback only afterwards) run under `npm run test:engine` in a separate CI job `openclaw-engine`. Real-Herdr contract runs happen only in an isolated lab under a `--herdr-lab` brief, never in CI and never against a person's Herdr. |
| D15 | Retained-login migration source for OpenClaw is a Pi `auth.json`-shaped record (`{ [provider]: credential }`): a file path (Crewhouse's legacy engine) or an in-memory record (an app moving from `@byokit/accounts`' `fileStore`/`secureStore`). Retire only after the Gateway itself reports the member signed in to every provider in the source. |
| D16 | Crewhouse adopts first with behavior parity; muxr adopts later in a separate muxr change after the Herdr kit is published and muxr's byokit cutover allows it. Neither adoption is part of the byokit PRs. |
| D17 | Accounts (5.15). A member can hold several accounts, several per provider, subscription or API key. Each credential is granted once (sign in once, D11): an account is an agent holding a scoped view of the shared grant (`viewStore`), never a separately sealed copy, which also confines the pin's per-provider profile rotation inside one agent. The member agent holds the first view of each provider it is signed in to (its own existing sign-ins keep working, no migration; sign-ins read through another member's agent stop applying) and never holds an API key. Each run uses one account and one model, chosen, the default, or Auto (most room left, decided once at run start); a run never switches accounts, and a session stays on the account whose agent holds it until `move`. The engine's own per-person accounts, pooled proxies and per-request or mid-run rotation are not used. The kit adds the plugin id of every default-eligible bundled route to `plugins.allow` (5.6), so offered sign-ins work without app config. |
| D18 | Account routes ([2.1](#21-account-routes-d18)). Every sign-in method a kit's pinned upstream supports is one data row in one shared vocabulary owned by `fixtures/conformance/account-routes-typescript.json`; each kit restates the shapes structurally (D3). Discovery lists every row, unavailable ones with a plain reason. Subscription rows are offered by default; every other billing is used only when the app or person names it. Billing is pinned upstream metadata or explicit host input, never inferred from an address. Credential import, pooling proxies, per-request or mid-run rotation, and tokens leaving the device never become routes. The one exception is adopting the machine's existing Claude/Codex login with the person's consent (D11). |
| D19 | Bundled engine patches: [5.16](#516-bundled-engine-patches-and-engine-started-usage) owns provenance, immutable sets, activation conditions and coverage. |
| D20 | Browser sign-in handoff and live view ([5.17](#517-browser-sign-in-handoff-and-live-view-d20)). Each member gets a kit-owned pipe-only Chromium behind a kit CDP broker that the stock engine attaches to as an `attachOnly` profile (no engine patch). The person signs in by taking over a private tab no agent client can see; it is closed before the fence lifts. A request settles once; only a positive host-only site verification is `verified`, and only `verified` resumes, at most once, with no automatic redispatch when the outcome is unknown. Handoff stays refused until parked sessions are protected (O17 or the proven `before_agent_run` seam), and while any agent sharing the engine has a tool outside the closed safe set. Live view is the same broker's screencast over a link stream. |

### 2.1 Account routes (D18)

One vocabulary covers every account mechanism on every surface: `@byokit/accounts` (the pinned pi-ai providers,
auth modules and `createProvider`), `@byokit/openclaw` (the pinned engine's auth choices, bundled and external
plugins, and providers configured without a choice) and `@byokit/herdr` (the pinned agent kinds). Each kit restates
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
  upstream: { surface: 'accounts' | 'openclaw' | 'herdr'; id: string; method?: string; revision: string; flow: 'present' | 'absent' };
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
   the provider and `via`. One time-boxed exception: OpenClaw's `anthropic-cli` reports provider `claude-cli` from
   0.7.0 but keeps id `anthropic:cli:anthropic-cli` (and `deprecatedProvider: 'anthropic'`) through 0.8.x so lookups
   by the old name still resolve; 0.9.0 drops `deprecatedProvider` and renames the id to `claude-cli:cli:anthropic-cli`. `upstream` names the pinned source; `flow: 'absent'` lists a row the pin cannot sign in.
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
   method (key, base URL, region, profile, key file, chosen billing). openclaw: `call`/`callDynamic` (D6) and the
   full table. herdr: `cli(argv)` (D7) and the kind table.
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

Names, codes, errors, state, events, construction, options, words and export names follow
[kit-conventions.md](kit-conventions.md); this section adds only what is specific to the runtime kits. Where this
spec's binding sections prescribe a different shape, the spec wins until it is amended (kit-conventions Precedence).

### 4.1 Layers

```
app (niche workflow + UI)
  │ uses                       │ uses
  ▼                            ▼
@byokit/openclaw  or  @byokit/herdr        ← runtime kit: aggregator's full power + helpers
  │ ./link adapter (host)      ▲ ./device client (phone/web)
  ▼                            │
@byokit/link · relay · discover · seal · ui   ← unchanged connection kits
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

Each kit has one `state` object and emits `onState`, and every state and failure a person can see has a sentence in
the kit's `src/words.json` ([kit-conventions.md](kit-conventions.md) §5 and §9).

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
import type { CallOptions, GatewayMethods as Methods } from '@byokit/openclaw';
type MethodName = keyof Methods;                       // generated
type ParamsOf<M extends MethodName> = Methods[M]['params'];
type ResultOf<M extends MethodName> = Methods[M]['result'];
declare function call<M extends MethodName>(method: M, params: ParamsOf<M>, o?: CallOptions): Promise<ResultOf<M>>;
```

`Methods` entries whose schema type could not be matched are `{ params: unknown; result: unknown }` and are listed in
the generated `report.json`.

## 5. `@byokit/openclaw`

### 5.1 Files

```
packages/openclaw/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  engine/package.json  engine/package-lock.json      # { "dependencies": { "openclaw": "2026.8.1" } }, integrity-locked
  plugin/index.js  plugin/accounts.js  plugin/package.json   # bridge plugin + account sealing (5.15); manifest at prepare
  policy/policy.mjs                                  # operator install policy (OpenClaw security.installPolicy, protocol 1)
  scripts/gen-methods.ts  scripts/method-types.json  # O2 generator + its override map
  src/index.ts  src/constants.ts  src/types.ts
  src/generated/methods.ts  src/generated/events.ts  src/generated/report.json
  src/engine.ts  src/config.ts  src/transport.ts  src/kit.ts
  src/bridge.ts  src/approvals.ts
  src/signin.ts  src/routes.json  src/routes.ts  src/migrate.ts
  src/runs.ts  src/classify.ts  src/members.ts
  src/accounts.ts  src/pick.ts  src/locks.ts       # 5.15
  src/words.json  src/words.ts
  src/link.ts  src/device.ts  src/notices.ts
  src/browser.ts  src/browser/broker.ts  src/browser/host.ts  src/browser/store.ts  src/browser/verify.ts
  src/browser/resume.ts  src/testing/browser.ts      # 5.17 (browser.ts: portable types)
  src/testing/index.ts  src/testing/fake-gateway.ts  src/testing/contract.ts  src/testing/model-stub.ts
  test/*.test.ts
```

`package.json`: `exports` `.` → `dist/index.js`, `./device` → `dist/device.js` (with `react-native` and `browser`
conditions pointing at the same file), `./link` → `dist/link.js`, `./testing` → `dist/testing/index.js`; `files`:
`dist`, `engine`, `plugin`, `policy`, `README.md`, `LICENSE`. Dependencies (exact): `@openclaw/gateway-client`
`2026.8.1`, `@openclaw/gateway-protocol` `2026.8.1`, `@byokit/link` (current `0.3.1`), `@byokit/relay` (current
`0.1.3`), `@byokit/discover` (current `0.2.0`), `@byokit/seal` (current `0.1.0`), `ws` `8.21.3`. Dev: `@byokit/ui-core`
(assignability test only).

### 5.2 Public types (`src/types.ts`)

```ts
import type { AccountId, AccountRef, Considered, PickWhy } from '@byokit/accounts';
import type { OutputSchema } from '@byokit/openclaw';
export type Member = string;                                   // D9 rule, = the member agent's OpenClaw agentId
export type LearningMode = 'off' | 'propose' | 'auto';        // skills.workshop.autonomous.mode (5.6)
export type LearningCapture = { present: false } | { present: true; mode: LearningMode };  // absence is a value
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
export interface RunSpec<S extends OutputSchema | undefined = OutputSchema | undefined> extends RunRef {
  message: string; system?: string;
  idempotencyKey?: string;                                    // stable per-dispatch action key; cache bounds in 5.8
  schema?: S;                                                 // validated JSON output (5.8.1)
  images?: { data: string; mimeType: string }[];
  thinking?: 'off' | 'low' | 'medium' | 'high';
  model?: string;                                              // 'provider/model' (5.8); with `account`, a model of that account
  account?: AccountRef | 'default' | 'auto';                   // 5.15; absent = the session's account, else as before
  needs?: string[];                                            // 5.15: other models the run may call
  auth?: 'apiKey';                                             // 5.15: the member's newest API-key account
  tools?: string[];                                            // app tools (KitOptions.tools names) this run may call
  register?: boolean;                                          // default true: the bridge recognizes this run
}
export type RunEvent =
  | { type: 'started' }                                       // Gateway accepted, not completed
  | { type: 'thinking'; tokens: number }                      // actual thinking progressTokens
  | { type: 'account'; account: AccountId; model: string; sessionKey: string;   // 5.15: first event of a run on
      how: 'chosen' | 'default' | 'auto'; why: PickWhy;        // an account, before the `agent` request
      considered: Considered[] }
  | { type: 'text'; text: string }                             // cumulative assistant text
  | { type: 'tool'; name: string; phase: 'start' | 'end';
      id?: string;                                             // engine toolCallId, pairs start and end
      input?: Record<string, unknown>;                         // start: the call's arguments
      output?: unknown; error?: boolean };                     // end: the engine's tool result, and whether it failed
export type RunUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  reasoning?: number; total?: number; costUsd?: number };      // the engine's run total
export type PlanWindow = { provider: string; plan?: string;
  windows: { label: string; usedPercent: number; resetAt?: number }[] };   // usedPercent 0-100, resetAt epoch ms
export type RunEnd<T = unknown> =
  | { ok: true; text: string; data?: T; usage?: RunUsage; planWindow?: PlanWindow;   // data: validated schema; usage/window: engine reports
      account?: AccountId; model?: string }                    // both exactly when the run used an account (5.15)
  | { ok: false; aborted: true }
  | { ok: false; kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other' | 'output'; until?: number; message: string };
export type SignInView = {
  state: 'waiting' | 'done' | 'failed'; via: 'browser' | 'code';
  url?: string; code?: string; expiresAt?: number; message?: string; prompt?: string; error?: string;
  why?: 'busy' | 'declined' | 'expired' | 'failed';
};                                                       // expiresAt: epoch ms when `code` expires, when the engine says; message: the engine's instructions shown with `code`; prompt: what a waiting text step asks
export type Approval = {
  id: string;                                                  // kit-minted, url-safe
  source: 'gate' | 'exec' | 'plugin' | 'question';
  member: Member; sessionKey?: string; tool?: string;
  summary: string; input?: unknown; at: number; expires: number;
};
export type Decision = { allow: boolean; reason?: string; answer?: unknown };   // answer: question.* only
export type KitState = {
  phase: 'stopped' | 'installing' | 'starting' | 'repairing' | 'ready' | 'restarting' | 'failed' | 'needs-update' | 'locked';
  why?: 'install' | 'handshake' | 'exited' | 'port' | 'version' | 'engine-already-running' | 'engine-patch' | 'sign-in-reset' | 'auth-store-unreadable' | 'auth-store-seal-size';
  retryAt?: number;
  sealSize?: { size: number; cap: number; file?: string };     // with 'auth-store-seal-size'; size is a lower bound; file names an over-cap engine store
  patchSet?: string | null;                                    // bundled engine patch set id after prepare (5.16)
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

### 5.2.1 Retained-session usage (portable `./usage`, also exported from `.` and `./device`)

`readAgentUsage(client, member, { startDate, endDate }, options?)` reads `sessions.usage` with explicit
agent ownership, inclusive UTC calendar dates and instance grouping. `client.call` may be the host or device
client's existing typed pass-through; options are `CallOptions`. `agentUsageOf(raw, member, window, receivedAt?)`
normalizes a previously read response without I/O. Both return `AgentUsageReading`: raw response retained,
received/assembly/refresh timestamps distinguished, `coverage: 'retained-transcripts-only'`, optional observed
`LedgerUsageTotals`, cache metadata, and `state: 'available' | 'unavailable'`. Missing/malformed counters, an
unconfirmed agent/window, absent cache freshness or pending/stale files leave totals unavailable, never zero.
RPC errors reject normally; no fabricated fallback response. Helpers do not cache or accumulate run results.

**This is not complete engine usage:** stock 2026.8.1's engine-started Workshop review uses detached persistence
and does not enter the session/day ledger (R4 real-engine gap fixture). Restart resumes and memory flushes are
included only to the extent their usage is actually persisted; real-trigger acceptance for those paths remains
unqualified. Resets/deletions/retention may reduce observed totals, so do not treat readings as monotonic. Cost
fields are engine price/billing counters, not a bill or subscription quota: preserve `missingCostEntries` and
`missingCostByModel`, and never infer billed dollars or plan weights from tokens or zero costs. The caller owns
budget/share policy and must explicitly handle partial/unavailable/stale coverage. Full existing `call` typing
and all usage RPCs remain available; no new engine API or patch build seam is created by this helper.

### 5.3 `OpenClawKit` (`src/kit.ts`, exported from `.`)

```ts
import type { Account, AccountId, AccountPick, AccountRef, Defaults, ModelInfo, Room, RunSelection } from '@byokit/accounts';
import type { Approval, CallOptions, Decision, GatewayEventName, GatewayEventPayload, GatewayMethod, GatewayParams,
  GatewayResult, GatewayTransport, Hello, KitState, LearningCapture, LearningMode, Member, OutputSchema, Route, RunEnd,
  RunEvent, RunRef, RunSpec, SchemaOutput, SignInView, ToolHost, ToolSpec } from '@byokit/openclaw';
import type { SealingAdapter } from '@byokit/secrets';
type MoveResult = { ok: true; session: string } | { ok: false; code: 'too_early' | 'busy' | 'unsupported' |
  'env_mismatch' | 'close_failed' | 'start_failed'; message: string; live?: string };   // 5.15

export type KitOptions = {
  stateDir: string;
  authSeal?: SealingAdapter;                       // @byokit/secrets seal: credential state (credential paths under state + home config/credentials) sealed while stopped; other state stores sealed as objects
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
  appOwnedSessions?: { keyPrefixes: string[] }; // caller-owned task prefixes, default stock recovery (5.16)
  installPolicy?: { trustedSkills: string; ownRoots: string[] };   // trusted-skills JSON path, own content roots
  callbackPort?: number;                 // default 1455
  approvalTimeoutMs?: number;            // default 180_000
  transport?: (ctx: { port: number; token: string; identityPath: string; bridgeSock: string }) => GatewayTransport;  // tests
  spawnEngine?: boolean;                 // default true; false skips install, doctor and spawn (layout, token,
                                         // port, config, plugin and bridge still happen)
  onState?: (s: KitState) => void;
  log?: (line: string) => void;
};

export declare class OpenClawKit {
  constructor(o: KitOptions);
  readonly state: KitState;
  prepare(): Promise<void>;              // install + layout + config, no launch; idempotent
  start(): Promise<void>;                // prepare, launch, handshake, bridge up; resolves at 'ready' or recoverable 'locked'
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
  providerStatus(member: Member): Promise<string[] | undefined>;
  providers(member: Member): Promise<string[]>;
  signedIn(member: Member, provider: string): Promise<boolean>;
  signIn(member: Member, o: { authChoice: string; via?: 'browser' | 'code' }, on: (v: SignInView) => void):
    { paste(text: string): void; cancel(): void; done: Promise<SignInView> };
  signOut(member: Member, provider: string): Promise<void>;
  migrateRetainedLogin(member: Member, source: RetainedLogin): Promise<'staged' | 'nothing' | 'failed'>;
  confirmRetainedLogin(member: Member, source: RetainedLogin): Promise<boolean>;
  // accounts (5.15)
  accounts(member: Member): Promise<Account[]>;
  addAccount(member: Member, o: { authChoice: string; via?: 'browser' | 'code'; name?: string; again?: AccountId },
    on: (v: SignInView) => void): Promise<{ id: AccountId; paste(text: string): void; cancel(): void;
    done: Promise<{ view: SignInView; id: AccountId }> }>;
  addKey(member: Member, o: { authChoice: string; apiKey: string; name?: string }): Promise<'ok' | 'invalid' | 'not_included'>;
  renameAccount(member: Member, id: AccountId, name: string): Promise<Account>;
  removeAccount(member: Member, id: AccountId): Promise<void>;
  models(member: Member, id: AccountId): Promise<ModelInfo[]>;
  room(member: Member, id: AccountId, demand?: string[]): Promise<Room>;   // demand: 'provider/model' ids (5.15)
  defaults(member: Member): Promise<Defaults>;
  setDefaults(member: Member, d: Defaults): Promise<void>;
  pick(member: Member, sel: RunSelection, o?: { sessionKey?: string }): Promise<AccountPick>; // what `run` would use now; decides nothing
  move(ref: RunRef, to: AccountId): Promise<MoveResult>;
  // runs (5.8)
  toolNames(): string[];                                        // KitOptions.tools names: what RunSpec.tools may carry
  run<const S extends OutputSchema | undefined = undefined>(spec: RunSpec<S>, on?: (e: RunEvent) => void): Promise<RunEnd<SchemaOutput<S>>>;
  steer(sessionKey: string, text: string, o?: { auth?: 'apiKey' }): Promise<void>;   // app or engine key (5.15)
  abort(sessionKey: string, o?: { auth?: 'apiKey' }): Promise<void>;
  // approvals (5.9)
  approvals(member?: Member): Approval[];
  onApproval(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void;
  decide(id: string, d: Decision): Promise<void>;
  allowOnce(rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean }, ms: number): void;
  disallowOnce(): void;
  // config
  patchConfig(patch: object, o?: { agentId?: string }): Promise<void>;   // config.get hash + config.patch
  getConfigKey(key: string): unknown;             // one dotted key out of openclaw.json, no full config read
  setConfigKey(key: string, value: unknown): unknown;  // one key in; returns what it replaced (undefined removes)
  memoryLimited(member: Member): boolean;
  learning(): LearningCapture;                    // the engine learning mode, file-backed (5.6 "Engine learning state")
  setLearning(mode: LearningMode | 'default'): LearningCapture;  // 'default' removes the key; returns what it replaced
  restoreLearning(captured: LearningCapture): LearningCapture;   // lands the capture, reads back, throws on mismatch
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

1. **prepare()**: create `openclaw/home`, `openclaw/state`, `openclaw/tmp`, `logs`. Adopt the wanted engine set
   (5.16), building it when absent: the stock set copies the kit's `engine/package.json` and `engine/package-lock.json`
   into a temporary set directory and runs `npm ci --ignore-scripts --no-audit --no-fund --prefix <tmp>` with env
   `{ PATH, HOME: openclaw/install-home, npm_config_cache: openclaw/npm-cache, OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL:
   '1' }`, timeout 300 s; state `installing`; failure → `failed/install`. Then verify the set's
   `node_modules/openclaw/package.json` version equals `ENGINE_VERSION`, else `needs-update/version` (never silently
   run another version). The entry is `<set>/node_modules/openclaw/openclaw.mjs`; `engineDir/node_modules` (an older
   kit's install) is never read, written or deleted. Token file `openclaw/token`
   (32 random bytes hex, 0600, created once). Port file `openclaw/port` (free loopback port chosen once; refuse 18789
   → `failed/port`). Write the bridge plugin (5.9) and reconcile config (5.6).
2. **start()**: before preparing or restoring credentials, inspect `openclaw/gateway.pid`. A live orphan may
   receive SIGTERM only after verifying the same user, executable, isolated cwd/HOME/state/config
   paths, a dead host lock owner and the launch identity in `openclaw/gateway.identity` (pid and Linux
   `/proc/<pid>/stat` field 22 start time). Record that identity before publishing `gateway.pid`, and recheck
   it immediately before signalling; the engine rewrites its process title, so command-line arguments are
   not an ownership proof. Missing or mismatched launch identity is ambiguous, including older live gateways.
   Wait at most 3 s for its exit. Ambiguous ownership, a live host or a
   shutdown timeout rejects with exported `EngineAlreadyRunningError` (`code: 'engine-already-running'`) and
   `failed/engine-already-running`, without modifying guards or state. On platforms without process identity
   verification, live pids are ambiguous. Dead pid guards are removed only under the acquired store lock.
   Then spawn `process.execPath <entry> gateway --port <port>` detached,
    cwd = isolated HOME, env = 5.5, stdout/stderr appended to `logs/openclaw.log` (0600); write the pidfile. Device
    identity `openclaw/device.json` (ed25519, created once when missing, 0600; the transport reads both the kit's
    `{ privateKey, publicKey }` shape and the Crewhouse legacy `{ deviceId, publicKeyPem, privateKeyPem }` shape, and
    never rewrites an existing file so an upgraded house keeps its keys). Connect the transport; wait up to 90 s for
   hello-ok, polling the child every 200 ms. Exit code 78 once → run `doctor --fix --yes --non-interactive` (60 s)
   with state `repairing`, relaunch. Other exit → `failed/exited`. Timeout → `failed/handshake`. Protocol ≠ 4 →
   `needs-update/version`. Then start the bridge socket; state `ready`.
3. **Crash**: on child exit while not stopping: drop the transport, state `restarting` with
   `retryAt = now + min(30 s, 1 s × 2^failures)`, then `start()` again; failures reset on a successful handshake.
4. **stop()**: stop transport; SIGTERM **each pid the kit itself spawned**, by pid and never a process group;
   wait 3 s; SIGKILL the same recorded pids; wait 3 s; await exit; close the bridge socket and delete it. The
   recorded list is the whole authority: every spawn (`npm ci`, the gateway) is entered when it starts and
   dropped when it exits, and a negative pid is never passed to `kill`. A group id belongs to whoever holds
   it once the kit's own child is gone, and it carries processes the kit never started — the gateway is left
   to shut its own sessions down on its own SIGTERM. Only the instance's child pid guard and acquired
   credential lock/state may be cleaned; failed-start cleanup and stop without ownership never acquire a lock
   to seal or delete state. State `stopped`.
5. `doctorContext()` returns the adopted set's entry and isolated env for an offline doctor run (migration).

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
- Auth isolation (5.15): `agents.defaults.authInheritance.agentId = 'byokit-base'`, an id the kit never creates or
  signs in to, so no agent reads another agent's sign-ins through.
- Subscription runtime: `agents.defaults.models['openai/*'].agentRuntime = { id: 'openclaw' }`; if
  `agents.defaults.modelPolicy.allow` is non-empty it gains `'openai/*'`.
- **No silent API billing** (Crewhouse #138): top-level and every `agents.entries[*].memory.search` →
  `provider` stays only if in `none|local|ollama|lmstudio|github-copilot` and, for ollama/lmstudio, `remote.baseUrl`
  host is loopback with no `remote.apiKey`; else `'none'`; `fallback: 'none'` always.
- Plugins: `plugins.load.paths` contains `<root>/plugin` (and no stale kit plugin path); `plugins.allow` contains the
  plugin id, the `plugin` id of every default-eligible bundled route in `routes.json` (`offerPolicy: 'default'`,
  no `needs.plugin`, so a route waiting only on its CLI and the explicit routes sharing its plugin work) (D17), and the
  `plugin` id of every route the app offers by name in `KitOptions.offered` (the provider, auth choice or alias a route
  carries — e.g. `openrouter`; a route nobody offers stays out); the kit adds no other id;
  `plugins.entries[id].hooks.timeouts.before_tool_call = 200_000`. The pinned
  engine treats a non-empty `plugins.allow` as a restrictive allowlist: a provider sign-in, and that provider's runs,
  need the bundled plugin that owns the route's auth choice (`Route.plugin`) in it, else the wizard ends
  `<label> is disabled (blocked by allowlist)`. Those plugins are always present (`anthropic` for `anthropic-cli` and `apiKey`); an app names the
  `plugin` id of any other route it signs in with (an unlisted plugin's route passed explicitly) in `KitOptions.offered`
  or directly through `config.plugins.allow` (merged with the kit's ids; 2026.8.1: `openai` for
  `openai`/`openai-device-code`, `xai` for `xai-oauth`, `github-copilot` for
  `github-copilot`/`github-copilot-enterprise`, `openrouter` for `openrouter-oauth`, `minimax` for
  `minimax-global-oauth`/`minimax-cn-oauth`); Crewhouse passes `offered(['chatgpt', 'grok', 'copilot', 'openrouter'])`
  and `plugins.allow: ['crewhouse', 'memory-core', 'openai']`. The kit never writes an empty list, nor one wider than
  app ids ∪ kit id ∪ those routes' plugins. A provider plugin also
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

#### One key, not the whole config (`getConfigKey` / `setConfigKey`)

`patchConfig` is the only whole-config writer and it can only start from a `config.get`, whose result redacts
token-bearing values; an app therefore cannot read one key and later restore it unchanged. `getConfigKey(key)` and
`setConfigKey(key, value)` are the narrow alternative, over the same `openclaw.json` file `prepare()` owns and the
engine loads at boot (`OPENCLAW_CONFIG_PATH`), with no Gateway round trip and no `config.get`:

- `key` is one dotted path of `[A-Za-z0-9_-]` segments, validated at the boundary; `__proto__`, `constructor` and
  `prototype` are refused, because the walk assigns into that path.
- `getConfigKey` returns the value, or `undefined` when the key is absent, as a copy.
- `setConfigKey` writes only that key, creating the missing objects on the way, returns the value it replaced, and
  takes `undefined` to remove the key, together with the empty objects that write created, so a removal lands the file
  it read. Every other key keeps its order; the file is rewritten atomically in `prepare()`'s exact shape
  (`JSON.stringify(config, null, 2) + '\n'`, 0600) and only when the bytes change.
- The engine applies the value at its next boot, so a running Gateway keeps what it applied. Do not interleave a
  narrow set with `patchConfig`: that one rewrites the whole config through the Gateway, last writer wins.
- Precedence stays 5.6's: `KitOptions.config` is merged over the saved file on every `prepare()`, so a key the app
  also passes in `config` belongs to that option, and the invariants above are re-forced at every boot. Narrow a
  key the app does not pass in `config`.

#### Engine learning state (`learning` / `setLearning` / `restoreLearning`)

The engine's learning switch is the config key `skills.workshop.autonomous.mode` (`'off' | 'propose' | 'auto'`;
engine default `'auto'` when the key is absent). `off` keeps only the suggestion nudge, `propose` creates pending
proposals, `auto` applies captured proposals and runs the scanner-gated cleanup that can rewrite or drop eligible
skills. The pinned engine hot-applies changes to it (reload-plan entry `skills.workshop.autonomous.mode`, action
`reconcile-skill-review-jobs`) and projects a system-owned cron job `skill-collection-review-<agentId>` per
workspace agent, enabled only while the mode is `auto`. Proposal records live in the engine state tree the kit
seals; applied skills live as files in `workspaces/<member>/skills/`, outside the seal.

The kit surface is a typed, validated veneer over `getConfigKey`/`setConfigKey` — the same file-backed narrow pair,
no Gateway round trip, valid before boot and after `stop()`. Types `LearningMode` (`'off' | 'propose' | 'auto'`)
and `LearningCapture` (`{ present: false } | { present: true; mode }`) are exported from `.`: absence is a value,
not "probably default".

- `learning(): LearningCapture` — `{ present: false }` when the key is absent, else `{ present: true; mode }`.
- `setLearning(mode: LearningMode | 'default'): LearningCapture` — writes the mode and returns the state it
  replaced; `'default'` removes the key, so the engine default (`auto`) applies again.
- `restoreLearning(captured: LearningCapture): LearningCapture` — writes the captured state (absence restores
  absence), reads the file back, returns `learning()`; a readback that differs from `captured` throws.

Error cases, all plain `Error`s carrying the real cause:

- `setLearning`/`restoreLearning` refuse a mode outside the enum, listing the accepted values (`off|propose|auto`
  plus `default` for `setLearning`): the engine itself falls back silently on an invalid stored value, so the kit
  must not let a typo quietly flip learning.
- `learning()` throws when the stored value is outside `off|propose|auto`, naming the actual value: corruption
  surfaces instead of silently meaning "default".
- Both writers throw at call time when the app also passes a `skills` key in `KitOptions.config`: that option is
  merged over the saved file at every `prepare()` and wins (the precedence rule above), so a narrow write here
  would be silently overwritten at the next boot. The key belongs to `config`, not to these methods.
- A state dir that was never prepared (`openclaw.json` absent) surfaces `setConfigKey`'s ENOENT: `prepare()`
  (or a first `start()`) once first.

A capture is one small value object; no config copy leaves the kit, and a restore writes exactly one key, so the
narrow pair's byte-exactness holds for every other key (and writes no bytes when nothing changes). Flipping
learning on a **running** home is out of scope here: `patchConfig` remains the whole-config writer, and the engine
hot-applies this key through it.

#### App-owned restart recovery (R1, binding 5.16)

`KitOptions.appOwnedSessions?: { keyPrefixes: string[] }` declares caller-owned task prefixes before the
Gateway starts, e.g. `{ keyPrefixes: ['agent:m1:crewhouse:'] }`. Omitted/empty retains stock recovery. Prefixes
must begin `^agent:[a-z0-9-]+:` and must not cover `agent:<member>:main`. Invalid public options fail before
preparing files. The kit also maps public-member prefixes to the app-managed API-key agent
(`byokit-key-<member>`), because keyed runs rewrite the engine session key (5.15). Arrays are copied.

The minimal environment passes validated JSON as `BYOKIT_APP_OWNED_SESSION_PREFIXES` (including `[]`, never
inherited from the person's shell or app `config.env`). Malformed raw engine env falls back to `[]` (stock).
The repo-pinned bundled patch changes only `isMainRestartRecoveryCandidate`, shared by startup marking and
dispatch admission. No synthetic recovery turn starts for matching keys; histories, files, session ids,
cancellation, run/tool gates, cron and stock retry/tombstone accounting remain intact. App foreground
continuation is admitted normally. An opted-out interrupted entry remains running with no recovery markers;
the app identifies interruption from running without a live run in this boot, not `abortedLastRun`.
Removing prefixes requires restart and restores stock eligibility without clearing markers or resetting
history. This is no task scheduler or global recovery disable. Installation/provenance belongs only to S1.

### 5.7 Sign-in, routes and retained-login migration

**Routes** (`src/routes.json`, O6): one entry per auth choice in the pinned tarball's provider contracts:
`{ "choice": "openai-device-code", "provider": "openai", "plugin": "openai", "billing": "subscription", "via": "code",
"prerequisite": null, "offer": true, "reason": "…", "source": "dist/provider-contract-api-*.js (2026.8.1)" }`.
Subscription choices are offered by default, including native `anthropic-cli`; `setup-token` is listed, never offered, because the pinned Gateway refuses it (no app-guided sign-in). API-billed choices, including `openrouter-oauth`, stay off until the app or person opts in.
Only proxy routes (`litellm-api-key`, `clawrouter-api-key`, `custom-api-key`), compatibility aliases,
local runtimes, `copilot-proxy` stay off. Billing labels distinguish subscription from
API key (billed per use); native `anthropic-cli` uses Claude Code in the isolated HOME. `routes()` returns the full table and
`routeFor(provider, via)` picks the first offered route. Each `plugin` names the bundled manifest owning
the choice; `via` is `code` for `appGuidedAuth: 'device-code'`, otherwise `browser`. Some offered routes
need a manual paste: the 2026.8.1 Gateway does not guide every pinned choice. The engine job
checks inventory and starts the routes the pin supports through its setup wizard.

**Target (D18, WPs B6 to B8).** The table grows to every auth choice in the pinned manifests (91 at 2026.8.1 with
the core `custom-api-key`). That includes the 55 choices whose plugins are not in the tarball (row `needs.plugin`,
installed only on an explicit call, B7), plus rows for the 5 providers configured without a choice (cloud or CLI).
Corrections to today's table: `minimax-global-oauth` and `minimax-cn-oauth` belong to manifest provider
`minimax-portal`; `anthropic-cli` reports provider `claude-cli` (from 0.7.0; the id `signedIn`, `providers()` and runs use for a Claude Code login), while its plugin, `upstream.id` and route id keep the manifest provider `anthropic` (`anthropic:cli:anthropic-cli`, the one row whose id prefix is not its `provider`, see the 2.1 exception). Its pre-0.7 provider `anthropic` is kept as `deprecatedProvider: 'anthropic'` through 0.8.x; 0.9.0 removes it and renames the id to `claude-cli:cli:anthropic-cli`. `anthropic` stays the API-billed provider: a Claude Code login never reports it; `opencode-go` is a plan
key (subscription); `microsoft-foundry-entra` is Entra cloud credentials, not an API key;
`alibaba-model-studio-api-key` comes from a video-generation plugin; `copilot-proxy` billing is unverified
(`unknown`). A sensitive wizard text step (`setup-token`) is answered from the paste channel without echo (B8).
Until those packages merge, the table above is what ships.

**signIn(member, { authChoice, via, signal? }, on)** — provider-owned wizard drive:
`ensureMember`; `openclaw.setup.auth.start { sessionId: 'byokit-' + uuid, agentId, authChoice }` (60 s); pull steps
only with `wizard.next` (120 s for ordinary steps, max 200 turns; never `wizard.status`); a `deviceCode` step,
or a `note` step whose text carries the code, → view `{ code, url, expiresAt?, message? }` then acknowledge
`{ stepId }`. That acknowledgment and subsequent progress pulls wait until
`deviceCode.expires_in` seconds (when supplied), otherwise the pin's `expiresInMinutes`; if neither is present,
the engine owns expiry and the request has `timeoutMs: null`. The caller's optional `signal` and handle's `cancel()`
release only this session. Code expiry yields `why: 'expired'`, cancellation `why: 'declined'`, with plain words.
Every `text` step → view `{ prompt }`, wait for `paste` (15 min), then answer `{ stepId, value }`. The rule
is the engine's own `sensitive` flag: a non-sensitive step is not a secret, so its `message` is the prompt as
written (`github-copilot-enterprise` asks for the Enterprise domain first); once any step is sensitive, or the
choice is `setup-token`, the prompt is the fixed `Sign-in token` label and no gateway prose is shown; `note|confirm|select|action` → surface `externalUrl`, acknowledge; `progress` → pull again.
Every exit short of done calls `wizard.cancel { sessionId }` for **its own** session. For `via: 'browser'` with
`authChoice` `openai`, the kit holds `127.0.0.1:<callbackPort>` for the sign-in's life: any request pastes
`http://<host><url>` into the wizard and answers a plain page (words key `signin.returned`); if the port is taken
the view fails with `why: 'busy'`. For ChatGPT browser/device sign-in, a gateway disconnect interrupts both local paste waits and in-flight wizard
requests. The kit's existing supervised reconnect remains the transport owner. Within 60 s of the disconnect,
read `models.authStatus { agentId, refresh: true }` on the live connection (20 s per read, 1 s retry). Only a
usable, unexpired OAuth profile for the selected agent/provider with an id absent from a known pre-start
readback can complete sign-in. Refreshing a pre-existing profile (including an expired one) is not proof of this
login; re-login to the same profile id must complete normally or fail closed after restart. Unknown readback,
pre-existing credentials, another provider, missing/pending
credentials, cancellation and expiry never count as success; timeout/error fails and releases only this session.
No credential files or tokens are read. Normal wizard completion and API billing labels are unchanged.
Mapping to `SignInView.why`: setup-admission-busy error → `busy`; person cancel →
`declined`; 200 turns or 15 min → `expired`; else `failed`. Errors are cut to 200 chars.

**providerStatus / signedIn / providers**: live readiness reads; see 5.8 for the usable-provider rule,
native Claude detection, unknown-status mapping and admission snapshots.
**signOut**: `models.authLogout { provider, agentId, profileIds }` with the agent's own profiles of that provider
(`byokit.accounts list`; from O14, 5.15). `signIn`, `signedIn`, `providers` and `signOut` address the
member agent, whose sign-in to a provider is that provider's first account (5.15); `addAccount` adds any further one.

**Credential sealing**: `authSeal` takes the `@byokit/secrets` `SealingAdapter` interface (non-interactive OS keyring with automatic persistent host-key fallback, or an explicit host-owned key),
the runtime kit delegates key management to that adapter. Opening follows the envelope mode, never the
adapter's current write mode. A locked or unresponsive keyring reports `KeystoreError('keyring-locked')`.
`prepare()` and `start()` resolve with `phase: 'locked'` and plain recovery words, without launching the
engine or changing the sealed snapshot; a later `start()` retries after unlock. Engine.start returns
`undefined` on this recoverable state, and the kit must skip connecting. A store the adapter cannot open
(`KeystoreError('auth-failed')`: a different key, damaged or tampered bytes) or whose authentic payload is not a
snapshot stays byte-identical at `auth-store.sealed`. `prepare()` and `start()` reject with the exported
`AuthStoreUnreadableError` (`code: 'auth-store-unreadable'`, reason `auth-failed` or `invalid-snapshot`)
and report `{ phase: 'failed', why: 'auth-store-unreadable' }`; no engine or sign-in starts.
Saved data over the seal cap rejects with `AuthStoreSealSizeError` and reports `{ phase: 'failed', why: 'auth-store-seal-size' }`;
the cap and refusal rules are owned by the OpenClaw README.
Never rotate a key or replace the snapshot as an automatic recovery. The host repair procedure is in
[OpenClaw's credential sealing guidance](../packages/openclaw/README.md#credential-sealing-and-threat-model).
Other sealing failures still reject.
Dual-wrap is explicit opt-in (`dualWrap: true`, default off) and weakens protection to the owner-only host
key file. SealingAdapter may expose `upgrade(data: Buffer): Uint8Array | undefined`; readers verify the
replacement decrypts to the same text, then atomically replace under their writer lock. With dual-wrap
on, reading a keyring-only store while unlocked upgrades it; failure leaves the previous store usable.
Successful reads adopt the store mode for writes. Locked dual updates reuse authenticated encrypted
wrapping metadata with fresh payload nonces; plaintext keys are not cached. The pinned engine has no supported OAuth persistence hook: it stores JSON in both
agent SQLite and the shared state SQLite database. The kit seals credential state into one bounded blob, `auth-store.sealed`, which is the only
store the cap applies to: every credential path under the isolated `state` tree and every config/credential path under `home`. Every other file under
`state` is sealed as its own file under `auth-store.objects/` (named by a hash of its path; the payload carries the path and the bytes) with the same
adapter and key; each object is capped individually at the same size, and their total is not capped: the shared and per-agent SQLite databases with their `-wal`/`-shm`/`-journal` sidecars (they mix credentials with
transcript rows), and the regenerable caches, exported transcripts, media, logs and legacy session stores beside them. Regenerable caches in `home`
(the `home/.cache` and `home/.npm` subtrees the engine environment pins, and the `sessions`/`log`/`cache`/`.tmp`/`history.jsonl` subtrees of `.codex` and
`projects`/`todos`/`shell-snapshots`/`statsig`/`file-history`/`history.jsonl` of `.claude`) stay on disk unsealed across stops; unknown `home` paths stay
sealed. Stop writes the blob and every object whose bytes changed since this process last sealed or restored it (an unchanged object keeps its sealed file), then removes the live `state` tree; start restores the blob, then the objects, byte for byte; no plaintext
copy of a sealed `state` file survives a stop or a remove. An object whose file is absent from the live tree at a stop is deleted. A v1 blob written before
this layout restores its engine stores and reseals them as objects at the next persist. The sealed payload is built exactly once and
verified by decrypting the sealed bytes. Snapshots are always written as `v: 1`, the only tag released readers through 0.6.1
accept, so a host rolled back to an earlier kit still opens its credentials; `v: 2` snapshots (written by 0.6.2) restore and re-seal as `v: 1`.
The engine databases are objects outside the blob, so a rollback to a kit older than this layout keeps the blob credentials but not the engine databases, and the user signs in again.
Pre-caches snapshots (whole trees) restore completely and re-seal once without their caches, with a log line; nothing is dropped. File symlinks are included only when their fully resolved
targets are regular files inside the isolated engine root; they restore as regular files at the link paths.
Outside-root, dangling and directory symlinks (including loops), sockets, FIFOs and devices are skipped.
`prepare()` seals existing plaintext stores and migration
archives; `start()` authenticates the sealed snapshot before restoring files (0600, directories 0700).
`stop()` waits for engine exit, writes and verifies a sealed snapshot atomically, then removes plaintext.
An offline migration doctor temporarily opens the same store and reseals it in `finally`. A sealing failure
rejects the operation rather than claiming stopped; the plaintext is retained for recovery. Abrupt host
termination cannot run cleanup: next prepare authenticates the previous snapshot before sealing the
remaining live files. Only one kit may own the sealed store at a time. Disabling the adapter on a sealed
store rejects; there is no silent plaintext fallback. Existing engine migration archives and retained
copies under `stateDir` are sealed with an event through `log`; sealed archives are never restored for
the engine. External retained sources are touched only when explicitly passed to migration/confirmation.

**Retained-login migration** (D15), Crewhouse `migrate`/`confirm` generalized:

- `migrateRetainedLogin(member, source)` must run **before** `start()` (doctor refuses while a Gateway owns the
  state). Source path: use `path`, else `path + '.moved-to-engine'` when no `.canonicalized` marker exists; nothing →
  `'nothing'`. `prepare()` first (never import without the engine). Stage `state/agents/<member>/agent/auth-profiles.json`
  (0600) as `{ version: 1, profiles: { '<provider>:default': credential } }` unless already staged; a `.moved-to-engine`
  source without `openai-codex` → `'nothing'`. Run doctor `--fix --yes --non-interactive` (120 s). Non-zero → delete
  the staging, return `'failed'` (the original stays byte-identical). Zero → `'staged'`. With `authSeal`, the staging and imported store are resealed before returning.
- `confirmRetainedLogin(member, source)` after `ready`: wanted providers = source keys mapped `openai-codex → openai`,
  else the provider map, else lower-case key; empty → `false`. Up to 3 × (`models.authStatus { agentId, refresh: true }`,
  1.5 s apart); all present → for a path source remove the verified original and any retained copy, and write the
  empty `.canonicalized` marker, return `true`. No plaintext archive is created. Record sources return `true` and the app deletes its own copy.
  Anything else → `false`, nothing moves; the next boot retries without a second sign-in.

### 5.8 Runs, members and streams

- `ensureMember(member)`: validate the id (D9); `agents.list`; if absent `agents.create { name: member, workspace:
  <root>/workspaces/<member> }`; cache.
- `run(spec, on)`: reject a `sessionKey` whose agent segment is neither `<member>` nor one of the member's account
  agents (member boundary, D9). Every run first finds the account its session is bound to (5.15). Register with the bridge
  unless `register === false`, with `spec.tools` as the run's subset (5.9); a `spec.tools` name outside
  `KitOptions.tools` is refused before any request. Subscribe to Gateway `agent` events filtered by `runId`:
  `stream === 'thinking'` with finite non-negative numeric `data.progressTokens` → `{ type: 'thinking', tokens }`;
  `stream === 'assistant'` with string `data.text` → `{ type: 'text', text }`; `stream === 'tool'` with string
  `data.name` and `data.phase` `start` → `{ type: 'tool', name, phase: 'start', id: data.toolCallId, input: data.args }`,
  `result` (the pin, O11) or `end` → `{ phase: 'end', id, output: data.result, error: data.isError }` (each field only
  when present with its type); the pin's `update`, `input_delta` and `review` phases are progress inside the pair and
  are not forwarded. Pin facts: the kit's `tool-events` cap makes the connection that sent `agent` a tool-event
  recipient, and that copy is never stripped by verbose level; `args` has its strings redacted, `result` text
  content is capped at 8000 characters by the engine. Request `agent { agentId, sessionKey, message,
  extraSystemPrompt, idempotencyKey: spec.idempotencyKey ?? uuid, attachments?, thinking?, provider?, model? }` with `expectFinal`: the
  interim `status: 'accepted'` frame names the run (its `runId` is taken as it lands) and emits `{ type: 'started' }`
  once, before subsequent stream events. Native lifecycle start does not double-emit; cached final/in-flight replays
  without an accepted frame do not invent a start. Acceptance is not completion. Then `agent.wait { runId,
  timeoutMs: 3_600_000 }` (client timeout 3_610_000) decides the end as before. `status === 'ok'` → final text event
  and `{ ok: true, text, usage?, planWindow? }`. Silent/empty terminal dispositions produce empty text. Otherwise
  text comes from string `result.payloads[].text` fields in the `agent` final frame, joined in order with two
  newlines (including explicit empty strings); absent payload text falls back to the last assistant stream
  text, then terminal text, then empty text. The terminal snapshot is sanitized and capped at 4096 characters
  by the pin, so it must not supersede complete generated text. Final callback, schema validation and RunEnd
  use the same selected text; streaming stops before that final callback. `usage` is the `agent` request's final
  frame `result.meta.agentMeta.usage` (the pin sums every model call of the run, compaction included, and omits zero
  buckets), renamed `reasoningTokens → reasoning`, plus `agentMeta.costUsd` when the engine priced the model; the
  kit waits at most 5 s for that frame after the wait says ok, and no frame or no usage is no `usage`. `planWindow`
  is the `models.authStatus { agentId }` row for `agentMeta.provider` when its `usage.windows` lists at least one
  window (`{ label, usedPercent 0-100, resetAt? epoch ms }`, `usage.plan`): the engine's own cached read of the
  provider's usage endpoint (subscription OAuth only, 60 s cache), never estimated by the kit; the pin reports no
  window per run, on `agent.wait` or on any agent event.
  `stopReason === 'aborted'` → `{ ok: false, aborted: true }`; the engine's own abort receipt is
  `status: 'error', stopReason: 'rpc'` with the run's lifecycle end carrying `aborted: true` (O11), so a
  non-ok receipt on a lifecycle-flagged run also ends `{ ok: false, aborted: true }`;
  else `{ ok: false, ...classify(message) }`.
  Always unsubscribe and unregister.
- Host `RunSpec.idempotencyKey` is optional; absent means a new UUID, preserving legacy behavior. A supplied key
  must be a non-empty string (the pin's `NonEmptyString`); the kit does not trim or rewrite it. The app mints and
  persists one globally unique nonce **per dispatch action**, for example `task:<id>:attempt:<n>:<uuid>`, then
  retries that action with identical session, member, message, model, system, images, tools and schema. A task id
  alone must not collapse distinct attempts/actions. The engine uses the key as `runId`.
  In 2026.8.1 the cache key is `agent:<idempotencyKey>` across the gateway, **not per agent/session/connection**;
  `chat.send` has a separate method namespace. Inputs are not compared: a valid differing-input collision returns
  the first run's cached answer/error, even for another agent. Preflight/schema failures may happen before lookup
  and are not a durable cached execution. Never reuse keys between members or actions.
  Cached accepted runs replay one `in_flight` response, not a new accepted/final subscription. The helper waits
  on that run and uses the existing stream/terminal fallback: previously emitted events are not replayed, the
  terminal snapshot is capped at 4096 characters, and usage is absent without a final frame. Truncated JSON may
  fail schema validation. Completed cache replays carry the full final payload/usage if the engine has it.
  The helper deliberately does **not** issue another `agent` request to retrieve a final: it is not a read-only
  lookup and could dispatch anew on a cache miss. Complete in-flight reattachment would require an engine
  read-only final-result API or a final-response subscription; the pin exposes neither through `agent.wait`.
  No exactly-once claim is made.
  Cache entries survive transport reconnects, not process restarts: the gateway owns an in-memory Map. Its
  maintenance tick (60 s) drops inactive entries older than 300,000 ms and trims oldest inactive entries above
  1,000 entries (active runs and future-expiring pending accepted reservations are exempt). Thus five minutes is
  not a guaranteed retry window under pressure. Cached success/failure replays the prior payload/error without
  comparing new input; do not retry after expiry/eviction/restart assuming dedupe. App task ownership and durable
  effect/recovery bookkeeping remain the app's. Pin sources: `principal-CA42B2iA.js` (`resolveAgentDedupeKeys`,
  `replayAgentTurnIfCached`), `server-maintenance-NppRBWD2.js`, `server-constants-DKuFNbQH.js`; acceptance:
  `test/engine/idempotency.test.ts` (real engine + scripted provider, accepted → close → reconnect → same-key
  retry; one run/provider dispatch, honest missing usage, cross-agent collision, different nonce, cached error,
  restart).
- Offered subscription and direct API-key accounts use the same explicit per-run model selection;
  a selected subscription never silently falls back to an API key (billed per use).
- `spec.model` (`provider/model`) picks the account a run is called and billed on. It is refused before any request
  if it is not `provider/model` or carries an `@profile` pin. Before the run, `models.authStatus { agentId }` (once
  more with `refresh: true` while it answers `unavailable`) must list the provider (lowercased, as the engine
  normalizes ids; a bare string row, or a row with a profile `ok`/`expiring`/`static`, is signed in), else the run ends `{ ok: false, kind: 'signed-out' }` without calling the engine. The
  check may reuse a positive snapshot from this kit's `providerStatus`/`providers`/`signedIn`, device `oc.state`,
  or previous run, scoped by exact agent
  and native-Claude detection mode, for at most 30 s from check start and never beyond reported expiry of a
  usable (`ok`/`expiring`/`static`) profile. Unusable profiles do not cap reuse. Fresh native readiness also
  prepares the underlying non-native provider snapshot, even without Claude credentials; synthetic Claude
  readiness never supplies ordinary profile authority.
  Public readiness/sign-in queries themselves stay live: they prepare a snapshot, never reuse one.
  `providerStatus` preserves unknown status as `undefined` for device state; `providers` maps it to `[]` and
  `signedIn` maps it to `false`.
  Every reuse stats only app-owned config/profile/CLI-auth file metadata; a changed or unreadable witness rechecks.
  Missing/unknown status is never reused. Refresh bypasses reuse. Disconnect/start/stop, auth/setup/wizard/config/
  agent/secret mutations and key replacement invalidate (before and after mutation); engine signed-out failures
  invalidate too. No agent request runs in parallel with an unfinished admission check. Native Claude still asks
  engine `setup.detect`; local snapshots do not prove remote revocation, whose actual run error stays signed-out.
  The split ref is sent as the `agent` request's per-run `provider`/`model` (pin `AgentParamsSchema`; needs `operator.admin`,
  which the kit holds). An explicit provider/model is strict: the engine reports failure instead of falling back to
  another provider or model, and nothing is persisted on the session (pin `docs/concepts/model-failover.md`
  "explicit user selections ... are strict"). An `@profile` auth-profile pin is not offered: the pin only takes one
  as a session preference (`sessions.patch` `model: 'p/m@id'`) that may rotate to another profile of the same
  provider on rate limits, auth failures or timeouts (same doc), so which profile is billed cannot be guaranteed.
  The member agent holds at most one view per provider, so without `spec.account` the provider names exactly one
  account; every further account is its own agent holding a scoped view of the shared grant (5.15).
  Absent, the request is unchanged and the engine uses its own selection.
- API keys are opt-in, labelled **API key (billed per use)**, and every API route retains `offer: false`.
  `addKey(member, { authChoice, apiKey })` uses typed `openclaw.setup.activate` with `kind: 'api-key'` only.
  It returns `ok | invalid | not_included`, never engine lines, errors or credentials. Only routes whose pinned
  manifests allow manual secrets for text inference expose `keyEntry`; every route carries `revision` and `checked`.
- The engine has no strict per-run auth-profile pin. Key isolation is by agent: a member's normal agent never
  receives a key from `addKey`. A reserved `byokit-key-<member>` agent has its own workspace and credential store;
  the `byokit-key-` prefix is not a member id. Its key is `copyToAgents: false`. The plugin seals the local store
  to exactly the selected key and a local auth order containing only that profile; no shared/global order is mutated.
  The normal agent's local order lists only its OAuth sign-ins, excluding paid keys. The pin prunes empty
  local orders on save; with no sign-ins the normal agent's store contains no key profile to try. The normal agent's model selection and auth pin are unchanged by activation on the key agent. If the normal
  store already contains an API key from pass-through calls, adding a key is refused without deleting it.
- `RunSpec.auth: 'apiKey'` explicitly routes to that member's key agent and its selected model. Key runs keep
  separate session history (`agent:byokit-key-<member>:...`) and app tool gates still see the original member.
  A missing, removed or unsealed key fails with a plain `signed-out` result before an engine run. Removal leaves
  no eligible fallback profile. Key replacement and key runs are serialized per member. `steer` and `abort` take the same optional
  `{ auth: 'apiKey' }` to address that separate history (host and device). A supplied model must
  equal the selected key model; it cannot choose another provider. Ordinary runs never enter the key agent.
  `addKey` invalidates the old key before checking a replacement; a failed replacement leaves the key option
  unavailable. Key entry and its result are represented by the framework-free `ui/kits` key card view.
- `classify(message)` (`src/classify.ts`) = Crewhouse `classifyText` mapped `rate_limit|overloaded → resting`,
  `signed_out → signed-out`, `not_included → plan`, `network → network`, `null → other`, with `until` carried.
- `steer` → `sessions.steer { sessionKey, message }`; `abort` → `chat.abort { sessionKey }`.
  Cancellation failure handling follows the [OpenClaw usage contract](../packages/openclaw/README.md#quickstart);
  healthy cancellation retains the aborted run result defined above.
- Streams: `onEvent` delivers every Gateway event (typed); the link adapter filters by member (7.1).

### 5.8.1 Structured output

`RunSpec.schema` is an app-supplied JSON Schema object in the kit's supported subset (`OutputSchema`).
`run<const S>(spec: RunSpec<S>)` returns `RunEnd<SchemaOutput<S>>`; successful schema runs include `data`,
inferred from literal types, object properties/required keys, arrays and enums. Dynamic schemas yield unknown.
The portable device run takes the same schema and returns the same typed end over `oc.run`.

The pinned `agent` protocol has no general output-schema parameter. Its `swarmOutputSchema` belongs to swarm
collectors and is not a general run contract. The kit appends a JSON-only instruction and the schema to the
per-run `extraSystemPrompt`, preserving the caller's system text, and validates the final cumulative text locally.
It never calls a provider directly, switches sign-in routes, enables API billing, or retries a model call.
Partial text events remain unvalidated. Invalid JSON or a schema mismatch ends `kind: 'output'`, with a fixed
message that never contains the answer; it never returns an unvalidated `data` as success. Usage and quota windows
are preserved on a successful result. Engine failures and aborts retain their existing outcomes.

Supported keywords: `type` (including nullable type arrays), `properties`, `required`, `additionalProperties`,
`items` (one schema), `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `not`, `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `uniqueItems`,
`minProperties`, `maxProperties`, plus `title`, `description`, `default`, `examples` and the draft-07 `$schema`
annotation. Other keywords (including references, formats and patterns) and malformed schemas are refused
before member creation or a Gateway request; they are never silently ignored. The schema is snapshotted before
account readiness or the run and limited to 64 KiB and 32 nested schemas. The facade passes that prepared
snapshot to `createRuns` so an explicit API-key readiness await cannot change its constraints. Validation neither coerces values nor fills defaults.
App-specific business checks belong in the app after the validated result.

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
and an allow gets neither permit nor ticket, and a `call` for a name outside `tools` is refused. `register(run,
tools?)` adds one registration with the run's subset (`RunSpec.tools`) and returns its release; a key stays registered
until its last run releases (permits and tickets go with it). Runs sharing a key share the narrowest subset: a gate for
an app tool missing from any live subset is denied before `host.gate` (builtins are unaffected). The pin's `agent` params have no per-run tool list (closed schema), so the model still sees
every tool; the gate is the enforcement. `prepare` rewrites
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
  to `openai`; `agent` (returns `{ runId, status: 'accepted' }`, emits `agent` events: one assistant text
  `fake: <message>` and, for a message `[tool NAME {json}]`, a tool `start`/`result` pair shaped like the pin's
  (`toolCallId` `call-<n>`, `args`; `result: { content: [{ type: 'text', text }] }`, `isError`) after calling the kit's
  bridge like the plugin does; with `expectFinal` the accepted frame goes to `onAccepted` and the request settles with
  the pin-shaped final frame, `result.meta.agentMeta { provider, model, usage }`, usage counted in characters);
  `agent.wait` (resolves `{ status: 'ok', terminalReply: { text } }`); `sessions.steer`; `chat.abort` (makes the
  pending wait resolve `{ status: 'error', stopReason: 'rpc' }` with a lifecycle end carrying `aborted: true`
  (O11: the engine's abort shape, which `runs.ts` maps back to aborted); `config.get`/`config.patch` (hash check,
  and the engine's ownership rule: a merged multi-agent roster without `agents.ownership: 'explicit'` is
  rejected, so the kit writes what the engine normalizes);
  `exec.approval.resolve`/`plugin.approval.resolve`/`question.resolve` (emit the matching `*.resolved`).
- `openclawContract(make: () => Promise<{ kit: OpenClawKit; model?: ModelStub }>)`: registers `node:test` cases for
  hello/method cross-check, member creation, member boundary refusal, device-code sign-in happy path and cancel,
  a run with text streaming, a tool call gated `ask` → approve → result, gated deny, abort, native exec approval
  round-trip, `call` pass-through for `health`, config invariants after `patchConfig`.
- `startModelStub(script, o?)` = Crewhouse `test/openclaw-stub.ts` (script grammar unchanged: `[tool NAME {json}]`,
  `hit the limit`, `no helpers in plan`, `sign me out`, `ask permission`, `[route ID]`; a reply asked
  `stream_options.include_usage` ends with a `STUB_USAGE` usage chunk, as OpenAI does) plus `useModelStub(kit, stub)` =
  Crewhouse `configureModelProvider` (provider id `byokit-stub`, model `test`). The bot id the stub reports comes
  from `o.idPattern` (default `/Your id is ([a-z0-9-]+)\./`) and routing requests start with `o.routingMarker`
  (default `'[routing]'`); Crewhouse passes its own grammar explicitly. Tool results count from the message the
  script came from (O11): the engine appends runtime-context user messages after each tool result, so counting
  from the last user message replays the first scripted call forever.

### 5.12 Version pin and upgrades

The pin is `ENGINE_VERSION` + `engine/package-lock.json` + exact client/protocol deps. An upgrade is one PR in
byokit: bump all four, re-run `npm run gen:openclaw`, review `report.json` and the method/event diff (listed in the
PR), re-verify `routes.json` choice ids, run `npm run test:engine` green, bump the kit's minor version, CHANGELOG
lists added/removed methods. Consumers upgrade the kit, never the engine directly. An installed engine whose version
differs from `ENGINE_VERSION` is `needs-update`; `prepare()` then builds and adopts the set for the current pin
(5.16), never touching `openclaw/state`, an existing set or `engineDir/node_modules`.
A pin bump also re-derives `engine/patches.json` from the new stock bytes (anchors may move and hashed file names
change; a stale set fails `before` and blocks release), re-checks that the Gateway-covered kinds of 5.16 still hold
(the review stays out of `sessions.usage`, recovery and flush stay in it), and re-runs the O15–O17 engine tests.

### 5.13 Internal module seams (stub signatures for O1)

```ts
import type { Account, AccountId, AccountPick, Considered, Defaults, ModelInfo, PickWhy, Room, RunSelection } from '@byokit/accounts';
import type { AccountView, Approval, Decision, GatewayTransport, KitState, KitOptions, Member, OutputSchema,
  RetainedLogin, Route, RunEnd, RunEvent, RunRef, RunSpec, SchemaOutput, SignInView, ToolHost, ToolSpec,
  WordKey } from '@byokit/openclaw';
declare function outputSchema(value: unknown): { prompt: string; parse(text: string): { data: unknown } | undefined };
type MoveResult = { ok: true; session: string } | { ok: false; code: 'too_early' | 'busy' | 'unsupported' |
  'env_mismatch' | 'close_failed' | 'start_failed'; message: string; live?: string };   // 5.15
interface OpenClawKit {   // 5.3 signatures; the built kit has addKey only until O14
  addKey(member: Member, o: { authChoice: string; apiKey: string; name?: string }): Promise<'ok' | 'invalid' | 'not_included'>;
  addAccount(member: Member, o: { authChoice: string; via?: 'browser' | 'code'; name?: string; again?: AccountId },
    on: (v: SignInView) => void): Promise<{ id: AccountId; paste(text: string): void; cancel(): void;
    done: Promise<{ view: SignInView; id: AccountId }> }>;
  renameAccount(member: Member, id: AccountId, name: string): Promise<Account>;
  removeAccount(member: Member, id: AccountId): Promise<void>;
  models(member: Member, id: AccountId): Promise<ModelInfo[]>;
  room(member: Member, id: AccountId, demand?: string[]): Promise<Room>;
  defaults(member: Member): Promise<Defaults>;
  setDefaults(member: Member, d: Defaults): Promise<void>;
  pick(member: Member, sel: RunSelection, o?: { sessionKey?: string }): Promise<AccountPick>;
  move(ref: RunRef, to: AccountId): Promise<MoveResult>;
}
// engine.ts (O3)
export type EngineOptions = Pick<KitOptions, 'stateDir' | 'engineDir' | 'npmPath' | 'enginePath' | 'config' | 'appOwnedSessions' | 'installPolicy' | 'log' | 'bridge'>
  & { pluginId: string; tools: ToolSpec[]; spawnEngine: boolean; onState(s: KitState): void; onExit(code: number | null): void };
export declare class Engine {
  constructor(o: EngineOptions); readonly root: string; readonly bridgeSock: string;
  prepare(): Promise<void>;
  start(): Promise<{ port: number; token: string; identityPath: string } | undefined>;   // undefined while credentials locked
  stop(): Promise<void>;
  doctor(timeoutMs: number): { status: number | null };                      // offline doctor --fix run
  doctorContext(): { entry: string; env: Record<string, string> };
}
// config.ts (O3)
export declare function reconcileConfig(saved: object | undefined, o: { root: string; stateDir: string; port: number;
  pluginId: string; pluginDir: string; policyPath: string; app?: object; installPolicy?: KitOptions['installPolicy'] }): object;
export declare function memoryLimited(config: object, member: Member): boolean;
// transport.ts (O4)
export declare function gatewayTransport(ctx: { port: number; token: string; identityPath: string; bridgeSock: string }): GatewayTransport;
// members.ts (O4)
export declare const MEMBER_ID: RegExp;
export declare function createMembers(ctx: { request: GatewayTransport['request']; root: string }): { ensure(member: Member): Promise<{ agentId: string; workspace: string }> };
// bridge.ts (O5)
export declare function resolveBridge(o?: { socketName?: string; paramPrefix?: string }): { socketName: string; paramPrefix: string };
export declare function writePlugin(dir: string, o: { id: string; tools: ToolSpec[]; paramPrefix: string;
  gateBuiltins: boolean }): void;
export declare class Bridge {
  constructor(o: { path: string; host?: ToolHost; tools: ReadonlySet<string>; permitted: (tool: string) => boolean; approvalTimeoutMs: number;
    onAsk(a: Approval): void; onAskGone(id: string): void });
  start(): Promise<void>; stop(): void;
  register(run: RunRef): void; unregister(sessionKey: string): void;
  allowOnce(rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean }, ms: number): void;
  disallowOnce(): void;
  resolveAsk(id: string, d: Decision): boolean;
}
// approvals.ts (O5)
export declare class Approvals {
  constructor(o: { request: GatewayTransport['request']; bridge: Pick<Bridge, 'resolveAsk'> });
  handleEvent(e: { event: string; payload?: unknown }): void; add(a: Approval): void; remove(id: string): void;
  list(member?: Member): Approval[]; on(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void;
  decide(id: string, d: Decision): Promise<void>;
}
// signin.ts (O6)
export type SignInCtx = { request: GatewayTransport['request']; ensure(member: Member): Promise<{ agentId: string }>; callbackPort: number };
export declare function signIn(ctx: SignInCtx, member: Member, o: { authChoice: string; via?: 'browser' | 'code' },
  on: (v: SignInView) => void): { paste(text: string): void; cancel(): void; done: Promise<SignInView> };
export declare function providers(ctx: SignInCtx, member: Member, refresh?: boolean): Promise<string[]>;
export declare function signOut(ctx: SignInCtx, member: Member, provider: string): Promise<void>;
// routes.ts (O6)
export declare function routes(): Route[]; export declare function routeFor(provider: string, via: 'browser' | 'code'): Route | undefined;
// migrate.ts (O6)
export type DoctorRunner = () => { status: number | null };
export declare function migrateRetainedLogin(ctx: { root: string; prepare(): Promise<void>; doctor: DoctorRunner }, member: Member,
  source: RetainedLogin): Promise<'staged' | 'nothing' | 'failed'>;
export declare function confirmRetainedLogin(ctx: SignInCtx, member: Member, source: RetainedLogin): Promise<boolean>;
// runs.ts (O8)
export declare function createRuns(ctx: { request: GatewayTransport['request']; onEvent: GatewayTransport['onEvent'];
  ensure(member: Member): Promise<{ agentId: string }>; bridge: Pick<Bridge, 'register' | 'unregister'> }):
  { run<const S extends OutputSchema | undefined = undefined>(spec: RunSpec<S>, on?: (e: RunEvent) => void, keyAgent?: string,
      preparedOutput?: ReturnType<typeof outputSchema>): Promise<RunEnd<SchemaOutput<S>>>; steer(k: string, t: string): Promise<void>; abort(k: string): Promise<void> };
// locks.ts (O14)
export declare function createLocks(): { shared<T>(agentId: string, work: () => Promise<T>): Promise<T>;
  exclusive<T>(agentIds: string[], work: () => Promise<T>): Promise<T>; live(agentId: string): boolean };
// accounts.ts (O14)
export declare function createAccounts(ctx: { request: GatewayTransport['request']; root: string;
  ensure(member: Member): Promise<{ agentId: string; workspace: string }>; signIn: SignInCtx;
  locks: ReturnType<typeof createLocks> }): {
  bind(member: Member, sessionKey: string): Promise<{ agentId: string; id?: AccountId } | undefined>;   // id absent: member agent
  memberOf(agentId: string): Member | undefined;                // attribution for approvals, bridge, link
  addKey: OpenClawKit['addKey'];
  list(member: Member): Promise<Account[]>; agentOf(member: Member, id: AccountId): Promise<string | undefined>;
  add: OpenClawKit['addAccount']; rename: OpenClawKit['renameAccount']; remove: OpenClawKit['removeAccount'];
  models: OpenClawKit['models']; room: OpenClawKit['room']; defaults: OpenClawKit['defaults'];
  setDefaults: OpenClawKit['setDefaults']; pick: OpenClawKit['pick']; move: OpenClawKit['move'];
  ready(agentId: string, provider: string): Promise<boolean>; rest(member: Member, id: AccountId, until: number): Promise<void> };
// runs.ts gains `accounts: ReturnType<typeof createAccounts>` and `locks` in createRuns' ctx (O14).
// pick.ts (O14; pure, portable)
export type RoomOf = (a: Account, demand: readonly string[]) => Room;
export declare function consider(accounts: readonly Account[], defaults: Defaults, sel: RunSelection, room: RoomOf,
  nowMs: number, models?: (a: Account) => readonly ModelInfo[], bound?: readonly AccountId[]): Considered[];
export declare function chooseAccount(candidates: readonly Account[], room: (a: Account) => Room, nowMs: number):
  { account: Account; why: PickWhy } | undefined;              // Auto only; resolveSelection builds the AccountPick
export declare function resolveSelection(accounts: readonly Account[], defaults: Defaults, sel: RunSelection,
  room: RoomOf, nowMs: number, models?: (a: Account) => readonly ModelInfo[], bound?: readonly AccountId[]): AccountPick;
// classify.ts (O8)
export declare function classify(message: string): { kind: 'signed-out' | 'resting' | 'plan' | 'network' | 'other'; until?: number };
// words.ts (O10)
export declare function words(key: WordKey, vars?: Record<string, string>): string;
export declare function stateWords(s: KitState): string;
export declare function toAccountView(view: SignInView | null, ready: boolean): AccountView;   // AccountView = ui's shape, declared locally
// notices.ts (O9; portable)
export declare function sealNotice(a: Approval, boxPublicKey: Uint8Array): { v: 1; sealed: string };
export declare function openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null;
```

### 5.14 Words (`src/words.json`, O10)

| Key | Sentence |
|---|---|
| `engine.installing` | Getting things ready on this computer. The first time takes a few minutes. |
| `engine.starting` | Starting up… |
| `engine.repairing` | Fixing a small problem with the setup. This takes a moment. |
| `engine.locked` | Your saved sign-in is locked. Unlock your password storage, then try again. |
| `engine.signInAgain` | Your saved sign-in couldn't be opened, so it was kept aside. Sign in again. (legacy state) |
| `engine.authStoreUnreadable` | Your saved sign-in couldn't be opened. It is unchanged. Restore its original key or a working backup, then retry. |
| `engine.ready` | Ready. |
| `engine.restarting` | Something stopped. Starting it again by itself. |
| `engine.alreadyRunning` | Your saved sign-in is in use. Try again after the other session stops. |
| `engine.failed` | This computer couldn't start the helper. Restart the app to try again. |
| `engine.needsUpdate` | This app needs an update to keep working. |
| `member.signedOut` | Sign in with {name} to start. |
| `member.resting` | {name} needs a break until {time}. |
| `member.plan` | Your {name} plan doesn't include this. |
| `member.output` | The answer did not match the requested format. |
| `member.network` | Can't reach {name} right now. This keeps trying by itself. |
| `signin.returned` | Thanks. Finishing the sign-in — you can go back to the app now. |
| `signin.busy` | Another sign-in is already in progress. Finish or cancel it, then try again. |
| `signin.cancelled` | Sign-in cancelled. You can start again whenever you are ready. |
| `signin.expired` | The sign-in took too long. Start it again. |
| `approval.ask` | {helper} wants to {summary}. Allow it? |
| `approval.expired` | Nobody answered in time, so this wasn't allowed. |
| `approval.notice` | Something is waiting for your yes. |
| `link.notAllowed` | This device can't do that. Ask the person at the computer. |

`words(key, vars)` fills `{name}`, `{time}`, `{helper}`, `{summary}`; `stateWords(state: KitState)`;
`toAccountView(view: SignInView | null, ready: boolean): AccountView` produces `@byokit/ui`'s `AccountView`
shape so `useSignIn`/`phaseOf` work unchanged (`why` maps 1:1; `busy`, `declined`, `expired` are ui's).

### 5.15 Accounts: one shared grant, one view per account (D17)

A member connects every subscription and API key they have, several per provider, and each run uses one account and
one model. The pin decides the shape (section 12): the `agent` request has no auth-profile field; an explicit
`provider`/`model` still rotates between that provider's profiles inside one agent; every agent reads the inherited-auth
owner's profiles through unless its own local order for the provider says otherwise; and `models.authStatus` reports
the merged store with no source flag and no per-profile identity. So an account is an agent holding a scoped view of one shared
sign-in (`viewStore`), never a separately sealed copy of the credential.

**Types** (`src/types.ts`; restated structurally from `@byokit/accounts` `multi.ts`, never imported; the ui
`fits` test checks both against its own copy). `AccountPick` is `@byokit/accounts`' `Pick`, renamed here because the
kit's modules use TypeScript's `Pick<T, K>`:

```ts
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
      considered: Considered[] };        // bound/paid: Runs step 2's refusals, reason its `account.*` words
export type MoveResult = { ok: true; session: string } | { ok: false; code: 'too_early' | 'busy' | 'unsupported' |
  'env_mismatch' | 'close_failed' | 'start_failed'; message: string; live?: string };   // shared with @byokit/herdr
```

`Room.at` optional, `RunSelection.needs`, `RunSelection.provider` (the respond-select slice), `Considered`, `PickWhy` and `AccountPick.why`/`considered` are amendments to
`@byokit/accounts`' `multi.ts` shapes and its Auto fixture: they land there first (fixture rows first), then O14 restates
them, and the ui `fits` test checks both. The failure codes `'bound' | 'paid'` and `Considered.out: 'bound'` are
kit-only (sessions bind to accounts only here): `@byokit/accounts` never returns them, and `fits` checks the accounts
shapes against the kit's with those members added.

**Isolation.** 5.6 forces `agents.defaults.authInheritance.agentId = 'byokit-base'`: a reserved id the kit never
creates, signs in to or runs, so the inherited base every agent reads through is empty. Without it the pin makes the
first agent the owner when the fleet grows past one, and every later agent (other members too) reads that agent's
sign-ins. `models.authLogout` and sign-out always pass `profileIds` of the agent's own sealed profiles, because
without them the pin removes the provider's profiles from every owner store. O14's engine job proves both; if the pin
refuses the value, O14 stops and asks. (After 5.7's doctor moves a legacy store into `state/openclaw.sqlite`, that
shared store is the base instead; the kit never writes it either.) This is a behavior change for installs with two or
more members: the pin had pinned the owner to the first member, so later members read its sign-ins through; from
O14 a member runs only on its own sign-ins, and one that never signed in reads `signed_out` (CHANGELOG entry).

**Where an account lives.**

- The member agent (`agentId = member`, 5.8) is the first account of every provider it holds a local profile of, id
  `<provider>`. Its own sign-ins, sessions and `signIn`/`signOut` calls keep working; nothing migrates (sign-ins it
  only read through another member's agent stop applying, Isolation above). It never
  holds an API key, and it holds at most one sign-in per provider (a second `signIn` to the same provider replaces
  the first when sealed).
- Every further account is agent `<member>--<hex6>` (6 random lowercase hex digits; drawn again when that id exists),
  id `<provider>.<hex6>`, created with `agents.create { name: '<member>--<hex6>', workspace: <the member's workspace> }`
  (the engine derives the id from `name`; the kit checks the returned `agentId`). The pin rewrites the shared
  workspace's `IDENTITY.md` Name line on create, so the kit reads that file on the member agent before
  (`agents.files.get`) and writes it back if changed (`agents.files.set`). All of a member's accounts share the
  member's workspace (files, memory, skills); only credentials and session history are per account. The first account
  agent turns the fleet `agents.ownership: 'explicit'`; every kit request already names its `agentId`.
- `<root>/accounts/<member>.json` (0600, written whole through a temp file and rename) is the only kit state:
  `{ v: 1, accounts: { [id]: { agent, name, route, addedAt, until?, model?, who? } }, defaults: Defaults }` (`model`
  only for an API key: the model saved with it; `who` the sign-in identity from `seal`, Sealing, kept after a sign-out
  so a later sign-in can be matched). It holds no credential, token, email or engine line. An entry is written
  before its agent is created, so an agent is one of the member's accounts **only** when the member's index names it
  and its id is exactly `<member>--[0-9a-f]{6}`; an unindexed agent of that shape is never listed, and an entry whose
  agent and `<root>/state/agents/<agent>` directory are both gone is dropped on the next write (an entry whose
  directory remains is finished by `removeAccount`). A member-agent account with no entry (signed in before O14) gets one on
  first list: `addedAt: 0`, `route` = `routeFor(provider, 'browser')`, else the provider's first pinned subscription
  choice, `who` from `byokit.accounts list`.
- `accounts(member)` lists member-agent accounts first (by `addedAt`, then provider id), then account agents by
  `addedAt`. The member agent's accounts come from `byokit.accounts list` (its own store), never from
  `models.authStatus` (merged). `state`: `signing` during its sign-in; `resting` while `until > now`; else from its
  local profile: `ready` for a usable one, `needs_again` when expired, `signed_out` when missing; `not_included` when
  its route is no longer in `routes.json`.

The TypeScript identity boundaries are recorded in `fixtures/conformance/identity-reauth-typescript.json`:
wrong-account re-auth is refused, duplicate nonblank provider identities use the canonical account, a changed
email alone does not change identity, and absent identity never merges accounts by email. Identity is scoped
by member/provider. The fixture's adoption actions belong to the sealed engine integration; portable chooser
tests exercise the host-validated records, and canonical-store tests cover removal races and extension fields.

**Sealing** (`plugin/accounts.js`, gateway method `byokit.accounts`, `operator.admin`, loaded by `plugin/index.js`,
using the plugin SDK's `resolveAgentDir` and local-only `updateAuthProfileStoreWithLock`; every failure answers
`{ ok: false }`, and no answer carries a secret):

- `list { agentId }`: the agent's own profiles as `{ provider, profileId, type, status, who? }[]`. `who` (also on
  `seal` and `ready` answers) is the sign-in's identity: for an OAuth profile that stores a provider account id (the
  pin's `OAuthCredential.accountId`; its ChatGPT sign-in fails without one), the first 16 hex digits of SHA-256 of
  `<provider>\n<accountId>`, computed in the plugin, so the id itself never leaves the engine. No such id, or an
  `api_key`/`token` profile, → no `who`.
- `seal { agentId, provider }`: the profile to keep is the one named after `@` in `agents.entries[agentId].model`'s
  primary (the pin's sign-in sets it to `provider/model@<new profile id>`); no such suffix, or a different provider →
  `{ ok: false }`; else `{ ok: true, who? }`. The agent's store keeps only that profile of `provider`, `order[provider] = [it]`, `lastGood`
  cleared for it; on an account agent every other provider's profile is removed too; on the member agent an
  `api_key` profile is refused. Run after every finished sign-in and key activation. A member-agent provider signed in
  before O14 (no local order) is sealed on its first use as an account when it has exactly one local profile of that
  provider; with several and none named by the model, its `state` is `needs_again`.
- `ready { agentId, provider }`: `{ ok: true, type: 'oauth' | 'token' | 'api_key', expiresAt?, who? }` only when the agent's
  own store holds that profile, its order lists exactly it, and it is not expired.
- `adopt { from, to, provider, who }`: under both agents' exclusive locks, rewrites `agents.entries[to].model`'s primary
  `@` suffix to `from`'s sealed profile id, moves that profile record unchanged (every field the pin stored) into
  `to`'s store, seals `to` to it (dropping `to`'s
  old profile), then clears it from `from` (the grant stays shared and agents hold views only; D11 holds). It answers
  `{ ok: false }`, changing nothing, unless `from`'s profile carries exactly that `who`. Without the rewrite
  the pin would keep pinning the deleted profile on every run with the agent's default model.
- Before any sign-in on an existing agent the kit notes that agent's primary model (`config.get`); when the sign-in's
  profile is adopted away or cleared from it, the kit restores that primary model (the pin's sign-in rewrote it).
- `clear { agentId }`: removes every profile from the agent's own store.

`@byokit/accounts`' structural `roomOf(windows, at, resetUnit?)` keeps legacy reset seconds as its default;
normalized `@byokit/usage` 0.2.0+ windows use epoch milliseconds and must pass `resetUnit: 'milliseconds'`
(the third argument is the unit string). A normalized usage `Room` can also pass directly to the chooser.
The source measurement `at` and chooser clocks always use epoch milliseconds.

**Choosing.** `src/pick.ts` holds `consider`, `chooseAccount` and `resolveSelection` (5.13), pure, ported from
`@byokit/accounts`; `fixtures/conformance/auto-pick-typescript.json` is the parity table both packages' tests run (its
rows gain the API-key rule, the demand and the explanation below first). `consider` is the one eligibility predicate:
one `Considered` row per account in list order. `resolveSelection` calls it and ranks only its candidates (through
`chooseAccount`, given `a => room(a, demand)`), and `run`, `pick` and the app's account list (through `pick`) all go
through `resolveSelection`; nothing else filters or ranks accounts. The demand is `sel.model` (when set) plus
`sel.needs`, deduplicated; `room(a, demand)` is the room for that demand (Room). `chooseAccount` returns only the
Auto winner and its `why`; `resolveSelection` fills `how`, `model`, `reason` and `considered`. `bound` (kit only; `@byokit/accounts`
has no bindings) is the accounts a conversation may use (Runs steps 1-2); absent, all.

1. Candidates: accounts in `bound` (else `out: 'bound'`); `ready`, or `resting` with `until <= now` (`resting`
   with a later `until` → `out: 'resting'` with `until`; any other state → `out: 'state'`); `billing:
   'subscription'` (else `out: 'billing'`): an API-key account is used only when chosen (by id, by
   `defaults.account`, or `auth: 'apiKey'`), never by Auto or a default fallback. With a demand, only accounts whose
   `models` list every demanded model (else `out: 'model'` with `missing`); without, those of the default account's
   provider, else of the first provider in list order (else `out: 'provider'`). The first matching `out` in that order
   is the row's.
2. Tier A (`tier: 'room'`): known room with `left > 0`, or with a `resetsAt` already past; `left <= 0` without
   `resetsAt` counts as 0. Sorted by `left` descending, then earlier `resetsAt` (an absent `resetsAt` after any
   present one), then list order.
3. Tier B (`tier: 'unknown'`): unknown room, including a reading whose `at` is older than 24 h, in list order; above
   exhausted accounts. A known reading without `at` keeps its tier; only its `age` is `'unknown'`.
4. Tier C (`tier: 'exhausted'`): every account exhausted: the earliest `resetsAt`, started anyway.
5. Nothing: `{ ok: false, code: 'none' }`.

`'default'` is the default account when `ready` and in `bound`, else Auto unless `defaults.auto === false`, else
the first `ready` subscription candidate (a default outside `bound` is treated as not ready; its row has `out:
'bound'`). `auth: 'apiKey'` is the id of the member's newest API-key account (API keys). A chosen id that
is not the member's → `unknown_account`; a chosen (or `ready` default) account lacking a demanded model →
`not_included`. `AccountPick.model` is `sel.model`, else (API key) its saved model, else `defaults.model` when that
account lists it, else its first available model. `reason` is a words sentence (`auto.*` below).

`considered` always has every account's row. An account the selection names (a chosen id, the `ready` default) is
judged only on `bound` and the demand, so an API-key or resting account it names carries no `billing`/`resting` `out`;
every other row is marked as Auto would mark it, so the app can show why each was not used.

`why` and `how` are deterministic: a chosen id (and `auth: 'apiKey'`) → `how: 'chosen'`, `why: 'chosen'`; the `ready`
default → `how: 'default'`, `why: 'default'`; the `auto: false` fallback → `how: 'default'`, `why: 'first_ready'`;
else `how: 'auto'` and Auto's: `only` (one candidate); in tier A against the next tier-A candidate (or, alone in tier
A, `most_room`): more `left` → `most_room`, the same `left` and an earlier `resetsAt` (by step 2's order) →
`earlier_reset`, else `list_order`; tier B → `no_reading`; tier C → `refills_first`. `considered.reason` is the exclusion
code or the deterministic ranking comparison with the winner (the winner gets the pick's `why`). `confidence`
describes the measurement age, never sign-in health. `considered` holds ids, figures
and codes only, never an email, name or engine line; the app renders it with the `pick.*` and `room.*` words
(`pick.why.<why>` for the pick, `pick.out.<out>` and a `room.*` or `pick.age*` line per row).
`pick(member, sel, { sessionKey })` applies Runs steps 1-2 for that key (their refusals answer `code: 'bound'` or
`'paid'`, the kit-only codes; `@byokit/accounts` never returns them) (the binding gives `bound` and, for a key
bound to an account agent, that account as a chosen id) and returns exactly what `run` would decide with the same
key, selection and state, `considered` included, without running. The pick is made once, before the run's first
request, and holds for the whole run: nothing re-picks during it (a limit hit ends the run, Runs step 7), and a bound
conversation keeps its account until `move`.

**Room** (`room(member, id, demand?)`): the `models.authStatus { agentId }` row for the account's provider; of its
`usage.windows` entries that apply to the demand, the one with the highest `usedPercent` gives `left = 100 -
usedPercent`, `resetsAt = resetAt`, `span` from the window label (session → `session`, weekly → `week`, monthly →
`month`, else `tightest`). A window applies to every model unless the engine scopes it to models; the pin's window
rows carry only `label`, `usedPercent` and `resetAt` (section 12), so today every window applies (the tightest known),
and a scope a later pin reports narrows it (spec change first).
A window without a numeric `usedPercent` is skipped, never read as unused. `at` is left out: the pin exposes no
reading age (its cache keeps the last good reading, and the row's `ts` is answer time), so the kit never stamps the
time it received a reading as the time it was read; `considered.age` is `'unknown'` and the 24 h rule never applies
to this kit. No applying window, no answer in 20 s, or an API-key account → `{ left: 'unknown' }`. The kit adds no
cache.

**Runs.** Every run first finds the account its session is bound to, whatever `spec.account` says:

1. Binding: a key `agent:<member>--<hex6>:<tail>` of an indexed account agent is bound to that account. A key
   `agent:<member>:<tail>` is bound to whichever of the member's agents holds `agent:<that agent>:<tail>`, found with
   `sessions.resolve { key, agentId, allowMissing: true }` per agent (member agent first; `missing: true` = not there);
   a session on the member agent is bound to the member agent (any of its accounts). A key found nowhere is unbound.
2. Bound to an account agent: `spec.account` absent, `'default'` or `'auto'` resolve to it (Choosing treats it as a
   chosen id with `bound` = that account, so a demand it lacks ends `plan` before any request), and a different id is
   refused before any request (`code: 'bound'`, words `account.bound`: move the conversation first). When that account bills `api`,
   only its own id or `auth: 'apiKey'` may continue it; anything else is refused the same way (`code: 'paid'`, words
   `account.paid`).
   Bound to the member agent with `spec.account` set: `'auto'` and `'default'` choose only among the member agent's
   own accounts (`bound` = those), and an id on another agent is refused with `account.bound`.
3. Bound to the member agent, or unbound, with `spec.account` and `spec.needs` absent: exactly today's 5.8 behavior on
   the member agent (existing requests stay byte-identical). `spec.needs` with `spec.account` absent resolves as
   `account: 'default'`.
4. Otherwise the selection `{ account: spec.account, model: spec.model, needs: spec.needs }` is resolved (Choosing,
   with step 2's `bound`). A failed pick ends the run before any request: `none` →
   `{ ok: false, kind: 'signed-out', message: reason }`, `not_included` → `kind: 'plan'`, step 2's `bound` and `paid`
   → `kind: 'other'` with `message: reason` (its `account.*` words); `unknown_account` throws (a
   caller bug, like a malformed model). An unbound key picking an account agent runs as
   `agent:<account agent>:<tail>` (`<tail>` = the app key after `agent:<member>:`).
5. `byokit.accounts ready` for the account's agent and provider replaces 5.8's `models.authStatus` check; not ready →
   `signed-out`, no engine request.
6. The first event is `{ type: 'account', account, model, sessionKey, how, why, considered }` (the pick's) with the
   engine key, before the `agent` request, which is 5.8's request on the account's `agentId` and engine key with the pick's `provider`/`model`
   (strict; `@profile` still refused). The bridge registers the engine key under `spec.member`.
7. An end classified `resting` writes `until` (now + 5 min when the message names none) to the index; Auto skips the
   account until then. The ok end carries `account` and `model`.
8. `steer`/`abort` take the app key of a live run (the kit keeps the app key → engine key map while it runs) or the
   engine key, and keep the optional `{ auth: 'apiKey' }` of the key lane.

**Adding.** `addAccount(member, { authChoice, via, name?, again? }, on)` accepts any pinned `subscription` choice
(D12); `api` routes go through `addKey`, `local` routes are not accounts. A member whose id passes only the old D9
rule is refused (words `account.legacyMember`). The target agent is the member agent when it holds no local profile
of the route's provider and `again` is absent, else a new account agent (`again` names an existing account of the same
provider). The index entry is written, then 5.7's sign-in loop runs against that `agentId` (one sign-in at a time per
kit: the engine has one setup admission; a second start ends `why: 'busy'`). A sign-in for a provider the member
already holds must not reuse the provider's browser session: for `openai` browser sign-ins the kit adds
`prompt=login` to the sign-in URL it surfaces (the pin builds that URL unsigned); for other routes the connect sheet
shows words `account.signOutFirst` first. When done: seal; its `who` (Sealing) is the sign-in's identity. Identity is
compared only within one member and one provider, against each account's index `who`. The email is a display hint:
it never decides which account a sign-in belongs to, and a changed email changes nothing.

- The same `who` as the target's own entry (the member agent signing in again to its signed-out account): that
  account is signed in again; nothing is adopted or cleared.
- The same `who` as another existing account X, whatever `again` names: `adopt { from: <target>, to: <X's agent>,
  provider, who }`, remove the new agent (or `clear` the member agent's profile of that provider when it was the
  target), and `done` names X: signing in again as the same account refreshes it instead of adding a row, whatever
  email it now reports, and an account `again` named but did not sign in to is untouched. Several accounts already
  sharing that `who` (only from before O14): X is the earliest `addedAt`. An `adopt` answering `{ ok: false }` leaves
  the sign-in a new account, as below.
- `again` = X and a `who` no account has: the sign-in stays a new account and `done` names it; X's sign-in is
  untouched (signing in to the wrong account never replaces X).
- No `who` on either side (a provider or profile without an account id, or an account signed in before its `who`
  was recorded that holds no profile now): no merge, even with `again` or the same email; the sign-in stays a new
  account, `done` names it, and the person removes the old row.
- A new agent whose sign-in fails, expires or is cancelled is removed with its index entry.

`addAccount` resolves once the target is known: `Promise<{ id; paste; cancel; done: Promise<{ view: SignInView; id:
AccountId }> }>`, where `done.id` is the account the sign-in ended in. `name` defaults to `<label> <n>`; the email's
local part is only a suggestion the app offers (`@byokit/ui` `nameSuggestions`), so the index never holds it.

**API keys.** `addKey(member, { authChoice, apiKey, name? })` accepts only routes with `keyEntry` (else
`not_included`), writes the index entry, creates a new account agent, calls typed `openclaw.setup.activate { kind:
'api-key', agentId, authChoice, apiKey }` (180 s), seals it, records its saved model, and returns `'ok' | 'invalid' |
'not_included'`; any result but `ok` removes the new agent and entry. Every key is a new account (keys add, never
replace; a key is replaced by `removeAccount` then `addKey`). The key never reaches kit storage, the index, logs,
errors or a return value, and is never sent over a link (`oc.account.add` refuses `key`). `RunSpec.auth: 'apiKey'`
means `account: <the member's newest api account>` and runs its saved model; another model ends `kind: 'plan'`.
If the key lane's `byokit-key-<member>` agent already exists (it shipped before O14): it is indexed as account
`<provider>.key`, keeps its workspace (`key-workspaces/<member>`) and sessions, `agent:byokit-key-<member>:` keys are
that member's (D9, matched exactly), `byokit.keys ready`/`prepare` serve only it, and every later key is a
`<member>--<hex6>` agent. That lane's per-member serialization of key runs is replaced by the locks below.

**Other operations.**

- `renameAccount` writes the index. `defaults`/`setDefaults` read and write it; a default naming a removed account is
  dropped.
- `removeAccount(member, id)`: a member-agent account is `models.authLogout { provider, agentId: member, profileIds:
  <its sealed profile> }`, then its entry is dropped. An account agent: refused (`busy`) while a run is live on it;
  `byokit.accounts clear`, then `byokit.accounts list` must answer no profile of any type, order or expiry (a
  profile the engine refreshed during `clear` lands whole before or after it, under the same store lock, which O14's
  engine job confirms: `clear` again, once; still listed → stop with the error, nothing deleted);
  `agents.delete { agentId, deleteFiles: false }` (with `true` the pin moves files to a trash path it never reports);
  the kit then removes `<root>/state/agents/<agentId>` (the agent's store and sessions) itself, never the shared
  workspace, and checks it is gone (recreated by a late write → removed once more; still there → stop with the error,
  the entry kept). The entry is dropped only when the directory is gone; `removeAccount` on an entry whose agent is
  already gone removes the directory and then the entry. A write the engine lands even later cannot be ruled out by a
  bounded check, so on `prepare` and after every removal the kit also removes each
  `<root>/state/agents/<member>--[0-9a-f]{6}` directory that no index names and no engine agent owns (an entry is
  written before its agent is created, so an account being added is never swept). The account's
  sessions go with it; `move` first keeps one.
- `models(member, id)`: `models.list { agentId, view: 'default' }` rows of the account's provider, mapped `id =
  'provider/model'`, `available`, `unavailableReason` `missing-auth`/`auth-failed` → `why: 'signed_out'`, `cooldown`
  → `why: 'resting'` with `until = unavailableUntil`. The pin reports no per-plan availability, so `why: 'plan'` only
  comes from a run ending `plan`.
- `move(ref, to)` moves a conversation (an app key binds as in Runs step 1): `unsupported` when it is bound nowhere;
  `busy` while a run is live on it (kit map, or its `sessions.list { agentId }` row `hasActiveRun`); `start_failed`
  when the target is not `ready`. Same agent (two member-agent accounts) → `{ ok: true, session: <its key> }`; the
  next run names the account. Otherwise, holding both agents' locks: note the source row's `sessionId` and `updatedAt` from
  `sessions.list { agentId }`; `sessions.create { agentId: <target>, key: 'agent:<target>:<tail>',
  parentSessionKey: <source key>, fork: true, model: <the session's model when the target lists it, else the target's
  first available> }` copies the full transcript into the target agent (never `chat.history` + `chat.inject`, which
  drop tool rows and rewrite user turns); failure → `start_failed` (engine message cut to 200 chars), the source
  untouched. Then `sessions.delete { key, agentId: <source>, deleteTranscript: true, expectedSessionId,
  expectedSessionUpdatedAt }`; failure or mismatch → `close_failed` with `live` = the new key (both exist).
- Locks (`src/locks.ts`): per agent id; runs take a shared hold from `ready` to their end (runs on one account may
  overlap), and `room` and `models` hold it for their read, so no kit read of an agent is in flight while it is
  removed; `removeAccount`, `move` (source and target) and sealing are exclusive.
- Attribution: every member lookup (approvals' `agentId` and session key, bridge, link `oc.events`/`oc.sessions`
  filters) maps an indexed `<member>--<hex6>` agent, and `byokit-key-<member>` when present, to `<member>`.

**Words** (added to `src/words.json`; `words` also fills `{provider}`, `{room}`, `{left}`, `{model}`, `{n}` and
`{ago}`; the kit renders `{left}` as the number with a percent sign, since `%` is banned in the file, `{room}` from the
`room.*` key of the span, and `{ago}` from `ago.minutes` under an hour, else `ago.hours`, `{n}` rounded down):

| Key | Sentence |
|---|---|
| `auto.room` | Right now that's {name}: {room} |
| `auto.unknown` | Right now that's {name} (no recent reading) |
| `auto.refills` | All {provider} accounts are out of room until {time}. {name} refills first. |
| `auto.refillsNoTime` | All {provider} accounts are out of room. {name} refills first. |
| `auto.terms` | Auto may use either of a provider's accounts. |
| `auto.none` | No signed-in {provider} account. |
| `room.unknown` | Room left unknown |
| `room.session` | {left} left this session |
| `room.week` | {left} left this week |
| `room.month` | {left} left this month |
| `room.tightest` | {left} left for now |
| `pick.out.state` | Not signed in right now |
| `pick.out.resting` | Taking a break until {time} |
| `pick.out.billing` | Billed per use, so used only when you choose it |
| `pick.out.model` | Doesn't include {model} |
| `pick.out.provider` | A different service |
| `pick.out.bound` | This conversation uses another account |
| `pick.why.chosen` | You chose {name}. |
| `pick.why.default` | {name} is your default. |
| `pick.why.first_ready` | Your default isn't ready, so {name}, the first ready account. |
| `pick.why.only` | {name} is the only account that can take this. |
| `pick.why.most_room` | {name} has the most room left. |
| `pick.why.earlier_reset` | {name} has as much room left and refills sooner. |
| `pick.why.list_order` | {name} is tied for room and comes first in your list. |
| `pick.why.no_reading` | No account has a recent reading, so {name}, first in your list. |
| `pick.why.refills_first` | All accounts are out of room; {name} refills first. |
| `pick.age` | Read {ago} ago |
| `pick.ageUnknown` | Reading time unknown |
| `ago.minutes` | {n} min |
| `ago.hours` | {n} h |
| `account.bound` | This conversation uses {name}. Move it to switch accounts. |
| `account.paid` | This conversation uses {name}, which is billed per use. Choose {name} to keep going. |
| `account.signOutFirst` | To add a different {provider} account, sign out of {provider} in your browser first. |
| `account.legacyMember` | This person needs a new profile before adding more accounts. |

### 5.16 Bundled engine patches and engine-started usage (D19)

The engine stays the npm tarball pinned by `engine/package-lock.json` (D4). The kit may change that install only
through a published, content-addressed patch set, so every byte the Gateway runs traces to the lock's `integrity`
plus one reviewed edit. A fork, a republished tarball or a source build is never used.

**Patch set** (`engine/patches.json`, inside the published `engine/` directory):

```json
{ "v": 1, "id": "<16 hex>",
  "upstream": { "name": "openclaw", "version": "2026.8.1",
    "integrity": "<the lock's sha512 for openclaw>", "commit": "<dist/build-info.json commit>", "license": "MIT" },
  "files": [ { "path": "dist/<file>.js", "before": "<sha256>", "after": "<sha256>",
               "edits": [ { "find": "<text occurring exactly once>", "replace": "<text>" } ] } ] }
```

- `upstream.version` and `integrity` equal `ENGINE_VERSION` and the lock's `openclaw` entry; `before` is the stock
  file's sha256, `after` the result of applying `edits` in order, each `find` occurring exactly once in the current
  text. `id` is the first 16 hex of sha256 over `JSON.stringify` of `files` with object keys sorted recursively and
  no whitespace. A checked-in script re-derives the file from stock bytes and anchors (`--check` in CI), so no hash
  is hand-edited, and asserts that no other `dist` file defines a patched function except the uncovered worker
  bundle named below. An empty `files` is a valid set.
- The full OpenClaw MIT copyright and permission text ships as `engine/OPENCLAW-LICENSE` (the set republishes
  upstream excerpts; the repo `NOTICE` is not in the tarball).
- Usage accounting and app-owned restart recovery patches do nothing unless the kit sets their own env
  variables at spawn (5.5); with those variables unset they behave as stock. The Claude Tooling patch below
  is route-gated instead. A patch adds no RPC, config key or schema to the engine.

**Claude Tooling names.** On the Claude CLI route, after the backend system-prompt transform, the kit's
bundled prepare patch prints OpenClaw tool names as `mcp__openclaw__<name>` in the policy-filtered
`## Tooling` list, matching the CLI wire catalog. It rewrites only bare names present in `promptTools`;
already-prefixed names, summaries, ordering and other sections stay unchanged. Non-Claude routes,
skipped turn preparation and empty tool lists keep the stock prompt. No consumer aliases are added.
`packages/openclaw/test/engine-unit.test.ts` exercises the shipped edit's rendered output; its minimal stock
input is unit coverage, not qualification against the complete pinned engine or a live Claude CLI.

**Engine sets.** A patched engine is never made by editing files in place: stock OpenClaw rewrites its process
title (`/proc/<pid>/cmdline` is `openclaw-gateway`, `test/engine/boot.test.ts`) and a running Gateway holds no file or
mapping in its engine tree, so no process can be tied to an engine directory without reading its environment, which
holds the Gateway token. Instead, no kit path writes a tree any process may load, and no process is identified,
signalled or waited for.

- **Where.** `<engineDir>.sets/<h>-<setId>/`, a sibling of `engineDir` (inside it, Node's import walk-up would fall
  back into `engineDir/node_modules`, which older kits delete and reinstall); `h` = first 16 hex of sha256 over the
  lock's `integrity` string. The sets directory and each set must not be symlinks. Credential archive walks skip it
  as they skip `engineDir`.
- **Build** (only when no verifying set exists): in `<sets>/.tmp-<pid>-<startTime>-<random>` on the same device. The
  stock set (`files: []`) is installed by 5.4's `npm ci`; every other set is copied from a verified stock set (never
  from `engineDir/node_modules`) with `cpSync(…, { recursive: true, verbatimSymlinks: true, mode: COPYFILE_FICLONE })`,
  no hardlinks. Verify version and commit and every `before`, apply the edits, verify every `after`, then freeze the
  built copy: read its tree once, set files 0444 and directories 0555 (links untouched) in bounded batches, and flush
  once (`sync -f` on Linux, one filesystem-wide syncfs; no flush elsewhere). The frozen entries become the manifest
  `.byokit-tree` (a sorted JSON array of every entry's path, type, mode, size, sha256 or symlink target), and
  `.byokit-patches` (`{ id, files, tree }`, where `tree` is the sha256 of `.byokit-tree`) sits beside it. Both are
  written durably (write, `fsync`, rename, `fsync` the parent), the whole tree is verified against them, and the
  temporary directory is renamed onto the final name and `fsync`ed in its parent. Per-entry `fsync`s are not taken.
  Durability: the pre-publication check proves the published tree equals the tree as read at freeze time, and the
  patched files and build version were checked before freeze. Power loss can still tear a published set; on any
  platform, the adopt rule's next-launch whole-tree verification detects the torn entry as drift and rebuilds it, so a
  torn set is never launched. Where no bulk flush runs (every non-Linux platform, macOS, Windows and BSD included, and
  Linux without a working `sync -f`), that verification is the only power-loss guard, and the worst case is a full
  reinstall. A rename that loses to another kit
  (`ENOTEMPTY`/`EEXIST`, `EPERM` on Windows) removes only its own temporary directory and adopts the winner after
  verification; any other error fails, never copy-over or remove-and-retry. A kit removes its own temporary directory
  on failure; another kit's is removed only when its `<pid>-<startTime>` is provably dead on Linux, and left
  untouched on any doubt or without `/proc`.
- **Adopt.** Every `prepare()` (so every start and restart, 5.4) runs **full manifest verification** of the set it
  is about to use, including a set this state directory adopted before: the tree holds exactly the manifest's
  entries with equal type, mode, size, hash and link target, plus the patch set's `after` hashes. Checking only
  patched files never counts as drift detection. The adopted set's name and manifest sha256 are kept in
  `<root>/engine-set` (atomic write). O15 measures full verification on the real tree; if that cost is unacceptable,
  the contract returns to firstmate for a different honest rule, never a silent weaker check.
- **Immutable.** After the rename no kit path, updater or `doctor --fix` run writes a final set, and none is ever
  deleted (`ponytail:` about 0.9 GB per set per `engineDir`, older pins' sets strand; collection needs per-launch
  leases, add when disk matters). A set failing verification is left byte for byte: the kit adopts a verifying
  `<name>.<random>` sibling or builds one, once per `prepare()`.
- **Failure.** No spawn on an unverified set: state `failed`, `why: 'engine-patch'`, with the set and cause
  (`write`: a set or temporary directory cannot be created; `drift-after-build`: a freshly built set fails
  verification) in the error. A failed install or verification also retains a size-capped, environment-free
  diagnosis at `<stateDir>/logs/engine-install-drift.json` (first failed root-manifest/package check with expected
  vs actual version or the read error, npm path and version, npm stderr tail) before the failed temporary tree is
  deleted. `KitState.patchSet` (5.2) is the adopted set's `id` (`null` before the first adoption).

**Rollback contract (one rule):** rollback is adopting another set. Copying from a verified stock set needs no
network; only building the stock set runs `npm ci` (registry unless cached). A kit from before this section runs
`engineDir/node_modules`, which this kit never touches, so it runs stock bytes. Ledger history (below) is never
deleted.

**Coverage.** Only the Gateway process (`openclaw.mjs` and the chunks it loads) is patched. The worker bundle
`dist/worker/worker.mjs` has its own copies of the review and recovery code and is **uncovered**: no guarantee of this
section holds for work run in a worker environment. Engine-started usage covered by the kit is exactly:

| Kind (Gateway) | Counted through |
|---|---|
| Your turns, restart-recovery resumes, pre-compaction memory flush | `sessions.usage` transcript totals (stock; these runs persist in the session transcript) |
| Skill Workshop review (`kind: 'workshop-review'`) | the engine-started ledger below (its detached clone is never persisted and internal-effects keys are excluded from usage discovery) |

Every other engine-started kind is **uncovered** and named so: skill collection review, history scan, slug generator,
active-memory recall, out-of-turn compaction, one-shot helper completions, and all worker-bundle work. A new kind is
covered only by a new patched seam and a widened `EngineStartedKind`, never by a side source.

**Engine-started ledger (R4-1).** Env `BYOKIT_ENGINE_USAGE_LEDGER=<stateDir>/openclaw/usage` and
`BYOKIT_ENGINE_BOOT=<bootId>`: a random UUID accounting identity minted before spawn, recorded first in
`boots.jsonl`, and added to `gateway.identity` beside the existing `pid` and `startTime`. Those fields alone still
own process liveness; `bootId` never does. The review site writes one JSON line per fact, `open(…, 'a', 0o600)` + one `write` + `fsync`,
to `engine-started-<YYYY-MM>.jsonl` (UTC month of the fact's `at`); a write error is counted and swallowed (accounting
never fails a review).

```
{ v: 1, phase: 'started' | 'ended', chargeId /* engine run id */, agentId, kind: 'workshop-review',
  provider, model, authProfileId?, bootId, seq, at, startedAt, origin: { sessionKey, runId? },
  outcome? /* ended: 'nothing' | 'proposed' | 'applied' | 'failed' */,
  usage? /* ended, only when the engine reported it: input, output, cacheRead, cacheWrite, reasoningTokens, total */ }
```

- `started` precedes the run; usage is taken from the run result before the success assertion, so a failed run that
  reported usage keeps it; success and failure paths are exclusive, so one `ended` per run. No prompt, output, tool
  argument or credential is written.
- `seq` counts every attempted write per `(bootId, month file)`, starting at 1, so a failed write leaves a hole in
  that month's file. The engine keeps `{ [month]: { lastSeq, failed } }` and the in-flight run ids in process,
  exposed to the kit's plugin.
- The kit writes `usage/boots.jsonl` (0600, `fsync`): `{ bootId, startedAt }` before spawn (a failed write fails the
  start, so no boot is unrecorded). A definite spawn failure before a pid exists appends
  `{ bootId, failedAt, spawned: false }` (fsync); that boot attempted no write. An unclosed start without this
  proof remains a crashed boot. The kit writes `{ bootId, stoppedAt, months: { [month]: { lastSeq, failed } } }` at clean
  stop, read from the live counters. The kit never deletes ledger or boot files; growth is about 400 bytes per review
  (about 7 MB a year per agent at 50 reviews a day). `ponytail:` no rotation; add one when a host shows the need.
- Read path: the kit plugin registers `byokit.usage.engineStarted { agentId, startMs, endMs }` (`operator.read`),
  returning facts, `unreadableLines`, the live boot's counters and in-flight starts. Browser and React Native reach it
  through `device`; no client reads files.

**Reading a window.** The reader opens only the UTC month files overlapping `[startMs, endMs]`, plus `boots.jsonl`
(one record pair per Gateway start). Cost is proportional to the requested months, never to total history. Facts
dedupe by `(chargeId, phase)`. A charge with `ended` is attributed by `ended.at` (the `ended` fact carries the full
identity, so its `started` may lie in an unread month); one without is attributed by `startedAt`. States:
`ended` + `usage` → `counted`; `ended` without usage → `reported-missing` (unknown, never zero); `started` alone →
`pending` when its `bootId` is the live boot, else `interrupted` (unknown spend). Elapsed time never decides.

`complete: true` is set only from bounded proven evidence, never defaulted and never from a later fact:

1. every boot whose life overlaps the window has a start record, and is either the live boot or has a clean stop
   record (a boot that ended in a crash makes every overlapping window incomplete, permanently);
2. for every **read** month file and every such boot, the boot's counters for that month (stop record or live) show
   `failed == 0`, and its facts in that file carry exactly `seq 1..lastSeq` (no hole, no extra);
3. no read file has an unreadable line, and no charge in the window is `pending`, `interrupted` or
   `reported-missing`; the live boot has no in-flight start, unless the window ends before that start;
4. the window starts at or after `coverageSince` (the first boot record).

A month the reader did not open is never claimed: continuity is checked per `(boot, month)`, and the one boot-wide
fact used from unread months is the stop record (or live counters), which the kit writes from the counters, not by
reading old files. A month absent from a boot's counters means that boot attempted no write there. Anything
unproven yields `complete: false`.

**Day total.** `transcripts (lane 19's sessions.usage term, fresh-or-unavailable rules unchanged) + Σ counted
ended.usage.total for workshop-review`. Recovery resumes, memory flush and `RunEnd.usage` are never added from a side
source (they are already in, or overlap, the transcript term). Time zones: `utc` or an IANA zone, applied the same way
to both terms; `gateway` (host-local) is refused. A review crossing midnight lands on its `ended.at` day. Cost is
`{ state: 'missing' }` for every engine-started charge (no USD estimate); billing comes from `Route.billing` of the
route that created `authProfileId`, else `'unknown'` (D18: never inferred from the provider name).

**Typed contract (additive; lane 19's `readAgentUsage`/`AgentUsageReading` partial transcript API stays unchanged).**
`AgentDayUsage` and `readAgentDayUsage` are the accepted additive names; the original partial API is unchanged.
The transcript term in this reader carries the requested UTC/IANA window (not a misleading UTC label).
The pinned transcript RPC resolves calendar days: a partial-day millisecond window leaves that term unavailable,
never a falsely precise day total.

```ts
import type { AgentUsageReading, Member, UsageWindow } from '@byokit/openclaw';
export type EngineStartedKind = 'workshop-review';
export type EngineStartedCharge = {
  chargeId: string; member: Member; kind: EngineStartedKind;
  state: 'counted' | 'reported-missing' | 'pending' | 'interrupted';
  startedAt: number; endedAt?: number; outcome?: 'nothing' | 'proposed' | 'applied' | 'failed';
  provider: string; model: string; billing: 'subscription' | 'api' | 'local' | 'unknown'; authProfileId?: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; total: number };
  tokenSource: 'engine-reported'; cost: { state: 'missing' }; bootId: string; seq: number;
  origin?: { sessionKey: string; runId?: string };
};
export type AgentDayUsage = {
  member: Member; window: { startMs: number; endMs: number } & ({ mode: 'utc' } | { mode: 'time-zone'; timeZone: string });
  transcripts: Omit<AgentUsageReading, 'window'> & { window: UsageWindow &
    ({ mode: 'utc' } | { mode: 'time-zone'; timeZone: string }) };
  engineStarted: { state: 'available' | 'unavailable'; coverageSince?: number; charges: EngineStartedCharge[]; unreadableLines: number };
  coverage: 'transcripts+workshop-review';     // the uncovered kinds above stay excluded
  complete: boolean;                           // only by the four rules above
  knownTotalTokens?: number;                   // only when both terms are available
};
export declare function readAgentDayUsage(client: { callDynamic(method: string, params?: unknown): Promise<unknown> },
  member: Member, window: AgentDayUsage['window']): Promise<AgentDayUsage>;   // host kit or device client
```

Policy stays with the caller: `complete === false` means the policy outcome is unknown, never "under".

**App-owned sessions (R1-1).** Env `BYOKIT_APP_OWNED_SESSION_PREFIXES` (JSON string array; malformed → `[]`, stock)
from `KitOptions.appOwnedSessions?: { keyPrefixes: string[] }` (each `^agent:[a-z0-9-]+:`, never covering a member's
`agent:<m>:main`; absent = stock). The first line of the engine's main-session restart-recovery candidate predicate
returns false for such a key, so startup marking, dispatch, `not_required` and admission rollover skip it. The patch
adds no attempt cap and changes no attempt or tombstone logic for other keys. After a crash an opted-out session reads
`status: 'running'` with no recovery markers; the app derives "interrupted" from `running` with no live run in the
current boot, never from `abortedLastRun`. Prefixes are re-applied at every start; changing them changes which old
interrupted sessions recover. Gateway only (the worker bundle keeps stock recovery).

### 5.17 Browser sign-in handoff and live view (D20)

When a member's agent reaches a signed-out site, the person signs in **on the real site in the agent's browser
session**, and the password never passes through the model, a tool, chat, logs, traces or persisted state. Apps
render the sheet, takeover and live view from typed state. Normative types: `src/browser.ts` (exported type-only
from `.` and `./device`); a shape change there is a spec change. No engine patch: the engine attaches to a
kit-owned browser as a documented `attachOnly` remote CDP profile.

**Engine facts this rests on (2026.8.1).** The engine-managed Chrome serves unauthenticated loopback CDP and
`browser status` hands its port to the model, so the engine-managed and implicit profiles (`openclaw`, `user`,
`chrome`) are never used. `before_tool_call` sees agent tool calls but not the operator `browser.request`,
in-process callers or collectors, so the fence lives at the CDP chokepoint too. Remote `cdpUrl` profiles call
`/json/list`, `/json/new` and per-tab sockets and copy the URL query into each tab's `wsUrl`; operator `/tabs`
returns it unredacted, so the broker token is not a security boundary. One global `defaultProfile`; `target` may
route to a node; the idle tab sweeper closes tabs after 120 min.

**Enable gate.** `KitOptions.browser` (off by default) runs the browser and live view. **Handoff** (raising
`NeedSignIn`, parking a session) is refused with `BrowserState.why: 'handoff-unprotected'` until parked sessions
cannot receive an unwanted model submission: either O17 has landed and every key the kit parks matches
`appOwnedSessions.keyPrefixes`, or O25 proves the kit's `before_agent_run` refusal (below). Labelling a restart
`indeterminate` does not stop an engine recovery turn.

**Precondition (all agents).** Every agent the engine can run (members, account agents, subagents/delegates,
plugin agents; browser member or not) shares the engine's OS user, config, token and profiles. At start and on
every member/tool change the kit checks each agent's effective tool policy against a closed safe set: `browser`,
`request_sign_in`, the app's bridge tools (`KitOptions.tools`) and engine tools the kit lists as file-, exec- and
network-free. Any other tool, including an unknown or custom one, sets `blocked: 'unsafe-tools'` for every browser
in the kit; a group deny is not assumed to cover it, and a separate-OS-user sandbox is not accepted as a claim. While
the feature is on, the pre-gate also denies `exec`, `process`, `code_execution`, `bash`, `terminal`, `read`,
`write`, `edit`, `apply_patch` and `gateway` for every agent. `gateBuiltins: false` with `browser` is refused at
construction (`gate-off`). The pinned `tools.effective` route needs an existing session: the kit creates one
inert audit session per roster agent (no task/message or model submission) before reading its inventory.
The trusted host (app code with typed pass-through) is outside this boundary.

**Browser and broker** (`src/browser/broker.ts`, O19). Per member: Chromium from `executablePath` with
`--remote-debugging-pipe` (no TCP DevTools port), profile `<stateDir>/browser/<member>/profile` (0700), env built
from nothing, password manager and autofill prefs off, back-forward cache off. Chromium's sandbox stays on: a launch refused
for no usable sandbox (e.g. unprivileged user namespaces disabled) throws `BrowserSandboxUnavailable`
(`reason: 'sandbox-unavailable'`), never retries unsandboxed, and keeps no stderr. The broker is the pipe's only
client and serves `ws://127.0.0.1:<port>/devtools/browser/<opaque-id>?token=<t>` (also `/json/version`'s
`webSocketDebuggerUrl`; per-page URLs keep the token), `/json/{version,list,new,activate,close}`
and `/devtools/page/<id>`; it refuses an `Origin` header or foreign `Host`, blocks `Browser.close`, rotates the
token per start, and multiplexes one `Target.attachToBrowserTarget` per client with per-client id remapping and
session ownership.
- **Private targets.** At takeover the broker creates the sign-in tab itself; popups opened by a held target are
  held too. Held targets are invisible to every non-viewer client (filtered from `Target.*` events, `/json/list`
  and auto-attach; attach refused).
- **Fence** (any request `waiting`, `held` or `checking`): on raise, waits out in-flight agent commands (≤ 5 s),
  then rejects every agent command; agent clients get only structural events for their own tabs; downloads denied
  browser-wide.
- **Controller.** `Byokit.claimTakeover {epoch, nonce}`; one controller; only `Input.*`, screencast and
  back/forward/reload, only on held targets; `Runtime.evaluate` refused. Input pauses whenever the held main frame
  is on an origin not **exactly** (scheme, host, port) the bound origin, a `knownIdps` origin or one confirmed for
  this lease.
- **Internal host seam.** `bindLease`, `confirmOrigin`, `privateState` and `ViewerSession.states` bind control to exact origins; `attachViewer({ lease?, maxWidth? })` uses per-viewer capture bounds and encoded JPEG dimensions; `clearSite` clears explicit exact origins only, never claims a whole-profile wipe.
- **Release order.** Close every held target, await `targetDestroyed`, lift the fence, then navigate the agent's
  tab (`checkUrl` on `verified`, else reload, which also resyncs Playwright).

**Kit wiring** (O21). `reconcileConfig` adds `plugins.allow += 'browser'`, `tools.alsoAllow += 'browser'`
(or merges these additions into an explicit closed `tools.allow`, removing `alsoAllow`: the stock schema refuses
both in one scope) and
`browser: { enabled, defaultProfile: 'byokit-none', evaluateEnabled: false, tabCleanup: { enabled: false },
ssrfPolicy, profiles: { 'byokit-<member>': { cdpUrl, attachOnly: true } } }` (`byokit-none` is dead, so an
unrewritten call fails closed). Before unfencing, the exact broker/generation is re-read and the profile is
acknowledged. Stock `config.get` masks token-bearing CDP URLs with `__OPENCLAW_REDACTED__`; this counts only
against an unchanged host-owned config file with the exact endpoint and attach-only profile, and equal
nonempty `configRevisionHash`/`appliedConfigHash` (the pinned Gateway's applied-source revision projections).
Unknown masks, unapplied revisions or changed files/bindings fail closed. The bridge plugin runs a kit pre-gate before the app's `gate`: rewrite every
`browser` call's `profile` to `byokit-<member>`, `target` to `host`, drop `node` (nested `request`/`actions` too);
deny `profiles`, `importprofile`, `start`, `stop`, `doctor` and `act:evaluate`; while the member has an open
request deny `browser` and `request_sign_in` in every session of that member with `signin.gate`. Kit tool
`request_sign_in({ note?, targetId? })`: the origin always comes from the broker's view of the tab (`targetId` if
it is the member's own tab, else the tab the member's engine client last commanded); `note` ≤ 140 chars, shown
only as quoted agent words. `./link` refuses `oc.call` for `browser.request`, `terminal.*` and `tools.invoke`
while `browser` is on, whatever `passThrough` says. Bridge socket paths limit `stateDir` to about 82 characters.

**Model-visible capabilities** (O24/W7). The installed bridge declares
`contracts.agentToolResultMiddleware: ["openclaw", "codex"]` and registers the pinned runtime-neutral,
awaited result middleware for all tools. Before handing content/details back to the model it rechecks the
bound session's admission, strips owned current/prior-generation broker capabilities and transport URLs,
and terminates on refusal or bridge failure. Image bytes and public content are preserved. Synchronous
transcript hooks provide a persistence-only safety net, not a substitute for live middleware. This source
implementation does not qualify actual provider bodies, replayed histories, private-cookie isolation or
parked/recovery no-submission behavior; production handoff stays closed until the combined matrix passes.

**Requests** (`src/browser/host.ts`, O20). One open request per member (`waiting|held|checking|parked`); another
raise is refused `already-open` and the detector is suppressed. Raise, under a per-member mutex: persist the record,
fence, abort the bound session's run, emit `byokit.browser`, push a sealed notice `{id, gen, member, site}`. Zero
model calls in the bound session while open; the member's other sessions run with `browser` blocked. A new run on a
parked `sessionKey` settles it `cancelled (run-replaced)`; a run on a `waiting|held|checking` session is refused.
The engine gate also refuses unproved resumes. A definite `failed` resume alone does not authorize recovery:
only a fresh kit registration matching the exact session and engine run id may start a replacement run;
missing, foreign and released run ids remain refused. This is not the submitted-resume seam or W7 qualification.
- `takeover` needs a control grant, `waiting`, and on `firstTime` `confirmSite === site` (typed or picked from a
  list with decoys); non-https non-loopback origins are refused `insecure-remote`. It opens the private tab at
  `checkUrl` and mints a lease (claim 60 s, grace 30 s; lapse closes the private tab, back to `waiting`, `gen+1`,
  fence held).
- `done` → `checking` (controller closed, fence held, ≤ `checkMs` 30 s) → settled. `notNow` (→ `parked`, nothing
  polls) and `cancel` are lease-holder only while `held`; every path closes private tabs before the fence lifts.
  `reopen` re-runs raise; `retry` mints a new request with `prev`; TTL expiry of `waiting|held` → `expired`.
- **Settle once**, persisted in `<stateDir>/browser/signins.json` (0600, atomic rename; no secret ever): `verified
  | entered-unverified | cancelled | expired | failed`. Every outcome except `verified` leaves the app's task
  needs-you; a sign-in never completes a task. Kit restart: `held|checking` → `failed (browser-gone)`;
  `waiting|parked` survive with `gen+1`.
- Internal `revokeGrant(grant): Promise<void>` invalidates grant/lease and detaches streams synchronously;
  it holds the fence and refuses new leases until `closePrivate` finishes, then publishes `waiting/gen+1`.
  Close failure stays fail-closed. Host control uses broker `bindLease`, `confirmOrigin` and `privateState`;
  site-specific forgetting uses exact recorded origins through `clearSite`. Forgetting `all` is unsupported
  until across-restart coverage of all stored origins or a whole-profile reset is proven.

**Verification.** `verified` needs a positive host-only `SiteVerifier` for the exact bound origin, run in a new
host-only tab: its same-origin `url` loads, every present condition (`status`, `selector`, host `check`) holds and
the final URL stays on the origin. No verifier → `entered-unverified (no-verifier)`; login-looking or failed →
`still-signed-out`; timeout → `check-timeout`; final private-tab origin outside the bound/confirmed set →
`failed (origin-mismatch)`. A login-free page or a clean 200 is never proof. The result is a boolean and a reason
code; no page text, cookie, header or value leaves it. Only `verified` adds the site to the member's verified set.

**Resume** (only `verified`; at most once; never claimed exactly-once). Persist `ResumeState { key, attempt,
state: 'pending' }` with the intended `sessionKey` before dispatch, `key = signin:<id>:resume:<attempt>:<uuid>`;
`kit.run({ ..., idempotencyKey: key })` (5.8). Accepted → `accepted`; a definite refusal before acceptance →
`failed`. A transport-unknown outcome, or a restart with `pending|accepted`, → `indeterminate`: needs-you, and
**no automatic redispatch**, even with the same engine process alive (the 5.8 cache is in-memory and evictable,
and `sessions.list` activity cannot identify an action). The person may start a new attempt explicitly.
- **Seam** (unbuilt; O21 behind O25's proof): the bridge plugin registers `before_agent_run` (gate, fail-closed on
  timeout; emitted by the embedded and CLI runners only, so not on Codex/Copilot harnesses). While a resume is open
  on `sessionKey` it allows a run only when `ctx.runId === key` after the host durably records `submitted`, and
  blocks every other run on that session (including restart-recovery turns) and any run without `ctx.runId`. Only
  with that proof may a missing `submitted` marker trigger one automatic redispatch at `attempt + 1`.

**Origins.** The origin and site come from the host, never the model or the app. `knownIdps` are exact origins
(default `https://accounts.google.com`, `https://login.microsoftonline.com`, `https://login.live.com`,
`https://appleid.apple.com`, `https://github.com`); no registrable-domain, wildcard or tenant trust. The shown
origin states the address bar; it is never presented as proof of legitimacy.

**Live view** (O22). Each viewer is its own broker client with its own screencast, delivered on link stream
`oc.browser.live` with paced writes (slow viewers drop frames). Frames never reach disk, logs, transcripts, relay
jobs, telemetry or the agent. `oc.browser.thumb`: ≤ 320 px wide, ≤ 1 per 5 s. While a request is open every viewer
but the lease holder gets `private`. States `connecting → live → reconnecting → live | ended | failed`; the control
stream is the lease keepalive; watching makes no model or tool call. `kind: 'desktop'` is the engine's
`desktop.observe` pass-through, labelled as a whole screen, never offering takeover.

**Recovery.** Pipe close or Chromium exit → `recovering`, ≤ 3 attempts (1, 5, 15 s), else
`blocked: 'recovery-exhausted'` with plain words in the agent's tool result; open requests follow the restart rules.
`engine-detached` comes from the kit's own `browser.request GET /` probe failing while the broker is up.

**Link ops.** View: `oc.browser.state`, `oc.browser.signins`, `oc.browser.thumb`, stream `oc.browser.live
{ mode: 'observe' }`. Control: `oc.browser.{takeover, confirmorigin, done, notnow, reopen, retry, cancel, forget}`,
stream `oc.browser.live { mode: 'control', lease }`. All member-checked via `memberOf(grant)`; while `held`,
`done`, `notnow`, `cancel` and `confirmorigin` need the lease bound to that grant; revoking a grant closes its streams
and lapses its leases. Device: `BrowserDevice`.

**Words** (O22, `words.json`): `signin.title` "Sign in to {site}", `signin.takeover` "Take over to sign in",
`signin.notNow` "Not now", `signin.done` "Done signing in", `signin.confirmSite` "First time {name} signs in to
{site}. Type the site name to continue.", `signin.offOrigin` "You're now on {origin}, not {site}. Continue only if
you expected this.", `signin.agentNote` "{name} says: “{note}”", `signin.waiting` "{name} needs you to sign in to
{site}.", `signin.parked` "Sign-in to {site} is waiting for you.", `signin.checking` "Sign-in details entered",
`signin.verified` "Signed in to {site}", `signin.noVerifier` "Sign-in details entered for {site}. {name} can't
confirm you're signed in.", `signin.stillSignedOut` "{site} still shows a sign-in page. Try again?",
`signin.expired` "The sign-in request for {site} timed out.", `signin.cancelled` "Sign-in to {site} was
cancelled.", `signin.originMismatch` "You finished on a different site than {site}, so {name} won't continue.",
`signin.insecureRemote` "{site} isn't secure, so taking over to sign in is off.", `signin.browserGone` "{name}'s
browser closed during sign-in.", `signin.superseded` "A newer request replaced this one.", `signin.runReplaced`
"This task moved on, so the sign-in request was closed.", `signin.resumeFailed` "Signed in, but {name} couldn't
continue. Try again.", `signin.resumeUnknown` "Signed in, but we can't tell whether {name} continued. Check the
task before retrying.", `signin.gate` "Waiting for the person to sign in to {site}.", `signin.resume` "The person
signed in to {site}. Continue the task.", `signin.private` "Private while someone signs in",
`browser.recovering` "Reconnecting to {name}'s browser…", `browser.blocked.noBrowser` "No browser is set up for
{name}.", `browser.blocked.exhausted` "{name}'s browser stopped and could not be restarted.",
`browser.blocked.detached` "{name}'s browser isn't connected.", `browser.blocked.unsafe` "An agent here can run
commands or read files, so the browser stays off.", `browser.blocked.gateOff` "Browser handoff needs the tool gate
on.", `browser.blocked.unprotected` "Signing in for {name} isn't available yet.", `live.reconnecting`
"Reconnecting…". Action labels: `signin.cancel` "Cancel sign-in", `signin.reopen` "Continue signing in", `signin.retry` "Try signing in again", `signin.confirmOrigin` "Continue on {origin}", `live.label` "Browser live view". Browser-specific expiry/cancellation use `browser.signin.expired` and `browser.signin.cancelled`; the existing provider sign-in words remain unchanged.

**Limits.** No platform-authenticator passkeys or hardware keys (→ `entered-unverified`); session-only cookies do
not survive a browser restart; the profile at rest is protected by the precondition, not file modes;
`Target.attachToBrowserTarget` is experimental, so O25 is the pin-bump gate for this feature; frames show the
email and password length to the lease holder.

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

Exports as D2 (`./device` with `react-native`/`browser` conditions, plus a Node-only `./binary`). Dependencies (exact): `@byokit/link`,
`@byokit/relay`, `@byokit/discover`, `@byokit/seal` (current versions as 5.1), `ws` `8.21.3`. Dev (root):
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
      transport?: HerdrTransport; protocolRange?: HerdrProtocolRange; onState?: (s: HerdrState) => void;
      onLog?: (message: string) => void }
  | { mode: 'own'; bin: string; stateDir: string; env?: Record<string, string>; path?: string[];
      transport?: HerdrTransport; protocolRange?: HerdrProtocolRange; onState?: (s: HerdrState) => void;
      onLog?: (message: string) => void };
// A live subscription: call to unsubscribe. `ready` resolves true on the server ack and false on a
// rejected batch (reported via `onError`, never retried); the reconnect hooks fire only on later
// drops of an acknowledged socket. The kit's own watches log rejections to `onLog`.
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
  snapshot(): HerdrSnapshot;     // workspaces → tabs → panes → agents, kept current by events
  onChange(fn: (s: HerdrSnapshot) => void): () => void;
  // helpers
  startAgent(o: StartAgent): Promise<AgentRef>;
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
  worktree?: { branch?: string; base?: string };
  args?: string[]; env?: Record<string, string> | { env: Record<string, string>; unset: string[] }; timeoutMs?: number;   // default 60_000
};
export type OpenSignInTab = Omit<StartAgent, 'place' | 'worktree'> & { workspaceId: string; label?: string };
export type BusyHandoff =
  | { busy?: 'refuse' }
  | { busy: 'wait'; confirmed: { session: string; terminalId: string }; waitMs: number }
  | { busy: 'interrupt'; confirmed: { session: string; terminalId: string; seq: number } };
export type MoveToAccount = {
  provider: string; folder: string; env?: Record<string, string>;
  direction?: 'right' | 'down'; timeoutMs?: number; whenBusy?: BusyHandoff;
};
export type MoveToAccountResult = { ok: true; session: string } | {
  ok: false; code: 'too_early' | 'busy' | 'unsupported' | 'env_mismatch' | 'close_failed' | 'start_failed'
    | 'blocked' | 'changed' | 'interrupt_unsupported';
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
`maxFiles`, `maxBytes`), and optional result policy `{ schema, validate, maxBytes }`. `schema` is an
app-supplied JSON Schema sent as instructions; `validate(unknown): value is T` is the app's schema
validator. No provider API or additional billing path is introduced. `onTurnEnd(fn)` subscribes
app-wide; `onEnd` and the promise carry the same completed turn, exactly once.

Before delivery, the kit acknowledges a pane-specific Herdr status subscription, checks that the
agent is idle and its working directory matches, and snapshots that directory. Completion requires
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
  pidfile with the same cmdline check as 5.4; wait for the socket to answer `ping` (250/500/1000/2000 ms backoff,
  then fail `failed/socket`). Server exit while not stopping → `reconnecting`, respawn with the 5.4 backoff.
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
  frames parsed as `{event, data}` or legacy `data.type`; an error frame with `id: ""` is a rejected subscription:
  report it via `onError` and do **not** retry that subscription; other closes reconnect after 1 s (event socket) or
  2 s (per-pane). Start retries 250/500/1000/2000 ms, then the 1 s loop; the kit stays up (`reconnecting`).
- **Bootstrap** (Herdr docs): open `events.subscribe`, wait for its ack, buffer events, call `session.snapshot`,
  install it, apply buffered events in order, continue. Re-bootstrap after every event-socket reconnect. Unfiltered
  kinds subscribed: `pane.agent_detected`, `pane.created`, `pane.closed`, `pane.moved`, `pane.exited`,
  `pane.updated`, `workspace.created`, `workspace.closed`, `workspace.renamed`, `workspace.updated`, `tab.created`,
  `tab.closed`, `tab.renamed` (muxr's verified list); per-pane `pane.agent_status_changed` for every pane with an agent.
  Agent records merge partial events (`{ ...current, ...incoming }`); `pane.updated` titles and labels merge the
  same way with no re-bootstrap. A per-pane lifecycle epoch keeps a status push that races a snapshot read: the
  push stamps its pane before the read returns, and the install keeps the live status and revision over the read.

### 6.4 Helpers (`src/agents.ts`, `src/close.ts`, `src/approvals.ts`)

- `startAgent`: `worktree` → `worktree.create { cwd, focus: false, env?, branch?, base? }` and use its
  checkout as `cwd` (`branch` optional; absent fields are omitted, never sent null). Placement:
  `workspace.create { cwd, label, focus: false }` → `result.root_pane.pane_id`; `tab.create { workspace_id, cwd,
  label, focus: false }` → `result.root_pane.pane_id`; `pane.split { pane_id, direction, focus: false }` →
  `result.pane.pane_id`; `pane` → as given. The placement `env` rides every create/split call (the pinned
  `agent.start` has no `env` param). Then `agent.start { pane_id, kind, name?, args?, timeout_ms }` with call
  timeout `timeoutMs + 5 s`, retrying `agent_pane_busy`/`agent_pane_unavailable` inside a bounded 5 s budget.
  When the start fails, the pane the kit created is rolled back with `pane.close` (a caller-owned `pane`
  placement is never closed). Returns `{ paneId, name }`. Exact param spellings come from the generated
  types; where muxr and the schema disagree, the schema wins and H5 records it in `report.json`.
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

`moveToAccount(target, { provider, folder, env?, direction?, timeoutMs?, whenBusy? })` accepts mapped
managed kinds, including Claude (`CLAUDE_CONFIG_DIR`, `--resume <id>`), Codex (`CODEX_HOME`, `resume <id>`)
and Pi (`PI_CODING_AGENT_DIR`, `--session <id|absolute path>`). Hosts own cross-account history sharing.
Absent/launch-pending conversation → `too_early`; default working/blocked or concurrent move → `busy`;
unsupported agent/session kind → `unsupported`. The source account is never inspected.

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
guards; a folder, a passing readiness check or a fixture never declares a native move proven. Kinds without a folder
variable are tab only, labelled one sign-in per computer user, and the kit never reads the person's default CLI
credentials for them. Readiness probes run only with the managed folder's explicit env (D13) and otherwise report
unknown.

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
| `turn.failed` | This turn could not be confirmed. Check the helper before trying again. |

## 7. Connection adapters

Same shape in both kits; names below use `oc`/`hd`.

### 7.1 Host side (`./link`)

```ts
import type { Member, OpenClawKit } from '@byokit/openclaw';
import type { Grant, Host, HostOptions } from '@byokit/link';
import type { RelayClient } from '@byokit/relay';
import type { IncomingMessage, ServerResponse } from 'node:http';
type Via = 'auto' | 'tailscale' | 'tailscale-direct' | 'private' | 'lan';   // @byokit/discover
type ServeIngress = { kind: 'tailscale-serve'; port: number; dnsName: string; proxy: string };   // @byokit/discover
export declare function openclawLink(kit: OpenClawKit, o: {
  memberOf: (grant: Grant) => Member | undefined;          // which member a device acts for (e.g. grant.meta.member)
  passThrough?: (method: string, grant: Grant) => boolean; // D8; default () => false
  relay?: Pick<RelayClient, 'notify'>;                     // sealed approval push (7.3); RelayClient fits
}): Pick<HostOptions, 'handle' | 'stream' | 'allow'>;
export declare function serve(o: { host: Host; port: number; via?: Via; previous?: ServeIngress;
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
| `oc.state` *view* | — | `{ state: KitState, words: string, version, engine, signedIn? }`: this kit's package version, `ENGINE_VERSION`, and the providers the device member is usably signed in to while `ready` (live `providerStatus` by 5.8, preparing admission; absent when not ready or status is unknown, never `[]` for unknown) |
| `oc.routes` *view* | — | offered routes only (`offer: true`) |
| `oc.signin.start` | `{ provider, via }` | `SignInView` (kit picks `routeFor(provider, via)`) |
| `oc.signin.view` *view* | `{ provider }` | `{ ready, view: SignInView \| null }` for `toAccountView` |
| `oc.signin.paste` | `{ provider, text }` | `null` |
| `oc.signin.cancel` | `{ provider }` | `null` |
| `oc.signout` | `{ provider }` | `null` |
| `oc.sessions` *view* | — | `sessions.list` filtered to the member's keys (member agent and account agents, D9) |
| `oc.run` (stream) | `{ sessionKey?, message, model?, account?, needs?, auth?, system?, images?, thinking?, tools?, schema? }` (`account` an id of the member's, `'default'` or `'auto'`; `auth` only `'apiKey'`) | frames `RunEvent` then `{ type: 'end', end: RunEnd }`; key defaults to `agent:<member>:link:<uuid>`; options are type-checked (`thinking` one of `off|low|medium|high`, `images` `{ data, mimeType }[]`, `needs` a `'provider/model'` string array refused like a malformed `model`); a `tools` name outside `kit.toolNames()` → `link.notAllowed` |
| `oc.steer` | `{ sessionKey, text, auth? }` | `null` (key must be the member's, D9) |
| `oc.abort` | `{ sessionKey, auth? }` | `null` (key must be the member's, D9) |
| `oc.accounts` *view* | — | `Account[]` (5.15) |
| `oc.account.add` | `{ provider, via?, name?, again? }` | `{ id, view: SignInView }` (kit picks `routeFor(provider, via)`; a `key` field → `link.notAllowed`, keys are host-only) |
| `oc.account.view` *view* | `{ id }` | `{ ready, view: SignInView \| null }` for `toAccountView` |
| `oc.account.paste` | `{ id, text }` | `null` |
| `oc.account.cancel` | `{ id }` | `null` |
| `oc.account.rename` | `{ id, name }` | `Account` |
| `oc.account.remove` | `{ id }` | `null` |
| `oc.models` *view* | `{ id }` | `ModelInfo[]` |
| `oc.room` *view* | `{ id, demand? }` | `Room` |
| `oc.defaults` *view* | — | `Defaults` |
| `oc.defaults.set` | `Defaults` | `null` |
| `oc.pick` *view* | `RunSelection & { sessionKey? }` | `AccountPick` |
| `oc.move` | `{ sessionKey, to }` | `MoveResult` (key must be the member's) |
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
import type { Account, AccountId, AccountPick, AccountRef, Defaults, ModelInfo, Room, RunSelection } from '@byokit/accounts';
import type { AccountView, Approval, Decision, GatewayEventName, GatewayEventPayload, GatewayMethod, GatewayParams,
  GatewayResult, KitState, OutputSchema, Route, RunEnd, RunEvent, SchemaOutput, SignInView } from '@byokit/openclaw';
import type { DeviceLink } from '@byokit/link';
import type { AgentRef, AgentStatus, BlockedAgent, HerdrEventName, HerdrEventOf, HerdrMethod, HerdrParams, HerdrResult,
  HerdrSnapshot, HerdrState, HerdrSubscription, PromptReceipt, StartAgent } from '@byokit/herdr';
type MoveResult = { ok: true; session: string } | { ok: false; code: 'too_early' | 'busy' | 'unsupported' |
  'env_mismatch' | 'close_failed' | 'start_failed'; message: string; live?: string };   // 5.15
export type OpenClawLinkEvent =                             // oc.events frames
  | { [E in GatewayEventName]: { event: E; payload: GatewayEventPayload<E> } }[GatewayEventName]
  | { event: 'approval'; change: 'added' | 'resolved'; approval: Approval };
export type SessionRow = { sessionKey: string; [k: string]: unknown };
export type DeviceRunOptions<S extends OutputSchema | undefined = OutputSchema | undefined> = { schema?: S; sessionKey?: string; model?: string; account?: AccountRef | 'default' | 'auto'; needs?: string[]; auth?: 'apiKey'; system?: string;
  images?: { data: string; mimeType: string }[]; thinking?: 'off' | 'low' | 'medium' | 'high'; tools?: string[] };
export type DeviceState = { state: KitState; words: string; version: string; engine: string; signedIn?: string[] };
export declare function openclawDevice(link: DeviceLink): {
  state(): Promise<DeviceState>;                            // oc.state
  routes(): Promise<Route[]>;
  signIn: { start(p: string, via: 'browser' | 'code'): Promise<SignInView>; view(p: string): Promise<AccountView>;
            paste(p: string, t: string): Promise<void>; cancel(p: string): Promise<void> };
  signOut(p: string): Promise<void>;                        // oc.signout
  sessions(): Promise<SessionRow[]>;                        // oc.sessions
  accounts(): Promise<Account[]>;                           // oc.accounts … oc.move (5.15)
  account: { add(provider: string, o?: { via?: 'browser' | 'code'; name?: string; again?: AccountId }): Promise<{ id: AccountId; view: SignInView }>;
             view(id: AccountId): Promise<AccountView>; paste(id: AccountId, t: string): Promise<void>;
             cancel(id: AccountId): Promise<void>; rename(id: AccountId, name: string): Promise<Account>;
             remove(id: AccountId): Promise<void> };
  models(id: AccountId): Promise<ModelInfo[]>; room(id: AccountId, demand?: string[]): Promise<Room>;
  defaults(): Promise<Defaults>; setDefaults(d: Defaults): Promise<void>; pick(sel: RunSelection, o?: { sessionKey?: string }): Promise<AccountPick>;
  move(sessionKey: string, to: AccountId): Promise<MoveResult>;
  run<const S extends OutputSchema | undefined = undefined>(message: string, o?: DeviceRunOptions<S>): AsyncIterable<RunEvent | { type: 'end'; end: RunEnd<SchemaOutput<S>> }>;
  steer(k: string, t: string, o?: { auth?: 'apiKey' }): Promise<void>; abort(k: string, o?: { auth?: 'apiKey' }): Promise<void>;
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
`linkWords`, `qrMatrix` from `@byokit/ui` cover pairing unchanged. The `accounts`, `account`, `models` and
`room` members are shaped so an app builds `@byokit/ui`'s `AccountsSource` from them with at most one line per
member (`providers()` from the offered routes; `add` with a `key` is host-only); O14's `fits` test checks it.

### 7.3 Relay, discover and seal

- **discover**: used only inside `serve()` (7.1); nothing kit-specific.
- **relay**: when `relay` is passed, each new `Approval`/`BlockedAgent` sends `relay.notify({ id: <approval id>,
  title: words('approval.notice'), data: { v: 1, sealed: b64url(sealBox(JSON.stringify(approval),
  box)) }, to: [grant.id], actions: ['allow', 'deny'] (OpenClaw) / none (Herdr), urgency: 'high' }, {
  includeContent: true })` once per device that registered a box key and may see it; the relay reads only the
  generic title. `onAction` for `allow`/`deny` calls `kit.decide(id, …)` after the same member check and
  requires a control grant, as `oc.decide` does. The app authenticates the action transport and makes
  `memberOf` refuse revoked grants; see [OpenClaw SECURITY.md](../packages/openclaw/SECURITY.md). Devices
  without a box key get the generic title only (`includeContent: false`).
- **seal**: `src/notices.ts` holds `sealNotice(approval, boxPublicKey)` and (portable, re-exported by `./device`)
  `openNotice(data, seed)` → `openBox` → JSON → shape-checked `Approval` or `null`.
- **ui**: 5.14 `toAccountView`; `stateWords`; ui itself unchanged.

## 8. Example apps

Two standalone apps that install **published** packages only (no workspace links, no Crewhouse or muxr source):

```
examples/openclaw-kit/  package.json  host.ts  web/index.html  web/app.ts  README.md  e2e.test.ts  LIVE.md
examples/herdr-kit/     package.json  host.ts  web/index.html  web/app.ts  README.md  e2e.test.ts  LIVE.md
```

- `package.json`: `"private": true`, dependencies on the kit and `@byokit/link`, `@byokit/discover`, `@byokit/relay`,
  `@byokit/ui-core`, `@byokit/seal` at exact published versions, `esbuild` (dev) to bundle `web/app.ts`. Scripts: `start` (`node
  host.ts`), `build:web`, `test` (`node --test e2e.test.ts`). Not part of the root workspaces.
- `host.ts` (OpenClaw): `new OpenClawKit({ stateDir: './.state', tools: [demo_note], host,
  config: { plugins: { allow: ['openai'] } } })` where `demo_note`
  (`{ text: string }`) is gated `{ ask: { summary: 'save a note' } }` and appends to `./.state/notes.txt`;
  `hostKeyFile('./.state/link-key.json')`; link `Host` with `openclawLink(kit, { memberOf: () => 'me' })`, grants
  in `./.state/grants.json`; `serve({ host, port: 7310 })`; also serves `web/` over plain HTTP on the same port;
  prints the offer as a terminal QR from `qrMatrix` and asks `Pair <name>? (y/n)` on stdin for `confirm`.
  Herdr: `new HerdrKit({ mode: 'own', bin: <from --herdr flag, absolute>, stateDir: './.state' })`, grants carry
  `meta.scope = { workspaces: 'all' }`, same link wiring with `herdrLink`.
  Both: `--relay <url>` (and `--enrol <token>`, first start only) opens a `RelayClient` once the host is open and
  passes the kit `relay: { notify }` reaching it (OpenClaw also `onAction`); the offer adds `linkUrl(relay, host.id)`,
  the terminal prints the relay's short code, and op `example.push` hands a device's push address to
  `relay.subscribe(grant.id, …)`. The page takes no push itself; a phone app registers its notice key, sends its
  push address and opens what arrives (7.3).
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
  person-visible text equals `words.json` sentences. Away from home: a loopback `Relay` whose push `fetch` is a
  recorder, a Node device pairing by `findHost` + `pairWithCode`, registering a notice key and an Expo token; the
  pushed message must carry the generic title, none of the approval's or question's text, and open only with the
  device's own seed (OpenClaw: Allow through `/relay/v1/push/action` saves the note).
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
Sol later: O14 (O11, accounts Auto + fixture, ui AccountsSource)
Sol later: O15 (O11) ─┬─ O16 (lane 19 usage)
                      └─ O17 (R1 lane)
Browser (5.17): O18 ─┬─ O19 ─┐
                     ├─ O20 ─┴─ O21 ─┐
                     ├─ O22 (O20) ───┴─ O25 → with O17, the handoff enable gate
                     └─ O23 ─ O24 (Opus frontend)
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
  test checks shape: billing ∈ {subscription, api, local}, `offer` boolean, reason non-empty); native `anthropic-cli` is offered; `setup-token` is not offered (`no_upstream_flow`); every API-billed route stays off by default and carries its billing label. `migrate.test.ts` (no engine, doctor stubbed via an injected runner): staging shape
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
  has a sentence; `toAccountView` result is assignable to `@byokit/ui`'s `AccountView` (type test) and
  `phaseOf` yields `opening`, `waiting`, `code`, `done`, `busy`, `cancelled`, `expired`, `failed` for the matching
  inputs.

**O11 — real-engine integration** · Sol · deps: O3, O4, O5, O6, O8 (O7 merged)
- Files: `test/engine/contract.test.ts`, `test/engine/run.test.ts`, `test/engine/generated.test.ts`, fixes inside
  O3–O8 files only where the real engine disagrees with the fake (each fix also updates the fake and contract).
- Acceptance: `openclawContract` passes against `fakeGateway` (in `npm test`) **and** against the real pinned engine
  with `startModelStub` (engine job); `run.test.ts` = Crewhouse `openclaw-run.test.ts` ported (real tool call crosses
  the fail-closed gate; keyword-only memory never requests embeddings; no `/v1/embeddings` call); `generated.test.ts`
  regenerates the tables from the pinned tarball and diffs the committed ones; `hello.features.methods` ⊇ every
  generated operator method (else list them in `report.json` and fail); every offered app-guided route starts on the real
  engine with its provider plugin allowed by default; `exec.approval.requested`/`plugin.approval.requested` from the real engine
  carry the requesting member in `Approval.member`.

**O12 — example app** · Flash · deps: O9, O11
- Files: `examples/openclaw-kit/*` (section 8), root `README.md` examples line, CI `browser` job step running
  `examples/openclaw-kit/e2e.test.ts`.
- Acceptance: `e2e.test.ts` green in CI against the fake; README steps followed verbatim in a clean temp dir with
  packed tarballs work (the test does exactly this); `LIVE.md` present with the procedure (the live run itself is a
  lab task for firstmate, recorded later).

**O14 — accounts as agents** · Sol · deps: O11; `@byokit/accounts` Auto (`chooseAccount`/`resolveSelection`) and
its fixture; `@byokit/ui` `AccountsSource` (for `fits`) · version: openclaw next minor
- Files: `src/accounts.ts`, `src/pick.ts`, `src/locks.ts`, `plugin/accounts.js`, `src/types.ts`, `src/kit.ts`,
  `src/runs.ts`, `src/members.ts`, `src/approvals.ts`, `src/bridge.ts`, `src/signin.ts`, `src/config.ts`,
  `src/engine.ts` (copies `plugin/accounts.js`), `src/link.ts`, `src/device.ts`, `src/words.json`, `src/words.ts`,
  `src/testing/fake-gateway.ts`, `test/accounts.test.ts`, `test/pick.test.ts`, `test/engine/accounts.test.ts`, the
  link/device/words/config tests they touch, README, CHANGELOG, and the `plugins.allow` sentence in `AGENTS.md`.
- Behavior: D9, D11, D17, 5.6 (isolation, plugins), 5.7 sign-out, 5.15, 7.1/7.2 account rows. The fake gateway gains,
  per agent: `agents.delete`, `agents.files.get/set`, `models.list { agentId }`, `sessions.resolve { allowMissing }`,
  `sessions.create { fork }`, `sessions.delete`, `sessions.list` `hasActiveRun`, `openclaw.setup.activate`,
  `byokit.accounts`, the `model@<profile>` write on sign-in, an `accountId` and `email` on each sign-in's profile
  (settable per test, or absent), a hook that writes a refreshed profile at a chosen step, and a cold usage cache (no
  `usage` on the first read).
- Acceptance: `pick.test.ts` runs every row of `fixtures/conformance/auto-pick-typescript.json`, including an API-key
  account never chosen by Auto or a default fallback; rows for each `why` (one candidate, more room, equal room and an
  earlier reset, a full tie, unknown room only, all exhausted), each `out` code, a known reading without `at` staying
  in tier A with `age: 'unknown'` while one with an old `at` drops to tier B, tied `left` with one or both
  `resetsAt` absent, the `auto: false` fallback (`first_ready`), `auth: 'apiKey'` (`chosen`), a chosen API-key or
  resting account carrying no `out`, `bound` narrowing candidates (`out: 'bound'`), and a demand whose `needs` model
  one account lacks (`out: 'model'` with `missing`; chosen by id → `not_included`). `accounts.test.ts` with `fakeGateway`: two ChatGPT accounts sign
  in to two agents and run independently; a run on an account emits the `account` event first and ends with
  `account`/`model`; `'auto'` picks by room and never switches mid-run; a second run on the same app key stays on the
  account that holds it; a resting end sets `until` and the next Auto skips it; a bound key refuses another account,
  and an API-key conversation refuses `'auto'`, before any request; an account whose `ready` fails ends `signed-out`
  with no `agent` request; `pick` with a key equals the `account` event of a run started with that key on the same
  state, `considered` included, for an unbound key, one bound to an account agent and one bound to the member agent,
  and refuses identically (`bound`, `paid`) where the run ends `kind: 'other'` with the same message; a member-agent-bound `'default'` whose default
  account is on another agent falls back (`out: 'bound'`); `needs` without `account` runs as `'default'`;
  a bound run whose account lacks a `needs` model ends `plan` with no `agent` request; `room` never carries `at`,
  skips a window without a numeric `usedPercent` (only such windows → `{ left: 'unknown' }`), and answers the same
  with a demand as without; identity (the fake stores an `accountId` per sign-in): a sign-in with an
  existing account's identity adopts into it and leaves one row (duplicate identity), also when its email changed;
  `again` = X signing in to another identity adds a row and X's next run still bills X (wrong-account re-auth); a
  sign-in without an account id adds a row even with the same email and `again` (missing identity); `again` = Y
  signing in to X's identity adopts into X and leaves Y untouched; adoption keeps every field of the profile record,
  an extra unknown one included; a refreshed profile the fake writes between `clear` and `agents.delete` (with no
  order, and expired), one written after the directory is removed, and one written after `removeAccount` returned
  (swept on the next `prepare`) leave no profile file under `<root>`, and the entry is dropped only after the
  directory is gone (removal racing refresh); `adopt` with another `who` answers `{ ok: false }` and changes nothing;
  two pre-O14 accounts sharing a `who` adopt into the earlier `addedAt`; the member agent signing in again to its
  signed-out account's `who` adopts nothing and clears nothing; no `who` or account id
  in `accounts()`, views, `considered`, words, errors, events or link frames; an email appears only as
  `Account.email`, never in `considered`, words, errors, events or the index; an unindexed `<member>--<hex6>` agent is never listed or reachable; `removeAccount`
  refuses while live, never touches the member agent's sign-in, and leaves no profile behind; `move` forks then
  deletes, `busy` while live, `close_failed` keeps both; `addKey` failure leaves no agent; the index file is 0600;
  a same-identity re-sign-in (and `again`) leaves the existing account's
  default-model run working; a canary token held by two accounts never appears in the index, `accounts()`, views, words, errors, events or link
  frames; with no account agents, every existing test's requests stay byte-identical; an existing old-rule member id
  still runs. Engine job (`test/engine/accounts.test.ts`, stub model): two account agents each billed on its own
  profile; with the member agent signed in to a provider and `authInheritance` forced, a signed-out account agent of
  that provider ends `signed-out`, and a second member never runs on the first member's sign-in; removing an account
  leaves the member agent `ready` and no file of the removed agent under `<root>`; a pre-O14 two-member state reads
  the second member `signed_out` for the first member's provider; `IDENTITY.md` is byte-identical after `addAccount`; `plugins.allow` holds every
  offered route's plugin; `move` carries the transcript (user and tool rows) to the target agent; an API-key account
  never serves an `'auto'` run. ui `fits`: an at-most-one-line-per-member adapter builds `AccountsSource` from
  the device client.

**O15 — bundled engine patch packaging** · Sol · deps: O11 · version: openclaw next minor
- Files: `engine/patches.json` (empty set), `engine/OPENCLAW-LICENSE`, the derive/check script, `src/engine.ts`
  (set build, manifest verification, adoption), `src/auth-store.ts` (archive walk skips the sets directory),
  `src/types.ts` (`why: 'engine-patch'`, `patchSet`), `test/engine-unit.test.ts`, `test/engine/sets.test.ts`,
  `scripts/pack-smoke.ts`, README/NOTICE lines, `changes/bundled-engine-patches.md`.
- Behavior: 5.16 patch set, engine sets and rollback rules.
- Unit (fake trees, labelled unit, not qualification): manifest mismatch for an extra, missing, changed, re-moded
  and re-linked entry; lost-rename codes; own temporary cleanup; pointer write; a symlinked sets directory refused.
- Engine job (real processes; no namespace, `/proc` or process mock): (1) a stock Gateway launched the old way from
  `X/node_modules` (title rewritten, unmarked) and a new-kit Gateway from set A of `X` run while a second kit prepares
  `X` with another set and with the empty set: full-tree sha256 of `X/node_modules` and of A are unchanged and both
  Gateways answer health; (2) patched-file-only drift and (3) unpatched-file-only drift, each separately on one state
  directory across repeated `prepare()` of an already adopted set: the second `prepare()` detects it, leaves A byte
  for byte and adopts a fresh sibling, while A's Gateway keeps answering; (4) a real `doctor --fix` from a set leaves
  its manifest unchanged and reaches `ready`; (5) switching sets keeps health and plugin listing (a stale plugin
  index rebuild warning is expected); (6) with a verified stock set present, building a patched set makes no
  registry request; (7) two kits racing one set leave one final set, both launch it, no temporary directory remains;
  (8) the measured full-verification time on the real tree is printed and recorded in the PR.
  Packed install: the packed tarball installed into a clean directory runs a real `prepare()` from registry deps and
  reports the expected `patchSet`; `--check` re-derives the set byte for byte.

**O16 — engine-started usage (R4-1)** · Sol · deps: O15; lane 19's `usage.ts` merged or rebased onto
- Files: R4-1 entry in `engine/patches.json`, ledger and boot env in `src/engine.ts`, boot records, the read method
  in `plugin/index.js`, a typed reader module beside lane 19's `usage.ts` (lane 19 keeps its file and API),
  `test/engine/usage-*.test.ts`, `changes/engine-started-usage.md`.
- Acceptance (real kit, patched engine, scripted loopback provider, no account): (1) Skill Workshop review scheduled
  by the engine (never dispatched by the test) lands one counted charge; the day total equals transcripts plus that
  charge, a caller cap between the two trips only on the sum, and a second read is identical (no double count);
  (2) memory flush: crossing the soft threshold, the flush's provider usage is in the day total through the
  transcript term and the ledger is unchanged; (3) restart recovery: after a real crash the recovery turn's usage is in
  the day total through the transcript term, and the total equals the provider-reported usage of the turns that ran;
  (4) SIGKILL during a review reads `pending` before restart and `interrupted`, `complete: false` after;
  (5) failed write: make the month file unwritable while one review runs and restore it for the next; assert `failed`
  equals the number of fact writes the test observed failing (not a fixed count), a `seq` hole at each, the later
  review's facts present, and `complete: false` for that window before and after a clean restart, never `true`;
  (6) month windows: a read of one month opens only that month's files, and a boot whose counters show a failure only
  in an unread month still allows `complete: true` for the read month when rules 1–4 hold; (7) cold cache reads
  `unavailable`, never zero.

**O17 — app-owned sessions (R1-1)** · Sol · deps: O15 · owner: the R1 lane
- Files: R1-1 entry in `engine/patches.json`, `KitOptions.appOwnedSessions` and its env in `src/engine.ts`/`src/kit.ts`,
  R1 regressions, `changes/app-owned-sessions.md`.
- Acceptance: a real crash and restart leaves an opted-out session with no engine recovery turn and one app
  continuation; non-opted sessions keep the measured stock recovery exactly (no cap asserted); cancellation and
  tombstone fixtures stay with R1.

**O18 — browser handoff types (5.17)** · Opus · deps: none
- Files: `src/browser.ts` (types only), type re-exports in `src/index.ts` and `src/device.ts`,
  `changes/browser-handoff-types.md`, this section. Landed with the spec.

**O19 — browser broker** · Sol · deps: O18
- Files: `src/browser/broker.ts`, `test/browser/broker.test.ts` (fake pipe peer, offline),
  `test/engine/browser-broker.test.ts` (real Chromium from an explicit path, loopback fixture site; skipped without
  one locally, required in the engine CI job), `changes/browser-broker.md`.
- Acceptance: no TCP listener in Chromium's process tree; token, `Origin` and `Host` refusals; Playwright
  `connectOverCDP` through the broker while a second client screencasts; held targets absent from every agent-side
  event, `/json/list` and attach; a token holder's earlier init script, binding and Fetch interception produce zero
  hits of a fake secret typed in the private tab; history and popups gone after release; downloads refused while
  fenced; in-flight agent command at fence waited out and the agent tab usable after release; stale epoch/nonce and
  second controller refused; exact-origin input pause (wrong scheme, look-alike, sibling host, alternate tenant).

**O20 — browser host** · Sol · deps: O18 (O19's interface; may start on a fake broker)
- Files: `src/browser/{host,store,verify,resume}.ts`, `test/browser/host.test.ts`, `changes/browser-host.md`.
- Acceptance: settle exactly once under concurrent done/cancel/expiry; lease lapse rules; verifier rules
  (anonymous 200 page → `entered-unverified`, only the positive fixture verifies); resume key persisted before
  dispatch; crash before dispatch, after accept before marker and after marker, each with unrelated activity on
  another session, ends `indeterminate` with no second dispatch; restart rules per state; recovery bounded at 3.

**O21 — browser kit wiring** · Sol · deps: O20
- Files: `src/kit.ts`, `src/config.ts`, `src/types.ts` (`KitOptions.browser`, `kit.browser`), `plugin/index.js`
  (pre-gate, `request_sign_in`, `before_agent_run` seam off until O25 proves it), `test/browser-kit.test.ts`,
  `changes/browser-kit.md`.
- Acceptance: all-agent precondition (a non-browser member, account agent or delegate with `exec`, a file tool or
  an unknown tool blocks every browser); `gate-off`; enable gate (`handoff-unprotected` without O17 coverage or the
  proven seam); profile rewrite with two members (`profile` absent, `user`, `openclaw`, `node` all pinned or
  refused); run refusal and `run-replaced`.

**O22 — browser link, device and words** · Flash · deps: O20 types
- Files: `src/link.ts`, `src/device.ts`, `src/words.json`, `test/browser-link.test.ts`, `changes/browser-link.md`.
- Acceptance: view/control roles; lease-bound actions; revoke closes streams; `oc.call` refusals; portable and
  React Native import checks; reconnect states with zero model calls (stub request count).

**O23 — browser fakes** · Flash · deps: O18
- Files: `src/testing/browser.ts` (`fakeBrowserHost`, `fakeBrowserDevice`), `src/testing/index.ts`, contract suite.
- Acceptance: the suite passes on the fake now and on the real host once O20 lands.

**O24 — browser UI** · Opus frontend · deps: O18, O23
- Files: `packages/ui` view models (`signInSheetView`, `liveViewStore`), `examples/openclaw-kit` sheet, live
  panel and chip, their tests and changes fragments.
- Acceptance: every `NeedSignIn` state and word renders; no secret-bearing value in view-model state; reconnect
  makes no model call.

**O25 — browser proof** · Sol · deps: O21, O22
- Files: `test/engine/browser-*.test.ts`, the CI browser job.
- Acceptance: the end-to-end path (real engine, model stub, loopback login site, private-tab takeover, fixture
  verifier, one resume with the persisted key); a fake password, OTP and email (plain, URL-encoded, base64) have
  zero hits in stateDir, `signins.json`, the Chromium profile, link/relay captures, push payloads, kit logs and
  agent-bound broker frames (with a positive control); restart in every state; Chromium crash recovery and engine
  reattach; the `before_agent_run` seam (`ctx.runId === idempotencyKey`, recovery turn blocked, missing `runId`
  blocked). Its result decides the enable gate together with O17.

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
| B6 | openclaw table from every pinned manifest, corrections above | `packages/openclaw/{scripts/gen-routes.ts,src/routes.json,src/routes.ts}` | F0 |
| B7 | explicit install of external provider plugins at the versions the pin names | `packages/openclaw/src/{engine.ts,plugins.ts}` | B6 |
| B8 | sensitive wizard steps | `packages/openclaw/src/signin.ts` | B6 |
| B9 | herdr kind table, folder per kind, managed-folder readiness | `packages/herdr/src/{kinds.json,accounts.ts,agents.ts}` | F0 |
| B10 | portable device-code engine for every device route; missing client ids are `needs_client` | `packages/accounts/src/device.ts`, a device-code fixture | B1, B5 |
| X3 | usage reads a credentials file only inside a managed folder | `packages/usage/src/providers.ts` | — |
| C1 | named catalogue import: key, plan-key, local, endpoint and cloud rows from exact release snapshots | `scripts/gen-parity-routes.ts`, `packages/accounts/src/routes.json` | B2, B3, B4 |
| C2 | further device-code flows | `packages/accounts/src/flows/*` | B5, B10 |
| C3 | further OAuth browser and paste flows. Google routes: **proceed** — both Google routes (`google-gemini-cli` and `google-antigravity`, browser and paste) kept in scope, plain sign-in, offered once their sign-in flows land (`google-gemini-cli` browser and paste landed with WP6-S3; `google-antigravity` waits for WP6-S5); no terms gate and no approval step. Recorded facts, not offer gates: the Gemini CLI individual-plan sunset (muxr research `pock-multisub-landscape/report.md:79`) and Antigravity's terms naming third-party OAuth as a suspension ground with the mass-ban incident (`:80`, `:81`); the Antigravity CLI's own sign-in stays the supported path (`:611`). Settled: reuse the upstream public client ids, as the upstream implementations do, and use the upstream fresh-sign-in parameter, whichever the parity snapshot (`omp` v18.4.10 `cb0d5295`) uses. Client-id reuse is the parity report's rule-8 fact (`byk-account-parity/report.md` §10.8: `impersonation_ua` reported on 16 tuples, no legal assurance). Routes rows land with the flows, not here. | `packages/accounts/src/flows/*` | B5 |
| C4 | further setup-token, environment-token and free-tier rows | `packages/accounts/src/{accounts.ts,routes.json}` | B2 |
| C5 | non-model service rows: data, adapters, auth tests | `packages/accounts/src/routes.json`, tests | B2, B4 |
| U1 | ui connect view grouping every route (plans, pay per use, on this computer, your own server, cloud, services) | `packages/ui/src/connect.ts`, words | F0, B1, B6, B9 |
| U2 | examples list every route; no hardcoded provider | `examples/*` | U1 |

Acceptance for every package: its fixture rows, mocks and fakes in `npm test`; no live vendor sign-in is required.

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
- Accounts (read in the 2026.8.1 tarball for 5.15; O14's engine job confirms): `agents.create` takes only `name`
  (plus workspace, model, emoji, avatar) and derives the id with `/^[a-z0-9][a-z0-9_-]{0,63}$/i` lowercased, so `--`
  survives; a taken id fails `already-exists`; into an existing workspace it rewrites `IDENTITY.md`'s Name line.
  Growing past one agent stamps `agents.ownership: 'explicit'` and pins `agents.defaults.authInheritance.agentId` to
  the previous sole agent, whose store every agent then reads through (the owner is that setting, else the legacy or
  sole agent, else `main`). `agents.delete { agentId, deleteFiles? }` defaults `deleteFiles: true`, moving the agent
  dir and sessions to `$HOME/.Trash` but not a path another agent still owns. Credentials live in per-agent SQLite;
  a provider's local non-empty `order` is the only restriction over the merged store, an empty order is dropped on
  save, and `models.authStatus` reports merged profiles with no source flag and no per-profile identity (only a
  per-provider `usage.accountEmail`, absent on a cold usage cache; its `ts` is answer time, never reading age). A
  usage window is `{ label, usedPercent, resetAt? }`, with no model scope. A stored OAuth profile carries
  `accountId?` and `email?`; the ChatGPT sign-in fails when it cannot read an `accountId` from the token.
  `models.authLogout` without `profileIds` removes the provider's profiles from every owner store. `openclaw.setup.auth.start
  { agentId }` writes a fresh `<provider>:setup-<uuid>` profile into that agent's store and sets that agent's primary
  model to `provider/model@<that id>`. An explicit `provider`/`model` never falls back to another provider but may
  rotate between that provider's profiles. `models.list { agentId }` marks rows `available`/`unavailableReason`; it
  does not filter by plan. `sessions.resolve` errors on a missing key unless `allowMissing: true` (then `missing:
  true`). `sessions.move` and `sessions.fork` stay in one agent; `sessions.create { agentId, key, fork: true,
  parentSessionKey, model }` copies the raw transcript across agents and refuses while the parent runs or when it
  exceeds the target model's context.

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
