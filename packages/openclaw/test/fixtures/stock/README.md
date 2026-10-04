# Stock byte fixtures for immutable engine unit tests

Exact npm OpenClaw 2026.8.1 bytes named by `engine/patches.json` (`.txt` suffix). `seedInstall` checks each against its manifest `before` SHA-256 before making a fake install. Update from the repo-pinned npm tarball when a semantic entry changes; license: `engine/OPENCLAW-LICENSE`.

These are byte fixtures, never executed and never real-engine proof. Actual crash/restart acceptance uses `test/engine/recovery-probe.ts`; Workshop day accounting uses `test/engine/day-usage.test.ts`. Both use the real Gateway, not these fixtures.
