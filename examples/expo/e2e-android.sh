#!/bin/sh
# Sign in with ChatGPT on an Android emulator, end to end against the stand-in OpenAI: device code shown in the app,
# typed on the stand-in's page, kept in secure storage across a restart, refreshed, signed out (revoked there).
#   ./e2e-android.sh <emulator-serial>     (builds the release APK first if there is none)
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
trap 'kill $mock 2>/dev/null; rm -f "$log"' EXIT
if [ ! -f "$apk" ]; then
  [ -d android ] || CI=1 npx expo prebuild --platform android --no-install
  (cd android && EXPO_PUBLIC_OPENAI_BASE="http://10.0.2.2:$port" NODE_ENV=production ./gradlew assembleRelease -q)
fi

# What the screen says, and a tap on the element with this testID.
screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
words() { screen | grep -o 'text="[^"]*"' | sed 's/text="//; s/"$//' | paste -sd'|'; }
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
tap signout
expect "ChatGPT isn't signed in yet."
start
expect "ChatGPT isn't signed in yet."
grep -q "POST /oauth/revoke" "$log" && echo "ok: sign-out ended the sign-in at the stand-in OpenAI"
grep -q "POST /oauth/token refresh_token" "$log" && echo "ok: refreshed"
echo "passed on $serial"
