#!/bin/sh
# Sign in with ChatGPT on an Android emulator, end to end against the stand-in OpenAI: device code shown in the app,
# typed on the stand-in's page, kept in secure storage across a restart, refreshed, asked (the answer streaming in, then
# a decision), signed out (revoked there); and paired with a @byokit/pair host on this computer (e2e-host.mts), the
# grant kept in secure storage across a restart.
#   ./e2e-android.sh <emulator-serial>     (builds the stand-in release APK)
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial>}
port=${PORT:-21455}
app=io.github.umeranjum17.byokit.example
apk=android/app/build/outputs/apk/release/app-release.apk
a() { adb -s "$serial" "$@"; }

log=$(mktemp)
hostlog=$(mktemp)
mock=''; host=''
cleanup() { [ -z "$mock" ] || kill "$mock" 2>/dev/null || true; [ -z "$host" ] || kill "$host" 2>/dev/null || true; rm -f "$log" "$hostlog"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ -d android ] || CI=1 npx expo prebuild --platform android --no-install
(cd android && EXPO_PUBLIC_OPENAI_BASE="http://10.0.2.2:$port" EXPO_PUBLIC_DEVICE_BASE="http://10.0.2.2:$port" \
  EXPO_PUBLIC_CLAUDE_BASE="http://10.0.2.2:$port" NODE_ENV=production ./gradlew assembleRelease --rerun-tasks -q)

node ../../packages/accounts/src/testing/mock-openai.ts "$port" >"$log" 2>&1 &
mock=$!

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
  # Swipe in the screen's side margin: a drag that starts on a text field scrolls the field, not the page.
  a shell input swipe "$((w / 20))" "$from" "$((w / 20))" "$to" 300
}
seek() {
  for direction in up down; do
    for _ in $(seq 16); do
      # RN may expose off-screen nodes with inverted clipped bounds. Only use a
      # positive on-screen rectangle, and tap the coordinates from this same dump.
      xy=$(screen | tr '>' '\n' | grep "resource-id=\"$1\"" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
        awk '$3 > $1 && $4 > $2 { print int(($1+$3)/2), int(($2+$4)/2); exit }')
      [ -n "$xy" ] && return
      scroll "$direction"
    done
  done
  echo "no $1 on screen: $(words)" >&2; exit 1
}
tap() {
  seek "$1"
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

# The captures in this script are the native proof of this phone screen; a browser is not.
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
offer=$(sed -n 's/^offer //p' "$hostlog")
tap offer
# Let the controlled React Native input settle between chunks; closing the keyboard
# immediately after one long injection can cut off its final characters.
for chunk in $(printf '%s\n' "$offer" | fold -w 64); do
  a shell input text "$chunk"
  sleep 0.2
done
# Keep the keyboard open until the native field acknowledges the entire offer.
held=''
for _ in $(seq 20); do
  held=$(value offer)
  [ "$held" = "$offer" ] && break
  sleep 1
done
[ "$held" = "$offer" ] || { echo "FAILED, pairing offer has ${#held} characters, expected ${#offer}" >&2; exit 1; }
a shell input keyevent 111 # close the keyboard only after the field has settled
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
grep -q "POST /oauth/revoke" "$log" && echo "ok: sign-out ended the sign-in at the stand-in OpenAI"
grep -q "POST /oauth/token refresh_token" "$log" && echo "ok: refreshed"
echo "passed on $serial"
# The account/picker native journey is captured only when requested.
if [ -n "${EXPO_ACCOUNTS_EVIDENCE:-}" ]; then
  . ./accounts-journey.sh
fi
