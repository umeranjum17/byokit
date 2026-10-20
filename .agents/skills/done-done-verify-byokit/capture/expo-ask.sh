#!/bin/sh
# Ask-box layout proof: signs in against the local stand-in OpenAI on the caller's
# private emulator, sets the system font to its largest scale (2.0), then captures
# the Accounts card (Ask box + Ask button) in light and dark, with ui dumps.
# The caller boots the emulator OUTSIDE any shared lock, holds the private/heavy
# locks and memory gate for this whole run, builds the release APK, and runs this
# once per stage (before on the base-built APK, after on the candidate APK):
#   expo-ask.sh <serial> <before|after> <absolute-private-evidence-dir> <apk-path>
set -eu
serial=${1:?usage: expo-ask.sh <serial> <before|after> <absolute-evidence-dir> <apk>}
stage=${2:?stage before|after required}
evidence=${3:?absolute private evidence directory required}
apk=${4:?release apk required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
root=$(git rev-parse --show-toplevel)
port=${EXPO_ASK_MOCK_PORT:-21455}
app=io.github.umeranjum17.byokit.example
a() { adb -s "$serial" "$@"; }

log=$(mktemp)
mock=''
cleanup() { [ -z "$mock" ] || kill "$mock" 2>/dev/null || true; rm -f "$log"; }
trap cleanup EXIT
mkdir -p "$evidence"

node "$root/packages/accounts/src/testing/mock-openai.ts" "$port" >"$log" 2>&1 &
mock=$!
for _ in $(seq 20); do grep -q 'stand-in OpenAI' "$log" 2>/dev/null && break; sleep 1; done

a install -r "$apk" >/dev/null
a shell pm clear $app >/dev/null
a shell settings put system font_scale 2.0 # largest system font

start() { a shell am force-stop $app; a shell am start -n $app/.MainActivity >/dev/null; }
screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//" | paste -sd'|'; }
value() { screen | tr '>' '\n' | grep "resource-id=\"$1\"" | grep -o 'text="[^"]*"' | head -1 | sed 's/^text="//; s/"$//'; }
scroll() {
  size=$(a shell wm size | tail -1 | grep -oE '[0-9]+x[0-9]+')
  w=${size%x*}; h=${size#*x}
  if [ "$1" = down ]; then from=$((h * 3 / 4)); to=$((h / 4)); else from=$((h / 4)); to=$((h * 3 / 4)); fi
  a shell input swipe "$((w / 20))" "$from" "$((w / 20))" "$to" 300
}
seek() {
  for direction in up down; do
    for _ in $(seq 16); do
      xy=$(screen | tr '>' '\n' | grep "resource-id=\"$1\"" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
        awk '$3 > $1 && $4 > $2 { print int(($1+$3)/2), int(($2+$4)/2); exit }')
      [ -n "$xy" ] && return
      scroll "$direction"
    done
  done
  echo "no $1 on screen: $(words)" >&2; exit 1
}
tap() { seek "$1"; a shell input tap $xy; }
expect() {
  for _ in $(seq 20); do case "$(words)" in *"$1"*) echo "ok: $1"; return;; esac; sleep 1; done
  echo "FAILED, expected \"$1\", screen: $(words)" >&2; exit 1
}
shot() { a exec-out screencap -p > "$evidence/$1.png"; }

start
expect "ChatGPT isn't signed in yet."
tap signin
expect 'type this code'
code=$(value code)
curl -fsS -o /dev/null --data "user_code=$code" "http://127.0.0.1:$port/codex/device"
seek status
expect 'ChatGPT is connected.'

for theme in light dark; do
  case "$theme" in light) night=no;; dark) night=yes;; esac
  a shell cmd uimode night "$night"
  start
  expect 'ChatGPT is connected.'
  seek picker
  expect 'Room left unknown'
  shot "${stage}__${theme}__accounts"
  screen > "$evidence/${stage}__${theme}__ui.xml"
done

a shell cmd uimode night no
a shell settings put system font_scale 1.0
echo "captured $stage into $evidence"
