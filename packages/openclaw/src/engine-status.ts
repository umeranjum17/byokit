import { readFileSync } from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';

/** Every process the kit itself spawned, held for shutdown by pid. */
export class StartedProcesses {
  private readonly started = new Set<ChildProcess>();
  /** Record a spawn. Its pid is the kit's to signal; nothing else about it is. */
  add(child: ChildProcess): void { this.started.add(child); }
  forget(child: ChildProcess | undefined): void { if (child) this.started.delete(child); }
  /** SIGTERM each recorded pid, wait, SIGKILL the ones still running, wait. Never signals a process group. */
  async terminate(wait: (ms: number) => Promise<void>, graceMs = 3000): Promise<void> {
    for (const child of this.live()) this.signal(child, 'SIGTERM');
    await this.settle(wait, graceMs);
    for (const child of this.live()) this.signal(child, 'SIGKILL');
    await this.settle(wait, graceMs);
  }
  private live(): ChildProcess[] { return [...this.started].filter(child => child.exitCode === null && child.signalCode === null); }
  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    const { pid } = child;
    if (pid === undefined) return;
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
  private async settle(wait: (ms: number) => Promise<void>, graceMs: number): Promise<void> {
    for (let waited = 200; waited <= graceMs && this.live().length; waited += 200) await wait(200);
  }
}

/** A live or unverifiable writer still owns the isolated engine state. Retry after it stops. */
export class EngineAlreadyRunningError extends Error {
  readonly code = 'engine-already-running';
  constructor() {
    super('engine already running; credential store is in use');
    this.name = 'EngineAlreadyRunningError';
  }
}

export function pidAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true; // An invalid guard is ambiguous, never stale.
  try {
    process.kill(pid, 0);
    // An orphan can remain a zombie until its new parent reaps it; it has no writer left.
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    } else if (platform !== 'win32' && psReportsZombie(pid)) {
      // No /proc here (notably macOS): only a definite zombie reads as stale.
      return false;
    }
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * Why ps: `ps -o stat=` exists on macOS and Linux with the same leading-letter state
 * convention, so a `Z` first letter names the same kernel fact the /proc read names on
 * Linux. Linux keeps its /proc read (no subprocess, unchanged answers); every other Unix
 * asks ps. Only positive `Z` evidence flips the answer — a missing ps, an empty reply,
 * or gibberish keeps the guard, so a reused live pid is never stolen.
 */
function psReportsZombie(pid: number): boolean {
  try {
    const probed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return (probed.stdout ?? '').trimStart().startsWith('Z');
  } catch {
    return false;
  }
}
