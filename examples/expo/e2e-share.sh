#!/bin/sh
# @byokit/share's demo screen on an Android emulator someone else already runs (this never starts one): text and a
# link shared warm and cold reach the screen, Done clears it, and shares the app may not or cannot read (a file://
# path, a missing content:// file) show the kit's words instead of crashing. Each step leaves a screenshot in $OUT.
#   OUT=captures ./e2e-share.sh <emulator-serial>     (builds the release APK with EXPO_PUBLIC_SHARE_DEMO=1)
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial> [--negative-only]}
selection=${2:-all}
case "$selection" in all|--negative-only) ;; *) echo 'unknown capture subset' >&2; exit 1;; esac
out=${OUT:-share-captures}
app=io.github.umeranjum17.byokit.example
apk=android/app/build/outputs/apk/release/app-release.apk
a() { adb -s "$serial" "$@" 9>&-; }
mkdir -p "$out"

[ -d android ] || CI=1 npx expo prebuild --platform android --no-install
# Reuse only an APK whose source and hash the caller already verified.
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  (cd android && EXPO_PUBLIC_SHARE_DEMO=1 NODE_ENV=production ./gradlew assembleRelease --rerun-tasks -q)
fi
[ -f "$apk" ]

screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//; s/&apos;/'/g; s/&quot;/\"/g" | paste -sd'|'; }
tap() {
  xy=$(screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
  [ -n "$xy" ] || { echo "no $1 on screen: $(words)" >&2; exit 1; }
  a shell input tap $xy
}
# Compare exact plain words after normalising XML quotation escapes.
expect() {
  want=$1
  for _ in $(seq 20); do case "$(words)" in *"$want"*) echo "ok: $1"; return;; esac; sleep 1; done
  echo "FAILED, expected \"$1\", screen: $(words)" >&2; exit 1
}
shot() { a exec-out screencap -p >"$out/$1.png"; echo "captured $out/$1.png"; }
start() { a shell am force-stop $app; a shell am start -n $app/.MainActivity >/dev/null; }
share() { a shell am start -n $app/.MainActivity -a android.intent.action.SEND "$@" >/dev/null; }
alive() { a shell pidof $app >/dev/null || { echo "FAILED: the app is not running (crashed?)" >&2; exit 1; }; }

a install -r "$apk" >/dev/null
a shell pm clear $app >/dev/null
start
expect 'Share text, a link or files to this app from any other app.'
if [ "$selection" = all ]; then
shot 01-ready

share -t text/plain --es android.intent.extra.TEXT "'hello from another app'"   # warm: the app is open
expect 'hello from another app'
shot 02-warm-text
tap share-clear
expect 'Share text, a link or files to this app from any other app.'
shot 03-cleared

a shell am force-stop $app                                                   # cold: the share starts the app
share -t text/plain --es android.intent.extra.TEXT "'read https://example.com/x later'"
expect 'Link: https://example.com/x'
shot 04-cold-link
tap share-clear
fi

share -t image/png --eu android.intent.extra.STREAM 'file:///sdcard/Download/nothing.png'
expect "That file couldn't be opened here. Share it again from the app it came from."
alive
shot 05-file-path-refused
tap share-clear
expect 'Share text, a link or files to this app from any other app.'

share -t image/png --eu android.intent.extra.STREAM 'content://media/external/images/media/2147483646'
expect "That file couldn't be opened here. Share it again from the app it came from."
alive
shot 06-missing-file-unreadable
tap share-clear
expect 'Share text, a link or files to this app from any other app.'
alive
echo "share demo: $selection steps passed on $serial; screenshots in $out"
