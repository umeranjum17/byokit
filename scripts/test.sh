#!/bin/sh
# Every test runs in a throwaway HOME, and the real ~/.pi (its sign-ins, settings, models and extensions) must come out
# of the run byte for byte as it went in. Its sessions are left out: a running pi writes those on its own.
set -eu
# Each invocation owns a short scratch folder, even if callers share TMPDIR, and it is created
# directly under /tmp rather than under an inherited TMPDIR or another mktemp level: a deep parent
# overflows Unix socket paths (EINVAL on listen) and reads as a product failure, not an environment one.
scratch_parent=/tmp
run_tmp=$(mktemp -d "$scratch_parent/bt.XXXXXX")
export TMPDIR="$run_tmp"
# One engine-set install per job, shared by every real-engine test file through BYOKIT_TEST_ENGINE_DIR: each
# file's engineDir otherwise defaults to its own tmpfs scratch, so an engine job installs the ~2 GB pinned engine
# twelve times into RAM-backed /tmp (and downloads it twelve times: the npm cache is per scratch root too).
# The shared dir lives off tmpfs; a caller-provided value (verify-byokit features) is kept as-is.
# Frozen engine sets are 0555/0444 on purpose; make them removable before rm.
chmod_tree() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o700);
  for (const name of fs.readdirSync(dir)) {
    const path = dir + '/' + name;
    if (fs.lstatSync(path).isDirectory()) walk(path); else fs.chmodSync(path, 0o700);
  }
};
try { walk(process.argv[2]); } catch { /* best effort: cleanup must not mask the test result */ }
NODE
}
engine_root="${XDG_CACHE_HOME:-$HOME/.cache}/byokit-engine-tests"
engine_job=""
if [ -z "${BYOKIT_TEST_ENGINE_DIR:-}" ] && mkdir -p "$engine_root" 2>/dev/null; then
  for stale in $(find "$engine_root" -maxdepth 1 -name 'job.*' -mtime +1 2>/dev/null || true); do # sweep jobs killed before cleanup
    chmod_tree "$stale" || true
    rm -rf "$stale" || true
  done
  if engine_job=$(mktemp -d "$engine_root/job.XXXXXX" 2>/dev/null); then
    export BYOKIT_TEST_ENGINE_DIR="$engine_job/engine"
  fi
fi
# The EXIT trap below invokes this function indirectly.
# shellcheck disable=SC2329
cleanup() {
  if [ -n "$engine_job" ]; then
    chmod_tree "$engine_job" || true
    rm -rf "$engine_job" || true
  fi
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
