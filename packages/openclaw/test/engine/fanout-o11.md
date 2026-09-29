# O11 fan-out proof (2026-09-29, retained test sign-in, exclusive slot)

Bounded 8-way fan-out on the pinned engine (2026.8.1, protocol 4): one sequential small-prompt run vs
8 parallel runs of the same prompt (`Say OK <tag> and nothing else`), driven at transport level
(`agent` + `agent.wait`) against a gateway spawned in place on the retained signed-in state. No product
code: the lab scripts live outside the repo; this file is the record.

- Sign-in found on agent `m1` only (openai + openai-codex OAuth, status ok, ~8d expiry); `main`, `m2`, `m3`
  report no providers. An initial probe as `main` ended signed-out (`No route-compatible authentication
  source is configured for openai`); the lab reran as `m1`.
- Sequential: 6260 ms, `status: ok`, `stopReason: stop`.
- 8-way wall: 5371 ms (par0 5371, par1 4875, par2 5095, par3 5289, par4 5334, par5 3522, par6 4822,
  par7 5165), every run `status: ok`, `stopReason: stop`.
- No resting and no rate-limit in any of the 9 runs, so no early stop was triggered.
- The kit connected with the paired `{ deviceId, publicKeyPem, privateKeyPem }` device.json shape
  (hello 371 methods): the O11 transport fix working on the retained state itself.
- State left as found: gateway stopped, pidfile restored to the stale bytes, port free, no files copied,
  no sign-in/out, no device codes. Nine `agent:m1:o11:fanout:*` sessions remain in the retained store.
