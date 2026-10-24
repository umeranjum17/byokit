#!/bin/sh
# MiniMax plan sign-in on the phone: the real release example app on the caller's private emulator signs in to
# MiniMax by user code against the local stand-in (expo-minimax-host.mjs): the MiniMax row, the code shown, the
# person approving it, the account kept in secure storage across a restart, then sign-out. Light and dark frames.
# The caller boots the emulator OUTSIDE any shared lock and holds the private/heavy locks and memory gate for the
# run; the APK must be built with EXPO_PUBLIC_DEVICE_BASE=http://10.0.2.2:<device-port> (see features/expo-minimax.md).
#   expo-minimax.sh <serial> <before|after> <absolute-private-evidence-dir> <apk-path>
# `before` (an APK built from the base App.tsx) captures only the plan list, where MiniMax is absent.
set -eu
serial=${1:?usage: expo-minimax.sh <serial> <before|after> <absolute-evidence-dir> <apk>}
stage=${2:?stage before|after required}
evidence=${3:?absolute private evidence directory required}
apk=${4:?release apk required}
case "$evidence" in /*) ;; *) echo 'Use an absolute private evidence path' >&2; exit 2;; esac
root=$(git rev-parse --show-toplevel)
port=${EXPO_MINIMAX_PORT:-21457}
approve=$((port + 1))
app=io.github.umeranjum17.byokit.example
a() { adb -s "$serial" "$@"; }

log=$(mktemp)
host=''
cleanup() { [ -z "$host" ] || kill "$host" 2>/dev/null || true; rm -f "$log"; a shell cmd uimode night no >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir -p "$evidence"

(cd "$root" && exec node .agents/skills/done-done-verify-byokit/capture/expo-minimax-host.mjs "$port" "$approve") >"$log" 2>&1 &
host=$!
for _ in $(seq 20); do grep -q 'stand-in MiniMax' "$log" 2>/dev/null && break; sleep 1; done
grep -q 'stand-in MiniMax' "$log" || { cat "$log" >&2; exit 1; }

a install -r "$apk" >/dev/null
a shell pm clear $app >/dev/null

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
themes() { for theme in light dark; do case "$theme" in light) night=no;; dark) night=yes;; esac; a shell cmd uimode night "$night"; "$@" "$theme"; done; a shell cmd uimode night no; }

start
expect "ChatGPT isn't signed in yet."
if [ "$stage" = before ]; then
  list() { start; expect "ChatGPT isn't signed in yet."; for _ in 1 2 3; do scroll down; done; shot "before__$1__plans"; }
  themes list
  case "$(words)" in *MiniMax*) echo 'FAILED, the base app already lists MiniMax' >&2; exit 1;; esac
  echo 'ok: the base app lists no MiniMax plan'
  exit 0
fi

row() { start; seek minimax-signin; expect "MiniMax isn't signed in yet."; shot "after__$1__minimax-row"; }
themes row
start
tap minimax-signin
seek minimax-code
expect 'type this code'
code=$(value minimax-code)
echo "the app shows $code"
shot after__light__minimax-code
a shell cmd uimode night yes
seek minimax-code
shot after__dark__minimax-code
a shell cmd uimode night no
# The person types the code on MiniMax's page.
curl -fsS -o /dev/null "http://127.0.0.1:$approve/approve?code=$code"
seek minimax-status
expect 'MiniMax is connected.'
connected() { start; seek minimax-status; expect 'MiniMax is connected.'; shot "after__$1__minimax-connected"; }
themes connected # kept in secure storage across each restart
tap minimax-signout
seek minimax-status
expect "MiniMax isn't signed in yet."
start
seek minimax-status
expect "MiniMax isn't signed in yet."
echo 'stand-in MiniMax saw:'
curl -fsS "http://127.0.0.1:$approve/requests"
printf 'MiniMax phone journey captured: %s\n' "$evidence"
