// Config invariants (5.6): defaults + app config deep-merged under the forced invariants, written only when the
// bytes change. Built in O3.
import type { KitOptions } from './kit.ts';
import type { Member } from './types.ts';

export function reconcileConfig(
  saved: object | undefined,
  o: {
    root: string;
    stateDir: string;
    port: number;
    pluginId: string;
    pluginDir: string;
    policyPath: string;
    app?: object;
    installPolicy?: KitOptions['installPolicy'];
  },
): object {
  throw new Error('not built: O3');
}

export function memoryLimited(config: object, member: Member): boolean {
  throw new Error('not built: O3');
}
