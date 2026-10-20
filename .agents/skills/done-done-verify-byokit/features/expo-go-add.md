# Expo OpenCode Go paste-key account

The native example lists a provider with no phone sign-in through its plan key route (`useConnect` key row, the
`@byokit/ui` key card), keeps the key in the phone's secure store (`@byokit/secrets` `nativeStore` as `keyStore`) and
adds it with `Accounts.add`. A key that acts for several workspaces gets the key card's `workspace` state: the
workspaces the kit listed are shown and the one picked is stored with the key. The account then reads Ready in the
provider's Accounts list.

## Sub-features

- `go-row`: the OpenCode Go card in Plans, light and dark, at 320 dp width and font scale 1.3.
- `go-paste`: the paste step, empty and after the paste with the key hidden (`secureTextEntry`); the screen's text never holds the key.
- `go-workspace`: with several workspaces, the pick lists their names; the named one is tapped and stored.
- `go-ready`: "OpenCode Go is connected." and the Accounts row "Ready", light and dark, after a restart.

## How to get to it (user POV)

Open the default Expo example, scroll to OpenCode Go in Plans, tap Sign in with OpenCode Go, paste the key from the
plan, tap Connect, pick the workspace if asked.

## Driving it

Build and doctor the workspace per the parent verify skill, then `cd examples/expo && npm ci`. On a task-owned
emulator under the environment's device/heavy locks and memory gate:

```sh
sh .agents/skills/done-done-verify-byokit/capture/expo-go.sh <private-emulator-serial> <absolute-private-evidence-dir> Working2
```

It reads the active OpenCode console login from `~/.local/share/opencode/opencode.db` in place into its own
environment (prints only a mask), runs `examples/expo/e2e-android.sh` with `EXPO_GO_EVIDENCE` (`go-journey.sh`: the
key reaches the phone on adb's stdin, never argv or the screen) and fails if the key appears anywhere in the
evidence. The live calls are the console's workspace listing (one) and nothing else: connecting makes no model call,
so Ready proves the key and workspace were stored, not a turn. Check every PNG visually.

## Gotchas

- Live: needs a real OpenCode Go login and the network on the emulator. Never use backup auth files.
- Only the caller's private emulator; every adb call names its serial. Stop it right after.
- The journey runs alone and exits; the ChatGPT/pair journey is not run in the same pass.
