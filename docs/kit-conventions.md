# Kit conventions

The one place that says how every `@byokit/*` kit looks from the outside: names, codes, errors, results, state,
events, construction, options, words and export names. Kit specs ([runtime-kits.md](runtime-kits.md) §4,
[capability-kits.md](capability-kits.md) §3, [cloud-kit.md](cloud-kit.md) §3) link here instead of restating these
rules, and add only what is specific to their kits.

Status: **rules adopted for new code; the kit-name list (§1.2) is pending owner approval.** Each rule is the pattern
most kits already use, so following it usually means copying a neighbour. Existing kits that break a rule are listed
in §12; they come in line through deprecated aliases (§11.1), not in one breaking release.

**Precedence.** A kit spec's binding sections (runtime-kits.md per AGENTS.md, and the frozen signatures in
capability-kits.md and cloud-kit.md) win over this guide until they are amended. Bringing a spec'd export in line
with this guide is a spec change first, then code.

**Scope.** These rules cover a kit's public TypeScript API. Wire formats keep their own shape: formats owned by
someone else (OpenAI request and stream items in accounts, Herdr's generated protocol types, OpenClaw's gateway
frames, the recorder protocol in record) and byokit's own versioned wire protocols (the link and relay frames, keyed
by `t` with `{ ok, error }` answers). A kit translates at its edge instead of renaming another party's fields.

Contents: [1 Names](#1-names) · [2 Codes](#2-codes) · [3 Errors](#3-errors) · [4 Results](#4-results-or-throws) ·
[5 State](#5-state) · [6 Events and streams](#6-events-and-streams) · [7 Construction](#7-construction) ·
[8 Options](#8-options) · [9 Words](#9-words) · [10 Export names](#10-export-names) ·
[11 Changing a public name](#11-changing-a-public-name) · [12 Where the kits stand](#12-where-the-kits-stand)

## 1. Names

### 1.1 Rule

- A kit that integrates a third party keeps **the third party's name**: `openclaw` and `herdr` stay, and a future kit
  for another product is named after that product.
- Every other kit gets a **short, plain, one-word name** for the capability it gives an app (`accounts`, `decide`,
  `secrets`, `relay`).
- The package is `@byokit/<name>` in `packages/<name>`. `scripts/release.ts` assumes the directory name is the npm
  name and tags releases `<name>-v<version>`, so the two never differ.
- Name an unpublished kit before its first publish. Renaming a published kit costs a shim package and a deprecation
  (§11.2).

### 1.2 Kit names: pending owner approval

The owner rejected the first proposed name table. The four never-published kits were renamed on main (#142:
machine→cloud, capture→record, compose→write, status→statusbar) with no shims; their class, type, API and word-key
names kept the old words (`MachineError`, `CaptureError`, `ComposeError`, `capture.*` keys), which §3, §9 and §10
now ask to follow the kit. The owner also approved secrets (was keystore) for its first public release. The rest of the list is **pending owner approval** and is recorded here once approved.
Until then no other kit is renamed, and a new kit (such as the in-flight `connect`) confirms its name with
the owner before its first publish.

| current | published | third-party integration | name |
|---|---|---|---|
| accounts | yes | no | pending |
| cloud (was machine) | no | no | **cloud** (renamed in #142) |
| decide | yes | no | pending |
| herdr | yes | yes (Herdr) | **herdr** (by the rule) |
| secrets (was keystore) | no | no | **secrets** (owner-approved for first release) |
| link | yes | no | pending |
| openclaw | yes | yes (OpenClaw) | **openclaw** (by the rule) |
| overlay | yes | no | pending |
| reach | yes | no | pending |
| record (was capture) | no | no | **record** (renamed in #142) |
| relay | yes | no | pending |
| seal | yes | no | pending |
| statusbar (was status) | no | no | **statusbar** (renamed in #142) |
| ui-core | yes | no | pending |
| usage | yes | no | pending |
| write (was compose) | no | no | **write** (renamed in #142) |
| connect (in flight) | no | no | pending |

## 2. Codes

- Every machine-readable code is a **kebab-case** string literal in a named union: `'rate-limited'`,
  `'needs-update'`. No snake_case, camelCase or numbers.
- A code names the situation, including a missing precondition (`needs-update`, `needs-permission`). It never
  carries a secret, path or id.
- **Account limits share one vocabulary, owned by `@byokit/accounts`.** When an account cannot serve right now, the
  reason is one of:

  | code | meaning | carries |
  |---|---|---|
  | `signed-out` | the sign-in is gone, lapsed or refused; the person signs in again | |
  | `resting` | the provider is busy or overloaded; try again shortly | `until` (epoch ms) |
  | `not-included` | the plan does not include this model or feature | |
  | `rate-limited` | the plan's usage limit is reached | `until` (epoch ms) when known |
  | `network` | the provider could not be reached | |

  accounts exports the union. A kit that already depends on accounts imports it. A kit that does not depend on accounts
  (openclaw, ui-core and usage today; ui-core imports no kit by design) declares the same literal union under the
  same name, and a test pins it to accounts' list. A failure that is none of these is not an account limit and does
  not get a sixth "other" member: it is a failure of the calling kit (§3).

## 3. Errors

Every kit that can fail has one error class. Required: the `<Kit>Error` name, a set `name`, and a readonly `code` from
a kebab-case `<Kit>ErrorCode` union, which is what record, write, secrets and cloud share today. New classes
also take the optional `detail` and `cause` shown here:

```ts
// For a kit named "sample":
export type SampleErrorCode = 'invalid' | 'unavailable' | 'failed';

export class SampleError extends Error {
  readonly code: SampleErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: SampleErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'SampleError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}
```

- The class and its code union are exported from the kit's main entry. `name` is set, so logs and checks across
  bundles (`e.name === 'SampleError'`) work.
- `code` picks the words (§9). `message` is for logs and never shown to a person. Neither `message` nor `detail`
  holds a secret.
- `detail` is optional structured data for logs. A kit may add other readonly fields its spec names (record's
  `why`, cloud's `extra`) and documents each one.
- Wrapping another error passes it as the standard `cause`.
- **Bad data versus bad calls.** Data from outside the program (a person's input, a file, a stored record, a
  network answer) that the kit cannot use rejects with the kit's error, usually code `invalid`. A programming
  mistake in the call itself (a wrong argument type, a buffer of the wrong length, a method called before `start()`)
  throws the built-in `TypeError` or `RangeError` with no code and no words, as seal does.
- **Aborts** reject with `signal.reason`: `signal.throwIfAborted()` before work starts, then the same reason when the
  signal fires, as record's `make()` does. A kit does not invent its own "cancelled" error for an abort.
- Never attach codes to a plain `Error` with `Object.assign`.

## 4. Results or throws

- **Throw for failure.** Anything that stops the call from doing its job rejects with the kit's error.
- **Return a result union only for expected outcomes** that the caller handles on every call, where a throw would
  mean a `try` around every call: `{ ok: true, ... } | { ok: false, code, ... }`, with `code` from a kebab-case
  union. A model run that ends because the account is rate-limited is an expected outcome. A missing engine binary
  is a failure.
- A data field that says why a reading is missing (usage's `Reading.code`) follows the same code rules.

## 5. State

A kit with a long-lived process, connection or supervisor has one state object:

```ts
type HerdrState = { phase: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'needs-update' | 'missing' | 'failed';
                    why?: 'binary' | 'socket' | 'version' | 'server-exited' };
```

- `phase` is a kebab-case union. `why` is an optional kebab-case detail for the phases that need one. Extra fields
  are allowed when the spec names them (openclaw's `retryAt`).
- The kit exposes the object as a `state` getter and reports every change through the `onState?: (s) => void`
  option.
- Kits whose calls simply resolve or reject (write, record, decide, seal) have no state.

## 6. Events and streams

- Members of event, frame and step unions are keyed by **`type`**: `{ type: 'text', text } | { type: 'end' }`.
- Subscribing returns its own unsubscribe: `on(type, fn): () => void`, or `onX(fn): () => void` for a single stream
  of one kind. A kit never makes the caller keep a listener reference to remove it, and never exposes an
  `EventEmitter`.
- A sequence the caller consumes step by step (a recording, a run, a claim) is an `AsyncIterable` of `type`-keyed
  members. The caller stops it with `break` or an `AbortSignal`.

## 7. Construction

- The kit's main object is a class made with `new` and one options object, typed `<Class>Options`, with no I/O in
  the constructor (`new Capture(CaptureOptions)`, `new HerdrKit(HerdrKitOptions)`). When setup must finish before
  the object is usable, a static `await <Class>.open(options)` stands in for `new` (link's `Host.open`, relay's
  `Relay.open`).
- Pluggable parts (stores, providers, engines, adapters) come from **lowercase noun factories**: `fileStore(o)`,
  `memoryStore()`, `sshVm(o)`, `binEngine(o)`.
- `createX(native)` is only for React Native kits that wrap a native module (overlay, statusbar), so tests can pass a
  fake module. The kit's entries export the ready-made instance.
- A kit that is a single operation may be a function (`decide(...)`, seal's primitives).

## 8. Options

Use these names and types when a kit needs the thing at all:

| option | type | rule |
|---|---|---|
| `stateDir` | `string` | Absolute. The kit writes only under its own folder in it (its spec names any other); folders 0700, secret files 0600, atomic writes. |
| `fetch` | `typeof fetch` | Defaults to the global. Tests pass a fake. |
| `signal` | `AbortSignal` | Per call, in the call's options, never in the constructor. |
| `*Ms` | `number` | Every duration is milliseconds with an `Ms` suffix: `timeoutMs`, `pingMs`, `retryMs`. |
| `now` | `() => number` | The clock, epoch ms. Never a `nowMs` value. |
| `log` | `(line: string) => void` | Diagnostics for developers. Never a person-facing sentence, never a secret. |
| `onState` | `(s: <Kit>State) => void` | §5. |

**A kit never reads an environment variable.** The host passes every value. Spawned processes get an explicit env
built from nothing (runtime-kits D13), not a copy of `process.env`. The documented exceptions are a kit's own CLI bin
(decide's `byokit-eval`), a spec'd `PATH` read for a spawn (openclaw's `npm ci`), and accounts' `isolate()`, whose
whole job is to scrub and pin the process env for Pi when the host calls it.

## 9. Words

Every sentence a person can see lives in the kit's `src/words.json`, tested against the repo's banned-jargon
expression (the one `packages/herdr/test/words.test.ts` uses).

- `words.json` is a flat object. Keys are `<kit>.<key>` with a camelCase key: `herdr.needsUpdate`,
  `overlay.on`.
- The kit exports from its main entry:
  - `WORDS`, the parsed JSON, and `WordKey = keyof typeof WORDS`;
  - `words(key: WordKey, vars?: Record<string, string>): string`, which fills `{slots}` and **leaves a missing slot
    as `{k}`**, so a gap shows rather than going silently blank;
  - `stateWords(s)` if the kit has state (§5), returning `''` for a phase with nothing to say;
  - `errorWords(e)` if the kit has an error class (§3).
- UI code shows these functions' output. It never builds a sentence from a code.

Each kit's `src/words.ts` starts from the same helper:

```ts
import WORDS from './words.json' with { type: 'json' };
export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
```

## 10. Export names

- **One name, one shape, across the whole ecosystem.** An app that imports two kits must never find `Provider` or
  `fileStore` meaning two different things. Before exporting a name, grep `packages/*/src` for it.
- A kit-specific concept carries the kit's word in its name (`KeystoreErrorCode`, `HerdrState`, `OverlayState`),
  not a bare generic (`Code`, `State`, `Kind`, `Window`, `KitOptions`).
- A type that must be the same in two kits keeps the same name only while it keeps the same shape. That covers
  ui-core's mirrors of runtime-kit types, where a dependency is not allowed, and the §2 limit union.

## 11. Changing a public name

### 11.1 Deprecated aliases

A published export that is renamed or reshaped to meet these rules keeps its old name as a `/** @deprecated */`
alias for at least one minor release, with a changelog line naming the replacement. Old codes stay accepted for the
same period wherever the kit reads them back (stored state, wire input). For a spec'd export, the spec changes first
(Precedence, above).

### 11.2 Renaming a kit

`scripts/release.ts` uses the directory name as the npm name (`@byokit/${d}`) and in tags (`${dir}-v${version}`), so
a rename is:

1. Move `packages/<old>` to `packages/<new>`, set `"name": "@byokit/<new>"`, and start at the next minor.
2. Update the root `build` list in `package.json`, the `canonical` order in `scripts/release.ts`, every
   `"@byokit/<old>"` pin, the examples, the kit's spec and the lockfile. For herdr and openclaw the spec
   ([runtime-kits.md](runtime-kits.md)) changes first, because it is binding.
3. If `@byokit/<old>` was published, add a new `packages/<old>/` shim:
   - it depends exactly on `@byokit/<new>`;
   - it keeps the old `exports` map, each subpath one line: `export * from '@byokit/<new>/<sub>'`;
   - it is in the root `build` list, like any package;
   - its README is one line pointing at the new name, and its own `CHANGELOG.md` has an `## Unreleased` bullet
     saying the kit moved (`npm run release` refuses a package without one);
   - it has an exports test in the style of `packages/herdr/test/exports.test.ts`.
4. Publish the shim once through `npm run release`, then set it `private: true`, which holds it back from every
   later release.
5. **Deprecate the old name.** The owner runs, by hand:
   `npm deprecate '@byokit/<old>@*' 'Renamed to @byokit/<new>'`.
   `release.ts` has no deprecate step, and the OIDC publish workflow cannot run one. The step to add, with the first
   published rename, is: after publishing a shim, `release.ts` prints this exact command for the owner.

An unpublished kit needs only steps 1 and 2.

## 12. Where the kits stand

Audited against `origin/main` 9ee1846 on 2026-09-30, with kit names updated for the renames in #142 (75f5705). Counts exclude `src/testing` fakes.

| rule | follows it | breaks it |
|---|---|---|
| §2 kebab codes | record, write, secrets, cloud, relay (owner), usage, link; herdr's own codes | accounts `Kind` and `Status.state` (`signed_out`, `not_included`, `needs_again`) and `unsupported_account`; decide `invalid_config`; herdr passes Herdr protocol errors it does not translate through with their snake codes |
| §2 limit vocabulary | none yet | accounts `rate_limit`/`overloaded`/…; openclaw and ui-core `RunEnd.kind` use `plan` and `other`, and their `resting` also covers rate limits (it splits into `resting` and `rate-limited`); openclaw copies accounts' classifier; usage `Code` uses `not-connected`/`expired`/`auth`/`no-plan`/`unavailable`; decide maps plan refusals to `UnsupportedAccountError` and rate limits and overloads to a plain `Error('http N')` |
| §3 `<Kit>Error` | record, write, secrets, cloud (name and code; none takes `cause`, secrets has no `detail`; the classes keep the old kit words: `CaptureError`, `ComposeError`, `MachineError`, `KeystoreError`) | plain `Error` throws in herdr (38, some with `Object.assign` codes), openclaw (34), link (29), reach (24), relay (22), accounts (17), decide (10), statusbar (8), overlay (4); accounts `ResponseError` has `kind` and no `name` or `code`; link `LinkError` has no `name` |
| §3 aborts | record `make()` | record `record()` rejects `CaptureError('stopped')` when aborted before it starts (spec'd); accounts rejects with `Error('Login cancelled')`; decide wraps non-Error reasons; openclaw runs return `{ ok: false, aborted: true }` |
| §4 result code | usage `Reading.code` | openclaw and ui-core `RunEnd` key the failure as `kind` |
| §5 state | herdr, openclaw | accounts `state` field with snake values; link and relay `onStatus`; overlay (a `state` event) and statusbar (polling) use bare strings; cloud has `state()` plus a separate `why()` |
| §6 `type` key | accounts, herdr, overlay, statusbar, ui-core runs, openclaw runs | record `RecordEvent`, openclaw `OpenClawLinkEvent` and ui-core `ApprovalFrame` use `event`; cloud `ClaimStep` uses `step`; reach `BrowseHandle.on` and herdr `onReconnect`/`onDisconnect` return nothing |
| §7 construction | accounts, record, write, herdr, openclaw, link, relay, overlay, statusbar, seal, decide's `decide()` | cloud (`machine(o)`) and usage (`usage(o)`) are main objects made by factories; decide's `createDecider()` uses the React-Native-only prefix |
| §8 options | `stateDir`, `fetch`, `signal` everywhere they appear | herdr `onLog` (openclaw's `log` is the rule); usage `ReadOptions.nowMs`; ui-core `useSignIn({ ms })`, reach `scan({ ms })` and record `maxSeconds`; reach spawns tailscale with a copy of `process.env`; openclaw also writes `stateDir/logs` (spec'd) |
| §9 words | herdr, cloud and usage export `WORDS`, `WordKey` and `words` | record (`capture.*`) and statusbar (`status.*`) prefix every key with the kit's old name; herdr (`herdr.*` beside `agent.*`), write (`compose.*` beside `check.*`) and overlay (`overlay.*` beside `field.*`) prefix some; cloud's keys are area prefixes and some are kebab; record, write, overlay, statusbar and openclaw do not export `WORDS`, and overlay and statusbar not `WordKey`; accounts exports `say`, which fills a missing slot with `''`; link (`LINK_WORDS` in code), ui-core (English in code), relay and reach have no `words.json` |
| §10 one shape | | `Provider` (accounts, cloud, usage), `Usage` (decide, cloud, usage), `fileStore` (accounts, secrets), `Route` (openclaw, ui-core), `Member`, `Status`, `Platform`, `Kind`, `classify`, `Source`, `Engine`, `serve`, `routes`, `sealNotice`/`openNotice`, `HerdrState` (herdr vs ui-core), `ENGINE_VERSION`; bare `Code` and `Window` in usage; openclaw `KitState` and `KitOptions` |
