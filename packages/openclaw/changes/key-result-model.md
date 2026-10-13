FIX: `addKey` now returns a typed `{ status, reason? }` result instead of a string, distinguishing provider auth refusal, unknown models, network failure, engine failure and busy without returning diagnostics or secrets. Use `result.status` to migrate.

FIX: Key-agent creation now waits for the engine's published roster before activation, using the same lifecycle boundary as member creation.

FIX: `addKey` accepts a catalog `model` and saves it for key-lane runs; `models(member, { authChoice })` lists the route's existing live catalog (engine discovery before a key is available), including Go Muse.
