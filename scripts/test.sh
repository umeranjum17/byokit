#!/bin/sh
# Every test runs in a throwaway HOME, and the real ~/.pi (its sign-ins, settings, models and extensions) must come out
# of the run byte for byte as it went in. Its sessions are left out: a running pi writes those on its own.
set -eu
pi_state() {
  [ -d "$HOME/.pi/agent" ] || return 0
  (cd "$HOME/.pi/agent" && find auth.json settings.json models.json extensions -type f 2>/dev/null | sort | xargs -r sha256sum)
}
before=$(pi_state)
node --input-type=module -e "import('./packages/test-support.ts').then(({ cleanStaleScratch }) => cleanStaleScratch())"
tmp_before=$(find "$(node -p 'require("node:os").tmpdir()')" -maxdepth 1 -type d -name 'byokit-*' -printf '%f\n' | sort)
throwaway=$(mktemp -d)
trap 'rm -rf "$throwaway"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ $# -gt 0 ] || set -- 'packages/*/test/*.test.ts'
# Browsers Playwright installed stay where they are; nothing else of the real HOME is seen.
if PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright} HOME="$throwaway" node --test --test-concurrency=1 "$@"; then test_status=0; else test_status=$?; fi
tmp_after=$(find "$(node -p 'require("node:os").tmpdir()')" -maxdepth 1 -type d -name 'byokit-*' -printf '%f\n' | sort)
leaks=$(printf '%s\n' "$tmp_after" | while IFS= read -r entry; do [ -z "$entry" ] || printf '%s\n' "$tmp_before" | grep -qxF "$entry" || printf '%s\n' "$entry"; done)
if [ -n "$leaks" ]; then echo "test run leaked project temp directories in $(node -p 'require("node:os").tmpdir()'):" >&2; printf '%s\n' "$leaks" >&2; test_status=1; fi
[ "$(pi_state)" = "$before" ] || { echo "~/.pi changed while the tests ran" >&2; test_status=1; }
[ -z "$before" ] || echo "~/.pi: sign-ins, settings and extensions unchanged, byte for byte."
exit "$test_status"
