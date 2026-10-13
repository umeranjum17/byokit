# Expo account list and model picker

A provider's card lists its saved accounts through `useAccounts` and uses `useModelPicker` for Auto, explicit account/model choices, and refusal words. Ask uses the kit-resolved account and model, never a fallback from an unavailable explicit choice. Without a usage reader the list honestly says room is unknown.

## Sub-features

- Account rows named by their kit sign-in label, ready rows before unavailable rows, plain readiness and room words.
- Expand/collapse the picker; Auto carries the kit's reason, explicit accounts expose their models, and the chosen model is passed to both the answer and decision calls.
- A remotely revoked short-lived fixture grant remains listed with its kit terminal marker. Choosing it explicitly says `Sign in first`, without substituting Auto.
- Native phone light/dark frames at 320 dp and font scale 1.3; connected before frames, account/picker/refusal after frames, one short real native recording. No desktop, web or native iOS runtime claim.

## How to get to it (user POV)

Open the default Expo example and sign in with ChatGPT. Its Accounts card appears beneath the connected status. Tap Auto to expand the account/model picker, choose an account or model, then Ask. A saved sign-in that has expired remotely stays listed with the reason to sign in again.

## Driving it with node scratch consumers

Build and doctor the workspace per the parent verify skill, then run `cd examples/expo && npm run typecheck && npm run bundle`. Start only the caller's task-owned Android emulator with the fleet's lean flags. Hold the environment's device/heavy locks and memory gate around the complete maintained capture:

```sh
sh .agents/skills/verify-byokit/capture/expo-accounts.sh <private-emulator-serial> <absolute-private-evidence-dir> origin/main
```

The capture runs the unchanged acceptance command `sh examples/expo/e2e-android.sh <serial>` with optional evidence hooks. It builds and installs the real release app, completes the local-fixture pair/sign-in/restart/refresh/answer/sign-out journey, then signs in again for account captures. A short-lived `mockOpenAI()` grant is issued through the built public testing entry. Restarting that local mock removes its valid refresh grants; the app's normal `keepFresh` observes the refusal, and the kit supplies the unavailable row and explicit pick reason. No app-side seed, counterfeit hook rows, or real provider is used.

With the base argument it builds the base App for connected before frames and restores the candidate even on failure. Review every PNG and decoded recording frames. Preserve the full command output and exit code in `e2e-android.txt`, and build/typecheck/bundle output in `test-own.txt`. Stop the private emulator immediately after qualification.

## Gotchas

- The capture temporarily replaces only App.tsx for the baseline build; do not edit it concurrently.
- The baseline has no account picker, so only its real connected card is captured; `manifest.json` names that absence and the unavailable non-phone surfaces.
- `e2e-android.sh` types pairing offers in settled chunks and checks the native field equals the whole offer before dismissing the keyboard. A length mismatch is a failure, not a usable pairing code.
- Evidence stays outside the repository. Screenshots and recording do not prove live provider credentials, billing, quantitative room readings or native iOS behavior.
