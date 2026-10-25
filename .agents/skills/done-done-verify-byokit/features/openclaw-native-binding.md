# Durable native binding (K1 slice 2, K2 routing)

Surface: `packages/openclaw/src/accounts.ts` (`add`, `build`, `remove`), `signin.ts` (bound drive), `engine.ts` (`nativeBound`, `doctorContext`), `native-env.ts` (the published folder table), `runs.ts` (admission of a bound row), built public `@byokit/openclaw`.

## Drive and capture

After building and committing, run `done-done run openclaw-native-binding`; add `-- node .agents/skills/done-done-verify-byokit/capture/openclaw-native-binding.mjs --gates` for one sealed run that also records the CI-matching gates.
The capture adds two `anthropic-cli` accounts with `credentialPolicy: 'in-place'` over the fake gateway and a fake `claude` that signs in per `CLAUDE_CONFIG_DIR`. It checks two distinct native folders, that each index entry holds only `{kind, cliAccountId, cli}`, listing and `accountStatus` through the binding (B signed out in its folder reads signed out, A stays ready), a cancelled re-auth keeping B's binding, removal logging out B's folder only, and that the engine sealed and activated nothing. For K2 it also checks the published table (`native/env.json`, named by `BYOKIT_NATIVE_ENV`): one row per account agent holding a CLI name and that account's own folder and nothing else, that a slow probe on A leaves B ready and both bound, that a signed-out or probed account keeps its row, and that removing B drops B's row.

Evidence: `native-binding.log`, `steps.json`, `summary.txt` and (with `--gates`) `checks.log`, all from the same done-done run. No screen exists for this SDK-only surface.

## Boundaries

Proves the account entry's binding, its list/status/re-auth/logout, and the folder table the pinned engine reads. The engine child itself (its `CLAUDE_CONFIG_DIR`, the cleared conflicting keys, reuse, a per-account limit) needs the pinned engine and is held by `packages/openclaw/test/engine/native-binding.test.ts` (`npm run test:engine`), not by this capture. It does not prove principal duplicate or mismatch for native rows, keyring separation, installed-origin binding or simultaneous runs.
