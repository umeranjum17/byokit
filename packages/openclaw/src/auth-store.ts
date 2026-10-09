// The pin persists OAuth JSON in both shared and agent SQLite. There is no public persistence hook.
// Seal only credential state — the engine's complete `state` tree plus every config/credential path in
// `home` — never the regenerable tool caches, transcripts and logs a signed-in home accumulates.
// Sealing those too once produced a snapshot past the runtime string limit and aborted boot; the collector is
// narrowed to credential state and capped (SEAL_CAP_BYTES), refusing with a typed error instead.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SealingAdapter } from '@byokit/secrets';
import { EngineAlreadyRunningError, pidAlive as live } from './engine-status.ts';

const encoder = new TextEncoder();
const archive = (name: string) => /^(auth-profiles|auth-state|auth|oauth)\.json\.(migrated-.+|sqlite-import\..+\.bak)$/.test(name)
  || name.endsWith('.moved-to-engine');
function regular(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error(`credential store requires regular files: ${path}`);
}
function syncDir(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function removeMarker(path: string): void {
  rmSync(path, { force: true });
  syncDir(dirname(path));
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
    syncDir(dirname(path));
  } finally { rmSync(tmp, { force: true }); }
}
// Always written as `v: 1`: released readers through 0.6.1 reject any other tag, so 0.6.2's `v: 2` locked a host
// rolled back to an earlier kit out of its sign-in. `v: 2` stays readable and re-seals as `v: 1`.
type Snapshot = { v: 1 | 2; dirs: string[]; files: [string, string][] };
// Credential state is what restores a working signed-in session. Regenerable tool caches, transcripts
// and logs never do: the XDG cache and npm cache homes the kit's engine environment pins, plus the
// transcript/log/cache subtrees of the Codex and Claude Code CLIs it runs in `home`. Unknown paths stay
// sealed — a credential location we do not know about must fail loudly, never drop silently.
const HOME_CACHES: Record<string, readonly string[]> = {
  home: ['.cache', '.npm'],
  'home/.codex': ['sessions', 'log', 'cache', '.tmp', 'history.jsonl'],
  'home/.claude': ['projects', 'todos', 'shell-snapshots', 'statsig', 'file-history', 'history.jsonl'],
};
/** True for the regenerable cache paths the collector never seals; tests assert these are all that stay at rest. */
export function cached(name: string): boolean {
  const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
  return (HOME_CACHES[parent] ?? []).includes(name.slice(name.lastIndexOf('/') + 1));
}
function safePath(path: unknown): path is string {
  return typeof path === 'string' && /^(state|home)(\/[^/]+)*$/.test(path)
    && !path.split('/').some((part) => part === '.' || part === '..' || part.includes('\\') || part.includes('\0'));
}
function snapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if ((s?.v !== 1 && s?.v !== 2) || !Array.isArray(s.dirs) || !Array.isArray(s.files)) throw new Error('invalid sealed credential store');
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

/** Opening failed; the original snapshot stays in place for repair and retry. */
export class AuthStoreUnreadableError extends Error {
  readonly code = 'auth-store-unreadable';
  readonly reason: 'auth-failed' | 'invalid-snapshot';
  constructor(reason: 'auth-failed' | 'invalid-snapshot') {
    super("Saved sign-in could not be opened; auth-store.sealed is unchanged. Restore the original seal/key access or a working backup with its matching key, then retry.");
    this.name = 'AuthStoreUnreadableError';
    this.reason = reason;
  }
}

/** Total raw credential bytes one snapshot may seal. The sealed payload is one runtime string, so a
 *  snapshot beyond this bound cannot be sealed at all: instead of aborting the process deep inside the
 *  sealer (a 364,927,687-character snapshot once hit the runtime string limit and killed Node), collect()
 *  refuses with this error while the store is still intact. Credential state is normally a few MiB; the
 *  cap leaves several times that headroom. */
export const SEAL_CAP_BYTES = 128 * 1024 * 1024;

/** Credential state exceeded `SEAL_CAP_BYTES`; nothing was read beyond the refusing file, nothing was
 *  sealed and nothing was removed — `auth-store.sealed` and the live trees are unchanged. */
export class AuthStoreSealSizeError extends Error {
  readonly code = 'auth-store-seal-size';
  readonly size: number;
  readonly cap: number;
  constructor(size: number, cap: number) {
    super(`Credential state is ${size} bytes and cannot be sealed: the seal cap is ${cap} bytes. ` +
      'Move regenerable data (tool caches are already skipped) out of the engine state and home trees, then retry.');
    this.name = 'AuthStoreSealSizeError';
    this.size = size;
    this.cap = cap;
  }
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
    // Never race a live gateway or another kit, including an orphan after its host crashed.
    const gateway = join(this.o.root, 'gateway.pid');
    if (existsSync(gateway) && live(Number(readFileSync(gateway, 'utf8')))) throw new EngineAlreadyRunningError();
    if (existsSync(this.lock)) {
      if (!lstatSync(this.lock).isDirectory() || lstatSync(this.lock).isSymbolicLink()) throw new Error('invalid credential lock');
      const owner = join(this.lock, 'pid');
      if (!existsSync(owner) || live(Number(readFileSync(owner, 'utf8')))) throw new EngineAlreadyRunningError();
      // Only one stale-owner recovery can proceed. Recheck after claiming it so a stale reader
      // cannot remove the lock a newer owner has just acquired.
      const recovery = join(this.lock, 'recovery');
      try { mkdirSync(recovery, { mode: 0o700 }); } catch { throw new EngineAlreadyRunningError(); }
      if (!existsSync(owner) || live(Number(readFileSync(owner, 'utf8')))) {
        rmSync(recovery, { recursive: true });
        throw new EngineAlreadyRunningError();
      }
      rmSync(this.lock, { recursive: true });
    }
    try { mkdirSync(this.lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EngineAlreadyRunningError();
      throw error;
    }
    this.owned = true;
    try {
      writeFileSync(join(this.lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
      // Recheck under the acquired lock before removing a dead writer's guard.
      if (existsSync(gateway)) {
        if (live(Number(readFileSync(gateway, 'utf8')))) throw new EngineAlreadyRunningError();
        removeMarker(gateway);
      }
    } catch (error) { this.release(); throw error; }
  }
  private release(): void {
    if (!this.owned) return;
    rmSync(this.lock, { recursive: true });
    this.owned = false;
  }
  private async read(): Promise<Snapshot | undefined> {
    if (!existsSync(this.file)) return undefined;
    regular(this.file);
    const seal = this.o.seal!;
    const bytes = readFileSync(this.file);
    let text: string;
    try { text = seal.decryptString(bytes); }
    catch (error) {
      if ((error as { code?: unknown })?.code !== 'auth-failed') throw error;
      throw new AuthStoreUnreadableError('auth-failed');
    }
    let saved: Snapshot;
    try { saved = snapshot(text); } catch { throw new AuthStoreUnreadableError('invalid-snapshot'); }
    const upgraded = seal.upgrade?.(bytes);
    if (upgraded) {
      if (seal.decryptString(Buffer.from(upgraded)) !== text) throw new Error('credential upgrade verification failed');
      put(this.file, upgraded);
    }
    return saved;
  }
  private collect(): Snapshot {
    const s: Snapshot = { v: 1, dirs: [], files: [] };
    let total = 0;
    const root = realpathSync(this.o.root);
    const walk = (path: string) => {
      const name = relative(this.o.root, path).split('\\').join('/');
      if (cached(name)) return; // tool caches are never credential state; skipping a directory skips its subtree
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        chmodSync(path, 0o700);
        s.dirs.push(name);
        for (const child of readdirSync(path).sort()) walk(join(path, child));
        return;
      }
      let file = path;
      let target = stat;
      if (stat.isSymbolicLink()) {
        try { file = realpathSync(path); } catch (error) {
          if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
          throw error;
        }
        const rel = relative(root, file);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return;
        target = lstatSync(file);
      }
      if (!target.isFile()) return;
      // Read the checked target, but save the link's path: restore materializes a regular file there.
      chmodSync(file, 0o600);
      // Refuse by size before reading: an over-cap file must never reach memory or the sealer.
      total += target.size;
      if (total > SEAL_CAP_BYTES) throw new AuthStoreSealSizeError(total, SEAL_CAP_BYTES);
      s.files.push([name, readFileSync(file).toString('base64')]);
    };
    for (const dir of ['state', 'home']) if (existsSync(join(this.o.root, dir))) walk(join(this.o.root, dir));
    return s;
  }
  /** Remove the live credential trees: `state` entirely (it is all credential state, including the
   *  runtime entries the collector skips), and in `home` exactly the sealed paths — regenerable caches
   *  and the directories still holding them are left in place. */
  private remove(s: Snapshot): void {
    rmSync(join(this.o.root, 'state'), { recursive: true, force: true });
    for (const [path] of s.files) if (path.startsWith('home/')) rmSync(join(this.o.root, path), { force: true });
    for (const path of [...s.dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (!path.startsWith('home/')) continue;
      try { rmdirSync(join(this.o.root, path)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error; // a directory still holding caches stays
      }
    }
  }
  private async persist(): Promise<void> {
    if (!this.o.seal) return;
    // Always authenticate an earlier snapshot before considering a leftover live store after a crash.
    const previous = await this.read();
    if (previous && (existsSync(this.cleanup) || existsSync(this.restoring))) {
      this.remove(previous);
      removeMarker(this.cleanup);
      removeMarker(this.restoring);
      this.o.log?.('interrupted credential transition recovered');
    }
    const saved = this.collect();
    // Live trees with nothing sealable are debris (crash leftovers, or only the caches a previous stop
    // left in place) — keep the sealed credentials instead of replacing them with an empty snapshot.
    // A running engine always leaves files behind (its SQLite stores), so a genuine sign-out still re-seals.
    if (!saved.files.length && previous) return;
    // The payload is built exactly once; verification decrypts the sealed bytes and compares to it.
    const payload = JSON.stringify(saved);
    const sealed = this.o.seal.encryptString(payload);
    if (this.o.seal.decryptString(Buffer.from(sealed)) !== payload) throw new Error('credential seal verification failed');
    put(this.file, sealed);
    if (this.o.seal.decryptString(readFileSync(this.file)) !== payload) throw new Error('credential seal verification failed');
    if (previous?.dirs.some(cached)) this.o.log?.('sealed credential store re-sealed: tool caches no longer sealed');
    put(this.cleanup, encoder.encode('1'));
    this.remove(saved);
    removeMarker(this.cleanup);
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
    removeMarker(this.restoring);
  }
  async archives(): Promise<void> {
    const ignored = new Set([resolve(this.o.engineDir), resolve(`${this.o.engineDir}.sets`), ...['npm-cache', 'install-home', 'tmp', 'plugin', 'workspaces'].map((d) => resolve(this.o.root, d))]);
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
      if (!this.owned) return;
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
  syncDir(dirname(path));
  log?.(seal ? 'credential archive sealed' : 'verified credential archive removed');
}
