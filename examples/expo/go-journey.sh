#!/bin/sh
# Sourced by e2e-android.sh: add an OpenCode Go account by pasting its plan key, live against OpenCode.
# The key comes from BYOKIT_GO_KEY in this process's environment only: it reaches the phone on adb's stdin (never
# argv, a log or the screen; the field hides it), and the console's workspace listing is the one live call. With
# several workspaces the pick shows and BYOKIT_GO_WORKSPACE (a workspace name) is tapped.
evidence=$EXPO_GO_EVIDENCE
mkdir -p "$evidence"
[ -n "${BYOKIT_GO_KEY:-}" ] || { echo 'BYOKIT_GO_KEY is not set' >&2; exit 1; }
shot() { a exec-out screencap -p > "$evidence/$1.png"; }
# The bounds of the element showing exactly this text, tapped from the same dump.
tap_text() {
  xy=$(screen | tr '>' '\n' | grep -F "text=\"$1\"" | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
    awk '$3 > $1 && $4 > $2 { print int(($1+$3)/2), int(($2+$4)/2); exit }')
  [ -n "$xy" ] || { echo "no \"$1\" on screen: $(words)" >&2; exit 1; }
  a shell input tap $xy
}
for theme in light dark; do
  case "$theme" in light) night=no;; dark) night=yes;; esac
  a shell cmd uimode night "$night"
  start
  expect "ChatGPT isn't signed in yet."
  seek opencode-signin
  expect "OpenCode Go isn't signed in yet."
  shot "${theme}__go-row"
done
a shell cmd uimode night no
start
tap opencode-signin
seek opencode-paste
expect 'Paste your key. It stays on this device.'
shot light__paste-empty
tap opencode-paste
printf '%s\n' "$BYOKIT_GO_KEY" | a shell 'IFS= read -r k; input text "$k"'
a shell input keyevent 111
shot light__paste-hidden
case "$(words)" in *"$BYOKIT_GO_KEY"*) echo 'FAILED, the key shows on screen' >&2; exit 1;; esac
echo 'ok: the pasted key is hidden'
tap opencode-connect
for _ in $(seq 20); do
  case "$(words)" in *'Pick the one to use.'*|*"OpenCode Go is connected."*) break;; esac
  sleep 1
done
case "$(words)" in *'Pick the one to use.'*)
  echo 'ok: several workspaces, the pick shows'
  shot light__workspace-pick
  tap_text "${BYOKIT_GO_WORKSPACE:?BYOKIT_GO_WORKSPACE names the workspace to pick}";;
esac
seek opencode-status
expect "OpenCode Go is connected."
start
seek opencode-picker
expect 'Ready'
shot light__ready
a shell cmd uimode night yes
start
seek opencode-picker
expect 'Ready'
shot dark__ready
a shell cmd uimode night no
echo "passed Go on $serial"
