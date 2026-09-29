// The fake engine (docs/capability-kits.md 4.7): its own small logic, no engine code copied. Lands in BK-P1.
import type { Engine, EngineRequest, EngineVerb } from '../types.ts';

export type FakeEngineOptions = {
  /** Default PROTOCOL. */
  protocol?: number;
  /** Default '0.0.0-fake'. */
  version?: string;
  /** That verb answers the error envelope. */
  fail?: { verb: EngineVerb; code: string; message: string };
};
/** `requests`: every request, in order. */
export type FakeEngine = Engine & { requests: EngineRequest[] };

export function fakeEngine(o?: FakeEngineOptions): FakeEngine {
  void o;
  throw new Error('not built: BK-P1');
}
