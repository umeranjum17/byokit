# Durable native binding (K1 slice 2)

Surface: `packages/openclaw/src/accounts.ts` (`add`, `build`, `remove`), `signin.ts` (bound drive), `engine.ts` (`nativeBound`), built public `@byokit/openclaw`.

## Drive and capture

After building and committing, run `done-done run openclaw-native-binding`; add `-- node .agents/skills/done-done-verify-byokit/capture/openclaw-native-binding.mjs --gates` for one sealed run that also records the CI-matching gates.
The capture adds two `anthropic-cli` accounts with `credentialPolicy: 'in-place'` over the fake gateway and a fake `claude` that signs in per `CLAUDE_CONFIG_DIR`. It checks two distinct native folders, that each index entry holds only `{kind, cliAccountId, cli}`, listing and `accountStatus` through the binding (B signed out in its folder reads signed out, A stays ready), a cancelled re-auth keeping B's binding, removal logging out B's folder only, and that the engine sealed and activated nothing.

Evidence: `native-binding.log`, `summary.txt` and (with `--gates`) `checks.log`, all from the same done-done run. No screen exists for this SDK-only surface.

## Boundaries

Proves the account entry's binding and its list/status/re-auth/logout. It does not prove the engine backend using the binding (K2), principal duplicate or mismatch for native rows, keyring separation, installed-origin binding or simultaneous runs.
