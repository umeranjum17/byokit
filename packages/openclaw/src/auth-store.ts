// The pin persists OAuth JSON in both shared and agent SQLite. There is no public persistence hook.
// Credential state under `home` and `state` is sealed as one bounded blob (`auth-store.sealed`, capped at
// SEAL_CAP_BYTES, refusing with a typed error). Every other file under `state` — the SQLite databases, which mix
// credentials with transcript rows, and the regenerable caches, transcripts, media, logs and session stores beside
// them — is sealed as its own file under `auth-store.objects/`. Each such file is capped individually at
// SEAL_CAP_BYTES; the total across objects is not, so growth in aggregate never refuses.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SealingAdapter } from '@byokit/secrets';
import { EngineAlreadyRunningError, pidAlive as live } from './engine-status.ts';

const encoder = new TextEncoder();
const archive = (name: string) => !name.endsWith('.sealed') && (/^(auth-profiles|auth-state|auth|oauth)\.json\.(migrated-.+|sqlite-import\..+\.bak)$/.test(name)
  || name.endsWith('.moved-to-engine'));
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
// Restore-only variant of put(): the same temp write, file fsync and atomic rename, but it records the
// containing directory in `changed` instead of fsyncing it now. restore() fsyncs each distinct directory
// once after every file is written, so a restore still makes each rename durable before it removes the
// restoring marker, without one directory fsync per object. seal() and the stop path keep put().
function putRestore(path: string, bytes: Uint8Array, changed: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.sealing-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    changed.add(dirname(path));
  } finally { rmSync(tmp, { force: true }); }
}
// Always written as `v: 1`: released readers through 0.6.1 reject any other tag, so 0.6.2's `v: 2` locked a host
// rolled back to an earlier kit out of its sign-in. `v: 2` stays readable and re-seals as `v: 1`. The engine
// databases are objects, not blob entries, so a host rolled back to an earlier kit keeps the blob's credentials
// but not its databases, and signs in again.
type Snapshot = { v: 1 | 2; dirs: string[]; files: [string, string][] };
type Entry = { name: string; file: string; size: number };
// Credential state is what restores a working signed-in session. Regenerable tool caches, transcripts
// and logs never do. In `home`: the XDG cache and npm cache homes the kit's engine environment pins, plus
// the transcript/log/cache subtrees of the Codex and Claude Code CLIs it runs; those stay on disk unsealed.
// In the isolated engine `state` tree the pinned engine (2026.8.1, `resolveStateDatabasePath`/`resolveOpenClawAgentSqlitePath`/
// `resolveOAuthDir`) keeps credentials in the shared and per-agent SQLite databases and `credentials/`, and
// writes non-credential data beside them: the caches (`cache/` control-UI assets, shell snapshots and
// worker bundles, `completions/`), exported transcript artifacts (`transcripts/`), legacy session stores
// (`sessions/`, `agents/<agentId>/sessions/`), the media stores (`media/`, `delivery-queue-media/`),
// logs (`logs/`) and gateway temp/lock files (`tmp/`). Unknown paths stay
// sealed — a credential location we do not know about must fail loudly, never drop silently.
const HOME_CACHES: Record<string, readonly string[]> = {
  home: ['.cache', '.npm'],
  'home/.codex': ['sessions', 'log', 'cache', '.tmp', 'history.jsonl'],
  'home/.claude': ['projects', 'todos', 'shell-snapshots', 'statsig', 'file-history', 'history.jsonl'],
};
// Positively non-credential subtrees directly under the isolated engine `state` tree. They are sealed as
// separate objects, never in the credential blob.
const STATE_NON_CREDENTIAL = new Set(['cache', 'completions', 'transcripts', 'sessions', 'media', 'delivery-queue-media', 'logs', 'tmp']);
// Legacy per-agent session migration sources and archives.
const AGENT_SESSIONS = /^state\/agents\/[^/]+\/sessions(\/|$)/;
// The engine's SQLite databases and their journal/WAL sidecars.
const DATABASE = /\.sqlite(-wal|-shm|-journal)?$/;
/** True for the non-credential paths: under `home` they are never sealed; under `state` they are sealed as objects. */
export function nonCredential(name: string): boolean {
  if (AGENT_SESSIONS.test(name)) return true;
  const slash = name.lastIndexOf('/');
  const parent = slash === -1 ? '' : name.slice(0, slash);
  if (parent === 'state') return STATE_NON_CREDENTIAL.has(name.slice(slash + 1));
  return (HOME_CACHES[parent] ?? []).includes(name.slice(slash + 1));
}
// A file under `state` that is sealed as its own object: the SQLite databases and anything in a non-credential subtree.
function apart(name: string): boolean {
  if (!name.startsWith('state/')) return false;
  if (DATABASE.test(name)) return true;
  const parts = name.split('/');
  return parts.some((_, i) => nonCredential(parts.slice(0, i + 1).join('/')));
}
const objectName = (name: string) => `${createHash('sha256').update(name).digest('hex')}.sealed`;
const objectHash = (payload: string) => createHash('sha256').update(payload).digest('hex');
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

/** Total raw credential bytes one snapshot may seal. The sealed payload is one runtime string, so collect()
 *  refuses a larger snapshot before reading it and the process never aborts inside the sealer. Credential
 *  state is normally a few MiB; the cap leaves several times that headroom. The same bound applies to each
 *  non-credential engine store under `state` sealed as its own object; their total is not bounded. */
export const SEAL_CAP_BYTES = 128 * 1024 * 1024;

/** The saved sign-in data (or one object file, when `file` names it) is over `SEAL_CAP_BYTES`. On a refusal the
 *  last good saved store is kept as it was and no live file is deleted. `size` is a lower bound for the whole
 *  store (the running total when the cap was crossed) and the exact size when `file` is set. */
export class AuthStoreSealSizeError extends Error {
  readonly code = 'auth-store-seal-size';
  readonly size: number;
  readonly cap: number;
  readonly file?: string;
  constructor(size: number, cap: number, file?: string) {
    const MiB = 1024 * 1024;
    super(`${file ? `Engine data ${file}` : 'Your saved sign-in data'} is too large to keep safely (more than ${Math.floor(size / MiB)} MB; the limit is ${cap / MiB} MB). ` +
      'Your sign-ins were kept.');
    this.name = 'AuthStoreSealSizeError';
    this.size = size;
    this.cap = cap;
    this.file = file;
  }
}

export class AuthStore {
  private active = false;
  private owned = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly objects: string;
  private readonly lock: string;
  private readonly cleanup: string;
  private readonly restoring: string;
  // Object file name -> sha256 of the plaintext payload currently sealed at that file. Kept only in memory: it
  // never becomes on-disk metadata. Filled by restore() from what is decrypted, refreshed after each successful
  // seal. A process that never restored starts with an empty map and reseals every object, as before.
  private readonly objectHashes = new Map<string, string>();
  constructor(privateOptions: { root: string; stateDir: string; engineDir: string; seal?: SealingAdapter; log?: (line: string) => void }) {
    this.o = privateOptions;
    this.file = join(this.o.root, 'auth-store.sealed');
    this.objects = join(this.o.root, 'auth-store.objects');
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
  private open(bytes: Buffer): string {
    try { return this.o.seal!.decryptString(bytes); }
    catch (error) {
      if ((error as { code?: unknown })?.code !== 'auth-failed') throw error;
      throw new AuthStoreUnreadableError('auth-failed');
    }
  }
  private seal(path: string, payload: string): void {
    const seal = this.o.seal!;
    const sealed = seal.encryptString(payload);
    if (seal.decryptString(Buffer.from(sealed)) !== payload) throw new Error('credential seal verification failed');
    put(path, sealed);
    if (seal.decryptString(readFileSync(path)) !== payload) throw new Error('credential seal verification failed');
  }
  private async read(): Promise<Snapshot | undefined> {
    if (!existsSync(this.file)) return undefined;
    regular(this.file);
    const seal = this.o.seal!;
    const bytes = readFileSync(this.file);
    const text = this.open(bytes);
    let saved: Snapshot;
    try { saved = snapshot(text); } catch { throw new AuthStoreUnreadableError('invalid-snapshot'); }
    const upgraded = seal.upgrade?.(bytes);
    if (upgraded) {
      if (seal.decryptString(Buffer.from(upgraded)) !== text) throw new Error('credential upgrade verification failed');
      put(this.file, upgraded);
    }
    return saved;
  }
  private readObject(file: string): [string, string, string] {
    let text = '';
    let entry: { path?: unknown; data?: unknown } | null = null;
    try {
      text = this.open(readFileSync(file));
      entry = JSON.parse(text);
    } catch (error) {
      if (error instanceof AuthStoreUnreadableError) throw error;
      throw new AuthStoreUnreadableError('invalid-snapshot');
    }
    const path = entry?.path;
    const data = entry?.data;
    if (!safePath(path) || !apart(path) || typeof data !== 'string' || Buffer.from(data, 'base64').toString('base64') !== data) {
      throw new AuthStoreUnreadableError('invalid-snapshot');
    }
    return [path, data, text];
  }
  private inventory(): { dirs: string[]; files: Entry[]; objects: Entry[] } {
    const dirs: string[] = [];
    const files: Entry[] = [];
    const objects: Entry[] = [];
    let total = 0;
    const root = realpathSync(this.o.root);
    const walk = (path: string) => {
      const name = relative(this.o.root, path).split('\\').join('/');
      if (name.startsWith('home/') && nonCredential(name)) return; // regenerable home caches stay on disk; skipping a directory skips its subtree
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (!apart(name)) dirs.push(name);
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
      if (apart(name)) {
        if (target.size > SEAL_CAP_BYTES) throw new AuthStoreSealSizeError(target.size, SEAL_CAP_BYTES, name);
        objects.push({ name, file, size: target.size });
        return;
      }
      // Refuse by size before any file is touched or read: an over-cap file must never reach memory or the sealer.
      total += target.size;
      if (total > SEAL_CAP_BYTES) throw new AuthStoreSealSizeError(total, SEAL_CAP_BYTES);
      files.push({ name, file, size: target.size });
    };
    for (const dir of ['state', 'home']) if (existsSync(join(this.o.root, dir))) walk(join(this.o.root, dir));
    return { dirs, files, objects };
  }
  private collect(): { saved: Snapshot; objects: Entry[] } {
    const { dirs, files, objects } = this.inventory();
    for (const dir of dirs) chmodSync(join(this.o.root, dir), 0o700);
    // Read the checked target, but save the link's path: restore materializes a regular file there.
    for (const { file } of [...files, ...objects]) chmodSync(file, 0o600);
    return {
      saved: { v: 1, dirs, files: files.map(({ name, file }): [string, string] => [name, readFileSync(file).toString('base64')]) },
      objects,
    };
  }
  /** Remove the live sealed trees: all of `state` (every file there is sealed, as a blob entry or an object),
   *  and in `home` exactly the sealed paths — regenerable caches and the directories still holding them are left in place. */
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
  private sealObjects(objects: Entry[]): void {
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    const keep = new Set<string>();
    for (const { name, file } of objects) {
      const object = objectName(name);
      keep.add(object);
      const target = join(this.objects, object);
      const payload = JSON.stringify({ path: name, data: readFileSync(file).toString('base64') });
      // An object this process already sealed (or restored) unchanged is not resealed: its plaintext hash is
      // the same and its sealed file is still on disk, so the encrypt + verify + fsyncs are skipped. A changed
      // file, a new one, or one whose sealed file vanished falls through to the normal seal.
      const hash = objectHash(payload);
      if (this.objectHashes.get(object) === hash && existsSync(target)) continue;
      this.objectHashes.delete(object);
      this.seal(target, payload);
      this.objectHashes.set(object, hash);
    }
    for (const entry of readdirSync(this.objects)) if (!keep.has(entry)) rmSync(join(this.objects, entry), { force: true });
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
    const { saved, objects } = this.collect();
    // Live trees with nothing sealable are debris (crash leftovers, or only the caches a previous stop
    // left in place) — keep the sealed credentials instead of replacing them with an empty snapshot.
    // A running engine always leaves files behind (its SQLite stores), so a genuine sign-out still re-seals.
    if (!saved.files.length && !objects.length && previous) return;
    // The payload is built exactly once; verification decrypts the sealed bytes and compares to it.
    this.seal(this.file, JSON.stringify(saved));
    if (previous?.dirs.some(nonCredential)) this.o.log?.('sealed credential store re-sealed: tool caches no longer sealed');
    this.sealObjects(objects);
    put(this.cleanup, encoder.encode('1'));
    this.remove(saved);
    removeMarker(this.cleanup);
  }

  /** `mkdir -p` for a restore target that records the parent of every directory it creates: a new directory
   *  changes its parent's entries, so the parent needs a directory fsync too. Stops at the store root (it exists)
   *  and never fsyncs now; restore() fsyncs the collected directories once after all files are written. */
  private ensureRestoreDirs(dir: string, changed: Set<string>): void {
    const created: string[] = [];
    for (let d = dir; d !== this.o.root && d !== dirname(d) && !existsSync(d); d = dirname(d)) created.push(d);
    for (const d of created.reverse()) { mkdirSync(d, { mode: 0o700 }); changed.add(dirname(d)); }
  }
  private async restore(): Promise<void> {
    if (!this.o.seal) return;
    const saved = await this.read();
    // A crashed host may leave a newer live state; prepare seals that before restore.
    put(this.restoring, encoder.encode('1'));
    const changed = new Set<string>();
    if (saved) {
      for (const dir of saved.dirs.sort((a, b) => a.split('/').length - b.split('/').length))
        this.ensureRestoreDirs(join(this.o.root, dir), changed);
      for (const [path, data] of saved.files) putRestore(join(this.o.root, path), Buffer.from(data, 'base64'), changed);
    }
    if (existsSync(this.objects)) {
      for (const entry of readdirSync(this.objects)) {
        const [path, data, payload] = this.readObject(join(this.objects, entry));
        this.objectHashes.set(entry, objectHash(payload));
        // An object path can be several directories below an existing one, and those directories are not in
        // `saved.dirs` (they sit in a non-credential subtree). Create them through ensureRestoreDirs so the
        // parent of every directory this restore creates — not just each object's own directory — is fsynced
        // before the marker goes; otherwise a crash after marker removal could lose a directory entry and the
        // next prepare() would seal the now-incomplete live tree over the good sealed objects.
        const target = join(this.o.root, path);
        this.ensureRestoreDirs(dirname(target), changed);
        putRestore(target, Buffer.from(data, 'base64'), changed);
      }
    }
    for (const dir of ['state', 'home']) this.ensureRestoreDirs(join(this.o.root, dir), changed);
    // Each restored file's content is durable already (putRestore fsyncs it); every rename and every new
    // directory entry is made durable here, once per distinct directory, before the marker is removed.
    for (const dir of changed) syncDir(dir);
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
      try {
        await this.archives();
        await this.persist();
      } catch (error) {
        if (error instanceof AuthStoreSealSizeError) { this.active = false; this.release(); }
        throw error;
      }
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
