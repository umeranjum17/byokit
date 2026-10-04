#!/bin/sh
# Run only this fixture app on an explicit emulator. Never select the first device.
set -eu
serial=${1:?Pass an emulator serial}
case "$serial" in emulator-[0-9]*) ;; *) echo 'An emulator is required; phones are forbidden.' >&2; exit 1;; esac
[ "$(adb -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || exit 1
cd "$(dirname "$0")"
adb -s "$serial" install -r android/app/build/outputs/apk/release/app-release.apk
node e2e.mjs "$serial" "${2:-.proof}" "${3:-}"
