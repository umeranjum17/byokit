# @byokit/nats

A local message bus for an app: the pinned, hash-checked `nats-server` as one supervised child on loopback behind a
token with JetStream on, plus publish and durable readers with explicit acks. Node and Electron only. The kit knows no
subjects and no policy; the app names its streams, subjects and durables.

## Use it

```ts
import { ensureNats, NatsBus } from '@byokit/nats';

const server = await ensureNats({ stateDir: '/abs/app/state' }); // downloads NATS_VERSION once, checks its sha256
const bus = await NatsBus.open({ url: server.url, token: server.token });
await bus.ensureStream({ name: 'APP', subjects: ['app.>'] });

await bus.publish('app.hello', 'hi', 'msg-1'); // a repeated id inside the duplicate window is reported, not stored twice
const reader = await bus.reader('APP', 'worker', { filter: 'app.>' }, async (m) => {
  console.log(m.subject, new TextDecoder().decode(m.data));
  await m.ack(); // nothing is acked for you: an unacked message comes again after ackWaitMs
});

await reader.stop();
await bus.close(); // stops its readers (bounded to 5 s) and closes the connection
await server.stop();
```

## What it promises

- **Pinned and checked.** `NATS_VERSION` and `NATS_ASSETS` name the release archive per platform (linux and macOS,
  x64 and arm64) and its SHA-256. Nothing downloads on install or import; `ensureNats` downloads when no `bin` is passed,
  refuses a hash mismatch (`checksum-failed`) and keeps nothing from it. It never uses a `nats-server` from `PATH`.
- **One server per store.** The port and token are saved under `<stateDir>/nats` (folders 0700, files 0600) and never
  re-picked. A server an earlier process left running is adopted (`started: false`); a second is never started while the
  first answers; a port taken by another program is `port-taken`, never moved. `server.stop()` signals the saved pid only
  while its command line still names the binary.
- **Loopback and a token.** The server listens on 127.0.0.1 only and runs with an empty environment. `sync_interval:
  always` means an acked publish survives a crash.
- **Explicit acks, replay, no hangs.** A reader is durable: it resumes where it stopped and sees messages published while
  it was away. A handler that throws hands the message back after a second. `reader.stop()` and `bus.close()` return within
  five seconds even if a handler never settles or the server is gone, so a stuck reader never keeps the process alive.
- **Errors in words.** Failures are `NatsError` with a kebab-case `code`; `errorWords(e)` gives the sentence to show.

## Testing

Tests need no network. Download tests serve a loopback fixture. The real-server tests run only when `BYOKIT_NATS_BIN`
names a nats-server; CI fetches the pinned one first with `node scripts/fetch-nats.ts <dir>`.

## Licence

This kit is Apache-2.0 (see `LICENSE`). Its dependencies `@nats-io/transport-node` and `@nats-io/jetstream` 3.4.0 and the
`nats-server` binary it runs (2.15.2) are Apache-2.0 too: permissive, no copyleft duties; the server's licence text is at
github.com/nats-io/nats-server/blob/v2.15.2/LICENSE.
