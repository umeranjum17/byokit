FIX: `addKey` now returns a typed `{ status, reason? }` result instead of a string, distinguishing provider auth refusal, unknown models, network failure, engine failure and busy without returning diagnostics or secrets. Use `result.status` to migrate.

FIX: Key-agent creation waits for the published roster before activation. `addKey` now waits for catalog synchronization and prepares the full-catalog owner once before success; preparation failures clear the attempted key and return a secret-safe `retry`/`engine`. Ordinary runs do not gain a cold refresh.

FIX: `addKey` accepts a catalog `model` and saves it for key-lane runs; `models(member, { authChoice })` lists the route's existing live catalog (engine discovery before a key is available), including Go Muse.
