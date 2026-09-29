# @byokit/compose

Drafting in a person's voice, without a model call: voice rules, the places a post can go with their length limits,
the brief lines a writer follows, checks on drafts (fits, voice, stock phrasing, kept the facts) and thread splits.
The app or agent writes the drafts; this kit checks them over the pinned public
[`ownvoice-engine`](https://www.npmjs.com/package/ownvoice-engine) package, loaded in process.

It ships a typed client (`new Compose()`), a `compose` agent CLI with plain TOON output, and `./testing` (a fake
engine and a contract suite).

**Status: in development, private.** The client, CLI, fake engine and engine seams are built
([docs/capability-kits.md](../../docs/capability-kits.md) §9.2). The engine's protocol 1 schema is committed in
`schema/engine-protocol-1.json` (sha256 in `ENGINE_SCHEMA_SHA256`) and the typed wire is generated from it
(`npm run gen:compose`).

Real engine: the contract suite runs against `ownvoice-engine` 0.1.0 in CI job `compose-engine`
(`npm run test:compose-engine`), in process and through its own bin. Until the engine is on npm, that job runs it
from its public source at the schema's commit; the kit publishes once the engine is its exact dependency.

Threads come back as the engine writes them, numbered (`1/3 …`).

The kit reads no environment variables, holds no key, makes no network call and writes no file.
