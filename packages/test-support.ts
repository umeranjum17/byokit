import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parent = tmpdir();
const prefix = 'byokit-test-';
let root: string | undefined;
const children = new Set<{ kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>();

/** Remove only this project's scratch parents whose recorded process is no longer alive. */
export function cleanStaleScratch(): void {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const match = entry.isDirectory() && entry.name.match(/^byokit-test-(\d+)-/);
    if (!match) continue;
    let alive = true;
    try { process.kill(Number(match[1]), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (!alive) rmSync(join(parent, entry.name), { recursive: true, force: true });
  }
}

function ensureRoot(): string {
  if (!root) {
    root = mkdtempSync(join(parent, `${prefix}${process.pid}-`));
    process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); rmSync(root!, { recursive: true, force: true }); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
      for (const child of children) child.kill('SIGKILL');
      rmSync(root!, { recursive: true, force: true });
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
  return root;
}

export function scratchDir(name = 'fixture'): string {
  return mkdtempSync(join(ensureRoot(), `${name}-`));
}

export function trackChild<T extends { kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>(child: T): T {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
