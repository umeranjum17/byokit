# @byokit/openclaw

The OpenClaw runtime kit: the pinned OpenClaw engine (`openclaw@2026.8.1`, protocol 4) driven through one kit object,
with the aggregator's full operator surface preserved as typed pass-through calls (`call` for every operator method,
`callDynamic` for the rest) plus plain-words helpers for members, sign-in, runs, approvals and config.

**State: in development.** Signatures are frozen (docs/runtime-kits.md §5); implementation bodies land package by
package and refuse with `not built: <package id>` until then.

Entries:

- `.` — the host side: `OpenClawKit`, engine supervision, config invariants, approvals (Node).
- `./device` — the portable client for phones and browsers (no Node imports).
- `./link` — the host-side `@byokit/link` adapter: member-checked ops, sealed approval push (Node).
- `./testing` — `fakeGateway`, the `openclawContract` suite and the scripted model stub.

The kit writes only under the `stateDir` the app passes, spawns the engine with an explicit isolated environment
(never `process.env`), reads no environment variables except `PATH` to find `npm`, and never bills an API behind the
person's back (memory search is never a paid provider).

Apache-2.0.
