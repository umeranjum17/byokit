# @byokit/machine

The person's own always-on cloud computer for an app's host process: the kit puts the host on a
computer the person rents on their own account, keeps it running, and says what it costs them, as
their own bill. The person-facing words say "your cloud computer". Nothing here names a machine
provider: the app passes the provider's address, a label to show, and dated price rows
([spec](../../docs/machine-kit.md)).

```ts
import { machine, estimate, stateWords } from '@byokit/machine';

const m = machine({ provider, store });
const ref = await m.create({ name: 'tracker', size: 'small', keepCopies: true });
await m.install(recipe);
await m.state(); // 'on'
```

`machine()` decides where the app's host process runs; the app's one runtime kit
(`@byokit/openclaw` or `@byokit/herdr`) runs inside that process exactly as it does at home.
Model sign-in happens on the machine, inside the aggregator — credentials are never copied from
the person's computer. One person, one provider account, one machine per app install.

Entries: `.` is portable (Node, Electron, React Native); `./ssh` is Node only (an already-rented
Linux machine over the `ssh` binary the app passes by absolute path); `./idle` runs on the machine
inside the host process; `./testing` is Node only (the fake provider and the contract suite).

**Status: in development.** This is the M1 scaffold ([spec](../../docs/machine-kit.md) §14):
frozen types, words, pure parts (`renderUnit`, recipe checks, node argv, cost), `machine()` for
§5.1–5.5 and §5.7, the fake provider and the contract suite. `install`, `update`, `host`, `logs`
and `deliver` check their arguments, then throw `not built: M3`; the sandbox API adapter lands in
M4, the SSH VM adapter in M2, sleep-and-wake in M7, account link in M8. The package stays private
until the recorded real-provider run (M6).

The library reads no environment variable. Every spawned process gets an env built from nothing.
