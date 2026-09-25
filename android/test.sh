#!/usr/bin/env bash
# Runs byokit-android's tests in a throwaway HOME and proves nothing outside it was touched:
# canary ~/.pi, ~/.codex and ~/.claude in the decoy HOME, and the real ~/.pi (minus what live agents write), byte for byte.
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

tree_hash() { # a folder's paths and contents, minus paths matching $2
  [ -d "$1" ] || { echo absent; return; }
  (cd "$1" && find . -type f ! -regex "${2:-^$}" -print0 | sort -z | xargs -0 -r sha256sum) | sha256sum | cut -d' ' -f1
}
live='.*/\(sessions\|pi-hermes-memory\|projects-memory\)/.*\|.*\.sqlite\(-shm\|-wal\)?'
canaries() { for d in .pi .codex .claude; do tree_hash "$decoy/$d"; done; }
before_decoy=$(canaries)
before_pi=$(tree_hash "$real_home/.pi" "$live")

tasks=(:byokit-android:testDebugUnitTest)
[ $# -gt 0 ] && export ANDROID_SERIAL=$1 && tasks+=(:byokit-android:connectedDebugAndroidTest)
HOME=$decoy ANDROID_USER_HOME=$decoy/.android GRADLE_USER_HOME=${GRADLE_USER_HOME:-$real_home/.gradle} \
  ./gradlew --no-daemon -q "${tasks[@]}"

after_decoy=$(canaries)
after_pi=$(tree_hash "$real_home/.pi" "$live")
[ "$before_decoy" = "$after_decoy" ] || { echo "FAIL: the decoy HOME's canaries changed"; exit 1; }
[ "$before_pi" = "$after_pi" ] || { echo "FAIL: ~/.pi changed"; exit 1; }
echo "ok: tests passed; decoy canaries and ~/.pi unchanged ($after_pi)"
