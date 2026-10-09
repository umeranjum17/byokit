// Internal artifact seam. Published patch semantics live only in engine/patches.json.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, cp, open, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
export type PatchFile = { path: string; before: string; after: string; edits: { find: string; replace: string }[] };
export type PatchSet = { v: 1; id: string; upstream: { name: string; version: string; integrity: string; commit: string; license: string }; files: PatchFile[] };
export class EnginePatchError extends Error {
  readonly code = 'engine-patch';
  readonly cause: 'spec' | 'drift' | 'drift-after-build' | 'write';
  readonly file?: string;
  constructor(cause: EnginePatchError['cause'], file?: string) {
    super(`engine-patch: ${cause}${file ? ` (${file})` : ''}`);
    this.name = 'EnginePatchError'; this.cause = cause; this.file = file;
  }
}
export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const patchId = (files: PatchFile[]): string => sha256(JSON.stringify(canonical(files))).slice(0, 16);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
function validateFiles(id: unknown, files: unknown): asserts files is PatchFile[] {
  if (typeof id !== 'string' || !Array.isArray(files)) throw new EnginePatchError('spec');
  const paths = new Set<string>();
  for (const f of files) {
    if (!object(f) || !keys(f, ['path', 'before', 'after', 'edits']) || typeof f.path !== 'string' ||
      !/^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.m?js$/.test(f.path) || f.path.split('/').some(p => p === '.' || p === '..') || paths.has(f.path) ||
      typeof f.before !== 'string' || !/^[a-f0-9]{64}$/.test(f.before) || typeof f.after !== 'string' || !/^[a-f0-9]{64}$/.test(f.after) || f.before === f.after ||
      !Array.isArray(f.edits) || !f.edits.length) throw new EnginePatchError('spec');
    paths.add(f.path);
    for (const e of f.edits) if (!object(e) || !keys(e, ['find', 'replace']) || typeof e.find !== 'string' || !e.find || typeof e.replace !== 'string' || !e.replace || e.find === e.replace) throw new EnginePatchError('spec');
  }
  if (id !== patchId(files)) throw new EnginePatchError('spec');
}
export function readPatchSet(path: string, version: string, integrity: string): PatchSet {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(value) || !keys(value, ['v', 'id', 'upstream', 'files']) || value.v !== 1 || !object(value.upstream) ||
      !keys(value.upstream, ['name', 'version', 'integrity', 'commit', 'license']) || value.upstream.name !== 'openclaw' || value.upstream.version !== version ||
      value.upstream.integrity !== integrity || value.upstream.license !== 'MIT' || typeof value.upstream.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.upstream.commit)) throw new Error();
    validateFiles(value.id, value.files);
    return value as PatchSet;
  } catch { throw new EnginePatchError('spec', path); }
}
export function editText(text: string, file: PatchFile): string {
  for (const edit of file.edits) {
    const at = text.indexOf(edit.find);
    if (at < 0 || text.indexOf(edit.find, at + 1) >= 0) throw new EnginePatchError('spec', file.path);
    text = text.slice(0, at) + edit.replace + text.slice(at + edit.find.length);
  }
  return text;
}
export function atomic(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path); syncDir(dirname(path));
  } catch { throw new EnginePatchError('write', path); }
  finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}
const syncDir = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
export function processStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!startTime || !/^\d+$/.test(startTime)) throw new EnginePatchError('write');
  return startTime;
}
const noLink = (path: string) => { if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new EnginePatchError('spec', path); };
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
type TreeEntry = { path: string; kind: 'file' | 'dir' | 'link'; mode: number; size: number; hash: string };
function tree(dir: string): TreeEntry[] {
  const result: TreeEntry[] = [];
  const root = realpathSync(dir);
  const walk = (path: string, rel: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (resolve(link) === link || !inside(root, realpathSync(path))) throw new EnginePatchError('spec', rel);
      result.push({ path: rel, kind: 'link', mode: info.mode & 0o777, size: info.size, hash: sha256(link) });
      return;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!rel && ['.byokit-tree', '.byokit-patches'].includes(name)) continue;
        walk(join(path, name), rel ? `${rel}/${name}` : name);
      }
      result.push({ path: rel, kind: 'dir', mode: info.mode & 0o777, size: 0, hash: '' });
      return;
    }
    if (!info.isFile()) throw new EnginePatchError('spec', rel);
    const hash = sha256(readFileSync(path));
    result.push({ path: rel, kind: 'file', mode: info.mode & 0o777, size: info.size, hash });
  };
  walk(dir, '');
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function metadata(dir: string, set: PatchSet): void {
  const root = join(dir, 'node_modules/openclaw');
  const build = JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8')) as { version?: string; commit?: string };
  if (build.version !== set.upstream.version || build.commit !== set.upstream.commit || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version !== set.upstream.version) throw new EnginePatchError('drift', 'dist/build-info.json');
  for (const file of set.files) {
    const path = join(root, file.path);
    if (!inside(realpathSync(root), realpathSync(path)) || lstatSync(path).isSymbolicLink() || sha256(readFileSync(path)) !== file.after) throw new EnginePatchError('drift', file.path);
  }
}
// Full verification on EVERY prepare/adoption, not just listed patched files or the directory mode.
export function verifyEngineSet(dir: string, set: PatchSet, installMatches: (dir: string) => boolean): void {
  noLink(dir);
  try {
    for (const name of ['.byokit-tree', '.byokit-patches']) {
      const info = lstatSync(join(dir, name));
      if (!info.isFile() || (info.mode & 0o777) !== 0o444) throw new Error();
    }
    const bytes = readFileSync(join(dir, '.byokit-tree'), 'utf8');
    const marker: unknown = JSON.parse(readFileSync(join(dir, '.byokit-patches'), 'utf8'));
    if (!object(marker) || !keys(marker, ['id', 'files', 'tree']) || marker.id !== set.id || JSON.stringify(marker.files) !== JSON.stringify(set.files) || marker.tree !== sha256(bytes)) throw new Error();
    metadata(dir, set);
    if (!installMatches(dir) || bytes !== JSON.stringify(tree(dir))) throw new Error();
  } catch (error) { if (error instanceof EnginePatchError && error.cause === 'spec') throw error; throw new EnginePatchError('drift', dir); }
}
// chmod/remove only this invocation's unlaunched private temp, never a final set or the base install.
async function removeTemp(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const walk = async (path: string) => {
    if (!lstatSync(path).isDirectory()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await walk(join(path, name));
  };
  await walk(dir); await rm(dir, { recursive: true, force: true });
}
const flushFs = (dir: string): Promise<void> => new Promise(resolve => {
  // One filesystem-wide syncfs through coreutils `sync -f`: per-file fsync transactions cost ~110 s per set on
  // the reference btrfs host (37,999 fsyncs), one syncfs ~2 s. A performance flush only, so where `sync -f` cannot run
  // (no sync binary, a sync that rejects -f, or a non-Linux host) the flush is skipped, durability rests on next-launch
  // whole-tree verification, and it is never an error.
  if (process.platform !== 'linux') return resolve();
  const child = spawn('sync', ['-f', dir], { stdio: 'ignore' });
  child.once('error', () => resolve());
  child.once('exit', () => resolve());
});
// Freeze makes the tree read-only and returns its entries as the manifest; durability rule: docs/runtime-kits.md 5.16.
async function freeze(dir: string): Promise<TreeEntry[]> {
  // Bound I/O while yielding the host event loop: chmod only, in batches. Links are left untouched (and keep
  // their recorded mode); every file becomes 0444 and every directory 0555, exactly what the manifest records.
  const entries = tree(dir).map(entry => entry.kind === 'link' ? entry : { ...entry, mode: entry.kind === 'dir' ? 0o555 : 0o444 });
  const paths = [...entries.filter(e => e.kind === 'file'), ...entries.filter(e => e.kind === 'dir').reverse()];
  for (let i = 0; i < paths.length; i += 16) await Promise.all(paths.slice(i, i + 16).map(async entry => {
    await chmod(join(dir, entry.path), entry.mode);
  }));
  await flushFs(dir);
  return entries;
}
export function engineSetName(set: PatchSet): string { return `${sha256(set.upstream.integrity).slice(0, 16)}-${set.id}`; }
export async function prepareEngineSet(engineDir: string, set: PatchSet, install: (dir: string) => void | Promise<void>, installMatches: (dir: string) => boolean): Promise<string> {
  validateFiles(set.id, set.files);
  const sets = `${engineDir}.sets`;
  noLink(sets); mkdirSync(sets, { recursive: true, mode: 0o700 });
  const name = engineSetName(set);
  for (const candidate of readdirSync(sets).filter(n => n === name || n.startsWith(`${name}.`)).sort()) {
    const dir = join(sets, candidate);
    try { verifyEngineSet(dir, set, installMatches); return dir; }
    catch (error) { if (!(error instanceof EnginePatchError) || error.cause !== 'drift') throw error; }
  }
  const stock: PatchSet = { ...set, id: patchId([]), files: [] };
  const stockDir = set.files.length ? await prepareEngineSet(engineDir, stock, install, installMatches) : undefined;
  const tmp = join(sets, `.tmp-${process.pid}-${process.platform === 'linux' ? processStartTime(process.pid) : 'unknown'}-${randomUUID()}`);
  const final = join(sets, existsSync(join(sets, name)) ? `${name}.${randomUUID()}` : name);
  try {
    if (stockDir) {
      // ponytail: reflink or plain copy, never hardlinks; no GC without per-launch leases (~889 MB/set).
      await cp(stockDir, tmp, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      // The copy is private and unlaunched. Make only it writable, and drop inherited provenance.
      const writable = async (path: string) => {
        const info = lstatSync(path);
        if (info.isSymbolicLink()) return;
        await chmod(path, info.isDirectory() ? 0o700 : 0o600);
        if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
      };
      await writable(tmp);
      rmSync(join(tmp, '.byokit-tree')); rmSync(join(tmp, '.byokit-patches'));
    } else { mkdirSync(tmp, { mode: 0o700 }); await install(tmp); }
    if (!installMatches(tmp)) throw new EnginePatchError('drift-after-build', tmp);
    const root = join(tmp, 'node_modules/openclaw');
    for (const file of set.files) {
      const path = join(root, file.path);
      if (!inside(realpathSync(root), realpathSync(path)) || lstatSync(path).isSymbolicLink()) throw new EnginePatchError('spec', file.path);
      const before = readFileSync(path, 'utf8');
      if (sha256(before) !== file.before) throw new EnginePatchError('drift-after-build', file.path);
      const after = editText(before, file);
      if (sha256(after) !== file.after) throw new EnginePatchError('spec', file.path);
      atomic(path, after);
    }
    metadata(tmp, set);
    const entries = await freeze(tmp);
    const bytes = JSON.stringify(entries);
    // Root alone is writable while publishing metadata, then made read-only too.
    await chmod(tmp, 0o700);
    atomic(join(tmp, '.byokit-tree'), bytes);
    atomic(join(tmp, '.byokit-patches'), JSON.stringify({ id: set.id, files: set.files, tree: sha256(bytes) }));
    for (const file of ['.byokit-tree', '.byokit-patches']) {
      const path = join(tmp, file); await chmod(path, 0o444);
      const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    }
    await chmod(tmp, 0o555);
    const directory = await open(tmp, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    try { verifyEngineSet(tmp, set, installMatches); }
    catch (error) { if (error instanceof EnginePatchError && error.cause === 'drift') throw new EnginePatchError('drift-after-build', error.file); throw error; }
    try { renameSync(tmp, final); syncDir(sets); }
    catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      try { verifyEngineSet(final, set, installMatches); }
      catch { throw new EnginePatchError('drift-after-build', final); }
    }
    return final;
  } catch (error) {
    if (error instanceof EnginePatchError) { if (error.cause === 'drift') throw new EnginePatchError('drift-after-build', error.file); throw error; }
    throw new EnginePatchError('write', tmp);
  }
  finally { await removeTemp(tmp); }
}
