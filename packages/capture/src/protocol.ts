// Wire parsers for recorder protocol v1 (docs/capability-kits.md 6, BK-C1). Each throws CaptureError('protocol') on
// a shape violation; parseHello checks the protocol range first and throws needs-update outside it (9.3 BK-C1).
import type { CaptureError } from './errors.ts';
import type { MakeResult, RecordEvent, RecorderHello } from './types.ts';

export type RecorderErrorLine = { code: string; message: string; hint?: string; extra: Record<string, unknown> };

const notBuilt = (): never => { throw new Error('not built: BK-C1'); };

export function parseHello(line: string): RecorderHello { void line; return notBuilt(); }
/** null for unknown events. */
export function parseEvent(line: string): RecordEvent | null { void line; return notBuilt(); }
/** Maps the wire's snake_case planner fields. */
export function parseMake(line: string): MakeResult { void line; return notBuilt(); }
/** null when the line is not an error envelope. */
export function parseError(line: string): RecorderErrorLine | null { void line; return notBuilt(); }
/** The 6.7 table. */
export function toCaptureError(e: RecorderErrorLine): CaptureError { void e; return notBuilt(); }
