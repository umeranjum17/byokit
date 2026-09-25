import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One isolated parent per test process; the exit and signal handlers cover failures and interrupted runs.
const root = mkdtempSync(join(tmpdir(), `byokit-test-${process.pid}-`));
const children = new Set<{ kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>();
process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});

export function scratchDir(name = 'fixture'): string {
  return mkdtempSync(join(root, `${name}-`));
}

export function trackChild<T extends { kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', listener: () => void): unknown }>(child: T): T {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
