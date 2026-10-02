# Capability kits: `@byokit/write`, `@byokit/record`, `@byokit/overlay`, `@byokit/secrets`, `@byokit/statusbar`, `@byokit/push` and `@byokit/share`

Foundation spec and builder breakdown. Status: **design approved for build (BK-0); the `write` and `record`
scaffolds are in the repo with frozen signatures, `@byokit/secrets` (section 11) is implemented,
and nothing else here is implemented yet. `@byokit/share` (section 14) has its TypeScript
surface and JS hook layer in the repo (offline tests only); none of its native code is built, prebuilt or run.**
This document is the single source of truth for the build lanes. A builder follows it literally. Where it is silent,
the builder stops and asks rather than designs. Section 9 is the work-package list.

Contents: [1 Goal](#1-goal) · [2 Decisions](#2-decisions) · [3 Shared conventions](#3-shared-conventions) ·
[4 `@byokit/write`](#4-byokitwrite) · [5 `@byokit/record`](#5-byokitrecord) ·
[6 Recorder protocol v1](#6-recorder-protocol-v1) · [7 `@byokit/overlay`](#7-byokitoverlay) ·
[8 Tests, CI and isolation](#8-tests-ci-and-isolation) · [9 Work packages](#9-work-packages) ·
[10 Known facts builders must not re-derive](#10-known-facts-builders-must-not-re-derive) ·
[11 `@byokit/secrets`](#11-byokitsecrets) · [12 `@byokit/statusbar`](#12-byokitstatusbar) ·
[13 `@byokit/push`](#13-byokitpush) · [14 `@byokit/share`](#14-byokitshare)

## 1. Goal

BYOKit gains these **capability kits**. Each one is named for what it can do, not for the product behind it:

- **`@byokit/write`**: drafting in a person's voice. It covers voice rules, the platforms a post can go to with
  their limits, the brief lines a writer follows, model-free checks on drafts (fit, voice, stock phrasing, kept facts)
  and thread splitting. It wraps the public `ownvoice-engine` npm package, pinned exactly. It makes no model call.
- **`@byokit/record`**: recording a screen or a desktop into a take, then turning the take into a video. It owns
  an open **recorder protocol v1** (section 6) and drives any recorder that implements it. The app passes that
  recorder by absolute path, or uses the bundled Linux X11 recorder when `bin` is omitted.
- **`@byokit/overlay`**: a floating on-screen bubble on Android. It has a panel that opens on tap, per-app visibility
  rules, a text-free tap log and an optional focused-field reader. On iOS it reports `unsupported`.
- **`@byokit/secrets`** (section 11, L-KEY): one secret per name for apps, from the OS keyring, a
  passphrase-sealed file, or a host-passed override for CI. It only consumes `@byokit/seal`.
- **`@byokit/statusbar`** (section 12, BK-S1): one ongoing job shown as a status-bar chip on Android 16 (a promoted
  ongoing notification), with a counts-only lock-screen copy and up to three actions. On iOS and below Android 16 it
  reports `unsupported`.
- **`@byokit/push`** (section 13): opens sealed push title and body before native display on iOS and Android.
- **`@byokit/share`** (section 14): receiving shared text and files in an Expo app through expo-share-intent's full
  public API, with a crash-safe Android receiver of its own, plus two option-gated build fixes on the same plugin
  (`appleTargets` for @bacons/apple-targets, `desklink` for @desklink/react-native). It runs against the stock
  published upstreams, pinned exactly, and never edits `node_modules`.

An app such as a writing helper or a demo-video helper uses these kits the way a coding app uses `@byokit/herdr`.
The kit supplies the typed, supervised, tested integration. The product keeps its own prompts, screens and
decisions. The kits never import each other, and no kit imports a runtime kit.

Out of scope for the build phase: any change to the upstream engine or recorder (their homes build those), releasing
(the owner runs `release.yml`), and adoption in any app.

## 2. Decisions

These close every design call. Builders do not reopen them; a reviewer who disagrees raises it with firstmate.

| # | Decision |
|---|---|
| D-A | Kits wrap an upstream engine. Product and domain behaviour stays in the product: prompts, scoring rules, planning, rendering, moods and labels. The kit adds the version pin, supervision, the typed surface, fakes and plain words, the same way `@byokit/openclaw` and `@byokit/herdr` do. |
| D-B | Kit names and person-visible words are capability words. The compose engine's package name (`ownvoice-engine`) is public and pinned, so it appears in `packages/write/package.json`, `constants.ts` and this document. No recorder product is named anywhere in BYOKit: not in code, docs, words, tests, commits, PR text or the isolation sentence. The kit and its tests refer to "a recorder implementing recorder protocol v1". |
| D-C | `@byokit/write` makes no model call and holds no key. Nothing it exports takes a key, and the engine it loads makes no network call (section 8 proves both). `@byokit/record` takes a planner key only as a string from the app and hands it to the recorder only on file descriptor 3 (6.6), never through env, argv or a file. |
| D-D | The isolation rule "byokit … never runs their CLIs" gets a separate carve-out for capability kits instead of stretching the runtime-kit wording. `@byokit/write` may load only its exactly pinned public engine package. `@byokit/record` may spawn a protocol-v1 recorder passed by absolute path or its bundled Node entry using the running Node executable. `@byokit/overlay` runs only its own native code inside the app, and so does `@byokit/statusbar` (D-T). The sentence lives in `CONTRIBUTING.md` (Rules, Isolation first) and `README.md` (What byokit never touches). |
| D-E | Packages `@byokit/write`, `@byokit/record`, `@byokit/overlay` in `packages/write`, `packages/record`, `packages/overlay`. All three are Apache-2.0 ESM and follow the repo's source rules: type-stripped TS, `.ts` imports, no enums, namespaces or parameter properties. Each is `private: true` at 0.1.0 until its proof lands (BK-P2, BK-C3, BK-O3). |
| D-F | Entries. write: `.` (Node), `./testing`, bin `write`. record: `.` (Node), `./testing`. overlay: `.` (native-free, every platform) with a `react-native` condition to `dist/rn.js`, and `./focused-field` with the same condition pair. No other entries. |
| D-G | Library code reads no environment variable. Every spawned process gets an env built from nothing (5.4, 4.6). `process.env` is never inherited or read, including for `PATH`. |
| D-H | The compose engine is an exact `dependencies` pin, loaded in process by `inProcessEngine()`. It is not installed at run time the way openclaw's `engine/` is, because compose keeps no state directory. `binEngine({ bin })` runs the engine's own bin as the fallback path for hosts that want the engine in its own process. The kit accepts engine protocols from `PROTOCOL_FLOOR` to `PROTOCOL`; anything outside that range is `needs-update` and fails closed. |
| D-I | Compose's public types are frozen by hand in 4.3 from the engine's protocol 1 surface. BK-P2 generates types from the engine's committed schema (sha256-pinned) and a type-level test proves they match 4.3 both ways. If they diverge, the builder stops: that is a spec change, not a builder fix. |
| D-J | `@byokit/record` owns recorder protocol v1 (section 6) and its JSON Schema (`packages/record/schema/recorder-protocol-1.json`, BK-C1). The bundled Linux X11 recorder implements this protocol; external recorder code is not committed. A recorder conforms by implementing section 6 under a `capture` sub-command. Within v1, only additive changes happen: new optional fields, new events and new error codes. Anything else is protocol 2. |
| D-K | Capture supervision (5.4): explicit absolute `bin` or bundled entry, env from nothing, argv array with NUL rejected, per-call timeouts, an 8 MB cap per stream for `hello`, `stop` and `make`, and for `record` an 8 MB stdout total, a 64 KB line cap and a rolling 2 KB stderr tail (5.4; the herdr `runCli` shape), and an abort signal that maps to `capture stop`. Display variables pass only for the source that needs them. |
| D-L | Consent belongs to the OS and the person. The kit never retries, bypasses or answers a consent prompt. A refused, timed-out or pre-consent-stopped recording leaves no take and nothing in the recorder's state dir (6.4 rule 4, a MUST). This is why the words can say "Nothing was kept." |
| D-M | The planner is off unless the app passes `plannerKey`. With a key the app must also pass `maxTokens` (the type requires both together). Planner billing is per use on the key's own account; the kit never says "subscription" for it. |
| D-N | Kotlin returns for `@byokit/overlay` only (7.1). The frozen `android/` mirror stays frozen. The overlay's Kotlin is written clean-room from the behaviour described in this document, and no Ownvoice code is copied. |
| D-O | Overlay privacy: nothing reads another app's screen in the background. `FocusedField` reads only when the app calls `read()`, and only through the app's own accessibility service. The tap log has no text field and prunes entries older than 30 days. The kit's words never claim where data goes. |
| D-P | Words. Each kit has `src/words.json` with the sentences in 4.8, 5.6 and 7.7. Each is tested against the repo's banned-jargon expression (the same one `packages/herdr/test/words.test.ts` uses). Compose's words must also avoid privacy claims: a test fails on `this phone`, `leave`/`leaves` and `never sent` (4.8). |
| D-Q | Fakes and contracts (3.4). write and record each ship a fake and a contract suite in `./testing`. overlay's JS core takes an injected native module (7.3) and has no public `./testing`. |
| D-R | Release: 0.1.0 `private: true`. write publishes after the real-engine CI job is green (BK-P2) and bumps minor for every new engine protocol pin. record publishes after the owner-machine conformance run is recorded (BK-C3). overlay publishes after the emulator proof (BK-O3). `scripts/release.ts`' canonical order gains `write`, `record` (BK-0) and `overlay` (BK-O1), in that order after `herdr`. |
| D-S | `@byokit/statusbar` (section 12) is named under D-B: `status` is the capability word. `ongoing` is Android jargon, `presence` reads as "online", and `live` is a product word on both platforms. It lives in `packages/statusbar`, follows D-E and D-F's overlay shape (`.` native-free with a `react-native` condition to `dist/rn.js`, no other entry), and is 0.1.0 `private: true` until its emulator proof (BK-S1, 12.8). The canonical release order gains `statusbar` after `overlay`. It is a sibling of overlay, not part of it: a chip needs neither the overlay permission nor a foreground service, and it has an iOS twin where overlay has none. |
| D-T | Kotlin carve-out beside D-N: Kotlin also returns for `@byokit/statusbar`, for the same reason (7.1): no JavaScript API can post a promoted ongoing notification with a lock-screen copy. The frozen mirror stays frozen, and nothing is shared between the overlay's and the statusbar kit's Kotlin. The statusbar Kotlin posts one notification from the app's own process. It runs no foreground service and no background work: keeping the process alive is the app's business. |

## 3. Shared conventions

Names, codes, errors, state, events, construction, options, words and export names follow
[kit-conventions.md](kit-conventions.md); this section adds only what is specific to the capability kits. Where
this spec prescribes a different shape, the spec wins until it is amended (kit-conventions Precedence).

### 3.1 Layers

```
app (drafting helper, demo helper, phone app: prompts, screens, decisions)
  │ uses                    │ uses                          │ uses
  ▼                         ▼                               ▼
@byokit/write             @byokit/record                @byokit/overlay
  │ in-process import       │ spawn, absolute bin           │ Expo native module (Android)
  ▼                         ▼                               ▼
ownvoice-engine (npm,    any recorder implementing      Android WindowManager,
 exact pin, public)       recorder protocol v1           AccessibilityService (app's own)
```

### 3.2 Source rules and files

Every package has `package.json`, `tsconfig.json` (the herdr one), `README.md`, `CHANGELOG.md` (first heading
`## Unreleased`), `LICENSE` (Apache-2.0, copied from `packages/herdr/LICENSE`), `src/`, `test/`.
`package.json` fields match `packages/herdr/package.json`: `repository.directory`, `engines.node >=22.18`,
`publishConfig.access public`, and a `files` list with `dist`, `README.md`, `LICENSE`, `CHANGELOG.md` plus the
kit's data dirs. `prepack` is `tsc -b && node ../../scripts/fix-words-dts.cjs`. The kit's dir is in the root `build`
list and in `scripts/fix-words-dts.cjs`' package list.

### 3.3 States, errors and plain words

write and record have no long-lived supervisor, so they have no `onState`. Each call resolves or rejects with the
kit's error class (`ComposeError`, `CaptureError`), whose `code` picks the sentence via `errorWords(e)`
([kit-conventions.md](kit-conventions.md) §3 and §9). overlay has one `OverlayState` and a `state` event (7.3).

### 3.4 Fakes and contract rule

write and record each ship a fake and a **contract suite** in `./testing`: `composeContract(make, o?)` and
`captureContract(make, o?)`. Both have the herdr shape: `make` returns a bench, and `o` is
`{ test?: TestFn } | TestFn`, with node:test's `test` as the default. The same assertions run against the fake in
`npm test` and against the real upstream:
- write: the real pinned engine, in CI job `write-engine` (BK-P2).
- capture: the bundled recorder against an isolated Xvfb in Linux CI, plus external owner/lab conformance (BK-C3).

Cases that need a scripted fault (`fake` present on the bench) skip on a real bench. A behaviour the fake has and the
contract does not assert is not relied on by any kit test.

## 4. `@byokit/write`

### 4.1 Files

```
packages/write/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  schema/engine-protocol-1.json          # BK-P2: `ownvoice-engine schema` output at the pin, sha256 in constants.ts
  scripts/gen-types.ts                   # BK-P2: schema → src/generated/protocol.ts
  src/index.ts  src/constants.ts  src/types.ts  src/errors.ts
  src/compose.ts                         # Compose client over the Engine seam (BK-P1)
  src/engine.ts                          # inProcessEngine, binEngine (BK-P2)
  src/cli.ts                             # bin `write` (BK-P1)
  src/words.json  src/words.ts
  src/generated/protocol.ts              # BK-P2
  src/testing/index.ts  src/testing/fake-engine.ts  src/testing/contract.ts   # BK-P1
  test/*.test.ts  test/engine/*.test.ts  # engine/ = real pinned engine, CI job only
```

`package.json`: `exports` `.` → `dist/index.js`, `./testing` → `dist/testing/index.js`; `bin`
`{ "write": "dist/cli.js" }`; `files` `dist`, `schema`, `README.md`, `LICENSE`, `CHANGELOG.md`. Dependencies:
none at BK-0; BK-P2 adds `"ownvoice-engine": "<exact>"`.

The React Native condition selects `dist/portable.js`; `./portable` explicitly selects the same entry for other
bundlers. Its `Compose` requires `{ engine: Engine }` (exported as `ComposeOptions`, also named
`PortableComposeOptions`). It shares all methods, validation and the version gate with the Node client, but
imports neither Node adapters nor the pinned engine. Node's `.` entry and CLI retain the lazy pinned default.
The host owns its engine/transport and text privacy. The current pinned engine's lookbehind expressions are not
Hermes-compatible, so the portable entry does not load it. Protocol 1 and generated/public wire parity are
unchanged: no voice-sample field or behavior is defined. The built-entry scripted protocol fixture is
`packages/write/test/fixtures/portable.ts`, with Hermes runner `packages/write/test/hermes.sh`.

### 4.2 Engine wire (what the kit expects from `ownvoice-engine` protocol 1)

The engine package exports `handle(request)`. It also has a bin that reads one JSON request on stdin and writes one
JSON response on stdout. The kit's `Engine` seam (4.5) sends:

```ts
type EngineRequest = { verb: EngineVerb; params: object };   // exact union in 4.3
// success: the verb's result object (4.3 EngineVerbs[V]['result'])
// failure: { error: { code: string; message: string } }
```

| Verb | Params | Result |
|---|---|---|
| `hello` | `{}` | `{ protocol: number; version: string }` |
| `voice.parse` | `{ markdown }` | `{ rules: Rules; skipped: number }` |
| `voice.guide` | `{ rules, post }` | `{ line: string }` (`''` when no rule applies) |
| `platforms` | `{}` | `Platform[]` |
| `brief` | `{ kind, platform, rules? }` | `{ lines: string[] }` |
| `check` | `{ drafts, platform, rules?, original? }` | `DraftCheck[]`, one per draft, same order |
| `split` | `{ text, platform }` | `{ posts: string[] }` |

If the engine's published protocol 1 uses a different envelope, BK-P2 adapts only `src/engine.ts`. The public types in
4.3 do not change. A result with a different shape is a D-I stop.

What protocol 1 at ownvoice `faf2fc2` actually speaks (BK-P2 adapted `src/engine.ts` only):
- Requests are flat, `{ verb, ...params }`, not `{ verb, params }`.
- `hello` is outside the schema: the engine answers it from `Protocol.hello()` in process and `ownvoice-engine hello`
  as a bin (argv `[bin, 'hello']`, nothing on stdin). The package exports the protocol as `Protocol` (`handle`, `hello`).
- The schema types requests only; each verb's result keys are in its `$comment`, which `gen-types.ts` reads.
- The schema's params are looser than 4.3: every `rules` field and both `voice.guide` params are optional, `platform`
  is the six-id enum and `drafts` has `minItems: 1`. The kit always sends the complete 4.3 shape, so
  `generated.test.ts` proves key-set equality both ways plus the kit's params fitting the wire, and equality for
  `Rules`, the kinds and every result's keys.

### 4.3 Public types (`src/types.ts`)

```ts
export type Rules = { never: string[]; noDashes: boolean; statementEndings: boolean; note: string };
export type ParsedVoice = { rules: Rules; skipped: number };      // skipped: never-say bullets too long to use
export type PlatformKind = 'chat' | 'feed' | 'mail';
export type Platform = {
  id: string;                        // 'x' | 'linkedin' | 'reddit' | 'slack' | 'whatsapp' | 'gmail' at protocol 1
  label: string;                     // 'X', 'LinkedIn', …
  kind: PlatformKind;
  limit: number | null;              // characters; null = no limit worth checking (mail)
  slots?: [string, string, string];  // the three reply slots
  polish?: string;                   // one extra polish rule, '' when none
};
export type BriefKind = 'reply' | 'polish' | 'post' | 'thread';
export type DraftCheck = {
  fits: boolean;                     // length <= limit, or limit null
  length: number;                    // characters
  limit: number | null;
  voice: string[];                   // plain-word breaks of the person's rules, e.g. 'says “delve” from your never-say list'
  stock: string[];                   // stock phrasing found, plain words
  added: string[];                   // numbers/times in the draft the original lacks ([] without original)
  dropped: string[];                 // numbers/times in the original the draft lacks ([] without original)
  layoutKept: boolean;               // lists and paragraphs kept (true without original)
  words: string;                     // the engine's verdict: 'Sounds natural' | 'A bit stock' | 'Sounds canned'
};
export type EngineHello = { protocol: number; version: string };
export type EngineVerbs = {
  hello: { params: Record<string, never>; result: EngineHello };
  'voice.parse': { params: { markdown: string }; result: ParsedVoice };
  'voice.guide': { params: { rules: Rules; post: boolean }; result: { line: string } };
  platforms: { params: Record<string, never>; result: Platform[] };
  brief: { params: { kind: BriefKind; platform: string; rules?: Rules }; result: { lines: string[] } };
  check: { params: { drafts: string[]; platform: string; rules?: Rules; original?: string }; result: DraftCheck[] };
  split: { params: { text: string; platform: string }; result: { posts: string[] } };
};
export type EngineVerb = keyof EngineVerbs;
export type EngineRequest = { [V in EngineVerb]: { verb: V; params: EngineVerbs[V]['params'] } }[EngineVerb];
export interface Engine {
  /** One request, one answer: the verb's result or `{ error: { code, message } }`. The kit validates the shape. */
  handle(request: EngineRequest): Promise<unknown>;
}
export type ComposeOptions = { engine?: Engine };            // default inProcessEngine()
export type ComposeErrorCode = 'missing' | 'needs-update' | 'engine' | 'invalid';
```

`src/errors.ts`:

```ts
export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  readonly detail?: Record<string, unknown>;   // engine: { engineCode }, needs-update: { protocol }
  constructor(code: ComposeErrorCode, message: string, detail?: Record<string, unknown>);
}
```

### 4.4 `Compose` (`src/compose.ts`, exported from `.`)

```ts
export class Compose {
  constructor(o?: ComposeOptions);
  hello(): Promise<EngineHello>;
  readonly voice: {
    parse(markdown: string): Promise<ParsedVoice>;
    guide(rules: Rules, o?: { post?: boolean }): Promise<string>;       // post default false
  };
  platforms(): Promise<Platform[]>;
  brief(o: { kind: BriefKind; platform: string; rules?: Rules }): Promise<string[]>;
  check(o: { drafts: string[]; platform: string; rules?: Rules; original?: string }): Promise<DraftCheck[]>;
  split(o: { text: string; platform: string }): Promise<string[]>;
}
```

Behaviour (BK-P1):
- **Version gate.** The first call of any method runs `hello` once and memoizes it. A `protocol` below
  `PROTOCOL_FLOOR` or above `PROTOCOL` rejects that call and every later one with
  `ComposeError('needs-update', …, { protocol })`. `hello()` itself also rejects then. Fail closed: no verb reaches
  the engine after a failed gate.
- **Validation before the engine.** Arguments must be strings or `Rules`. A `Rules` needs `never: string[]`, two
  booleans and `note: string` (at most 200 characters). `drafts` must have 1–50 entries. Each text must be at most
  100,000 characters with no NUL. Anything else rejects `ComposeError('invalid', <what is wrong>)`.
- **Answers.** `{ error: { code, message } }` rejects `ComposeError('engine', message, { engineCode: code })`. A
  result that fails the 4.3 shape check rejects `ComposeError('engine', 'engine answered an unexpected shape')`.
- **No state, no writes.** No cache beyond the memoized hello and no file access. `Compose` never reads env.

### 4.5 Engine seams (`src/engine.ts`, exported from `.`, BK-P2)

```ts
export function inProcessEngine(): Engine;
export function binEngine(o: { bin: string; timeoutMs?: number }): Engine;
```

- `inProcessEngine()` lazily `import(ENGINE_PACKAGE)` on the first `handle` and calls its `handle`. If the import
  fails with `ERR_MODULE_NOT_FOUND`, it rejects `ComposeError('missing', …)`.
- `binEngine` spawns `process.execPath` (the running Node) with argv `[bin]`, where `bin` is the absolute path of the
  engine's JS bin entry (else `missing`), and env `{ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }`. Running Node directly
  avoids a `#!/usr/bin/env node` shebang, which would search a PATH that holds no Node on most installs. It writes the request as one JSON line on stdin, then reads one JSON document from stdout. The timeout
  defaults to 10 s, clamped to 1 s–60 s. Output is capped at 8 MB per stream. ENOENT or EACCES gives `missing`. A
  non-zero exit with no JSON gives `engine`.

### 4.6 The `write` CLI (`src/cli.ts`, BK-P1)

The CLI is for agents and scripts, and prints TOON or plain `key: value` lines. `src/cli.ts` exports
`main(argv: string[], io: { engine?: Engine; stdout(s: string): void; stderr(s: string): void; readFile(path: string): string }):
Promise<number>` and runs it when executed as the bin, which makes the CLI testable with the fake engine.

```
write hello
write platforms
write voice parse <file>
write voice guide --voice '<rules json>' [--post]
write brief --kind reply|polish|post|thread --platform <id> [--voice '<rules json>']
write check --platform <id> [--voice '<rules json>'] [--original <file>] <draft file>...
write split --platform <id> <file>
```

Output format (values use the quoting rule below). The `check` example is what `fakeEngine({ version: '1.0.0' })`
prints when `b.md` is 301 characters, says "delve" and has `50` where the original has `40`:

```
$ write hello
protocol: 1
version: 1.0.0

$ write platforms
platforms[6]{id,label,kind,limit}:
  x,X,feed,280
  linkedin,LinkedIn,feed,3000
  reddit,Reddit,feed,10000
  slack,Slack,chat,40000
  whatsapp,WhatsApp,chat,65536
  gmail,Gmail,mail,none

$ write voice parse profile.md
rules: {"never":["delve","game changer"],"noDashes":true,"statementEndings":false,"note":""}
skipped: 0

$ write voice guide --voice '{"never":[],"noDashes":true,"statementEndings":false,"note":""}'
line: No em dashes.

$ write brief --kind reply --platform x
lines[3]:
  "Agree and add one concrete detail."
  "Push back kindly, with one reason."
  "Ask one sharp question."

$ write check --platform x --original original.md a.md b.md
drafts[2]{file,fits,length,limit,verdict}:
  a.md,yes,212,280,Sounds natural
  b.md,no,301,280,A bit stock
issues[3]{file,kind,detail}:
  b.md,stock,delve
  b.md,added,50
  b.md,dropped,40
result: 1 of 2 drafts pass

$ write split --platform x long.md
posts[2]:
  "First post…"
  "Second post…"
```

- **Quoting:** a value is printed through `JSON.stringify` when it is empty, contains `,` `"` `:` or a newline, or
  has leading or trailing space. Otherwise it is printed as is. Brief lines, posts and rules are always quoted
  (rules as one-line JSON so an agent can paste it back into `--voice`). `limit` null prints `none`.
- **Issues:** `kind` is one of `voice`, `stock`, `added`, `dropped`, `layout`. There is one row per entry, and the
  `layout` detail is `lists or paragraphs changed`. With no issues the block is the single line `issues: none`.
- **Pass:** a draft passes when `fits` is true, `voice`, `added` and `dropped` are all empty, and `layoutKept` is
  true (only checked with `--original`). Stock phrasing is reported but does not fail a draft.
- **Exit codes:** 0 when the command ran and every draft passes; 1 when `check` ran and at least one draft fails;
  2 on a usage error; 3 when the engine is `missing` or `needs-update`; 4 on any other engine failure.
- **Errors:** one line `error: <sentence>` on stderr, then for usage errors one line `help: <usage line of that verb>`.
  Before any verb that takes `--platform`, the CLI calls `platforms()` and checks the id. An unknown id is a usage
  error (exit 2) printing `error: unknown platform "<id>". Pick one of: <ids from platforms(), joined by ", ">`. A
  `ComposeError('invalid')` is also a usage error (exit 2) printing `error: <its message>`. `missing` and `needs-update` print `words('compose.missing')` and
  `words('compose.needsUpdate')`. Invalid `--voice` JSON prints `error: --voice is not valid rules JSON`.
- The CLI reads only the files named on its command line. It writes nothing, reads no env and never makes a network
  call.

### 4.7 Fake engine and contract (`./testing`, BK-P1)

```ts
export type FakeEngineOptions = {
  protocol?: number;                                     // default PROTOCOL
  version?: string;                                      // default '0.0.0-fake'
  fail?: { verb: EngineVerb; code: string; message: string };   // that verb answers the error envelope
};
export type FakeEngine = Engine & { requests: EngineRequest[] };   // every request, in order
export function fakeEngine(o?: FakeEngineOptions): FakeEngine;

export type ComposeContractBench = { compose: Compose; fake?: FakeEngine };
export type ComposeContractTestFn = (name: string, fn: (t: { skip(message?: string): void }) => void | Promise<void>) => void | Promise<void>;
export type ComposeContractOptions = { test?: ComposeContractTestFn };
export function composeContract(make: () => Promise<ComposeContractBench>, options?: ComposeContractOptions | ComposeContractTestFn): void;
```

The fake has its own small logic and copies no engine code:
- `platforms` returns the six platforms of 10.1 with their limits. Every platform has `slots: ['Agree and add one
  concrete detail.', 'Push back kindly, with one reason.', 'Ask one sharp question.']`, and `polish: ''` except `x`,
  whose polish is `'The first line must stand alone.'`.
- `voice.parse` collects `-`/`*` bullets under a heading containing "never say" (quoted text inside a bullet wins) and
  sets `noDashes` when the text mentions "em dash".
- `voice.guide` joins, with a space, `No em dashes.` (when `noDashes`), `End on a statement, not a question.` (when
  `statementEndings` and `post`) and `How they write: <note>` (only when `note` is non-empty).
- `brief` answers the platform's three slots for `reply`, `[polish]` for `polish` (`[]` when polish is empty), and one line
  `One post for <label>.` for `post`/`thread`.
- `check` measures `length` in UTF-16 units, as the engine does. `voice` lists
  `says “<phrase>” from your never-say list` for each case-insensitive whole-word never-say hit. `stock` lists hits
  of `delve`, `game changer` and `seamless`. `added`/`dropped` are the digit runs (`/\d+(?:[.,:]\d+)*/g`) present on
  one side only, and are `[]` without an original. `layoutKept` compares the count of `-`/`*`/`1.` list lines.
  `words` is `Sounds natural` with no stock hit and `A bit stock` otherwise.
- `split` splits at sentence ends (`. `, `! `, `? `) greedily under the limit, and hard-wraps a sentence longer than
  the limit at the last space.
- `hello` answers `{ protocol, version }`.

`composeContract` cases. All of them hold on the real engine too; the ones marked *fake* skip without `fake`:
1. `hello`: `protocol` is within `[PROTOCOL_FLOOR, PROTOCOL]` and `version` is a non-empty string.
2. `platforms`: ids include the six of 10.1 with exactly those `limit`s and kinds.
3. `check` on `x` with a 300-character draft: `fits: false`, `length: 300`, `limit: 280`.
4. `check` with `rules.never: ['delve']` on "Let's delve in.": `voice` has one entry containing `delve`.
5. `check` with original "Meet at 3pm on Friday, 40 seats." and draft "Meet at 3pm on Friday, 50 seats.":
   `added` includes `50` and `dropped` includes `40`. The same draft without the original has both `[]`.
6. `split` on `x` of a 600-character text of short sentences: every post is at most 280 characters, and joining the
   posts with a space, each with a leading `<n>/<m> ` counter stripped, gives the input with its whitespace collapsed.
   The engine numbers a thread's posts (`1/3 …`, D-A: numbering is engine behaviour); the kit returns them as is.
7. `voice.parse` of `"## Never say\n- delve\n- \"game changer\"\n"` gives `rules.never` that includes both.
8. `voice.guide({ …noDashes: true }, { post: false })` gives a line matching `/dash/i`.
9. `brief` of each kind on `x` gives at least one non-empty line.
10. *fake*: protocol `PROTOCOL + 1` gives `needs-update` on the first call and on a second call, and the fake saw only
    `hello`. Protocol `0` gives the same.
11. *fake*: `fail` on `check` rejects `ComposeError` `engine` with `detail.engineCode`.
12. Invalid input (`drafts: []`, NUL in a draft, `note` over 200) rejects `invalid`. With a fake bench it reaches no
    engine request.

### 4.8 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `compose.missing` | The writing checker isn't installed yet. |
| `compose.needsUpdate` | This app needs an update to check drafts. |
| `compose.failed` | The writing checker stopped with a problem. Try again. |
| `check.fits` | Fits on {platform}. |
| `check.tooLong` | Too long for {platform}: {length} characters, and the most is {limit}. |
| `check.voice` | Goes against your voice: {list}. |
| `check.stock` | Sounds stock: {list}. |
| `check.added` | Adds numbers or times the original doesn't have: {list}. |
| `check.dropped` | Drops numbers or times from the original: {list}. |
| `check.layout` | The lists or paragraphs changed from the original. |
| `check.keptFacts` | Kept the facts: every number and time from the original is still there. |
| `check.pass` | Ready for you to look over. |
| `check.fail` | Needs another pass. |
| `split.posts` | Split into {count} posts. |

- `words(key, vars)` fills `{platform}`, `{length}`, `{limit}`, `{list}` and `{count}`. An unfilled slot stays
  visible, as in herdr.
- `errorWords(e: ComposeError)`: `missing` → `compose.missing`, `needs-update` → `compose.needsUpdate`, `engine` and
  `invalid` → `compose.failed`.
- `checkLines(c: DraftCheck, platform: Platform, o?: { original?: boolean }): string[]` (BK-P1) returns, in order:
  - `check.fits` or `check.tooLong`, using the platform `label` (it says "Fits on {label}." when `limit` is null);
  - `check.voice` when `voice` is non-empty;
  - `check.stock` when `stock` is non-empty;
  - with `original` only: `check.added` if `added` is non-empty, `check.dropped` if `dropped` is non-empty,
    `check.keptFacts` if both are empty, then `check.layout` if `layoutKept` is false;
  - last, `check.pass` or `check.fail` by the 4.6 pass rule.

  `{list}` joins entries with `, `.
- Banned claims (D-P): no sentence may match `/this phone|\bleaves?\b|never sent/i`.

### 4.9 Version pin and upgrades

The pin is `ENGINE_VERSION`, the exact `dependencies` entry and `schema/engine-protocol-1.json` with its
`ENGINE_SCHEMA_SHA256`. An upgrade is one byokit PR that:
- bumps all three;
- re-runs `npm run gen:write`;
- runs the `write-engine` job green;
- bumps the kit's minor version;
- adds a CHANGELOG line naming the new engine version and any verb change.

A new engine protocol number also moves `PROTOCOL`. That is a spec change to 4.2 and 4.3 first. `scripts/pin-watch.mjs`
gains a compose section that compares the pin with npm's `latest` dist-tag for `ownvoice-engine` (BK-P2).

## 5. `@byokit/record`

### 5.1 Files

```
packages/record/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  schema/recorder-protocol-1.json         # BK-C1, JSON Schema 2020-12 of section 6
  src/index.ts  src/constants.ts  src/types.ts  src/errors.ts
  src/capture.ts                          # Capture client (BK-C2)
  src/protocol.ts                         # wire parsers for section 6 (BK-C1)
  src/supervise.ts                        # env, argv, spawn, caps (BK-C2)
  src/words.json  src/words.ts
  src/testing/index.ts  src/testing/fake-recorder.ts  src/testing/contract.ts   # BK-C1
  test/*.test.ts
```

`package.json`: `exports` `.` → `dist/index.js`, `./testing` → `dist/testing/index.js`; `files` `dist`, `schema`,
`README.md`, `LICENSE`, `CHANGELOG.md`; no dependencies.

### 5.2 Public types (`src/types.ts`)

```ts
export type SourceKind = 'screen' | 'x11' | 'android';
export type Source = 'screen' | `x11:${string}` | `android:${string}`;   // grammar in 6.4
export type EventsMode = 'own' | 'none';
export type DisplayVar = 'WAYLAND_DISPLAY' | 'XDG_RUNTIME_DIR' | 'DBUS_SESSION_BUS_ADDRESS' | 'HYPRLAND_INSTANCE_SIGNATURE' | 'XAUTHORITY';
export type CaptureOptions = {
  bin?: string;                                  // absolute external recorder; omitted: bundled Linux X11
  stateDir: string;                              // app-owned; the kit writes only under join(stateDir, 'capture')
  display?: Partial<Record<DisplayVar, string>>; // the session a `screen` or `x11:` recording needs (5.4)
  timeoutMs?: number;                            // make() timeout, default 600_000, clamped 1 s–30 min
};
export type RecorderHello = {
  protocol: number;
  recorder: { name: string; version: string };
  sources: SourceKind[];
  android: boolean;                              // = sources.includes('android')
  events: EventsMode[];                          // always includes 'none'
  planner: { available: boolean; needsKey: boolean };
};
export type RecordOptions = {
  source: Source;
  root: string;                                  // absolute; takes are created as direct children
  events?: EventsMode;                           // default 'none'
  maxSeconds: number;                            // integer 1–3600, a hard stop in the recorder
  signal?: AbortSignal;                          // abort → `capture stop` (5.4)
};
export type RecordEvent =
  | { event: 'consent-pending' }
  | { event: 'recording'; take: string }
  | { event: 'done'; take: string; seconds: number; warnings: string[] };
export type Caption = { t: number; text: string; d?: number };   // seconds from the take's start; d = duration
export type MakeOptions = {
  take: string;                                  // absolute take dir from a `recording`/`done` event
  planOnly?: boolean;                            // estimate only: no model call, no video
  title?: string;
  captions?: Caption[];
  set?: Record<string, string | number | boolean>;   // recorder-defined render settings (6.6)
  signal?: AbortSignal;                          // abort kills the make process and rejects signal.reason (5.3)
} & ({ plannerKey: string; maxTokens: number } | { plannerKey?: undefined; maxTokens?: undefined });
export type MakeResult = {
  out: string | null;                            // absolute .mp4 inside the take; null with planOnly
  seconds: number;
  beats: number;
  planner: { plannedTokens: number; inputTokens: number; usd: number; failed: boolean };
  warnings: string[];
};
export type CaptureErrorCode =
  | 'missing' | 'needs-update' | 'unsupported' | 'invalid'
  | 'consent-cancelled' | 'consent-timeout' | 'stopped' | 'already-recording'
  | 'preflight-refused' | 'take-input' | 'render-failed'
  | 'timeout' | 'too-much-output' | 'protocol' | 'failed';
```

`src/errors.ts`:

```ts
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  readonly why?: 'recorder' | 'app';             // needs-update only: which side is older
  readonly hint?: string;                        // the recorder's hint, for logs, never shown as words
  readonly detail?: Record<string, unknown>;     // preflight-refused: { planned, cap }; failed: { recorderCode, stderrTail }
  constructor(code: CaptureErrorCode, message: string, o?: { why?: 'recorder' | 'app'; hint?: string; detail?: Record<string, unknown> });
}
```

### 5.3 `Capture` (`src/capture.ts`, exported from `.`, BK-C2)

```ts
export class Capture {
  constructor(o: CaptureOptions);                // validates only; spawns nothing
  hello(): Promise<RecorderHello>;
  record(o: RecordOptions): AsyncIterableIterator<RecordEvent>;
  stop(): Promise<'stopping' | 'not-recording'>;
  make(o: MakeOptions): Promise<MakeResult>;
}
```

- **Constructor.** It throws `CaptureError('invalid')` when `stateDir` is not absolute, and `CaptureError('missing')`
  when an explicit `bin` is not absolute. Omitted `bin` selects the bundled entry. It never touches the disk.
- **`hello()`.** It runs `capture hello` and caches the answer on the first success. It checks the protocol range
  before any other field, so an out-of-range recorder gets `needs-update` even when the rest has changed. It rejects:
  - `missing` when the bin does not exist, is not a regular file or is not executable (checked before the spawn;
    ENOENT or EACCES at spawn also gives `missing`);
  - `needs-update` with `why: 'recorder'` when `protocol < PROTOCOL_FLOOR`, or `why: 'app'` when
    `protocol > PROTOCOL`;
  - `protocol` when the answer fails the 6.3 shape.
- **`record()`.** It calls `hello()` first. It rejects, on the first `next()`:
  - `unsupported` when the source kind is not in `hello.sources`, or `events: 'own'` is not in `hello.events`;
  - `invalid` for a bad source grammar, a relative `root`, or a `maxSeconds` that is not an integer from 1 to 3600;
  - `already-recording` when this `Capture` already has a recording running. The recorder enforces the same lock
    across processes.

  After that, it yields each known event in order. After `done` is yielded, the next `next()` resolves
  `{ done: true }` only after the process has exited, and a non-zero exit after `done` is ignored. If the process is
  still alive when the guard fires, it is killed and that `next()` rejects `timeout`. Unknown `event` values and unknown fields are dropped. The iterator
  ends after `done`. A recorder error line rejects the pending `next()` with the mapped code (6.7).

  If the process exits with code 0 without `done`, the error is `protocol`. Any other exit without an error line is
  `failed`, with `detail.stderrTail`: the last 2 KB of stderr.

  **Ending early.** An abort `signal` or the consumer's `return()` (breaking out of `for await`) runs `stop()`.
  - The process group is sent SIGTERM if it has not exited 10 s after `stop()`, and SIGKILL 5 s after that.
  - `return()` resolves `{ done: true, value: undefined }` only after the process has exited, so a `record()` started
    after it never sees `already-recording`. Stop buttons use `stop()` or `signal`, not `return()` while a `next()`
    is pending.
  - An abort after `recording` still yields `done` and then ends.
  - An abort before `recording` rejects `stopped`.

  **Wall-clock guard.** The kit ends a recording itself through `streamRecorder`'s guard
  (`guardMs = recordGuardMs(maxSeconds)`): SIGTERM to the process group, then SIGKILL 5 s later, with no
  `capture stop`. A guarded exit rejects `timeout`, and any `done` read after the guard fired is dropped, not yielded.
- **`stop()`.** It runs `capture stop --state-dir <recorderStateDir>` and returns `'stopping'`. It returns
  `'not-recording'` when the recorder answers that code.
- **`make()`.** It calls `hello()` first. It rejects:
  - `unsupported` when a `plannerKey` is passed and `hello.planner.available` is false;
  - `invalid` for a relative `take`, a NUL in any string, a `maxTokens` that is not a positive integer, a `set` key
    not matching `/^[a-z][a-z0-9_.-]{0,63}$/`, or a caption with a negative `t`.

  It writes the captions to `join(stateDir, 'capture', 'tmp', randomUUID() + '.json')` (mode 0600) and deletes the
  file when make settles. An abort of `signal` kills the process group (SIGTERM, SIGKILL 5 s later) and rejects with
  `signal.reason` (an `AbortError`, the fetch convention), not a `CaptureError`: the app asked for the stop, so there
  is no sentence to show. It maps the snake_case planner fields to `MakeResult`.

### 5.4 Supervision (`src/supervise.ts`, BK-C2)

```ts
export type Spawned = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean };
export function recorderEnv(o: { stateDir: string; source?: Source; display?: CaptureOptions['display'] }): Record<string, string>;
export type RecorderCall =
  | { verb: 'hello' }
  | { verb: 'stop' }
  | { verb: 'record'; o: RecordOptions }
  | { verb: 'make'; o: MakeOptions; captionsFile?: string };
export function recorderArgv(stateDir: string, call: RecorderCall): string[];   // starts ['capture', verb, …]
export function runRecorder(bin: string, env: Record<string, string>, args: string[], o: { timeoutMs: number; key?: string; signal?: AbortSignal }): Promise<Spawned>;
export function streamRecorder(bin: string, env: Record<string, string>, args: string[], o: { guardMs: number }):
  { lines: AsyncIterable<string>; exited: Promise<Spawned & { guarded: boolean }>; kill(signal: NodeJS.Signals): void };
export function recordGuardMs(maxSeconds: number): number;   // (maxSeconds + CONSENT_WINDOW_S + 30) * 1000
// guardMs: past it the stream stops itself (SIGTERM, SIGKILL 5 s later) and `exited` reports guarded: true
```

- **Layout.** The kit owns `join(stateDir, 'capture')` with mode 0700. Inside it:
  - `home/` is the recorder's `HOME`;
  - `recorder/` is the recorder's `--state-dir`;
  - `tmp/` holds caption files.

  It creates these with `mkdirSync({ recursive: true, mode: 0o700 })` on first use. It writes nothing else.
- **Env from nothing (D-G).** Every spawn gets exactly these variables, with `home = join(stateDir, 'capture', 'home')`:
  - `HOME = home`
  - `XDG_CONFIG_HOME = home/.config`
  - `XDG_STATE_HOME = home/.local/state`
  - `XDG_CACHE_HOME = home/.cache`
  - `XDG_DATA_HOME = home/.local/share`
  - `PATH = /usr/bin:/bin`
  - `LANG = C.UTF-8`

  Then, for `record` only:
  - `screen`: each of `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and
    `HYPRLAND_INSTANCE_SIGNATURE` that is present in `display`.
  - `x11:<d>`: `DISPLAY = <d>`, plus `XAUTHORITY` when present in `display`. The Wayland variables never pass,
    so recording a helper's own X desktop cannot reach the person's session.
  - `android:<serial>`: nothing more.

  `hello`, `stop` and `make` never get display variables.
- **argv.** It is always an array, and the kit never uses a shell. Every element is a string without NUL (rejected
  `invalid`). `bin` must be absolute (`missing` otherwise). The PATH is never searched.
- **Timeouts.** `hello` and `stop` take 10 s. `make` takes `timeoutMs`. On timeout the process gets SIGTERM, then
  SIGKILL 5 s later, and the call rejects `timeout`.
- **Caps.** For `hello`, `stop` and `make`, stdout and stderr are capped at 8 MB each. Past the cap, the process is
  killed and the call rejects `too-much-output`. For `record`, stdout is capped at 8 MB in total and a single stdout
  line over 64 KB is `protocol`; stderr keeps a rolling 2 KB tail with no total cap, because a recording can log for an
  hour.
- **Process groups.** `runRecorder` and `streamRecorder` spawn with `detached: true`, and every SIGTERM and SIGKILL
  (timeout, cap, guard, stop fallback, make abort) goes to the process group (`process.kill(-pid, sig)`), as
  `packages/herdr/src/supervise.ts` does.
- **Planner key.** With `key`, stdio is `['ignore', 'pipe', 'pipe', 'pipe']`. The kit writes the key to fd 3, closes
  it, and passes `--planner-key-fd 3 --max-tokens <n>`. Without a key it passes `--no-planner`. The key never
  appears in argv, env, a file or any error message.

### 5.5 Fake recorder and contract (`./testing`, BK-C1)

```ts
export type RecorderErrorWire = { code: string; message: string; hint?: string; [k: string]: unknown };
export type FakeRecorderScript = {
  hello?: Partial<RecorderHello>;               // merged over the default hello (below)
  consent?: 'yes' | 'no' | 'timeout';           // screen only, default 'yes'; 'timeout' answers at once, no 120 s wait
  seconds?: number;                             // take length before `done` unless stopped, default 1, capped by --max-seconds
  makeError?: RecorderErrorWire;                // make answers this envelope
  plannedTokens?: number;                       // default 1000
  corrupt?: 'hello' | 'record' | 'make';        // print `not json` instead of the answer
  flood?: 'stdout' | 'stderr';                  // make writes 9 MB to that stream, then hangs
  hang?: 'hello' | 'stop' | 'make';             // never answer
};
export type FakeInvocation = { argv: string[]; env: Record<string, string>; key?: string; captions?: unknown };
export type FakeRecorder = {
  bin: string;                                  // absolute path of the shim (0700)
  script(s: FakeRecorderScript): void;          // replaces the script for later runs
  invocations(): FakeInvocation[];              // every run so far, in order
};
export function fakeRecorder(o: { dir: string; script?: FakeRecorderScript }): FakeRecorder;

export type CaptureContractBench = { capture: Capture; source: Source; root: string; fake?: FakeRecorder };
export type CaptureContractTestFn = (name: string, fn: (t: { skip(message?: string): void }) => void | Promise<void>) => void | Promise<void>;
export type CaptureContractOptions = { test?: CaptureContractTestFn };
export function captureContract(make: () => Promise<CaptureContractBench>, options?: CaptureContractOptions | CaptureContractTestFn): void;
```

**Fake behaviour.**
- **The shim.** `bin` is a Node script at `<dir>/recorder`. Its shebang pins `process.execPath`, as herdr's
  `writeBinShim` does. It reads `<dir>/script.json` on every run, and appends one JSON line per run to
  `<dir>/invocations.jsonl`. That line holds argv, env, the key read from `--planner-key-fd`, and the parsed captions
  file.
- **Default hello.** `{ protocol: 1, recorder: { name: 'fake-recorder', version: '0.0.0' }, sources: ['screen',
  'x11'], android: false, events: ['own', 'none'], planner: { available: true, needsKey: true } }`.
- **`record`.** It takes `<state-dir>/recording.pid` as its lock. A live pid already there gives `already-recording`.
  - For `screen` it prints `consent-pending`, then follows `consent`. `no` and `timeout` exit 1 with
    `consent-cancelled` or `consent-timeout`, having created nothing under `--root`.
  - It creates `<root>/take-<n>/` with `take.json` (`{"fake":true,"source":…,"events":…}`) and prints `recording`.
  - After `seconds` (capped by `--max-seconds`), or on SIGTERM, SIGINT or `stop`, it prints `done` and exits 0.
  - A SIGTERM before `recording` gives `capture-stopped` with nothing created.
- **`stop`.** It signals the pid in the lock and prints `{"stopping":true}`. With no live pid it prints
  `not-recording`.
- **`make`.** It checks that `<take>/take.json` exists, otherwise `take-input`.
  - `--plan-only`: `out: null`, `planned_tokens: plannedTokens`, `input_tokens: 0`, `usd: 0`.
  - `--max-tokens` below `plannedTokens`: `preflight-refused` with `planned` and `cap`.
  - Otherwise it writes `<take>/out/<basename>.mp4` (the bytes `fake`). It writes the title and captions into
    `take.json`, and prints the result with `seconds` taken from the take. Tokens are 0 with `--no-planner` and
    `plannedTokens` with a key.
  - An unknown `--set` key other than `speed` gives `invalid-arguments` with exit 2.

**`captureContract` cases.** All of them hold on a real recorder; *fake* ones skip without `fake`:
1. `hello` passes the 6.3 shape, has `protocol` from `PROTOCOL_FLOOR` to `PROTOCOL`, and includes `'none'` in
   `events`.
2. `record({ source, root, maxSeconds: 2 })` yields `recording` then `done`. The take is a direct child directory of
   `root`, `done.take` equals `recording.take`, and `seconds` is at most 3.
3. Aborting the signal after `recording` still yields `done` within 15 s, and the take exists.
4. A second `record` while one runs rejects `already-recording`.
5. `stop()` with nothing recording resolves `'not-recording'`.
6. `make({ take, planOnly: true })` gives `out: null` and `planner.failed: false`, and no file appears under
   `take/out`.
7. `make({ take })` gives `out` as an existing `.mp4` file inside the take, with `planner.inputTokens` 0 and
   `planner.usd` 0.
8. `make({ take, title: 'T', captions: [{ t: 0, text: 'Hi' }] })` succeeds without recording again (no new take
   under `root`).
9. `make({ take: join(root, 'nope') })` rejects `take-input`.
10. *fake*: `consent: 'no'` rejects `consent-cancelled`, and `root` has no new entries.
11. *fake*: a hello with `protocol: 0` gives `needs-update`/`recorder`, and `protocol: 2` gives `needs-update`/`app`.
12. *fake*: a key reaches the recorder on fd 3 only. The invocation's `key` equals it, and neither argv nor env
    contains it.
13. *fake*: the env is exactly 5.4's for each verb and source, `display` variables included.
14. *fake*: `corrupt`, `flood` and `hang` give `protocol`, `too-much-output` and `timeout` respectively.
15. *fake*: `maxTokens` below the planned amount rejects `preflight-refused` with `detail.planned` and `detail.cap`.

### 5.6 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `capture.missing` | This computer needs the recorder installed first. |
| `capture.needsUpdate.recorder` | The recorder on this computer needs an update. |
| `capture.needsUpdate.app` | This app needs an update to work with the recorder on this computer. |
| `capture.unsupported` | The recorder on this computer can't record that yet. |
| `capture.consentPending` | Say yes in the window that just opened to start recording. |
| `capture.recording` | Recording. |
| `capture.done` | Recording finished. |
| `capture.consentCancelled` | You said no to the recording. Nothing was kept. |
| `capture.consentTimeout` | Nobody said yes in time, so nothing was recorded. |
| `capture.stopped` | Stopped before anything was recorded. |
| `capture.busy` | Another recording is already running. Stop it first. |
| `capture.making` | Making the video… |
| `capture.made` | The video is ready. |
| `capture.overLimit` | Planning this video would go over its limit, so nothing was spent. |
| `capture.takeMissing` | That recording can't be opened. Record it again. |
| `capture.renderFailed` | The video couldn't be made from this recording. Try again. |
| `capture.timeout` | The recorder took too long to answer. Try again. |
| `capture.failed` | The recorder stopped with a problem. Try again. |

- `eventWords(e: RecordEvent)`:
  - `consent-pending` → `capture.consentPending`
  - `recording` → `capture.recording`
  - `done` → `capture.done`
- `errorWords(e: CaptureError)`:
  - `missing` → `capture.missing`
  - `needs-update` → `capture.needsUpdate.<why>` (`recorder` when `why` is absent)
  - `unsupported` → `capture.unsupported`
  - `consent-cancelled` → `capture.consentCancelled`
  - `consent-timeout` → `capture.consentTimeout`
  - `stopped` → `capture.stopped`
  - `already-recording` → `capture.busy`
  - `preflight-refused` → `capture.overLimit`
  - `take-input` → `capture.takeMissing`
  - `render-failed` → `capture.renderFailed`
  - `timeout` → `capture.timeout`
  - `invalid`, `too-much-output`, `protocol` and `failed` → `capture.failed`
- `capture.making` and `capture.made` are for the app to show around `make()`.
- The words never name a recorder, a device path or a key.

### 5.7 What runs where

`npm test` runs fake recorders/media tools. Linux CI also runs the bundled recorder on an isolated Xvfb.
External recorders run on the owner's machine or in a lab via `captureContract` (BK-C3). External recorders may be private; the bundled backend needs no download helper. `scripts/pin-watch.mjs`
watches nothing for record: external compatibility is pinned by protocol, and the bundled backend ships with the kit.

### 5.8 Bundled recorder (G8, 2026-09-30)

`CaptureOptions.bin` is optional: omitted selects the bundled recorder, launched with `process.execPath`
(no PATH lookup for Node). Explicit bins retain the unchanged protocol and supervision. The bundled recorder
supports Linux `x11:` video only, `events: none`, and no planner. `screen` (Wayland portal), Android,
macOS, Windows, browsers and React Native are unsupported by this backend. X11 has no system consent dialog:
the host must present an explicit Start action before iterating `record()`. Construction and hello open no display.
The bundled recorder uses `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`; it reads only the scrubbed process environment
provided by Capture (for XAUTHORITY). It never starts another application's CLI or contacts the network.
Takes contain local video, duration metadata and requested caption/title edits. `make()` embeds timed subtitles
and title metadata, with optional `crf` (0–51) and `preset` settings; unknown settings fail closed. Stop uses a
state-scoped marker, with no cross-process PID signalling. Failed/pre-start recordings and active state are cleaned
up; completed takes are retained until the host deletes their returned directory. Linux CI runs a real smoke
against its own Xvfb; ordinary tests fake media binaries. External recorders retain their owner-machine proof.


## 6. Recorder protocol v1

This is the open protocol a recorder implements to be driven by `@byokit/record`. "MUST" and "SHOULD" are binding
for conformance. BK-C1 turns 6.3–6.7 into `packages/record/schema/recorder-protocol-1.json`.

### 6.1 Invocation and output

- **Argv.** The kit runs `<bin> capture <verb> [arguments]` with an argv array and no shell. Flags take their value as
  the next argv entry (`--root /x`). An unknown verb or flag is `invalid-arguments` with exit 2. The `capture`
  sub-command is the whole protocol surface, so a recorder's other commands stay its own.
- **stdout** carries only protocol JSON: one object per line, UTF-8, each ending in `\n`. `hello`, `stop` and `make`
  print exactly one line. `record` prints event lines.
- **stderr** is free-form logging. The kit keeps only a 2 KB tail, for its own error detail, and never shows it to a
  person.
- **Exit codes.** 0 is success. 1 is failure, with the error envelope (6.7) as the last stdout line. 2 is
  `invalid-arguments`, also with the envelope.
- **Env.** The recorder MUST work with only the variables 5.4 lists. It MUST keep its own files under `HOME`/`XDG_*`,
  `--state-dir` and the takes under `--root`, and nowhere else.
- **Speed.** `hello` and `stop` MUST answer within 5 s.
- **Processes.** The recorder MUST keep its helper processes in its own process group: no `setsid`, no daemonizing.
  The kit's SIGKILL fallback reaches the whole group.
- **Logs.** stderr from `hello`, `stop` and `make` MUST stay under 8 MB; `record` may log without a total limit.

### 6.2 Versioning

`hello.protocol` is an integer, and it is `1` for this document. Additive changes keep `1`: new optional fields, new
event names and new error codes. The kit ignores unknown fields and events, and maps unknown error codes to `failed`.
Any other change is protocol `2`. The kit accepts protocols from `PROTOCOL_FLOOR` (1) to `PROTOCOL` (1); anything else
is `needs-update` (5.3).

### 6.3 `capture hello`

```json
{"protocol":1,"recorder":{"name":"example-recorder","version":"2.3.0"},"sources":["screen","x11"],"android":false,"events":["own","none"],"planner":{"available":true,"needsKey":true}}
```

| Field | Rule |
|---|---|
| `protocol` | integer ≥ 0 (the kit applies the accepted range, 5.3) |
| `recorder.name` | `/^[a-z0-9][a-z0-9._-]{0,63}$/` |
| `recorder.version` | non-empty string, at most 64 characters |
| `sources` | non-empty, unique, each one of `screen`, `x11`, `android` |
| `android` | boolean, MUST equal `sources` including `android` |
| `events` | non-empty, unique, each `own` or `none`, MUST include `none` |
| `planner.available` | boolean: whether `make` can plan with a key |
| `planner.needsKey` | boolean: whether planning needs `--planner-key-fd` |

Exit 0. `hello` MUST NOT open a display, an input device or the network.

### 6.4 `capture record`

```
<bin> capture record --source <source> --root <dir> --state-dir <dir> --events own|none --max-seconds <n>
```

The kit always passes every flag. Source grammar:
- `screen`: the person's own screen through the OS's own screen-sharing consent.
- `x11:<display>`: `<display>` matches `/^:\d{1,4}(\.\d{1,2})?$/`.
- `android:<serial>`: `<serial>` matches `/^[A-Za-z0-9._:-]{1,64}$/`. The recording uses the person's already-running
  adb server over loopback, and so that server's existing device authorization. The recorder MUST NOT start an adb
  server, and MUST NOT generate, copy or read any adb key. With no reachable server or an unauthorized serial it gives
  `unsupported-source` before printing `recording`.

stdout events:

```json
{"event":"consent-pending"}
{"event":"recording","take":"/abs/root/take-7"}
{"event":"done","take":"/abs/root/take-7","seconds":12.4,"warnings":[]}
```

A recorder MUST:
1. Refuse a source kind missing from its `hello.sources` with `unsupported-source`, and an events mode missing from
   `hello.events` with `invalid-arguments`.
2. Allow one recording per `--state-dir`. A second one gets `already-recording`.
3. For `screen`: print `consent-pending` and ask through the OS's own consent. It never bypasses consent and never
   retries on its own. A refusal gives `consent-cancelled`. No answer within 120 s gives `consent-timeout`.
   `x11:` and `android:` MAY skip consent.
4. Leave nothing under `--root` or in `--state-dir` after `consent-cancelled`, `consent-timeout` or `capture-stopped`
   (a stop before `recording`).
5. Print `recording` once frames flow. Its `take` is an absolute directory the recorder created as a direct child of
   `--root`.
6. With `--events none`, open no input device and no compositor input channel. With `--events own`, record input
   only as classes (pointer move, button, wheel, key pressed), never the characters typed.
7. Stop on `--max-seconds` (a hard stop), SIGTERM, SIGINT, or `capture stop` for the same `--state-dir`. It then prints
   `done`, with `seconds` at most `--max-seconds + 1` and `warnings` as plain strings, and exits 0.
8. Never write a planner key into a take.

A recorder SHOULD keep no window titles and no copies of planner request bodies in a take.

### 6.5 `capture stop`

```
<bin> capture stop --state-dir <dir>
```

The recorder prints `{"stopping":true}` and exits 0 when a recording under that state dir was told to stop. It
returns at once, and the `record` process prints `done`. With nothing recording it gives `not-recording` (exit 1).

### 6.6 `capture make`

```
<bin> capture make <take> [--plan-only] (--no-planner | --planner-key-fd <n> --max-tokens <n>)
                          [--title <text>] [--captions <file>] [--set <key>=<value>]...
```

```json
{"out":"/abs/root/take-7/out/take-7.mp4","seconds":12.4,"beats":6,"planner":{"planned_tokens":0,"input_tokens":0,"usd":0,"failed":false},"warnings":[]}
```

A recorder MUST:
1. With `--plan-only`, make no model or network call and write no video. `out` is `null`, and `planned_tokens` is the
   estimate.
2. With `--no-planner`, make zero model calls, so `input_tokens` and `usd` are `0`.
3. With `--planner-key-fd <n>`, read the key from fd `n` to EOF and trim one trailing newline. It never reads a key
   from env, argv or its own files, and never writes the key anywhere, logs included.
4. Treat `--max-tokens` as a hard cap. When the estimate is above it, give `preflight-refused` (with `planned` and
   `cap`) before any call.
5. Treat `--title` and `--captions` as edits to the take. The captions file is a JSON array of `{ "t": seconds,
   "text": string, "d"?: seconds }`. Making again with only these changes MUST NOT record again.
6. Treat `--set` keys as its own render settings. An unknown key is `invalid-arguments`.
7. Put `out` inside the take directory.
8. Give `take-input` for a missing or unreadable take and `render-failed` when the video cannot be made. `failed:
   true` means the planner failed and the video was made without it.

### 6.7 Error envelope and codes

```json
{"error":{"code":"preflight-refused","message":"planned 48000 tokens, cap 40000","hint":"raise --max-tokens","planned":48000,"cap":40000}}
```

`message` and `hint` are for logs; the kit never shows them to a person. Extra fields sit inside `error`.

| Code | Verb | Meaning | Kit code |
|---|---|---|---|
| `invalid-arguments` | any | unknown verb, flag or value (exit 2) | `protocol` |
| `unsupported-source` | record | source kind not offered | `unsupported` |
| `consent-cancelled` | record | the person said no | `consent-cancelled` |
| `consent-timeout` | record | no answer in 120 s | `consent-timeout` |
| `capture-stopped` | record | stopped before `recording` | `stopped` |
| `already-recording` | record | a recording already runs for this state dir | `already-recording` |
| `not-recording` | stop | nothing to stop | (resolves `'not-recording'`) |
| `preflight-refused` | make | estimate above `--max-tokens`; has `planned`, `cap` | `preflight-refused` |
| `take-input` | make | take missing or unreadable | `take-input` |
| `render-failed` | make | the video could not be made | `render-failed` |
| `internal` and any other | any | anything else | `failed` (`detail.recorderCode`) |

### 6.8 Conformance

A recorder conforms when `captureContract` passes against it on a real machine (BK-C3). The recorder's own home
records that run in its own docs, outside BYOKit. A recorder that changes protocol behaviour re-runs it.

## 7. `@byokit/overlay`

### 7.1 Why Kotlin returns here

The frozen `android/` mirror (AGENTS.md) exists because React Native apps use the TypeScript kits. That reasoning does
not cover a bubble. No JavaScript or React Native API can draw a window over other apps
(`TYPE_APPLICATION_OVERLAY`), run a foreground service, or host a view from an accessibility service. So the overlay
is an Expo module with Kotlin inside `packages/overlay/android/`, built with `expo-module-gradle-plugin`. The mirror
stays frozen: this Kotlin serves only the Expo module, and nothing from the mirror is reused or extended.

### 7.2 Files (BK-O1 creates the layout)

```
packages/overlay/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  expo-module.config.json                 # { "platforms": ["android"], "android": { "modules": [
                                          #   "io.github.umeranjum17.byokit.overlay.OverlayModule",
                                          #   "io.github.umeranjum17.byokit.overlay.FocusedFieldModule"] } }
  app.plugin.js                           # config plugin (7.6)
  android/build.gradle
  android/src/main/AndroidManifest.xml    # the permissions, OverlayService and PanelActivity (7.6); Gradle merges it
  android/src/main/res/values/styles.xml  # Theme.ByokitOverlay.Panel: translucent, no action bar
  android/src/main/java/io/github/umeranjum17/byokit/overlay/*.kt   # 7.5
  android/src/test/java/io/github/umeranjum17/byokit/overlay/*Test.kt
  src/index.ts  src/types.ts  src/rules.ts  src/overlay.ts  src/words.json  src/words.ts
  src/rn.ts                               # the only file calling requireOptionalNativeModule('ByokitOverlay')
  src/focused-field.ts  src/focused-field.rn.ts
  test/*.test.ts
```

`package.json`:
- `exports`: `.` → `{ "react-native": dist/rn.js, "default": dist/index.js }` and `./focused-field` →
  `{ "react-native": dist/focused-field.rn.js, "default": dist/focused-field.js }`, each with its `types`.
- `files`: `dist`, `android` (without `build/`), `expo-module.config.json`, `app.plugin.js`, `README.md`,
  `LICENSE`, `CHANGELOG.md`.
- `peerDependencies`: `expo-modules-core` (`>=3.0.0`) and `expo` (`>=57.0.0`), both marked optional in
  `peerDependenciesMeta`.
- `devDependencies`: `expo-modules-core`, pinned exactly to the version `examples/expo` resolves, so the root
  `npm ci` installs it and `tsc -b` can type `rn.ts` and `focused-field.rn.ts`.

Android `minSdk` is 26 and `compileSdk` follows Expo SDK 57. The config plugin raises the app's minSdk to 26 (7.6).

### 7.3 Public types (`src/types.ts`) and entries

```ts
export type OverlayState = 'on' | 'off' | 'stuck' | 'needs-permission' | 'unsupported';
export type HostKind = 'window' | 'accessibility';
export type Edge = 'left' | 'right';
export type AppRules = { paused: boolean; on: string[]; off: string[]; defaults: string[] };   // Android package names
export type ForegroundNotice = { channel: string; title: string; text: string; icon: string }; // icon: app drawable name
export type StartOptions = {
  host: HostKind;
  mood: string;                        // resting drawable name, /^[a-z][a-z0-9_]{0,63}$/, app-supplied
  notice?: ForegroundNotice;           // required for host 'window' (the foreground service's notification)
  rules?: AppRules;                    // host 'accessibility' only (needs the foreground app); 'window' + rules rejects
  panel?: string;                      // registered React component opened on tap; absent: tap only emits
  hideWhilePanelOpen?: boolean;        // default true
  spots?: 'global' | 'per-app';        // remembered rest spot; 'per-app' needs host 'accessibility'; default 'global'
  label?: string;                      // TalkBack label for the bubble; absent: none
};
export type OverlayEvent =
  | { type: 'tap' }
  | { type: 'longPress' }
  | { type: 'moved'; edge: Edge; y: number }        // y: 0–1 of the usable height
  | { type: 'state'; state: OverlayState }
  | { type: 'panel'; open: boolean };
export type OverlayEventType = OverlayEvent['type'];
// State transitions (native side, reported by state() and the `state` event):
// - 'off' before the first start() and after stop().
// - start() with host 'window' and no SYSTEM_ALERT_WINDOW grant, or host 'accessibility' before
//   ByokitAccessibility.attach, resolves 'needs-permission' and shows nothing.
// - A successful start() resolves 'on'.
// - While on, 'stuck' when the bubble's view goes away without stop(): OverlayService destroyed or killed ('window'),
//   or ByokitAccessibility.detach ('accessibility'). start() again is the way back to 'on'.
// - 'unsupported' only from createOverlay(null) (no native module: iOS, web, Node).
export type TapEntry = { app: string; at: number; action: string };   // no text field, by design (D-O)
export interface Overlay {
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;     // window: the "display over other apps" screen; accessibility: accessibility settings
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  say(text: string, mood?: string, ms?: number, o?: { announce?: boolean }): void;   // pill next to the bubble; ms default 2500; still under reduced motion; announce reads the pill for TalkBack
  setMood(mood: string): void;
  setLabel(label: string | null): void;   // TalkBack label for the bubble; null clears it
  setRules(rules: AppRules): void;
  openPanel(props?: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  on<T extends OverlayEventType>(type: T, fn: (e: Extract<OverlayEvent, { type: T }>) => void): () => void;   // listener set
  logTap(entry: { app: string; action: string }): Promise<void>;
  taps(o?: { since?: number }): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
}
export interface NativeOverlay {                         // what the Kotlin module exposes (7.5); internal seam
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  say(text: string, mood: string | null, ms: number, announce: boolean): void;
  setMood(mood: string): void;
  setLabel(label: string | null): void;
  setRules(rules: AppRules): void;
  openPanel(props: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  logTap(app: string, action: string): Promise<void>;
  taps(since: number): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
  addListener(event: 'overlay', fn: (e: OverlayEvent) => void): { remove(): void };
}
```

`src/rules.ts` (pure):

```ts
export function shownFor(rules: AppRules, app: string | null): boolean;
// paused → false; app null → false; off has app → false; on has app → true; else defaults has app
export function setApp(rules: AppRules, app: string, shown: boolean): AppRules;   // moves app into on/off, out of the other
export function resetApp(rules: AppRules, app: string): AppRules;                 // removes app from on and off
```

`src/overlay.ts` (pure):

```ts
export function createOverlay(native: NativeOverlay | null): Overlay;
```

With `null`, every method resolves `'unsupported'` or does nothing, and `taps()` resolves `[]`. With a module,
`createOverlay` validates the arguments and calls it:
- `start` rejects `window` without `notice`, `window` with `rules`, `per-app` spots with `window`, and a `mood` that
  fails the pattern. These throw `Error('overlay: <what>')` before any native call.
- One native listener feeds a JS listener `Set` per event type. `on()` returns its own remover, and a throwing
  listener does not stop the others.

Entries:
- `src/index.ts` (`.` default) exports the types, `shownFor`, `setApp`, `resetApp`, `createOverlay`, `words` and
  `stateWords`, plus `overlay = createOverlay(null)`.
- `src/rn.ts` (`react-native`) exports the same names, but with `overlay =
  createOverlay(requireOptionalNativeModule('ByokitOverlay'))`. That call returns null on iOS, where the module is
  not built.

### 7.4 `./focused-field`

```ts
export type FocusedText = { app: string; text: string; selection: { start: number; end: number } | null };
export type InsertResult = 'inserted' | 'landedWithoutNewlines' | 'copied' | 'failed' | 'cancelled';
export type InsertOptions = {
  signal?: AbortSignal;            // cancellation settles once with cancelled
  replace?: 'selection' | 'all';   // default 'selection'
  attempts?: number;               // SET_TEXT tries; default 2 (a panel on top needs ~13 x 150 ms in Chrome)
  retryMs?: number;                // pause between tries; default 150
  acceptNewlineLoss?: boolean;     // default false; true resolves 'landedWithoutNewlines' when only newlines were lost
};
export interface FocusedField {
  available(): Promise<boolean>;       // the app's accessibility service has attached the kit
  read(): Promise<FocusedText | null>; // only on this call; null when no editable field has focus
  insert(text: string, o?: InsertOptions): Promise<InsertResult>;
}
export const focusedField: FocusedField;
```

- The default entry: `available()` resolves false, `read()` resolves null and `insert()` resolves `'failed'`.
- The React Native entry calls `requireOptionalNativeModule('ByokitFocusedField')` and passes the options through as
  a record (`{ replace, attempts, retryMs, acceptNewlineLoss }`, defaults 2 tries of 150 ms).
- `insert` sets the text, reads it back to verify, and retries up to `attempts` times, pausing `retryMs` between
  tries: while the panel's window is on top Chrome refuses SET_TEXT, so ~13 x 150 ms lands it. If the text still does
  not match, a contenteditable that dropped only the newlines resolves `'landedWithoutNewlines'` when
  `acceptNewlineLoss` is set; otherwise the text goes on the clipboard (`'copied'`).
- The field is resolved with `findFocus(FOCUS_INPUT)`, falling back to `FOCUS_ACCESSIBILITY`, including virtual
  WebView nodes. An input-focused container may contain the accessibility-focused field. No focus means no field;
  never guess the first editable child. A password node anywhere on the focused path (including ancestors and
  focused descendants) prevents reads, writes and clipboard fallback. The same search, read and insert are callable
  from Kotlin (`FocusedFields`, 7.5), so the app's
  service can read at tap time and insert into the captured node with no JS running.

### Screen frames and point markers

`@byokit/overlay/screen-frame` exports `screenFrame`, `createScreenFrame`, `ScreenFrame`,
`NativeScreenFrame`, `ScreenFrameResult` and `ScreenSpace`. The default entry is native-free;
React Native binds `ByokitScreenFrame` on Android and returns typed `unsupported` on iOS.

```ts
export type ScreenSpace = {
  width: number; height: number; density: number; densityDpi: number;
  rotation: 0 | 1 | 2 | 3; displayId: number;
  origin: 'top-left'; unit: 'physical-pixels';
};
export type ScreenFrameResult =
  | { status: 'captured'; uri: string; mimeType: 'image/png'; width: number; height: number; space: ScreenSpace }
  | { status: 'cancelled' | 'busy' | 'unsupported' }
  | { status: 'failed'; reason: 'timeout' | 'display-changed' | 'capture-failed' };
export interface ScreenFrame {
  frame(): Promise<ScreenFrameResult>;
  clear(): Promise<void>;
}
export type NativeScreenFrame = ScreenFrame;
export function createScreenFrame(native: NativeScreenFrame | null): ScreenFrame;
export type PointHereOptions = { x: number; y: number; label: string; space?: ScreenSpace; ms?: number };
export type PointHereResult = 'shown' | 'needs-permission' | 'not-running' | 'display-changed' | 'unsupported';
```

Both overlay entries export the point types. `Overlay` adds `pointHere(o: PointHereOptions):
Promise<PointHereResult>` and `dismissPoint(): Promise<void>`. `NativeOverlay` receives the same options
with `ms` required; JS supplies 2500 by default. It validates finite, nonnegative coordinates, a nonblank
label and a duration of 1–60000 ms before passing all fields through.

Every frame asks for fresh MediaProjection consent for the entire default display, including system bars.
Only one request runs at once. Its PNG lives in app cache; the next request deletes previous kit frames,
and `clear()` deletes them explicitly (rejecting during capture). A projection foreground service stops
on success, denial, failure, timeout or teardown. Rotation or display geometry changes fail capture rather
than returning an incompatible coordinate space. Nothing uploads the image.

The marker uses full-display physical pixels from the image. Passing `space` rejects stale display metrics;
React Native layout coordinates must first be multiplied by the display density. It requires a running
window or accessibility overlay host. Its ring and label occupy a separate nonfocusable, nontouchable
window, announce the label to accessibility clients, and dismiss on timeout, explicit dismissal, replacement,
display changes or host teardown. Application overlay opacity stays below Android's tap-through threshold.

### 7.5 Kotlin parts (package `io.github.umeranjum17.byokit.overlay`, one job each)

```kotlin
data class Size(val w: Int, val h: Int)
data class Spot(val edge: Edge, val y: Float)                            // y in 0..1
enum class Edge { LEFT, RIGHT }
sealed class OverlayEvent { object Tap; object LongPress; data class Moved(val spot: Spot); data class State(val state: String); data class Panel(val open: Boolean) }   // each extends OverlayEvent
class Listeners<T> { fun add(fn: (T) -> Unit): () -> Unit; fun emit(e: T) }   // a set: add returns its own remover; one throwing listener never stops the rest
interface SpotStore { fun get(key: String): Spot?; fun put(key: String, spot: Spot) }
object Placement {                                                       // pure, JVM-tested
  const val DRAG_SLOP_DP = 8
  fun isDrag(dxPx: Float, dyPx: Float, density: Float): Boolean          // hypot > DRAG_SLOP_DP * density
  fun snap(xPx: Int, yPx: Int, screen: Size, bubble: Size, insetTopPx: Int, imeTopPx: Int?): Spot   // nearest edge, clamped
  fun toPixels(spot: Spot, screen: Size, bubble: Size, insetTopPx: Int, imeTopPx: Int?): Pair<Int, Int>   // rests above the keyboard
}
interface OverlayHost { fun add(view: View, x: Int, y: Int); fun move(x: Int, y: Int); fun remove(); val attached: Boolean }
class WindowOverlayHost(context: Context) : OverlayHost                  // TYPE_APPLICATION_OVERLAY, FLAG_NOT_FOCUSABLE; needs SYSTEM_ALERT_WINDOW
class AccessibilityOverlayHost(service: AccessibilityService) : OverlayHost   // TYPE_ACCESSIBILITY_OVERLAY, FLAG_NOT_FOCUSABLE
class OverlayService : Service()                                         // foreground, type specialUse; owns a WindowOverlayHost
interface BubbleControl { var spotKey: String; var imeTopPx: Int?; val events: Listeners<OverlayEvent>; fun show(mood: String); fun hide(); fun say(text: String, mood: String?, ms: Long, announce: Boolean = false); fun setMood(mood: String); fun setLabel(label: String?) }   // what drives the bubble's view; a fake in JVM tests
class Bubble(host: OverlayHost, spots: SpotStore, moods: (String) -> Drawable?, reducedMotion: () -> Boolean) : BubbleControl {
  fun show(mood: String); fun hide(); fun say(text: String, mood: String?, ms: Long, announce: Boolean = false); fun setMood(mood: String); fun setLabel(label: String?)
  val events: Listeners<OverlayEvent>                                    // listener set, never a single slot
}
data class Rules(val paused: Boolean = false, val on: List<String> = emptyList(), val off: List<String> = emptyList(), val defaults: List<String> = emptyList()) { fun shows(app: String?): Boolean }   // the 7.3 decision in Kotlin; the app layers its own allowances on top
class ServiceBubble(moods: (String) -> Drawable?, spots: SpotStore, reducedMotion: () -> Boolean = { false }, ...) {   // the bubble from Kotlin alone: start(config) once, it shows on attach and restores after every rebind
  constructor(host: OverlayHost, moods: (String) -> Drawable?, spots: SpotStore, reducedMotion: () -> Boolean = { false })   // over a window the app's own foreground service owns
  data class Config(val mood: String, val label: String? = null, val rules: Rules = Rules(), val perAppSpots: Boolean = false, val hideWhilePanelOpen: Boolean = true)
  val events: Listeners<OverlayEvent>
  fun start(config: Config); fun stop()
  fun say(text: String, mood: String? = null, ms: Long = 2500, announce: Boolean = false)
  fun setMood(mood: String); fun setLabel(label: String?); fun setRules(rules: Rules)
  companion object { fun drawables(context: Context): (String) -> Drawable?; fun reducedMotion(context: Context): () -> Boolean }   // moods by drawable name; the system's animator scale
}
interface ForegroundApp { val current: String?; fun onChange(fn: (String?) -> Unit): () -> Unit }
interface KeyboardInset { val imeTopPx: Int?; fun onChange(fn: (Int?) -> Unit): () -> Unit }
object ByokitAccessibility { fun attach(service: AccessibilityService); fun detach(service: AccessibilityService) }   // called from the app's own service
class PanelActivity : ReactActivity()                                    // translucent, renders the app-registered component
class TapLog(context: Context) { fun add(app: String, action: String, at: Long); fun since(at: Long): List<TapEntry>; fun clear(); fun prune(now: Long) }  // 30 days
class OverlayModule : Module()                                           // Expo module 'ByokitOverlay', maps NativeOverlay (7.3)
data class InsertOpts(val attempts: Int = Insert.DEFAULT_ATTEMPTS, val retryMs: Long = Insert.RETRY_MS, val acceptNewlineLoss: Boolean = false)
interface FieldNode { val identity: FieldIdentity?; fun reacquire(): FieldNode?; fun recycle(); val editable: Boolean; val password: Boolean; fun shown(): String?; fun set(text: String): Boolean; fun selection(): Pair<Int, Int>?; fun findFocus(input: Boolean): FieldNode?; fun parent(): FieldNode?; val childCount: Int; fun child(i: Int): FieldNode?
  companion object { fun of(node: AccessibilityNodeInfo, service: AccessibilityService? = null): FieldNode } }   // the field, or a focused descendant; `of` wraps a node the app's service captured; faked in JVM tests
data class FieldIdentity(val viewId: String, val bounds: List<Int>, val app: String)   // all three match, or it is not the same field
object FocusedFields {                                                   // the Kotlin entry for the app's own service
  fun find(node: FieldNode): FieldNode?                                  // input focus, else accessibility focus; no field on a password path or without focus
  fun capture(service: AccessibilityService): FieldNode?                 // the focused field now, kept for a later insert; the caller recycles it
  fun read(service: AccessibilityService): FocusedFieldText?
  fun insert(node: FieldNode, text: String, replace: String = "selection", opts: InsertOpts = InsertOpts(), pause: (Long) -> Unit = Thread::sleep, copy: (String) -> Boolean = { false }, cancellation: InsertCancellation = InsertCancellation(), service: AccessibilityService? = null): String
  fun insert(node: AccessibilityNodeInfo, text: String, replace: String = "selection", opts: InsertOpts = InsertOpts(), pause: (Long) -> Unit = Thread::sleep, copy: (String) -> Boolean = { false }, service: AccessibilityService? = ByokitAccessibility.service, cancellation: InsertCancellation = InsertCancellation()): String   // finds the field at or under node; "failed" when none
  fun clipboard(context: Context): (String) -> Boolean                  // the copy fallback
}
class InsertCancellation { fun cancel() }                               // one operation, idempotent cancellation
class FocusedFieldModule : Module()                                      // Expo module 'ByokitFocusedField' (BK-O3)
```

- The app's own `AccessibilityService` calls `ByokitAccessibility.attach(this)` in `onServiceConnected`. That supplies
  `AccessibilityOverlayHost`, `ForegroundApp`, `KeyboardInset` and `FocusedField`. The kit declares no accessibility
  service of its own.
- A service that must show the bubble with no JS running (after a reboot or process death, before any React context
  exists) keeps a `ServiceBubble` and calls `start(config)` in `onServiceConnected` with the persisted rules: the
  bubble shows on attach and restores after every rebind, until `stop()`. `Rules.shows(app)` is the same per-app
  decision as `shownFor`, for the service to decide in Kotlin; the app layers its own allowances on top, and persists
  the rules itself so they work before JS runs again.
- **The app-owned-service API.** Everything an app's own service hands the kit, or gets back, is public Kotlin, with
  the kit's internals (`NodeWrap`, the same-field search) behind it:
  - *Attach:* `ByokitAccessibility.attach(this)` / `detach(this)`, which supplies `host`, `foreground` and `keyboard`.
  - *Focused field:* `FocusedFields.capture(service)` at tap time, or `FieldNode.of(node)` over the
    `AccessibilityNodeInfo` the service captured itself with `findFocus(FOCUS_INPUT)` (falling back to
    `FOCUS_ACCESSIBILITY`): only an exactly focused field is taken, never the first editable descendant;
    `capture`/`read` search every interactive window root and the active root, refresh and require two agreeing
    snapshots with at most three 75 ms settling pauses. Native containers resolve virtual children by their exact
    focus flags. The app's service retrieves window content, reports view ids and subscribes to window/content,
    view focus, text and selection changes. `FocusedFields.insert` takes either. Before the first write and on
    retries, it refreshes and re-acquires the field across window roots only when view id, bounds and package
    all match (or framework node identity for virtual fields without ids), never a different field; the
    captured node stays the caller's to recycle. `FocusedFields.clipboard(context)` is the `copy` fallback. Insert
    blocks for up to `attempts x retryMs`, so the service calls it off the main thread. Each insert accepts an optional
    `InsertCancellation` (JS: `AbortSignal`); cancellation is checked before field reads, writes and copy fallback,
    and returns `cancelled` exactly once. Service detach and native module teardown cancel pending inserts.
    Services detach in both `onUnbind` and `onDestroy`. Bubble touch and accessibility ACTION_CLICK share one Tap handler.
  - *Bubble:* `ServiceBubble` on the attached service's host, or `ServiceBubble(WindowOverlayHost(this), ...)` from the
    app's own foreground service; `drawables(context)`, `PrefsSpotStore(context)` and `reducedMotion(context)` supply
    it. The fixed-host bubble knows no foreground app or keyboard: like the JS `window` host it takes no rules and
    shows everywhere. It hides while the panel is on top (`hideWhilePanelOpen`, also when `start` finds it open),
    shows again over another app the person switches to meanwhile, and re-reads the foreground app when it closes.
  - *Panel:* `events` delivers `Tap` and `LongPress`; the service opens the panel with
    `PanelActivity.launch(context, key, props)` and closes it with `PanelActivity.current?.finish()`.
  - *Placement, tap log, rules:* `Placement`, `SpotStore.key`, `TapLog(context)` and `Rules` are the same pure parts
    the module uses.
- The bubble carries a TalkBack label (`label` in `StartOptions`, `setLabel`, `ServiceBubble.Config.label`), and
  `say` takes `announce` to read the pill aloud.
- Moods are drawable names the app ships. With reduced motion (the system animator scale is 0), the bubble snaps
  instead of gliding, and a mood change is a still frame.
- `panel` is an `AppRegistry.registerComponent` key the app registers in its JS entry. `start()` stores it in the
  module. A tap, or `openPanel(props)`, launches `PanelActivity` with `FLAG_ACTIVITY_NEW_TASK` and the extras
  `byokit.panel` (the key) and `byokit.props` (a Bundle of strings). `getMainComponentName()` returns the key, and the
  React activity delegate passes the props as the component's initial props. `openPanel` without a stored key rejects
  `Error('overlay: no panel')`.
- The bubble hides while the panel is open (`hideWhilePanelOpen`). `closePanel()` finishes the activity. Both emit the
  `panel` event. The panel is where the app makes any network call.

### 7.6 Library manifest and config plugin

The library's `android/src/main/AndroidManifest.xml` declares the static entries below, and Gradle merges them into the
app. `app.plugin.js` adds nothing to the manifest.

- **Permissions:** `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE` and `POST_NOTIFICATIONS`.
- **The service.** `<service android:name="io.github.umeranjum17.byokit.overlay.OverlayService"
  android:foregroundServiceType="specialUse" android:exported="false">` with
  `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="floating assistant bubble"/>`.
- **The panel activity.** `<activity android:name="io.github.umeranjum17.byokit.overlay.PanelActivity"
  android:theme="@style/Theme.ByokitOverlay.Panel" android:excludeFromRecents="true"
  android:taskAffinity="" android:exported="false"/>`.
- **Config plugin** (`app.plugin.js`), with options `{ moods?: Record<string, string> }` mapping a drawable name to an
  app asset path:
  - it copies each asset into `res/drawable-nodpi/<name>.png`;
  - it sets `android.minSdkVersion` in `gradle.properties` to 26 when it is lower, and leaves a higher value alone.

### 7.7 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `overlay.on` | The bubble is on. |
| `overlay.off` | The bubble is off. |
| `overlay.stuck` | The bubble stopped. Turn it off and on again. |
| `overlay.needsPermission` | Allow this app to show over other apps to see the bubble. |
| `overlay.restricted` | If that switch is greyed out, open this app's info, tap the menu, and allow restricted settings first. |
| `overlay.unsupported` | This device can't show a bubble over other apps. |
| `field.copied` | Couldn't type it in, so it's copied. Paste it where you want it. |
| `field.failed` | Couldn't type it in. Try again. |

`stateWords(s: OverlayState)` maps each state to its `overlay.*` sentence. `needs-permission` gives
`overlay.needsPermission`, and the app shows `overlay.restricted` as a second line on Android 13+ sideloaded installs.

## 8. Tests, CI and isolation

- Every kit test runs under `scripts/test.sh`: the throwaway HOME, the `~/.pi` byte check and the egress guard. Temp
  dirs use `scratchDir` from `packages/test-support.ts`.
- **compose, no network and no writes.** BK-P2's `test/engine/isolation.test.ts` runs a child
  `node --permission --allow-fs-read=<repo> -e <import the kit, run every verb through inProcessEngine()>` and asserts
  exit 0. Any fs write would throw `ERR_ACCESS_DENIED`. The egress guard makes any outbound dial fail.
- **write, words claims.** The words test greps the D-P banned-claims expression over `words.json`.
- **record, isolation.** BK-C2's `test/isolation.test.ts` uses a decoy HOME (`packages/accounts/src/testing`). It
  runs the full contract against the fake recorder with `process.env.HOME` pointing at the decoy, and asserts that the
  decoy's canaries are untouched and that the fake's recorded env holds no decoy path.
- **overlay.** `test/rules.test.ts` and `test/overlay.test.ts` (fake `NativeOverlay`) run in `npm test`.
  `test/portable.test.ts` bundles `.` and `./focused-field` for `browser` and `react-native` with esbuild, marking
  `expo-modules-core` external. It fails on
  any `node:*` import, and on any `expo-modules-core` import outside `rn.ts` and `focused-field.rn.ts`. The JVM tests
  run in the `overlay-android` job.
- **secrets, isolation.** `test/keyring-isolation.test.ts` puts a decoy HOME beside the throwaway one and runs a
  child `node --permission --allow-fs-read=<repo> --allow-fs-write=<scratch> --allow-child-process` that stores a
  canary through the fake keyring CLIs (both tools) and the passphrase file under scratch. A control read of the
  decoy throws `ERR_ACCESS_DENIED`; the run asserts the decoy's canaries are byte-identical and the fakes' argv/env
  logs hold no canary. `test/process-env.test.ts` poisons `process.env` and greps `process.env` out of `src/`.
- **CI jobs added:**
  - `write-engine` (BK-P2): Node 24, `npm ci`, `npm run build`, `npm run test:write-engine`
    (`sh scripts/test.sh 'packages/write/test/engine/*.test.ts'`).
  - `overlay-android` (BK-O1): JDK 17, `npm ci` in `examples/expo`, then
    `npx expo prebuild -p android --no-install && (cd android && ./gradlew assembleDebug :byokit-overlay:testDebugUnitTest)`
    in `examples/expo`. BK-O1 records the Gradle project name autolinking gives the package, if it is not
    `byokit-overlay`.
- **Changelog lint (BK-O1).** `scripts/release.ts` line 678 counts `packages/<pkg>/android/**` and
  `packages/<pkg>/ios/**` as source, next to `src/`.

## 9. Work packages

Builders: **Sol** (judgment-heavy: supervision, protocol, native) and **Flash** (mechanical: fakes, words, schema,
CLI, tests), as in `docs/runtime-kits.md` §11.
- Each package is one direct PR to byokit. It commits only its listed files (plus the lockfile) and keeps
  `npm run build`, `npm run check`, `npm test` and `npm run smoke:pack` green.
- A package that changes `packages/<pkg>/src/**` adds a `## Unreleased` bullet.
- **Stubs rule:** BK-0 created `packages/write` and `packages/record` with every `src/*.ts` file of 4.1 and 5.1 that
  holds a public or seam signature. Their bodies are `throw new Error('not built: <package id>')`. Later packages
  replace bodies only. A signature change is a spec change: stop and ask.
- **Exports test:** each package also edits its kit's `test/exports.test.ts`. It replaces the stub assertions naming
  its own package id with behaviour or existence assertions, and turns the matching `todo` into a `test` (BK-C1:
  `PROTOCOL_SCHEMA_SHA256`; BK-P2: `ENGINE_SCHEMA_SHA256`). This file needs no mention in each Files list.

### 9.1 Dependency graph

```
BK-0 (done: this doc, scaffolds, isolation sentence)
 ├─ BK-P1 Flash ── BK-P2 Sol (needs the engine's protocol 1 published: OV-3)
 ├─ BK-C1 Flash ── BK-C2 Sol ── BK-C3 Flash (needs a conforming recorder on the owner's machine)
 ├─ BK-O1 Sol ── BK-O2 Sol ── BK-O3 Sol (emulator)
 └─ BK-S1 Sol (after BK-O1: reuses its layout and CI job shape; section 12)
```

The lanes share only root `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`, `scripts/release.ts`,
`scripts/fix-words-dts.cjs`, `README.md` and `CONTRIBUTING.md`. BK-P2, BK-O1 and the publish packages touch those;
later merges rebase.

### 9.2 Compose lane

**BK-P1 — client, words, fake engine, contract, CLI** · Flash · deps: BK-0
- **Files:** `src/compose.ts`, `src/words.ts` (`checkLines`), `src/cli.ts`,
  `src/testing/{index,fake-engine,contract}.ts`, and the tests `test/{compose,words,cli,fake,contract}.test.ts`.
- **Behaviour:** 4.4, 4.6, 4.7 and 4.8.
- **Acceptance:**
  - `contract.test.ts` runs `composeContract` against `new Compose({ engine: fakeEngine() })`, and all 12 cases
    pass.
  - `words.test.ts` checks:
    - the 4.8 table verbatim, in the same key order as `words.json`;
    - the jargon expression over every sentence;
    - the banned-claims expression;
    - `checkLines` for a passing draft with an original:
      `['Fits on X.', 'Kept the facts: every number and time from the original is still there.', 'Ready for you to look over.']`;
    - `checkLines` for a failing 301-character draft on X with no original and no voice or stock hits:
      `['Too long for X: 301 characters, and the most is 280.', 'Needs another pass.']`.
  - `cli.test.ts` drives `main()` with `fakeEngine({ version: '1.0.0' })`. It asserts golden text for `hello`,
    `platforms`, `voice guide`, `brief` and `check` (the inputs 4.6 names), and checks `voice parse` and `split` by
    shape (the `key[n]:` header count and quoted rows). It asserts exit codes 0, 1, 2, 3 and 4. It also checks the unknown-platform line, that `--voice`
    with bad JSON exits 2, and that 51 draft files exit 2.
  - `exports.test.ts` still passes, with its stub assertions for BK-P1 bodies replaced by behaviour assertions.

**BK-P2 — real engine, generated types, CI job, publish** · Sol · deps: BK-P1 and the engine's published protocol 1
- **Files:**
  - `package.json`: dependency `ownvoice-engine` exact, and `private` removed.
  - `src/constants.ts`: `ENGINE_VERSION` and `ENGINE_SCHEMA_SHA256`.
  - `src/engine.ts`.
  - `schema/engine-protocol-1.json`.
  - `scripts/gen-types.ts`.
  - `src/generated/protocol.ts`.
  - root `package.json` scripts `gen:write` and `test:write-engine`.
  - `.github/workflows/ci.yml` job `write-engine`.
  - `scripts/pin-watch.mjs` write section, with its fixture.
  - The tests `test/generated.test.ts`, `test/engine-seam.test.ts` and `test/engine/{contract,isolation}.test.ts`.
  - README real-engine line and a CHANGELOG bullet.
- **Acceptance:**
  - `generated.test.ts` checks:
    - that the sha256 of `schema/engine-protocol-1.json` equals `ENGINE_SCHEMA_SHA256`;
    - that the schema equals `ownvoice-engine schema` output (run in `test/engine/` only);
    - a type-level mutual assignability check (`type _ = Assert<Equals<Generated…, EngineVerbs…>>`) for every verb's
      params and result against 4.3.
  - `engine-seam.test.ts` covers `binEngine` with a fake JS bin: it is spawned as `process.execPath` with argv
    `[bin]` and env exactly `{PATH, LANG}`; timeout; the 8 MB cap; a missing bin gives `missing`.
  - `test/engine/contract.test.ts` runs `composeContract` against `new Compose()` (the real pin), and it is green.
  - `isolation.test.ts` passes as in section 8.
  - The `write-engine` job is green on the PR.
  - `npm run smoke:pack` passes (the `write` bin loads from the packed tarball), and `test/engine/contract.test.ts`
    also runs `write platforms` through `main()` against the real pin: exit 0 and six rows.
  - A `D-I` mismatch stops the package.
- **As built (engine not yet on npm):** `private` stays and the exact `ownvoice-engine` dependency is not added yet;
  `ENGINE_VERSION` is 0.1.0 and the `write-engine` job runs the engine from ownvoice's public source at `faf2fc2`
  (the schema's commit), linked as `node_modules/ownvoice-engine`. Publishing (the dependency, `private` removed) is a
  later package once the engine is on npm. Without the engine, `test/engine-seam.test.ts` runs the contract over a
  stub that checks every request against the committed schema, in process and as a bin.

### 9.3 Capture lane

**BK-C1 — protocol schema, parsers, fake recorder, contract** · Flash · deps: BK-0
- **Files:** `schema/recorder-protocol-1.json`, `src/constants.ts` (`PROTOCOL_SCHEMA_SHA256`), `src/protocol.ts`,
  `src/testing/{index,fake-recorder,contract}.ts`, and the tests `test/{protocol,fake,schema}.test.ts`.
- **Behaviour:** section 6 and 5.5.
- **`src/protocol.ts`:**

  ```ts
  export function parseHello(line: string): RecorderHello;
  export function parseEvent(line: string): RecordEvent | null;   // null for unknown events
  export function parseMake(line: string): MakeResult;
  export function parseError(line: string): { code: string; message: string; hint?: string; extra: Record<string, unknown> } | null;
  export function toCaptureError(e: { code: string; message: string; hint?: string; extra: Record<string, unknown> }): CaptureError;   // 6.7 table
  ```

  Each throws `CaptureError('protocol')` on a shape violation. `parseHello` first checks `protocol`: an integer
  outside `[PROTOCOL_FLOOR, PROTOCOL]` throws `CaptureError('needs-update', …, { why })` (`recorder` below, `app`
  above) before any other field is validated. `protocol.test.ts` covers a `protocol: 2` hello with a changed body.
- **Acceptance:**
  - `schema.test.ts` validates every example in section 6 and every line the fake prints (hello, each event, stop,
    make and each error) against the schema, using a small in-test validator for the subset used: `type`,
    `required`, `properties`, `enum`, `pattern`, `items`, `oneOf` and `const`. No new dependency.
  - The same test checks that the schema's sha256 equals `PROTOCOL_SCHEMA_SHA256`.
  - `fake.test.ts` spawns the shim directly and checks each 5.5 behaviour, including that nothing is created under
    `--root` on `consent: 'no'`.
  - `protocol.test.ts` covers the parsers and the whole 6.7 mapping.
  - The contract is written but only its registration is tested here. It runs in BK-C2.

**BK-C2 — the client and supervision** · Sol · deps: BK-C1
- **Files:** `src/capture.ts`, `src/supervise.ts`, `src/words.ts` (`eventWords`, `errorWords` bodies), and the tests
  `test/{capture,supervise,contract,isolation,words}.test.ts`.
- **Behaviour:** 5.3, 5.4 and 5.6.
- **Acceptance:**
  - `contract.test.ts` runs `captureContract` against the fake recorder with `x11:99` and with `screen`, and all 15
    cases pass.
  - `supervise.test.ts` writes its own throwaway shim scripts under `scratchDir` for the SIGTERM, grandchild and
    stderr-flood cases (they do not use `fakeRecorder`), and covers:
    - `recorderEnv` per source (exact objects);
    - NUL in argv rejected;
    - a relative bin gives `missing`, and so does a non-executable bin;
    - the 8 MB cap;
    - the 64 KB line cap;
    - timeout, SIGTERM, then SIGKILL, shown by a fake that ignores SIGTERM and forks a SIGTERM-ignoring grandchild,
      which is gone after the SIGKILL;
    - a `record` stderr flood of 9 MB does not end the recording;
    - the key on fd 3 only.
  - `capture.test.ts` covers:
    - abort after `recording` gives `done`;
    - abort before `recording` gives `stopped`;
    - `break` out of `for await` runs `stop`, and a `record` started right after it does not reject
      `already-recording`;
    - an abort during `make` rejects `signal.reason`, and the captions file is gone;
    - a guarded run never yields `done` and rejects `timeout`;
    - the wall-clock guard: `streamRecorder` with `guardMs: 1000` over a fake with `seconds: 9999` reports
      `guarded: true` within 7 s; `recordGuardMs(2)` equals `(2 + CONSENT_WINDOW_S + 30) * 1000`; `Capture` maps a
      guarded exit to `timeout`;
    - captions files are deleted after make.
  - `words.test.ts` checks the 5.6 table verbatim, the jargon expression, and every `CaptureErrorCode` mapping to a
    non-empty sentence.
  - `isolation.test.ts` passes as in section 8.

**BK-C3 — owner-machine proof and publish** · Flash · deps: BK-C2 and a conforming recorder
- **Files:** `test/lab/contract-run.ts`, which runs `captureContract` against `CAPTURE_LAB_BIN` with source `x11:<n>`
  on an Xvfb the script starts. It is excluded from `npm test`: `lab/` is not in the glob.
- Also: README "Tested against a real recorder" line (the result, date, protocol 1), `private` removed, and a CHANGELOG
  bullet.
- **Acceptance:** the lab run's output is pasted in the PR, with every non-*fake* case passing, and the PR changes no
  `src/` behaviour. The run happens on the owner's machine or in a lab under a lab brief, never in CI. The PR names no
  recorder product.

### 9.4 Overlay lane

**BK-O1 — package layout, JS core, config plugin, CI** · Sol · deps: BK-0
- **Files:**
  - Everything in 7.2 except the 7.5 Kotlin bodies. The Kotlin `OverlayModule` is a definition whose functions reject
    with `not built: BK-O2` (`state` resolves `off`). `FocusedFieldModule` is a stub too: `available()` resolves false,
    and the other functions reject with `not built: BK-O3`.
  - `src/{index,types,rules,overlay,rn,words,focused-field,focused-field.rn}.ts` and `src/words.json`.
  - `test/{rules,overlay,portable,words,exports}.test.ts`.
  - Root build list and `scripts/fix-words-dts.cjs` gain `packages/overlay`.
  - `scripts/release.ts` canonical order gains `overlay`, and line 678 counts `android/**` and `ios/**` as source.
  - `examples/expo`: dependency `"@byokit/overlay": "file:../../packages/overlay"` and the plugin in `app.json`.
  - `.github/workflows/ci.yml` job `overlay-android`.
  - README table row.
- **Acceptance:**
  - `rules.test.ts` covers every `shownFor` branch and both `setApp` directions.
  - `overlay.test.ts` uses a fake `NativeOverlay` and checks:
    - `start` validation;
    - a listener set where two listeners both fire and a throwing one does not stop the other;
    - that remove works;
    - that `createOverlay(null)` is `unsupported` everywhere.
  - `portable.test.ts` passes as in section 8.
  - `exports.test.ts` checks the frozen names.
  - The `overlay-android` job is green: the prebuild assembles with the module stub.
  - `npm run smoke:pack` imports `.` and `./focused-field` in plain Node.

**BK-O2 — bubble, hosts, panel, tap log** · Sol · deps: BK-O1
- **Files:** the 7.5 Kotlin except `ForegroundApp`, `KeyboardInset` and `FocusedFieldModule` bodies, the JVM tests,
  and the `OverlayModule` wiring.
- **Acceptance:** JVM tests:
  - `PlacementTest`: snap to the nearest edge, clamp inside the insets, rest above the IME, the drag slop threshold.
  - `TapLogTest`: prune at 30 days, and that the entry type has no text field.
  - `SpotStoreTest`: `global` versus `per-app` keys.
  - `ListenersTest`: two listeners, and a remove.

  All run in `overlay-android`. `examples/expo` gets a screen with Start/Stop and a panel component.

**BK-O3 — providers, focused field, emulator proof, publish** · Sol · deps: BK-O2
- **Files:** `ForegroundApp`, `KeyboardInset`, `ByokitAccessibility`, `FocusedFieldModule`, the `focused-field.rn.ts`
  wiring, JVM tests for the insert retry/verify/copy decision, README, CHANGELOG, and `private` removed.
- **Acceptance:** an emulator run recorded in the PR per CONTRIBUTING, on `examples/expo`:
  1. grant with `adb shell appops set <pkg> SYSTEM_ALERT_WINDOW allow`;
  2. start the `window` host;
  3. drag the bubble and see it snap to the edge;
  4. tap it and see the panel open with the bubble hidden;
  5. close the panel and see the bubble return;
  6. `taps()` lists the tap with no text;
  7. with the example's accessibility service enabled, `focusedField.available()` resolves true, and `read()` on a
     focused text field returns its text. BK-O3 adds that service to `examples/expo` as a local Expo module
     (`examples/expo/modules/a11y-demo`) whose service calls `ByokitAccessibility.attach(this)`.

  Screenshots and the command log go in the PR. The iOS bundle still builds, and `overlay.state()` is
  `unsupported` there.

## 10. Known facts builders must not re-derive

### 10.1 Compose engine at protocol 1 (from the engine's source at the commit read for this spec)

| id | label | kind | limit |
|---|---|---|---|
| `x` | X | feed | 280 |
| `linkedin` | LinkedIn | feed | 3000 |
| `reddit` | Reddit | feed | 10000 |
| `slack` | Slack | chat | 40000 |
| `whatsapp` | WhatsApp | chat | 65536 |
| `gmail` | Gmail | mail | null |

- `Rules` is `{ never, noDashes, statementEndings, note }`.
- The guide line uses `No em dashes.`, `End on a statement, not a question.` (posts only) and
  `How they write: <note, at most 200 characters>`.
- The verdict words are `Sounds natural`, `A bit stock` and `Sounds canned`.
- The engine measures length in UTF-16 code units (`string.length`).
- It has no thread splitter before protocol 1's `split`, which is new engine work.

### 10.2 Recorder side

- A recorder's consent for `screen` is the OS's own dialog, and the protocol never answers it.
- One recording per state dir is enforced by a pid lock.
- `record` blocks until it is stopped.
- A take directory holds the video, the input classes, and the edit fields that `--title`/`--captions` write, but only
  `make` reads it: the kit treats a take as an opaque path.

### 10.3 Repo facts

- The canonical release order is at `scripts/release.ts:551`.
- The build list is at `package.json` `scripts.build`.
- `scripts/fix-words-dts.cjs` lists every package with a `words.json` import.
- `smoke:pack` imports every export subpath under default and browser conditions, typechecks a consumer under three
  resolutions, and runs every bin without arguments, failing on module-load errors.

## 11. `@byokit/secrets`

A secret store for Node 22.18+, React Native and browsers with one secret (a string) per name: `get/set/delete(name)`. It exists
because `@byokit/seal` 0.1.0 is primitives only, so apps keep API keys in plaintext files. The name is
capability-named (D-B). It consumes seal and an optional native keyring binding and is independent of L-SEAL.
Windows Credential Manager is supported by the native backend (11.7); the legacy CLI backend alone
rejects `unsupported` on Windows (typed, fail closed).

Five backends:

- the **phone store**: optional Expo SecureStore peer, with injectable async get/set/delete methods and no plaintext fallback;
- the **web store**: IndexedDB plus WebCrypto AES-256-GCM, a persisted non-extractable key and authenticated entry names;
- the **OS keyring**: macOS Keychain or Secret Service (libsecret), through their CLIs, spawned by absolute path
  with an env built from nothing plus only what the host passes (D-G);
- a **passphrase file** sealed with seal's `sealSecretBox` over a scrypt key, written through the atomic
  0700/0600 writer lifted from `packages/accounts/src/node-stores.ts:13-23` and exported (R6);
- a **CI override**: the host passes `override: Record<string, string>` and may build it from `process.env`
  itself. The kit never reads `process.env` (D-G), which is how "env override for CI" is met.

### 11.1 Files

```
packages/secrets/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE  SECURITY.md
  src/index.ts  src/errors.ts  src/types.ts  src/validate.ts  src/atomic.ts
  src/keyring.ts  src/file.ts  src/override.ts  src/portable.ts
  src/native.ts  src/rn.ts  src/web.ts
  test/*.test.ts
```

`package.json`: public at 0.2.0 (first publish after merge); `exports` `.` selects `rn` under `react-native`,
`web` under `browser`, and `index` by default. Explicit `/node`, `/native` and `/web` entries use those
same implementations. Portable entries never import Node; `/native` loads optional peer `expo-secure-store`
only on an operation. `dependencies` pins `"@byokit/seal": "0.2.0"` exactly; `files` is
`dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`.
The root build list gains `packages/secrets` after `packages/seal`, and `scripts/release.ts`' canonical order
gains `secrets` after `seal`.

### 11.2 Shared public surface (all platform entries)

```ts
export type KeystoreErrorCode = 'invalid' | 'auth-failed' | 'unsupported' | 'unavailable' | 'failed';
export class KeystoreError extends Error {
  readonly code: KeystoreErrorCode;
  constructor(code: KeystoreErrorCode, message: string);
}
export interface Keystore {
  get(name: string): Promise<string | null>;   // null when no entry exists
  set(name: string, secret: string): Promise<void>;
  delete(name: string): Promise<boolean>;      // true when an entry existed
}
```

Names (and the keyring `service`) are non-empty, at most 256 UTF-16 units, with no NUL; anything else rejects
`invalid`. Secrets are strings of at most 1 MiB UTF-8; NUL is allowed (stdin carries it); anything else rejects
`invalid`. No error message ever contains a secret. The portable entries also export `overrideStore`.
`/native` exports `nativeStore(NativeOptions?)`; `/web` exports `webStore(WebOptions?)`, with the
options and security limits documented in the package README. Native names use fixed-width UTF-16 hex
under an app prefix; web entries use versioned ciphertext with fresh 12-byte IVs and the entry name as
AAD. Web key initialization uses an atomic read/recheck/insert transaction across instances/tabs;
operations resolve on commit. No web key is cached across calls. These formats do not automatically
migrate old product stores; the host reads/verifies/removes those entries through its old adapter.

### 11.3 Keyring backend (`src/keyring.ts`)

```ts
export type KeyringTool = 'security' | 'secret-tool';
export type KeyringOptions = {
  service?: string;                 // default 'byokit-secrets', same rules as a name
  bin?: string;                     // absolute path; default /usr/bin/security (darwin), /usr/bin/secret-tool (linux)
  tool?: KeyringTool;               // default from platform; an explicit tool skips the platform check (tests)
  env?: Record<string, string>;     // host-passed extras only, e.g. DBUS_SESSION_BUS_ADDRESS
  timeoutMs?: number;               // default 10_000, clamped 1_000–60_000
};
export function keyringStore(o?: KeyringOptions): Keystore;
export function keyringEnv(extra?: Record<string, string>): Record<string, string>;
```

- **Wire, `security` (Keychain).** get: `security find-generic-password -s <service> -a <name> -w` (the secret
  on stdout). set: the secret on stdin of `security add-generic-password -s <service> -a <name> -U -w` (`-U`
  updates an existing entry). delete: `security delete-generic-password -s <service> -a <name>`.
- **Wire, `secret-tool` (Secret Service).** set: the secret on stdin of
  `secret-tool store --label=byokit:<service>:<name> service <service> account <name>` (store replaces).
  get: `secret-tool lookup service <service> account <name>`. delete: a `lookup` first (missing gives false),
  then `secret-tool clear service <service> account <name>`.
- **The secret reaches a keyring CLI only on stdin, never in argv or env** (D-C). `get` strips the single
  trailing LF the CLI adds; a secret ending in LF round-trips without it (README says so).
- **Missing entry:** `get` resolves null, `delete` resolves false (`security` "could not be found",
  `secret-tool lookup` exit 1). Any other CLI failure rejects `failed`.
- **Env from nothing (D-G).** Every spawn gets exactly `keyringEnv(hostEnv)`, which is
  `{ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...extra }`. `process.env` is never read and never inherited (the
  spawn passes `env` explicitly). Extra keys and values must be strings without NUL (`invalid` otherwise).
- **argv** is always an array, never a shell. `bin` must be absolute (`invalid` otherwise); a missing or
  non-executable bin rejects `unavailable` (checked before the spawn; ENOENT/EACCES at spawn too).
- **Timeouts** kill the process group (SIGTERM, then SIGKILL 5 s later) and reject `failed`. stdout is capped at
  1 MB (past it, kill and reject `failed`); stderr keeps a 2 KB tail for logs only, never in messages.

### 11.4 Passphrase file (`src/file.ts`, `src/atomic.ts`)

```ts
export type FileOptions = { path: string; passphrase: string | Uint8Array };
export function fileStore(o: FileOptions): Keystore;
/** Atomic 0700/0600 writer (R6). Lets fs errors (paths only, never secrets) propagate. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void;
```

- `path` must be absolute (`invalid` otherwise); `passphrase` must be non-empty (`invalid` when empty).
- The file is UTF-8 JSON
  `{ v: 1, kdf: 'scrypt-16384-8-1', salt: base64(16 fresh random bytes per save),
     box: base64(sealSecretBox(JSON { entries: { name: secret } }, scrypt(passphrase, salt))) }`,
  written through `writeFileAtomic`: `mkdirSync(dirname, { recursive: true, mode: 0o700 })`, write
  `<path>.tmp` with mode 0600, rename over the target.
- `get` on a missing file resolves null; `set` creates; `delete` on a missing entry resolves false.
- A wrong passphrase or a tampered box makes `openSecretBox` return null: the call rejects `auth-failed` and
  fails closed (nothing returned, nothing written). An unparseable file rejects `failed`.
- Derived keys are zeroed after use. A string passphrase cannot be zeroed (the runtime keeps copies), so
  `Uint8Array` is preferred; the README says so.

### 11.5 CI override (`src/override.ts`)

```ts
export function overrideStore(entries: Record<string, string>): Keystore;
```

It copies `entries` (names and secrets validated as in 11.2) and runs `get/set/delete` on the copy. The host
builds the map from `process.env` itself when it wants to; the kit never reads it.

### 11.6 Acceptance (L-KEY)

- Decoy HOME with `--permission` and fake keyring CLIs for both tools that log argv+env and emulate a store:
  the canary is absent from argv and env, the decoy is byte-identical, the child exits 0.
- A test with a poisoned `process.env` (decoy HOME, junk PATH, entries named like the secrets) behaves
  identically, and the fake's env holds exactly the base plus host extras.
- A wrong passphrase rejects `auth-failed`; the sealed file holds no plaintext canary.
- `~/.pi` is untouched byte for byte (`scripts/test.sh`).
- Portable entries bundle without Node imports/globals; fake SecureStore covers the shared API, names,
  options and sanitized errors. Fake IndexedDB plus local WebCrypto covers persistence, non-extractability,
  fresh IVs, concurrent initialization, tampering, entry swapping, aborted transactions and missing APIs.
- `SECURITY.md` exists; the package is public at 0.2.0; build, check, test and `smoke:pack` are green.

### 11.7 Desktop and server accounts sealing (0.3.0)

Node-only exports add `osKeyring({ service, entry? }): KeyringBackend` (synchronous get/set/delete),
`osKeyringStore` with the same options (async `Keystore`), and ready adapters:

```ts
export interface SealingAdapter {
  encryptString(text: string): Uint8Array;
  decryptString(data: Buffer): string;
}
export function osKeyringSeal(o: { service: string; keyring?: KeyringBackend }):
  SealingAdapter & { rotateKey(): string };
export function hostKeySeal(o: { key: Uint8Array | (() => Uint8Array); service?: string }): SealingAdapter;
```

These fit accounts 0.8.0's `fileStore(path, adapter)` without an accounts runtime dependency. Phone/web
entries never import this code. Exactly pinned optional `@napi-rs/keyring` 2.1.0 supplies Keychain,
Credential Manager and Secret Service native APIs; Linux must pass `store: 'secret-service'`, never
the binding's implicit kernel-keyring fallback. Native code uses the OS session; the TS kit reads no
environment variable and spawns no helper for these exports. A missing/locked backend or binding is
sanitized `unavailable`, not a missing entry. Injectable `entry` and `keyring` are fake-only test seams.

The OS seal probes availability at construction and creates a random 32-byte data key only on write.
Immutable keys are stored as hex under `byokit-seal-key-v1-<random-16-byte-id>`, with an active id in
`byokit-seal-active-v1`. Read-back verifies a new key before activation; concurrent creation cannot
overwrite an existing key. No credential or generated key is stored beside the data. The wire is
`BKS1 | mode (host=0, OS=1) | id (16) | sealSecretBox(header | JSON {service,text})`, with seal's fresh
24-byte nonce. The header and service are authenticated. Missing/corrupt keys, wrong keys and tamper
fail `auth-failed`; decryption never creates a replacement. Byte copies are zeroed after each operation.

Rotation activates a fresh verified key, retains old keys for files/backups, and applies to every instance's
next write. Hosts lock multi-process writers, rewrite files and retire backups before deleting old keys.
Explicit headless selection uses `hostKeySeal` with a separately provisioned 32-byte key or synchronous
resolver. It creates no key, saves no key and has no plaintext fallback. The host owns key rotation and
old-key backup retention; the mode-0 wire has a zero id and no key version. Resolver failures are sanitized.

Acceptance: fake-only native/keyring unit tests exercise accounts' real fileStore, rotation, tamper/wrong
key rejection with no overwrite, dropped/failed key writes, unavailable storage and explicit headless
sealing. Opt-in real Linux tests run in CI's own disposable D-Bus/Secret Service session, skipping when
unavailable unless CI requires the provisioned service. `scripts/test-keyring.sh` clears inherited desktop
settings and creates private HOME/XDG/control directories; the test asserts the private bus before any
native call and refuses standalone opt-in. README records binding choice, threat model
(other users, leaked files and backups), same-user/privileged attacker and rollback limits, and migrations.

## 12. `@byokit/statusbar`

One ongoing job the person started, shown where Android 16 shows a Live Update: a chip in the status bar, the top of
the notification shade and the lock screen. The kit takes plain text from the app and never builds a sentence of its
own except its state words (12.7). Product meaning (what counts as a job, when to promote, the counts) stays in the
app (D-A).

### 12.1 Platform facts builders must not re-derive

- A Live Update is a promoted ongoing notification. `NotificationCompat` in androidx.core 1.17.0 (already an `api`
  dependency of `expo-modules-core` 57) sets the promotion request on every API level. `setShortCriticalText`,
  `canPostPromotedNotifications()` and `Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS` are API 36; the
  `POST_PROMOTED_NOTIFICATIONS` permission and the public `setRequestPromotedOngoing` are API 36.1.
- Promotion needs all of: the request, `ongoing`, a content title, a standard/BigText/Call/Progress style, no custom
  views, not colorized, not a group summary, and a channel above `IMPORTANCE_MIN`. OEMs may add criteria.
- The chip always shows the small icon. Text of 7 characters or fewer shows whole.
- `POST_PROMOTED_NOTIFICATIONS` is manifest-only (no runtime prompt), on top of the runtime `POST_NOTIFICATIONS`. The
  person can switch promotion off per app; `canPostPromotedNotifications()` reports it.
- Google's use rules: ongoing, user-initiated, time-sensitive activity with a start and an end; never alerts, chat,
  ads or quick access to app features; and never repost one the person dismissed (detect it with the delete intent).
- A notification shows at most 3 actions. `setAuthenticationRequired(true)` makes the OS unlock first.
- `VISIBILITY_PRIVATE` with a public version shows only the public copy on a secure lock screen and during screen
  sharing. What the chip shows on a secure lock screen is unverified, so the chip text must be counts-only too.
- AOSP drops updates beyond 5 per second per package.

### 12.2 Files (BK-S1)

```
packages/statusbar/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE  .gitignore
  expo-module.config.json                 # { "platforms": ["android"], "android": { "modules": [
                                          #   "io.github.umeranjum17.byokit.status.StatusModule"] } }
  app.plugin.js                           # config plugin (12.6)
  android/build.gradle                    # minSdk 24; androidx.core 1.17.0
  android/src/main/AndroidManifest.xml    # POST_NOTIFICATIONS and the dismissal receiver (12.6)
  android/src/main/java/io/github/umeranjum17/byokit/status/{StatusRules,StatusNotice,StatusModule}.kt   # 12.5
  android/src/test/java/io/github/umeranjum17/byokit/status/StatusRulesTest.kt
  src/index.ts  src/types.ts  src/status.ts  src/words.json  src/words.ts
  src/rn.ts                               # the only file calling requireOptionalNativeModule('ByokitStatus')
  test/{status,portable,words,exports}.test.ts
```

`package.json` follows 7.2: the same `files`, optional peers and exact `expo-modules-core` dev pin; `exports` has
only `.` → `{ "react-native": dist/rn.js, "default": dist/index.js }`.

### 12.3 Public types (`src/types.ts`) and entries

```ts
export type StatusState = 'on' | 'off' | 'needs-permission' | 'unsupported';
export type StatusAction = { id: string; label: string };   // id /^[a-z][a-z0-9_]{0,31}$/, label non-empty
export type ShowOptions = {
  title: string;          // private, non-empty: promotion needs a content title
  text: string;           // private
  chip: string;           // status-bar chip, at most 7 characters (code points); counts and fixed words only
  publicText: string;     // lock screen and screen share; counts and fixed words only
  promote: boolean;       // ask for the chip; false posts a plain ongoing notification
  actions?: StatusAction[];   // at most 3, unique ids; each needs the phone unlocked
  timeoutMs: number;      // integer ≥ 1000: the notification clears itself this long after the last post
  icon?: string;          // small icon, an app drawable name /^[a-z][a-z0-9_]{0,63}$/; default the app's icon
};
export type StatusEvent = { type: 'action'; id: string } | { type: 'dismissed' };
export type StatusEventType = StatusEvent['type'];
export interface Status {
  show(o: ShowOptions): void;          // throws Error('status: <what>') on bad options, before any native call
  clear(): void;                       // the job ended: cancels the notification and forgets a dismissal
  on<T extends StatusEventType>(type: T, fn: (e: Extract<StatusEvent, { type: T }>) => void): () => void;   // listener set
  state(): Promise<StatusState>;
  openSettings(): Promise<void>;       // the promotion setting, else the app's notification settings
}
export interface NativeStatus {        // what the Kotlin module exposes (12.5); internal seam
  show(o: ShowOptions & { channel: string }): void;   // channel: the channel's visible name, from words
  clear(): void;
  state(): Promise<StatusState>;
  openSettings(): Promise<void>;
  addListener(event: 'status', fn: (e: StatusEvent) => void): { remove(): void };
}
```

States:
- `unsupported`: no native module (iOS, web, Node), or Android below API 36. `show()` posts nothing there.
- `needs-permission`: notifications are off for the app (no `POST_NOTIFICATIONS` grant) or its channel is blocked.
- `off`: the person switched promotion off for the app, or set the kit's channel to Minimum. `show()` still posts, as
  a plain ongoing notification.
- `on`: a `promote: true` post can show as a chip.

`src/status.ts` (pure): `createStatus(native: NativeStatus | null): Status`. It checks `show()`'s options on every
platform, so a bad call fails in development on iOS too; with `null` everything else does nothing and `state()`
resolves `unsupported`. One native listener feeds a JS listener `Set` per event type, as in overlay (7.3).

Entries: `src/index.ts` exports the types, `createStatus`, `words`, `stateWords` and `status = createStatus(null)`;
`src/rn.ts` exports the same names with `status = createStatus(requireOptionalNativeModule('ByokitStatus'))`.

Events:
- `action`: the person tapped an action. Actions open the app (an activity intent, so Android 12's trampoline rule
  holds) with the id and a per-tap nonce as extras; the module reads it when the activity starts or gets a new
  intent, and holds it until JS listens. Each nonce is emitted once, even when Android replays the intent after process
  death or from Recents. A tap on the notification itself opens the app and emits nothing.
- `dismissed`: the person swiped the notification away. From then on `show()` posts nothing until the app calls
  `clear()` (the job ended); the next `show()` after that posts again. The dismissal survives the process.

### 12.4 Keeping the chip truthful

- `timeoutMs` is re-armed on every post. A dead app therefore clears its chip within `timeoutMs`.
- The app calls `show()` from its own refresh. Posts are deduped by the visible content (every `ShowOptions` field
  except `timeoutMs`) and throttled to one per 1.5 s with a trailing post of the latest options.
- An unchanged `show()` is dropped while the notification is still posted, except once half of `timeoutMs` has passed
  since the last post: then it posts again to re-arm the timeout. So an app that keeps calling `show()` keeps its chip,
  and one that stops loses it. A notification that went without a delete intent (force-stop, reboot, a blocked channel)
  is posted again by the next `show()`.
- A delete that arrives within 1 s of the timeout counts as the timeout, not as the person's dismissal.
- Times are on the boot clock (`elapsedRealtime`), so a wall-clock change moves nothing; a record from an earlier boot
  is forgotten. Nothing is recorded for a post that `needs-permission` stopped.

### 12.5 Kotlin parts (package `io.github.umeranjum17.byokit.status`, one job each)

```kotlin
data class Post(val title: String, val text: String, val chip: String, val publicText: String, val promote: Boolean,
                val actions: List<Pair<String, String>>, val timeoutMs: Long, val icon: String?)
data class Last(val signature: String, val at: Long, val timeoutMs: Long)
object StatusRules {                                                     // pure, JVM-tested
  const val CHIP_MAX = 7; const val ACTIONS_MAX = 3; const val THROTTLE_MS = 1500L; const val TIMEOUT_SLACK_MS = 1000L
  fun chipFits(chip: String): Boolean                                    // ≤ CHIP_MAX code points
  fun check(p: Post): String?                                            // the 12.3 rules; null when fine, else what is wrong
  fun promotable(p: Post, channelImportance: Int): Boolean               // promote, a title, the chip fits, channel above MIN
  fun channelPromotable(importance: Int): Boolean                        // above MIN; state() uses it
  fun signature(p: Post): String                                         // every visible field; not timeoutMs
  sealed class Decision { object Show; object Drop; data class Later(val ms: Long) }
  fun decide(sig: String, now: Long, last: Last?, dismissed: Boolean): Decision   // dismissed → Drop; dedupe/refresh; throttle
  fun userDismissed(now: Long, last: Last?): Boolean                     // false when the delete is the timeout
}
class StatusNotice(context: Context) {                                   // NotificationCompat, one notification
  fun show(p: Post, channelName: String); fun clear(); fun deleted()     // deleted(): from the delete intent
}
class StatusDismissReceiver : BroadcastReceiver()                        // the delete intent's target; not exported
class StatusModule : Module()                                            // Expo module 'ByokitStatus', maps NativeStatus
```

`StatusNotice` posts one notification (fixed tag and id) on its own channel `byokit.status`, `IMPORTANCE_LOW` (never
MIN, which blocks promotion), with no sound or badge. Each post sets:
- `setOngoing(true)`, `setOnlyAlertOnce(true)`, `setRequestPromotedOngoing(promote)` and `setShortCriticalText(chip)`;
- `VISIBILITY_PRIVATE` with a public version whose title is `publicText` (no text, no actions);
- `setTimeoutAfter(timeoutMs)`;
- `setDeleteIntent` to `StatusDismissReceiver`;
- the content intent and each action as an activity `PendingIntent` to the app's launch intent, each action with
  `setAuthenticationRequired(true)`.

The last post (`Last`) and the dismissal live in the app's `byokit.status` shared preferences, so the receiver works
in a fresh process. The module emits `dismissed` when it is alive; a later `show()` obeys the dismissal either way.

### 12.6 Library manifest and config plugin

- The library manifest declares `POST_NOTIFICATIONS` and `<receiver android:name=
  "io.github.umeranjum17.byokit.status.StatusDismissReceiver" android:exported="false"/>`.
- `app.plugin.js` adds `android.permission.POST_PROMOTED_NOTIFICATIONS` to the app manifest. It takes no options.
- There is no foreground service and no runtime prompt: the app asks for `POST_NOTIFICATIONS` itself (for example with
  `PermissionsAndroid`), shows `stateWords('needs-permission')`, and calls `openSettings()`.

### 12.7 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `status.on` | Work in progress shows at the top of the screen. |
| `status.off` | Work in progress shows only in the notification list. Turn it on in this app's notification settings. |
| `status.needsPermission` | Allow notifications for this app to see work in progress. |
| `status.unsupported` | This device can't show work in progress at the top of the screen. |
| `status.channel` | Work in progress |

`stateWords(s: StatusState)` maps each state to its `status.*` sentence; `status.channel` names the channel in the
system settings. The words test uses the D-P jargon expression.

### 12.8 Work package

**BK-S1 — the kit, JVM tests, CI and the emulator proof** · Sol · deps: BK-O1
- **Files:** everything in 12.2; root build list, `scripts/fix-words-dts.cjs` and `tsconfig.json`'s `rn.ts`
  exclusion gain `packages/statusbar`; `scripts/release.ts`' canonical order gains `statusbar` after `overlay`;
  `examples/expo` gets the dependency, the plugin and a small screen (show with three actions, clear, state);
  `.github/workflows/ci.yml` job `statusbar-android` (the `overlay-android` shape, running
  `:byokit-statusbar:testDebugUnitTest`); README table rows and the isolation sentence (D-D).
- **Acceptance:**
  - `StatusRulesTest` covers eligibility, the 7-character chip (code points), `check`, the signature (not
    `timeoutMs`), dedupe, the half-timeout refresh, the 1.5 s throttle, a dismissal dropping every post, and the
    timeout-versus-dismissal split. It runs in `statusbar-android`.
  - `status.test.ts` (fake `NativeStatus`) covers `show` validation before any native call, the channel name from
    words, listener sets, and `createStatus(null)` unsupported everywhere; `portable`, `words` and `exports` as in
    overlay.
  - An API 36.1 emulator run on `examples/expo`, recorded in the PR: the chip is visible, the lock screen shows the
    public copy, the expanded notification shows 3 actions, and after a swipe the next `show()` posts nothing.
  - The package stays `private: true` until that proof is recorded; publishing is a later release.

## 13. `@byokit/push`

Owner-approved capability name: **push**. One Expo module opens sealed notices before native display;
`private: true` at 0.1.0. It sits beside seal and relay, consumes exactly seal 0.2.0, and imports no runtime kit.
The transport credentials, notification permission, registration, routing policy and visible product copy stay
with the host app. It never reads installed AI tools or starts a host service.

### 13.1 Surface and payload

- `setNoticeKey(key: Uint8Array): Promise<void>` stores one raw 32-byte X25519 secret; invalid lengths reject
  before native calls. `clearNoticeKey(): Promise<void>` deletes it before logout/revocation. Unsupported default
  entries reject; the React Native export alone loads `ByokitNotices`.
- `openNoticeContent(payload: unknown, key: Uint8Array): NoticeContent | null` is a native-free parser consuming
  seal's `{ v: 1, sealed }` envelope, directly or in `payload.notice` (object or JSON string).
- `NoticeContent = { title: string; body: string; data?: Record<string, unknown> }`. Title must be non-empty;
  body may be empty. `data` preserves app routing fields, including muxr's current notice shape. Never infer
  authorization or sender identity from an opened notice. Invalid envelopes, invalid content, wrong keys and
  tampering fail closed; native display uses the transport's original generic copy.
- Wire: unpadded canonical base64url of ephemeral public key (32) | nonce (24) | NaCl crypto_box_easy MAC and
  ciphertext (16 + JSON bytes), opened with the raw secret. Native envelopes cap `sealed` at 8192 characters;
  actual APNs/FCM payload limits are lower and enforced by the sender/provider.

### 13.2 Native integration

`packages/push` follows statusbar/overlay's layout: pure TS entry, RN entry, config plugin, Expo module config,
Kotlin library, Swift module and extension. The plugin requires `appGroup` and `ios.bundleIdentifier`.
It adds and embeds the `ByokitNoticeService` Xcode target with a pinned Swift-Sodium 0.11.0 Clibsodium product,
sets App Group entitlements on app and extension, and supplies EAS extension metadata. The app writes its secret
through a shared App Group generic-password keychain entry, `AfterFirstUnlockThisDeviceOnly`; no key file or
content log. The NSE opens top-level APNs `notice` or Expo's `userInfo.body.notice`, requires an alert with `mutable-content: 1`, replaces
title/body and puts routing fields in `userInfo.data` and Expo's `userInfo.body.data`. Every failure/timeout returns the original generic content.

Android's non-exported FirebaseMessagingService owns data-only messages containing JSON-string `notice`.
It reads the AES-GCM wrapped secret from private preferences with a wrapping key held in Android Keystore,
opens the box, then builds the notification. No `notification` FCM field: the background system-tray path would
bypass opening. Missing/unreadable keys fall back to generic transport title/body. The private notification has
a generic public version and an activity launch intent carrying `byokit.notice.data`. No direct boot, no prompt
from a service, no executable tap action. A host with its own service sets `androidService: false` and forwards
to `NoticeHandler.handle`; it owns all other messages and token refresh. Clearing the key deletes the encrypted
entry and wrapping alias. Rotation keeps one key; old messages fall back.

### 13.3 Acceptance

TS, JVM and Swift tests open the same deterministic seal 0.2.0 fixture and exercise malformed/wrong-key/tamper
fallback. Portable entry bundles without Node/native imports. Root build/check/test/pack pass; `push-android`
assembles and runs JVM tests; `push-ios` runs Swift tests and builds the generated extension. Neither test suite
needs a push account or delivery network. Signed physical-device sleeping-phone proof is the manual procedure
in the package README, with generic fallback, key clearing, tap routing and first-unlock behavior recorded.
Publishing remains held by `private: true` until release approval.

## 14. `@byokit/share`

Owner-approved capability name: **share**. One package, `@byokit/share` 0.1.0 `private: true`, receives shared
text and files in an Expo app and carries two third-party build fixes on the same config plugin. It replaces an
app's `postinstall` rewrites of three published upstreams with its own Kotlin and TS code plus config-plugin edits of
the app's *generated* native project. It never edits `node_modules`, imports no other kit and no runtime kit, and
the app keeps its share screens and decisions (D-A).

**Status: specified; the TypeScript surface (14.7) and the JS hook layer (`hook.ts`, `adapter.ts`, `rn.ts`) are in the
repo with offline tests (H1-H22, `npm test`); no native build, prebuild, Gradle run, emulator run or device run has
happened. Every statement here carries one of three labels; an unlabelled statement about this kit's own code is
[PROPOSED].

| Label | Meaning |
|---|---|
| [SOURCE-VERIFIED `file:line`] | The cited file in an unmodified published tarball (or this repo) shows it. Says nothing about runtime. |
| [PROPOSED] | Design intent. Verified only when the acceptance case named next to it passes. |
| [UNVERIFIED-RUNTIME] | Depends on Android, iOS, RN 0.86.3, Gradle, npm or device behaviour the evidence does not show, including reasoning from RN 0.81.5 sources. |

**Citations** name a published package version and a path inside it. Short keys used below:

| Key | Package and path |
|---|---|
| `esi` | expo-share-intent 8.0.1, package root |
| `esik` | expo-share-intent 8.0.1 `android/src/main/java/expo/modules/shareintent/` |
| `at` | @bacons/apple-targets 5.0.0 `build/` (`at/../package.json` is its package root) |
| `dl` | @desklink/react-native 0.3.0, package root |
| `emc` / `emck` / `emgp` | expo-modules-core 57.0.19 / its `android/src/main/java/expo/modules/kotlin/` / its `expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/` |
| `ema` / `eagp` | expo-modules-autolinking 57.0.13 / its `android/expo-gradle-plugin/` |
| `expo` | expo 57.0.25 `android/src/main/java/expo/modules/` |
| `cp` | @expo/config-plugins 57.0.9 `build/` |
| `tpl` | expo-template-bare-minimum 57.0.27 |
| Crewhouse | Crewhouse `mobile/` at fae80a2 (the consumer whose patches this replaces) |

The scout evidence (extracted tarballs, consumer source copies, analyst and review outputs) and its integrity
receipts live with firstmate, not in this repo. Anyone can reproduce the tarballs with `npm pack <name>@<version>`;
each `sha512` equals the registry `dist.integrity` and the Crewhouse lock entry:

| Tarball | Integrity |
|---|---|
| expo-share-intent@8.0.1 | `sha512-VOHzutKhiEuVW9ygWCfBlseVqR5Zs8+8GAOGdg42bm7yzHALmYBclrTL+6oCIv34q+CHxf/lCt/67qeZrORfVQ==` |
| @bacons/apple-targets@5.0.0 | `sha512-03LEidnuAAccH5ueL03sOaauQMnpJ7ZGwrVUlzNc5K3BrlfGE9SDUJs1ITkXC7YLKfFPJyiB7VzoZYiRxJmUdA==` |
| @desklink/react-native@0.3.0 | `sha512-CKhNL64waY3F0XbDRrnJ59qXdM82KDa6Uc6VsowH9IGV/fhdt6EA8GUGnMkh5xcvrXN5XEPpj4qrWRBp5NGAZA==` |

All three are `dist-tags.latest` as of 2026-10-02; no newer release removes the problems.

### 14.1 Decisions

| # | Decision |
|---|---|
| SH-1 | **One package, one plugin.** `["@byokit/share", { shareIntent?, appleTargets?, desklink? }]` configures share receiving, the apple-targets fix and the desklink fix; each part is off unless its option is set. **Disclosed cost:** any app that installs the kit links `ShareModule` and `ShareListener`, a desklink-only app included. Without the manifest filters no implicit SEND reaches it. `.MainActivity` is `exported="true"` [SOURCE-VERIFIED `tpl/android/app/src/main/AndroidManifest.xml:23`], so an **explicit** SEND can probably reach it without any filter [UNVERIFIED-RUNTIME]; `ShareListener` would capture it, nothing reads it while no hook is mounted, and every read is guarded. "Harmless" is [PROPOSED]. |
| SH-2 | **Stock, byte-identical upstreams.** Acceptance runs against the published expo-share-intent 8.0.1, @bacons/apple-targets 5.0.0 and @desklink/react-native 0.3.0, byte-identical in the app's `node_modules` (14.14 D2). No patch-package, `postinstall`, fork, vendored or bundled copy, source build or unpublished prerequisite. The OpenClaw bundling exception does not apply. |
| SH-3 | **Exact optional peer pins** (14.5). Only these versions are qualified; moving one is a deliberate bump that reruns 14.12, 14.13 and 14.14. |
| SH-4 | **Android: upstream's native module is replaced, not wrapped.** expo-share-intent's Android code is kept out of the build through Expo's supported `expoAutolinking.exclude` in the generated `settings.gradle`; the kit's own module `ByokitShare` receives shares; upstream's config plugin still writes the manifest filters. No `MainActivity` edit, no intent sanitizing in the host. |
| SH-5 | **iOS: upstream passes through unchanged**; the kit's hook validates a share URL before any native call. |
| SH-6 | **Full typed pass-through** of expo-share-intent's published surface (14.12): every public export, type, hook option, native member and plugin option, each marked identical, adapted or unsupported per platform. No `sharePlugin()` helper; `SharePluginOptions` is the typed config entry. |
| SH-7 | **apple-targets: hide and restore.** A public-API config mod hides foreign extension targets while apple-targets runs, then restores them; a sibling guard fails loud. `match` accepts any glob, resolved with apple-targets' own nested `glob`. |
| SH-8 | **desklink: Gradle from outside.** A root `build.gradle` insert applies `expo-module-gradle-plugin` to `:desklink-react-native`. desklink's source is unchanged. |
| SH-9 | **`singleTask` only** (14.2). |
| SH-10 | **Release.** `SECURITY:`/`FIX:` lines in `packages/share/CHANGELOG.md` `## Unreleased`, no cascade, `share` added to the canonical order (14.17). Main is the sole publisher and npm-trust owner. |

### 14.2 The launch-mode rule

**`.MainActivity` must have `android:launchMode="singleTask"`. Nothing is equivalent; `singleTop` is rejected.**

- Upstream defaults to `singleTask` and merges caller attributes over it [SOURCE-VERIFIED
  `esi/plugin/build/android/withAndroidMainActivityAttributes.js:31-34`]; the template sets it [SOURCE-VERIFIED
  `tpl/android/app/src/main/AndroidManifest.xml:23`]; Crewhouse sets no launch-mode override [SOURCE-VERIFIED
  Crewhouse `app.json:58-76`].
- The warm path needs the running instance to get `onNewIntent` [SOURCE-VERIFIED
  `expo/ReactActivityDelegateWrapper.kt:306-315` → `emck/ReactLifecycleDelegate.kt:40-41` → `emck/AppContext.kt:360-364`];
  the RN `ReactActivity` hop is cited only from RN 0.81.5 [UNVERIFIED-RUNTIME for 0.86.3].
- Under `singleTop` a share usually starts a second `MainActivity` in the sender's task [UNVERIFIED-RUNTIME].
  Upstream papers over that with a relaunch that forwards the sender's grants [SOURCE-VERIFIED
  `esik/ExpoShareIntentModule.kt:114-122`]; this kit never relaunches.

Enforced by: option validation (14.6 step 2), the final-manifest assertion (14.6 step 3b, with its ordering caveat),
D3's `.MainActivity` read and D6 W3. A committed `android/` that never runs prebuild gets neither plugin check (L2);
the README tells bare apps to keep `singleTask`.

### 14.3 Upstream facts builders must not re-derive

**expo-share-intent 8.0.1, Android** [SOURCE-VERIFIED `esik/ExpoShareIntentModule.kt`]:
- `getFileInfo` (`:59-112`) has no guard: `query(...)!!` at `:69`, `getType(uri)!!` at `:75`, an unclosed
  `decodeStream(openInputStream(uri))` at `:84`, an unreleased `setDataSource` at `:90`; `?.toInt().toString() ?: null`
  yields the string `"null"` (`:91-99`).
- Warm intents run on the UI thread via `OnNewIntent` (`:199-201`); `expo/ExpoReactHostFactory.kt:86-93` re-throws
  (process crash is [UNVERIFIED-RUNTIME]). The cold path clears its singleton only after success (`:184-188`).
- Path resolution can return external-storage absolute paths (`:231`), a cache copy of any `content://` URI including
  the app's own providers (`:264-265` → `getDataColumn` → copy at `:329-331`), or raw `uri.path` (`:268`). For
  `file://`, `query(...)!!` at `:69` runs first, so the expected result is a crash [UNVERIFIED-RUNTIME].
- The listener captures any typed launch intent (`esik/ExpoShareIntentReactActivityLifecycleListener.kt:15-21`).
  `disableAndroid` gates only the manifest mods (`esi/plugin/build/index.js:29-34`); module and listener stay
  registered (`esik/ExpoShareIntentPackage.kt:8-9`).
- Text branching: `startsWith("text/plain")` gives text only (`:125-139`; VIEW reads `intent.dataString`, `:135-136`);
  anything else gives files only (`:140-159`).
- **Supported route:** `var exclude` on the autolinking settings extension
  (`eagp/expo-autolinking-settings-plugin/.../ExpoAutolinkingSettingsExtension.kt:46`, passed on at `:75-81`, through
  `SettingsManager.kt:31-35` and `AutolinkingCommandBuilder.kt:64`), appended to the package.json list at
  `ema/build/commands/autolinkingOptions.js:156-157`. RN's own autolinking already skips Expo modules
  (`ema/build/reactNativeConfig/androidResolver.js:142-144`). The template calls `expoAutolinking.useExpoModules()` at
  `tpl/android/settings.gradle:32`. The effect is [UNVERIFIED-RUNTIME] until D5's package-list grep.
- Manifest filters still come from upstream's plugin (`withAndroidIntentFilters.js:48-79`), not from autolinking.

**expo-share-intent 8.0.1, iOS** [SOURCE-VERIFIED]: the extension copies into the app group
(`esi/plugin/build/ios/ShareExtensionViewController.swift:298-308`) and the host reads only app-group UserDefaults
(`esi/ios/ExpoShareIntentModule.swift:25-35`). Upstream's hook calls native `getShareIntent(url)` for **any** URL
containing `<scheme>://dataUrl=` (`esi/build/useShareIntent.js:40-42`), and native runs `url.fragment!`
(`ExpoShareIntentModule.swift:138-143`, also `:87,106,119,130,151`). The extension builds exactly
`<scheme>://dataUrl=<scheme>ShareKey…#(media|text|weburl|file)` (`ShareExtensionViewController.swift:15,494,513-518`).
`getScheme` can return null (`esi/build/utils.js:23-27`); `parseShareIntent` reads `options.debug` unguarded (`:117`).

**@bacons/apple-targets 5.0.0, iOS** [SOURCE-VERIFIED]: candidates are listed by type only
(`at/with-xcode-changes.js:58-63`), then `targets.find(productName) ?? targets[0]` (`:64-68`). Its custom
`xcodeProjectBeta2` mod (`at/with-bacons-xcode.js:34`) reads the project from disk (`:53-61`); Expo's `xcodeproj`
runs at precedence -1 (`cp/plugins/mod-compiler.js:122-152`), so plugin order cannot help. Options: `root`
(default `./targets`), `match` (default `*`, any glob), `appleTeamId` (`at/config-plugin.js:16-17,28`;
`at/config-plugin.d.ts:3-7`). Discovery: `globSync(`${root}/${match}/expo-target.config.@(json|js)`)`
(`at/config-plugin.js:28-31`), `require`, call with `config` if a function (`:34-45`), then
`sanitize(name || dir) || sanitize(dir) || sanitize(type)` (`at/with-widget.js:31-35`; `at/util.js:42-47`). It
declares `glob ^10.4.2` (`at/../package.json:127`); Crewhouse's lock nests glob 10.5.0 under it and hoists 13.0.6.
It returns false for an unknown product type before reading any Info.plist (`at/target.js:729-731`, read at `:733`).
No Android mods.

**@desklink/react-native 0.3.0, Android** [SOURCE-VERIFIED]: applies only `com.android.library` and `kotlin-android`
(`dl/android/build.gradle:1-2`). Without the Pika compiler step (`emgp/ExpoModulesGradlePlugin.kt:22-33`;
`emgp/ProjectConfiguration.kt:22-42`), `isIntrospectable<T>()`/`introspectionOf<T>()` in expo-modules-core's
`types/ReturnType.kt:68-91` keep Pika's stubs, which throw "should be replaced by the compiler plugin" (string in
Pika's `io/github/lukmccall/pika/IsIntrospectableKt.class`); the launch throw itself is reported by Crewhouse
[UNVERIFIED-RUNTIME here]. Its `app.plugin.js:11-16` is iOS-only. The plugin id is on the root classpath
(`eagp/.../SettingsManager.kt:113-125`); defaults are apply-if-missing (`emgp/ProjectConfiguration.kt:22-32`);
`canBePublished` (`emgp/gradle/ExpoModuleExtension.kt:47`) and `enableCompileTimeOptimization` (`:49-50`) are read
in `finalizeDsl` (`emgp/ExpoModulesGradlePlugin.kt:29-30`); `canBePublished` is read at
`emgp/ProjectConfiguration.kt:88-92`, so `false` removes the versionName need. `:expo` calls `evaluationDependsOn`
(`eagp/.../ExpoAutolinkingPlugin.kt:40`); RN forcing `:app` evaluation is checked only in RN 0.81.5
[UNVERIFIED-RUNTIME for 0.86.3]. Project name `desklink-react-native`
(`ema/src/platforms/android/android.ts:176-178`). The root `build.gradle` ends with `apply plugin:
"expo-root-project"` then `"com.facebook.react.rootproject"` (`tpl/android/build.gradle:23-24`). iOS: plain podspec.

### 14.4 Files and root wiring

| File | WP | What it is |
|---|---|---|
| `packages/share/{package.json,tsconfig.json,README.md,CHANGELOG.md,LICENSE,.gitignore}` | WP1 | Scaffold; `tsconfig.json` copied from `packages/statusbar/tsconfig.json` (Expo module); CHANGELOG starts with `## Unreleased` holding the 14.17 lines |
| `expo-module.config.json` | WP1 | `{"platforms":["android"],"android":{"modules":["io.github.umeranjum17.byokit.share.ShareModule"]}}` |
| `app.plugin.js` | WP3 | Config plugin (14.6) |
| `android/build.gradle` | WP2 | Copy of statusbar's; namespace `io.github.umeranjum17.byokit.share`; junit |
| `android/src/main/AndroidManifest.xml` | WP2 | Empty `<manifest/>` |
| `android/src/main/java/io/github/umeranjum17/byokit/share/SharePackage.kt` | WP2 | Contains the literal `import expo.modules.core.interfaces.Package` (scanned at `ema/build/platforms/android/android.js:86`) |
| `…/share/{ShareListener,ShareModule,ShareReader,ShareRules,ShareInbox,ShareMeta}.kt` | WP2 | 14.9 |
| `android/src/test/java/io/github/umeranjum17/byokit/share/{ShareRulesTest,ShareInboxTest,ShareMetaTest}.kt` | WP2 | 14.13 |
| `src/types.ts`, `src/words.json`, `src/words.ts`, `src/index.ts`, `src/url.ts` | WP1 | `url.ts` holds pure `isValidShareUrl` |
| `src/hook.ts` | WP2 | `createUseShareIntent(deps)`: no runtime imports, only `import type` from react; every dependency injected |
| `src/rn.ts` | WP2 | The only file importing `react`, `react-native`, `expo-modules-core`, `expo-linking` or `expo-share-intent` at runtime |
| `src/adapter.ts` | WP2 | Native-free `ShareIntentModule` builders: `createAndroidShareModule(native)` (the Android adapter, 14.8) and `guardIosShareModule(module, scheme)` (iOS `getShareIntent` behind `isValidShareUrl`), plus `androidPayload(r)` shared with `hook.ts` |
| `test/{exports,portable,words,hook,plugin,url}.test.ts` | WP1-3 | 14.13 |
| `test/fixtures/{withwidgets.pbxproj,root.build.gradle,settings.gradle,AndroidManifest.xml,esi-utils.js,esi-utils.d.ts}` | WP2-4 | Gradle files and manifest copied from `tpl/android/`; pbxproj captured in WP4; `esi-utils.js` is `esi/build/utils.js:37-120` (`parseJson`, `parseShareIntent`) with its MIT notice kept, typed by `esi-utils.d.ts` |

Root wiring (WP1): the root `build` list (`package.json:14`); `tsconfig.json:7`'s exclude gains
`packages/share/src/rn.ts`; `scripts/fix-words-dts.cjs:9`'s list gains `share`; README install and kit table rows
(beside `README.md:58-59,144-145`); `examples/expo` (WP2): `package.json` and its lock gain `@byokit/share`
(`file:../../packages/share`) and `expo-share-intent` 8.0.1 (plugin step 3a requires it from the app, so prebuild in
the `react-native`, `statusbar-android`, `push-android` and `push-ios` jobs fails without it), plus
`@bacons/apple-targets` 5.0.0, `expo-widgets` ~57.0.22 and `@desklink/react-native` 0.3.0 with `react-native-webrtc`
if WP4 needs them in that app; then the plugin is listed in `app.json`; `.github/workflows/ci.yml` (14.13); `scripts/release.ts`
in WP1r (14.17). The isolation sentences at `CONTRIBUTING.md:70-71` and `README.md:245` gain: "`@byokit/share` runs
only its own native code, copies shared content into the app's cache only under the sender's grant, and its plugin
edits only the generated `settings.gradle`, `build.gradle` and pbxproj."

### 14.5 package.json

- As statusbar (`packages/statusbar/package.json:1-58`): `"version": "0.1.0"`, `"private": true`, `"type": "module"`,
  `repository.directory`, `engines.node ">=22.18"`, `publishConfig.access public`,
  `"prepack": "tsc -b && node ../../scripts/fix-words-dts.cjs"`.
- `peerDependencies`, all optional (`peerDependenciesMeta`): `"expo": ">=57.0.0"`, `"expo-modules-core": ">=3.0.0"`,
  `"expo-share-intent": "8.0.1"`, `"@bacons/apple-targets": "5.0.0"`, `"@desklink/react-native": "0.3.0"`, plus
  `react`, `react-native`, `expo-linking`. Exact, because the kit relies on upstream deep type paths, the `AndroidShareIntent` parse shape,
  the iOS URL format and apple-targets' discovery internals.
- `files` as statusbar (`packages/statusbar/package.json:27-35`): `dist`, `android`, `!android/build`,
  `expo-module.config.json`, `app.plugin.js`, `README.md`, `LICENSE`, `CHANGELOG.md` (release lint fails without it,
  `scripts/release.ts:341-342`).
- `devDependencies`, exact: `"expo-modules-core": "57.0.19"` (statusbar `:52-54`), plus `"expo-share-intent": "8.0.1"`
  and `"expo-linking": "57.0.11"` so root `npm run check` (`types.ts`) and `tsc -b` (`rn.ts`) resolve them; neither is
  installed at the root today. The last two are an inference not in the report [PROPOSED].
- `exports` as `packages/statusbar/package.json:15-26`: `"."` → `{ "react-native": { "types": "./dist/rn.d.ts",
  "default": "./dist/rn.js" }, "types": "./dist/index.d.ts", "default": "./dist/index.js" }`, plus
  `"./app.plugin.js"` and `"./package.json"`.
  `app.plugin.js` does not import `dist/`.
- README contract [PROPOSED]: the JS entry imports `expo-share-intent` and `expo-linking`; apps using only `desklink`
  or `appleTargets` need not import it; apps must import from the kit, not `expo-share-intent` directly.

### 14.6 Config plugin (`app.plugin.js`)

Plain ESM; `expo/config-plugins` resolved lazily from the app as in `packages/push/app.plugin.js:11-12`. Options:
`ShareIntentPluginOptions` (upstream `Parameters`, `esi/plugin/build/types.d.ts:4-19`), `AppleTargetsPluginOptions`
(`= at/config-plugin.d.ts:3-7`), `SharePluginOptions = { shareIntent?; appleTargets?; desklink?: boolean }`.
`withShare(config, options = {})`, every step [PROPOSED] and checked by C5:

1. **Resolve from the app.** `app = createRequire(join(projectRoot, 'package.json'))`; `interop = m => m.default ?? m`.
2. **Validate**, throwing plain `Error('@byokit/share: …')` (developer messages, not words) on: an unknown
   **top-level** key; a non-boolean `desklink`; `config.plugins` also listing `expo-share-intent` or
   `@bacons/apple-targets` (they would run twice); `shareIntent.androidMainActivityAttributes['android:launchMode']`
   other than `'singleTask'`, with the message
   `@byokit/share: MainActivity must stay singleTask so a share reaches the running app`. Keys **inside**
   `shareIntent` and `appleTargets` pass through verbatim, unknown ones included.
3. **`shareIntent` set.**
   - a. `interop(app('expo-share-intent/app.plugin.js'))(config, options.shareIntent)`. Upstream requires `scheme`
     unless `disableIOS` (`esi/plugin/build/withCompatibilityChecker.js:19-23`).
   - b. Final-manifest assertion: `withBaseMod(config, { platform: 'android', mod: 'manifest', isProvider: false,
     action })`; the action awaits `nextMod` first, then `AndroidConfig.Manifest.getMainActivityOrThrow`
     (`cp/android/Manifest.js:82`) and throws unless `$['android:launchMode'] === 'singleTask'`. Writes nothing.
     Caveat: it runs after every `withMod`-style manifest action, not after a `withBaseMod` post-action registered
     later (`cp/plugins/withMod.js:94-121,189-203`); D3 re-reads the written file.
   - c. Always, whatever `disableAndroid` says, `withSettingsGradle` with `insertShareExclude(contents)`: if the tag is
     present return unchanged; else insert immediately before `expoAutolinking.useExpoModules()`, throwing if that
     line is missing:
     ```groovy
     // @byokit/share exclude: @byokit/share reads shares on Android; keep expo-share-intent's native code out
     expoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ['expo-share-intent']
     ```
4. **`appleTargets` set.**
   - `owned = ownedTargetNames(config, options.appleTargets)` immediately before applying upstream, then
     `interop(app('@bacons/apple-targets/app.plugin.js'))(config, options.appleTargets)` (`{}` = upstream defaults).
   - **Hide:** `withBaseMod(config, { platform: 'ios', mod: 'xcodeproj', isProvider: false, action })`
     (`cp/index.js:207`); the action awaits `modRequest.nextMod`, then `assertNoOrphanSibling(section, owned)`, then
     `hideForeignExtensions(section, owned)`, which rewrites each `com.apple.product-type.app-extension` target not in
     `owned` to `…app-extension.byokit-hidden`. Same ordering caveat as 3b (L4).
   - **Sibling guard:** if at least one owned name is already a target and another owned name is missing, throw
     "run `expo prebuild --clean`" before anything is written (otherwise apple-targets falls back to `targets[0]`).
   - **Restore:** `withFinalizedMod(['ios', …])` (`cp/plugins/withFinalizedMod.js:20-25`) runs `restoreHidden` on
     `IOSConfig.Paths.getPBXProjectPath(projectRoot)`; idempotent; also repairs a project left by an aborted prebuild:
     ```js
     export const restoreHidden = text => text.replace(
       /productType = "?com\.apple\.product-type\.app-extension\.byokit-hidden"?;/g,
       'productType = "com.apple.product-type.app-extension";')
     ```
   - **Discovery**, matching apple-targets exactly, with **its own** nested glob:
     ```js
     export function ownedTargetNames(config, { root = './targets', match = '*' } = {}, { globSync, load } = fromAppleTargets(config)) {
       const names = new Set()
       for (const p of globSync(`${root}/${match}/expo-target.config.@(json|js)`, { cwd: config._internal.projectRoot, absolute: true })) {
         let c = load(p); if (typeof c === 'function') c = c(config)
         if (!c || typeof c !== 'object' || !c.type) continue        // upstream throws for these itself (at/config-plugin.js:39-48)
         const dir = basename(dirname(p)); const n = sanitize(c.name || dir) || sanitize(dir) || sanitize(c.type)
         if (n) names.add(n)
       }
       return names
     }
     function fromAppleTargets(config) {
       const r = createRequire(createRequire(join(config._internal.projectRoot, 'package.json')).resolve('@bacons/apple-targets/package.json'))
       return { globSync: r('glob').globSync, load: p => r(p) }      // apple-targets' nested glob@10, not the app's hoisted one
     }
     ```
     `sanitize` is a verbatim copy of `at/util.js:42-47`. The third parameter exists only so C5 can inject a fake. A
     function-style target config runs twice, here and upstream [UNVERIFIED-RUNTIME; harmless if pure]. Optional
     cross-check, not primary: `config.extra.eas.build.experimental.ios.appExtensions[].targetName` before and after
     upstream (`at/with-widget.js:263-266`; `at/with-eas-credentials.js:27-44`).
   - Exported pure helpers: `hideForeignExtensions(section, owned) → string[]`, `restoreHidden(text)`,
     `assertNoOrphanSibling(section, owned)`, `sanitize`, `ownedTargetNames`, `insertShareExclude`,
     `insertDesklinkGradle`.
5. **`desklink: true`.** `withProjectBuildGradle` with `insertDesklinkGradle(contents)`: if the tag is present return
   unchanged; else insert before `apply plugin: "com.facebook.react.rootproject"` (either quote style); throw if that
   line is missing or `expo-root-project` is not above it:
   ```groovy
   // @byokit/share desklink: build @desklink/react-native as an Expo module (Expo SDK 57 needs its compile step)
   def byokitDesklink = findProject(':desklink-react-native')
   if (byokitDesklink != null) {
     if (byokitDesklink.state.executed) throw new GradleException('@byokit/share: :desklink-react-native was configured before the Expo module plugin could apply')
     byokitDesklink.apply plugin: 'expo-module-gradle-plugin'
     byokitDesklink.expoModule.canBePublished = false
     byokitDesklink.expoModule.enableCompileTimeOptimization = true
   }
   ```
   That ordering is SOURCE-VERIFIED; the bytecode effect is [UNVERIFIED-RUNTIME] until D5. Placement premise: `:expo`
   calls `evaluationDependsOn` (`eagp/.../ExpoAutolinkingPlugin.kt:40`); that RN forces `:app` evaluation is checked
   only in RN 0.81.5 [UNVERIFIED-RUNTIME for 0.86.3]; build success under Gradle 9.3.1 and AGP is [UNVERIFIED-RUNTIME]
   until D5. `canBePublished` is read at `emgp/ProjectConfiguration.kt:88-92`, and `canBePublished = false` removes
   the versionName need. A future desklink release that applies the plugin itself makes this a no-op [PROPOSED].
6. **Return `config`.** The plugin never writes `node_modules`, `MainActivity` or package.json.

### 14.7 Types and entries

```ts
// src/types.ts: upstream types re-exported verbatim (type-only). Explicit .js deep paths: nodenext, and esi has no "exports".
// `export type … from` binds no local names, so the types this file uses are also imported.
import type { ShareIntent, AndroidShareIntent, AndroidShareIntentFile, ErrorEventPayload, StateEventPayload } from 'expo-share-intent/build/ExpoShareIntentModule.types.js'
import type { Parameters as ShareIntentPluginOptions } from 'expo-share-intent/plugin/build/types.js'
export type {
  ShareIntent, ShareIntentFile, ShareIntentMeta, ShareIntentOptions,
  AndroidShareIntent, AndroidShareIntentFile, IosShareIntent, IosShareIntentFile,
  NativeShareIntent, NativeShareIntentFile, ChangeEventPayload, ErrorEventPayload, StateEventPayload,
} from 'expo-share-intent/build/ExpoShareIntentModule.types.js'
export type { Parameters as ShareIntentPluginOptions, CustomParameter } from 'expo-share-intent/plugin/build/types.js'

export type AppleTargetsPluginOptions = { appleTeamId?: string; match?: string; root?: string }
export type SharePluginOptions = { shareIntent?: ShareIntentPluginOptions; appleTargets?: AppleTargetsPluginOptions; desklink?: boolean }

export type ShareErrorCode = 'unreadable' | 'partial' | 'failed' | 'invalid_share_url'
export type ShareSkipReason = 'not_content' | 'own_provider' | 'too_large' | 'unreadable'

/** Upstream hook result (esi/build/useShareIntent.d.ts:4-10) plus additive fields. */
export type ShareIntentState = {
  isReady: boolean; hasShareIntent: boolean; shareIntent: ShareIntent
  resetShareIntent: (clearNativeModule?: boolean) => void; error: string | null
  errorCode: ShareErrorCode | null; skipped: number; skipReasons: readonly ShareSkipReason[]
}
/** esi/build/ExpoShareIntentModule.d.ts:3-14, typed to the runtime (onChange is a string on iOS, an object on Android). */
export type ShareIntentModuleEvents = {
  onChange: (e: { value: string | AndroidShareIntent }) => void
  onError: (e: ErrorEventPayload) => void
  onStateChange: (e: StateEventPayload) => void
}
/** NativeModule<Events> members (emc/build/ts-declarations/EventEmitter.d.ts:48-61) plus the module's own. */
export interface ShareIntentModuleLike {
  getShareIntent(url: string): Promise<void>        // iOS: rejects ShareError('invalid_share_url') before any native call
  clearShareIntent(key: string): Promise<void>
  hasShareIntent(key: string): boolean
  addListener<E extends keyof ShareIntentModuleEvents>(event: E, listener: ShareIntentModuleEvents[E]): { remove(): void }
  removeListener<E extends keyof ShareIntentModuleEvents>(event: E, listener: ShareIntentModuleEvents[E]): void
  removeAllListeners(event: keyof ShareIntentModuleEvents): void
  emit<E extends keyof ShareIntentModuleEvents>(event: E, ...args: Parameters<ShareIntentModuleEvents[E]>): void
  listenerCount<E extends keyof ShareIntentModuleEvents>(event: E): number
}
/** Android ByokitShare native contract. */
export type NativeShareRead =
  | { kind: 'none'; seq: 0 }
  | { kind: 'unreadable'; seq: number; skipReasons: ShareSkipReason[] }
  | { kind: 'shared'; seq: number; text: string | null; title: string | null; files: AndroidShareIntentFile[]; skipReasons: ShareSkipReason[] }
export interface NativeShare {
  read(): Promise<NativeShareRead>   // repeatable: with nothing pending, returns the last delivered share until cleared
  clear(seq: number): void           // clears only the delivered share with this seq; never a pending one
  hasPending(): boolean
  addListener(event: 'onShare', listener: () => void): { remove(): void }
}
```

```ts
// src/rn.ts (react-native condition)
export function useShareIntent(options?: ShareIntentOptions): ShareIntentState
export function ShareIntentProvider(props: { options?: ShareIntentOptions; children: React.ReactNode }): React.JSX.Element
export function useShareIntentContext(): ShareIntentState
export const ShareIntentContextConsumer: React.Consumer<ShareIntentState>
export const ShareIntentModule: ShareIntentModuleLike | null   // Android: adapter over ByokitShare; iOS: guarded upstream
export { getScheme, getShareExtensionKey, parseShareIntent } from 'expo-share-intent'
export const shareSupported: boolean
export { WORDS, words, errorWords, createUseShareIntent, ShareError, isValidShareUrl }
export type * from './types.ts'

// src/index.ts (portable: no React, RN or Expo runtime imports)
export const shareSupported = false
export { WORDS, words, errorWords, createUseShareIntent, ShareError, isValidShareUrl }
export type * from './types.ts'

// src/hook.ts (no runtime imports; `import type` from react only)
export function createUseShareIntent(d: {
  module: ShareIntentModuleLike | null
  native?: NativeShare | null                       // Android path
  useLinkingURL?: () => string | null               // iOS path (expo-linking)
  parse: (v: string | AndroidShareIntent, o: ShareIntentOptions) => ShareIntent
  getScheme: (o?: ShareIntentOptions) => string | null
  getShareExtensionKey: (o?: ShareIntentOptions) => string
  react: { useState: typeof useState; useEffect: typeof useEffect; useRef: typeof useRef }
  appState: { currentState?: string | null; addEventListener(e: 'change', f: (s: string) => void): { remove(): void } }
  os: string
}): (o?: ShareIntentOptions) => ShareIntentState
```

`isValidShareUrl(url, scheme)` regex-escapes `scheme`, returns false for a null scheme, and accepts only
`^<scheme>://dataUrl=<scheme>ShareKey(\?[^#]*)?#(media|text|weburl|file)$`.

### 14.8 Hook semantics

Both platforms, identical to upstream unless noted (checked by H1-H22):
- **Options** are merged over upstream's defaults once; that object goes everywhere, including `parse` (it reads
  `options.debug` unguarded). `disabled` (default true on web): no reads, no subscriptions, `isReady: false`.
  `debug`: `console.debug` in JS only. `scheme` feeds `getScheme`, `getShareExtensionKey` and the iOS URL check.
- **`resetShareIntent(clearNative = true)`:** if `disabled`, return (upstream `useShareIntent.js:25-26`); set `error`
  and `errorCode` to null and `skipped` to 0; bump `resetGen` (Android); if `clearNative`, call `native.clear(applied)`
  on Android (skipped when `applied` is 0) or `module.clearShareIntent(key)` on iOS; if a value was showing, reset to
  upstream's default and call `onResetShareIntent` (upstream `:24-34`). After `resetShareIntent(false)` a remount
  shows the share again (L15).
- **Reset before the first delivery (L16, disclosed, not fixed):** a reset clears only what JS has applied. A share
  pending or in flight at reset time is delivered afterwards (H22), by the rule "never drop an undelivered share"
  (X1, X2). A consumer that wants "ignore everything until the next share" compares `seq` or timestamps itself.
- **Background reset:** previous state `active`, next `inactive` or `background`, and `resetOnBackground !== false` →
  `resetShareIntent(true)` (upstream `:70-76`).
- **Provider and context** mirror upstream (`esi/build/ShareIntentProvider.js:4-24`); the default context adds
  `errorCode: null, skipped: 0, skipReasons: []`.

Android (`native` given):
- Refs `applied = 0` (highest seq applied) and `resetGen = 0` (bumped by every reset, X19). `alive` is **not** a ref:
  each effect run declares `let alive = true` and its cleanup sets it false (a ref stays false after StrictMode's
  mount, cleanup, remount, H18).
- One effect, in order: `addListener('onShare', refresh)`; the AppState subscription (refresh on `active`, plus the
  reset rule); `refresh()`. Cleanup sets this run's `alive = false` and removes both.
- `refresh`, defined inside the effect:
  ```ts
  const at = applied.current, gen = resetGen.current
  native.read().then(
    r => { if (!alive || r.kind === 'none' || r.seq <= applied.current) return; applied.current = r.seq; set(map(r)) },  // newer share: delivered even across a reset (H6)
    () => { if (alive && applied.current === at && resetGen.current === gen) set(failed) })                              // X10, X19: a request issued before a reset never restores `failed`
  ```
- `map(r)` builds `{ type: files?.length ? 'file' : 'text', text, meta: { title }, files }` and parses it with
  **upstream's** `parseShareIntent`:

  | Result | `errorCode` | `error` | `skipped` |
  |---|---|---|---|
  | `shared`, no skips | `null` | `null` | 0 |
  | `shared`, skips | `'partial'` | `null` (consumers that reset on error keep the readable files) | count |
  | `unreadable` | `'unreadable'` | `share.unreadable` sentence | count |
  | rejected read | `'failed'` | `share.failed` sentence | — |

- The Android `ShareIntentModule` adapter keeps a JS listener set backing `addListener`, `removeListener`,
  `removeAllListeners`, `emit` and `listenerCount`, and remembers the last seq it emitted for `clearShareIntent`.

iOS (`useLinkingURL` and `module` given): upstream's flow (`useShareIntent.js:38-117`), except `refresh` calls
`module.getShareIntent(url)` only if `url` contains `<scheme>://dataUrl=` **and** `isValidShareUrl(url, scheme)`; with
the prefix but failing the check it sets `errorCode: 'invalid_share_url'` and the `share.invalid_link` sentence and
makes no native call; without the prefix it ignores the URL.

### 14.9 Android native (package `io.github.umeranjum17.byokit.share`)

All Kotlin is [PROPOSED]; compiling it, and kotlinx-coroutines reaching the classpath through expo-modules-core
(`emck/AppContext.kt:79-92`), are [UNVERIFIED-RUNTIME] until WP2. If coroutines are missing, add
`implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android"`.

```kotlin
object ShareRules {                                                                    // pure, JVM-tested
  const val CONSUMED = "io.github.umeranjum17.byokit.share.CONSUMED"
  const val MAX_BYTES = 100L * 1024 * 1024
  fun isTextBranch(type: String?) = type?.startsWith("text/plain") == true            // esik:125, charset forms included
  fun isShare(action: String?, type: String?) = action == "android.intent.action.SEND" ||
    action == "android.intent.action.SEND_MULTIPLE" || (action == "android.intent.action.VIEW" && isTextBranch(type))
  /** null = may read; else the skip reason. content:// only; no N@authority; never a provider owned by our uid. */
  fun reject(scheme: String?, authority: String?, providerUid: Int?, myUid: Int): String? = when {
    scheme != "content" -> "not_content"
    authority.isNullOrEmpty() || '@' in authority || providerUid == myUid -> "own_provider"
    else -> null }
  fun copyName(index: Int, displayName: String?, ext: String?): String   // [A-Za-z0-9._-], ≤100, never ""/"."/"..", "<index>-" prefix
  fun label(displayName: String?, fallback: String) = displayName?.take(255)?.ifBlank { null } ?: fallback
  fun mime(provider: String?, intentType: String?, extGuess: String?) =
    provider ?: intentType?.takeUnless { '*' in it } ?: extGuess ?: "application/octet-stream"
  fun kind(textBranch: Boolean, text: String?, streams: Int, read: Int) = when {
    textBranch -> if (text != null) "shared" else "none"
    read > 0 -> "shared"; streams > 0 -> "unreadable"; else -> "none" }
}

class ShareInbox<I, R>(private val folders: () -> List<Long>, private val delete: (Long) -> Unit, private val wipeAll: () -> Unit) {
  private var seq = 0L; private var pending: Pair<Long, I>? = null; private var last: Pair<Long, R>? = null
  private var watermark = 0L   // highest seq ever delivered (done) or cleared; independent of `last` (X18)
  private val inFlight = mutableSetOf<Long>(); private var wiped = false
  @Synchronized fun offer(i: I): Long { pending = ++seq to i; return seq }                    // UI thread; last wins (L13)
  @Synchronized fun take(): Pair<Long, I>? {
    if (!wiped) { wipeAll(); wiped = true }                                                    // X13: once per process
    val p = pending ?: return null; pending = null; inFlight += p.first
    val keep = inFlight + listOfNotNull(last?.first); folders().filter { it !in keep }.forEach(delete)  // X11
    return p }
  /** true only if this result is newer than everything delivered or cleared so far (X4, X18). */
  @Synchronized fun done(s: Long, r: R): Boolean { inFlight -= s; if (s <= watermark) return false; watermark = s; last = s to r; return true }
  @Synchronized fun requeue(p: Pair<Long, I>) { inFlight -= p.first; if (pending == null) pending = p } // X7
  @Synchronized fun current(): Pair<Long, R>? = last                                         // X8
  @Synchronized fun clear(s: Long) { if (s <= 0) return; if (last?.first == s) last = null; if (s > watermark) watermark = s }  // X1/X2: never pending; X18
  @Synchronized fun hasPending() = pending != null
}
```

**`ShareListener`** (`ReactActivityLifecycleListener`; `onCreate` reached via `expo/ReactActivityDelegateWrapper.kt:169-171`),
body in try/catch: skip a null activity or intent, `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`, `!isShare(action, type)` or
the CONSUMED marker; else `Inbox.get(a).offer(i)` and `a.intent = Intent(i).putExtra(CONSUMED, true)`. The template
calls `super.onCreate(null)` (`tpl/.../MainActivity.kt:19`), so the listener cannot tell recreation from a fresh
launch; the marker is the only defence (X17, L9). Whether RN 0.86.3 forwards `super.onCreate(null)` to the wrapper's
listeners is [UNVERIFIED-RUNTIME]. Every body is in try/catch because unparcelling a foreign extra can throw
[UNVERIFIED-RUNTIME, platform knowledge].

**`Inbox`, `root` and `SharePackage`** (the report names `object Inbox` over `cacheDir/byokit-share` but gives no
body; this fill-in is [PROPOSED, not in the report] and root confirms it before WP2):

```kotlin
fun root(ctx: Context) = File(ctx.cacheDir, "byokit-share")
object Inbox {
  @Volatile private var inbox: ShareInbox<Intent, Map<String, Any?>>? = null
  fun get(ctx: Context): ShareInbox<Intent, Map<String, Any?>> = inbox ?: synchronized(this) {
    inbox ?: root(ctx.applicationContext).let { r -> ShareInbox<Intent, Map<String, Any?>>(
      folders = { r.listFiles()?.mapNotNull { it.name.toLongOrNull() } ?: emptyList() },
      delete = { File(r, "$it").deleteRecursively() },
      wipeAll = { r.deleteRecursively() }) }.also { inbox = it } }
}
class SharePackage : Package {
  override fun createReactActivityLifecycleListeners(ctx: Context?) = listOf(ShareListener())
}
```

Call sites pass a context: `Inbox.get(activity)` in `ShareListener`, the react context in `ShareModule`.

**`ShareModule`:**

```kotlin
Name("ByokitShare"); Events("onShare")
OnNewIntent { i -> val c = appContext.reactContext ?: return@OnNewIntent                     // context null: stop and ask (fill-in)
  if (ShareRules.isShare(i.action, i.type)) { Inbox.get(c).offer(i); sendEvent("onShare") } }   // UI thread: store only
AsyncFunction("read") Coroutine { ->
  val ctx = appContext.reactContext ?: throw Exceptions.ReactContextLost()                    // X6: before take
  val p = Inbox.get(ctx).take() ?: return@Coroutine (Inbox.get(ctx).current()?.let { it.second + ("seq" to it.first) } ?: mapOf("kind" to "none", "seq" to 0))
  val r = try { withContext(Dispatchers.IO) { ShareReader(ctx).read(p.second, File(root(ctx), "${p.first}")) } }
          catch (e: CancellationException) { Inbox.get(ctx).requeue(p); throw e }                // X7
          catch (e: Exception) { mapOf("kind" to "unreadable", "skipReasons" to listOf("unreadable")) }
  if (Inbox.get(ctx).done(p.first, r)) r + ("seq" to p.first) else mapOf("kind" to "none", "seq" to 0)   // X18: a superseded result never resurfaces
}
Function("clear") { s: Long -> appContext.reactContext?.let { Inbox.get(it).clear(s) } }
Function("hasPending") { appContext.reactContext?.let { Inbox.get(it).hasPending() } ?: false }
```

[SOURCE-VERIFIED] the read starts on Expo's single `modulesQueue` (`emck/functions/SuspendFunctionComponent.kt:36-42`;
`emck/AppContext.kt:71-74,88-92`); a cancelled scope leaves the promise unsettled (`:48-50`); a throw rejects
(`:52-56`); `sendEvent` drops silently without a JS object (`emck/events/KModuleEventEmitterWrapper.kt:47-49`). Whether
an event with no subscriber is buffered is unknown; the design assumes not [UNVERIFIED-RUNTIME], hence X9.

**`ShareReader.read(intent, dir)`:**
1. `dir.mkdirs()`; the folder name is the seq.
2. Text branch: `text = VIEW ? intent.dataString : EXTRA_TEXT`; `title = EXTRA_TITLE` for SEND, null for VIEW; no
   stream opened; return `{ kind: kind(true, text, 0, 0), text, title, files: [], skipReasons: [] }`.
3. Files branch: streams from `EXTRA_STREAM` or SEND_MULTIPLE's list, with the API 33 split as `esik:165-173`; text
   not read. Per URI, inside `try { … } catch (e: Exception) { out?.delete(); reasons += if (e is TooLarge) "too_large" else "unreadable" }`:
   `uid = authority?.let { pm.resolveContentProvider(it, 0)?.applicationInfo?.uid }`, then `reject(...)?.let { reasons += it; continue }`;
   display name from a null-safe `query`, as a label only; MIME `ShareRules.mime(getType, intent.type, MimeTypeMap guess)`;
   `out = File(dir, copyName(...))` with the canonical-path guard (`esik:304-310`), 64 KB copy loop throwing `TooLarge`
   past `MAX_BYTES`; `m = try { ShareMeta.of(out, mime) } catch (e: Exception) { ShareMeta.NONE }`; add
   `{ contentUri, filePath: out.path, fileName, fileSize, mimeType, width, height, duration }` as strings, as upstream
   sends them (`esik:103-111`). Return `{ kind: kind(false, null, streams.size, files.size), text: null, title: null, files, skipReasons }`.
4. Log only `Log.w("ByokitShare", "skipped $n")`, no URIs. Only the sender's grant is used: no
   `takePersistableUriPermission`, no relaunch.

```kotlin
object ShareMeta {                                                    // orient is pure and JVM-tested; of() runs on the private copy only
  data class M(val width: Int?, val height: Int?, val durationMs: Long?)
  val NONE = M(null, null, null)
  fun orient(w: Int?, h: Int?, rot: Int, d: Long?) = if (rot == 90 || rot == 270) M(h, w, d) else M(w, h, d)
  fun of(f: File, mime: String): M = when {
    mime.startsWith("image/") -> BitmapFactory.Options().apply { inJustDecodeBounds = true }
      .also { BitmapFactory.decodeFile(f.path, it) }
      .let { if (it.outWidth > 0 && it.outHeight > 0) M(it.outWidth, it.outHeight, null) else NONE }
    mime.startsWith("video/") -> { val r = MediaMetadataRetriever(); try { r.setDataSource(f.path)
        orient(r.extractMetadata(METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull(), r.extractMetadata(METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull(),
               r.extractMetadata(METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0, r.extractMetadata(METADATA_KEY_DURATION)?.toLongOrNull())
      } finally { try { r.release() } catch (_: Exception) {} } }
    else -> NONE
  }
}
```

`release()`, not `close()` (API 29): nothing proves minSdk ≥ 29. Expo's default is 24 via `setIfNotExist`
(`eagp/expo-autolinking-plugin/.../ExpoRootProjectPlugin.kt:53`); the real value comes from RN 0.86.3's catalog
[UNVERIFIED-RUNTIME]. Audio duration stays null, as upstream.

### 14.10 Races

All fixes [PROPOSED]. Rejected alternative: funnelling every read through one in-flight promise, because a read that
never settles (L11, X7) would block every later share.

| ID | Interleaving | Fix | Test |
|---|---|---|---|
| X1 | `OnNewIntent(B)`, then JS handles a queued `background` and clears | `clear(seq)` touches only the delivered share, never `pending` | J5, H4 |
| X2 | `resetShareIntent()` while B is pending | Same as X1 | J5, H5, H6 |
| X3 | Three overlapping reads (mount, active, onShare) | `none` never changes state; only `seq > applied` applies | H2, H9 |
| X4 | Read A in flight, B arrives and finishes first | Monotonic seq; hook drops `seq <= applied`; `done` keeps the newer `last` | J3, H3 |
| X5 | Two shares before any read | Last wins, disclosed (L13), upstream parity | J2 |
| X6 | `take`, then `reactContext` null | Context checked before `take` | code review |
| X7 | Host teardown or reload mid-copy | `CancellationException` requeues (only into an empty slot) and rethrows | J8 |
| X8 | Unmount mid-read, then remount | `read()` with nothing pending returns `current()`; per-effect `alive` | H8, H18 |
| X9 | `onShare` before subscription, or while already foreground | Subscribe before the first `read()` | H1, W2 |
| X10 | Stale rejection after a newer apply | `failed` only if `applied === at` | H7 |
| X11 | Prune vs in-flight copy; same-millisecond reads | Folder = seq; prune keeps `inFlight ∪ {last}` | J6, J10 |
| X12 | Prune vs paths JS still holds | L14 lifetime rule (README) | J10 |
| X13 | Process death | Wipe the root once per process at the first `take`; L9b | J7 |
| X14 | Listener `onCreate` vs `OnNewIntent` | Both `offer`; seq orders them | J9 |
| X15 | Share during app load | Disclosed (L1); not deterministically testable | — |
| X16 | `inactive` parity | Upstream rule: `active` → `inactive` or `background` | H12 |
| X17 | In-process recreation re-runs `ShareListener.onCreate` with a null bundle | CONSUMED marker on `activity.intent`; if it does not survive, offered again (L9) | D6 T-recreate (observational) |
| X18 | `done(2,B)`, `clear(2)`, then late `done(1,A)` | `watermark` (highest delivered or cleared, independent of `last`); `done` returns false for `s <= watermark`, so `read` returns `none`, also on remount | J11, H19 |
| X19 | Reset, then a read issued before it rejects (`applied` unchanged) | `resetGen` captured per request; `failed` needs `applied === at && resetGen === gen`; newer shares still delivered | H20, H21 |
| X20 | Reset before the first delivery (`applied` 0, read in flight) | Not a bug: delivered after the reset; disclosed as L16, not fixed | H22 |

### 14.11 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `share.unreadable` | That file couldn't be opened here. Share it again from the app it came from. |
| `share.partial` | Some of the shared files couldn't be opened, so they were left out. |
| `share.failed` | That share couldn't be opened here. Try sharing it again. |
| `share.invalid_link` | That link didn't come from this app's share sheet, so it was ignored. |

`src/words.ts` is kit-conventions §9's helper verbatim (`WORDS`, `WordKey`, `words`) plus
`errorWords(e: ShareError)`, which maps `ShareErrorCode` one-to-one (`invalid_share_url` → `share.invalid_link`).
`ShareError` lives in `src/words.ts` beside `errorWords` and follows §3's template (`name = 'ShareError'`, `(code, message, o?)`). The words test applies the D-P jargon
expression (`packages/statusbar/test/words.test.ts:21-24`, regex at `:22`). The Android adapter's `onError` carries the same sentences,
no URIs. Plugin build errors stay plain strings in `app.plugin.js`.

### 14.12 Coverage map of the published upstream surface

Mappings are [SOURCE-VERIFIED] against upstream; the kit's side is [PROPOSED].

**expo-share-intent 8.0.1 exports** (`esi/build/index.d.ts:1-5`):

| Upstream | Kit | Android | iOS |
|---|---|---|---|
| `useShareIntent(options?)` (`useShareIntent.d.ts:4-10`) | `useShareIntent(o?): ShareIntentState` | Adapted: same five fields and AppState rules; reads `ByokitShare` with seq; adds `errorCode`, `skipped`, `skipReasons` | Same logic, guarded by `isValidShareUrl` |
| `ShareIntentProvider` (`ShareIntentProvider.d.ts:12-15`) | Same signature; value `ShareIntentState` | Superset | Same |
| `useShareIntentContext` (`.d.ts:11`) | `(): ShareIntentState` | Plus additive defaults | Same |
| `ShareIntentContextConsumer` (`.d.ts:10`, deep import) | Exported | Same | Same |
| `ShareIntentModule \| null` (`ExpoShareIntentModule.d.ts:8-14`) | `ShareIntentModuleLike \| null` | Adapter over `ByokitShare` (upstream's is `null` once excluded) | Upstream wrapped: `getShareIntent` guarded, rest delegated |
| `parseShareIntent`, `getScheme`, `getShareExtensionKey` (`utils.d.ts:2-5`) | Re-export | Identical (key ignored, as `esik:191,195`) | Identical |
| 13 deep types (`ExpoShareIntentModule.types.d.ts:1-114`) | `export type` | Identical | Identical |
| `SHAREINTENT_DEFAULTVALUE`, `SHAREINTENT_OPTIONS_DEFAULT`, `parseJson` (not in `index.d.ts`) | Not re-exported; deep import still works | — | — |

**`ShareIntentOptions`** (`types.d.ts:13-38`), identical on both platforms: `debug`, `resetOnBackground` (default true),
`disabled` (default true on web; also makes reset a no-op), `scheme` (also the iOS URL check), `onResetShareIntent`.

**Native members:**

| Member | Kit Android adapter | Kit iOS |
|---|---|---|
| `getShareIntent(url)` (declared `string`, runtime void) | `Promise<void>`; runs `read()`; on `shared` emits `onStateChange{pending}` then `onChange{AndroidShareIntent}`; on `unreadable`/`failed` emits `onError` with words; the read starts on `modulesQueue`, IO is used only for the copy | Delegated only if `isValidShareUrl`; else rejects `ShareError('invalid_share_url')` |
| `clearShareIntent(key)` | `clear(lastEmittedSeq)`; key ignored | Delegated |
| `hasShareIntent(key)` | `hasPending()`: adapted to any unread share (upstream: cold captures only, `esik:195-197`) | Delegated (upstream always false) |
| `addListener`, `removeListener`, `removeAllListeners`, `emit`, `listenerCount` | The adapter's JS listener set | Delegated |
| `onChange` / `onError` / `onStateChange` | Object / `unreadable` and `failed` only, words, no URIs / `"pending"` only | Delegated |
| Launch and new intent | Store and emit `onShare` only; SEND, SEND_MULTIPLE, VIEW with `text/plain*` | — |

**Android `ShareIntentFile` fields:** `path` is always the private copy `cacheDir/byokit-share/<seq>/<name>`
(adapted); `contentUri` identical, informational; `fileName` null-safe, ≤255, falls back to the copy name;
`mimeType` never throws (14.9); `size` is bytes copied; `width`, `height`, `duration` preserved via `ShareMeta`, null on
failure; `meta.title` from `EXTRA_TITLE`, SEND text branch only.

**Unsafe upstream routes:**

| Route | Upstream | Kit |
|---|---|---|
| External-storage path, `_data` column | `esik:221-268`, `:231` | Never used |
| App's own provider copied to cache | `esik:264-265` → `:329-331` | `own_provider` |
| `N@authority` | not checked | `own_provider` |
| `file://` stream | `esik:69`, `:268` | `not_content` |
| Relaunch with copied grants | `esik:116-122` | Never relaunches |
| `!!` and unguarded calls | `esik:69,75,84,90` | Per-URI try/catch → `unreadable` / `too_large` |
| Mixed text and file branching | `esik:125-159` | Same branching (identical) |
| Malformed `Pair` in `files` | `esik:145` | Not reproduced; `parseShareIntent` filters it (`utils.js:95-96`) |
| iOS `url.fragment!` from any `<scheme>://dataUrl=` link | `ExpoShareIntentModule.swift:138-143`; `useShareIntent.js:40-42` | `isValidShareUrl` first; the check also blocks forged keys that would read other app-group entries |
| iOS `encodedData!` | `ExpoShareIntentModule.swift:207-208,211-212` | Not guardable from JS (L3) |

**Plugin `Parameters`**, all passed through verbatim, unknown keys included: `iosActivationRules`,
`iosShareExtensionName`, `iosAppGroupIdentifier`, `iosShareExtensionBundleIdentifier`, `iosHideView`,
`preprocessorInjectJS`, `disableExperimental`, `disableIOS`, `androidIntentFilters`, `androidMultiIntentFilters`,
`androidMainActivityAttributes` (launch-mode rule applies), `disableAndroid` (gates upstream's manifest mods only;
the settings exclusion applies regardless).

**@bacons/apple-targets 5.0.0:** `root`, `match` (any glob), `appleTeamId` passed through and drive
`ownedTargetNames`; plugin type → `AppleTargetsPluginOptions`; `Config`, `ConfigFunction` (`at/config.d.ts:64,113`),
`ExtensionStorage` and the iOS `ExtensionStorageModule` untouched (apps import them from upstream).

**@desklink/react-native 0.3.0:** JS surface (`.`, `./availability`) and `withDesklinkPointer` untouched, not
re-exported; apps that want them list desklink themselves. `desklink: true` only switches on the Gradle fix.

### 14.13 Tests and CI

Offline; picked up by `scripts/test.sh`'s package glob and `:byokit-share:testDebugUnitTest`.

- **C1 `exports.test.ts`:** freezes both entries' names; `rn.ts` minus `index.ts` is exactly `useShareIntent`,
  `ShareIntentProvider`, `useShareIntentContext`, `ShareIntentContextConsumer`, `ShareIntentModule`, `getScheme`,
  `getShareExtensionKey`, `parseShareIntent`. esbuild bundles `rn.ts` with stubs for `react`, `react-native`
  (`Platform.OS = 'android'`), `expo-modules-core` (records lookups, returns null), `expo-linking` and
  `expo-share-intent`; lookups are `['ByokitShare']`, `shareSupported === false`, and the Android adapter has exactly
  the eight `ShareIntentModuleLike` members `getShareIntent`, `clearShareIntent`, `hasShareIntent`, `addListener`,
  `removeListener`, `removeAllListeners`, `emit`, `listenerCount`.
- **C2 `portable.test.ts`:** export keys `['.', './app.plugin.js', './package.json']`; the browser bundle of
  `index.ts` has none of `expo-modules-core`, `expo-share-intent`, `expo-linking`, `react`, `react-native` and no
  `node:*`, and loads; in the RN bundle only `rn.ts` imports them.
- **C3 `words.test.ts`:** the jargon expression; every key `hook.ts` uses exists.
- **C4 `hook.test.ts`:** fake `NativeShare` logging calls in order with deferred `read()` promises; fake AppState
  `emit(s)`; fake `emitShare()`; a ~20-line stub React running effects synchronously that can replay StrictMode's
  effect, cleanup, effect.

  | Case | Steps | Expected |
  |---|---|---|
  | H1 subscribe first | mount | log begins `addListener('onShare')`, then `read` |
  | H2 triple fire | mount (r1), `emit('active')` (r2), `emitShare()` (r3); resolve r2 `{none}`, r3 `{seq:1,A}`, r1 `{seq:1,A}` | state A; one apply |
  | H3 out of order | r1 open; `emitShare()` → r2; resolve r2 `{seq:2,B}`, then r1 `{seq:1,A}` | state B |
  | H4 background reset vs new share | applied 1; `emit('background')`; `emitShare()` resolves `{seq:2,B}` | `clear(1)` once; state B; never `clear()` without an argument |
  | H5 reset vs stale same seq | applied 1; r open; reset; resolve `{seq:1}` | empty; `clear(1)` |
  | H6 reset vs newer | applied 1; r open; reset; resolve `{seq:2,B}` | state B |
  | H7 stale rejection | r1 open; r2 resolves `{seq:2,B}`; r1 rejects | state B, `errorCode null`; a lone rejection gives `failed` |
  | H8 unmount mid-read | r open; unmount; resolve; remount; read gives `current` `{seq:1}` | no apply after unmount; A after remount |
  | H9 `none` never clears | state A; read `{none}` | state A |
  | H10 disabled | mount `disabled`; reset; also on iOS with a share link | no `read`, no `addListener`, no `clear`, no `onResetShareIntent`; iOS: no `getShareIntent`, no `clearShareIntent` |
  | H11 `resetOnBackground:false` | applied 1; `emit('background')` | no `clear`; state A |
  | H12 inactive parity | applied 1; `emit('active')`, `emit('inactive')` | `clear(1)`; state empty |
  | H13 iOS valid URL | `os:'ios'`, extension-format URL; then mount with no link, the link arrives, `emit('background')`, `emit('active')` | `module.getShareIntent(url)` once; background → `clearShareIntent(key)`; active re-reads the **current** link (a repeat share) |
  | H14 reset callback | reset with a value / when empty | `onResetShareIntent` once / never |
  | H15 iOS invalid URL | prefix but no fragment, or a foreign key; and a URL without the prefix | `errorCode 'invalid_share_url'`, zero native calls; no call and no error |
  | H16 mapping | `unreadable`; files + skips; URL text; images, through the real `parseShareIntent` from `test/fixtures/esi-utils.js` | `'unreadable'` with words; `'partial'` with `error === null`; `weburl`; `media`; options passed to `parse` contain `debug` |
  | H17 Android adapter | emit, clear, listener members | `onStateChange{pending}` before `onChange`; `clearShareIntent` → `clear(lastEmittedSeq)`; listener members reflect the set; iOS `guardIosShareModule`: a forged link rejects `ShareError('invalid_share_url')` with no inner call, the extension link and the seven other members delegate |
  | H18 StrictMode | effect, cleanup, effect; read resolves `{seq:1,A}` | state A |
  | H19 late older after clear | r1 open; `emitShare()` → r2 resolves `{seq:2,B}`; reset; r1 resolves `{seq:1,A}`. (a) unmount + remount, fake `read` returns `{none}` (J11 contract). (b) unmount + remount **before** r1 resolves | `clear(2)` once; empty after r1; (a) empty after remount; (b) r1, resolving a higher seq, is ignored (`alive` false: nothing parsed), empty |
  | H20 reset then reject | applied 1; r open; reset; r rejects | empty; `errorCode null`; `error null` |
  | H21 reset / new-share order | (a) applied 1; reset; `emitShare()` → `{seq:2,B}`. (b) applied 1; reset; `emitShare()` → rejects. (c) applied 1; r open; `emitShare()` → r2 open; reset; r2 `{seq:2,B}`; r rejects | (a) B. (b) `failed`. (c) B, r's rejection ignored |
  | H22 reset before first delivery (L16) | mount, r1 open; reset; r1 resolves `{seq:1,A}` | no `clear` (applied 0); state A after the reset |

- **C5 `plugin.test.ts`:** `hideForeignExtensions` marks only foreign app-extensions; `assertNoOrphanSibling` throws
  when `actions` exists and owned `foo` is missing, passes on clean and complete projects; `restoreHidden` handles
  quoted and unquoted forms, is idempotent, leaves zero markers; `insertDesklinkGradle` on `fixtures/root.build.gradle`
  lands between the original lines 23 and 24, contains `enableCompileTimeOptimization = true`, is idempotent, throws
  on drift; `insertShareExclude` on `fixtures/settings.gradle` lands before `:32`, is idempotent, throws without
  `useExpoModules()`. Launch mode: `singleTop`, `standard`, `singleInstance`, `singleInstancePerTask` in options each
  throw; a `withAndroidManifest` mod registered after ours that sets `singleTop` makes the final assertion throw; the
  template value passes. Pass-through: an unknown key inside `shareIntent` reaches the upstream stub; an unknown
  top-level key throws; a duplicate plugin entry throws. `ownedTargetNames` with injected glob and loader:
  `match` `'*'`, `'w*'`, `'{a,b}'` each passed verbatim as `./targets/<match>/expo-target.config.@(json|js)`; a function
  config is called with `config`; no `type` skipped; `name:'actions'` → `actions`; dir `my_widget` → `mywidget`;
  precomposed `'Crème'` → `Crme`; `'Créme'` → `Creme`; a missing folder → empty set. Real-chain ordering:
  `config._internal.projectRoot` = repo root with the root `@expo/config-plugins` 57.0.9 (`package-lock.json:2326-2328`;
  the root lock has expo 57.0.26, while `examples/expo`'s has 57.0.25); one `withXcodeProject`
  before ours and one after, each adding a foreign target; `config.mods.ios.xcodeproj(...)` leaves both hidden.
- **C6 `url.test.ts`:** accepts the four extension forms with and without `?…`; rejects no fragment, an unknown
  fragment, a foreign key, another scheme, a scheme with regex metacharacters (escaped), and a null scheme.
- **C7 `ShareRulesTest.kt`:** `copyName` (traversal, empty, `..`, 300 chars, unicode); `reject` (`file`, `http` →
  `not_content`; `0@x.y` → `own_provider`; foreign authority and uid → null; own uid → `own_provider`; null uid →
  null (the read then fails and is caught)); `kind` (text branch with text → `shared`; files branch with 0 of 2 read
  → `unreadable`; nothing → `none`); `isTextBranch("text/plain; charset=utf-8")`, `isShare(VIEW, "text/plain; charset=utf-8")` true,
  `isShare(VIEW, "image/png")` false; `mime` fallbacks; `label` capping.
- **C8 `ShareInboxTest.kt`** (pure Kotlin; `folders` a `MutableSet<Long>`, `delete` removes, `wipeAll` clears and
  counts; J6 and J10 add folders **after** the first take, as `ShareReader` does):

  | Case | Steps | Expected |
  |---|---|---|
  | J1 take once | offer(A); take; take | (1,A), `inFlight={1}`; then null |
  | J2 last wins | offer(A); offer(B); take | (2,B) |
  | J3 out-of-order done | offer A; take; offer B; take; done(2,rB); done(1,rA) | `done(2)` true, `done(1)` false; `current()==(2,rB)`; `inFlight={}` |
  | J4 clear compares | after J3: clear(1), then clear(2) | first leaves (2,rB); second gives null |
  | J5 clear never touches pending | offer A; take; done(1); offer B; clear(1); clear(2); take | (2,B) |
  | J6 prune | seq 1 taken (wipe ran), folder 1, done(1); seq 2 taken, folder 2; seq 3 taken, folder 3; done(2); offer, take (seq 4) | before: last=2, `inFlight={3}`; after: {2,3} kept, 1 deleted; 4 never deleted |
  | J7 wipe once | folders {7,8}; offer, take, offer, take | `wipeAll` once; 7 and 8 gone before seq 1 |
  | J8 requeue | offer A; take; requeue; take | (1,A); with offer(B) before the requeue, it is ignored and take gives (2,B) |
  | J9 concurrency | 8 threads × 500 `offer()` behind a latch | 4000 unique seqs, max 4000 |
  | J10 superseded | J3 with folders 1, 2 added after their takes; offer, take | 1 deleted, 2 kept |
  | J11 watermark after clear | offer A; take; offer B; take; done(2,rB); clear(2); done(1,rA); offer C; take | `done(2)` true; `done(1)` **false**; `current()` null; take gives seq 3; folder 1 pruned. `clear(0)` no-op; `clear(5)` with nothing delivered makes a later `done(4)` false |

- **C9 `ShareMetaTest.kt`:** `orient` at 0, 90, 180, 270 and with nulls. `of()` runs only on a device (D6 R1). X6 is
  checked in review (faking `appContext` would need Robolectric).

**CI** (normal PRs and pushes): the `check` matrix (build, check, test, `smoke:pack` importing `app.plugin.js` under
plain Node with no `dist`, release lint); **`share-android`** in the `statusbar-android` shape,
added by WP2 as `npm ci`, prebuild `examples/expo`, `./gradlew assembleDebug :byokit-share:testDebugUnitTest`; WP4
adds its `node scripts/share-expo-smoke.ts --android-only` step and the **`share-ios-prebuild`** job (a macOS GitHub
runner, not the reserved Mac; prebuild only, D4 assertions via `--ios-only`), since WP4 creates that script. `examples/expo` uses `shareIntent: { disableIOS: true,
androidIntentFilters: ['text/*','image/*'], androidMultiIntentFilters: ['image/*'] }`: it has no `scheme`, so without
`disableIOS` upstream's checker would throw in the `react-native` and `push-ios` jobs.

### 14.14 Clean-install qualification

Runs twice: **(i)** against the `npm pack` tarball on the candidate SHA (local, permitted now); **(ii)** against
`@byokit/share@0.1.0` from the registry after main publishes. Heavy steps hold the home's heavy-jobs lock on fd 9
(never passed to adb or the emulator); HOME, AVD, Gradle and npm caches live in a throwaway dir.
Nothing in WP0-WP5 needs the reserved Mac, npm auth or a publish. Emulator use (the WP2 Q-app U1/T1 record and
WP5's D6) starts only after the home's supervisor emulator slot is granted, with one owned emulator.

Apps: **Q-app**, generated by `scripts/share-expo-smoke.ts` from the packed kit and the pinned stack, rendering
`<Text>{JSON.stringify({has, type, n, skipped, skipReasons, errorCode, text, w: files?.[0]?.width ?? null})}</Text>`;
every share-hook assertion runs here. **Crewhouse** at origin/main plus the 14.18 adoption diff, only for launch,
desklink, build and iOS-target checks (its share UI and watch need a paired home).

- **D1 adopt.** (i): apply the diff's other edits, `npm install --save-exact <packed tgz>`, assert every lock entry
  except `@byokit/share` and removed patch-only entries is unchanged (version and integrity), then
  `rm -rf node_modules && npm ci`. (ii): the diff as written, then `npm ci`.
- **D2 unmodified upstreams, before any Gradle run:** no `preinstall`/`install`/`postinstall`/`prepare` script, no
  `scripts/patch-modules.mjs`, no `patches`, no `patch-package`; for expo-share-intent@8.0.1, @bacons/apple-targets@5.0.0,
  @desklink/react-native@0.3.0, expo-modules-core@57.0.19 and expo-widgets@57.0.22: `npm pack` integrity equals the
  lock's, `diff -r -x node_modules` against `node_modules/<name>` is empty, and `cmp` against the verified tarballs.
- **D3 Android prebuild** (`npx expo prebuild --clean --no-install -p android`): exactly one `@byokit/share desklink`
  tag, between `expo-root-project` and `com.facebook.react.rootproject`, with `enableCompileTimeOptimization = true`;
  exactly one `@byokit/share exclude` tag, above `expoAutolinking.useExpoModules()`; the manifest has SEND and
  SEND_MULTIPLE; `getMainActivityOrThrow(readAndroidManifestAsync(M)).$['android:launchMode'] === 'singleTask'`.
- **D4 iOS prebuild** (Linux if `expo prebuild -p ios` works there [UNVERIFIED-RUNTIME], else the macOS CI job):
  `--clean` then a second plain prebuild; no `Target "ExpoWidgetsTarget" already exists`; `check-pbx.mjs`
  (`@bacons/xcode`) asserts distinct `ExpoWidgetsTarget`, `actions` and share-extension targets with
  `productName === name` and app-extension type, zero `byokit-hidden` markers, ExpoWidgetsTarget's
  `PRODUCT_BUNDLE_IDENTIFIER dev.crewhouse.app.ExpoWidgetsTarget` and `INFOPLIST_FILE ExpoWidgetsTarget/Info.plist`,
  actions' `INFOPLIST_FILE ../targets/actions/Info.plist` and bundle id `dev.crewhouse.app.widget`, the `actions`
  synchronized group owned only by `actions`, each `.appex` in Embed Foundation Extensions, the app depending on all three.
- **D5 Gradle** (`./gradlew assembleRelease :byokit-share:testDebugUnitTest`): the class set
  `node_modules/@desklink/react-native/android/build/**/kotlin-classes/**/DesklinkModule*.class` is non-empty, and
  `javap -c -p` over it finds zero matches of
  `lukmccall/pika/(IsIntrospectableKt\.isIntrospectable|IntrospectionOfKt\.introspectionOf)|should be replaced by the compiler plugin|reified type parameter`;
  `node_modules/expo/android/build/generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.kt` contains `io.github.umeranjum17.byokit.share` and not `expo.modules.shareintent`;
  post-Gradle `cmp` of every packed file of the five upstreams. The `javap` check stays [UNVERIFIED-RUNTIME] until a
  **negative control** (snippet removed → count above 0) passes; until then the D6 Crewhouse launch logcat is the gate.
- **D6 one owned emulator** (`android-36 google_apis x86_64`, AVD `byk-share-qual`, port probed from 5560-5584,
  serial checked with `emu avd name`; never touch other devices). Every case asserts alive and no `logcat -b crash`
  entry. `AUTH` comes from `dumpsys package $A | grep -o 'authority=[^ ]*'`. Q-app cases, cold (`am force-stop`
  first) and warm; U1-U3 send with `-t image/png`: U1 MediaStore image, no grant → `unreadable`,
  `skipReasons ["unreadable"]`; U2 `content://com.android.contacts/contacts` → `unreadable`; U3 missing media id →
  `unreadable`; U4 `file:///data/data/<app>/shared_prefs/x.xml` → `unreadable`, `n:0`,
  `["not_content"]`; U5 `content://0@<own authority>/x` → `own_provider`; U6 `content://<own authority>/<path>` →
  `["own_provider"]` (via `resolveContentProvider`); T1 text with a URL → `weburl`; T2 `text/plain` with text and an
  unreadable stream → text, `skipped 0`; T3 `image/png` with text and an unreadable stream → `unreadable`, `text null`.
  Readable via DocumentsUI and uiautomator, because `am`'s grant does not reach `EXTRA_STREAM` [UNVERIFIED-RUNTIME]
  and `am` cannot build an `ArrayList<Uri>`; images come from `screencap` plus a media scan: R1 one screencap image → `n:1`, `media`, `w` = screencap width; M1 two
  images (plus one unreadable if offered) → `n:2`, mixed variant `partial`, `skipped 1`. Observational: W1 two warm
  SEND texts back to back → the second; W2 SEND while resumed → updates through `onShare`; W3 launch, then share from
  DocumentsUI → exactly one `MainActivity`, in the original task; T-replay (cold T1, HOME, `am kill`, relaunch from
  recents and `am start`) and T-recreate (`always_finish_activities 1`, then `font_scale 1.3` after a reset; both settings
  restored afterwards) → no second delivery; a second delivery is recorded and opens the L9 follow-up; a crash fails the run. Crewhouse: launch
  after `pm clear`, 8 s, no `reified type parameter`; U1 and T1 cold (capture only); open
  `crewhouse://screen?bot=qual&watch=1`, HOME 35 s, relaunch. iOS and Android evidence in separate PR sections.
- **D7 iOS on a Mac: DEFERRED** (Mac reserved): `pod install`, unsigned `xcodebuild`, simulator share of a photo and
  text, a forged `crewhouse://dataUrl=x` (no crash, `invalid_share_url`), the Controls widget, the Live Activity.

**Pinned qualification matrix.** Anything not IN is not claimed.

| Platform | Case | App | Build | Status |
|---|---|---|---|---|
| JVM (Linux) | ShareRulesTest, ShareInboxTest J1-J11, ShareMetaTest | — | `:byokit-share:testDebugUnitTest` | IN |
| Node 22, 24 | exports, portable, words, url, plugin, hook H1-H22 | — | `npm test` | IN |
| Android | D1 lock check, D2 integrity and unmodified upstreams | Crewhouse, Q-app | tgz install, then `npm ci` | IN |
| Android | D3 incl. `.MainActivity` singleTask | Crewhouse, Q-app | `expo prebuild --clean -p android` | IN |
| Emulator `android-36 google_apis x86_64` only | U1-U6, T1-T3, cold and warm | Q-app | assembleRelease | IN |
| same | R1, M1 | Q-app | release | IN; automation [UNVERIFIED-RUNTIME], manual capture as fallback |
| same | W1, W2, W3 | Q-app | release | IN |
| same | T-replay, T-recreate | Q-app | release | IN as observation |
| same | launch, U1/T1 capture, desklink deep link plus HOME 35 s | Crewhouse | assembleRelease | IN |
| Android | D5 bytecode with negative control, package list, post-Gradle `cmp` | Crewhouse, Q-app | assembleRelease | IN |
| iOS | D4 pbxproj | Crewhouse | Linux prebuild or macOS CI | IN (prebuild only) |
| — | D(ii) registry rerun | both | release | LATER (after npm publication) |
| iOS | D7 | Crewhouse | — | OUT (Mac reserved) |
| Android | debug-variant runtime, StrictMode on a device, other API levels, physical devices, other OEM share sheets or senders beyond `am` and DocumentsUI, split-screen beyond W2 | — | — | OUT |
| Android | Crewhouse share composer, watch stream, landscape hold, reconnect | Crewhouse | — | OUT (needs a paired home) |
| Android | live >100 MB file (L10), stalled provider or crafted video (L11), dev reload or cancel (X7), share during load (L1, X15) | — | — | OUT live; only the J/H cases listed |
| Any | expo-share-intent ≠ 8.0.1, apple-targets ≠ 5.0.0, desklink ≠ 0.3.0, Expo ≠ 57.0.25, RN ≠ 0.86.3 | — | — | OUT (unqualified) |
| Android | Kotlin ≥ 2.2 (L8); muxr; Ownvoice | — | — | OUT |

Pinned stack: expo 57.0.25, RN 0.86.3, react 19.2.3, expo-share-intent 8.0.1, @bacons/apple-targets 5.0.0,
expo-widgets 57.0.22, @desklink/react-native 0.3.0, react-native-webrtc 124.0.8, expo-linking 57.0.11,
expo-constants 57.0.19, expo-modules-core 57.0.19, @expo/config-plugins 57.0.9. Crewhouse's lock matches every pin;
`examples/expo` is on expo 57.0.25.

### 14.15 Limits

| ID | Platform | Limit | Status |
|---|---|---|---|
| L1 | Android | A warm share arriving while the app is still loading is dropped by Expo before any listener sees it; upstream behaves the same | [SOURCE-VERIFIED `expo/ReactActivityDelegateWrapper.kt:306-308`]; RN fall-through [UNVERIFIED-RUNTIME] |
| L2 | Android | A committed `android/` that never runs prebuild gets neither the settings exclusion nor the launch-mode assertion; the README tells bare apps to add `expo.autolinking.android.exclude: ["expo-share-intent"]` and keep `singleTask` | — |
| L3 | iOS | Upstream's `encodedData!` on undecodable app-group data cannot be guarded from JS; only the app's own extension writes there | [UNVERIFIED-RUNTIME] |
| L4 | iOS | A third-party precedence-0 mod reading extension targets from disk does not see hidden ones; a `withBaseMod` `xcodeproj` post-action registered after ours can add a foreign target after the hide | [UNVERIFIED-RUNTIME] |
| L5 | iOS | Foreign watch and App Clip targets are not hidden | [PROPOSED] |
| L6 | iOS | apple-targets sets `DEVELOPMENT_TEAM` and `TargetAttributes` on all targets (`at/with-xcode-changes.js:70-95`); unchanged upstream behaviour | [SOURCE-VERIFIED] |
| L8 | Android | desklink's `kotlinOptions { jvmTarget }` (`dl/android/build.gradle:13`) may warn or fail on Kotlin ≥ 2.2; only a desklink release fixes it. The Kotlin in use (Expo default 2.0.21, real value from RN 0.86.3's catalog) is unknown | [UNVERIFIED-RUNTIME] |
| L9 | Android | An old share may be offered again, or show as unreadable, after process death (system recreates with the original SEND) or in-process recreation without the CONSUMED copy (X17). Never a crash | [UNVERIFIED-RUNTIME]; T-replay, T-recreate. `ponytail:` if either reproduces, add a persisted fingerprint of the last consumed share; ceiling: sharing the identical item again is ignored once |
| L9b | Android | A share taken but unfinished when the process dies is lost (X13) | [PROPOSED] |
| L10 | Android | A file over 100 MB is skipped as `too_large` | [PROPOSED] |
| L11 | Android | A stalled provider, or a crafted video in MediaMetadataRetriever, blocks only our IO coroutine; no per-URI timeout (a blocking read cannot be interrupted) | first part [PROPOSED]; second [UNVERIFIED-RUNTIME] |
| L12 | iOS | Adding an apple target to a project that already has one needs `prebuild --clean`; the sibling guard enforces it | [PROPOSED] |
| L13 | Android | One pending slot, last wins (X5); upstream parity (`esik/ExpoShareIntentReactActivityLifecycleListener.kt:18`) | `ponytail:` single slot; a queue when a consumer needs bursts |
| L14 | Android | A share's files stay until the next `take()` after it stops being the delivered share, or a process restart; consumers copy or upload before `resetShareIntent` | [PROPOSED] |
| L15 | Android | After `resetShareIntent(false)`, a remount shows the share again via `current()`; upstream had nulled its singleton (`esik:187`) | [PROPOSED]; disclosed parity gap |
| L16 | Android | A reset clears only shares JS has applied; a share pending or in flight at reset time, including before the first delivery, is delivered afterwards (X20). Reset races are ordered, not all suppressed | [PROPOSED]; H22 |

L7 is not used. Safeguards kept by design (verified only when D6 U1-U6, T1, T2, R1, M1, W1-W3, T-replay and T-recreate
pass): an unreadable share, cold or warm, does not crash; only the sender's grant is used; the app's own files cannot
be reached through a share (`file://`, `N@authority`, own authorities); nothing is read on the UI thread and
`modulesQueue` is held only for the take; `clear` never wipes a newer share; a cleared share never returns from a
late older read; a stale rejection never overrides a reset; `singleTask` is enforced.

### 14.16 Work packages

Order: WP0 → WP1 → WP1r → (WP2 ∥ WP3) → WP4 → WP5 → WP6 release-prep PR → [npm publication hold lifts] → main
publishes → consumer adoption. Root dispatches after this section lands. Source pushes, PRs, CI, green merges and the
release-prep PR are permitted throughout; only the actual npm publication waits.

| WP | Content | Acceptance | Deps | Builder |
|---|---|---|---|---|
| WP0 | This section | Lands on main | — | Opus 5.5 medium (docs) |
| WP1 | Scaffold rest (README, LICENSE, `expo-module.config.json`: landed with the spec PR, as are `types.ts`, `words.ts`, `url.ts`, `index.ts` and the root build wiring); README rows and isolation sentences; `files` incl. `CHANGELOG.md`; CHANGELOG `## Unreleased` with the 14.17 lines; C1, C2, C3, C6 | `npm run build && npm run check && npm test`; pack smoke; tsc resolves the deep type paths [UNVERIFIED until run] | WP0 | Pi Sol 6.1 medium |
| WP1r | Append `"share"` to `canonical` at `scripts/release.ts:608` (after `"push"`); nothing else. No lint change is needed: a SECURITY:/FIX: bullet on a first release passes; while `private` the bumped-version section check is skipped (`:356-358`); nothing depends on share, so no cascade (`:206-266`); the change is cosmetic, as unlisted packages already rank last (`:609-612`) | `npm run release -- lint --base origin/main` green on the WP1r branch; the `canonical` diff is the one token | WP1 | Pi Sol 6.1 medium |
| WP2 Kotlin | 14.9, C7-C9, `examples/expo` wiring (`disableIOS: true`, 14.4), the `share-android` CI job without the smoke step (14.13) | Local `share-android` commands green under the lock; Q-app U1/T1 recorded | WP1 | Pi Sol 6.1 medium |
| WP2 hook | `hook.ts`, `adapter.ts`, `rn.ts` (hook, Provider, context, Consumer), C4 H1-H22, `examples/expo/ShareDemo.tsx`: **landed with the spec PR** | `npm test` | WP0 | Opus 5.5 medium |
| WP3 | `app.plugin.js` (14.6), C5 | `npm test`; `node -e "import('./packages/share/app.plugin.js')"` with no Expo installed | WP1 | Pi Sol 6.1 medium |
| WP4 | `scripts/share-expo-smoke.ts`: packed kit, pinned stack, Q-app with the state `<Text>` and a `targets/actions` widget, D3/D4 assertions, `--android-only` / `--ios-only`, captures `withwidgets.pbxproj`; the smoke step in `share-android` and the `share-ios-prebuild` job | Passes locally under the lock; iOS part on Linux or the macOS CI job | WP2, WP3 | Pi Sol 6.1 medium |
| WP5 | D1-D6 (i) on the Q-app and Crewhouse incl. U6, W1-W3, T2/T3, T-replay, T-recreate, R1 metadata, the D5 negative control | Every IN row green, evidence attached; no release line ships as a claim until its gate is green | WP4 | Pi Sol 6.1 medium |
| WP6 | Release-prep PR (14.17) | 14.17, including on the release branch after "drop `private`": `npm run release -- prepare share=0.1.0 --dry-run` shows `share=0.1.0`, no pins, no cascade | WP5 | prep: this work; publish and trust: main |

### 14.17 Release

`packages/share/CHANGELOG.md` `## Unreleased` holds these lines (WP1 creates the file; lint requires it and its
`files` entry, `scripts/release.ts:317-320,328-329,341-342`; the "do not edit CHANGELOG.md" rule targets existing
packages, `CONTRIBUTING.md:121-124`). Format per `CONTRIBUTING.md` "Changelog and release notes":
exactly `- SECURITY:` / `- FIX:` (a bold or `Fix:` prefix parses as a plain bullet), wrapped lines indented two
spaces, SECURITY first. Later WP2-WP5 PRs may add `changes/` fragments; prepare folds them in
(`:495-496`) and deletes them (`:545`). `FIX:` is right on a first
release because consumers of the unmodified upstreams hit these bugs today, and `notes --since` relays only the SDK
changelog; the consumer PR copies the lines verbatim, it does not replace them.

```
- SECURITY: On Android a share can no longer make the app read its own private files: content URIs served by
  the app's own providers (including the `N@authority` form) are refused; that item is left out with
  `skipReasons` `own_provider`, and the share reports `errorCode: 'unreadable'`, or `'partial'` when other
  files were read. expo-share-intent 8.0.1 copies such content into the cache and hands its path to JS.
- FIX: Sharing a file the app may not read, or a `file://` URI (refused as `not_content`), no longer crashes
  the Android app, cold or warm; that file is left out, and the share reports `errorCode: 'partial'` with the
  readable files, or `'unreadable'` when none could be read.
- FIX: On iOS a link of the form `<scheme>://dataUrl=…` that did not come from the app's own share extension
  is ignored and reported as `errorCode: 'invalid_share_url'` instead of reaching expo-share-intent's native
  module, which can crash on it.
- FIX: `appleTargets` keeps @bacons/apple-targets 5.0.0 from taking over another plugin's extension target
  (such as expo-widgets' `ExpoWidgetsTarget`) on a fresh iOS prebuild. Checked by prebuild only.
- FIX: `desklink` builds @desklink/react-native 0.3.0 as an Expo module, so it no longer crashes at launch on
  Expo SDK 57, without a postinstall patch.
- Receive shared text and files with `useShareIntent`, `ShareIntentProvider` and the rest of
  expo-share-intent's public API; reads run off the main thread and image and video sizes are still reported.
```

Every line describes [PROPOSED] behaviour; WP6 does not run prepare until each gate is green:

| Line | Gate |
|---|---|
| SECURITY | D6 U5, U6 plus `ShareRulesTest` |
| FIX unreadable | D6 U1-U4 cold and warm, M1 (mixed variant for `'partial'`) |
| FIX iOS link | H15 plus `url.test.ts`; the no-crash part stays [UNVERIFIED-RUNTIME] until D7, so the line says only "instead of reaching" |
| FIX appleTargets | D4 |
| FIX desklink | D5 `javap` with its negative control, plus the D6 Crewhouse launch case |
| Final bullet | D6 R1 and C1 |

Mechanics: nothing depends on share, so there is **no cascade** (`:206-266`). While `private`, only the
bumped-version section check is skipped (`:356`); a non-empty `## Unreleased` is still required when shipped files
change (`:359-360`), which the WP1 lines satisfy. WP6, following precedent 7a692353 (#231):
- push first, with CI green including `share-ios-prebuild`;
- on a named release branch (prepare refuses detached `HEAD` and `main`, `:470`, and a dirty tree, `:471`), commit
  "chore(share): enable first public release" (drop `private`; prepare refuses private packages, `:481`), then
  `npm run release -- prepare share=0.1.0`. An equal version is allowed while it is not on npm (`:487-490`);
  Unreleased must have bullets (`:501-503`). Prepare rolls Unreleased, SECURITY:/FIX: lines included, into
  `## 0.1.0 (<date>)`, and lint passes after it (`:356-358,754-755`). Merge on green.

**Publishing belongs to main**, the sole publisher and npm-trust owner (hold **byk-npm-trust**): main runs
`npm run release -- publish` on the green main head with its own npm session, once the npm404 publication hold
(main285) lifts, and adds `@byokit/share` to its trusted-publishing scope (trust for a new name can likely be set only
after that first publish [UNVERIFIED, npm behaviour]). This work never runs `npm login`, `npm trust` or a
`release.yml` dispatch, and makes no second login or passkey request. Done means: `npm view @byokit/share@0.1.0`; tag
`share-v0.1.0` whose GitHub release notes show the SECURITY:/FIX: lines (`release.ts:688-690`); D(ii) green; trust status reported as main reports it.

### 14.18 Consumer adoption (handoff, not done here)

Consumers change only through their own homes, after `@byokit/share@0.1.0` is on npm. The Crewhouse diff, handed
over as written:
- `package.json`: remove `scripts.postinstall`; add `"@byokit/share": "0.1.0"` (exact; D1 (i) substitutes the
  packed tarball); pin `"expo-share-intent": "8.0.1"`. No autolinking exclude (prebuild runs). Delete
  `scripts/patch-modules.mjs`, then `npm install`.
- `app.json`: replace the `expo-share-intent` and `@bacons/apple-targets` entries with
  `["@byokit/share", { "shareIntent": { "androidIntentFilters": ["text/*","image/*"], "androidMultiIntentFilters": ["image/*"], "iosActivationRules": { …unchanged… }, "iosShareExtensionName": "Send to Crewhouse" }, "appleTargets": {}, "desklink": true }]`;
  keep `expo-widgets` and `./plugins/shortcuts.js`.
- `App.tsx:27` imports from `'@byokit/share'`; `:662-668` stays (same hook shape). Optionally show the
  `share.partial` sentence when `errorCode === 'partial'`.
- Behaviour changes [PROPOSED until M1]: a partial multi-share now delivers the readable files; files stay until the
  next share after a reset (L14).
- The PR body copies the SECURITY:/FIX: lines verbatim, each with its gate evidence. Acceptance: Crewhouse CI plus
  the D6 Crewhouse rows rerun on the merged SHA.

muxr (SDK 55, desklink 0.3.0 unpatched) needs nothing now; inferred from expo-modules-core 55's changelog never naming
Pika [UNVERIFIED-RUNTIME]. On SDK 57 (or 56, unverified) it adds `["@byokit/share", { "desklink": true }]`. Ownvoice
needs nothing.

### 14.19 Notes for builders

- The spec PR also lands the frozen TypeScript surface and the WP2 JS layer, so builders share exact interfaces:
  the WP1 builder's scaffold and `src/{types,url,index}.ts`, `src/words.ts` in §9 form with `ShareError` (§3), the
  WP2 `src/{hook,adapter,rn}.ts`, `test/hook.test.ts` (H1-H22) with `test/fixtures/esi-utils.js`, the root build,
  check-exclude and `fix-words-dts.cjs` wiring, and `examples/expo/ShareDemo.tsx` (`EXPO_PUBLIC_SHARE_DEMO=1`). Later
  work packages build on these and change none of their signatures without a spec change.
- Where the source report disagreed with itself, this section follows its revision 2.2: limits run L1-L16 (its WP0
  row still said L1-L15), races X1-X20, tests J1-J11 and H1-H22. The report did not place `share` in the canonical
  order; 14.17 appends it after `push`.
- The snake_case members of `ShareErrorCode` and `ShareSkipReason` and the word key `share.invalid_link` differ from
  [kit-conventions.md](kit-conventions.md) §2 (kebab codes) and §9 (camelCase keys). They are **binding** under its
  Precedence rule: the 14.17 release lines quote `'invalid_share_url'`, `own_provider` and `not_content` verbatim.
  Words follow §9's helper and §3's error template exactly (14.7, 14.11); where the report indexes `words[key]`,
  read `words(key)`.
- The report's WP1r acceptance (bare `release -- lint`, and a `--dry-run` prepare while `private`) cannot pass:
  lint needs `--base` (`scripts/release.ts:731`) and prepare refuses private packages (`:481`), as the report's own
  WP6 row says. 14.16 moves the plan check to WP6.
- WP2 Kotlin's "Q-app U1/T1 recorded" comes from the report, but the Q-app generator is WP4. A WP2 builder without
  it stops and asks root whether `examples/expo` stands in.
- Open fallback, not adopted (F8): if D6 W1, W2 or warm T1 fail on the RN 0.86.3 `onNewIntent` hop, capture warm
  shares in `ShareListener.onNewIntent` (`expo/ReactActivityDelegateWrapper.kt:310-311`) with the module emitting
  `onShare` through a callback registered in `OnCreate`. That is a spec change first.
