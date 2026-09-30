// Check before loading/calling any native entry; opt-in alone is never permission to use a user bus.
export function assertPrivateKeyringSession(env: NodeJS.ProcessEnv): void {
  const root = env.BYOKIT_KEYRING_TEST_ROOT;
  const bus = env.DBUS_SESSION_BUS_ADDRESS;
  if (!root || !/^\/tmp\/ks\.[A-Za-z0-9]+$/.test(root) || !bus ||
      !/^unix:(path|abstract)=\/tmp\/dbus-[^,]+(?:,guid=[a-f0-9]+)?$/.test(bus) ||
      bus !== env.BYOKIT_KEYRING_TEST_BUS || bus === env.BYOKIT_KEYRING_OWNER_BUS ||
      env.XDG_RUNTIME_DIR !== `${root}/runtime` || env.XDG_DATA_HOME !== `${root}/data` ||
      env.XDG_CONFIG_HOME !== `${root}/config` || env.XDG_CACHE_HOME !== `${root}/cache` ||
      env.GNOME_KEYRING_CONTROL !== undefined || env.GNOME_KEYRING_PID !== undefined ||
      env.DBUS_STARTER_ADDRESS !== undefined || env.DBUS_STARTER_BUS_TYPE !== undefined) {
    throw new Error('Real keyring tests require scripts/test-keyring.sh and its private OS session');
  }
}
