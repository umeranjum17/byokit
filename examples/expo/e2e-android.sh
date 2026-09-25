#!/bin/sh
# Sign in with ChatGPT on an Android emulator, end to end against the stand-in OpenAI: device code shown in the app,
# typed on the stand-in's page, kept in secure storage across a restart, refreshed, asked (the answer streaming in, then
# a decision), signed out (revoked there); and paired with a @byokit/link host on this computer (e2e-host.mts), the
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
node ../../packages/accounts/src/testing/mock-openai.ts "$port" >"$log" 2>&1 &
mock=$!
hostlog=$(mktemp)
node e2e-host.mts "$((port + 1))" >"$hostlog" 2>&1 &
host=$!
cleanup() { kill "$mock" "$host" 2>/dev/null || true; rm -f "$log" "$hostlog"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ -d android ] || CI=1 npx expo prebuild --platform android --no-install
(cd android && EXPO_PUBLIC_OPENAI_BASE="http://10.0.2.2:$port" NODE_ENV=production ./gradlew assembleRelease --rerun-tasks -q)

# What the screen says, and a tap on the element with this testID.
screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
# uiautomator quotes a text holding " with ' instead.
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//" | paste -sd'|'; }
tap() {
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

# Pair with the computer: its code pasted in, the two words shown on both, then the link used.
for _ in $(seq 20); do grep -q '^offer ' "$hostlog" && break; sleep 1; done
tap offer
a shell input text "$(sed -n 's/^offer //p' "$hostlog")"
a shell input keyevent 111 # close the keyboard
tap pair
expect "This device is paired with Kitchen computer."
expect "Connected to Kitchen computer."
tap ping
expect '"from":"Kitchen computer"' # the computer's answer, over the link
start
expect "Connected to Kitchen computer." # the grant kept in secure storage across a restart
tap unpair
expect "Scan the code on your computer"

tap signin
expect "type this code"
code=$(words | tr '|' '\n' | grep -E '^MOCK-[0-9]+$')
echo "the app shows $code"
# The person types the code on the provider's page.
curl -fsS -o /dev/null --data "user_code=$code" "http://127.0.0.1:$port/codex/device"
expect "ChatGPT is connected."
expect "sara@example.com, plus plan"
start
expect "ChatGPT is connected." # kept in secure storage across a restart
tap recheck
expect "the sign-in was refreshed"
tap question
a shell input text "is%sthe%sroof%sleaking"
a shell input keyevent 111
tap ask
expect "You said: is the roof leaking"
expect "Not sure if it needs doing today." # the stand-in only echoes, so the decision abstains
tap signout
expect "ChatGPT isn't signed in yet."
start
expect "ChatGPT isn't signed in yet."
grep -q "POST /oauth/revoke" "$log" && echo "ok: sign-out ended the sign-in at the stand-in OpenAI"
grep -q "POST /oauth/token refresh_token" "$log" && echo "ok: refreshed"
echo "passed on $serial"
