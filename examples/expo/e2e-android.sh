#!/bin/sh
# Sign in with ChatGPT on an Android emulator, end to end against the stand-in OpenAI: device code shown in the app,
# typed on the stand-in's page, kept in secure storage across a restart, refreshed, asked (the answer streaming in, then
# a decision), signed out (revoked there); Grok the same way against the stand-in device sign-in (its /activate page,
# the connected status kept across a restart, then signed out; a decline shows one sentence and keeps nothing); Claude
# by pasting the code its stand-in page shows (the Claude Max badge kept across a restart, then signed out); and paired
# with a @byokit/pair host on this computer (e2e-host.mts), the grant kept in secure storage across a restart.
#   ./e2e-android.sh <emulator-serial>     (builds the stand-in release APK)
# Loopback only: every stand-in listens on this computer (the emulator reaches it at 10.0.2.2); no account, no network.
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial>}
port=${PORT:-21455}
devicePort=${DEVICE_PORT:-$((port + 2))}
claudePort=${CLAUDE_PORT:-$((port + 3))}
app=io.github.umeranjum17.byokit.example
apk=android/app/build/outputs/apk/release/app-release.apk
a() { adb -s "$serial" "$@"; }

log=$(mktemp)
hostlog=$(mktemp)
devicelog=$(mktemp)
claudelog=$(mktemp)
mock=''; host=''; device=''; claude=''
cleanup() {
  if [ -n "${EXPO_CONNECT_RECORDING:-}" ]; then
    a shell "kill -INT $(a shell pidof screenrecord 2>/dev/null | tr -d '\r') 2>/dev/null" >/dev/null 2>&1 || true
    sleep 2
    a pull /sdcard/e2e.mp4 "$EXPO_CONNECT_RECORDING" >/dev/null 2>&1 || true
  fi
  [ -z "$mock" ] || kill "$mock" 2>/dev/null || true
  [ -z "$host" ] || kill "$host" 2>/dev/null || true
  [ -z "$device" ] || kill "$device" 2>/dev/null || true
  [ -z "$claude" ] || kill "$claude" 2>/dev/null || true
  if [ -n "${EXPO_CONNECT_EVIDENCE:-}" ]; then
    mkdir -p "$EXPO_CONNECT_EVIDENCE"
    cp "$log" "$EXPO_CONNECT_EVIDENCE/mock-openai.log" 2>/dev/null || true
    cp "$hostlog" "$EXPO_CONNECT_EVIDENCE/e2e-host.log" 2>/dev/null || true
    cp "$devicelog" "$EXPO_CONNECT_EVIDENCE/mock-device.log" 2>/dev/null || true
    cp "$claudelog" "$EXPO_CONNECT_EVIDENCE/e2e-claude-standin.log" 2>/dev/null || true
  fi
  rm -f "$log" "$hostlog" "$devicelog" "$claudelog"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ -d android ] || CI=1 npx expo prebuild --platform android --no-install
(cd android && EXPO_PUBLIC_OPENAI_BASE="http://10.0.2.2:$port" EXPO_PUBLIC_DEVICE_BASE="http://10.0.2.2:$devicePort" EXPO_PUBLIC_CLAUDE_BASE="http://10.0.2.2:$claudePort" NODE_ENV=production ./gradlew assembleRelease --rerun-tasks -q)

node ../../packages/accounts/src/testing/mock-openai.ts "$port" >"$log" 2>&1 &
mock=$!
node ../../packages/accounts/src/testing/mock-device.ts "$devicePort" >"$devicelog" 2>&1 &
device=$!
node e2e-claude-standin.mts "$claudePort" >"$claudelog" 2>&1 &
claude=$!
for _ in $(seq 20); do
  grep -q 'stand-in device sign-in' "$devicelog" 2>/dev/null && grep -q 'stand-in Claude' "$claudelog" 2>/dev/null && break
  sleep 1
done
grep -q 'stand-in device sign-in' "$devicelog" || { echo "the device stand-in never started: $(cat "$devicelog")" >&2; exit 1; }
grep -q 'stand-in Claude' "$claudelog" || { echo "the Claude stand-in never started: $(cat "$claudelog")" >&2; exit 1; }
if [ -n "${EXPO_CONNECT_RECORDING:-}" ]; then
  mkdir -p "$(dirname "$EXPO_CONNECT_RECORDING")"
  a shell rm -f /sdcard/e2e.mp4
  # screenrecord stops by itself after 180s unless told; the journey after the build needs ~10 minutes.
  a shell screenrecord --time-limit 1200 /sdcard/e2e.mp4 >/dev/null 2>&1 &
fi

# What the screen says, and a tap on the element with this testID.
screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
# uiautomator quotes a text holding " with ' instead.
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//" | paste -sd'|'; }
# The text one named field itself currently holds (not the whole screen).
value() { screen | tr '>' '\n' | grep "resource-id=\"$1\"" | grep -o 'text="[^"]*"' | head -1 | sed 's/^text="//; s/"$//'; }
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
  echo "no $1 on screen: $(words)" >&2; exit 1
}
tap() {
  seek "$1"
  xy=$(screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
  [ -n "$xy" ] || { echo "no $1 on screen: $(words)" >&2; exit 1; }
  a shell input tap $xy
}
expect() {
  for _ in $(seq 20); do case "$(words)" in *"$1"*) echo "ok: $1"; return;; esac; sleep 1; done
  echo "FAILED, expected \"$1\", screen: $(words)" >&2; exit 1
}
start() { a shell am force-stop $app; a shell am start -n $app/.MainActivity >/dev/null; }

a install -r "$apk" >/dev/null
a shell pm clear $app >/dev/null
start
expect "ChatGPT isn't signed in yet."

# verify-byokit owns native captures; a browser is not proof of this phone screen.
if [ -n "${EXPO_CONNECT_EVIDENCE:-}" ]; then
  mkdir -p "$EXPO_CONNECT_EVIDENCE"
  stage=${EXPO_CONNECT_STAGE:-after}
  for theme in light dark; do
    case "$theme" in light) night=no;; dark) night=yes;; esac
    a shell cmd uimode night "$night"
    start
    expect "ChatGPT isn't signed in yet."
    if [ "$stage" = after ]; then expect 'Plans'; fi
    a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/${stage}__${theme}__top.png"
    for id in ${EXPO_CONNECT_ROWS:-claude}; do
      seek "${id}-signin"
      a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/${stage}__${theme}__${id}.png"
    done
  done
  a shell cmd uimode night no
  start
  expect "ChatGPT isn't signed in yet."
  if [ "${EXPO_CONNECT_CAPTURE_ONLY:-0}" = 1 ]; then exit 0; fi
fi

# Pair with the computer: issue its short-lived code after the build and captures, not before them.
node e2e-host.mts "$((port + 1))" >"$hostlog" 2>&1 &
host=$!
for _ in $(seq 20); do grep -q '^offer ' "$hostlog" && break; sleep 1; done
tap offer
# A 277-char code typed at once loses its tail on a loaded emulator (per-char key injection outruns the settling
# keyboard), so type it in short chunks, then read the field back and require the whole code before submitting.
offer=$(sed -n 's/^offer //p' "$hostlog")
type_offer() {
  i=1
  while [ "$i" -le "${#offer}" ]; do
    a shell input text "$(printf '%s' "$offer" | cut -c "$i-$((i + 39))")"
    i=$((i + 40))
    sleep 1
  done
}
type_offer
[ "$(value offer)" = "$offer" ] || {
  echo "retyping the pairing code after a short type"
  a shell "i=0; while [ \$i -lt ${#offer} ]; do input keyevent 67; i=\$((i + 1)); done"
  tap offer
  type_offer
}
[ "$(value offer)" = "$offer" ] || { echo "FAILED, the offer field holds \"$(value offer)\"" >&2; exit 1; }
a shell input keyevent 111 # close the keyboard
tap pair
expect "This device is paired with Kitchen computer."
expect "Connected to Kitchen computer."
tap ping
expect '"from":"Kitchen computer"' # the computer's answer, over the link
start
seek link
expect "Connected to Kitchen computer." # the grant kept in secure storage across a restart
tap unpair
expect "Scan the code on your computer"

tap signin
seek code
expect "type this code"
[ -z "${EXPO_CONNECT_EVIDENCE:-}" ] || a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/journey__code.png"
code=$(words | tr '|' '\n' | grep -E '^MOCK-[0-9]+$')
echo "the app shows $code"
# The person types the code on the provider's page.
curl -fsS -o /dev/null --data "user_code=$code" "http://127.0.0.1:$port/codex/device"
seek status
expect "ChatGPT is connected."
# The grouped list puts the plan badge above the status; scroll it into view before asserting it.
seek plan
expect "ChatGPT Plus"
seek who
expect "Signed in as umer@example.com"
[ -z "${EXPO_CONNECT_EVIDENCE:-}" ] || a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/journey__connected.png"
start
seek status
expect "ChatGPT is connected." # kept in secure storage across a restart
tap recheck
seek note
expect "the sign-in was refreshed"
tap question
a shell input text "is%sthe%sroof%sleaking"
a shell input keyevent 111
# Android applies the field's sentence capitalisation, so bind the oracle to the field's real value, then require its whole echo.
asked=''
for _ in $(seq 20); do
  held=$(value question)
  case "$held" in "is the roof leaking" | "Is the roof leaking") asked=$held; break;; esac
  sleep 1
done
[ -n "$asked" ] || { echo "FAILED, the question field holds \"$(value question)\", screen: $(words)" >&2; exit 1; }
echo "the question field holds: $asked"
tap ask
seek answer
got=''
for _ in $(seq 20); do
  got=$(value answer)
  [ "$got" = "You said: $asked" ] && break
  sleep 1
done
[ "$got" = "You said: $asked" ] || { echo "FAILED, expected \"You said: $asked\", the answer field holds \"$got\", screen: $(words)" >&2; exit 1; }
seek decision
expect "Not sure if it needs doing today." # the stand-in only echoes, so the decision abstains
tap signout
seek status
expect "ChatGPT isn't signed in yet."
start
expect "ChatGPT isn't signed in yet."

# Grok against the stand-in device sign-in: the code shown in the app, approved on its page, kept across a restart.
tap grok-signin
seek grok-code
expect "type this code"
[ -z "${EXPO_CONNECT_EVIDENCE:-}" ] || a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/journey__grok-code.png"
code=$(words | tr '|' '\n' | grep -E '^FIXTURE-[0-9]+$')
echo "the app shows $code"
# The person types the code on the provider's page.
curl -fsS -o /dev/null --data "user_code=$code" "http://127.0.0.1:$devicePort/activate"
seek grok-status
expect "Grok is connected."
[ -z "${EXPO_CONNECT_EVIDENCE:-}" ] || a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/journey__grok-connected.png"
start
seek grok-status
expect "Grok is connected." # kept in secure storage across a restart
tap grok-signout
seek grok-status
expect "Grok isn't signed in yet."

# A Grok decline shows one sentence and keeps nothing.
tap grok-signin
seek grok-code
code=$(words | tr '|' '\n' | grep -E '^FIXTURE-[0-9]+$')
curl -fsS -o /dev/null --data "user_code=$code&deny=1" "http://127.0.0.1:$devicePort/activate"
seek grok-failed
expect "declined"
tap grok-close
seek grok-status
expect "Grok isn't signed in yet."
start
expect "Grok isn't signed in yet." # a decline keeps nothing

# Claude by pasting the code its stand-in page shows: the badge kept across a restart, then signed out.
tap claude-signin
seek claude-paste
tap claude-open # the app opens the stand-in page in the emulator browser, which tells it this sign-in's state
pasted=''
for _ in $(seq 30); do
  pasted=$(curl -fsS "http://127.0.0.1:$claudePort/state" | grep -o '"state":"[^"]*"' | sed 's/"state":"//; s/"$//')
  [ -n "$pasted" ] && break
  sleep 1
done
[ -n "$pasted" ] || { echo "FAILED, the Claude stand-in never saw the opened page" >&2; exit 1; }
a shell input keyevent 4 # back to the app; the sign-in's state never leaves it
a shell am start -n $app/.MainActivity >/dev/null
tap claude-paste
echo "pasting recorded-code#$pasted"
held=''
for i in $(seq 5); do
  a shell input text "recorded-code#$pasted"
  for j in $(seq 20); do
    held=$(value claude-paste)
    [ "$held" = "recorded-code#$pasted" ] && break
    sleep 1
  done
  [ "$held" = "recorded-code#$pasted" ] && break
  tap claude-paste # the keyboard was still opening under the first type; focus and type again
done
[ "$held" = "recorded-code#$pasted" ] || { echo "FAILED, the paste field holds \"$(value claude-paste)\", screen: $(words)" >&2; exit 1; }
a shell input keyevent 111 # close the keyboard
tap claude-connect
seek claude-status
expect "Claude is connected."
seek claude-plan
expect "Claude Max"
seek claude-who
expect "Signed in as umer@example.com"
[ -z "${EXPO_CONNECT_EVIDENCE:-}" ] || a exec-out screencap -p > "$EXPO_CONNECT_EVIDENCE/journey__claude-connected.png"
start
seek claude-status
expect "Claude is connected." # kept in secure storage across a restart
seek claude-plan
expect "Claude Max"
tap claude-signout
seek claude-status
expect "Claude isn't signed in yet."
start
expect "Claude isn't signed in yet."
grep -q "POST /oauth/revoke" "$log" && echo "ok: sign-out ended the sign-in at the stand-in OpenAI"
grep -q "POST /oauth/token refresh_token" "$log" && echo "ok: refreshed"
grep -q "POST /oauth2/token" "$devicelog" && echo "ok: Grok asked the stand-in device sign-in"
grep -q "POST /activate" "$devicelog" && echo "ok: Grok was approved and declined on the stand-in page"
grep -q "GET /oauth/authorize" "$claudelog" && echo "ok: the app opened the stand-in Claude page"
grep -q "POST /v1/oauth/token" "$claudelog" && echo "ok: Claude pasted its code at the stand-in"
echo "passed on $serial"
