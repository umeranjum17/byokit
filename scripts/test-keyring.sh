#!/bin/sh
# Real native keyring tests ONLY in an isolated bus, daemon, HOME and XDG tree.
set -eu
if [ "$(uname -s)" != Linux ] || ! command -v dbus-run-session >/dev/null || ! command -v gnome-keyring-daemon >/dev/null; then
  echo 'Real keyring test skipped: Linux D-Bus/gnome-keyring unavailable.'
  exit 0
fi
# Native tests import workspace packages through their built entry points.
npm run build
test_session_root=$(mktemp -d /tmp/ks.XXXXXX)
cleanup() {
  node --input-type=module -e 'import { rmSync } from "node:fs"; rmSync(process.argv[1], { recursive: true, force: true });' "$test_session_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$test_session_root/runtime" "$test_session_root/runtime/keyring"
owner_bus_address=${DBUS_SESSION_BUS_ADDRESS-}
# In particular GNOME_KEYRING_CONTROL, DBUS_STARTER_* and all owner XDG settings are absent.
env -i PATH="$PATH" LANG=C.UTF-8 TMPDIR=/tmp HOME="$test_session_root" \
  XDG_DATA_HOME="$test_session_root/data" XDG_CONFIG_HOME="$test_session_root/config" \
  XDG_CACHE_HOME="$test_session_root/cache" XDG_RUNTIME_DIR="$test_session_root/runtime" \
  BYOKIT_KEYRING_TEST_ROOT="$test_session_root" BYOKIT_KEYRING_OWNER_BUS="$owner_bus_address" \
  dbus-run-session -- sh -eu -c '
    case "$DBUS_SESSION_BUS_ADDRESS" in unix:path=/tmp/dbus-*|unix:abstract=/tmp/dbus-*) ;; *) echo "Refusing a non-private test bus" >&2; exit 1 ;; esac
    [ "$DBUS_SESSION_BUS_ADDRESS" != "$BYOKIT_KEYRING_OWNER_BUS" ] || { echo "Refusing the owner bus" >&2; exit 1; }
    [ -z "${GNOME_KEYRING_CONTROL-}" ] || exit 1
    printf "%s\n" "Umer-test-keyring-password" | gnome-keyring-daemon --unlock --components=secrets --control-directory="$XDG_RUNTIME_DIR/keyring"
    BYOKIT_KEYRING_TEST_BUS="$DBUS_SESSION_BUS_ADDRESS" BYOKIT_REAL_KEYRING=required \
      sh scripts/test.sh packages/secrets/test/keyring.test.ts
  '
