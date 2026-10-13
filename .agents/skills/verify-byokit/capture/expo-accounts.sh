#!/bin/sh
# The caller holds the private emulator/heavy locks and memory gate for this whole run.
set -eu
root=$(git rev-parse --show-toplevel)
serial=${1:?usage: expo-accounts.sh <private-emulator-serial> <absolute-evidence-dir> [base-ref]}
evidence=${2:?absolute private evidence directory required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
mkdir -p "$evidence"
cd "$root"
adb -s "$serial" shell wm size 960x1920
adb -s "$serial" shell wm density 480
adb -s "$serial" shell settings put system font_scale 1.3
adb -s "$serial" shell settings put secure stylus_handwriting_enabled 0
if [ -n "${3:-}" ]; then
  cp examples/expo/App.tsx "$evidence/candidate-App.tsx"
  trap 'cp "$evidence/candidate-App.tsx" "$root/examples/expo/App.tsx"' EXIT
  git show "$3:examples/expo/App.tsx" > examples/expo/App.tsx
  EXPO_ACCOUNTS_EVIDENCE="$evidence" EXPO_ACCOUNTS_STAGE=before sh examples/expo/e2e-android.sh "$serial"
  cp "$evidence/candidate-App.tsx" examples/expo/App.tsx
  trap - EXIT
fi
EXPO_ACCOUNTS_EVIDENCE="$evidence" sh examples/expo/e2e-android.sh "$serial"
printf '{"feature":"expo-accounts","device":"%s","themes":["light","dark"],"widthDp":320,"fontScale":1.3,"beforeRef":"%s","absent":["before account picker: not implemented on base","desktop/web: native phone surface","iOS runtime: not qualified on Linux"],"recording":"picker-motion.mp4"}\n' "$serial" "${3:-not requested}" > "$evidence/manifest.json"
