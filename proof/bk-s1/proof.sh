#!/bin/sh
# BK-S1 emulator proof for @byokit/statusbar on examples/expo's release build, adb on a remote emulator over ssh.
#   ./proof.sh <ssh-host> <serial> <apk-path-on-host> <out-dir> full|unsupported
set -eu
host=$1 serial=$2 apk=$3 out=$4 mode=$5
app=io.github.umeranjum17.byokit.example
mkdir -p "$out"
a() { ssh -o BatchMode=yes "$host" "\$HOME/Library/Android/sdk/platform-tools/adb -s $serial $*"; }
run() { echo "\$ adb $*"; a "$@"; }
shot() { a exec-out screencap -p > "$out/$1.png"; echo "[screenshot $1.png]"; }
screen() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/ui.xml; }
center() { sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}'; }
tapid() { xy=$(screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | center); echo "\$ adb shell input tap $xy   # $1"; a shell input tap $xy; }
taptext() { xy=$(screen | grep -o "text=\"$1\"[^>]*bounds=\"[^\"]*\"" | head -1 | center); echo "\$ adb shell input tap $xy   # \"$1\""; a shell input tap $xy; }
said() { screen | grep -oE "text=\"[^\"]*\" resource-id=\"chip-said\"" | sed 's/ resource-id.*//'; }
posted() { a shell dumpsys notification --noredact | grep -c "tag=byokit.status" || true; }
notice() { a shell dumpsys notification --noredact | grep -A2 "tag=byokit.status" | grep -oE "flags=[A-Z_|]*|actions=[0-9]+|vis=[A-Z]+" | sort -u | paste -sd' '; }

echo "== device"
sdk=$(a shell getprop ro.build.version.sdk_full)
[ -n "$sdk" ] || sdk=$(a shell getprop ro.build.version.sdk)
echo "sdk: $sdk fingerprint: $(a shell getprop ro.build.fingerprint)"
echo "== install and grant POST_NOTIFICATIONS"
run install -r "$apk"
run shell pm grant $app android.permission.POST_NOTIFICATIONS
run shell am start -n $app/.MainActivity >/dev/null
sleep 4
a shell input swipe 540 1800 540 800 300; sleep 1

echo "== show"
tapid chip-show; sleep 3
echo "said: $(said)"
echo "posted: $(posted)  $(notice)"
if [ "$mode" = unsupported ]; then shot 35-unsupported; exit 0; fi
shot 01-app-state

echo "== the chip: home screen"
run shell input keyevent 3; sleep 2
shot 02-chip-home

echo "== the expanded notification: three actions"
run shell cmd statusbar expand-notifications; sleep 2
shot 03-shade-actions
run shell cmd statusbar collapse; sleep 1

echo "== secure lock screen, sensitive content hidden, silent notifications shown"
run shell locksettings set-pin 1234
run shell settings put secure lock_screen_allow_private_notifications 0
run shell settings put secure lock_screen_show_silent_notifications 1
run shell input keyevent 26; sleep 2
run shell input keyevent 224; sleep 3
# Android 36.1 initially collapses lock-screen notifications into an icon shelf.
run shell input tap 135 590; sleep 2
shot 04-lock-public
echo "lock screen words: $(screen | grep -oE 'text="[^"]*working[^"]*"' | paste -sd' ')"

echo "== unlock, tap an action"
run shell cmd statusbar collapse; sleep 1
a shell input swipe 540 2000 540 600 300; sleep 2
a shell input text 1234; a shell input keyevent 66; sleep 3
run shell cmd statusbar expand-notifications; sleep 2
taptext "See what needs you"; sleep 3
echo "said: $(said)"

echo "== swipe the notification away"
run shell cmd statusbar expand-notifications; sleep 2
y=$(screen | grep -o 'text="Scribe[^"]*"[^>]*bounds="[^"]*"' | center | awk '{print $2}')
run shell input swipe 200 "$y" 1050 "$y" 250; sleep 2
echo "posted after swipe: $(posted)"
run shell cmd statusbar collapse; sleep 1
run shell am start -n $app/.MainActivity >/dev/null; sleep 2
echo "said: $(said)"

echo "== show twice after the dismissal: nothing posts"
tapid chip-show; sleep 3; echo "posted: $(posted)"
tapid chip-show; sleep 3; echo "posted: $(posted)"
shot 05-dismissed-not-reposted

echo "== clear, then show: posts again"
tapid chip-clear; sleep 2; echo "said: $(said)"
tapid chip-show; sleep 3; echo "posted: $(posted)"

echo "== restore the device"
tapid chip-clear; sleep 1
run shell locksettings clear --old 1234
run shell settings put secure lock_screen_allow_private_notifications 1
run shell settings delete secure lock_screen_show_silent_notifications
