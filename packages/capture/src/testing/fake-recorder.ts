// The fake recorder (docs/capability-kits.md 5.5): a Node shim bin speaking recorder protocol v1, scripted through
// <dir>/script.json and logging every run to <dir>/invocations.jsonl. Lands in BK-C1.
import type { RecorderHello } from '../types.ts';

export type RecorderErrorWire = { code: string; message: string; hint?: string; [k: string]: unknown };
export type FakeRecorderScript = {
  /** Merged over the default hello. */
  hello?: Partial<RecorderHello>;
  /** screen only, default 'yes'; 'timeout' answers at once, no 120 s wait. */
  consent?: 'yes' | 'no' | 'timeout';
  /** Take length before `done` unless stopped, default 1, capped by --max-seconds. */
  seconds?: number;
  /** make answers this envelope. */
  makeError?: RecorderErrorWire;
  /** Default 1000. */
  plannedTokens?: number;
  /** Print `not json` instead of the answer. */
  corrupt?: 'hello' | 'record' | 'make';
  /** Write 9 MB to that stream, then hang. */
  flood?: 'stdout' | 'stderr';
  /** Never answer. */
  hang?: 'hello' | 'stop' | 'make';
};
export type FakeInvocation = { argv: string[]; env: Record<string, string>; key?: string; captions?: unknown };
export type FakeRecorder = {
  /** Absolute path of the shim (0700). */
  bin: string;
  /** Replaces the script for later runs. */
  script(s: FakeRecorderScript): void;
  /** Every run so far, in order. */
  invocations(): FakeInvocation[];
};

export function fakeRecorder(o: { dir: string; script?: FakeRecorderScript }): FakeRecorder {
  void o;
  throw new Error('not built: BK-C1');
}
