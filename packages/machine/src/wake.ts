// Wake-on-open resolver (docs/machine-kit.md M7). M1 stub: signature frozen, body lands in M7.
import type { MachineRef, Provider } from './types.ts';

export function wakeResolve(o: { provider: Provider; ref: MachineRef; port: number }): (url: string) => Promise<string> {
  void o;
  throw new Error('not built: M7');
}
