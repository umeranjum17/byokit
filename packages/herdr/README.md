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
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/3-agent.png" width="240" alt="Phone page titled Agents, Connected to Test computer and Connected to Herdr: two pi agents marked Ready for you, and under Talk to it the agent's screen reading 'ready.' and 'fake pi: hello' above a Message box, a Send button and Sent." />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/4-question.png" width="240" alt="Phone page with Questions for you at the top: pi, Waiting for your answer., the question 'Allow this? (y/n)' and buttons Enter, y, n and Esc; below, the second pi agent marked Waiting for your answer." />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/5-answered.png" width="240" alt="Phone page after the answer: no Questions for you section, both pi agents marked Ready for you, and the agent's screen ending in 'Allow this? (y/n)' and 'y'" />
</p>
<p align="center"><sub>The <a href="../../examples/herdr-kit">herdr-kit example</a>'s phone page: an agent at work, its
question, answered. Captured by the example's e2e in a phone-sized headless Chromium, against the kit's stand-in
Herdr.</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/herdr-kit-host.png" width="420" alt="Terminal running BYOKIT_EXAMPLE_FAKE=1 npm start -- --via lan --name 'Kitchen computer': a QR code, then 'On the phone, scan this, or open http://192.168.1.144:7310/ and type A937-EYXC-EBCZ', 'Codes last five minutes. Press Enter for new ones.', 'Connecting to Herdr…' and 'Connected to Herdr.'" />
</p>
<p align="center"><sub>The same example's host terminal (<code>host.ts</code>), started with <code>BYOKIT_EXAMPLE_FAKE=1</code> so it runs the kit's stand-in Herdr.</sub></p>

## Quickstart

In development and not published (`private: true`); use it from this repo, or from its packed packages as
[`examples/herdr-kit`](../../examples/herdr-kit) does. Once `private: true` is removed and it is released:

```sh
npm install @byokit/herdr
```

Herdr itself is not an npm dependency: the app installs Herdr 0.9.1 (see herdr.dev) and passes its path as `bin`.
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
| `HerdrKit` (`@byokit/herdr`) | The host-side kit, in `adopt` or `own` mode: `start`/`stop`, `state`, `snapshot`/`onChange`, `startAgent`, `prompt`, `sendKeys`, `wait`, `read`, `blocked`/`onBlocked`/`answer`, `closePane`/`closeTab`/`closeWorkspace`, `agentKinds`, `installedAgentKinds`, `terminal`, `onEvent`, `statusWatchReady`, and the pass-throughs `call`, `subscribe` and `cli` |
| `HERDR_VERSION`, `HERDR_PROTOCOL` | The pinned Herdr release (`0.9.1`) and the protocol the kit speaks (`22`) |
| `words`, `agentWords`, `stateWords`, `WORDS` | Plain sentences for agent statuses and kit states |
| `herdrLink` (`@byokit/herdr/link`) | The host side of the `hd.*` link ops, spread into `Host.open`; scopes each grant to its workspaces and can push sealed approval notices through a relay |
| `serve` (`@byokit/herdr/link`) | Finds the address with `@byokit/reach` and serves the link (and an optional page) on one port |
| `herdrDevice` (`@byokit/herdr/device`) | The phone and browser side: typed calls over a `DeviceLink` (`tree`, `startAgent`, `prompt`, `read`, `blocked`, `answer`, `events`, `terminal`, notices); no Node import |
| `openNotice` (`@byokit/herdr/device`) | Opens a sealed approval notice with the device's own seed |
| `startFakeHerdr`, `writeBinShim`, `herdrContract` (`@byokit/herdr/testing`) | The kit's stand-in Herdr, a bin shim that runs it, and the contract suite the kit passes |

Types (`HerdrKitOptions`, `HerdrState`, `StartAgent`, `PromptReceipt`, `BlockedAgent`, `HerdrSnapshot`,
`HerdrMethod`/`HerdrParams`/`HerdrResult`, `HerdrEventName`/`HerdrEventOf`, ...) come from the main entry.

## Two ways in

- `adopt` talks to the socket path the app passes: the person's own Herdr, nothing spawned, nothing written.
- `own` runs the Herdr binary the app names, in an app-owned state directory.

Helpers cover the common paths (start an agent, deliver a prompt with a receipt, watch blocked agents, exact closes).
`call` and `subscribe` are typed pass-throughs to the complete socket API, and `cli()` reaches the full CLI.

`start()` is non-fatal: if Herdr is down it rejects (state `failed`, e.g. `failed/socket`) and may be called again
afterwards, so the host comes up while Herdr is down by retrying `start()` in a backoff loop.

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
