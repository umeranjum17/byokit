# Android dictation restart on the system recognizer

An Android app that drives `@byokit/dictation`'s `systemEngine` through its own native port finishes one dictation and starts the next at once: the second session reaches the recognizer, can be cancelled, and the journey settles with the real `DictationProof` JSON, even when `system_server` is starved. The example bridge (`examples/dictation-android`, `DictationActivity`) keeps one `SpeechRecognizer` for the activity's life, because Android shares one service connection per app and recognition service and a destroyed recognizer's asynchronous shutdown can unbind the connection a recognizer created right after it has just joined.

## Sub-features

- `journey`: `DictationFlowTest.systemRecognizerSettlesAndCancelsThroughThePublishedKit`: a missing language pack reports `needs-download`, the first take settles `hello app` with stable partials, the immediate restart's partial arrives and its cancel reaches the service (`starts=2`, `stops=1`, `cancels=1`), and logcat carries `DictationProof`.
- `one-connection`: the restart keeps the one recognizer service connection: the journey asserts `FixtureRecognizer.connections == 1`, and `system_server` logs one `has opened N sessions` line per journey with no unbind between the two takes.
- `starved-system-server`: with `system_server` pinned to one loaded vCPU, every run still settles with one system session. A destroy-and-recreate bridge fails there when its second session opens before the first is shut down (`has opened 2 sessions` on a fresh boot), then gets `ERROR_SERVER_DISCONNECTED` (11) on the second session and `JavaScript consumer did not complete` after 20 s.

## How to get to it (user POV)

Open the example app on an emulator: its page checks a missing language, dictates "hello kit" (shown as "hello app" after the word replacement), finishes, starts a second dictation and cancels it, then shows the result JSON. A person sees the second dictation start right after the first instead of hanging.

## Driving it with node scratch consumers

No scratch consumer: the maintained instrumentation journey is the drive. After SKILL.md Launch (`npm ci`, `npm run build`) and Doctor, boot a task-owned userdebug emulator (API 35 x86_64; Google APIs and default AOSP images both allow `adb root`) through the environment's memory gate with lean headless flags, and wait for `sys.boot_completed=1`. Then, holding the machine's heavy-job lock for the whole drive:

```bash
feature=dictation-android-restart; entry=examples/dictation-android/src/androidTest/java/io/github/umeranjum17/byokit/dictationproof/DictationFlowTest.java
serial=emulator-NNNN; proof=/absolute/private/evidence/dir   # your emulator; a folder outside the repository
drive=(sh .agents/skills/done-done-verify-byokit/capture/dictation-android-restart.sh "$serial" "$proof" 30)
```

Run SKILL.md Evidence's capture block: exit `0`, `Finished 1 tests on <avd>(AVD) - <api>`, the `DictationProof: {"text":"hello app",…,"cancelCode":"cancelled","missing":"needs-download"}` line and one `has opened 1 sessions` line (freshly booted emulator) from `$proof/journey-logcat.txt`, then `starving system_server <pid> (Cpus_allowed_list: 1) with busy loops …`, `starved run N: settled, system sessions opened: 1` for every run and `starved runs: 30, failed: 0`. Each starved run keeps its filtered logcat as `$proof/starved-N-logcat.txt`. Stop the emulator right after (`adb -s "$serial" emu kill`).

## Gotchas

- Only the caller's private emulator is authorized; every adb command names its serial. The script roots that emulator's adbd and undoes its own load and pin on exit, so kill the emulator rather than reuse it for another lane.
- Unstarved, the restart race rarely fires, so a destroy-and-recreate bridge usually still settles there; the `connections` assertion is what fails it every time (`expected:<1> but was:<2>`).
- `Service is unbinding` or `DeadObjectException` lines after `run finished` are `system_server` cleaning up the killed test process, not the journey; read only the lines before the test's end.
- `N` in `has opened N sessions` is `system_server`'s count for the app since boot. When a test process is force-stopped before its recognizer's posted shutdown arrives, Android 15's death cleanup throws `ConcurrentModificationException` in `RemoteSpeechRecognitionService.shutdown` and skips the decrement, so `N` stays one higher until reboot; later sessions still work. The script counts lines, not `N`.
- Gradle uninstalls both APKs after its run; the script reinstalls what that run built before the starved runs. CI runs the same journey on the default AOSP image (`.github/workflows/ci.yml`, `android` job), without the starved runs.
