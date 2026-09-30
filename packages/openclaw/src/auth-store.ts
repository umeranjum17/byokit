// The pin persists OAuth JSON in both shared and agent SQLite. There is no public persistence hook.
// Seal the complete isolated stores, including journals, only after their writer has exited.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { SealingAdapter } from '@byokit/secrets';

const encoder = new TextEncoder();
const archive = (name: string) => /^(auth-profiles|auth-state|auth|oauth)\.json\.(migrated-.+|sqlite-import\..+\.bak)$/.test(name)
  || name.endsWith('.moved-to-engine');
const live = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
function regular(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error('credential store requires regular files');
}
function put(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.sealing-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    // POSIX directory fsync makes the rename durable before any plaintext is removed.
    if (process.platform !== 'win32') {
      const parent = openSync(dirname(path), 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  } finally { rmSync(tmp, { force: true }); }
}
type Snapshot = { v: 1; dirs: string[]; files: [string, string][] };
function safePath(path: unknown): path is string {
  return typeof path === 'string' && /^(state|home)(\/[^/]+)*$/.test(path)
    && !path.split('/').some((part) => part === '.' || part === '..' || part.includes('\\') || part.includes('\0'));
}
function snapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (s?.v !== 1 || !Array.isArray(s.dirs) || !Array.isArray(s.files)) throw new Error('invalid sealed credential store');
  const paths = new Set<string>();
  for (const path of s.dirs) {
    if (!safePath(path) || paths.has(path)) throw new Error('invalid sealed credential path');
    paths.add(path);
  }
  for (const entry of s.files) {
    if (!Array.isArray(entry) || entry.length !== 2 || !safePath(entry[0]) || typeof entry[1] !== 'string'
      || paths.has(entry[0]) || Buffer.from(entry[1], 'base64').toString('base64') !== entry[1]) throw new Error('invalid sealed credential file');
    paths.add(entry[0]);
    if (!s.dirs.includes(dirname(entry[0]))) throw new Error('invalid sealed credential parent');
  }
  for (const path of s.dirs) if (path.includes('/') && !s.dirs.includes(dirname(path))) throw new Error('invalid sealed credential parent');
  return s;
}

export class AuthStore {
  private active = false;
  private owned = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly lock: string;
  private readonly cleanup: string;
  private readonly restoring: string;
  constructor(privateOptions: { root: string; stateDir: string; engineDir: string; seal?: SealingAdapter; log?: (line: string) => void }) {
    this.o = privateOptions;
    this.file = join(this.o.root, 'auth-store.sealed');
    this.lock = join(this.o.root, 'auth-store.lock');
    this.cleanup = join(this.o.root, 'auth-store.cleanup');
    this.restoring = join(this.o.root, 'auth-store.restoring');
  }
  private readonly o: { root: string; stateDir: string; engineDir: string; seal?: SealingAdapter; log?: (line: string) => void };
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private acquire(): void {
    if (this.owned) return;
    if (existsSync(this.file) && !this.o.seal) throw new Error('authSeal required for sealed credential store');
    if (!this.o.seal) return;
    // Never race a live gateway or another kit, including an orphan after its host crashed.
    const gateway = join(this.o.root, 'gateway.pid');
    if (existsSync(gateway) && live(Number(readFileSync(gateway, 'utf8')))) throw new Error('credential store is in use');
    if (existsSync(this.lock)) {
      if (!lstatSync(this.lock).isDirectory() || lstatSync(this.lock).isSymbolicLink()) throw new Error('invalid credential lock');
      const owner = join(this.lock, 'pid');
      if (!existsSync(owner) || live(Number(readFileSync(owner, 'utf8')))) throw new Error('credential store is in use');
      rmSync(this.lock, { recursive: true });
    }
    mkdirSync(this.lock, { mode: 0o700 });
    writeFileSync(join(this.lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
    this.owned = true;
  }
  private release(): void {
    if (!this.owned) return;
    rmSync(this.lock, { recursive: true });
    this.owned = false;
  }
  private async read(): Promise<Snapshot | undefined> {
    if (!existsSync(this.file)) return undefined;
    regular(this.file);
    return snapshot(this.o.seal!.decryptString(readFileSync(this.file)));
  }
  private collect(): Snapshot {
    const s: Snapshot = { v: 1, dirs: [], files: [] };
    const walk = (path: string) => {
      const name = relative(this.o.root, path).split('\\').join('/');
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        chmodSync(path, 0o700);
        s.dirs.push(name);
        for (const child of readdirSync(path).sort()) walk(join(path, child));
        return;
      }
      regular(path);
      chmodSync(path, 0o600);
      s.files.push([name, readFileSync(path).toString('base64')]);
    };
    for (const dir of ['state', 'home']) if (existsSync(join(this.o.root, dir))) walk(join(this.o.root, dir));
    return s;
  }
  private async persist(): Promise<void> {
    if (!this.o.seal) return;
    // Always authenticate an earlier snapshot before considering a leftover live store after a crash.
    const previous = await this.read();
    if (previous && (existsSync(this.cleanup) || existsSync(this.restoring))) {
      for (const dir of ['state', 'home']) rmSync(join(this.o.root, dir), { recursive: true, force: true });
      rmSync(this.cleanup, { force: true });
      rmSync(this.restoring, { force: true });
      this.o.log?.('interrupted credential transition recovered');
    }
    const hasLive = ['state', 'home'].some((dir) => existsSync(join(this.o.root, dir)));
    if (!hasLive && previous) return;
    const text = JSON.stringify(this.collect());
    const sealed = this.o.seal.encryptString(text);
    if (this.o.seal.decryptString(Buffer.from(sealed)) !== text) throw new Error('credential seal verification failed');
    put(this.file, sealed);
    if (this.o.seal.decryptString(readFileSync(this.file)) !== text) throw new Error('credential seal verification failed');
    put(this.cleanup, encoder.encode('1'));
    for (const dir of ['state', 'home']) rmSync(join(this.o.root, dir), { recursive: true, force: true });
    rmSync(this.cleanup, { force: true });
  }

  private async restore(): Promise<void> {
    if (!this.o.seal) return;
    const saved = await this.read();
    // A crashed host may leave a newer live state; prepare seals that before restore.
    put(this.restoring, encoder.encode('1'));
    if (saved) {
      for (const dir of saved.dirs.sort((a, b) => a.split('/').length - b.split('/').length))
        mkdirSync(join(this.o.root, dir), { recursive: true, mode: 0o700 });
      for (const [path, data] of saved.files) put(join(this.o.root, path), Buffer.from(data, 'base64'));
    }
    for (const dir of ['state', 'home']) mkdirSync(join(this.o.root, dir), { recursive: true, mode: 0o700 });
    rmSync(this.restoring, { force: true });
  }
  async archives(): Promise<void> {
    const ignored = new Set([resolve(this.o.engineDir), ...['npm-cache', 'install-home', 'tmp', 'plugin', 'workspaces'].map((d) => resolve(this.o.root, d))]);
    const walk = async (dir: string): Promise<void> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (ignored.has(resolve(path)) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile() || !archive(entry.name)) continue;
        if (!this.o.seal && entry.name.endsWith('.moved-to-engine') && !existsSync(path + '.canonicalized')) continue;
        await retireArchive(path, this.o.seal, this.o.log);
      }
    };
    if (existsSync(this.o.stateDir)) await walk(this.o.stateDir);
  }
  prepare(): Promise<void> {
    return this.serial(async () => {
      if (this.active) return;
      this.acquire();
      try {
        await this.read();
        await this.archives();
        await this.persist();
      } finally { this.release(); }
    });
  }
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.active) return;
      this.acquire();
      try { await this.restore(); this.active = true; } catch (error) { this.release(); throw error; }
    });
  }
  stop(): Promise<void> {
    return this.serial(async () => {
      this.acquire();
      await this.archives();
      await this.persist();
      this.active = false;
      this.release();
    });
  }
  offline<T>(task: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (this.active) throw new Error('credential migration requires a stopped engine');
      this.acquire();
      try {
        await this.restore();
        try { return await task(); }
        finally { await this.archives(); await this.persist(); }
      } finally { this.release(); }
    });
  }
}

/** A retired archive is never restored as a live engine source. */
export async function retireArchive(path: string, seal?: SealingAdapter, log?: (line: string) => void): Promise<void> {
  regular(path);
  if (seal) {
    const bytes = readFileSync(path);
    try {
      const text = bytes.toString('base64');
      const sealed = seal.encryptString(text);
      if (seal.decryptString(Buffer.from(sealed)) !== text) throw new Error('archive seal verification failed');
      put(path + '.sealed', sealed);
      if (seal.decryptString(readFileSync(path + '.sealed')) !== text) throw new Error('archive seal verification failed');
    } finally { bytes.fill(0); }
  }
  rmSync(path);
  log?.(seal ? 'credential archive sealed' : 'verified credential archive removed');
}
