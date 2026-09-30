#!/bin/sh
# Every test runs in a throwaway HOME, and the real ~/.pi (its sign-ins, settings, models and extensions) must come out
# of the run byte for byte as it went in. Its sessions are left out: a running pi writes those on its own.
set -eu
# Each invocation owns a short scratch folder, even if callers share TMPDIR.
# Set it before any helper scans scratch so cleanup and leak detection cannot
# see another run's files. With the default parent this is /tmp/bt.XXXXXX.
scratch_parent=$(node -p 'require("node:os").tmpdir()')
run_tmp=$(mktemp -d "$scratch_parent/bt.XXXXXX")
export TMPDIR="$run_tmp"
# The EXIT trap below invokes this function indirectly.
# shellcheck disable=SC2329
cleanup() {
  node --input-type=module -e 'import { rmSync } from "node:fs"; rmSync(process.argv[1], { recursive: true, force: true });' "$run_tmp"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pi_state() {
  [ -d "$HOME/.pi/agent" ] || return 0
  (cd "$HOME/.pi/agent" && find auth.json settings.json models.json extensions -type f 2>/dev/null | sort | xargs -r sha256sum)
}
before=$(pi_state)
throwaway=$(mktemp -d "$run_tmp/home.XXXXXX")
# Tests are offline by contract; the guard makes an outbound dial fail loudly instead of leaving the machine.
root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $root/scripts/test-egress-guard.cjs"
[ $# -gt 0 ] || set -- 'packages/*/test/*.test.ts' 'scripts/*.test.ts'
# Browsers Playwright installed stay where they are; nothing else of the real HOME is seen.
browser_cache=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}
if PLAYWRIGHT_BROWSERS_PATH="$browser_cache" HOME="$throwaway" node --test --test-concurrency=1 "$@"; then test_status=0; else test_status=$?; fi
leaks=$(find "$run_tmp" -maxdepth 1 -type d -name 'byokit-*' -printf '%f\n' | sort)
if [ -n "$leaks" ]; then echo "test run leaked project temp directories in $run_tmp:" >&2; printf '%s\n' "$leaks" >&2; test_status=1; fi
# These messages name ~/.pi literally; they are not shell paths.
# shellcheck disable=SC2088
[ "$(pi_state)" = "$before" ] || { echo "~/.pi changed while the tests ran" >&2; test_status=1; }
# shellcheck disable=SC2088
[ -z "$before" ] || echo "~/.pi: sign-ins, settings and extensions unchanged, byte for byte."
exit "$test_status"
