<h1 align="center">@byokit/herdr</h1>

<p align="center">
  <img alt="status: in development" src="https://img.shields.io/badge/status-in%20development-lightgrey?style=flat" />
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
</p>

<p align="center"><strong>Drive the Herdr already on this computer from an app, or from a phone.</strong><br/>
Workspaces, tabs, panes, coding agents and blocked-approval answers, from a Node app or handed to a phone over
<a href="../link"><code>@byokit/link</code></a>. Each agent inside Herdr keeps its own subscription login; the kit
never sees a credential.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/3-agent.png" width="240" alt="Phone page titled Agents, Connected to Kitchen computer and Connected to Herdr: two pi agents marked Ready for you, and under Talk to it the agent's screen reading '> Add a --json flag to export', 'Read src/cli/export.ts', 'Edited src/cli/export.ts +18 -3' and 'export --json now prints JSON.' above a Message box, a Send button and Sent." />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/4-question.png" width="240" alt="Phone page with Questions for you at the top: pi, Waiting for your answer., the question 'Allow this? (y/n)' and buttons Enter, y, n and Esc; below, the second pi agent marked Waiting for your answer." />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/5-answered.png" width="240" alt="Phone page after the answer: no Questions for you section, both pi agents marked Ready for you, and the agent's screen ending in 'Allow this? (y/n)', 'y' and 'npm test: 42 passing'" />
</p>
<p align="center"><sub>The <a href="../../examples/herdr-kit">herdr-kit example</a>'s phone page: an agent at work, its
question, answered. Captured by the example's e2e in a phone-sized headless Chromium, against the kit's stand-in
Herdr.</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/herdr-kit-host.png" width="420" alt="Terminal running npm start -- --herdr &quot;$(command -v herdr)&quot; --via lan --name 'Kitchen computer': a QR code, then 'On the phone, scan this, or open http://192.168.1.144:7310/ and type K3J8-CJZ7-SE4R', 'Codes last five minutes. Press Enter for new ones.', 'Connecting to Herdr…' and 'Connected to Herdr.'" />
</p>
<p align="center"><sub>The same example's host terminal (<code>host.ts</code>), started with <code>BYOKIT_EXAMPLE_FAKE=1</code> so it runs the kit's stand-in Herdr.</sub></p>

## Install

```sh
npm install @byokit/herdr
```

[![npm](https://img.shields.io/npm/v/@byokit/herdr?style=flat&label=)](https://www.npmjs.com/package/@byokit/herdr) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=herdr-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

Available on npm; it is also used from this repo, or from its packed packages as
[`examples/herdr-kit`](../../examples/herdr-kit) does:

```sh
npm install @byokit/herdr
```

Herdr itself is not an npm dependency: the app installs Herdr 0.9.1 (see herdr.dev) and passes its path as `bin`.
The opt-in helper `ensureHerdr` (`@byokit/herdr/binary`, also spelled `fetchHerdr`) fetches that for the app:
it downloads the pinned release asset for the current platform into an app-owned directory, verifies its sha256
against a committed per-platform table, marks it executable, and returns the absolute `bin` for `own` mode.
Nothing downloads on install or import — the network happens only when the helper is called.
This runs against the kit's stand-in Herdr from `@byokit/herdr/testing`, so it needs neither Herdr nor an agent:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HerdrKit, agentWords, type BlockedAgent } from '@byokit/herdr';
import { startFakeHerdr } from '@byokit/herdr/testing';

// The kit's stand-in Herdr. With a real one, pass its bin and socket path instead.
const fake = await startFakeHerdr({ dir: mkdtempSync(join(tmpdir(), 'herdr-')) });
const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
await kit.start();

const agent = { paneId: 'w1:p2' };
await kit.prompt(agent, 'hello');                     // resolves with a receipt once delivered
console.log(await kit.wait(agent, { until: ['idle'], timeoutMs: 5000 }));
console.log((await kit.read(agent.paneId)).text);

// The question arrives once the kit has read it off the pane, so wait for it.
const asked = new Promise<BlockedAgent>((resolve) => {
  const off = kit.onBlocked((b, change) => {
    if (change === 'added' && b.paneId === agent.paneId) { off(); resolve(b); }
  });
});
await kit.prompt(agent, 'ask permission');
const question = await asked;
console.log(agentWords('blocked'), '|', question.prompt);
await kit.answer(agent.paneId, ['y'], { revision: question.revision });
console.log(await kit.wait(agent, { until: ['idle'], timeoutMs: 5000 }));

await kit.stop();
await fake.stop();
```

```text
idle
ready.
fake pi: hello
Waiting for your answer. | Allow this? (y/n)
idle
```

To hand Herdr to a phone, spread `herdrLink` into a `@byokit/link` host and serve it; the phone calls the same
things through `herdrDevice`:

```ts
import { ensureHerdr } from '@byokit/herdr/binary';
import { HerdrKit } from '@byokit/herdr';

// One call, only when the app wants it: the pinned Herdr 0.9.1 binary lands verified in an
// app-owned directory (never PATH, never ~/.local/bin), ready for own mode.
const bin = await ensureHerdr({ dir: './.state/herdr-bin' });
const own = new HerdrKit({ mode: 'own', bin, stateDir: './.state' });
```

```ts
import { HerdrKit } from '@byokit/herdr';
import { herdrLink, serve } from '@byokit/herdr/link';
import { Host, type Grant } from '@byokit/link';
import { hostKeyFile } from '@byokit/link/node';

const kit = new HerdrKit({ mode: 'own', bin: '/usr/local/bin/herdr', stateDir: './.state' });
const grants: Grant[] = [];

const host = await Host.open({
  keys: hostKeyFile('./.state/link-key.json'),
  name: 'my-computer',
  grants: { load: () => grants, save: (g) => { grants.splice(0, grants.length, ...g); } },
  confirm: async () => true,        // ask the person at the computer here
  // Each paired device sees the workspaces its grant's meta names; none by default.
  ...herdrLink(kit, {
    scopeOf: (g) => (g.meta as { scope?: { workspaces: 'all' | string[] } } | undefined)?.scope ?? { workspaces: [] },
  }),
});
const served = await serve({ host, port: 7310 });
console.log(served.urls);
kit.start().catch(() => {});        // non-fatal: retry later while Herdr is down
```

```ts
import type { DeviceLink } from '@byokit/link';
import { agentWords, herdrDevice } from '@byokit/herdr/device';

declare const link: DeviceLink;     // from pairing (pairWithCode / pairWithOffer)

const hd = herdrDevice(link);
const agent = await hd.startAgent({ kind: 'pi', cwd: '/home/me/project', place: { workspace: 'new' } });
await hd.prompt(agent.paneId, 'Run the tests');
for (const q of await hd.blocked()) {
  console.log(agentWords('blocked'), q.prompt);
  await hd.answer(q.paneId, ['y'], q.revision);
}
```

The [herdr-kit example](../../examples/herdr-kit) is the full version: pairing with a QR code and typed code, a
persistent grant store, and the phone page above.

## API at a glance

| Export | What it does |
|---|---|
| `HerdrKit` (`@byokit/herdr`) | The host-side kit, in `adopt` or `own` mode: `start`/`stop`, `state`, `snapshot`/`onChange`, `startAgent`, `openSignInTab`, `move`, `moveToAccount`, `onStartAgent`, `prompt`, `sendKeys`, `wait`, `read`, `blocked`/`onBlocked`/`answer`, `closePane`/`closeTab`/`closeWorkspace`, `agentKinds`, `installedAgentKinds`, `agentStatus`, `agentInstallState`, `terminal`, `onEvent`, `statusWatchReady`, and the pass-throughs `call`, `subscribe` and `cli` |
| `agentStatus`, `agentInstallState`, `agentProbePath`, `extraPathDirs`, `runStatusCommand`, `isAutoInstallShim`, `resolveAgentBinary` (`@byokit/herdr`) | Onboarding readiness: per-kind install + CLI sign-in without a Herdr connection (see below) |
| `HERDR_VERSION`, `HERDR_PROTOCOL` | The pinned Herdr release (`0.9.1`) and the protocol the kit speaks (`22`) |
| `words`, `agentWords`, `stateWords`, `WORDS` | Plain sentences for agent statuses and kit states |
| `herdrLink` (`@byokit/herdr/link`) | The host side of the `hd.*` link ops, spread into `Host.open`; scopes each grant to its workspaces and can push sealed approval notices through a relay |
| `serve` (`@byokit/herdr/link`) | Finds the address with `@byokit/reach` and serves the link (and an optional page) on one port |
| `herdrDevice` (`@byokit/herdr/device`) | The phone and browser side: typed calls over a `DeviceLink` (`tree`, `startAgent`, `prompt`, `read`, `blocked`, `answer`, `events`, `terminal`, notices); no Node import |
| `openNotice` (`@byokit/herdr/device`) | Opens a sealed approval notice with the device's own seed |
| `startFakeHerdr`, `writeBinShim`, `herdrContract` (`@byokit/herdr/testing`) | The kit's stand-in Herdr, a bin shim that runs it, and the contract suite the kit passes |
| `ensureHerdr`, `fetchHerdr`, `HERDR_ASSETS` (`@byokit/herdr/binary`) | Opt-in pinned fetch: the v0.9.1 asset for the current platform into an app-owned dir, sha256-verified, executable, returned as the absolute `own`-mode `bin`; refused (nothing left) on a hash mismatch or unsupported platform |

`PromptReceipt` contains `paneId`, `terminalId`, `revision`, and `status`. Its optional
`agentSession` (`{ source, agent, kind, value }`) identifies the conversation that received
this prompt, taken directly from the `agent.prompt` response without another read.
`kind` distinguishes a session id from a session path; `value` is that id or path.
Herdr exposes no separate generation counter. When Herdr omits the session (or returns
null), `agentSession` is absent; callers can fall back to their existing checks.

Types (`HerdrKitOptions`, `HerdrState`, `StartAgent`, `PromptReceipt`, `BlockedAgent`, `HerdrSnapshot`,
`HerdrMethod`/`HerdrParams`/`HerdrResult`, `HerdrEventName`/`HerdrEventOf`, ...) come from the main entry.

## Account-specific sign-ins and moves

The host supplies account folders and shares conversation history as needed. The kit never reads or copies
credentials. To connect an account, open its CLI in a new tab and let the person complete the CLI's own login:

```ts
import { HerdrKit } from '@byokit/herdr';
const kit = new HerdrKit({ mode: 'adopt', bin: '/app/bin/herdr', socketPath: '/app/herdr.sock' });
await kit.start();

const signIn = await kit.openSignInTab({
  workspaceId: 'w1', kind: 'codex', cwd: '/home/me/project', env: { CODEX_HOME: '/app/accounts/work' },
});
// Attach terminal(signIn.paneId, …) for the CLI's own sign-in screen.
const moved = await kit.moveToAccount({ paneId: 'w1:p2' }, {
  provider: 'codex', folder: '/app/accounts/work',
});
if (moved.ok) console.log(moved.session); // new pane to follow
```

A move accepts Claude for Claude folders and Codex for Codex folders. Pi ignores these folder variables and is refused. It verifies the new shell's effective
account folder, resumes the conversation there, waits for a ready session, then closes the old pane. A failed
start preserves the original; a failed source close rolls back the new pane. Failures return a plain `message`
and a `live` pane id for recovery, including when cleanup fails. Wait until a conversation is idle or done before
moving it. `StartAgent.env` applies to newly created placements; existing shells cannot receive a new env.
Tokens stay on the device and are never logged. Each provider's own terms apply to how you use your plan.

For managed-folder stores that supply resume arguments and credential shedding, use `move`:

```ts
import { HerdrKit } from '@byokit/herdr';
const kit = new HerdrKit({ mode: 'adopt', bin: '/app/bin/herdr', socketPath: '/app/herdr.sock' });
await kit.start();

const conversationId = 'published-conversation-id';
const staged = new Set<string>();
let activePane = 'w1:p2';
const moved = await kit.move({
  paneId: 'w1:p2', kind: 'codex', args: ['resume', conversationId],
  set: { CODEX_HOME: '/app/accounts/work' }, unset: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  onStaged(paneId) { staged.add(paneId); },
  onReplaced(paneId) { staged.delete(paneId); activePane = paneId; },
});
if (moved.ok) console.log(moved.paneId);
await kit.cli(['integration', 'install', 'codex'], { env: { CODEX_HOME: '/app/accounts/work' } });
```

`MoveResult` names the new pane as `paneId`; `moveToAccount` retains its `session` result as
`MoveToAccountResult`. Both share the same per-source lock. Staging runs before verification/start; a staging
exception rolls back. Replacement notification runs after closing the source and cannot undo the move.
`move` clears `unset` in the new shell, verifies the account folder and unset names' absence, and requires an interactive
agent publishing a conversation before closing the source. The pinned start API has no command-prefix/env
field, so this uses shell `unset` rather than `env -u`; shells that cannot clear a variable fail closed.
Only folder paths belong in `set`, never tokens. `cli` env overlays the kit's explicit env for one call;
it inherits no process variables. The default move step timeout is 60 seconds.

## Two ways in

- `adopt` talks to the socket path the app passes: the person's own Herdr, nothing spawned, nothing written.
- `own` runs the Herdr binary the app names, in an app-owned state directory.

Helpers cover the common paths (start an agent, deliver a prompt with a receipt, watch blocked agents, exact closes).

## Agent readiness

`kit.agentStatus(kinds)` reports, per kind, whether the agent's CLI is installed and whether
it is signed in — the onboarding agents-and-pickers check. It needs no Herdr connection: it
probes the local machine. Install detection reuses `installedAgentKinds` over the host PATH plus
the extra install dirs a service PATH omits (`extraPathDirs`: `~/.local/bin`, the mise shims,
`~/.npm-global/bin`, Homebrew and the system dirs — the set muxr probed before this kit did).
Sign-in comes only from each CLI's own documented non-secret status command, with a 10 s timeout;
a kind whose CLI has none, or whose command gives no answer, reads `unknown`. Credential files
are never opened, read or statted — only the signed-in boolean is kept. Install detection tells a
real runnable binary apart from an auto-install launcher: a mise-style shim on PATH, or nothing
on PATH at all, reads `installState: 'installs-on-first-start'` with `installed: false` — Herdr
fetches the agent on first start — instead of a missing-install error. That covers `pi`, which
Herdr installs via mise: a missing or shimmed `pi` reads `installed: false` with `installs on
first start`, while a real `pi` binary reads `installed: true`.

```ts
import { HerdrKit } from '@byokit/herdr';

const kit = new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath: '/tmp/herdr.sock' });
// Local probe only — the kit need not be started.
console.log(await kit.agentStatus(['pi', 'claude', 'codex']));
```

```text
[
  { kind: 'pi', installed: false, installState: 'installs-on-first-start', signedIn: 'unknown',
    installHint: 'installs on first start' },
  { kind: 'claude', installed: true, installState: 'installed', signedIn: 'yes',
    installHint: 'Install the claude command, then check again.' },
  { kind: 'codex', installed: true, installState: 'installed', signedIn: 'no',
    installHint: 'Install the codex command, then check again.',
    signInHint: 'On this computer run `codex`, sign in, then come back.' },
]
```

| Kind | Status command | Why this one |
|---|---|---|
| `claude` | `claude auth status` (JSON `loggedIn`) | The CLI's own documented status; a signed-out CLI still prints its JSON, so only an empty answer reads `unknown`. |
| `codex` | `codex app-server` with a pipelined `initialize` + `account/read` round | Codex exposes sign-in only over its app-server protocol; a record `account` in the second answer means signed in. |
| `pi` | none (Herdr installs it via mise) | Missing or shimmed: `installed: false`, `installs on first start`. A real binary reads `installed: true`. |
| any other kind | none | No documented non-secret status command, so `unknown` until the kit covers it. |

Options: `{ path, aliases }` as in `installedAgentKinds`; `{ readFile }` overrides the shim
sniff's file-head reader (tests use fakes); `{ run }` injects the command runner
(`(command, args, { stdin, timeoutMs }) => Promise<{ stdout } | undefined>`, so tests use fakes);
`{ timeoutMs }` bounds each probe. `signInHint` rides kinds the kit knows how to check whenever they
are not signed in; `installHint` always rides along.

## Agent start lifecycle

`startAgent` keeps its typed shape and rejection, and additionally reports the launch as events
so an app shows `Installing…` instead of a blank start: `installing` (with the progress words)
before a start that needs an install, `ready` with the fresh ref, and `launchFailed` with a typed
`reason` (`placement-failed` | `pane-busy` | `install-failed` | `start-rejected`) plus plain words.
Subscribe per call with `onEvent`, or app-wide with `kit.onStartAgent` — no polling either way.

```ts
import { HerdrKit } from '@byokit/herdr';

const kit = new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath: '/tmp/herdr.sock' });
const off = kit.onStartAgent((e) => {
  if (e.phase === 'installing') console.log(e.message);       // Installing pi…
  if (e.phase === 'launchFailed') console.log(e.reason, e.message);
});
await kit.startAgent({ kind: 'pi', cwd: '/home/me/project', place: { workspace: 'new' },
  onEvent: (e) => { if (e.phase === 'ready') console.log(e.ref.paneId); } });
off();
```
`call` and `subscribe` are typed pass-throughs to the complete socket API, and `cli()` reaches the full CLI.

`start()` is non-fatal: if Herdr is down it rejects (state `failed`, e.g. `failed/socket`) and may be called again
afterwards, so the host comes up while Herdr is down by retrying `start()` in a backoff loop.

## Turn results

`runTurn` prompts an existing subscription agent and resolves after Herdr reports that it worked
and returned to `idle` or `done`. Subscribe app-wide with `onTurnEnd`, or use the call's `onEnd`.
An initial idle or a blocked approval does not finish the turn; keep using `onBlocked`/`answer`.
No provider API or additional billing path is involved.

```ts
import { HerdrKit } from '@byokit/herdr';

const kit = new HerdrKit({ mode: 'adopt', bin: 'herdr', socketPath: '/tmp/herdr.sock' });
await kit.start();
const target = await kit.startAgent({ kind: 'codex', cwd: '/app/worktree', place: { workspace: 'new' } });
const off = kit.onTurnEnd((end) => console.log(end.changedFiles));
const end = await kit.runTurn(target, {
  prompt: 'Implement the requested change, then report whether the build passed.',
  cwd: '/app/worktree',
  timeoutMs: 10 * 60_000,
  files: { exclude: (path) => path === 'node_modules' || path === 'dist' },
  result: {
    schema: { type: 'object', required: ['buildPassed'], additionalProperties: false,
      properties: { buildPassed: { type: 'boolean' } } },
    // For larger schemas, call the app's existing JSON Schema validator here.
    validate: (value: unknown): value is { buildPassed: boolean } =>
      typeof value === 'object' && value !== null && 'buildPassed' in value &&
      typeof value.buildPassed === 'boolean' && Object.keys(value).length === 1,
  },
});
if (end.result.state === 'valid') console.log(end.result.value.buildPassed);
off();
```

The kit asks the agent to write `{ turnId, result }` to a fresh JSON file in that folder before
finishing. It checks the id, parses and validates the bounded file, and removes it. The result
is `not-requested` without a policy, `missing` if the agent did not write it, `invalid` with a
reason if it could not be accepted, or `valid` with a typed value. Unchecked payloads are never
returned or logged; the transient result file is excluded from `changedFiles`. Default result
limit: 1 MiB (`result.maxBytes`). The agent must follow these instructions; Herdr has no native
schema-enforced response API. Task success is a separate app decision.

`changedFiles` lists sorted relative paths with `added`, `modified` or `deleted`, including
untracked files and changes to already-dirty files. Snapshots compare content, modes and symlink
targets, do not traverse symlinks, always exclude `.git`, and ignore special files. Files changed
and restored during the turn do not appear. Use `files.exclude` to prune generated or sensitive
folders. Each scan defaults to 10000 entries and 128 MiB of regular-file content; set
`files.maxFiles`/`maxBytes` to change these limits. An incomplete scan rejects the call.

Reserve the pane and folder exclusively while the turn runs. Overlapping calls in one kit are
refused, but changes by other apps or processes cannot be attributed to this agent. The supplied
absolute `cwd` must match Herdr's reported working directory. Timeout, watch loss, pane closure or
replacement, `kit.stop()` and an aborted `signal` reject without a completion event. Monitoring
cancellation does not interrupt the agent; it may still finish or write its result file later.
Herdr's working-to-idle/done detection is the end signal, not proof of semantic success. The kit
does not guess completion from elapsed silence or a prompt receipt.

This helper runs on the host. Apps own branches, review/apply/rollback and authorized forwarding
of results to devices; it adds no link permission or device operation.

## Status

Pinned to Herdr v0.9.1. The schema snapshot (`schema/herdr-api-0.9.1.json`, protocol 22) generates the typed surface
(`src/generated/`, `HERDR_PROTOCOL` in `src/constants.ts`). See [docs/runtime-kits.md](../../docs/runtime-kits.md)
§11.3 for the work packages.

## Isolation

The kit reads no environment variables, spawns processes with an explicit env only, and, like every byokit
package, never touches a person's other AI tools. Its tests run against a fake Herdr.

## Links

- [byokit](../../README.md): the other packages and the repo's isolation rules
- [examples/herdr-kit](../../examples/herdr-kit): Herdr's agents from a phone browser
- [docs/runtime-kits.md](../../docs/runtime-kits.md): the runtime kits' decisions and work packages
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
