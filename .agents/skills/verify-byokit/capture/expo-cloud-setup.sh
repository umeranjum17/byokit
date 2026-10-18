#!/bin/sh
# Native proof for the phone cloud-key setup (features/cloud-setup-phone.md).
# The caller owns the private emulator, memory gate and device/heavy locks.
# The pasted value is a fixture key the fake provider rejects; it never reaches
# a log or a screenshot (the input clears on submit, before every capture).
set -eu
root=$(git rev-parse --show-toplevel)
serial=${1:?usage: expo-cloud-setup.sh <private-emulator-serial> <absolute-evidence-dir>}
evidence=${2:?absolute evidence directory required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
cd "$root/examples/expo"
mkdir -p "$evidence"
app=io.github.umeranjum17.byokit.example
apk=android/app/build/outputs/apk/release/app-release.apk
port=21456
key=${FIXTURE_KEY:?set FIXTURE_KEY to the rejected fixture key (alphanumeric and dashes only)}
a() { adb -s "$serial" "$@"; }
log() { printf '%s\n' "$1" >> "$evidence/drive.log"; }

screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//" | paste -sd'|'; }
field() { screen | tr '>' '\n' | grep "resource-id=\"$1\"" | grep -o 'text="[^"]*"' | head -1 | sed 's/^text="//; s/"$//'; }
# uiautomator reports an empty field's placeholder as its text: assert the key itself is gone, not emptiness.
nocarry() { if field "$1" | grep -qF -e "$key"; then echo 'key text still on screen' >&2; exit 1; fi; }
scroll() {
  size=$(a shell wm size | tail -1 | grep -oE '[0-9]+x[0-9]+')
  w=${size%x*}; h=${size#*x}
  if [ "$1" = down ]; then from=$((h * 3 / 4)); to=$((h / 4)); else from=$((h / 4)); to=$((h * 3 / 4)); fi
  a shell input swipe "$((w / 2))" "$from" "$((w / 2))" "$to" 300
}
seek() {
  for direction in up down; do
    for _ in $(seq 16); do
      screen | grep -q "resource-id=\"$1\"" && return
      scroll "$direction"
    done
  done
  echo "no $1 on screen" >&2; exit 1
}
tap() {
  seek "$1"
  xy=$(screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
  [ -n "$xy" ] || { echo "no $1 on screen" >&2; exit 1; }
  a shell input tap "${xy% *}" "${xy#* }"
}
expect() {
  for _ in $(seq 20); do case "$(words)" in *"$1"*) log "ok: $1"; return;; esac; sleep 1; done
  echo "FAILED, expected \"$1\"" >&2; exit 1
}
start() { a shell am force-stop $app; a shell am start -n $app/.MainActivity >/dev/null; }
fixture() {
  mode=${1:?fast or slow}
  cat > "$evidence/fixture.cjs" <<'NODE'
const http = require('node:http');
const mode = process.env.FIXTURE_MODE;
http.createServer((req, res) => {
  const answer = () => { res.writeHead(401, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":"bad key"}'); };
  if (mode === 'slow') setTimeout(answer, 5000); else answer();
}).listen(21456, '127.0.0.1', () => console.log('fixture ready'));
NODE
  FIXTURE_MODE=$mode nohup node "$evidence/fixture.cjs" > "$evidence/fixture.log" 2>&1 & echo $! > "$evidence/fixture.pid"
  for _ in $(seq 20); do grep -q 'fixture ready' "$evidence/fixture.log" && return; sleep 1; done
  echo 'fixture did not start' >&2; exit 1
}
stopfixture() { pid=$(cat "$evidence/fixture.pid" 2>/dev/null || true); [ -z "$pid" ] || kill "$pid" 2>/dev/null || true; }
trap stopfixture EXIT

: > "$evidence/drive.log"
log "build: EXPO_PUBLIC_BOAT_BASE=http://10.0.2.2:$port release APK"
[ -f "$apk" ] || { echo "missing $apk: build it first" >&2; exit 1; }
a install -r "$apk" >/dev/null
a shell pm clear $app >/dev/null
a shell wm size 960x1920
a shell wm density 480

fixture fast
start
seek cloud-paste
log "entry shows the make-key guidance"
a exec-out screencap -p > "$evidence/entry.png"
tap cloud-connect
expect 'Make a key on the Boat site, then paste it here.'
log "missing: empty paste checks nothing"
a exec-out screencap -p > "$evidence/missing.png"

tap cloud-paste
a shell input text "$key"
a shell input keyevent 111 # close the keyboard so the Connect tap lands while the layout is settled
tap cloud-connect
expect "didn't accept your key"
nocarry cloud-paste
log "unknown-key: rejected key stored nothing, input cleared"
a exec-out screencap -p > "$evidence/unknown-key.png"

stopfixture
fixture slow
start
seek cloud-paste
tap cloud-paste
a shell input text "$key"
a shell input keyevent 111 # close the keyboard so the Connect tap lands while the layout is settled
tap cloud-connect
tap cloud-cancel
expect 'Cancelled. Nothing was saved.'
nocarry cloud-paste
log "cancelled: mid-check cancel saved nothing, input cleared"
a exec-out screencap -p > "$evidence/cancelled.png"

stopfixture
trap - EXIT
start
seek cloud-paste
tap cloud-paste
a shell input text "$key"
a shell input keyevent 111 # close the keyboard so the Connect tap lands while the layout is settled
tap cloud-connect
expect "Can't reach Boat right now. Try again."
nocarry cloud-paste
log "unreachable: dead connection stored nothing, input cleared"
a exec-out screencap -p > "$evidence/unreachable.png"

if grep -rqF -e "$key" --include='*.png' --include='*.log' --include='*.json' "$evidence" 2>/dev/null; then
  echo 'fixture key leaked into evidence' >&2; exit 1;
fi
log "leak check passed"
cat > "$evidence/manifest.json" <<JSON
{"feature": "cloud-setup-phone", "base": "origin/main",
 "files": ["entry.png", "missing.png", "unknown-key.png", "cancelled.png", "unreachable.png", "drive.log", "fixture.log"],
 "skips": ["connected state: no live key on a device; proved by examples/expo/cloud-setup.test.ts",
  "claim refused/expired: this card has no claim flow yet; claim() itself is proved by features/cloud-claim.md"]}
JSON
log "done"
