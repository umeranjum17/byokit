// Env from nothing, argv, spawn, caps and the wall-clock guard (docs/capability-kits.md 5.4, D-G, D-K). Bodies land
// in BK-C2.
import type { CaptureOptions, MakeOptions, RecordOptions, Source } from './types.ts';

export type Spawned = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean };
export type RecorderCall =
  | { verb: 'hello' }
  | { verb: 'stop' }
  | { verb: 'record'; o: RecordOptions }
  | { verb: 'make'; o: MakeOptions; captionsFile?: string };

const notBuilt = (): never => { throw new Error('not built: BK-C2'); };

/** HOME/XDG under join(stateDir, 'capture', 'home'), PATH=/usr/bin:/bin, LANG, plus display vars by source. */
export function recorderEnv(o: { stateDir: string; source?: Source; display?: CaptureOptions['display'] }): Record<string, string> {
  void o; return notBuilt();
}

/** Starts ['capture', verb, …]; every element a string without NUL. */
export function recorderArgv(stateDir: string, call: RecorderCall): string[] {
  void stateDir; void call; return notBuilt();
}

/** One call to completion: timeout (SIGTERM, SIGKILL 5 s later), 8 MB per stream, key on fd 3 only. */
export function runRecorder(
  bin: string, env: Record<string, string>, args: string[],
  o: { timeoutMs: number; key?: string; signal?: AbortSignal },
): Promise<Spawned> {
  void bin; void env; void args; void o; return notBuilt();
}

/** A record process as lines; past `guardMs` it stops itself and `exited` reports guarded: true. */
export function streamRecorder(
  bin: string, env: Record<string, string>, args: string[], o: { guardMs: number },
): { lines: AsyncIterable<string>; exited: Promise<Spawned & { guarded: boolean }>; kill(signal: NodeJS.Signals): void } {
  void bin; void env; void args; void o; return notBuilt();
}

/** (maxSeconds + CONSENT_WINDOW_S + 30) * 1000. */
export function recordGuardMs(maxSeconds: number): number {
  void maxSeconds; return notBuilt();
}
