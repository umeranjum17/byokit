// The client (docs/capability-kits.md 5.3): hello gate, record as an async iterator, stop, make. Bodies land in
// BK-C2 over supervise.ts (5.4) and protocol.ts (BK-C1).
import type { CaptureOptions, MakeOptions, MakeResult, RecordEvent, RecordOptions, RecorderHello } from './types.ts';

const notBuilt = (): never => { throw new Error('not built: BK-C2'); };

export class Capture {
  private readonly o: CaptureOptions;
  /** Validates only; spawns nothing and touches no disk. Validation lands in BK-C2. */
  constructor(o: CaptureOptions) {
    this.o = o;
  }
  hello(): Promise<RecorderHello> { return notBuilt(); }
  record(o: RecordOptions): AsyncIterableIterator<RecordEvent> { void o; return notBuilt(); }
  stop(): Promise<'stopping' | 'not-recording'> { return notBuilt(); }
  make(o: MakeOptions): Promise<MakeResult> { void o; return notBuilt(); }
}
