# @byokit/herdr

Drive the Herdr already on this computer — workspaces, tabs, panes, coding agents and blocked-approval answers —
from an app, or hand it to a phone over [`@byokit/link`](../link). Each agent inside Herdr keeps its own
subscription login; the kit never sees a credential.

Two ways in: `adopt` talks to the socket path the app passes (the person's own Herdr, nothing spawned, nothing
written), `own` runs the Herdr binary the app names in an app-owned state directory. Helpers cover the common
paths (start an agent, deliver a prompt with a receipt, watch blocked agents, exact closes); `call` and
`subscribe` are typed pass-throughs to the complete socket API, and `cli()` reaches the full CLI.

**Status:** pinned to Herdr v0.9.1 — the schema snapshot (`schema/herdr-api-0.9.1.json`,
protocol 22) generates the typed surface (`src/generated/`, `HERDR_PROTOCOL` in `src/constants.ts`).
See [docs/runtime-kits.md](../../docs/runtime-kits.md) §11.3 for the work packages.

Herdr itself is not an npm dependency; the app installs it (see herdr.dev) and passes `bin`. The kit reads no
environment variables, spawns processes with an explicit env only, and — like every byokit package — never
touches a person's other AI tools; its tests run against a fake Herdr.

`start()` is non-fatal: if Herdr is down it rejects (state `failed`, e.g. `failed/socket`) and may be called
again afterwards, so the host comes up while Herdr is down by retrying `start()` in a backoff loop.
