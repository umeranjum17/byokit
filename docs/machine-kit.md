# Machine kit: `@byokit/machine`

Foundation spec and builder breakdown. Status: **design approved for build (M0). Nothing here is implemented yet.**
This document is the single source of truth for the build lanes. A builder follows it literally. Where it is silent,
the builder stops and asks rather than designs. Section 14 is the work-package list.

Contents: [1 Goal](#1-goal) · [2 Decisions](#2-decisions) · [3 Where it fits](#3-where-it-fits) ·
[4 Public types](#4-public-types-srctypests-frozen) · [5 `Machine`](#5-machine-srcmachinets) ·
[6 Sandbox API adapter](#6-sandbox-api-adapter-srcsandbox-apits) · [7 SSH VM adapter](#7-ssh-vm-adapter-srcsshts) ·
[8 Installing and supervising](#8-installing-and-supervising-the-host-process) · [9 Reach](#9-reach-from-phone-and-web) ·
[10 Cost](#10-cost) · [11 Credentials](#11-credentials) · [12 Words](#12-words-srcwordsjson) ·
[13 Security, tests and isolation](#13-security-tests-and-isolation) · [14 Work packages](#14-work-packages) ·
[15 Known facts builders must not re-derive](#15-known-facts-builders-must-not-re-derive) ·
[16 Consumer gaps G1-G11](#16-consumer-gaps-g1-g11)

## 1. Goal

BYOKit gains one more capability kit, **`@byokit/machine`**: the person's own always-on machine somewhere else. It
does three things:

- puts an app's host process on a cloud computer the person rents, on their own account;
- keeps that process running;
- says what it costs them, as their own bill.

The person-facing words say "your cloud computer". Nothing in BYOKit names a machine provider: not code, docs, words,
tests, commits or PR text. The app passes the provider's address, a label to show, and dated price rows.

A person who wants their app's host process to stay on while their own computer sleeps, or who has only a phone, uses
it the way a coding app uses `@byokit/herdr`: the kit supplies the typed, tested integration; the app keeps its own
screens, recipe and decisions.

**Direction.** BYOKit stays self-hosted and operates nothing. A machine the person rents on their own account, with
their own bill, is still self-hosting: optional hosted or cloud pieces are opt-in and clearly labelled, and BYOKit
never runs a service, holds an account or picks a vendor for them. `README.md` carries this line (M0).

Out of scope: any service BYOKit would operate (relay, wake service, provider account, default URL), managing the
machine's OS, macOS or Windows machines, model credentials (they stay with the runtime kits), and adoption in any app.

## 2. Decisions

These close every design call. Builders do not reopen them; a reviewer who disagrees raises it with firstmate.

| # | Decision |
|---|---|
| D-1 | The name is `@byokit/machine`, a capability word. Rejected: a provider's name (capability-kits D-B), `sandbox` (already means OpenClaw's agent sandbox), `cloud` and `hosted` (read as a service BYOKit runs), `host` (collides with link's `Host`), `remote` (vague). |
| D-2 | No machine provider is named anywhere in BYOKit, with the capability-kits D-B strictness. Adapters are named for the API shape they speak: `sandboxApi()` and `sshVm()`. Test fixtures use the host `sandbox.test`. The provider's label comes from the app at run time. |
| D-3 | A capability kit, not a third aggregator. It sits beside `@byokit/openclaw` and `@byokit/herdr`: the app still picks one runtime kit, and that kit runs inside the app's host process on the machine exactly as it does at home. `@byokit/machine` only decides where that process runs. It imports no other kit and no kit imports it. `@byokit/accounts` is untouched. |
| D-4 | Two adapters behind one `Provider` type (4). **Sandbox API**: create, sleep, wake, snapshot, fork, remove, exec, write and an HTTPS URL per port, over `fetch` with no vendor SDK. **SSH VM**: any rented Linux box the person already created; exec, write, install and supervise only, through the `ssh` binary the app passes by absolute path. Optional `Provider` methods an adapter cannot do are absent, and the UI hides that action. |
| D-5 | Types in section 4 are frozen at M1. A change is a spec change first: stop and ask. |
| D-6 | Entries. `.` is portable (Node, Electron, React Native): types, `machine()`, `sandboxApi()`, `claim()` (M8), words, and M7's `wakeResolve()`; no `node:*` import. `./ssh` is Node only (`sshVm()`, `sshHostKey()`). `./idle` (M7) runs on the machine inside the host process and is portable. `./testing` is Node only: the fake provider and the contract suite. No other entries. The sandbox API adapter does not run from a web page (15.1), so browsers and PWAs set up from the phone app or a desktop app. |
| D-7 | One person, one provider account, one machine per app install. The kit refuses a `MachineRef` whose `account` differs from `provider.account()`. An app operator provisioning on its own account for users is pooling and is not supported. |
| D-8 | Model credentials are signed in on the machine, inside the aggregator (11). They are never copied from the person's computer and never pass through the provider's own credential features. Sandboxes are created with nothing of the person's passed in (`noEnv: true`). |
| D-9 | Reach: the person's own `@byokit/relay` runs on the machine beside the host (the relay README's "self-hosted, beside one host" model). Phones pair with the unchanged `@byokit/link`, whose Noise IK with a pinned host key is the only gate. No provider access token goes in any URL (9). |
| D-10 | v1 is always-on. Sleep and wake-on-open are designed here (5.4, 14 M7) and ship only after the real-provider proof (M6). |
| D-11 | Library code reads no environment variable (capability-kits D-G). Every spawned process gets an env built from nothing; argv is an array. |
| D-12 | Words. `src/words.json` holds the section 12 sentences, tested against the repo's banned-jargon expression (the one `packages/herdr/test/words.test.ts` uses). UI code shows `words(key, vars)`; it never builds sentences from states or codes. |
| D-13 | Fakes and contract (capability-kits 3.4): `./testing` ships `fakeProvider()` and `machineContract(make, o?)`. The same assertions run against the fake and each adapter's loopback or fake-bin bench in `npm test`, and against a real provider only in M6's lab run. |
| D-14 | Release: 0.1.0 `private: true`. It publishes only after M6's recorded run. `scripts/release.ts`' canonical order gains `machine` after `overlay` (M1). |
| D-15 | Isolation carve-out, added to `CONTRIBUTING.md` (Rules, Isolation first) and `README.md` (What byokit never touches) in M0: "`@byokit/machine` spawns only the `ssh` binary the app passes by absolute path, with the key path the app passes and a kit-owned config, and holds only the provider key the app's store gives it." |
| D-16 | Builders: **Opus** for spec, architecture and the real-provider proof; **Muse** for builds (14). This supersedes the Sol/Flash naming used in the older specs for this kit only. |

## 3. Where it fits

```
person's device: app UI ── @byokit/machine (create, install, wake, cost, words) ── provider REST API | ssh
the machine:     byokit-<app>.service → the app's host process (unchanged)
                   ├─ its ONE runtime kit: @byokit/openclaw (bots) | @byokit/herdr (terminals)
                   ├─ @byokit/link host + the person's own @byokit/relay  ← phone / web
                   └─ (M7) @byokit/machine/idle
```

- The kit runs on the **setup device** (a phone or a desktop app) for everything except `./idle`.
- Runtime kits' sentences say "this computer". On a hosted machine the app shows its own machine-aware sentences for
  any runtime-kit sentence it shows word for word; each app checks this in its own adoption, not here.
- Other hosts the types were checked against: a terminal-host daemon that dials out to its relay (fits `HostRecipe`
  if its recipe skips its own service install), an outbound pull daemon with no inbound port, and the recorder
  (`@byokit/capture`), which needs only `exec()`.

### 3.1 Files

```
packages/machine/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  src/
    index.ts          # '.' re-exports: types, machine, sandboxApi, claim, words, MachineError, estimate, keyWords, wakeResolve
    types.ts          # section 4, verbatim
    errors.ts         # MachineError (4.2)
    machine.ts        # machine() (5)
    unit.ts           # renderUnit(), quoting (8.2), pure
    recipe.ts         # recipe checks (8.1), pure
    node.ts           # node resolve/install steps (8.3), pure argv builders
    cost.ts           # estimate(), cost rules (10)
    sandbox-api.ts    # sandboxApi() (6)
    ssh.ts            # './ssh': sshVm(), sshHostKey() (7)
    claim.ts          # claim() (G1, M8)
    wake.ts           # wakeResolve() (M7)
    idle.ts           # './idle' (M7)
    words.json  words.ts
    testing/{index,fake-provider,contract,fake-sandbox-server,fake-ssh}.ts
  test/
```

Source rules and package fields follow `docs/capability-kits.md` 3.2 exactly (`packages/herdr` is the model:
`tsconfig.json`, `files`, `engines.node >=22.18`, `prepack`, Apache-2.0 `LICENSE`, `CHANGELOG.md` starting
`## Unreleased`). No runtime dependency.

## 4. Public types (`src/types.ts`, frozen)

### 4.1 Types

```ts
// packages/machine/src/types.ts
export type MachineRef = {
  provider: string                // Provider.id
  account: string                 // provider account id, read once at setup; the kit refuses a ref from another account
  id: string                      // provider machine id
  name: string                    // ^[a-z][a-z0-9-]{0,31}$
  keepCopies: boolean             // provider snapshots on; false = no backups AND no sleep (section 11)
}

export type MachineState =
  | 'creating' | 'on' | 'asleep' | 'waking' | 'stopping'
  | 'unknown'                      // provider can't be asked (VM unreachable, API down)
  | 'failed'                       // provider reports an error
  | 'host-key-changed'             // SSH VM only: the pinned key no longer matches (section 13 rule 6)
  | 'gone'                         // deleted, or a create that never got a machine

export type HostState = 'not-installed' | 'installing' | 'running' | 'restarting' | 'stopped' | 'failed'

export type Size = { id: string; cpus: number; memoryGb: number; diskGb: number }
export type Price = {
  size: string
  perHour?: number; perMonthCap?: number
  planFloorPerMonth?: number       // minimum the person pays the provider each month
  asleepPerHour: number            // 0 on per-second sandbox APIs; = perHour on a VM that bills while off
  currency: 'USD' | 'EUR'
  basis: string                    // e.g. 'incl. IPv4, excl. VAT'
  source: string                   // public URL
  checked: string                  // YYYY-MM-DD
}
export type Cost = { perMonth: number; floor: number | null; currency: 'USD' | 'EUR'; basis: 'list' | 'usage' | 'entered'; checked: string; words: string }
export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type Usage = { from: string; to: string; hours: number; amount: number; currency: 'USD' | 'EUR' }
export type KeyInfo = { expires: string | null; scopes: readonly string[] }

export interface Provider {
  readonly id: string              // 'sandbox-api' | 'ssh-vm'
  readonly label: string           // from the app, e.g. the provider's name; shown in words
  account(): Promise<string>
  sizes(): readonly Size[]
  prices(): readonly Price[]
  status(m: MachineRef): Promise<MachineState>
  exec(m: MachineRef, argv: readonly string[], o: { timeoutMs: number; root?: boolean; input?: Uint8Array }): Promise<ExecResult>
  write(m: MachineRef, path: string, bytes: Uint8Array, mode: number): Promise<void>
  // Optional. Absent means the adapter can't, and the UI hides the action.
  create?(o: { name: string; size: string; keepCopies: boolean; idempotencyKey: string }): Promise<MachineRef>
  wake?(m: MachineRef): Promise<void>                 // resolves at 'on'
  sleep?(m: MachineRef): Promise<void>
  snapshot?(m: MachineRef, name: string): Promise<{ name: string }>
  fork?(m: MachineRef, o: { name: string; size: string; idempotencyKey: string }): Promise<MachineRef>
  remove?(m: MachineRef, confirm: string): Promise<void>        // confirm must equal m.id; also removes the kit's named snapshots
  url?(m: MachineRef, port: number): Promise<string | null>     // provider HTTPS URL for a port bound on 0.0.0.0
  usage?(m: MachineRef, since: string): Promise<Usage>
  key?(): Promise<KeyInfo>                                      // provider key expiry and scopes
}

export type HostRecipe = {
  name: string                                           // unit 'byokit-<name>.service'
  node: { version: string; sha256: Record<'linux-x64' | 'linux-arm64', string> }  // tarball used only if node is missing or too old
  install: readonly (readonly string[])[]                // argv lists, run once in workDir
  update?: readonly (readonly string[])[]
  run: { argv: readonly string[]; env: Readonly<Record<string, string>> }  // names matching /KEY|TOKEN|SECRET|PASSWORD/i refused
  workDir: string                                        // absolute, inside the machine user's home
}

// The app's own persistence for the one MachineRef + provider key; the same load/save seam as
// recordStore(load, save) (packages/accounts/src/stores.ts:11). The kit imports no other kit.
export type MachineRecord = { ref: MachineRef | null; providerKey: string; monthlyEntered?: number }
export type MachineStore = { load(): Promise<MachineRecord | null>; save(r: MachineRecord): Promise<void> }

export interface Machine {
  readonly ref: MachineRef | null
  create(o: { name: string; size: string; keepCopies: boolean }): Promise<MachineRef>
  state(): Promise<MachineState>
  wake(): Promise<void>; sleep(): Promise<void>
  install(r: HostRecipe, onLine?: (line: string) => void): Promise<void>
  update(r: HostRecipe): Promise<void>
  host(): Promise<HostState>                             // systemctl is-active + NRestarts
  logs(lines: number): Promise<string[]>                 // journalctl, capped
  url(port: number): Promise<string | null>
  cost(): Promise<Cost>
  remove(confirm: string): Promise<void>
}
export function machine(o: { provider: Provider; store: MachineStore }): Machine
export function sandboxApi(o: { baseUrl: string; label: string; prices: readonly Price[]; key: () => Promise<string>; fetch?: typeof fetch }): Provider
// './ssh' entry (Node only):
export function sshVm(o: { ssh: string /* absolute */; host: string; port?: number; user: string; keyPath: string; stateDir: string; label: string; monthly?: Price }): Provider
```

`types.ts` holds the types; the three functions are declared where section 3.1 puts them, with exactly these
signatures. The provider key reaches `sandboxApi()` through the app's `key` callback, which the app reads from its
`MachineStore` record's `providerKey`; `machine()` never reads `providerKey` itself.

### 4.2 Additions beyond the frozen block

Only these. They add exports and change nothing in 4.1.

```ts
// src/errors.ts
export type MachineErrorCode =
  | 'no-machine'          // a call that needs a ref, with none in the store
  | 'exists'              // create() while the store already holds a ref
  | 'wrong-account'       // stored ref.account !== provider.account()
  | 'unsupported'         // the provider lacks the optional method this call needs
  | 'confirm'             // remove(confirm) with confirm !== ref.id
  | 'bad-recipe'          // 8.1 check failed; message names the rule
  | 'not-linux'           // uname, systemd or arch check failed (8.3)
  | 'linger'              // loginctl enable-linger refused (8.4); extra.command holds the line to run
  | 'host-key'            // SSH host key unconfirmed or changed (7.2)
  | 'unauthorized'        // provider answered 401/403
  | 'balance'             // provider says the account's balance is spent (10)
  | 'unreachable'         // network or ssh transport failure
  | 'provider'            // any other provider failure; message holds the provider's own text
  | 'timeout'
export class MachineError extends Error {
  readonly code: MachineErrorCode
  readonly extra: Readonly<Record<string, string>>
  constructor(code: MachineErrorCode, message: string, extra?: Record<string, string>)
}

// src/cost.ts
export function estimate(p: Price, o?: { hoursOn?: number }): Cost   // 10.1; hoursOn defaults to 730

// src/words.ts
export function words(key: WordKey, vars?: Record<string, string>): string
export function stateWords(s: MachineState, vars: { app: string; label: string }): string
export function hostWords(s: HostState, vars: { app: string }): string
export function keyWords(k: KeyInfo, o: { label: string; now: Date; days?: number }): string | null   // 11.3

// src/wake.ts (M7; declared at M1 with a 'not built: M7' body)
export function wakeResolve(o: { provider: Provider; ref: MachineRef; port: number }): (url: string) => Promise<string>

// './ssh' (M2)
export function sshHostKey(o: { ssh: string; host: string; port?: number; stateDir: string }):
  Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }>

// './idle' (M7)
export function idle(o: { linked: () => number; held: () => boolean; minutes: number; stop: () => Promise<void> }): { close(): void }

// './testing'
export function fakeProvider(o?: FakeProviderOptions): Provider & { fake: FakeControl }
export function machineContract(make: () => Promise<MachineBench>, o?: { test?: TestFn } | TestFn): void
```

`FakeProviderOptions`, `FakeControl`, `MachineBench` and `TestFn` are defined by M1 in `src/testing/index.ts` with the
shapes 13.3 needs; they are test-only and not frozen.

### 4.3 Consumer additions (from the first app's consumer design, gaps G1-G11)

The first consuming app's design found eleven gaps; section 16 maps each one. The ones the kit adopts add the members
below. Every one is **optional or new**, so nothing in 4.1 changes meaning: M1 writes 4.1 with these members merged in,
and they are frozen with it.

```ts
// types.ts: new members on 4.1 types
export type HostRecipe = { /* 4.1 fields */
  node: { version: string; sha256: Record<'linux-x64' | 'linux-arm64', string>
          range?: string }                                // G5a: the machine's node is used only if it satisfies this; default '>=<version>'
  installRoot?: readonly (readonly string[])[]           // G5b: argv lists run as root before `install`, and again before `update`; must be idempotent
  user?: string                                          // G7: run as this no-sudo user, created by the kit, home inside the machine user's home
}
export type AsleepWhy = 'you' | 'out-of-credit' | 'trial-limit' | 'provider' | 'idle'      // G3
export type Plan = { inTrial: boolean; trialEndsAt: string | null; canStayOn: boolean; checkoutUrl: string | null }  // G2
export interface Provider { /* 4.1 members */
  plan?(): Promise<Plan>                                 // G2
  why?(m: MachineRef): Promise<AsleepWhy | null>         // G3: null when not asleep
  selfId?: readonly string[]                             // G4: argv that prints this machine's provider id on the machine itself (15.1, fixed by M6)
  wakeKey?(m: MachineRef, o: { label: string }): Promise<{ id: string; key: string; expires: string | null }>  // G11 (M7)
  revokeKey?(id: string): Promise<void>                  // G11 (M7)
}
export interface Machine { /* 4.1 members */
  plan(): Promise<Plan | null>                           // G2: null when the provider has no plan()
  why(): Promise<AsleepWhy | null>                       // G3 (5.7)
  deliver(r: HostRecipe, file: string, bytes: Uint8Array): Promise<void>  // G9 (5.8)
}

// src/claim.ts, exported from '.' (G1, built in M8)
export type ClaimStep =
  | { step: 'open-page'; url: string }
  | { step: 'type-code'; url: string; code: string }
  | { step: 'waiting' }
  | { step: 'done'; key: string; expires: string | null; scopes: readonly string[] }
  | { step: 'failed'; why: 'refused' | 'expired' | 'unreachable' | 'provider' }
export function claim(o: { baseUrl: string; fetch?: typeof fetch; signal?: AbortSignal }): AsyncIterable<ClaimStep>
```

`MachineErrorCode` (4.2) also gains `'needs-root'` (G5b, G7: root steps on an SSH VM without passwordless sudo;
`extra.command` holds the lines to run).

## 5. `Machine` (`src/machine.ts`)

### 5.1 Store and refs

- `machine()` does no I/O. Every method first awaits a one-time `store.load()` (the same promise for every caller).
  `ref` is `null` until that resolves, then mirrors the loaded or last saved record.
- After load, a non-null ref with `ref.provider !== provider.id` or `ref.account !== await provider.account()` rejects
  every call with `MachineError('wrong-account')`. The kit never uses, repairs or overwrites that ref; the app decides.
- Every change to the ref is written with `store.save({ ...record, ref })` before the method resolves, keeping
  `providerKey` and `monthlyEntered` as loaded. A missing record saves as `{ ref, providerKey: '' }`.
- Calls that need a machine reject `MachineError('no-machine')` when `ref` is null: `state`, `wake`, `sleep`,
  `install`, `update`, `host`, `logs`, `url`, `cost` (5.5 has the one exception), `remove`.

### 5.2 `create`

1. `ref` non-null: reject `exists`.
2. `name` must match `^[a-z][a-z0-9-]{0,31}$`, `size` must be one of `provider.sizes()` ids unless `sizes()` is empty:
   else reject `bad-recipe` naming the field.
3. **Provider with `create`** (sandbox API): the kit makes one idempotency key per `create` call,
   `` `byokit-${name}-${n}` `` where `n` is 16 random base36 chars from `crypto.getRandomValues` (available on Node 22,
   Electron, React Native with Hermes, and browsers). It calls `provider.create({ name, size, keepCopies, idempotencyKey })`,
   retrying up to 3 times with the same key on `unreachable` only.
4. **Provider without `create`** (SSH VM): the machine already exists. The kit adopts it: `keepCopies` must be
   `false` (else `bad-recipe`), the ref is `{ provider: provider.id, account: await provider.account(), id: <7.1 id>, name, keepCopies: false }`,
   and `provider.status(ref)` must be `'on'` before it is saved (else reject with that state's `MachineError`: `host-key`
   for `host-key-changed`, `unreachable` otherwise).
5. The returned ref is saved (5.1), then returned.

### 5.3 `state`, `url`, `remove`

- `state()`: `provider.status(ref)`.
- `url(port)`: `provider.url?.(ref, port) ?? null` (a missing method resolves `null`, not an error). `port` is an
  integer 1-65535.
- `remove(confirm)`: `confirm !== ref.id` rejects `confirm`. `provider.remove` missing rejects `unsupported`. Otherwise
  `provider.remove(ref, confirm)`, then save `ref: null`. `remove` is irreversible; the app calls it only from a person's
  explicit action on a screen that shows the machine's name.

### 5.4 `wake` and `sleep`

- Missing provider method: `unsupported`.
- `sleep()` with `ref.keepCopies === false` rejects `unsupported`: a stop without copies erases the disk (11.4).
- `wake()` when `state()` is already `on` resolves without calling the provider.
- `sleep()` first runs `systemctl [--user] stop byokit-<ref.name>.service` (ignoring a missing unit) so the host
  process gets SIGTERM and flushes, whether or not the provider's stop is a clean OS shutdown (G10).
- v1 apps do not call `sleep()`; only M7's idle rule does (D-10). A v1 app may call `wake()` after a stop it did not
  cause (credit, trial limit, provider), from the setup device that holds the key.

### 5.7 `plan` and `why` (G2, G3)

- `plan()`: `provider.plan?.() ?? null`. It needs no ref, so an app can show the trial notice before `create`.
- `why()`: `null` unless `state()` is `asleep`. Then, first match wins: `provider.why?.(ref)` if it returns non-null;
  else `out-of-credit` if `usage` rejects `balance`; else `trial-limit` if `plan()` has `canStayOn: false`; else
  `provider`. The app shows `asleep.<why>` words (12) instead of `state.asleep` when `why()` is non-null.

### 5.8 `deliver` (G9)

`deliver(r, file, bytes)` hands the running host one small file, for example a new phone's public key during owner
recovery. `file` matches `^[a-z0-9][a-z0-9._-]{0,63}$`, `bytes` is at most 64 KB, and it lands at
`<r.workDir>/.byokit/inbox/<file>` at mode 0600, owned by the run user (`r.user` or the machine user), written through
a temp name and renamed. The app's host watches that directory. It is the only write `Machine` offers; anything else
goes in the recipe.

### 5.5 `cost`

Section 10. With no ref, `cost()` rejects `no-machine`; apps show a pre-create estimate with `estimate(price)`.

### 5.6 `install`, `update`, `host`, `logs`

Section 8. `host()` resolves `'installing'` while an `install` or `update` of this `Machine` object is in flight,
without asking the machine.

## 6. Sandbox API adapter (`src/sandbox-api.ts`)

`sandboxApi()` speaks one public REST shape (15.1) over `o.fetch ?? globalThis.fetch`. Every request sends
`Authorization: Bearer <await o.key()>` and `Content-Type: application/json`, to `` `${baseUrl}${path}` ``. `id` is
`'sandbox-api'`; `label` and `prices()` are the app's; `sizes()` is the 15.1 table.

### 6.1 Calls

| Kit | Request | Rules |
|---|---|---|
| `account` | `GET /me` (15.1) | Returns the account id; cached for the adapter's life. |
| `create` | `POST /sandboxes` `{type: size, ttlSeconds: null, noEnv: true, snapshots: keepCopies}` + header `Idempotency-Key` | `ttlSeconds: null` disables the provider's auto-stop. Resolves once the returned id exists; it does not wait for `on`. The returned ref's `name` is the kit's `name`. |
| `status` | `GET /sandboxes/{id}` | Mapping in 6.2. |
| `wake` | `POST /sandboxes/{id}/resume` `{ttlSeconds: null}` | **No `noEnv` field** (6.3). Then polls `status` every 2 s until `on` (resolve), `failed` or `gone` (reject `provider`), or 5 minutes (reject `timeout`). |
| `sleep` | `POST /sandboxes/{id}/stop` | The provider takes a final snapshot; if that fails the stop aborts and the machine keeps running, which the kit reports as the `provider` error it returns. |
| `snapshot` | `POST /named-snapshots` `{sandboxId, name}`, then poll `GET /named-snapshots/{name}` every 2 s until ready | The kit names copies `byokit-<ref.name>-<name>`. At most 10 exist per account; an 11th rejects `provider`. |
| `fork` | `POST /sandboxes/{id}/fork` `{ttlSeconds: null}` + `Idempotency-Key` | A fork does not inherit the source's TTL: without `ttlSeconds: null` it stops after 1 h. A fork of a no-env source is always no-env, so no `noEnv` field. |
| `remove` | `DELETE /sandboxes/{id}` + header `X-Ascii-Confirm-Delete: <id>`; poll `GET /deletion-operations/{op}` every 2 s until done; then `GET /named-snapshots` and `DELETE /named-snapshots/{name}` for every name starting `byokit-<ref.name>-` | Named snapshots survive a sandbox delete; without the second step the sign-ins inside them outlive it. A 404 on the sandbox counts as already deleted and the snapshot step still runs. |
| `exec` | `POST /sandboxes/{id}/commands` `{command, timeoutSeconds, detached}`, poll `GET /sandboxes/{id}/commands/{pid}` every 1 s | 6.4. |
| `write` | `PUT /sandboxes/{id}/files` | Only paths under `/home/user/` or `/tmp/`; anything else rejects `bad-recipe` before any request. The kit writes elsewhere (for example `/etc`) by writing under `/tmp/` then `exec({ root: true })` `install -m <mode> <tmp> <dest>`. After the PUT, `exec` `chmod <mode, octal> <path>`. |
| `url` | `POST /sandboxes/{id}/host` `{port, public: true}` → the returned HTTPS URL | The app's process must bind `0.0.0.0`. Hosting also opens the machine firewall for that port. Re-hosting the same port returns the same URL. |
| `usage` | `GET /sandboxes/{id}/usage?since=<since>` → `{seconds, dollars, running}`; then `GET /limits` for the balance | `hours = seconds / 3600`, `amount = dollars`, `currency: 'USD'`, `from = since`, `to` = the request time (ISO). A balance at or below 0 rejects `balance`. |
| `key` | `GET /api-keys/current` (15.1) → `{expiresAt, scopes}` | `expires` is `expiresAt` or `null`. |
| `plan` (G2) | `GET /limits` (15.1) | Maps the plan's trial flag, trial end, whether auto-stop may be disabled (`canStayOn`) and the checkout URL the provider gives. Cached 60 s. |
| `why` (G3) | `GET /sandboxes/{id}` stop reason, if the API document has one (15.1) | Maps a stop the person made to `you`, a stop by M7's stop-only key to `idle`, balance to `out-of-credit`, trial auto-stop to `trial-limit`, anything else to `provider`. No stop reason in the document: `why` is absent and 5.7's fallbacks apply. |
| `selfId` (G4) | argv fixed by M6 (15.1) | Absent until M6 finds how a machine reads its own id. |

**Trial (G2).** While `plan()` says `canStayOn: false`, `create`, `wake` and `fork` send `ttlSeconds: 7200` (the
trial's 2-hour maximum) instead of `null`; the provider refuses `null` there. The app shows `plan.trial` before
`create`. When the trial ends, the next `wake` sends `null` again.

Errors on every call: HTTP 401 or 403 → `unauthorized`; 404 on `GET /sandboxes/{id}` → status `gone`; 429 and 5xx
retried 3 times with 1 s, 2 s, 4 s waits, then `provider`; a `fetch` rejection → `unreachable`; any other non-2xx →
`provider` with the body's message capped at 200 characters. The key never appears in an error message or `extra`.

### 6.2 State mapping

| Provider state | `MachineState` |
|---|---|
| `init`, `provisioning`, `provisioned`, `cloning` | `creating`, or `waking` when the adapter last saw `archived` for this id or a `wake()` is in flight |
| `ready`, `idle`, `running` | `on` |
| `archiving` | `stopping` |
| `archived` | `asleep` |
| `error` | `failed` |
| `cancelled`, or 404 | `gone` |
| request failed (`unreachable`, 5xx after retries) | `unknown` |

The adapter remembers the last provider state per id in memory only. The provider's state ignores processes the
person runs, so `HostState` comes from systemd (8.5), never from this table.

### 6.3 `noEnv` is sticky

`noEnv: true` is sent on `create` only. A sandbox created no-env stays no-env across resumes. Sending `noEnv` again on
resume means a **conversion**, which scrubs agent CLI login files on the machine even when the person signed in there,
wiping Herdr pane logins. So no request other than `create` carries a `noEnv` key, and no request carries an `env` key
(13.1 rule 3).

### 6.4 `exec`

- The provider takes a shell string, not argv, and has no stdin. The adapter joins argv with POSIX single-quote
  quoting (`'` → `'\''`); NUL in any argument rejects `bad-recipe`.
- `root: true` prefixes `sudo -n`. The machine user has passwordless sudo (15.1).
- `input`: the adapter first `write`s the bytes to `/tmp/byokit-in-<16 random base36>` at mode 0600, runs
  `<command> < <that path>`, then removes the file in the same shell line (`; rm -f <path>`), keeping the command's exit
  code.
- `timeoutMs` ≤ 600 000: one request with `timeoutSeconds = ceil(timeoutMs / 1000)` and `detached: false`.
  Larger: `detached: true` with `timeoutSeconds: 600` is not enough, so the adapter runs the command detached with
  no provider timeout and polls every 1 s; at `timeoutMs` it runs `kill -TERM -<pid>` then resolves
  `timedOut: true`.
- The result's `stdout` and `stderr` are each capped at 8 MB (the tail is kept).

### 6.5 Sleep semantics (for M7)

- The provider has no idle timer: its auto-stop counts from create or resume, never from last activity. The kit
  therefore sends `ttlSeconds: null` on create, resume and fork (7200 during a trial, 6.1), and only M7's idle rule
  ever sleeps a machine.
- One provider stop remains: running sandboxes are stopped 24 h after the account balance reaches zero (words
  `cost.balance`).
- Every wake is a cold boot on new hardware: memory and hand-started processes are gone and enabled systemd units
  start again. Apps must not rely on in-memory "I was asleep" detection.

## 7. SSH VM adapter (`src/ssh.ts`, `./ssh`)

`sshVm()` drives one Linux box the person already rents. `id` is `'ssh-vm'`. It has no `create`, `wake`, `sleep`,
`snapshot`, `fork`, `remove`, `url`, `usage` or `key`. `sizes()` is `[]`. `prices()` is `o.monthly ? [o.monthly] : []`.

### 7.1 Every call

- The kit spawns `o.ssh` (absolute; a relative path or a non-executable file rejects `unreachable` with
  `extra.why: 'bin'`) with argv:

  ```
  -F <stateDir>/ssh_config -i <keyPath> -o IdentitiesOnly=yes -o UserKnownHostsFile=<stateDir>/known_hosts
  -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o BatchMode=yes -p <port ?? 22> -- <user>@<host> <quoted command>
  ```

  `-F` with a kit-owned file stops `ssh` reading the person's `~/.ssh/config`, and `IdentitiesOnly` stops it trying
  `~/.ssh/id_*`. The kit writes `<stateDir>/ssh_config` (mode 0600) once, empty except for a comment line naming the
  kit, and creates `stateDir` with mode 0700.
- Env from nothing: `{ LANG: 'C.UTF-8' }` only. No `PATH`, no `HOME`, no `SSH_AUTH_SOCK`.
- The remote command is the argv quoted as in 6.4. `root: true` prefixes `sudo -n`. `input` goes to the child's stdin.
- Caps: 8 MB per stream (tail kept); `timeoutMs` then SIGTERM, 2 s, SIGKILL; `timedOut: true`.
- `ssh` exit 255 with a host-key mismatch in stderr (`REMOTE HOST IDENTIFICATION HAS CHANGED` or
  `Host key verification failed`) → `status` is `host-key-changed` and `exec`/`write` reject `host-key`. Any other
  exit 255 → `unreachable`. Any other code is the remote command's and resolves normally.
- `account()` is `` `${user}@${host}:${port ?? 22}` ``. The machine id used by `Machine.create` (5.2 step 4) is the
  pinned host key's SHA256 fingerprint, read from `<stateDir>/known_hosts`.
- `status()`: no pinned key → `unknown`; `true` exits 0 → `on`; mismatch → `host-key-changed`; else `unknown`. It never
  returns `asleep`, `waking`, `creating` or `gone`.
- `write(path, bytes, mode)`: `exec` of `sh -c 'umask 077 && cat > "$1" && chmod <mode> "$1"' sh <path>` with
  `input: bytes`.

### 7.2 First connect and a changed key

- `sshHostKey({ ssh, host, port, stateDir })` runs `ssh-keyscan -p <port> -t ed25519,ecdsa,rsa <host>` from the same
  directory as `ssh` (`join(dirname(ssh), 'ssh-keyscan')`), env from nothing, 15 s timeout. It resolves the preferred
  key's `SHA256:` fingerprint (ed25519 first), `pinned` (whether `<stateDir>/known_hosts` already holds exactly that
  key), and `confirm()`, which writes that one line to `known_hosts` (mode 0600).
- The app shows the fingerprint in words for the person to compare with their provider's console, and calls
  `confirm()` only on their yes. Until then every `sshVm` call except `account` rejects `host-key` and `status` is
  `unknown`.
- A changed key is never re-accepted by the kit. The person removes the machine from the app and sets it up again
  after checking with their provider (words `state.host-key-changed`).

## 8. Installing and supervising the host process

The app supplies its own host program and installer as a `HostRecipe`. The kit writes and owns exactly one systemd
unit per app, because Herdr and OpenClaw supervise their engines only while the app's host process lives, and nothing
else restarts that process.

### 8.1 Recipe checks (before any machine call; failures reject `bad-recipe`, message names the rule)

- `name` matches `^[a-z][a-z0-9-]{0,31}$`.
- `workDir` is absolute, has no `..` segment, and is inside the run user's home: the machine user's home
  (`/home/user/` on the sandbox API; on the SSH VM, `/home/<o.user>/`, or `/root/` for `root`), or with `user` set,
  `<machine home>/.users/<user>/`. Every piece of app state must live there: on the sandbox API only the machine
  user's home is kept across sleep, which is why a `user`'s home sits inside it.
- Every argv (install, update, run) is non-empty, with no NUL.
- `run.env` names match `^[A-Z_][A-Z0-9_]*$` and not `/KEY|TOKEN|SECRET|PASSWORD/i`; values have no control characters.
  Unit files and the recipe are copied into snapshots and are readable, so secrets never go there.
- `node.version` is `x.y.z`; both `sha256` values are 64 lowercase hex characters; `node.range`, if present, is one
  or more `||`-separated groups of space-separated comparators (`>=`, `>`, `<=`, `<`, `=` followed by `x.y.z`) and
  `node.version` satisfies it (G5a).
- `installRoot` argv lists follow the argv rule above (G5b).
- `run.argv` is one process. An app that needs two (for example its host and its own relay) passes a wrapper that
  starts both and exits when either exits, so `Restart=always` restarts both; systemd's default
  `KillMode=control-group` stops every child with the unit (G6).
- `user` (G7), if present, matches `^[a-z][a-z0-9-]{0,30}$` and is not the machine user or `root`; `workDir` is then
  inside that user's home, `<machine home>/.users/<user>/`.

### 8.2 Unit file (`renderUnit`, pure)

Sandbox API, and any recipe with `user` (G7): a system unit at `/etc/systemd/system/byokit-<name>.service`, written
through `/tmp/` and `exec({ root: true })` (6.1 `write`). SSH VM without `user`: a user unit at
`~/.config/systemd/user/byokit-<name>.service`.

```ini
[Unit]
Description=byokit <name>
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<run user>                    ; system unit only: recipe.user, else the machine user
WorkingDirectory=<workDir>
Environment="<NAME>=<value>"       ; one line per run.env entry, sorted by name
ExecStartPre=<node path> <kit boot script> ; only when provider.selfId is present (G4, 8.6)
ExecStart=<node path> "<arg 1>" "<arg 2>" …   ; see below
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target         ; default.target for the user unit
```

- If `run.argv[0]` is `node`, it is replaced by the resolved node path (8.3); otherwise it must be absolute.
- Every `ExecStart` argument and `Environment` value is double-quoted, with `\` → `\\`, `"` → `\"`, `%` → `%%` and,
  in `ExecStart` only, `$` → `$$`.
- The rendered bytes are the golden files in `test/golden/` (M3). Without `user`, the system unit's `User=` is the
  output of `id -un`.
- The sandbox API uses a system unit because only `/etc`, `/usr`, `/opt`, `/root`, `/srv` and the home survive sleep:
  a user unit's linger flag lives under `/var` and could be lost on wake. The SSH VM uses a user unit plus linger so
  the kit needs no root there.

### 8.3 Machine and Node checks (first steps of `install`)

1. `uname -s`, `uname -m`, `systemctl --version`: Linux, `x86_64` (→ `linux-x64`) or `aarch64` (→ `linux-arm64`),
   and systemd present; else reject `not-linux` naming what failed.
2. `node --version` on the machine's `PATH`: if it satisfies `recipe.node.range` (default `>=<node.version>`), use
   `command -v node` (G5a). Otherwise install the pinned official tarball
   `https://nodejs.org/dist/v<v>/node-v<v>-<arch>.tar.xz`: download with `curl -fsSL` to `/tmp/`, check with
   `sha256sum` against `recipe.node.sha256[arch]` (mismatch → `bad-recipe` and the file is deleted), extract to
   `<run user's home>/.local/share/byokit/node/<v>/` (owned by the run user), and use its `bin/node`. It is never put on `PATH`. This is the herdr binary rule
   (`packages/herdr/src/binary.ts`).

### 8.4 `install(recipe, onLine?)`

1. 8.1 checks, then 8.3.
2. **Root steps** (G5b, G7), only when the recipe has `installRoot` or `user`. The kit checks `sudo -n true` (skipped
   when the SSH user is `root`); if it fails, reject `needs-root` with `extra.command` holding every line the person
   must run once, each prefixed `sudo ` and shell-quoted, joined with `\n`, and the app shows `host.needsRoot` above
   them. Otherwise, as root: with `user`, create it once with
   `useradd --system --create-home --home-dir <machine home>/.users/<user> --shell /usr/sbin/nologin <user>` (skipped if
   `id -u <user>` succeeds); then each `installRoot` argv, in order, 20-minute timeout each.
3. `mkdir -p <workDir>` as the run user; each `install` argv runs in `workDir` as the run user
   (`cd <workDir> && <argv>`, through `sudo -n -u <user> --` when `user` is set) with a 20-minute timeout.
   A non-zero exit rejects `provider` with `extra.step` (the index) and the last 2 KB of stderr in `extra.tail`.
   `onLine` gets each line of each step's stdout and stderr, in order, after the step ends.
4. Write `<workDir>/.byokit/installed.json` `{ "id": <ref.id> }` at mode 0600 (G4, 8.6), then the unit (8.2) at mode
   0644.
5. System unit (sandbox API, or `user`): `sudo -n systemctl daemon-reload` then `sudo -n systemctl enable --now byokit-<name>.service`.
   User unit (SSH VM without `user`): `loginctl enable-linger <o.user>` first; if it fails, reject `linger` with
   `extra.command: 'sudo loginctl enable-linger <o.user>'` (the kit never escalates); then
   `systemctl --user daemon-reload` and `systemctl --user enable --now byokit-<name>.service`.
6. The app's own autostart must stay off so there is exactly one supervisor. The recipe is the app's; the README says
   so and gives the rule, not app names.

### 8.5 `update`, `host`, `logs`

- `update(recipe)`: 8.1 checks; root steps as in 8.4 step 2 (`installRoot` runs again, so it must be idempotent);
  each `update` argv in `workDir` as in 8.4 step 3; rewrite `installed.json`; re-render the unit and rewrite it
  only if it changed (then `daemon-reload`); then `systemctl [--user] restart byokit-<name>.service`. A recipe with
  no `update` only restarts. The kit never manages the OS; unattended upgrades are the machine's own.
- `host()`: `systemctl [--user] show byokit-<name>.service -p LoadState,ActiveState,SubState,NRestarts`:

  | Reading | `HostState` |
  |---|---|
  | `LoadState=not-found` | `not-installed` |
  | `ActiveState=active` | `running` |
  | `ActiveState=activating` with `SubState=auto-restart`, `NRestarts` < 5 | `restarting` |
  | `ActiveState=activating` with `SubState=auto-restart`, `NRestarts` ≥ 5, or `ActiveState=failed` | `failed` |
  | `ActiveState=activating`, any other `SubState` | `running` |
  | `ActiveState=inactive` or `deactivating` | `stopped` |

- `systemctl [--user]` above means `--user` for a user unit and `sudo -n` for a system unit.
- `logs(lines)`: `journalctl [--user] -u byokit-<name>.service -n <min(lines, 500)> --no-pager -o cat`, split on
  `\n`, trailing empty line dropped. `lines` must be an integer ≥ 1.

### 8.6 Copy detection at boot (G4)

A fork copies the whole home, including the host's link key, so without a check the copy's host and relay fight the
original's (the relay closes one as `replaced`) and scheduled work runs twice.

- `install` and `update` write `<workDir>/.byokit/installed.json` `{ "id": <ref.id> }`.
- When `provider.selfId` is present, the unit's `ExecStartPre` runs a kit boot script (rendered into
  `<workDir>/.byokit/boot.mjs` by `install`, plain Node, no dependency) that runs `selfId`, and writes
  `<workDir>/.byokit/boot.json` `{ "id": <printed id>, "copy": <id !== installed.id> }` at mode 0600. It always exits
  0: the kit reports, the app decides.
- The app's host reads `boot.json` at start and refuses to run its scheduled work or dial its relay while
  `copy` is true, showing its own words. The kit's words do not cover this; the app's do.
- `selfId` is absent until M6 records how a machine reads its own provider id (15.1). Until then `boot.json` is not
  written, and the kit's only guarantee is that `Machine` never forks.

## 9. Reach from phone and web

The host process runs link exactly as it does at home. The person's own relay runs in the same host process (or its
own unit from the same recipe), listening on `0.0.0.0` so the provider's proxy reaches it. Everything else stays on
loopback.

- **No provider access token in any URL.** The relay port is hosted `public: true`; link's Noise IK with a pinned
  host key and `relay.admit` are the only gates. A token gate would break typed-code lookup (`findHost` rebuilds URLs
  without the query string, `packages/relay/src/device.ts`) and would copy a provider secret into every QR code and
  device grant.
- **Candidates, best first,** in the app's `host.offer({ urls })` (link takes up to 8, tries them in order and saves
  the winner):
  1. the person's relay on the machine through the provider URL, `wss://<provider URL host>/link/v1/<hostId>`, with
     `relay.admit(host.keys.publicKey)`. After the first QR pairing, later devices can pair by typed code through
     `findHost(relayBase, code)`;
  2. the person's tailnet through `@byokit/reach`, unchanged. Apps never call `reach` with `auto` or `lan` on a cloud
     machine: it would advertise an unreachable private address;
  3. SSH VM with no domain and no tailnet: Node and Electron devices only, through link's `Dial.resolve` hook running
     an `ssh -L` tunnel. Phones and browsers need candidate 1 or 2.
- **Package changes:** `@byokit/link` none; `@byokit/reach` none; `@byokit/relay` gains a keepalive (M5), because a
  half-open host→relay socket is noticed today only when TCP closes.
- **Unverified until M6:** WebSocket through the provider's HTTPS proxy. If it fails, the fallback is the raw port
  with the relay's own TLS, or the tailnet.

## 10. Cost

Every cost sentence says it is the person's own bill from `{label}`, not from the app.

### 10.1 Rules

- `estimate(p, { hoursOn = 730 })`, for screens before a machine exists:
  - `perHour` present: `perMonth = max(p.planFloorPerMonth ?? 0, min(p.perMonthCap ?? ∞, p.perHour × hoursOn + p.asleepPerHour × (730 − hoursOn)))`;
  - else `perMonth = p.perMonthCap` (a price row with neither rejects `bad-recipe`);
  - `floor = p.planFloorPerMonth ?? null`, `basis: 'list'`, `checked = p.checked`, `currency = p.currency`;
  - `words`: `cost.sandbox` for a row with `perHour`, else `cost.vm`, with `{amount}` from `perMonth`.
- `Machine.cost()`:
  - **Provider with `usage`**: `usage(ref, <first instant of the current UTC month>)`. `perMonth` is the amount so
    far projected over the month (`amount / elapsedHours × 730`, elapsed from `from` to `to`, at least 1 h), raised to
    the largest `planFloorPerMonth` in `prices()`. `basis: 'usage'`, `checked` = the date of `to`, `words`:
    `cost.sandbox`. A `balance` rejection resolves instead a `Cost` with `perMonth` from the same floor rule,
    `basis: 'usage'`, and `words: cost.balance`.
  - **Otherwise**: `record.monthlyEntered` if set, else `monthly.perMonthCap` from `prices()[0]`; `basis: 'entered'`,
    `currency` from `prices()[0]` (`'USD'` when there is no row), `checked` from the row or today, `words: cost.vm`.
    Neither set rejects `unsupported`.
- `{amount}` is `new Intl.NumberFormat('en', { style: 'currency', currency }).format(perMonth)`.
- A `Cost` whose `checked` is more than 90 days before today appends `cost.checked` to `words` (one space between).

### 10.2 Worked examples (public list prices, 2026-09-29; the app supplies real rows)

| Case | Sandbox API, 2 vCPU / 4 GB / 12 GB, $0.018/h, $20/month plan floor | Sandbox API, 4 / 8 / 50, $0.036/h, same floor | Budget VM, 2 / 4 / 40, €5.99/month cap | Mainstream VM, 2 / 4 / 80, $24/month |
|---|---|---|---|---|
| Always on (730 h) | $13.14 of time; **$20** (the floor) | **$26.28** | **€5.99** | **$24** |
| Asleep 16 h a day | $4.38 of time; **still $20** | $8.76; **still $20** | €5.99, billed while off | $24, billed while off |
| Kept, never run | no machine or copy charge; **$20 while the plan is kept** | same | delete and keep a snapshot | per-GB snapshot charge |

Sleep saves money only above a plan floor. A budget VM is the cheapest always-on option; the sandbox API earns its
price through phone-only setup, create, fork, sleep and HTTPS URLs without a domain. `estimate` for the first column
at `hoursOn: 730` is `{ perMonth: 20, floor: 20, currency: 'USD', basis: 'list', … }`.

## 11. Credentials

### 11.1 Whose, where, carried by

| Credential | Lives | Carried by |
|---|---|---|
| Model plan sign-in | On the machine, in the aggregator's state: OpenClaw's per-member auth profile at 0600, or the agent CLI login under Herdr's isolated home | `@byokit/openclaw` / `@byokit/herdr`, unchanged |
| Per-use API key route | Same place, labelled as charged per use (`packages/accounts/src/words.json`); never offered by default | same |
| Provider key (full) | The app's `MachineStore` on the setup device (phone secure store or desktop app store) | `@byokit/machine` |
| Provider wake key (M7) | The phone's secure store, scoped to read, resume and host on one machine id | `@byokit/machine` |
| Provider stop-only key (M7) | On the machine, 0600 in the kit's state dir; so it is inside snapshots and forks | `@byokit/machine` |
| SSH private key | The person's own, passed by path; the kit stores only the pinned host key | `@byokit/machine/ssh` |

### 11.2 Rules

- **Sign in on the machine, never copy from home.** OpenClaw's device-code route (`openai-device-code` in
  `packages/openclaw/src/routes.json`) works headless; a browser-redirect route would land on the person's own
  computer, so hosted apps offer device code or `paste()`. Herdr D11 forbids copying agent CLI logins, so the person
  signs in again inside the pane. Device-code sign-in from a datacenter address is proven in M6.
- **Never use the provider's credential features:** no dashboard subscription connect, no agent credentials, no `env`
  secrets, no secrets API. Secrets stored there come back in plain text from the provider's API.
- **Never pooled.** One person owns one provider account holding their machine (D-7). The provider's terms also forbid
  reselling or providing third-party access to credentials, keys or compute.
- **No per-request rotation.** One provider key per machine; the kit never chooses among model accounts.

### 11.3 Keys expire

Every provider key expires: at most 365 days, and 90 days for an unscoped (admin) key. `keyWords(k, { label, now, days = 14 })`
returns `key.expiring` with `{date}` as `YYYY-MM-DD` when `k.expires` is within `days` of `now`, else `null`. The app
calls `provider.key?.()` on open. Minting the M7 wake key needs an admin-scoped key or a dashboard step.

### 11.5 Linking an account without pasting a key (G1)

Making a provider key on a dashboard and pasting it is a technical step. The provider also has an app sign-in: the app
shows a short code, the person opens the provider's page, signs in there and types it, and the app receives a scoped,
expiring key. `claim({ baseUrl })` (M8) drives that flow and yields 4.3's `ClaimStep`s; on `done` the app saves `key`
as `MachineRecord.providerKey`. It is the person's own sign-in on the provider's own page, so nothing BYOKit runs sees
their password. There is no refresh: when the claimed key nears expiry, `keyWords` warns and the app runs `claim()`
again. Whether the claimed key's scopes allow create, install and hosting is unverified until M6; if they do not, the
app keeps `setup.makeKey` and M8 ships only what M6 proved.

### 11.4 Copies

- `keepCopies: true`: everything in the home, sign-ins included, goes into the provider's snapshots. Encryption at
  rest is not stated by the provider, and its stated retention is inconsistent (for the life of the machine, against
  about 30 days). Account and billing data may be handled in the United States. Words `copies.on` say so.
- `keepCopies: false`: nothing is stored at the provider, but a stop erases the disk with no backup, so the kit never
  sleeps such a machine (5.4).
- Later option, not v1: seal the aggregator's state at rest with a key a paired device delivers on each boot
  (`@byokit/seal` `sealBox`). It needs the engine to read credentials through an injected store, which the pinned
  OpenClaw does not have.

## 12. Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `state.creating` | Setting up your cloud computer. This takes a minute or two. |
| `state.on` | Your cloud computer is on. |
| `state.waking` | Waking your cloud computer. This takes a few seconds. |
| `state.asleep` | Your cloud computer is asleep. Opening {app} wakes it. |
| `state.stopping` | Your cloud computer is going to sleep. |
| `state.unknown` | Can't reach your cloud computer right now. |
| `state.failed` | {label} reports a problem with your cloud computer. |
| `state.host-key-changed` | Your cloud computer's identity changed. Check with {label} before connecting again. |
| `state.gone` | This cloud computer was deleted. |
| `asleep.you` | Your cloud computer is asleep because you put it to sleep. Opening {app} wakes it. |
| `asleep.out-of-credit` | Your {label} balance ran out, so {label} switched your cloud computer off. Add funds, then open {app} to turn it back on. |
| `asleep.trial-limit` | {label} switched your cloud computer off, as it does every 2 hours during the free trial. Opening {app} turns it back on. |
| `asleep.provider` | {label} switched your cloud computer off. Opening {app} turns it back on. |
| `asleep.idle` | Your cloud computer went to sleep because nobody was using it. Opening {app} wakes it. |
| `plan.trial` | Your first week is a free trial, and {label} switches your cloud computer off every 2 hours during it. Opening {app} turns it back on. After the trial it stays on. |
| `setup.makeKey` | Make a key on the {label} site, then paste it here. |
| `setup.typeCode` | Open the {label} page and type this code: {code} |
| `host.not-installed` | {app} isn't on your cloud computer yet. |
| `host.installing` | Putting {app} on your cloud computer… |
| `host.running` | {app} is running on your cloud computer. |
| `host.restarting` | {app} stopped on your cloud computer. Restarting it. |
| `host.stopped` | {app} is stopped on your cloud computer. |
| `host.failed` | {app} keeps stopping on your cloud computer. |
| `host.needsRoot` | {app} needs a few setup steps that only your cloud computer's owner can run. Run the lines below on it once, then try again. |
| `host.linger` | {app} won't start again by itself when your cloud computer restarts. Run the line below on it once to allow that. |
| `cost.sandbox` | About {amount} a month, billed by {label} to your own account. {app} doesn't charge for this. |
| `cost.vm` | {amount} a month, the price you told us {label} charges you. |
| `cost.balance` | Your {label} balance ran out. Your cloud computer stops in a day unless you add funds. |
| `cost.checked` | Price last checked {date}. |
| `key.expiring` | Your {label} key expires on {date}. Make a new one to keep your cloud computer working. |
| `copies.on` | {label} keeps copies of your cloud computer's disk, including your sign-ins, so it can wake where it left off. Your {label} account details may be handled in the United States. |

- Sentences use ASCII apostrophes and U+2026 for the ellipsis, byte for byte as above.
- `words(key, vars)` fills `{app}`, `{label}`, `{amount}`, `{date}` and `{code}`; an unfilled slot stays visible, as in herdr.
- `stateWords(s, vars)` returns `state.<s>`; `hostWords(s, vars)` returns `host.<s>`. For an asleep machine the app
  shows `asleep.<why>` when `Machine.why()` is non-null (5.7).
- `setup.makeKey` is the v1 path while `claim()` (G1, M8) is unbuilt or M6 finds the claimed key too narrow;
  `setup.typeCode` goes with `claim()`'s `type-code` step.
- `Cost.words` is already filled except `{app}`, which `cost()` fills with the literal `{app}` left visible; the app
  passes the result through `words`-style replacement of `{app}` or calls `words(key, vars)` itself. (The kit does not
  know the app's name.)
- Jargon: every sentence, with `{…}` slots replaced by `X`, must not match the herdr expression
  (`packages/herdr/test/words.test.ts`). `host.linger` refers to "the line below": the app shows
  `MachineError.extra.command` under it as code, outside the sentence; `host.needsRoot` likewise.

## 13. Security, tests and isolation

### 13.1 Rules (binding for M1-M8)

1. **BYOKit operates nothing:** no relay, no wake service, no provider account, no default URL, no vendor name.
2. **One person, one provider account, one machine per app install** (D-7, 5.1).
3. **`noEnv: true` on create; no `env` key on any request.** The kit never calls the provider's secrets, environments
   or agent-credential endpoints. The contract fails if a create body lacks `noEnv: true`, if any body carries an
   `env` key, or if a resume or fork body carries `noEnv`.
4. **Library code reads no environment variable.** Spawned `ssh` and `ssh-keyscan` get an env built from nothing.
5. **Only the relay port is exposed** (9). Everything else stays on loopback.
6. **SSH host keys are pinned** in the kit-owned `known_hosts`. A changed key is `host-key-changed`, never silently
   re-accepted.
7. **No secrets in unit files or `HostRecipe.env`** (8.1), because both are copied into snapshots and readable.
8. **`remove` is irreversible.** It needs `confirm === ref.id` and a person's action in the app, and also removes the
   kit's named snapshots.
9. **Tests never touch the network or a real provider** (`scripts/test-egress-guard.cjs`). The sandbox adapter runs
   against a loopback fake server; the SSH adapter against a fake `ssh` bin passed by absolute path (the reach
   fake-CLI precedent).
10. **Never read or write the owner's `~/.ssh`**, `~/.pi`, Herdr, muxr or CLIs. M2's isolation test runs the fs
    tracer over the SSH adapter.
11. **Accepted risk, stated to the person by the app:** on the sandbox API the host runs as a user with passwordless
    sudo, so any agent tool the aggregator runs can become root on that machine. A separate non-sudo user was rejected
    because only that user's home survives sleep. This is the same trust the person gives agents on their own
    computer.

### 13.2 Test layout

- Every test runs under `scripts/test.sh` (throwaway HOME, `~/.pi` byte check, egress guard). Temp dirs use
  `scratchDir` from `packages/test-support.ts`.
- `test/portable.test.ts` (M1, extended in M4 and M7): bundles `.` and `./idle` for `browser` and `react-native` with
  esbuild, as `packages/overlay/test/portable.test.ts` does, and fails on any `node:*` import.
- `test/isolation.test.ts` (M2): a decoy HOME (`packages/accounts/src/testing`) with canary `~/.ssh/config`,
  `~/.ssh/id_ed25519` and `~/.ssh/known_hosts`; `process.env.HOME` points at the decoy; the full contract runs
  against `sshVm` with the fake `ssh` under the fs tracer (`traceFs`). It asserts: the canaries are unchanged, no
  traced path is under the decoy's `.ssh`, the fake's recorded argv matches 7.1 exactly, and its recorded env is
  exactly `{ LANG: 'C.UTF-8' }`.
- `test/words.test.ts` (M1): section 12 verbatim in the same key order as `words.json`, the jargon expression, a
  sentence for every `MachineState` and `HostState`, and unfilled slots staying visible.

### 13.3 Fake provider and contract (`./testing`, M1)

- `fakeProvider({ create?: boolean; sleep?: boolean; url?: boolean; account?: string })` implements every `Provider`
  method (the optional ones unless turned off) in memory: a machine map, a scripted state per id, a file map, an exec
  handler that answers `uname`, `systemctl`, `journalctl`, `node --version`, `id -un`, `loginctl` and recipe argv from
  a script, and a recorded list of every call. `fake` exposes `setState(id, s)`, `script(argv0, result)`, `calls` and
  `files`.
- `machineContract(make, o)` has the herdr shape (`make` returns a bench `{ provider, store, fake? }`; `o` is
  `{ test? } | TestFn`). Its cases, each a separate `test`:
  1. `create` saves the ref, and a second `create` rejects `exists`;
  2. a ref from another account rejects `wrong-account` and is not overwritten;
  3. calls with no ref reject `no-machine`;
  4. `remove` with a wrong confirm rejects `confirm` and keeps the ref; with the right one clears it;
  5. `install` of a valid recipe ends with `host()` `running` and writes one unit whose bytes equal `renderUnit`;
  6. each 8.1 recipe rule rejects `bad-recipe` before any provider call;
  7. `update` restarts the unit;
  8. `logs(10000)` asks for at most 500 lines;
  9. `wake` on an `on` machine makes no provider call;
  10. `sleep` with `keepCopies: false` rejects `unsupported`;
  11. a missing optional method rejects `unsupported` (or resolves `null` for `url`);
  12. `cost()` returns the section 10 shape with filled words;
  13. (*fake*) `host()` maps every 8.5 row;
  14. (*fake*) the linger refusal rejects `linger` with `extra.command`;
  15. `plan()` resolves the provider's plan, or `null` when the provider has none;
  16. (*fake*) `why()` is `null` when on, and each 5.7 fallback in order when asleep;
  17. `deliver` writes one file at mode 0600 under `<workDir>/.byokit/inbox/`, and rejects a bad name or 64 KB + 1;
  18. (*fake*) root steps without passwordless sudo reject `needs-root` with every line in `extra.command`;
  19. `install` writes `installed.json` with the ref's id.

  Cases marked *fake* skip on a bench without `fake`.

## 14. Work packages

Builders: **Opus** (spec, architecture, real-provider proof) and **Muse** (builds) (D-16).
- Each package is one direct PR to byokit. It commits only its listed files (plus the lockfile) and keeps
  `npm run build`, `npm run check`, `npm test` and `npm run smoke:pack` green.
- A package that changes `packages/machine/src/**` adds a `## Unreleased` bullet.
- **Stubs rule:** M1 creates every `src/*.ts` file of 3.1 that holds a public signature, with bodies
  `throw new Error('not built: <package id>')`. Later packages replace bodies only. A signature change is a spec
  change: stop and ask.
- **Exports test:** each package edits `test/exports.test.ts`, replacing stub assertions naming its own id with
  behaviour assertions.
- Nothing committed names a machine provider (D-2). Every PR's diff, commit messages and PR text are checked for it.

### 14.1 Dependency graph

```
M0 (this doc, README and CONTRIBUTING lines)
 ├─ M1 Muse ─┬─ M2 Muse ── M3 Muse ─┐
 │           └─ M4 Muse ────────────┼─ M6 Opus (captain's go to spend) ─┬─ M7 Opus check, Muse build
 └─ M5 Muse ────────────────────────┘                                   └─ M8 Muse (claim, copy detection)
```

M2 and M4 both touch only their own files after M1. M3 and M4 both add to `src/testing/contract.ts`; the later merge
rebases.

### 14.2 Packages

**M0 — spec** · Opus · deps: none
- **Files:** `docs/machine-kit.md`; the D-15 sentence in `CONTRIBUTING.md` and `README.md`; the direction line (1) and a
  contents link in `README.md`.
- **Acceptance:** main approves; section 4.1 matches the approved design's types exactly; no machine provider is named
  in the diff.

**M1 — scaffold** · Muse · deps: M0
- **Files:**
  - `packages/machine/{package.json,tsconfig.json,README.md,CHANGELOG.md,LICENSE}`, `private: true`, version `0.1.0`,
    `exports` for `.`, `./ssh`, `./idle` and `./testing` (D-6), each with `types` and `default`, and `.` and `./idle`
    also with `react-native` and `browser` conditions pointing at the same file.
  - Every 3.1 source file; real bodies for `types.ts`, `errors.ts`, `words.ts`, `words.json`, `unit.ts`, `recipe.ts`,
    `cost.ts`, `machine.ts` (sections 5 and 8 over any `Provider`), and `testing/{index,fake-provider,contract}.ts`;
    stubs for `sandbox-api.ts` (M4), `ssh.ts` (M2), `wake.ts` and `idle.ts` (M7), `claim.ts` (M8), `testing/fake-sandbox-server.ts`
    (M4) and `testing/fake-ssh.ts` (M2).
  - Tests: `test/{exports,words,unit,recipe,cost,machine,contract,portable}.test.ts`, and `test/golden/` with the two
    unit files for the recipe in `unit.test.ts`.
  - Root: `package.json` `scripts.build` gains `packages/machine` after `packages/overlay`;
    `scripts/fix-words-dts.cjs` gains `machine`; `scripts/release.ts` canonical order gains `machine` after
    `overlay`; `tsconfig.json` references it if the others are referenced there; README packages table row marked
    unreleased.
- **Acceptance:**
  - `contract.test.ts` runs `machineContract` against `fakeProvider()`, and all 19 cases pass.
  - `words.test.ts` passes as in 13.2.
  - `unit.test.ts`: both golden files byte for byte; an arg with `"`, `\`, `%` and `$` round-trips per 8.2.
  - `recipe.test.ts`: every 8.1 rule, one failing and one passing case each; `API_KEY`, `token`, `DB_PASSWORD` and
    `Secret_x` refused; `/home/user/../etc` refused; `node.range` `>=24.15.0 <25 || >=25.9.0` accepts `24.21.0` and
    `25.9.0` and rejects `24.14.9` and `26.0.0` as a machine version; a `workDir` outside `<home>/.users/<user>/` with
    `user` set refused.
  - Types include every 4.3 member; `machine.ts` implements 5.7 and 5.8 over any `Provider`.
  - `cost.test.ts`: the four 10.2 always-on figures via `estimate`, the plan-floor case, a stale `checked` appending
    `cost.checked`, and a projected `usage` cost with a floor.
  - `portable.test.ts` passes for `.`.
  - `npm run check`, `npm test` and `npm run smoke:pack` green.

**M2 — SSH VM adapter** · Muse · deps: M1
- **Files:** `src/ssh.ts`, `src/testing/fake-ssh.ts` (a Node script run as the fake `ssh` and `ssh-keyscan` from one
  scratch dir; it records argv, env and stdin to a JSON log and serves a scripted machine state from a JSON file),
  `test/{ssh,isolation}.test.ts`, and additions to `test/contract.test.ts`.
- **Acceptance:**
  - `machineContract` passes against `sshVm` with the fake `ssh` (the non-*fake* cases, plus create-by-adoption).
  - `ssh.test.ts`: exact argv (7.1); env exactly `{ LANG: 'C.UTF-8' }`; relative and non-executable `ssh` rejected;
    NUL rejected; exit 255 with each mismatch text gives `host-key-changed`; another 255 gives `unreachable`; the
    8 MB cap; timeout → SIGTERM → SIGKILL on a fake that ignores SIGTERM; calls before `confirm()` reject `host-key`;
    `sshHostKey` prefers ed25519, reports `pinned`, and `confirm()` writes one line at mode 0600.
  - `isolation.test.ts` passes as in 13.2: the decoy's `~/.ssh` is untouched.

**M3 — install and supervise on both adapters** · Muse · deps: M2
- **Files:** `src/node.ts`, `src/machine.ts` (install, update, host, logs and deliver as run through a real adapter's
  exec), `test/{node,install}.test.ts`, the fake-ssh script's systemd, journal, `sudo` and `useradd` answers, and
  contract cases 5 to 8 and 17 to 19 on the SSH bench.
- **Acceptance:**
  - Golden unit files for both adapters (system unit for `sandbox-api`, user unit for `ssh-vm`, `Restart=always`).
  - The fake machine runs a three-step recipe to `running`; `onLine` receives every step's lines in order.
  - Node: a machine `node` at or above the recipe version is used; an older or missing one triggers the tarball steps
    in 8.3 order; a sha256 mismatch rejects `bad-recipe` and deletes the file.
  - The linger-refused path rejects `linger` with `extra.command` and `words('host.linger', …)` is a filled sentence.
  - G5: a machine node inside `node.range` is used; one outside it installs the tarball; `installRoot` runs as root
    before `install` and again before `update`; without passwordless sudo the kit rejects `needs-root` before running
    any step, with every line in `extra.command`.
  - G6: the README's recipe section states the one-process rule and the wrapper pattern (8.1).
  - G7: a recipe with `user` creates the user once (a second install skips `useradd`), runs `install` argv through
    `sudo -n -u <user> --`, installs node under that user's home, and renders a system unit with `User=<user>` on both
    adapters (golden files).
  - G9: `deliver` lands at `<workDir>/.byokit/inbox/<file>` owned by the run user.
  - `host()` maps every 8.5 row; `update` rewrites the unit only when it changed.

**M4 — sandbox API adapter** · Muse · deps: M1
- **Files:** `src/sandbox-api.ts`, `src/testing/fake-sandbox-server.ts` (a loopback `node:http` server on
  `127.0.0.1:0` answering the 6.1 routes with the response fields 15.1 lists, a state machine per id, and a request
  log), `test/sandbox-api.test.ts`, additions to `test/{contract,portable}.test.ts`. The M4 brief gives the builder
  the provider's public API document; the fake copies only the fields 6.1 uses, and nothing committed names the
  provider or its host (fixtures use `http://sandbox.test` mapped to the loopback port through the `fetch` option).
- **Acceptance:**
  - `machineContract` passes against `sandboxApi` over the fake server.
  - Rule 3 assertions from the request log: create has `noEnv: true`; no body has `env`; resume and fork bodies have
    no `noEnv`; create, resume and fork send `ttlSeconds: null`, or `7200` while the fake's plan says
    `canStayOn: false` (G2).
  - Every 6.2 row, including `waking` after `archived` and during `wake()`.
  - `exec`: single-quote quoting; `root` → `sudo -n`; emulated stdin writes, runs and removes the temp file;
    `timeoutMs` > 600 000 runs detached and times out with `kill -TERM`.
  - `write` outside `/home/user/` and `/tmp/` rejects before any request.
  - `create` retries with the same `Idempotency-Key` after a dropped connection.
  - `remove` sends `X-Ascii-Confirm-Delete`, polls the deletion, then deletes every `byokit-<name>-` named snapshot and
    no other.
  - 401 → `unauthorized`; 429 and 5xx retry three times; the key never appears in any error message.
  - `usage` maps to `Usage`; a zero balance rejects `balance`; `key()` maps expiry.
  - G2: `plan()` maps the fake's trial answer; with `canStayOn: false`, create, resume and fork send `ttlSeconds: 7200`,
    and after the fake ends the trial the next resume sends `null`.
  - G3: every stop reason the API document lists maps to its `AsleepWhy`; with no reason field, `why` is absent from
    the adapter.
  - `portable.test.ts`: `.` still has no `node:*` import (the fake server lives only in `./testing`).

**M5 — relay keepalive** · Muse · deps: none
- **Files:** `packages/relay/src/{client,relay}.ts`, `packages/relay/test/keepalive.test.ts`, `packages/relay/CHANGELOG.md`,
  relay patch version.
- **Behaviour:**
  - `RelayClientOptions` gains `pingMs?: number` (default 20 000). While `online`, the client sends
    `{ t: 'ping', id }` every `pingMs` outside the call queue. Any frame from the relay counts as heard. With no frame
    for `2 × pingMs` it closes the socket and reconnects with its existing backoff. It uses link's late-tick guard
    (`packages/link/src/device.ts` `ping()`, commit `08a9f27`): a tick that fires more than `pingMs / 2` late resets
    the silence clock instead of dropping the socket.
  - `Relay.control` answers `t: 'ping'` with `{}` (older relays answer "unknown request", which still counts as heard,
    so a new client works with an old relay).
  - `Relay` sends WebSocket ping frames to every host and device socket every 30 s and terminates a socket that
    missed two pongs.
- **Acceptance:** `keepalive.test.ts` covers a half-open host socket (the fake relay stops answering, the client
  reconnects within `2 × pingMs` plus one tick), a frozen-timer tick that does not drop a healthy socket, a new client
  against a relay without the ping handler, and server-side termination of a socket that never pongs; existing relay
  tests stay green.

**M6 — real-provider proof** · Opus · deps: M3, M4, M5 and **the captain's go to spend**
- **Files:** `packages/machine/test/lab/proof.ts` (excluded from `npm test`; `lab/` is not in the glob), a
  "Real-provider run" section appended to this document, README "Tested against a real provider" line (date and
  adapter only), `private` removed, CHANGELOG bullet.
- **Checks,** on one real sandbox API machine and one real SSH VM, each recorded:
  - the full `machineContract` against both;
  - a real app host recipe to `running`, and the app's own doctor on the machine: unprivileged user namespaces and
    whether a 12 GB disk is enough (else the recommended size moves up);
  - WebSocket through the provider's HTTPS URL, and a phone pairing through it;
  - device-code sign-in from the machine's datacenter address;
  - stop and resume: the unit and relay come back; whether the IP changes or is IPv6-only; whether the relay port
    needs re-hosting after resume;
  - whether a redundant `noEnv` on resume would scrub (checked on a throwaway machine only);
  - G10: peak memory and disk use of the real app on the smallest size; whether a provider stop is a clean OS shutdown
    (SIGTERM reaches the unit); whether the provider's proxy sets `X-Forwarded-For` for the relay's per-source limits;
    that engine sign-ins survive stop and resume;
  - G1: whether a key from the provider's app sign-in can create, install into and host a machine;
  - G2: the trial's auto-stop cap and the plan fields `GET /limits` returns on a new account;
  - G4: how a machine reads its own provider id (hostname, a metadata route or a file), recorded as `selfId`'s argv
    in 15.1.
- **Acceptance:** the recorded run in this document with every check's result; the kit leaves `private` only after
  it. The run and the PR name no provider.

**M7 — sleep and wake** · Opus design check, Muse build · deps: M6
- **Files:** `src/{wake,idle}.ts`, `test/{wake,idle}.test.ts`, contract additions, README section.
- **Behaviour:**
  - `wakeResolve({ provider, ref, port })` returns a `Dial.resolve` function for link. Before every dial it calls
    `status()`; only when `asleep` does it call `wake()` and then `url(port)` (re-hosting the relay port), resolving
    the new URL's host with the dialled path, or the dialled URL unchanged when it is already `on`. `unknown` resolves
    the dialled URL unchanged (the dial then fails on its own).
  - The phone holds one wake key scoped to read, resume and host on one machine id; the app stores it like the
    provider key. The machine holds a stop-only key (stop on its own id) at 0600 in the kit's state dir; the README
    and `copies.on`'s screen say that it is inside snapshots and forks and that any process on the machine can stop
    it.
  - `idle({ linked, held, minutes, stop })` checks once a minute; after `minutes` consecutive minutes with
    `linked() === 0` and `held() === false` it calls `stop()` once and waits for the process to end. `close()` stops
    the timer. It imports no other kit; the app wires `linked` from its link host and `held` from its own keep-awake
    signal.
  - A machine with `keepCopies: false` never gets `idle` wired (the app checks `ref.keepCopies`).
  - G11: `sandboxApi` implements `wakeKey(ref, { label })`, minting one wake key per phone (label = the phone's name,
    scoped to read, resume and host on `ref.id`), and `revokeKey(id)`. The app mints one when it pairs an owner phone
    and revokes it when it removes that phone.
- **Acceptance:** fake-provider tests: wake on open; no wake when already `on`; no sleep while `held()`; a cold-boot
  wake leaves the unit running (the fake restarts enabled units on wake); `idle` fires `stop` exactly once;
  `portable.test.ts` covers `./idle`; two phones get two wake keys with distinct ids, and revoking one leaves the other
  working against the fake server.

**M8 — account link and copy detection** · Muse · deps: M6
- **Files:** `src/claim.ts`, `src/sandbox-api.ts` (`selfId` from 15.1), `src/unit.ts` (`ExecStartPre`), the boot script
  template in `src/unit.ts`, `test/{claim,boot}.test.ts`, fake-server routes for the sign-in flow, README section.
- **Behaviour:** 11.5 and 8.6, using the routes and fields M6 recorded in 15.1.
- **Acceptance:**
  - `claim.test.ts` against the fake server: the steps arrive in order `open-page`, `type-code`, `waiting`, `done` with
    the key, expiry and scopes; an expired code yields `failed` with `expired`; aborting the signal ends the iterator
    and stops polling; the key never appears in any step but `done`.
  - `boot.test.ts`: the unit golden files with `ExecStartPre`; the boot script run under Node with a fake `selfId`
    writes `copy: false` for the installed id and `copy: true` for another, always exiting 0.
  - If M6 found the claimed key cannot create or host, M8 ships `claim()` with the words staying on `setup.makeKey`
    and the README says so; if M6 found no `selfId`, the copy-detection half is dropped from M8 and 8.6 records it.

Adoption (each app's setup screen, recipe and any cold-boot hook) happens in that app's own home after M6. Nothing in
BYOKit waits on it.

## 15. Known facts builders must not re-derive

### 15.1 The sandbox API shape (public docs, read 2026-09-29)

- Base path `/api/v1`, Bearer key. Machines are "sandboxes". Machine user `user`, home `/home/user`, passwordless sudo,
  real systemd, x86_64, a current Node preinstalled.
- Sizes (`sizes()`): `small` = 2 vCPU / 4 GB / 12 GB disk; `default` = 4 vCPU / 8 GB / 50 GB disk.
- Sandbox states: `init`, `provisioning`, `provisioned`, `cloning`, `ready`, `idle`, `running`, `archiving`, `archived`,
  `error`, `cancelled`.
- `ttlSeconds: null` disables auto-stop. The trial caps the TTL at 2 h, so always-on needs a paid account.
- `Idempotency-Key` is scoped to the account and kept 24 h.
- Commands: `timeoutSeconds` at most 600; no stdin; `detached` for long runs.
- Files API writes only under `/home/user` and `/tmp`.
- Snapshots capture the home, `/etc`, `/usr`, `/opt`, `/root`, `/srv` and systemd services; not `/var`. At most 10
  named snapshots, no expiry; resume uses the latest, with no restore to an arbitrary point.
- Hosted port URLs are `https://<machine>-<port>.<provider domain>`.
- Usage is priced at list price. A running machine is stopped 24 h after the balance reaches zero.
- Trial: a new account's plan starts with a 7-day trial; during it auto-stop cannot be disabled and cannot exceed 2 h
  (the provider's error is `trial_auto_stop_required`). How to end a trial early is not stated.
- App sign-in: a short code typed on the provider's page yields a scoped key with an expiry; whether its scopes cover
  create over the REST API is not stated (M6).
- Keys: every key expires, 365 days at most; an unscoped key is admin with 90 days; only a browser session or an
  admin key can mint keys; id- and action-scoped keys with default deny exist.
- The account-id and current-key routes (`GET /me`, `GET /api-keys/current` in 6.1), the plan and trial fields of
  `GET /limits` (G2), any stop-reason field on a sandbox (G3), and every response field name are confirmed against the
  public API document in M4's brief. The app sign-in's routes (G1) are confirmed the same way in M8's brief, and
  `selfId`'s argv (G4) comes from M6's recorded run. A different route or field there is a spec fix to 6.1 and
  this list, made before M4 builds, not a builder choice.
- CORS allows only localhost origins and omits `Idempotency-Key`, so the adapter does not run from a web page.

### 15.2 Machine facts

- A VM that is powered off still bills; only per-second sandbox APIs stop billing while asleep.
- `loginctl enable-linger` starts a user manager at boot and keeps it after logout; polkit may refuse it for a
  non-root user.
- `ssh-keyscan` output taken without checking the fingerprint is open to a man-in-the-middle; hence 7.2.

### 15.3 Repo facts

- The canonical release order is at `scripts/release.ts:551`; the build list is root `package.json` `scripts.build`;
  `scripts/fix-words-dts.cjs` lists every package with a `words.json` import.
- The jargon expression is in `packages/herdr/test/words.test.ts`.
- The decoy HOME, canaries and `traceFs` are in `packages/accounts/src/testing`.
- Link's `Dial.resolve` runs before every dial (`packages/link/src/device.ts`); link takes up to 8 candidate URLs.
- `RelayClient` and `Relay` send no ping or pong today; the relay answers an unknown host request with
  `{ t: 'res', id, ok: false, error: 'unknown request' }` (`packages/relay/src/relay.ts`, `control`).

## 16. Consumer gaps G1-G11

The first consuming app (a crew app running an OpenClaw-based host plus its own relay) wrote its consumer design
against this kit and listed eleven gaps. Each one is either adopted here or left with the app, with the reason.

| Gap | Ask | Decision | Where |
|---|---|---|---|
| G1 | Link a provider account without pasting a key | **Adopted**: `claim()` over the provider's app sign-in; key paste stays as the fallback words | 4.3, 11.5, 12 `setup.*`, M6 scope check, M8 |
| G2 | Plan and trial facts; a trial machine can't stay on | **Adopted**: `Provider.plan?`, `Machine.plan()`; during a trial the adapter asks for the 2-hour maximum instead of always-on, and words explain it | 4.3, 5.7, 6.1 Trial, 12 `plan.trial`, M4, M6 |
| G3 | Why the machine is asleep | **Adopted**: `AsleepWhy`, `Provider.why?`, `Machine.why()` with fallbacks, `asleep.*` words | 4.3, 5.7, 6.1, 12, M4 |
| G4 | Detect a copied machine (fork) at boot | **Adopted**: `installed.json` at install; `boot.json` with `copy` written each boot once M6 finds how a machine reads its own id. Refusing to run while a copy is the **app's** decision and words | 4.3 `selfId`, 8.6, M3, M6, M8 |
| G5 | Node version range; root install steps | **Adopted**: `node.range`, `installRoot` (re-run on update), `needs-root` with the lines to run and `host.needsRoot` | 4.3, 8.1, 8.3, 8.4, M1, M3 |
| G6 | Two processes (host and relay) | **Stays in the app**, rule stated: one unit runs one `run` argv; an app wrapper starts both and exits when either dies, and systemd restarts and stops the whole group. A multi-process `run` would make the kit a process manager | 8.1, M3 README |
| G7 | A no-sudo run user | **Adopted**: optional `HostRecipe.user`, created by the kit with its home inside the machine user's home so it is still copied; system unit with `User=` on both adapters. It narrows 13.1 rule 11 for apps that set it | 4.3, 8.1, 8.2, 8.4, M3 |
| G8 | Cloud-init text for phone-only setup on a plain VM | **Not in v1**: the SSH VM path is the technical option and runs from a desktop app; a text the person pastes into a provider's box is a new setup path with no proof yet. Revisit after M6 if a phone-only VM user appears | none |
| G9 | Hand the running host a small file (owner recovery with a new phone's key) | **Adopted**, narrowly: `Machine.deliver(recipe, file, bytes)` into `<workDir>/.byokit/inbox/`, 64 KB, 0600 | 4.3, 5.8, M3 |
| G10 | More real-machine checks; clean stop | **Adopted**: `sleep()` always stops the unit first; memory, disk, clean shutdown, forwarded-for header and sign-ins across stop are M6 checks. The app's own doctor run rides on the same M6 run | 5.4, M6 |
| G11 | One wake key per phone, revocable | **Adopted** in M7: `Provider.wakeKey?`, `revokeKey?`; the app mints on pairing and revokes on removal | 4.3, M7 |

The app's own fixes that its design found (restart-safe job limits, a persisted last tick for cold boots, an answers
store for replayed requests) are the app's, in its own home; nothing in BYOKit waits on them.
