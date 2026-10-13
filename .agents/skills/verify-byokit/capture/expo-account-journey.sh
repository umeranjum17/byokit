#!/bin/sh
# Sourced by e2e-android.sh: use its real native selectors and loopback fixture.
evidence=$EXPO_ACCOUNTS_EVIDENCE
stage=${EXPO_ACCOUNTS_STAGE:-after}
mkdir -p "$evidence"
connect_again() {
  tap signin
  expect 'type this code'
  code=$(value code)
  curl -fsS -o /dev/null --data "user_code=$code" "http://127.0.0.1:$port/codex/device"
  seek status
  expect 'ChatGPT is connected.'
}
shot() { a exec-out screencap -p > "$evidence/$1.png"; }
# This extra journey uses short-lived fixture grants so the app's normal keepFresh
# path can observe remote revocation without editing SecureStore or the app.
kill "$mock"
wait "$mock" 2>/dev/null || true
node --input-type=module -e "import {mockOpenAI} from '@byokit/accounts/testing'; const m=await mockOpenAI({port:$port,host:'0.0.0.0',expiresIn:300}); console.log('stand-in OpenAI',m.base);" >"$log" 2>&1 &
mock=$!
for _ in $(seq 20); do grep -q 'stand-in OpenAI' "$log" && break; sleep 1; done
connect_again
for theme in light dark; do
  case "$theme" in light) night=no;; dark) night=yes;; esac
  a shell cmd uimode night "$night"
  start
  expect 'ChatGPT is connected.'
  if [ "$stage" = before ]; then
    seek who
    shot "before__${theme}__connected"
    continue
  fi
  seek picker
  expect 'Room left unknown'
  expect 'Auto — most room left'
  shot "after__${theme}__accounts"
  if [ "$theme" = light ]; then
    a shell screenrecord --time-limit 20 /sdcard/byokit-p22-picker.mp4 >/dev/null 2>&1 &
    recorder=$!
  fi
  tap picker
  seek pick-0
  shot "after__${theme}__picker"
  tap pick-1
  seek model-1-0
  tap model-1-0
  tap picker
  if [ "$theme" = light ]; then
    wait "$recorder"
    a pull /sdcard/byokit-p22-picker.mp4 "$evidence/picker-motion.mp4" >/dev/null
    a shell rm /sdcard/byokit-p22-picker.mp4
  fi
done
if [ "$stage" = after ]; then
  # Restarting the loopback provider loses its valid refresh grants, just as a remote
  # revocation does. The kit retains its terminal marker and owns the sign-in reason.
  kill "$mock"
  wait "$mock" 2>/dev/null || true
  node ../../packages/accounts/src/testing/mock-openai.ts "$port" >"$log" 2>&1 &
  mock=$!
  for _ in $(seq 20); do grep -q 'stand-in OpenAI' "$log" && break; sleep 1; done
  start # keepFresh observes the revoked grant and retains the kit's terminal marker
  seek status
  expect 'again'
  for theme in light dark; do
    case "$theme" in light) night=no;; dark) night=yes;; esac
    a shell cmd uimode night "$night"
    start
    seek picker
    tap picker
    tap pick-1
    seek pick-reason
    expect 'Sign in first'
    shot "after__${theme}__signed-out-pick"
  done
fi
a shell cmd uimode night no
printf 'native account journey captured: %s (%s)\n' "$evidence" "$stage"
