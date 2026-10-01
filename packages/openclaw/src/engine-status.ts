import { readFileSync } from 'node:fs';

/** A live or unverifiable writer still owns the isolated engine state. Retry after it stops. */
export class EngineAlreadyRunningError extends Error {
  readonly code = 'engine-already-running';
  constructor() {
    super('engine already running; credential store is in use');
    this.name = 'EngineAlreadyRunningError';
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true; // An invalid guard is ambiguous, never stale.
  try {
    process.kill(pid, 0);
    // An orphan can remain a zombie until its new parent reaps it; it has no writer left.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
