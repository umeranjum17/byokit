#!/bin/sh
# Live native proof: add an OpenCode Go account on the Expo example by pasting the plan key. The caller owns the private
# emulator, memory gate and device/heavy locks. The key is read in place from the OpenCode CLI's own sign-in database
# into this process's environment only (never argv, a file or a log); the evidence is leak-checked against it.
set -eu
root=$(git rev-parse --show-toplevel)
serial=${1:?usage: expo-go.sh <private-emulator-serial> <absolute-evidence-dir> [workspace-name]}
evidence=${2:?absolute evidence directory required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
db=${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}
BYOKIT_GO_KEY=$(sqlite3 -readonly "$db" 'select access_token from account where id = (select active_account_id from account_state)')
[ -n "$BYOKIT_GO_KEY" ] || { echo 'no OpenCode console login to read' >&2; exit 1; }
printf 'key: %s...%s (%d chars)\n' "$(printf %s "$BYOKIT_GO_KEY" | cut -c1-4)" "$(printf %s "$BYOKIT_GO_KEY" | rev | cut -c1-4 | rev)" "${#BYOKIT_GO_KEY}"
export BYOKIT_GO_KEY BYOKIT_GO_WORKSPACE="${3:-}"
mkdir -p "$evidence"
a() { adb -s "$serial" "$@"; }
a shell wm size 960x1920
a shell wm density 480
a shell settings put system font_scale 1.3
cd "$root"
status=0
EXPO_GO_EVIDENCE="$evidence" sh examples/expo/e2e-android.sh "$serial" > "$evidence/drive.txt" 2>&1 || status=$?
cat "$evidence/drive.txt"
if printf "%s\n" "$BYOKIT_GO_KEY" | grep -rqF -f - "$evidence"; then echo 'FAILED, the key reached the evidence' >&2; exit 1; fi
echo 'ok: leak check, the key is nowhere in the evidence'
exit "$status"
