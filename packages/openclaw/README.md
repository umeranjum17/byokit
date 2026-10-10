<h1 align="center">@byokit/openclaw</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/openclaw"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/openclaw?style=flat" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
</p>

<p align="center"><strong>The OpenClaw runtime kit: one object that runs the pinned engine for your app.</strong><br/>
It drives the pinned OpenClaw engine (<code>openclaw@2026.8.1</code>, protocol 4) through one kit object. The
aggregator's full operator surface stays available as typed pass-through calls (<code>call</code> for every operator
method, <code>callDynamic</code> for the rest), with plain-words helpers for members, sign-in, runs, approvals and
config. For apps built on OpenClaw, where the engine holds the subscriptions.</p>

## Install

```sh
npm install @byokit/openclaw
```

[![npm](https://img.shields.io/npm/v/@byokit/openclaw?style=flat&label=)](https://www.npmjs.com/package/@byokit/openclaw) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=openclaw-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

Node 22.18 or later. The kit brings the engine with it: the first `start()` installs the pinned `openclaw@2026.8.1`
under your `stateDir` (a few minutes, needs the network once), and later starts run from there. For a whole app, a
phone page that pairs, signs in with ChatGPT, runs and answers approvals, see
[`examples/openclaw-kit`](../../examples/openclaw-kit).

## Bundled engine provenance

`engine/patches.json` declares the exact upstream tarball integrity, commit, unique edits and before/after file
hashes. The Gateway Workshop review patch writes content-free, durable usage facts only when the kit sets its
accounting environment. The separately bundled worker and all other detached kinds remain uncovered.
The Claude CLI route also uses the bundled [Tooling-name correction](../../docs/runtime-kits.md#516-bundled-engine-patches-and-engine-started-usage);
apps do not need consumer tool aliases.
The full upstream MIT notice ships in [engine/OPENCLAW-LICENSE](engine/OPENCLAW-LICENSE).

Each `prepare()` verifies the **entire** selected engine tree, including unpatched files. The kit installs stock
into a private temporary tree, clones verified stock for a changed set, then publishes read-only sibling trees
under `<engineDir>.sets/`. It never patches, reinstalls or deletes the base `<engineDir>/node_modules` or any
published set, even when a shared Gateway is running. `doctorContext().entry` points at the selected set after
prepare; `<stateDir>/openclaw/engine-set` records that selection. `kit.state.patchSet` is its content-addressed
patch id (`null` after a provenance failure); a refusal is `why: 'engine-patch'` with a typed error code.

Rollback selects a verified stock or older set; known sets and offline clones require no registry access.
Drift leaves the old bytes untouched and builds a replacement sibling; rebuilding stock may need the registry.
When an install or post-build verification fails, the kit retains a size-capped, environment-free diagnosis at
`<stateDir>/logs/engine-install-drift.json` — the first failed root-manifest or package check (path, expected vs
actual version, or the read error), the npm path and version, and the npm stderr tail — before the failed temporary
tree is deleted. Pre-change kits still run the untouched base install. No garbage collection: each retained set can occupy about
889 MB on this pin (reflinks may reduce physical storage). Whole-tree verification also adds preparation I/O;
read-only modes protect against accidental writes, not a malicious host app that owns the files.

## Quickstart

Start the engine, add a member, sign them in with a subscription, run a message (typechecked; running it installs
the pinned engine and needs a real ChatGPT sign-in, so it is not run here):

```ts
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({ stateDir: './openclaw-state', config: { plugins: { allow: ['openai'] } } });
await kit.start(); // installs the pinned engine under stateDir, spawns it, connects

await kit.ensureMember('umer');
const controller = new AbortController(); // call controller.abort() when Umer cancels
const signIn = kit.signIn('umer', {
  authChoice: 'openai-device-code', via: 'code', signal: controller.signal,
}, (view) => { if (view.code) console.log('Open', view.url, 'and enter', view.code); });
const signedIn = await signIn.done;
if (signedIn.state !== 'done') {
  console.log(signedIn.error); // plain words; why is 'expired' or 'declined' on expiry or cancellation
  await kit.stop();
  process.exit(0);
}

const end = await kit.run(
  { member: 'umer', sessionKey: 'agent:umer:main', message: 'Say hello.' },
  (e) => { if (e.type === 'text') console.log(e.text); },
);
console.log(end);
await kit.stop();
```

For a host run that may be retried after a lost connection, mint and persist an action key **once**, then reuse
that key and the same run inputs:

```ts
import type { OpenClawKit } from '@byokit/openclaw';

async function dispatch(kit: OpenClawKit, taskId: string, attempt: number, message: string) {
  const actionKey = `task:${taskId}:attempt:${attempt}:${crypto.randomUUID()}`;
  // Persist actionKey with this dispatch before calling; a new action/attempt gets a new nonce.
  const spec = { member: 'umer', sessionKey: `agent:umer:task:${taskId}`, message, idempotencyKey: actionKey };
  return kit.run(spec); // reconnect retry: kit.run(spec), not another dispatch()/new actionKey
}
```

Omitting `idempotencyKey` preserves a fresh UUID per call. Supplied keys are non-empty strings passed unchanged.
**Not exactly-once:** engine 2026.8.1 caches `agent` keys gateway-wide, across agents and sessions, without comparing
inputs. A collision silently returns the first run's result/error; a task id alone is not a safe key. Reconnects
retain the in-memory cache; engine process restarts lose it. Inactive entries expire after five minutes (60-second
cleanup tick), or earlier under the 1,000-entry cache limit; active and pending accepted runs are exempt.
An in-flight replay waits on the original run but cannot replay old events or subscribe to its final response:
text may be a capped 4096-character terminal snapshot, usage stays absent, and capped JSON may fail schema
validation. A completed cached replay can return full text/usage. The helper never sends another `agent` request
just to read a final result: on cache eviction that would start another run. Apps still own durable task/effect
recovery. Typed `kit.call('agent', ...)` remains exact upstream pass-through. Details and real-engine proof are
in [the run contract](../../docs/runtime-kits.md#58-runs-members-and-streams).

Every code route shows its code the same way: a waiting view carries `code`, `url`, `expiresAt` (epoch ms, when
the engine gives a lifetime) and the engine's own instructions in `message`, including routes whose pinned engine
prints the code only into a note's text.
Device approval can take longer than two minutes. The kit waits through the engine's advertised code lifetime
(`expiresInMinutes` on the pin, or `expires_in` seconds when supplied), including progress pulls. If the engine
supplies no lifetime, it owns the deadline. Ordinary wizard requests keep their 120-second timeout.
`signIn.cancel()` or the optional caller `signal` cancels this sign-in and releases its wizard session.
`done` returns a typed `SignInView`: `why: 'expired'` for an expired code, `why: 'declined'` for cancellation,
with a plain sentence in `error`. `SignInOptions` is exported from the host entry.

For any sensitive wizard text step, pass the secret once through the same
`signIn.paste(token)` channel and clear the input afterwards. The kit displays only a fixed entry label;
subsequent wizard errors, links and codes are withheld, and failures use a fixed message rather than
engine text that could echo the token. It is sent only as this member's wizard answer, never in views,
results or kit logs. Ordinary browser paste and typed `kit.call('wizard.next', …)` pass-through are unchanged.
API key (billed per use) entry still requires explicit selection; there is no subscription-to-key fallback.

To choose which of a member's accounts a run uses, pass `model: 'provider/model'` in the run spec (for example
`'openai/gpt-5.1'`, where `provider` is an id `kit.providers(member)` lists). That provider is the one called and billed for this run only, with no fallback to another
provider or model. If the member isn't signed in to it, the run ends `{ ok: false, kind: 'signed-out' }` and the
engine is never called. Leave `model` out to keep the engine's own choice. A specific sign-in (`@profile`) can't be
picked per run: the pinned engine may still switch to another sign-in for the same provider.


For an owner who explicitly offers keys, `kit.addKey('ana', { authChoice: 'openai-api-key', apiKey })` returns
`ok`, `invalid` or `not_included`. Label the option **API key (billed per use)**. Select only `routes()` rows with
`keyEntry: true`; API rows remain `offer: false`. Each route also carries its engine `revision`, `checked` date,
label and key error word names. Submit the input directly, clear the field afterwards, and never log or save it in
app state. The kit never returns engine key-check errors or the key. [`@byokit/ui/kits`](../ui/README.md) supplies `keyStep`/`keyView`
for entry, checking, success and failure states, using the kit's `key.*` words.

To use the saved key for one run, pass `auth: 'apiKey'`. The key lives in the member's separate
`byokit-key-<member>` agent and workspace, with `copyToAgents: false` and only that key in its local auth order.
Its selected model is used; omit `model` or pass that same model. Key runs have separate history. To steer or stop
one, pass `{ auth: 'apiKey' }` to `steer` or `abort` too (the device helpers accept the same option).
Ordinary runs never enter the key agent, even when the subscription is resting. This agent boundary is necessary
because the engine's profile pins can rotate. The `byokit-key-` member prefix is reserved. Adding another key
replaces the previous key; a failed replacement leaves this option unavailable. If the normal agent already has
an API key added through pass-through calls, `addKey` returns `invalid` and leaves that key untouched.

`OpenClawKit.abort` always returns a Promise. Await it or attach `.catch(...)`: an unavailable engine, transport
failure or invalid API-key session key rejects with the original error, never throws synchronously, and is not
reported as successful cancellation. Healthy cancellation ends the run as defined in
[the run contract](../../docs/runtime-kits.md#58-runs-members-and-streams).

A run spec also takes `system`, `images` (`{ data, mimeType }[]`), `thinking` and `tools`, a subset of the app tools
(`KitOptions.tools` names) this run may call; any other app tool is refused at the gate before `ToolHost.gate` sees
it. Run events report `started` when the Gateway accepts the request (not when it finishes), and forward
actual `thinking` progress as `{ type: 'thinking', tokens }`. Silent routes invent no progress; cached replays
without a new accepted frame emit no `started`. Handle these frames explicitly rather than treating every
non-text/tool frame as an end.
Live readiness reads (`providers`, `signedIn`, or device `state()`) prepare admission for the next run, avoiding
redundant checks while authority remains reusable. `providerStatus(member)` returns `undefined` for unknown
status rather than `[]`; `providers` maps unknown to `[]`, and `signedIn` to `false`.
See [the admission contract](../../docs/runtime-kits.md#58-runs-members-and-streams) for lifetime, expiry,
file witnesses, invalidation and remote-revocation limits.
Tool events carry the engine's call `id`, the `input` on `start` and the `output` and `error` on `end`. A run that
ends ok carries `usage` (the engine's token total for the run, and `costUsd` when it priced the model) and
`planWindow` (the subscription's quota windows as the engine last read them), each only when the engine reports it.
`openclawDevice(link).run(message, o)` takes the same options over the link, and `state()` adds the kit and engine
versions and the providers the device's member is signed in to.

### Observed per-agent ledger usage (not complete engine spend)

```ts
import { readAgentUsage } from '@byokit/openclaw/usage'; // portable; kit or device client
import type { OpenClawKit } from '@byokit/openclaw';

async function showUsage(kit: OpenClawKit) {
  const reading = await readAgentUsage(kit, 'umer', { startDate: '2026-10-02', endDate: '2026-10-02' });
  // Caller decides whether partial coverage is acceptable; never turn unavailable totals into zero.
  if (reading.state === 'available') console.log(reading.totals);
}
```

`agentUsageOf(raw, member, window)` also normalizes an existing explicitly agent-scoped UTC response. Full raw
RPC data is retained; existing typed `call` pass-through is unchanged. Windows are inclusive UTC calendar days.
`receivedAt`, result-assembly `updatedAt` and `cache.refreshedAt` are separate: receiving cached data does not
refresh it. The engine response cache lasts 30 seconds; pending/stale/unknown data leaves `totals` absent.
An absent agent row is unavailable, not proof of zero usage. Reset/deletion/retention can reduce counters.

**Coverage is always `retained-transcripts-only`.** Stock 2026.8.1's detached Skill Workshop reviews are omitted
from its ledger; actual crash-recovery resumes and threshold memory flushes are counted through persisted
transcripts, never through a second side total. This reader cannot enforce a complete all-turn budget. The app owns budget,
share and unavailable/partial-data policy. Do not add run results to these totals: they already overlap. Engine
cost fields are price counters, not a bill or subscription quota; zero cost with `missingCostEntries > 0` is
unknown cost, and tokens never establish subscription plan weights. No billing conversion is performed.

### Day readings including Gateway Workshop reviews

```ts
import { readAgentDayUsage } from '@byokit/openclaw/day-usage'; // also exported by . and ./device

async function dayBudget(kitOrDevice: Parameters<typeof readAgentDayUsage>[0]) {
  const startMs = Date.parse('2026-10-02');
  const day = await readAgentDayUsage(kitOrDevice, 'umer', {
    startMs, endMs: startMs + 86_400_000 - 1, mode: 'utc',
  });
  return day.knownTotalTokens !== undefined && day.knownTotalTokens > 190 ? 'over'
    : day.complete ? 'under' : 'unknown'; // policy is the caller's
}
```

This additive reader leaves `readAgentUsage` unchanged. Coverage is **retained transcripts + Gateway Workshop
reviews**, not all engine spend. Reviews crossing midnight land on their ended day. UTC and IANA
`{ mode: 'time-zone', timeZone: 'America/New_York' }` apply to both terms; Gateway-local zones are refused.
The engine transcript RPC reports calendar days: use complete inclusive days in that zone. A partial-day window
leaves the transcript term unavailable rather than inventing a millisecond total.

Review facts carry only run/session/agent/model/profile ids, times, outcomes and reported tokens. Their cost is
always `missing`; billing stays `unknown` without verified selected-route identity, never inferred from a provider.
Missing usage is `reported-missing`, a live start is `pending`, and an old boot's start is `interrupted`; none means
zero. Facts deduplicate by charge and phase. `knownTotalTokens` is the sum of reported counters only and is absent
when either source is unavailable. `complete: false` is a budget-policy unknown, not permission to proceed.

The append-only `openclaw/usage/` ledger survives session reset, engine replacement and restart. Start records are
fsynced before spawning, using an accounting UUID separate from unchanged pid/start-time ownership. Month attempt
counters and failures survive clean stop; holes, missing counters, corrupt lines and overlapping crash boots keep
windows incomplete permanently. Reads open only requested UTC months plus boot records. No rotation yet.
Device reads use the operator-read plugin RPC, never host files; the link adapter restricts it to the granted member.
As with the existing transcript reader, the app must explicitly allow member-scoped `sessions.usage` pass-through.

Uncovered: worker-bundle work, skill collection review, history scans, slug generation, active-memory recall,
out-of-turn compaction and one-shot helper completions. Do not add `RunEnd.usage`, memory flush or recovery totals
again: they already overlap retained transcripts. Offline scripted-provider tests verify seven Gateway accounting
cases; they do not establish live subscription quota, provider bills or universal coverage.

For a validated JSON answer, pass a literal `schema`. The result's `data` is inferred from that schema:

```ts
import type { OpenClawKit } from '@byokit/openclaw';

async function summarize(kit: OpenClawKit) {
  const end = await kit.run({
    member: 'umer', sessionKey: 'agent:umer:report', message: 'Summarize the work.',
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, ready: { type: 'boolean' } },
      required: ['summary', 'ready'],
      additionalProperties: false,
    },
  });
  if (end.ok && end.data) {
    const summary: string = end.data.summary;
    const ready: boolean = end.data.ready;
    // Show summary and ready in the app.
  }
  return end;
}
```

`openclawDevice(link).run(message, { schema })` carries the same schema and typed result over the link.
The pinned engine has no general schema parameter: the kit adds a JSON-only instruction to the run's
system prompt, then parses and validates the final answer locally. Partial text events are unvalidated.
Malformed JSON or a schema mismatch returns `{ ok: false, kind: 'output', message }`; the message never
includes the answer. The kit sends one agent request, with no kit retries or sign-in changes. Subscription
routes stay subscriptions; an API key (billed per use) still requires the app's explicit opt-in.

The supported JSON Schema subset covers types (including nullable arrays of types), objects with
`properties`, `required` and `additionalProperties`, arrays with one `items` schema, `enum`, `const`,
`anyOf`, `oneOf`, `allOf`, `not`, numeric bounds, string/array/object length bounds and `uniqueItems`.
Annotations `title`, `description`, `default`, `examples` and the draft-07 `$schema` are accepted;
defaults are never inserted and values are never coerced. Unsupported keywords (including `$ref`,
`format` and `pattern`), malformed schemas, schemas over 64 KiB or over 32 levels deep throw before
any Gateway request. Use `as const` for schemas defined separately; dynamic schemas return unknown
`data`. App-specific business checks belong in the app after validation.

The same kit runs offline against the fake Gateway from `@byokit/openclaw/testing` (no engine, no network, no
account), and lists the sign-in routes it offers:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';

const stateDir = mkdtempSync(join(tmpdir(), 'openclaw-readme-'));
const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fakeGateway().factory });
try {
  await kit.start();
  console.log('state:', kit.state.phase, '| protocol:', kit.hello?.protocol);
  await kit.ensureMember('umer');
  const end = await kit.run(
    { member: 'umer', sessionKey: 'agent:umer:main', message: 'Say hello.' },
    (e) => console.log('event:', JSON.stringify(e)),
  );
  console.log('end:', JSON.stringify(end));
  for (const r of kit.routes().filter((r) => r.offer))
    console.log(`route: ${r.choice.padEnd(26)} ${r.billing.padEnd(12)} ${r.via}`);
} finally {
  await kit.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
```

Its output, run from this repo with Node:

```text
state: ready | protocol: 4
event: {"type":"text","text":"fake: Say hello."}
event: {"type":"text","text":"fake: Say hello."}
end: {"ok":true,"text":"fake: Say hello.","usage":{"input":10,"output":16,"total":26}}
route: github-copilot             subscription code
route: github-copilot-enterprise  subscription code
route: minimax-global-oauth       subscription code
route: minimax-cn-oauth           subscription code
route: openai                     subscription browser
route: openai-device-code         subscription code
route: opencode-go                subscription plan_key
route: xai-oauth                  subscription code
```

The block above is the whole quickstart: copy it into a `.mts` file next to your app's
`node_modules` and `node` it. No engine, no account, no network. Then read
[the run contract](../../docs/runtime-kits.md#58-runs-members-and-streams) for retries and
streams, [`examples/openclaw-kit`](../../examples/openclaw-kit) for a whole app, and
[SECURITY.md](SECURITY.md) before you store anything the engine returns.

Subscription sign-ins are offered by default. API-billed routes remain in `kit.routes()` with `offer: false`;
apps can offer them when the app or person opts in, labelled API key (billed per use). Each `Route` carries `billing` (`subscription`, `api` or
`local`) so the app can label what is billed. Proxy routes, compatibility aliases, local runtimes stay off. Native Claude Code sign-in is offered by default. The pinned Gateway guides only some routes; other choices need manual paste or key entry. For an opted-in route, allow its `plugin` id
in the app configuration and pass its `choice` explicitly to `kit.signIn()`.
Offered provider plugins are allowed by default alongside the app's plugin ids.

## API at a glance

Entries:

- `.` is the host side: `OpenClawKit`, engine supervision, config invariants, approvals (Node).
- `./device` is the portable client for phones and browsers (no Node imports).
- `./link` is the host-side `@byokit/link` adapter: member-checked ops, sealed approval push (Node).
- `./testing` holds `fakeGateway`, the `openclawContract` suite and the scripted model stub.

| Export | What it does |
| --- | --- |
| `OpenClawKit` (`.`) | Prepares, starts, supervises and stops the engine. `call` / `callDynamic` pass through to the Gateway, `onEvent` listens. Helpers: `ensureMember`, `routes`, `providers`, `signedIn`, `signIn`, `signOut`, `migrateRetainedLogin`, `confirmRetainedLogin`, `toolNames`, `run`, `steer`, `abort`, `approvals`, `onApproval`, `decide`, `allowOnce`, `disallowOnce`, `patchConfig`, `getConfigKey`, `setConfigKey`, `memoryLimited`, `doctorContext` |
| `ENGINE_VERSION`, `PROTOCOL_VERSION`, `OPERATOR_SCOPES` (`.`) | The pinned engine version, its protocol and the operator scopes the kit connects with |
| `KitOptions`, `RunSpec`, `RunEvent`, `RunEnd`, `RunUsage`, `PlanWindow`, `Route`, `Approval`, `Decision`, `ToolSpec`, `ToolHost`, `KitState`, ... (`.`) | Public types (docs/runtime-kits.md §5.2) |
| `GatewayMethods`, `GatewayMethod`, `GatewayParams`, `GatewayResult`, `GatewayEventName`, `GatewayEventPayload` (`.`) | The generated pass-through tables, so an app can write its own generic wrapper over `call` / `onEvent` once |
| `RouteView`, `RouteFacts`, `JsonValue`, `UsageClient`, `DayUsageClient` (`.`) | The types `routes()`, `routes(facts)` and the usage readers return or take, nameable without a cast |
| `openclawDevice(link)` (`./device`) | Portable client: state, routes, sign-in, runs, steer, abort, approvals, events, sealed notices, pass-through `call`. `OpenClawDevice` and `DeviceEndFrame` name what it returns |
| `LinkRefused`, `openNotice` (`./device`) | The host's own refusal as an error; opens a sealed approval notice |
| `words`, `stateWords`, `toAccountView` (`.`, `./device`) | The kit's sentences, so a phone shows the words the computer does; `toAccountView` feeds [`@byokit/ui`](../ui/README.md)'s `phaseOf` |
| `openclawLink(kit, o)` (`./link`) | `handle` / `stream` / `allow` for a `@byokit/link` `Host`, checked per member, plus `onAction` for relay push actions. `OpenClawLinkOptions` / `OpenClawLinkHost` name both sides |
| `serve(o)` (`./link`) | Binds the link host per reach and returns its URLs (`OpenClawServeOptions` / `OpenClawServeHandle`) |
| `fakeGateway`, `openclawContract`, `startModelStub`, `useModelStub` (`./testing`) | In-memory Gateway, the contract suite and the scripted model for tests. `fakeGateway`'s script is typed per method (`FakeScript`, `FakeHandler`), and a recorded `StubCall` carries a typed `StubRequest` |

### What the pass-through cannot type

Every method and event the pin publishes has a real type: `kit.call('sessions.list', params)` is checked in and
returns the engine's declared result, with no cast. For the slots the pin itself leaves undeclared the table stays
`unknown`, and `src/generated/report.json` names every one of them per release. On `openclaw@2026.8.1` that is 301
of 393 methods' params and 192 of their results, plus 21 of 55 event payloads; the other slots are not missing from
the kit, they are not published by the engine, and typing them here would be a guess that does not match the
gateway. `callDynamic` stays the same shape for a method the pin never declared.

## Owned browser (unqualified handoff)

`browser: { executablePath, members }` opts into isolated member Chromium profiles. It requires a closed
explicit tool allowlist and keeps `request_sign_in` refused: protected production handoff is not qualified.
Public live view/thumbnail APIs are model-free; source tests alone do not prove private/restart protection.
The opt-in physical fixture retains raw JPEG/control inputs before decoding, pipe chunk order, complete
synthetic provider bodies and authoritative SQLite transcripts, including failures.

## One config key, narrowed

`patchConfig` is the only whole-config writer, and it can only start from `config.get`, whose result redacts
token-bearing values: an app cannot read one key through it and write it back unchanged. For a single key, use the
narrow pair over the config file the engine loads at boot:

```ts
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({ stateDir: './openclaw-state' });

kit.getConfigKey('skills.workshop.autonomous.mode');            // value, or undefined
kit.setConfigKey('skills.workshop.autonomous.mode', 'off');      // returns the value it replaced
kit.setConfigKey('skills.workshop.autonomous.mode', undefined); // remove it again
```

One dotted path of `[A-Za-z0-9_-]` segments; prototype-reaching segments are refused. Only that key changes (every
other key keeps its order, an unchanged value writes no bytes, and removing a key takes the empty objects it created
back out), the write is atomic in `prepare()`'s exact shape, and the engine applies it at its next boot. Narrow a key
your app does **not** also pass in `KitOptions.config`: that option is merged over the saved file on every boot and
wins. Don't interleave a narrow set with `patchConfig`, which rewrites the whole config through the Gateway.

## Engine learning state

The engine's learning switch is the config key `skills.workshop.autonomous.mode` (`off | propose | auto`; engine
default `auto` when absent). `off` keeps only the suggestion nudge, `propose` creates pending proposals, `auto`
applies captured proposals and runs the scanner-gated cleanup; the engine projects a system-owned cron job
`skill-collection-review-<agentId>` per workspace agent, enabled only on `auto`. The kit names it — file-backed like
the pair above, so it works on a stopped home, before boot and after `stop()`:

```ts
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({ stateDir: './openclaw-state' });

kit.learning();                                  // { present: false } | { present: true, mode: 'off' | 'propose' | 'auto' }
const before = kit.learning();                   // capture before maintenance
kit.setLearning('off');                          // returns the state it replaced
kit.setLearning('default');                      // remove the key: the engine default (auto) applies again
kit.restoreLearning(before);                     // writes the capture, reads it back, throws on mismatch
```

Absence is a value (`{ present: false }`), never "probably default". An unknown mode throws listing the accepted
values (`off|propose|auto`, plus `default` for `setLearning`), a stored value outside the enum makes `learning()`
throw naming it, and both writers throw when the app also passes a `skills` key in `KitOptions.config` (that option
wins at every boot). A home that was never prepared surfaces the file read's ENOENT: `prepare()` once first.

## Retained home killed without stop()

A host crash or `kill -9` skips `stop()` cleanup. The next `prepare()` (the next `start()`) repairs the home
itself — no manual file surgery:

- It stops a leftover Gateway only after verifying it is a same-user orphan of this root (matching pid, identity,
  start time, exe/cwd and env), and only when the auth-store lock's owner is dead; then it seals the leftover live
  credential state (`state/` and the non-cache `home/` paths, see below) back into the store under the acquired
  lock. Anything ambiguous (a live lock owner, an unverifiable pid, another writer alive, shutdown timeout) fails
  closed with `EngineAlreadyRunningError` instead.
- A stale `auth-store.lock/` with a dead owner is recovered through a `recovery/` marker; interrupted
  `cleanup`/`restoring` transitions are completed from the authenticated snapshot; empty live trees are treated as
debris.
- An engine exit code 78 means the engine asked for repair: the kit's own repair path runs
  `doctor --fix --yes` with `doctorContext()`'s exact env.

What a killed home leaves behind: live plaintext `state/` and `home/` (never resealed), `auth-store.lock/` with a
dead owner pid, `gateway.pid` and `gateway.identity` (a still-live orphan Gateway is the dangerous case),
`openclaw.json` with its `.bak.*` journal, `engine-set`, `plugin/`, `workspaces/`, `usage/`, `tmp/`, `npm-cache/`
and `install-home/`. None of these is safe to edit by hand, and `auth-store.sealed` above all: never hand-edit it —
restore an authentic backup under the lock instead (see the credential sealing section). Keep backups before any
manual intervention.

Resealing after the kill seals every file under the engine `state` tree and the credential paths under `home`.
Credential files under `state` and `home` go into the bounded credential blob. Every other file under `state` is
sealed as its own object under `auth-store.objects/`, outside that bound: the shared and per-agent SQLite databases
(with their `-wal`/`-shm`/`-journal` sidecars, which mix credentials with session and transcript rows), exported
transcript artifacts (`state/transcripts`), legacy session stores (`state/sessions`, `state/agents/<agentId>/sessions`),
the media stores (`state/media`, `state/delivery-queue-media`), the control-UI and other caches (`state/cache`,
`state/completions`), logs (`state/logs`) and gateway temp/lock files (`state/tmp`). However large a long-used host's
transcripts and media grow, they never count toward the bound. In `home` the XDG cache and npm cache homes
(`home/.cache`, `home/.npm`) and the transcript, log and cache subtrees of the CLIs the engine runs (`home/.codex`
sessions/log/cache/`.tmp`/`history.jsonl`, `home/.claude` projects/todos/shell-snapshots/statsig/file-history/`history.jsonl`)
stay on disk unsealed. Unknown paths are still sealed in the blob (a credential location we do not know about must
fail loudly, never drop silently). The blob is bounded: if the collected credential files together pass a fixed
limit, `prepare()`, `start()`, `stop()` and an engine exit reject with exported `AuthStoreSealSizeError`
(`code: 'auth-store-seal-size'`, fields `size` and `cap`). On that refusal the last good saved store is kept as it
was and no live file is deleted; nothing else is promised. A refused `stop()` still releases the lock. Its `size` is a
lower bound (the running total at the refusal). Do not move or delete files under `state/` or `home/` to get under the
limit: the next successful seal would drop them. If your app hits this, report the error's size and cap to the byokit
maintainers; the limit was reached in real use.

## App-owned task recovery

If your app requeues interrupted tasks itself, declare their namespaces **before starting the kit**:

```ts
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({
  stateDir: './openclaw-state',
  appOwnedSessions: { keyPrefixes: ['agent:m1:crewhouse:'] },
  // tools and host as usual
});
```

Matching task sessions are excluded from the bundled engine's automatic restart continuation; your app
continues the same session key with `kit.run`. Prefixes must start with `agent:<member>:` and must not cover
that member's `main` key. The kit also covers a public member's isolated API-key session rewrite. Omitted/empty
keeps stock recovery, including its existing retry accounting; no histories or recovery markers are deleted,
no tool gate is bypassed, and cron behavior is unchanged. Changing ownership requires an engine restart.
This option does not decide whether an interrupted external action is safe to retry; your app still owns
that decision. It needs the published kit's bundled engine patch, not a separately installed stock CLI.

## Phones and browsers

The host side serves member-checked ops over `@byokit/link`; the phone or browser uses the portable client:

```ts
import { Host, keyPair, type DeviceLink } from '@byokit/link';
import { OpenClawKit } from '@byokit/openclaw';
import { openclawLink, serve } from '@byokit/openclaw/link';
import { openclawDevice } from '@byokit/openclaw/device';

// On the computer (Node): member-checked ops over @byokit/link, served per reach.
declare const kit: OpenClawKit;
declare const ask: (question: string) => Promise<boolean>; // your own prompt
const api = openclawLink(kit, { memberOf: (grant) => (grant.meta as { member?: string } | undefined)?.member });
const host = await Host.open({
  keys: keyPair(),
  name: 'My computer',
  confirm: ({ name, words }) => ask(`Pair ${name}? Check it shows “${words}”.`),
  ...api,
});
const served = await serve({ host, port: 8787, via: 'lan' });
console.log(served.urls);

// On the phone or in the browser: the portable client over a paired DeviceLink.
declare const link: DeviceLink;
const oc = openclawDevice(link);
for await (const e of oc.run('Say hello.')) console.log(e);
```

## Isolation and billing

The kit writes only under the `stateDir` the app passes. It spawns the engine with an explicit isolated environment
(never `process.env`), reads no environment variables except `PATH` to find `npm`, and never bills an API behind the
person's back (memory search is never a paid provider).

Route data follows the shared account-route vocabulary (D18 in [`docs/runtime-kits.md`](../../docs/runtime-kits.md#21-account-routes-d18)): subscription routes are offered by default, and every other billing is used only when named. The full table of the pinned engine's auth choices is planned work; `routes()` returns today's table.

## Credential sealing and threat model

The pinned engine has no supported hook for sealing OAuth profile writes. Its `auth-profiles` loader stores
credential JSON in agent SQLite databases and a shared state database, and doctor imports leave migration
archives. `authSeal` therefore protects credential state — config/credential paths under `home` and every credential
path under the isolated `state` tree — in one bounded blob, `auth-store.sealed`. Every other file under `state`
(the shared state database `state/state/openclaw.sqlite` and the per-agent databases
`state/agents/<agentId>/agent/openclaw-agent.sqlite`, which mix credentials with transcript rows, plus transcripts,
media, logs, caches and session stores) is sealed as its own file under `auth-store.objects/`, outside the bound, so
a long-used host's history never makes `start()` or `stop()` refuse. Regenerable tool caches in `home` stay on disk
unsealed. Only a credential blob over the cap still refuses `start()` and `stop()` with the typed size error instead of
aborting the process. It uses the injected `SealingAdapter` from `@byokit/secrets`. `osKeyringSeal()` automatically
uses a persistent private file key for new stores when no non-interactive keyring is available.
Opening follows the saved envelope's mode. A locked or unresponsive keyring-only store leaves
`kit.state.phase === 'locked'`: `prepare()` and `start()` resolve, show `stateWords(kit.state)` for
recovery, and keep the sealed snapshot unchanged without launching the engine. Call `start()` again
after unlock to restore the same credentials, even if a fallback key directory now exists.

For hosts whose keyring stays locked, opt into `osKeyringSeal({ service, dualWrap: true })`.
While unlocked, reading an existing keyring-only snapshot atomically upgrades it to dual-wrap.
Later starts and stops can use the host wrap without prompting. Default off: **protection is only
as strong as the owner-only host-key file**, which must stay outside sealed-store backups.

```ts
import { osKeyringSeal, hostKeySeal } from '@byokit/secrets';
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({
  stateDir: './openclaw-state',
  authSeal: osKeyringSeal({ service: 'my-app-runtime' }),
});
await kit.prepare(); // seals an existing plaintext store and migration archives without starting the engine
await kit.start();   // authenticates and restores the isolated files for the engine
await kit.stop();    // waits for exit, verifies an atomic sealed snapshot, then removes plaintext

// Inspect the adapter's write mode: 'keyring', 'host-key-file' or opt-in 'dual-wrap'.
// Hosts can also explicitly supply a 32-byte key kept outside stateDir and its backups:
declare const hostKey: Uint8Array;
const server = new OpenClawKit({
  stateDir: './server-state',
  authSeal: hostKeySeal({ key: hostKey, service: 'my-app-runtime' }),
});
```

The automatic key lives in the platform state directory, separate from the engine store. A key
on the same disk protects copied stores/backups only when the key directory is excluded; it does
not protect against code running as the same OS user. See [secrets' rotation and threat model](../secrets/README.md#servers-and-headless-node).
Stop the kit, acquire the host writer lock and call `seal.rotate()` with `auth-store.sealed` plus
every retained sealed migration archive before retiring an automatic key. Rotate each envelope mode
separately; dual-wrap rotation retains old wrapping keys for backups.

Without `authSeal`, engine credentials remain plaintext. With it, successful `prepare()` and `stop()` leave
only sealed files: `auth-store.sealed` for the credential paths, and `auth-store.objects/` for the other engine stores
under `state`; regenerable caches under `home` stay on disk unsealed. The adapter authenticates the snapshot
before any restoration; a missing adapter rejects. A store the key cannot open (a wrong key,
damaged or tampered bytes) or whose payload is not a credential snapshot stays unchanged at
`auth-store.sealed`. Both `prepare()` and `start()` reject with exported `AuthStoreUnreadableError`
(`code: 'auth-store-unreadable'`, `reason: 'auth-failed' | 'invalid-snapshot'`). The kit reports
`{ phase: 'failed', why: 'auth-store-unreadable' }`; show `stateWords(kit.state)`, not a sign-in prompt.
Saved sign-in data over the cap rejects with `AuthStoreSealSizeError`, and the kit reports
`{ phase: 'failed', why: 'auth-store-seal-size', sealSize: { size, cap } }`; the refusal rules are in
[Retained home killed without stop()](#retained-home-killed-without-stop).
Restore access to the original seal/key (and the original service/stateDir binding if the adapter uses
one), then retry `start()` with that adapter. Do not generate/rotate a key to repair an unreadable store.
If the bytes are damaged, stop all writers, acquire the host writer lock, and restore an authentic
backup with its matching key before retrying. There is no automatic reset or overwrite.
For stores kept aside by an older kit, restore the original `.unreadable-*` snapshot to
`auth-store.sealed` only while stopped under that lock, preserving both it and any replacement as
backups first; use the original seal. Without the matching key or an authentic backup the kit cannot
recover the sign-in. Files restored for the engine
have mode 0600 and directories 0700. File symlinks are sealed only when their fully resolved targets are
regular files inside the isolated engine root; they restore as regular files at the link paths. Outside-root,
dangling and directory symlinks (including loops), sockets, FIFOs and devices are skipped.
One kit owns the store at a time. After a host crash, preparation stops a verified same-user gateway
only when its host lock owner is dead, waits up to three seconds for exit, then seals and restores the
leftover state under the acquired lock. If process identity is ambiguous (including unavailable process
inspection or a rewritten command line), another host is alive, or shutdown times out, `prepare()` and
`start()` reject with exported `EngineAlreadyRunningError` (`code: 'engine-already-running'`). The kit reports
`{ phase: 'failed', why: 'engine-already-running' }`; show `stateWords(kit.state)` and retry after the other
session stops. Failed-start cleanup and `stop()` on an instance with no ownership preserve the other
writer's pid, lock, sealed snapshot and live state.
The sealed payload is built once and verified by decrypting the sealed bytes, so startup and stop cost
grows with credential state, not session history.

The migration doctor temporarily opens the same store and reseals it even when import fails. Once the gateway
verifies every provider, `confirmRetainedLogin()` removes the explicitly passed legacy source and writes only
an empty completion marker. It no longer creates a plaintext `.moved-to-engine` copy. On prepare, old engine
`*.json.migrated-*` and `*.json.sqlite-import.*.bak` archives and retained copies under `stateDir` are sealed
with the adapter (a `credential archive sealed` log event). Without an adapter, engine archives and confirmed
retained copies are removed (`verified credential archive removed`). An unconfirmed retained copy remains a
migration source until verified or sealed; pass its original path to migration to recover a sealed copy.
Archives stay sealed and are never restored as engine input. External source paths are handled only when the
host explicitly passes them to migration/confirmation. An app supplying a record still removes its own copy.

Residual risk: credentials are plaintext on disk and in process memory while the gateway or migration doctor
runs. Abrupt host termination or power loss cannot run stop cleanup: next prepare seals leftover live files,
but refuses while the old gateway is alive. Interrupted restore/removal is recovered from the authenticated
snapshot. A sealing failure rejects stop and retains recoverable live files; the host must resolve it and retry.
Await `stop()` during orderly shutdown. File removal does not erase old filesystem blocks, snapshots, swap or
backups; use an encrypted volume and exclude live state from backups. A same-user process, administrator,
compromised engine/plugin, memory dump, or stolen host key can read credentials. There is no rollback protection
against replacement with an older authentic snapshot. Gateway/device keys, inline config secrets, logs, engine
install/cache files and app workspaces are outside this adapter's sealing scope; protect them separately.
`doctorContext()` is an advanced escape hatch: launching an external doctor bypasses this lifecycle; use the
kit's migration method for sealed stores.

See [SECURITY.md](SECURITY.md) for the credential and approval threat model, private-directory requirements,
retained-login cleanup and sealed approval limits.

## Status

Pinned to OpenClaw `2026.8.1` (protocol 4); `ENGINE_VERSION` and `PROTOCOL_VERSION` carry the pin. Signatures are
frozen (docs/runtime-kits.md §5).

## Links

- [byokit](../../README.md), the repo root
- [docs/runtime-kits.md](../../docs/runtime-kits.md), the binding spec for this kit (§5)
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE); the bundled engine's MIT text is [engine/OPENCLAW-LICENSE](engine/OPENCLAW-LICENSE).

Claude: `anthropic-cli` uses your own unmodified Claude Code login on this machine (provider `claude-cli`, plugin `anthropic`; subscription billing; `kit.signedIn(member, 'claude-cli')` is true once Claude Code is signed in, and `'anthropic'` stays the API-billed provider a Claude Code login never satisfies. Before 0.7.0 this route reported provider `anthropic`; that value is deprecated, kept as `deprecatedProvider` until 0.9.0), with login kept in Claude Code under the kit’s isolated `HOME=<stateDir>/openclaw/home` and `CLAUDE_CONFIG_DIR=<stateDir>/openclaw/home/.claude`; sign in there with `claude auth login`, then call `signIn`. Activation live-tests the route; native sign-out is through Claude Code. `apiKey` is explicit API billing (“API key (billed per use)”, `offer: false`): `signIn` asks for the key through `paste`, then engine activation verifies it. The `setup-token` choice is listed but never offered: the pinned Gateway has no app-guided sign-in for it. The kit never imports Claude credentials or implements direct Claude.ai OAuth; [Anthropic’s terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) apply.
