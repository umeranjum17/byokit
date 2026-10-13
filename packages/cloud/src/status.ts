// status(): the one read a phone polls (docs/cloud-kit.md 5.9). The host is asked only while
// the machine is on, because `host()` runs a command on the machine.
import { hostWords, stateWords } from './words.ts';
import type { HostState, Machine, MachineState } from './types.ts';

export type Status = { machine: MachineState; host: HostState | null; words: string };

/** The machine's state, its host's state while on, and the one sentence to show. */
export async function status(m: Machine, vars: { app: string; label: string }): Promise<Status> {
  const machine = await m.state();
  if (machine !== 'on') return { machine, host: null, words: stateWords(machine, vars) };
  let host: HostState;
  try {
    host = await m.host();
  } catch (e) {
    const now = await m.state();
    if (now === 'on') throw e;
    return { machine: now, host: null, words: stateWords(now, vars) };
  }
  return { machine, host, words: hostWords(host, vars) };
}
