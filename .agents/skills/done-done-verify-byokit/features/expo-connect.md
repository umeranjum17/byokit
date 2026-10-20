# Expo phone connect routes

The native example lists every phone sign-in in `accounts.providers`, grouped by `useConnect`, without a fixed provider-key union or fixed cards. ChatGPT keeps the original native selectors. Other providers use prefixed selectors; the existing ask demo remains limited to ChatGPT and Claude.

## Sub-features

- Catalogue method and billing words, with every offered phone provider visible in the grouped list.
- The existing ChatGPT device-code → connected → restart → refresh → answer → sign-out journey.
- `EXPO_PUBLIC_DEVICE_BASE` supplies the device-flow fixture base. `EXPO_PUBLIC_CLAUDE_BASE` supplies `/oauth/authorize`, `/v1/oauth/token` and `/api/oauth/profile`; unset overrides leave kit defaults intact.
- Native before/after frames in light/dark, 320 dp width and font scale 1.3. No physical-phone or live-provider claim.

## How to get to it (user POV)

Open the default Expo example, scroll through Plans, and choose a provider's Sign in button. ChatGPT shows a code; Claude offers its own page and a pasted code. Close returns to the route list.

## Driving it with node scratch consumers

Build and doctor the workspace per the parent verify skill, then `cd examples/expo && npm ci && npm run typecheck && npm run bundle`. Metro resolves the built package exports. Run the existing native journey on a task-owned emulator under the environment's device/heavy locks and memory gate:

```sh
sh .agents/skills/done-done-verify-byokit/capture/expo-connect.sh <private-emulator-serial> <absolute-private-evidence-dir> origin/main
```

The capture invokes `examples/expo/e2e-android.sh`, which builds/installs the actual release app and uses only the local OpenAI fixture and local pair host. The optional final argument builds the base App for before frames, restoring the candidate on exit. Candidate captures derive their row selectors from the built Accounts provider list. Check every PNG visually; preserve the command log and failures. Capture code/connected frames with the same maintained e2e path. Check unset-endpoint defaults separately against built Accounts without contacting vendors; an offline intercepted request proves URL selection, not a vendor sign-in.

## Gotchas

- Only the caller's private emulator is authorized; every adb command includes its serial. Start it with the environment's lean flags, wait for `sys.boot_completed=1`, stop it immediately after this recipe.
- Proof lives outside the repository. Before frames are the old native app (which had only light styling), not an invented dark baseline.
- The capture temporarily swaps only App.tsx for the baseline build; do not edit the candidate concurrently. Failed baseline builds restore it.
- Other device routes are visible, but their live vendor flows, credentials, billing and native iOS execution are not qualified here. Bundles are not device proof.
