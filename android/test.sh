#!/usr/bin/env bash
# Runs byokit-android's tests in a throwaway HOME and checks its canaries byte for byte.
# Only the task's decoy HOME is scanned; the owner's private directories are never read.
# Usage: ./test.sh            JVM tests
#        ./test.sh <serial>   JVM tests, then the instrumented tests on that device or emulator
set -euo pipefail
cd "$(dirname "$0")"
real_home=$HOME
decoy=$(mktemp -d)
cleanup() { rm -rf "$decoy"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for d in .pi/agent .codex .claude; do
  mkdir -p "$decoy/$d"
  echo '{"canary":"do not read"}' > "$decoy/$d/auth.json"
done

tree_hash() { # a folder's paths and contents inside the task's decoy HOME
  [ -d "$1" ] || { echo absent; return; }
  (cd "$1" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) | sha256sum | cut -d' ' -f1
}
canaries() { for d in .pi .codex .claude; do tree_hash "$decoy/$d"; done; }
before_decoy=$(canaries)

tasks=(:byokit-android:testDebugUnitTest)
[ $# -gt 0 ] && export ANDROID_SERIAL=$1 && tasks+=(:byokit-android:connectedDebugAndroidTest)
HOME=$decoy ANDROID_USER_HOME=$decoy/.android GRADLE_USER_HOME=${GRADLE_USER_HOME:-$real_home/.gradle} \
  ./gradlew --no-daemon -q "${tasks[@]}"

after_decoy=$(canaries)
[ "$before_decoy" = "$after_decoy" ] || { echo "FAIL: the decoy HOME's canaries changed"; exit 1; }
echo "ok: tests passed; decoy HOME's canaries unchanged"
