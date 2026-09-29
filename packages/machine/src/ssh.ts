// SSH VM adapter (docs/machine-kit.md section 7, './ssh' entry, Node only).
// M1 stub: signatures frozen, bodies land in M2.
import type { Price, Provider } from './types.ts';

export function sshVm(o: {
  ssh: string /* absolute */; host: string; port?: number; user: string; keyPath: string; stateDir: string; label: string; monthly?: Price
}): Provider {
  void o;
  throw new Error('not built: M2');
}

export function sshHostKey(o: { ssh: string; host: string; port?: number; stateDir: string }):
  Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }> {
  void o;
  throw new Error('not built: M2');
}
