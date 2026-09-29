<h1 align="center">@byokit/openclaw</h1>

<p align="center">
  <img alt="status: in development" src="https://img.shields.io/badge/status-in%20development-lightgrey?style=flat" />
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
</p>

<p align="center"><strong>The OpenClaw runtime kit: one object that runs the pinned engine for your app.</strong><br/>
It drives the pinned OpenClaw engine (<code>openclaw@2026.8.1</code>, protocol 4) through one kit object. The
aggregator's full operator surface stays available as typed pass-through calls (<code>call</code> for every operator
method, <code>callDynamic</code> for the rest), with plain-words helpers for members, sign-in, runs, approvals and
config. For apps built on OpenClaw, where the engine holds the subscriptions.</p>

## Quickstart

Not on npm yet. Use it from this repo: `npm ci`, `npm run build`, then import `@byokit/openclaw` from a workspace
package.

Start the engine, add a member, sign them in with a subscription, run a message (typechecked; running it installs
the pinned engine and needs a real ChatGPT sign-in, so it is not run here):

```ts
import { OpenClawKit } from '@byokit/openclaw';

const kit = new OpenClawKit({ stateDir: './openclaw-state' });
await kit.start(); // installs the pinned engine under stateDir, spawns it, connects

await kit.ensureMember('ana');
const signIn = kit.signIn('ana', { authChoice: 'openai-device-code', via: 'code' }, (view) => console.log(view));
await signIn.done;

const end = await kit.run(
  { member: 'ana', sessionKey: 'agent:ana:main', message: 'Say hello.' },
  (e) => { if (e.type === 'text') console.log(e.text); },
);
console.log(end);
await kit.stop();
```

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
  await kit.ensureMember('ana');
  const end = await kit.run(
    { member: 'ana', sessionKey: 'agent:ana:main', message: 'Say hello.' },
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
end: {"ok":true,"text":"fake: Say hello."}
route: openai                     subscription browser
route: openai-device-code         subscription code
route: xai-oauth                  subscription code
route: github-copilot             subscription code
route: github-copilot-enterprise  subscription code
route: minimax-global-oauth       subscription code
route: minimax-cn-oauth           subscription code
```

Every offered route is a subscription sign-in. Each `Route` carries `billing` (`subscription`, `api` or `local`), so
an app labels any other route it shows; API-billed routes are not offered by default.

## API at a glance

Entries:

- `.` is the host side: `OpenClawKit`, engine supervision, config invariants, approvals (Node).
- `./device` is the portable client for phones and browsers (no Node imports).
- `./link` is the host-side `@byokit/link` adapter: member-checked ops, sealed approval push (Node).
- `./testing` holds `fakeGateway`, the `openclawContract` suite and the scripted model stub.

| Export | What it does |
| --- | --- |
| `OpenClawKit` (`.`) | Prepares, starts, supervises and stops the engine. `call` / `callDynamic` pass through to the Gateway, `onEvent` listens. Helpers: `ensureMember`, `routes`, `providers`, `signedIn`, `signIn`, `signOut`, `migrateRetainedLogin`, `confirmRetainedLogin`, `run`, `steer`, `abort`, `approvals`, `onApproval`, `decide`, `allowOnce`, `disallowOnce`, `patchConfig`, `memoryLimited`, `doctorContext` |
| `ENGINE_VERSION`, `PROTOCOL_VERSION`, `OPERATOR_SCOPES` (`.`) | The pinned engine version, its protocol and the operator scopes the kit connects with |
| `KitOptions`, `RunSpec`, `RunEvent`, `RunEnd`, `Route`, `Approval`, `Decision`, `ToolSpec`, `ToolHost`, `KitState`, ... (`.`) | Public types (docs/runtime-kits.md §5.2) |
| `openclawDevice(link)` (`./device`) | Portable client: state, routes, sign-in, runs, steer, abort, approvals, events, sealed notices, pass-through `call` |
| `LinkRefused`, `openNotice` (`./device`) | The host's own refusal as an error; opens a sealed approval notice |
| `openclawLink(kit, o)` (`./link`) | `handle` / `stream` / `allow` for a `@byokit/link` `Host`, checked per member, plus `onAction` for relay push actions |
| `serve(o)` (`./link`) | Binds the link host per reach and returns its URLs |
| `fakeGateway`, `openclawContract`, `startModelStub`, `useModelStub` (`./testing`) | In-memory Gateway, the contract suite and the scripted model for tests |

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

## Status

In development and not published (`private: true`). Signatures are frozen (docs/runtime-kits.md §5).

## Links

- [byokit](../../README.md), the repo root
- [docs/runtime-kits.md](../../docs/runtime-kits.md), the binding spec for this kit (§5)
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
