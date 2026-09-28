# @byokit/herdr

Drive the Herdr already on this computer — workspaces, tabs, panes, coding agents and blocked-approval answers —
from an app, or hand it to a phone over [`@byokit/link`](../link). Each agent inside Herdr keeps its own
subscription login; the kit never sees a credential.

Two ways in: `adopt` talks to the socket path the app passes (the person's own Herdr, nothing spawned, nothing
written), `own` runs the Herdr binary the app names in an app-owned state directory. Helpers cover the common
paths (start an agent, deliver a prompt with a receipt, watch blocked agents, exact closes); `call` and
`subscribe` are typed pass-throughs to the complete socket API, and `cli()` reaches the full CLI.

**Status: in development** — this is the H1 scaffold ([docs/runtime-kits.md](../../docs/runtime-kits.md) §11.3):
types, signatures and words are frozen, behavior lands work package by work package. `HERDR_PROTOCOL` is a
placeholder until the v0.9.1 schema snapshot is captured (H2).

Herdr itself is not an npm dependency; the app installs it (see herdr.dev) and passes `bin`. The kit reads no
environment variables, spawns processes with an explicit env only, and — like every byokit package — never
touches a person's other AI tools; its tests run against a fake Herdr.
