#!/bin/sh
# Gemini Nano vs the downloaded GGUF model on a connected Android phone someone already owns (hold the keeper lock
# yourself; this never takes one). Lab app only: install, start, tap, screenshot, logcat of its own JS/Nano tags,
# meminfo of the app and of AICore (Nano runs in AICore's process). Same pane (the PROBE realistic pane) for both.
#   OUT=bench RUNS=5 ./bench-infer.sh <serial>
# Needs the release APK built with EXPO_PUBLIC_INFER_DEMO=1 EXPO_PUBLIC_INFER_PROBE=1 and the GGUF model already
# downloaded (e2e-infer.sh). Each run's speed is written to $OUT/speed.txt as it finishes (bench-speed.mjs). Timings come from logcat: `infer-completion result` (llama.rn timings, firstTokenMs) and
# `infer-nano-timing` (firstTextMs, totalMs, outputTokens). Memory: app and AICore PSS/RSS plus the phone's MemAvailable
# sampled about once a second; full dumpsys meminfo after each backend.
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <serial>}
out=${OUT:-bench}
runs=${RUNS:-5}
app=io.github.umeranjum17.byokit.example
apk=android/app/build/outputs/apk/release/app-release.apk
a() { adb -s "$serial" "$@" 9>&-; }
mkdir -p "$out"
receipt() { echo "$*" | tee -a "$out/receipts.txt"; }

screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//; s/&apos;/'/g; s/&quot;/\"/g" | paste -sd'|'; }
text_of() { screen | grep -o "text=\"[^\"]*\" resource-id=\"$1\"" | sed 's/^text="//; s/" resource-id=.*//' | head -1; }
tap_xy() { # shellcheck disable=SC2086 # "x y" is two arguments
  a shell input tap $1; }
bounds() { sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}'; }
tap() {
  xy=$(screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | bounds)
  [ -n "$xy" ] || { echo "no $1 on screen: $(words)" >&2; exit 1; }
  tap_xy "$xy"
}
phase() {
  for _ in $(seq "${2:-60}"); do p=$(text_of infer-phase); case "|$1|" in *"|$p|"*) return;; esac; sleep 1; done
  echo "FAILED, expected phase $1, screen: $(words)" >&2; exit 1
}
# Tap $2 and wait for its run's record in logcat (the card's timing can sit below the fold, out of uiautomator's
# reach), then write that run's speed at once as "$1: ...".
run() {
  engine=${1%% *}; done0=$(speed count-$engine); failed0=$(speed count-failed)
  mark "$1"; tap "$2"
  for _ in $(seq 300); do
    sleep 1
    [ "$(speed count-failed)" = "$failed0" ] || { receipt "$1: FAILED, screen: $(words)"; exit 1; }
    [ "$(speed count-$engine)" = "$done0" ] || { receipt "$1: $(speed "$engine")" | tee -a "$out/speed.txt"; return; }
  done
  receipt "$1: FAILED, no record in 300 s, screen: $(words)"; exit 1
}
speed() { node bench-speed.mjs "$out/logcat.txt" "$1"; }
shot() { a exec-out screencap -p >"$out/$1.png"; echo "captured $out/$1.png"; }
start() { a shell am force-stop $app; a shell am start -n $app/.MainActivity >/dev/null; }
mem() { a shell dumpsys meminfo "$1" 2>/dev/null | grep -E 'TOTAL PSS|TOTAL RSS' | head -1 | tr -s ' '; }
mark() { echo "$(date +%s.%N | cut -c1-14) mark $*" >>"$out/meminfo-samples.txt"; }
battery() { a shell dumpsys battery | grep -E ' level:|temperature:|AC powered:|USB powered:' | tr -s ' ' | paste -sd' '; }

receipt "device: $(a shell getprop ro.product.model) $(a shell getprop ro.soc.model) android $(a shell getprop ro.build.version.release) at $(date -u +%FT%TZ)"
receipt "apk sha256: $(sha256sum "$apk" | cut -d' ' -f1)"
adb -s "$serial" install -r "$apk" >/dev/null 9>&- &
inst=$!
while kill -0 $inst 2>/dev/null; do              # this OEM's install guard: continue for our own lab APK only
  xy=$(screen | grep -o 'text="Continue installation"[^>]*bounds="[^"]*"' | bounds)
  [ -z "$xy" ] || { shot 00-install-guard; tap_xy "$xy"; }
  sleep 2
done
wait $inst

a logcat -c
adb -s "$serial" logcat -v epoch ReactNativeJS:I ByokitNanoDemo:I '*:S' >"$out/logcat.txt" 2>&1 9>&- &
logcat=$!
( while :; do echo "$(date +%s) app $(mem $app) | aicore $(mem com.google.android.aicore) | system $(a shell grep MemAvailable /proc/meminfo | tr -s ' ')"; sleep 1; done ) >>"$out/meminfo-samples.txt" 2>&1 9>&- &
sampler=$!
trap 'kill $sampler $logcat 2>/dev/null' EXIT

start; phase installed 60
sleep 5                                             # NanoModel.check() asks AICore (statusMs 3 s)
receipt "nano: $(text_of infer-nano-phase) | $(text_of infer-nano-state)"
shot 01-status
receipt "battery before: $(battery)"
mark idle; sleep 3

start; phase installed 60
run 'gguf cold' infer-summarize; shot 02-gguf-cold
i=1
while [ "$i" -le "$runs" ]; do run "gguf warm $i" infer-summarize; i=$((i + 1)); done
shot 03-gguf-warm
mark gguf-steady; sleep 3; receipt "gguf steady app: $(mem $app)"
a shell dumpsys meminfo $app >"$out/meminfo-app-after-gguf.txt"

if text_of infer-nano-phase | grep -q ': ready$'; then
  start; phase installed 60; sleep 5
  a shell dumpsys meminfo >"$out/meminfo-system-before-nano.txt"   # Nano's weights may sit outside AICore's PSS (DMA-BUF)
  run 'nano cold' infer-nano-summarize; shot 04-nano-cold
  i=1
  while [ "$i" -le "$runs" ]; do run "nano warm $i" infer-nano-summarize; i=$((i + 1)); done
  shot 05-nano-warm
  mark nano-steady; sleep 3; receipt "nano steady app: $(mem $app) aicore: $(mem com.google.android.aicore)"
  a shell dumpsys meminfo $app >"$out/meminfo-app-after-nano.txt"
  a shell dumpsys meminfo com.google.android.aicore >"$out/meminfo-aicore-after-nano.txt"
  a shell dumpsys meminfo >"$out/meminfo-system-after-nano.txt"
else
  receipt "nano: not ready on this phone, not benchmarked"
fi
receipt "battery after: $(battery)"
mark end
a shell input keyevent KEYCODE_HOME
receipt "done; receipts, logcat.txt and meminfo-samples.txt in $out"
