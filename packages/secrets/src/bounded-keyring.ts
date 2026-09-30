// Native keyring work runs outside the synchronous host so a hung OS service is bounded.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { KeystoreError } from './errors.ts';
import type { KeyringBackend } from './os-keyring.ts';

export function boundedKeyring(o: { service: string; timeoutMs?: number }): KeyringBackend {
  const timeout = o.timeoutMs ?? 1000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) throw new KeystoreError('invalid', 'Keyring timeout must be between 100 and 5000 milliseconds');
  // The pinned Keychain binding cannot disable authorization UI. Automatic selection must
  // not trigger it; explicit osKeyring() remains available to hosts permitting interaction.
  if (process.platform === 'darwin') throw new KeystoreError('unavailable', 'Non-interactive Keychain access is unavailable');
  const call = (operation: string, name: string, secret?: string): string | null | boolean => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './keyring-worker.ts' : './keyring-worker.js', import.meta.url))], {
      input: JSON.stringify({ service: o.service, operation, name, secret }), encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: '1', HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, NODE_OPTIONS: process.env.NODE_OPTIONS },
    });
    try {
      if (result.error || result.status !== 0) throw new Error();
      return JSON.parse(result.stdout) as string | null | boolean;
    } catch { throw new KeystoreError('unavailable', 'No non-interactive OS keyring is available or accessible'); }
  };
  return { get: (name) => call('get', name) as string | null, set: (name, secret) => { call('set', name, secret); }, delete: (name) => call('delete', name) as boolean };
}
