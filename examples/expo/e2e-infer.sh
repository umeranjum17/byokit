#!/bin/sh
# @byokit/infer's demo screen (InferDemo.tsx) on a connected Android phone or emulator someone else already runs and
# owns (this never starts one and never takes a device lock: hold the keeper lock yourself before calling it). It
# touches only this lab app: install, clear its own data, start, tap, screenshot, read its own meminfo.
# Steps: model download (the only network use) → cold summary → warm summaries → cancel by flipping → not enough
# output → background release. Each step leaves a screenshot and a line in $OUT/receipts.txt.
#   OUT=infer-captures RUNS=10 ./e2e-infer.sh <serial>     (builds the release APK with EXPO_PUBLIC_INFER_DEMO=1)
#   KEEP_MODEL=1 skips clearing app data, so a downloaded model is reused.
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <serial>}
out=${OUT:-infer-captures}
runs=${RUNS:-10}
app=io.github.umeranjum17.byokit.example
apk=android/app/build/outputs/apk/release/app-release.apk
a() { adb -s "$serial" "$@" 9>&-; }
mkdir -p "$out"
receipt() { echo "$*" | tee -a "$out/receipts.txt"; }

[ -d android ] || CI=1 npx expo prebuild --platform android --no-install
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  (cd android && EXPO_PUBLIC_INFER_DEMO=1 NODE_ENV=production ./gradlew assembleRelease --rerun-tasks -q)
fi
[ -f "$apk" ]
unzip -l "$apk" | grep -q 'lib/arm64-v8a/librnllama_jni' || { echo "FAILED: no arm64-v8a llama.rn JNI library in $apk" >&2; exit 1; }

screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//; s/&apos;/'/g; s/&quot;/\"/g" | paste -sd'|'; }
# Text of the element with this testID.
text_of() { screen | grep -o "text=\"[^\"]*\" resource-id=\"$1\"" | sed 's/^text="//; s/" resource-id=.*//' | head -1; }
tap() {
  xy=$(screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
  [ -n "$xy" ] || { echo "no $1 on screen: $(words)" >&2; exit 1; }
  # shellcheck disable=SC2086 # "x y" is two arguments
  a shell input tap $xy
}
# Wait (up to $2 seconds) until the phase is one of $1 ("ready|installed").
phase() {
  for _ in $(seq "${2:-60}"); do p=$(text_of infer-phase); case "|$1|" in *"|$p|"*) return;; esac; sleep 1; done
  echo "FAILED, expected phase $1, screen: $(words)" >&2; exit 1
}
# Wait for a summary or an honest no-summary; print what the card says.
result() {
  sleep 1
  for _ in $(seq "${1:-180}"); do
    w=$(words); case "$w" in *"ms on this phone"*|*"Not enough recent output"*|*"was cut off"*|*"stopped working"*) echo "$w"; return;; esac; sleep 1
  done
  echo "FAILED, no summary, screen: $(words)" >&2; exit 1
}
shot() { a exec-out screencap -p >"$out/$1.png"; echo "captured $out/$1.png"; }
start() { a shell am force-stop $app; a shell am start -n $app/.MainActivity >/dev/null; }
rss() { a shell dumpsys meminfo $app | grep -E 'TOTAL PSS|TOTAL RSS|TOTAL:' | head -2 | tr -s ' ' | paste -sd' '; }
battery() { a shell dumpsys battery | grep -E ' level:|temperature:|AC powered:|USB powered:' | tr -s ' ' | paste -sd' '; }

receipt "device: $(a shell getprop ro.product.model) android $(a shell getprop ro.build.version.release) abi $(a shell getprop ro.product.cpu.abi) at $(date -u +%FT%TZ)"
receipt "apk sha256: $(sha256sum "$apk" | cut -d' ' -f1) bytes $(wc -c <"$apk")"
a install -r "$apk" >/dev/null
[ "${KEEP_MODEL:-0}" = 1 ] || a shell pm clear $app >/dev/null
start
phase 'not-installed|installed' 30
shot 01-start
if [ "$(text_of infer-phase)" = not-installed ]; then
  t0=$(date +%s); tap infer-download
  phase installing 30; shot 02-downloading
  phase installed 1800
  receipt "download+verify: $(( $(date +%s) - t0 )) s"
fi
shot 03-installed

battery_before=$(battery)
start; phase installed 60                                  # cold: fresh process, model not loaded
tap infer-pane-tests; receipt "cold tests: $(result | grep -oE '[0-9]+ ms on this phone[^|]*')"
shot 04-cold-summary
receipt "after cold: $(rss)"
i=1
while [ "$i" -le "$runs" ]; do                             # warm: same process, context loaded
  tap infer-summarize; receipt "warm $i: $(result | grep -oE '[0-9]+ ms on this phone[^|]*')"; i=$((i + 1))
done
shot 05-warm-summary
receipt "after warm: $(rss)"
receipt "battery before: $battery_before"
receipt "battery after:  $(battery)"

tap infer-summarize; tap infer-pane-build                  # flip mid-summary: the old call is cancelled
result >/dev/null; shot 06-flipped-build
tap infer-pane-idle; result | grep -q 'Not enough recent output' && receipt "idle pane: not enough output (no summary invented)"
shot 07-idle

a shell input keyevent KEYCODE_HOME; sleep 3                # background releases the native context
receipt "backgrounded: $(rss)"
a shell am start -n $app/.MainActivity >/dev/null; phase installed 30
shot 08-resumed
receipt "done; screenshots and receipts in $out"
