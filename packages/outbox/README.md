# @byokit/outbox

A durable outbound message queue: messages wait in a file, every change is bound to a revision, and a
message can be taken back until the moment it is handed to the sender. The kit is named for the capability
(outbox); like every unpublished kit its name is confirmed with the owner before a first publish
([docs/kit-conventions.md](../../docs/kit-conventions.md) §1.2).

Node host side, private at 0.1.0. It ships **no sender and no transport**: the app passes the sender, and
every kit test uses a fake. The store is one JSON file, written atomically and fsynced, under
`stateDir/outbox/entries.json` (directory 0700, file 0600).

## The boundary, stated honestly

The irreversible boundary is the **invocation of the sender** — the real send — not any earlier durable
mark. Each send is two serialized steps:

1. the **claim**: `queued` → `sending`, fsync-durable (so a crash can never lose the fact that a send was
   attempted);
2. the **arm step**: one critical section that re-checks the entry at the claimed revision and then invokes
   `sender.send` — nothing can interleave between that last check and the invocation.

Everything follows from that:

- A cancel the kit accepts (`ok: true`) means the sender is **never invoked** for that message. Not
  "probably not": the winning window runs from `queued` all the way to the arm step — a cancel accepted
  after the claim is durable but before the invocation still wins, and the arm step skips the send.
- A cancel that loses returns `{ ok: false, code: 'too-late' }`: the sender was already invoked (or the
  message settled). Never a false success, never a fabricated boundary.
- A message left `sending` by an interrupted process has an **unknown** outcome: cancel answers
  `{ ok: false, code: 'unknown' }` (the kit cannot know whether it went), reopening never redispatches it
  (no invented exactly-once), and `resolve` records what the app itself learned from the transport.
- Every mutation carries the entry revision the caller observed. An older revision rejects with
  `stale-revision` (with the current revision in `detail.current`), so a screen can never act on a message
  it is no longer showing. A cancel request that merely *arrives* is not *accepted*: only the
  revision-checked acceptance stops the send.
- `sent` means "the sender resolved", nothing more; the kit never claims delivery.

Because the sender is invoked inside a serialized step, a `send` that does slow synchronous work before
returning its promise holds up other queue operations for that time.

## Use it

```ts
import { Outbox, type OutboxSender } from '@byokit/outbox';

// The app owns the transport. Invoking send() is the irreversible boundary.
const sender: OutboxSender = {
  send: async (job) => ({ accepted: true, id: job.id }), // your SMTP client, API, queue…
};

const outbox = await Outbox.open({ stateDir: '/var/lib/myapp', sender });
const entry = await outbox.enqueue({ kind: 'email-reply', payload: { to: 'a@example.org', body: 'Hi' } });

// The person hit "take it back" while the message is still queued: this wins.
const result = await outbox.cancel(entry.id, { revision: entry.revision });
if (!result.ok) {
  // Too late: the message was already handed to the sender. Show that honestly.
  console.log('already on its way');
}

// Drain: claims in enqueue order, fsyncs each claim, invokes the sender, records each outcome.
const drained = await outbox.flush();
for (const sent of drained.sent) console.log('sent', sent.id, sent.receipt);
for (const failed of drained.failed) console.log('failed', failed.id, failed.failure);

await outbox.close();
```

A queue without a `sender` parks: enqueue and cancel work, `flush` rejects `unavailable`.

## API

| member | what it does |
|---|---|
| `Outbox.open({ stateDir, sender?, now?, log? })` | Open or create the store. A malformed store rejects `invalid`; it is never reset. |
| `enqueue({ kind, payload }, { signal? })` | Queue a message. `payload` must be JSON; it is stored as its JSON round-trip and the kit never reads it. Returns the entry (`revision: 1`). |
| `get(id)` / `list()` | Snapshots of the last persisted state, in enqueue order. |
| `cancel(id, { revision })` | `{ ok: true, entry }` while queued **or claimed-not-yet-invoked** — the sender will never see it; `{ ok: false, code: 'too-late' }` once the sender was invoked or the message settled; `{ ok: false, code: 'unknown' }` for a send interrupted by an earlier process; rejects `stale-revision` for an older revision, `not-found` for a missing id. |
| `flush({ signal? })` | Send every queued message in order, one claim at a time, through the two serialized steps above. Sender rejections are recorded as `failed` and never retried by the kit. `signal` stops further claims; an in-flight send still records its outcome before the call rejects. |
| `resolve(id, { revision, outcome, receipt?, failure? })` | Record what the app learned about an interrupted (`sending`) message: `sent` or `failed`. Only `sending` entries accept it. |
| `close()` | Stop accepting work. A send already handed to the sender still records its outcome. |
| `OutboxError` with `code` | `invalid` (bad stored data or non-JSON payload), `io` (the store could not be saved), `not-found`, `stale-revision`, `unavailable` (no sender, or closed). |
| `WORDS` / `words` / `errorWords` / `cancelWords` / `stateWords` | Person-facing sentences, one per code and state (docs/kit-conventions.md §9). After a restart, an entry that is `sending` has an unknown outcome: show `words('outbox.unknown')` for it. |

## Cancellations and races

All state changes are serialized inside one queue: a cancel and a claim cannot interleave. When both are
in flight in the same tick, whichever registers its step first on the queue wins, deterministically —
the tests pin both orders. A cancel that observes `queued` always wins; a cancel that observes `sending`,
`sent`, `failed` or `cancelled` (at the current revision) returns `too-late`.

## What it deliberately does not do

- No retries, scheduling or backoff: a `failed` message stays failed; the app decides what to enqueue next.
- No multi-process coordination: one process owns a `stateDir` at a time. A second live `Outbox` on the same
  files is an app bug (last writer wins), not something the kit detects.
- No size management: the store is rewritten whole per change (`ponytail:` fine for thousands of small
  messages; move to an append log if it grows), and entries are never pruned by the kit.
- No delivery, read or bounce semantics: `sent` is a resolved `send` call, nothing more.
