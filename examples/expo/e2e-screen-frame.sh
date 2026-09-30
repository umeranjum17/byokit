#!/bin/sh
# Account-free phone proof. Use only an emulator owned by this test run.
# Build a bundled APK first: EXPO_PUBLIC_SCREEN_DEMO=1 NODE_ENV=production ./gradlew assembleRelease
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial> [capture-directory]}
case "$serial" in emulator-*) ;; *) echo 'screen proof requires an emulator' >&2; exit 1;; esac
captures=${2:-../../.task/captures}
mkdir -p "$captures"
app=io.github.umeranjum17.byokit.example
a() { adb -s "$serial" "$@"; }
[ "$(a shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'device is not an emulator' >&2; exit 1; }
a install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null
a shell pm clear "$app" >/dev/null
a shell appops set "$app" SYSTEM_ALERT_WINDOW allow
a shell settings put secure enabled_accessibility_services "$app/io.github.umeranjum17.byokit.example.a11y.DemoAccessibilityService"
a shell settings put secure accessibility_enabled 1
a logcat -c
a shell am start -n "$app/.MainActivity" >/dev/null
screen() { a shell uiautomator dump /sdcard/byokit-screen-ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/byokit-screen-ui.xml; }
expect() {
  for _ in $(seq 20); do
    if screen | grep -Fq "$1"; then echo "ok: $1"; return; fi
    sleep 1
  done
  echo "missing: $1" >&2; screen >&2; exit 1
}
# Match resource-id or text; emit its centre in physical display pixels.
xy() {
  screen | python3 -c 'import sys,xml.etree.ElementTree as E,re
key=sys.argv[1]
for n in E.fromstring(sys.stdin.read()).iter("node"):
 if n.get("resource-id")==key or n.get("text")==key:
  x,y,r,b=map(int,re.findall(r"\d+",n.get("bounds"))); print((x+r)//2,(y+b)//2); break
else: raise SystemExit("missing target: "+key)' "$1"
}
tap() {
  location=$(xy "$1")
  a shell input tap $location
}
no_capture() {
  if a shell dumpsys activity services "$app" | grep -q 'ServiceRecord.*ScreenFrameService'; then
    echo 'capture service still running' >&2; exit 1
  fi
}
marker() { a shell dumpsys window windows | grep -q 'byokit-point-marker'; }
expect_marker() {
  for _ in $(seq 20); do
    if marker; then return; fi
    sleep 0.1
  done
  echo 'marker never appeared' >&2; exit 1
}
expect 'A little help for Umer'
tap screenGuide
expect 'Guide ready.'
# Denial must resolve and not retain a grant or projection.
tap screenCapture
expect 'android:id/button1'
a exec-out screencap -p > "$captures/byokit-screen-consent.png"
tap Cancel
expect 'Picture cancelled.'
no_capture
# Fresh consent, then one readable PNG.
tap screenCapture
expect 'android:id/button1'
tap android:id/button1
expect 'Picture ready.'
no_capture
# Marker over a real underlying button; the underlying app receives the touch.
tap screenPoint
expect 'Follow the ring.'
# Accessibility node and announcement dispatch are covered by PointMarkerTest instrumentation.
expect_marker
location=$(xy screenTarget)
a exec-out screencap -p > "$captures/byokit-screen-marker.png"
a shell input tap $location
expect 'Umer tapped through 1 time.'
# Explicit dismissal, replacement and auto-dismiss.
tap screenDismiss
expect 'Ring dismissed.'
if marker; then echo 'marker remained after dismiss' >&2; exit 1; fi
tap screenPoint
expect_marker
tap screenPointShort
sleep 2
if marker; then echo 'marker remained after timeout' >&2; exit 1; fi
# A successful capture never exempts the next request from consent.
tap screenCapture
expect 'android:id/button1'
tap Cancel
expect 'Picture cancelled.'
no_capture
echo "passed screen-frame and point marker on $serial"
