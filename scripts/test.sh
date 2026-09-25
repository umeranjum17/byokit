#!/bin/sh
# Every test runs in a throwaway HOME, and the real ~/.pi (its sign-ins, settings, models and extensions) must come out
# of the run byte for byte as it went in. Its sessions are left out: a running pi writes those on its own.
set -eu
pi_state() {
  [ -d "$HOME/.pi/agent" ] || return 0
  (cd "$HOME/.pi/agent" && find auth.json settings.json models.json extensions -type f 2>/dev/null | sort | xargs -r sha256sum)
}
before=$(pi_state)
throwaway=$(mktemp -d)
trap 'rm -rf "$throwaway"' EXIT
[ $# -gt 0 ] || set -- 'packages/*/test/*.test.ts'
# Browsers Playwright installed stay where they are; nothing else of the real HOME is seen.
PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright} HOME="$throwaway" node --test --test-concurrency=1 "$@"
[ "$(pi_state)" = "$before" ] || { echo "~/.pi changed while the tests ran" >&2; exit 1; }
[ -z "$before" ] || echo "~/.pi: sign-ins, settings and extensions unchanged, byte for byte."
