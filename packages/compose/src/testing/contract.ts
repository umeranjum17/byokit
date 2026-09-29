// The contract suite (docs/capability-kits.md 4.7, 3.4): the same cases run against the fake engine in `npm test`
// (BK-P1) and the real pinned engine in the compose-engine CI job (BK-P2). Cases needing `fake` skip without it.
import type { Compose } from '../compose.ts';
import type { FakeEngine } from './fake-engine.ts';

export type ComposeContractBench = { compose: Compose; fake?: FakeEngine };
export type ComposeContractTestFn = (
  name: string,
  fn: (t: { skip(message?: string): void }) => void | Promise<void>,
) => void | Promise<void>;
export type ComposeContractOptions = {
  /** The runner's `test` (node:test's by default). */
  test?: ComposeContractTestFn;
};

export function composeContract(
  make: () => Promise<ComposeContractBench>,
  options?: ComposeContractOptions | ComposeContractTestFn,
): void {
  void make; void options;
  throw new Error('not built: BK-P1');
}
