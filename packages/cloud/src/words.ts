// Every sentence a person can see, in one file other languages can read too (words.json, section 12).
// Plain words only: no codes, commands, paths, model ids or jargon a person would have to look up;
// words.test.ts holds the line with the same banned-jargon expression packages/herdr uses.
import WORDS from './words.json' with { type: 'json' };
import type { HostState, KeyInfo, MachineState } from './types.ts';
import type { MachineError, MachineErrorCode } from './errors.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const STATE_KEY: Record<MachineState, WordKey> = {
  creating: 'state.creating', on: 'state.on', asleep: 'state.asleep', waking: 'state.waking',
  stopping: 'state.stopping', unknown: 'state.unknown', failed: 'state.failed',
  'host-key-changed': 'state.host-key-changed', gone: 'state.gone',
};

/** The sentence for a machine state. */
export const stateWords = (s: MachineState, vars: { app: string; label: string }): string =>
  words(STATE_KEY[s], vars);

const HOST_KEY: Record<HostState, WordKey> = {
  'not-installed': 'host.not-installed', installing: 'host.installing', running: 'host.running',
  restarting: 'host.restarting', stopped: 'host.stopped', failed: 'host.failed',
};

/** The sentence for a host state. */
export const hostWords = (s: HostState, vars: { app: string }): string =>
  words(HOST_KEY[s], vars);

/**
 * The key-expiry warning (11.3): `key.expiring` with `{date}` as YYYY-MM-DD when `k.expires`
 * is within `days` of `now`, else `null`.
 */
export const keyWords = (k: KeyInfo, o: { label: string; now: Date; days?: number }): string | null => {
  if (k.expires === null) return null;
  const expires = Date.parse(k.expires);
  if (Number.isNaN(expires)) return null;
  if (expires - o.now.getTime() > (o.days ?? 14) * 86_400_000) return null;
  return words('key.expiring', { label: o.label, date: k.expires.slice(0, 10) });
};

const ERROR_KEY: Record<MachineErrorCode, WordKey> = {
  unauthorized: 'error.key',
  balance: 'cost.balance',
  unreachable: 'state.unknown',
  timeout: 'error.slow',
  provider: 'state.failed',
  'host-key': 'state.host-key-changed',
  'not-linux': 'error.notLinux',
  linger: 'host.linger',
  'needs-root': 'host.needsRoot',
  'wrong-account': 'error.wrongAccount',
  'no-machine': 'error.app',
  exists: 'error.app',
  unsupported: 'error.app',
  confirm: 'error.app',
  'bad-recipe': 'error.app',
};

/** The sentence to show for a kit failure (section 12 table). */
export const errorWords = (e: MachineError, vars: { app: string; label: string }): string => {
  if (e.code === 'needs-root' && !e.extra.command) return words('host.needsAdmin', vars);
  return words(ERROR_KEY[e.code], vars);
};
