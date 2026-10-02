// Fixture-only byte evidence. No gateway events or clipped output stand in for full provider bodies.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function emitEvidence(path: string, event: unknown): void {
  const fd = openSync(path, 'a', 0o600);
  try { writeSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

export async function boundedAwait<T>(stage: string, work: () => Promise<T>, emit: (event: unknown) => void, ms = 20_000): Promise<T> {
  emit({ stage, phase: 'start', at: Date.now() });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture await timed out: ${stage}`)), ms);
    })]);
    emit({ stage, phase: 'end', at: Date.now() }); return result;
  } catch (error) { emit({ stage, phase: 'error', at: Date.now(), error: String(error) }); throw error; }
  finally { clearTimeout(timer); }
  // Timeout bounds observation, NOT proof of cancellation or safe resource reuse.
}

export function sqliteTranscripts(root: string, destination: string) {
  const output: { path: string; snapshot: string; files: { suffix: string; sha256: string; bytes: number }[]; events: Record<string, unknown>[] }[] = [];
  const base = resolve(root);
  function visit(directory: string): void {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('transcript root is a symlink');
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { visit(path); continue; }
      if (!stat.isFile() || name !== 'openclaw-agent.sqlite') continue;
      const buffers = ['', '-wal', '-shm'].filter(suffix => existsSync(path + suffix)).map(suffix => {
        if (!lstatSync(path + suffix).isFile() || lstatSync(path + suffix).isSymbolicLink()) throw new Error('invalid SQLite sidecar');
        return { suffix, bytes: readFileSync(path + suffix) };
      });
      const snapshot = join(destination, relative(base, path)); mkdirSync(resolve(snapshot, '..'), { recursive: true, mode: 0o700 });
      for (const file of buffers) {
        writeFileSync(snapshot + file.suffix, file.bytes, { mode: 0o600 });
        if (!file.bytes.equals(readFileSync(path + file.suffix))) throw new Error('SQLite capture changed during snapshot');
      }
      // SQLite may update reader marks in SHM even on a read-only connection. Query a second copy.
      for (const file of buffers) writeFileSync(snapshot + '.query' + file.suffix, file.bytes, { mode: 0o600 });
      const db = new DatabaseSync(snapshot + '.query', { readOnly: true });
      try {
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('invalid SQLite snapshot');
        const events = db.prepare('SELECT * FROM transcript_events').all();
        output.push({ path, snapshot, files: buffers.map(file => ({ suffix: file.suffix, bytes: file.bytes.length,
          sha256: createHash('sha256').update(file.bytes).digest('hex') })), events });
      } finally { db.close(); }
    }
  }
  visit(base); return output;
}

export function scanCapabilities(value: unknown, capabilities: ReadonlySet<string>): { checked: number; matches: string[] } {
  const text = JSON.stringify(value);
  if (text === undefined || capabilities.size === 0 || [...capabilities].some(value => !value))
    throw new Error('privacy evidence unavailable');
  return { checked: capabilities.size, matches: [...capabilities].filter(value => text.includes(value))
    .map(value => createHash('sha256').update(value).digest('hex')) };
}
