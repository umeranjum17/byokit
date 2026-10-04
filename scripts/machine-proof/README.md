# M6 lab runner and app recipes

Nothing runs against a real provider by default. CI executes:

```sh
node scripts/machine-proof/run.ts --dry-run --output .lab/m6-dry.json
```

The same runner uses the loopback Boat adapter and fake SSH binary, registers the entire
`machineContract`, installs an app with M3, records all 21 M6 rows on both adapters,
exercises sleep/resume and a throwaway redundant `noEnv` request, and checkpoints JSON.
The fake never qualifies M6. `scripts/machine-proof.test.ts` also installs all three
recipes on both fake machine types and executes the two-process wrapper with harmless
local Node children to prove child failure stops its sibling. No account or model is needed.

## Live input

After spending approval, run:

```sh
node scripts/machine-proof/run.ts --live --config .lab/m6.ts --output .lab/m6-report.json --record-doc
```

The app prepares a private `.lab/m6.ts` module exporting `LiveConfig` from `live.ts`.
It passes the provider API root (including the version), a file containing its API key,
its dated prices, a clean app release archive, real Node tarball hashes for both Linux
architectures, and the two `AppRecipe` objects. `--live` is explicit consent to the
billable operations; it is never used in CI. No input is taken from ambient credentials
or environment variables. All remote machines must be disposable and app-owned.

The SSH input is the absolute `ssh` binary, host, port, user, private-key path, state
directory, monthly price and **independently verified SHA256 host fingerprint**.
The scanner must match that fingerprint before confirmation. The VM user must have
passwordless sudo for recipes using root dependencies or a dedicated run user. Its home
is passed explicitly; it need not be `/home/user`.

`prepare(session)` uploads only the app's clean, checksum-pinned release archive and
lab-owned setup files using `provider.write`. The archive is readable by the dedicated
run user (0644); it must contain no `.env`, sign-ins, recovery keys or owner state.
The `archive` recipe input is its remote path, beneath the machine user's home. The
archive has one top directory (`tar --strip-components=1`) and a package lock. Runtime
sign-in happens on the new machine, never by copying desktop credential directories.
Persist the app machine ids from the `Session` while preparing it. The runner also
writes contract and app resource ids to `resourcesFile` immediately after creation.

The built-in `probes()` in `probes.ts` supplies WebSocket handshakes, health reachability,
plan fields, raw public-port reachability, disk and cgroup peak-memory observations,
the proxy forged-header probe, a second provider-only shutdown to check SIGTERM, and
an isolated `noEnv` canary experiment. It asks the operator to complete real phone
pairing, the engine device-code sign-in, a representative workload, the provider's
app-sign-in key scope test, and the VM console power cycle. Those confirmations are
recorded as operator evidence. An answer other than `yes` does not pass a functional
check. A paid account without new-account trial evidence cannot qualify the trial row.

An app may override checks with `commands[check]`: a lab remote argv returning exactly
`{"status":"pass|fail|observed|unavailable","detail":"non-secret measured evidence"}`.
For example, use its own workload measurement when the OS cannot report `MemoryPeak`,
its proxy observation for a VM ingress, or its metadata command when `hostname` is not
its provider id. Only facts actually observed belong in `detail`; never output secrets,
sign-in tokens, transport URLs or provider names. These hooks live in the app's lab
module, not portable kit code. All unavailable rows remain visible; required unavailable
rows make qualification false. Trial, sign-in and phone evidence cannot be replaced by
fakes in a live run.

Example wiring (the app supplies the values and locked release; no defaults select a provider):

```ts
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { probes } from '../scripts/machine-proof/probes.ts';
import { crewhouseRecipe } from '../scripts/machine-proof/recipes.ts';
import type { LiveConfig } from '../scripts/machine-proof/live.ts';

const input = /* app-owned, verified lab inputs */;
const question = async (prompt: string) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question(prompt + ' '); } finally { rl.close(); }
};
export default {
  ...input,
  sandboxApp: crewhouseRecipe(input.sandboxRecipeInputs),
  vmApp: crewhouseRecipe(input.vmRecipeInputs),
  resourcesFile: '.lab/m6-resources.json',
  prepare: async session => {
    const bytes = await readFile(input.releaseArchive);
    const path = session.provider.id === 'ssh-vm'
      ? input.vmRecipeInputs.archive : input.sandboxRecipeInputs.archive;
    await session.provider.write(session.ref, path, bytes, 0o644);
  },
  hooks: probes({
    apiRoot: input.providerUrl,
    key: async () => (await readFile(input.apiKeyFile, 'utf8')).trim(),
    vmRelayUrl: input.vmRelayUrl,
    publicAddress: session => input.publicAddress(session),
    ask: question,
    commands: input.appProbeCommands,
  }),
} satisfies LiveConfig;
```

A checkpoint writes atomically after each row. `--record-doc` inserts the final table in
`docs/cloud-kit.md` immediately before M7, even for a failed run, explicitly labelled
**NOT qualified**. The key is redacted from live evidence and errors omit raw transport
text. Review app-provided evidence before committing a recorded run. No script removes
`private`, publishes, changes library provider defaults, or alters M7/M8 decisions.

Contract resources and the scrub sandbox are cleaned automatically. The two app lab
machines are retained for inspection, including when a check fails. Use the app's
recorded refs to remove them explicitly after review; removing only one sandbox does
not remove the other contract/scrub resources after a process is forcibly interrupted.
`m6-resources.json` lists all created sandbox ids for that recovery. Stop the VM's app
and prerequisite units through its own lab console, then delete the disposable VM there.

## App recipes (source read 2026-09-30)

These objects belong to app integration, outside the published package. They do not
change `HostRecipe`. `installApp` starts prerequisite units first and passes each recipe
through M3's own install and unit writer. It keeps every run user's home beneath the
machine user's home, so the app state is included in provider snapshots. Root steps
are idempotent. Do not invoke any desktop setup/autostart command in these recipes.

| App | Current start command | Local state | Exposure and health |
|---|---|---|---|
| Crewhouse | `node src/main.ts`, plus `node relay/main.ts` | `data/state` (SQLite, engine and per-person sign-ins), `data/crew`, `data/tools`, `data/relay` beneath the `crewbot` home | crewd 7711 and direct link 7712 stay loopback; relay 7300 binds `0.0.0.0`; `/health` |
| muxr | built `host.js`, plus `relay.js`; its own isolated Herdr prerequisite runs `<app-passed binary> server` first | `MUXR_HOME=<muxrbot home>/data`, relay `data/relay`, the app-passed runtime workDir and socket | relay 8792 binds `0.0.0.0`; mDNS off; `/health`; host diagnosis uses the app's doctor |
| v1 studio engine | `node --import tsx bin/engine.mjs` | private `.env` in the app workDir; `data` for app-local artifacts; projects/credits in external MongoDB and live events in Upstash | authenticated HTTP/SSE/MCP on 8787; `/health`; currently no link relay or phone pairing ingress |

Crewhouse source: [manifest](https://github.com/umeranjum17/crewhouse/blob/main/package.json),
[config](https://github.com/umeranjum17/crewhouse/blob/main/src/config.ts),
[crewd](https://github.com/umeranjum17/crewhouse/blob/main/src/main.ts),
[doctor](https://github.com/umeranjum17/crewhouse/blob/main/src/doctor.ts),
[relay](https://github.com/umeranjum17/crewhouse/blob/main/relay/main.ts).
`crewhouseRecipe` requires Node >=22.22.3, builds the web UI, installs bubblewrap,
Xvfb, Chromium, ffmpeg, git and Python venv, and supervises the host and relay together.
The relay remains in enrol mode. The app must perform its normal owner enrolment and
persist the public provider relay candidate in its phone-pairing state. A successful
WebSocket upgrade alone does not prove that pairing. Its doctor receives the same
Crewhouse state paths as the host; the state and crew directories are outside the repo.

muxr source: [host config](https://github.com/umeranjum17/muxr/blob/main/apps/host/src/config.ts),
[host](https://github.com/umeranjum17/muxr/blob/main/apps/host/src/main.ts),
[relay config](https://github.com/umeranjum17/muxr/blob/main/apps/relay/src/config.ts),
[current startup](https://github.com/umeranjum17/muxr/blob/main/scripts/setup/presentation/hostUp.mjs).
Read-only local checkout: `/home/umer/.treehouse/pockit-497a78/10/pockit`.
The app supplies a prebuilt Linux release tree with `host.js`, `relay.js`, its lockfile
and diagnostics scripts (its source build also includes mobile/native steps and is not
run on the rented computer). `muxrRecipe` takes a separate pinned Herdr `HostRecipe`,
with `user: 'muxrbot'`, an absolute app-owned binary and `HERDR_SOCKET_PATH` beneath
its workDir. That recipe installs the runtime and M3 enables its own unit before muxr.
The muxr wrapper does not run `hostUp.mjs` (which repairs desktop services and has its
own restart policy). Its child commands start the built host and relay directly.
Provision its selfhost registration and owner-only `selfhost.json` through the app's
normal setup on this machine before first use; copying a desktop file is not setup.
No real Herdr server, socket, CLI or local session is used by this lane's tests.

The engine repository was discovered using `gh-axi repo list umeranjum17`:
[manifest](https://github.com/umeranjum17/v1-design-engine/blob/master/package.json),
[entry](https://github.com/umeranjum17/v1-design-engine/blob/master/bin/engine.mjs),
[HTTP routes](https://github.com/umeranjum17/v1-design-engine/blob/master/src/http/server.ts),
[environment](https://github.com/umeranjum17/v1-design-engine/blob/master/README.md).
`studioRecipe` runs the existing engine, without inventing a phone or link bridge.
Its current deployment requires external MongoDB/Upstash and the app's existing model,
billing and service credentials. They cannot be `run.env` (the kit refuses secret
names); provision an owner-only `.env` on the new machine via the app, and let the
existing `dotenv/config` entry read it. The app must supply those services separately;
this recipe does not provision them or make billed model requests. A relay/link bridge
and subscription-device-code flow for this engine remain app adoption work, not an M6
claim made by this kit. Use Crewhouse as M6's real phone/sign-in app recipe.

G1 account key scope, G2 trial, G3 stop reason, G4 self-id and G10 workload/shutdown
remain recorded proof observations. G5 root steps/Node range, G6 paired child shutdown,
G7 dedicated no-sudo users and G9 secure inbox use the existing M3 implementation.
G8 phone-only VM setup stays out of scope; G11 wake keys wait for M7. Provider and
model credentials never go in recipes or systemd unit files. `trustProxy` stays off
on every relay, including when the proxy-header probe reports a safe result.
