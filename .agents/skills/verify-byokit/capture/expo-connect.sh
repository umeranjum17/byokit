#!/bin/sh
# Native proof. The caller owns the private emulator, memory gate and device/heavy locks.
set -eu
root=$(git rev-parse --show-toplevel)
serial=${1:?usage: expo-connect.sh <private-emulator-serial> <absolute-evidence-dir> [base-ref]}
evidence=${2:?absolute evidence directory required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
cd "$root"
mkdir -p "$evidence"
a() { adb -s "$serial" "$@"; }
a shell wm size 960x1920
a shell wm density 480
a shell settings put system font_scale 1.3
a shell settings put secure stylus_handwriting_enabled 0
# Capture the same running native screen before the change; restore the candidate even on failure.
if [ -n "${3:-}" ]; then
  cp examples/expo/App.tsx "$evidence/candidate-App.tsx"
  trap 'cp "$evidence/candidate-App.tsx" "$root/examples/expo/App.tsx"' EXIT
  git show "$3:examples/expo/App.tsx" > examples/expo/App.tsx
  EXPO_CONNECT_EVIDENCE="$evidence" EXPO_CONNECT_STAGE=before EXPO_CONNECT_CAPTURE_ONLY=1 \
    /home/umer/firstmate/config/fm-mem-gate.sh sh examples/expo/e2e-android.sh "$serial"
  cp "$evidence/candidate-App.tsx" examples/expo/App.tsx
  trap - EXIT
fi
rows=$(node --input-type=module -e "import {Accounts,portable} from '@byokit/accounts';console.log(new Accounts({app:'native proof'},portable).providers.map(p=>p.key).filter(k=>k!=='chatgpt').join(' '))")
EXPO_CONNECT_EVIDENCE="$evidence" EXPO_CONNECT_ROWS="$rows" \
  /home/umer/firstmate/config/fm-mem-gate.sh sh examples/expo/e2e-android.sh "$serial"
