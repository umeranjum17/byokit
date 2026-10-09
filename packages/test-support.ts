import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parent = tmpdir();
const prefix = 'byokit-test-';
let root: string | undefined;
// Test teardown only: immutable engine sets need writable directories to unlink their children.
function discard(path: string): void {
  if (!existsSync(path)) return;
  const walk = (dir: string) => {
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) walk(join(dir, name));
  };
  walk(path); rmSync(path, { recursive: true, force: true });
}
export function removeScratch(path: string): void {
  if (!root || path !== root && !path.startsWith(root + '/')) throw new Error('not this process scratch');
  discard(path);
}
const children = new Set<{ kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>();

/** Remove only this project's scratch parents whose recorded process is no longer alive. */
export function cleanStaleScratch(): void {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const match = entry.isDirectory() && entry.name.match(/^byokit-test-(\d+)-/);
    if (!match) continue;
    let alive = true;
    try { process.kill(Number(match[1]), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (!alive) discard(join(parent, entry.name));
  }
}

function ensureRoot(): string {
  if (!root) {
    root = mkdtempSync(join(parent, `${prefix}${process.pid}-`));
    process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); discard(root!); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
      for (const child of children) child.kill('SIGKILL');
      discard(root!);
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
  return root;
}

export function scratchDir(name = 'fixture'): string {
  return mkdtempSync(join(ensureRoot(), `${name}-`));
}

/** Real-engine tests share one engine-set install per job when scripts/test.sh exports BYOKIT_TEST_ENGINE_DIR
 * (a job-scoped dir off tmpfs); unset keeps the per-scratch install, so a single file run directly still works. */
export function sharedEngineDir(): string | undefined {
  return process.env.BYOKIT_TEST_ENGINE_DIR;
}

export function trackChild<T extends { kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>(child: T): T {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
