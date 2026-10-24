#!/bin/sh
# Native proof of the version label at the foot of the Expo example's main screen. The caller owns the private
# emulator, memory gate and device/heavy locks. With a base ref, the same screen's foot is captured from that ref's
# App.tsx first (it had no label); the candidate is restored even on failure.
set -eu
root=$(git rev-parse --show-toplevel)
serial=${1:?usage: expo-versions.sh <private-emulator-serial> <absolute-evidence-dir> [base-ref]}
evidence=${2:?absolute evidence directory required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
cd "$root"
mkdir -p "$evidence"
gate() { if [ -n "${MEM_GATE:-}" ]; then "$MEM_GATE" "$@"; else "$@"; fi; }
if [ -n "${3:-}" ]; then
  cp examples/expo/App.tsx "$evidence/candidate-App.tsx"
  trap 'cp "$evidence/candidate-App.tsx" "$root/examples/expo/App.tsx"' EXIT
  git show "$3:examples/expo/App.tsx" > examples/expo/App.tsx
  EXPO_VERSION_EVIDENCE="$evidence" EXPO_VERSION_STAGE=before gate sh examples/expo/e2e-android.sh "$serial"
  cp "$evidence/candidate-App.tsx" examples/expo/App.tsx
  trap - EXIT
  rm -f "$evidence/candidate-App.tsx"
fi
# What the release build must say: the app manifest's version and the kit it bundles, read from their files.
want=$(node -e "const a=require('./examples/expo/app.json').expo.version,k=require('./packages/accounts/package.json').version;console.log('byokit example '+a+' · @byokit/accounts '+k)")
echo "expect: $want"
EXPO_VERSION_EVIDENCE="$evidence" EXPO_VERSION_TEXT="$want" gate sh examples/expo/e2e-android.sh "$serial"
