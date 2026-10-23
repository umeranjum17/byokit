# Cloud M6 physical-phone lab journey

The explicit Expo lab screen creates one trial-only Boat machine, installs a small pair host on the machine's loopback, reached through an SSH forward, pairs the physical lab phone, and runs one phone-local agent turn on the phone's Claude plan sign-in whose machine-state tool executes on that cloud host. It then stops/removes its own machine and deletes only the temporary provider key. This bounded journey is not the full two-adapter M6 qualification in docs/cloud-kit.md and never changes package publication status.

## Sub-features

- `cloud-m6-refuse`: no provider key or no existing Claude plan sign-in means no creation. Do not substitute a stand-in, desktop proxy, emulator or new sign-in for the approved physical proof.
- `cloud-m6-trial`: immediately before creation, direct native authenticated limits and a complete machine count establish a zero-price personal trial, remaining subscription credit, no purchased credit, enough runtime/stop reserve, start allowance and at most two machines. The lab stops itself before min(trial remaining, USD 10), keeping a fifteen-minute reserve, so it always ends inside the approved caps. The task's external guard warns at USD 10 and hard-stops (stop and remove) at USD 15. SDK retries must retain the one persisted creation identity.
- `cloud-m6-install-pair`: the Cloud kit installs one clean pinned pair recipe on the machine's loopback (no tailnet, no public port, no relay, no provider URL), and no model/provider credential is installed on the machine. Pair lets the app's SSH module in with Boat's `/sshkey` and dials through `sshResolve`; a build without an SSH module keeps Pair disabled (`examples/expo/cloud-m6-demo.test.ts`). Only one phone may pair; the host handles one bounded machine-state tool call.
- `cloud-m6-turn`: Accounts asks the Claude plan with `tool_choice: auto`, because the plan's strong model refuses a forced `tool`/`any` choice with HTTP 400. The turn still requires exactly one approved tool call, executes it over the real paired link, and feeds its result into the subscription-backed final response, which defines the tool and sets `tool_choice: none`. Two model round trips form one agent turn, not an unrelated decision call. No API-billed substitute.
- `cloud-m6-stop`: stop/remove only this task's machine, then purge/read back the temporary SecureStore key. A failed removal keeps the key and leaves Stop and remove enabled so it can retry; and separately retain fresh account/list/deletion receipts and any continuing storage exposure.

## How to get to it (user POV)

Build the existing native example with `EXPO_PUBLIC_CLOUD_M6=1` and `EXPO_NO_DOTENV=1`, with no EXPO_PUBLIC_OPENAI_BASE override. Normal example behavior stays unchanged without the flag. The device owner unlocks the phone; the PIN is never shared with tooling. This lab-only flag adds a USB shell-write-only ContentProvider pipe. The explicitly approved existing Boat key travels through adb stdin directly into app memory and Expo SecureStore, never argv, a textbox/clipboard, source, computer proxy or a cloud machine. No other credential transfer or sign-in is implied.

## Driving it with node scratch consumers

Native acceptance uses the maintained device capture, not a Node stand-in. Build/prebuild outside the device lock; then hold the home heavy-job lock, memory gate and one device lock for the entire install-to-capture journey:

```sh
flock <authorized-heavy-jobs.lock> <memory-gate> \
  <device-lock> <device-serial> \
  python3 .agents/skills/done-done-verify-byokit/capture/cloud-m6.py \
  <device-serial> <candidate-app-release.apk> <absolute-task-evidence-dir> <explicitly-approved-existing-key-file>
```

`<memory-gate>`/`<device-lock>` are the caller's optional wrapper scripts (for example a `MEM_GATE` env var); run the command directly when none are configured.

Only paths, never credential values, enter argv. The capture records the missing-key screen and the ready/create/install/pair/agent/stop screens. It also makes one silent native recording of pair → agent turn → stop where the phone supports it: screenrecord hangs on some phones, and then the screenshots are the proof. On a miss it keeps the lab screen's words and the lab's `M6 diagnostic` log line (call, HTTP status, kind, reason, credential-redacted detail). The lab's Check Claude (no machine) button sends the turn's first Claude call alone, with no Boat key and no machine, to read a failure's cause cheaply. It preserves measured install/key-bootstrap → pairing boundaries in manifest.json; it does not pretend to measure owner signup or the prior manual unlock duration. Source build time is separate. ffprobe validates the recording container when there is one. Inspect every screenshot and decoded recording frames before reporting acceptance.

The command has no money-action retry, sign-in, permission grant, uninstall or personal-app action. A missing model sign-in is a blocker before key import/create. Each adb call names the device serial. Safe guard/cleanup account reads belong to the authorized task home, not ambient credentials. In an offline source rehearsal, execute the clean M6 host program against built public pair/relay entries and Accounts with the repo's mockOpenAI; label that explicitly a loopback rehearsal, never physical/provider proof.

## Gotchas

- Paid billing/overage, a second creation identity, missing trial allowance, unknown mutation or new model sign-in requires the lead, not a guessed retry. The distinct random recipe name confines kit snapshot cleanup to this task.
- The receiver is registered only in the explicit M6 native build. It rejects all credential reads and callers other than USB shell. An empty approved USB write deletes only the lab provider key even while a model/install action is awaiting I/O; UI readback is boolean-only. The lab keeps its own window awake for the journey, then capture stops only this lab-app process without clearing its existing model/account data.
- Relaunch behaviour: after an app relaunch with a stored machine record and key, the lab stops and removes that machine on the watchdog's first tick, about 15 s after launch (fail-closed for cost).
- Key-removal override: the lab's on-screen 'Remove lab key' button and an empty approved USB write both delete the Boat key even while a machine record exists. After that the lab can no longer stop that machine, so the task's external guard must remove it with its own key.
- The screen also conservatively stops on expiry, lost guard reads, budget/credit reserve or a twenty-minute run deadline. The task's independent guard and ownership journal must exist before the real run; a UI timer alone is not a surviving watchdog.
- Source/model errors or capture interruption never qualify the journey. Retain its resource identity and original limits for authorized own-machine recovery; do not delete other resources. A key-removal failure remains a security blocker. Provider deletion acceptance does not by itself prove all disk objects were purged.
- The lab has one fixed light layout. Do not manufacture web/dark-mode proof or count a fixtures-only run as M6. All media stays outside the repository. B2 provider bootstrap, B3 installed-app incoming-link handling, signing/publication and Herdr lifecycle are outside this journey.
