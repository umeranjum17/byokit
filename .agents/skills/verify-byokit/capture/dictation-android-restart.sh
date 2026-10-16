#!/bin/sh
# Android dictation restart journey on a private emulator (features/dictation-android-restart.md).
# Run from the worktree root after npm ci and npm run build:
#   sh .agents/skills/verify-byokit/capture/dictation-android-restart.sh <serial> <absolute-evidence-dir> [starved-runs]
# 1. Gradle connectedDebugAndroidTest: the named journey, its logcat kept as journey-logcat.txt.
# 2. starved-runs (default 30) more runs of the same test with system_server pinned to one vCPU that three busy
#    loops keep loaded. Needs adb root (a userdebug image); the loops and the pin are undone on exit.
set -eu
serial=$1 out=$2 runs=${3:-30}
pkg=io.github.umeranjum17.byokit.dictationproof
apks=examples/dictation-android/build/outputs/apk
keep='TestRunner|DictationProof|SpeechRecognitionManagerServiceImpl|RemoteSpeechRecognitionService|ServiceConnector|RecognitionService'
mkdir -p "$out"
ANDROID_SERIAL=$serial ./android/gradlew -p examples/dictation-android --no-daemon connectedDebugAndroidTest > "$out/gradle.txt" 2>&1 \
  || { tail -40 "$out/gradle.txt"; exit 1; }
# AGP names the device folder after the AVD, or after the serial when the AVD name is unknown (CI).
cp examples/dictation-android/build/outputs/androidTest-results/connected/debug/*/logcat-*.txt "$out/journey-logcat.txt"
grep -E 'Finished [0-9]+ tests|BUILD' "$out/gradle.txt"
grep -E 'DictationProof|has opened|Service is unbinding' "$out/journey-logcat.txt"
# Gradle uninstalls both APKs after its run; the starved runs reuse what it built.
adb -s "$serial" install -r -t "$apks/debug/dictation-consumer-debug.apk" > /dev/null
adb -s "$serial" install -r -t "$apks/androidTest/debug/dictation-consumer-debug-androidTest.apk" > /dev/null
adb -s "$serial" root > /dev/null
adb -s "$serial" wait-for-device
server=$(adb -s "$serial" shell pidof system_server | tr -d '\r')
loops=$(adb -s "$serial" shell "taskset -a -p 2 $server >/dev/null; for i in 1 2 3; do nohup taskset 2 sh -c 'while :; do :; done' >/dev/null 2>&1 & echo \$!; done" | tr -d '\r' | tr '\n' ' ')
trap 'adb -s "$serial" shell "kill $loops; taskset -a -p 3 $server >/dev/null"' EXIT
echo "starving system_server $server ($(adb -s "$serial" shell grep Cpus_allowed_list /proc/"$server"/status | tr -d '\r' | tr -s '\t' ' ')) with busy loops $loops"
failed=0 i=0
while [ "$i" -lt "$runs" ]; do
  i=$((i + 1))
  adb -s "$serial" logcat -c
  adb -s "$serial" shell am instrument -w -r -e class "$pkg.DictationFlowTest" "$pkg.test/androidx.test.runner.AndroidJUnitRunner" > "$out/starved-$i-instrument.txt"
  adb -s "$serial" logcat -d -v threadtime | grep -E "$keep" > "$out/starved-$i-logcat.txt" || true
  if grep -q 'OK (1 test)' "$out/starved-$i-instrument.txt"; then r=settled; else r=FAILED; failed=$((failed + 1)); fi
  echo "starved run $i: $r, system sessions opened: $(grep -c 'has opened' "$out/starved-$i-logcat.txt" || true)"
done
echo "starved runs: $runs, failed: $failed"
[ "$failed" -eq 0 ]
