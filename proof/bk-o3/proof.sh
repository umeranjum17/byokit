#!/bin/sh
# BK-O3 emulator proof. Usage: proof.sh <serial> <outdir>
set -eu
S=$1; O=$2; app=io.github.umeranjum17.byokit.example
mkdir -p "$O"
a() { echo "\$ adb $*" >&2; adb -s "$S" "$@"; }
screen() { adb -s "$S" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb -s "$S" exec-out cat /sdcard/ui.xml; }
words() { screen | grep -oE "text=(\"[^\"]*\"|'[^']*')" | sed "s/^text=.//; s/.\$//" | paste -sd'|'; }
center() { screen | grep -o "resource-id=\"$1\"[^>]*bounds=\"[^\"]*\"" | sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}'; }
tap() { xy=$(center "$1"); [ -n "$xy" ] || { echo "no $1: $(words)" >&2; exit 1; }; a shell input tap $xy; }
expect() { for _ in $(seq 20); do case "$(words)" in *"$1"*) echo "ok: $1"; return;; esac; sleep 1; done; echo "FAILED: $1 / $(words)" >&2; exit 1; }
shot() { adb -s "$S" exec-out screencap -p > "$O/$1.png"; echo "shot: $1.png"; }
# The bubble window: the overlay window's frame from dumpsys (TYPE_APPLICATION_OVERLAY is type 2038).
bubble() { adb -s "$S" shell dumpsys window windows | awk -v app="$app" '/Window #/{mine=index($0, app)>0; ov=0} mine&&/ty=APPLICATION_OVERLAY/{ov=1} ov&&/ frame=/{match($0, / frame=\[[0-9-]+,[0-9-]+\]\[[0-9-]+,[0-9-]+\]/); print substr($0, RSTART+7, RLENGTH-7); exit}'; }

echo "== 1. grant"
a shell am force-stop $app
a shell appops set $app SYSTEM_ALERT_WINDOW allow
a shell appops get $app SYSTEM_ALERT_WINDOW
a shell am start -n $app/.MainActivity >/dev/null
expect "The bubble is off."
echo "== 2. start the window host"
tap bubbleStart
expect "The bubble is on."
sleep 1; shot 01-started
echo "bubble frame: $(bubble)"
echo "== 3. drag and snap"
a shell input keyevent 3   # home: the bubble floats over the launcher
sleep 1
f=$(bubble); echo "before drag: $f"
x=$(echo "$f" | sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2)}')
y=$(echo "$f" | sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' | awk '{print int(($2+$4)/2)}')
a shell input swipe $x $y 300 900 800
sleep 1; echo "after drop at 300,900: $(bubble)"; shot 02-snapped-left
f=$(bubble)
x=$(echo "$f" | sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2)}')
y=$(echo "$f" | sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' | awk '{print int(($2+$4)/2)}')
echo "== 4. tap: the panel opens, the bubble hides"
a shell input tap $x $y
expect "Opened from the bubble."
sleep 1; echo "bubble frame while panel open: '$(bubble)'"; shot 03-panel-open
echo "== 5. close the panel: the bubble returns"
tap panelClose
sleep 2; echo "bubble frame after close: $(bubble)"; shot 04-panel-closed
echo "== 6. taps() lists the tap, no text"
a shell am start -n $app/.MainActivity >/dev/null
sleep 2
tap taps
expect '"action":"tap"'
screen | grep -oE 'resource-id="tapLog"[^>]*' | head -1 >/dev/null || true
echo "tap log: $(words | tr '|' '\n' | grep '"action"')"
shot 05-taps
echo "== 7. focused field via the example's accessibility service, read in another app"
a shell settings put secure enabled_accessibility_services $app/io.github.umeranjum17.byokit.example.a11y.DemoAccessibilityService
a shell settings put secure accessibility_enabled 1
sleep 3
a shell am start -a android.intent.action.INSERT -t vnd.android.cursor.dir/contact >/dev/null
sleep 3
xy=$(screen | grep -o '<node[^>]*EditText[^>]*>' | head -1 | sed 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
a shell input tap $xy
sleep 1
a shell input text "hello%sbubble"
sleep 1
echo "focused field: $(screen | grep -o '<node[^>]*focused="true"[^>]*>' | grep -o 'class="[^"]*"\|package="[^"]*"\|text="[^"]*"' | paste -sd' ')"
f=$(bubble); echo "bubble frame (above the keyboard): $f"
x=$(echo "$f" | sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2)}')
y=$(echo "$f" | sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' | awk '{print int(($2+$4)/2)}')
a shell input swipe $x $y $x $y 1200   # long press: the example reads the field and says it
sleep 1; shot 06-field-read-said
echo "focus kept: $(screen | grep -o '<node[^>]*focused="true"[^>]*>' | grep -o 'text="[^"]*"')"
a shell am start -n $app/.MainActivity >/dev/null
expect 'available: true'
expect '"text":"hello bubble"'
echo "field: $(words | tr '|' '\n' | grep 'available:')"
shot 07-field-in-app
