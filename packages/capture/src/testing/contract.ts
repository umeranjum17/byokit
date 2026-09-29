// The contract suite (docs/capability-kits.md 5.5, 3.4): the same cases run against the fake recorder in `npm test`
// (BK-C2) and a real recorder on the owner's machine or in a lab (BK-C3). Cases needing `fake` skip without it.
import type { Capture } from '../capture.ts';
import type { Source } from '../types.ts';
import type { FakeRecorder } from './fake-recorder.ts';

export type CaptureContractBench = { capture: Capture; source: Source; root: string; fake?: FakeRecorder };
export type CaptureContractTestFn = (
  name: string,
  fn: (t: { skip(message?: string): void }) => void | Promise<void>,
) => void | Promise<void>;
export type CaptureContractOptions = {
  /** The runner's `test` (node:test's by default). */
  test?: CaptureContractTestFn;
};

export function captureContract(
  make: () => Promise<CaptureContractBench>,
  options?: CaptureContractOptions | CaptureContractTestFn,
): void {
  void make; void options;
  throw new Error('not built: BK-C1');
}
