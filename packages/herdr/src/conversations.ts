// Host-owned archive engine. Only documented conversation stores are eligible, never HOME.
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, writeSync, lstatSync, realpathSync,
  readdirSync, opendirSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, rmdirSync, linkSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { ConversationExport, ConversationImport, ConversationFailure, ConversationImportOptions } from './types.ts';
import { words } from './words.ts';
const CEILING = 1024 ** 3, HEADER_LIMIT = 16 * 1024 ** 2;
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
// Pi SessionManager.getDefaultSessionDirPath/newSession, pi-mono d5b3de22d0e24a3e9c38a9410d3329b099717283.
// https://github.com/badlogic/pi-mono/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/session-manager.ts
const stores: Record<string, { variable: string; directory: string; accepts(path: string, conversation: string): boolean }> = {
  pi: { variable: 'PI_CODING_AGENT_DIR', directory: 'sessions', accepts: (p, id) => new RegExp(`^sessions/--[^/\\\\\x00-\x1f]+--/[0-9TZ.-]+_${uuid}\\.jsonl$`).test(p) && p.endsWith(`_${id}.jsonl`) },
};
stores.claude = { variable: 'CLAUDE_CONFIG_DIR', directory: 'projects',
  accepts: (p, id) => new RegExp(`^projects/[^/]+/${uuid}\\.jsonl$`).test(p) && p.endsWith(`/${id}.jsonl`) };
type Entry = { path: string; size: number; sha256: string };
type Manifest = { version: 1; kind: string; conversation: string; files: Entry[]; bytes: number };
export const fail = (code: ConversationFailure['code']): ConversationFailure => ({ ok: false, code, message: words(`conversation.${code}`) });
function refuse(code: ConversationFailure['code']): never { throw fail(code); }
const result = (e: unknown): ConversationFailure => e && typeof e === 'object' && 'ok' in e && e.ok === false
  ? e as ConversationFailure : fail('write-failed');
function regular(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) refuse('unsafe-path'); return fd; }
  catch (e) { closeSync(fd); throw e; }
}
function safe(root: string, rel = ''): string {
  if (!isAbsolute(root) || realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) refuse('unsafe-path');
  if (rel && (rel.includes('\\') || rel.split('/').some((p) => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f]/.test(rel))) refuse('unsafe-path');
  let path = resolve(root);
  for (const part of rel.split('/').filter(Boolean)) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) refuse('unsafe-path'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return path;
}
function conversationFiles(root: string, kind: string, id: string): string[] {
  const found: string[] = []; let seen = 0;
  function walk(rel: string, depth: number): void {
    if (depth > 8) refuse('too-large');
    const path = safe(root, rel);
    try {
      const dir = opendirSync(path);
      try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++seen > 20000) refuse('too-large');
        const child = `${rel}/${entry.name}`; safe(root, child);
        if (entry.isDirectory()) walk(child, depth + 1);
        else if (stores[kind]!.accepts(child, id)) { const fd = regular(safe(root, child)); closeSync(fd); found.push(child); }
      } } finally { dir.closeSync(); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  walk(stores[kind]!.directory, 0); return found;
}
// Constant-memory copying and hashing; positional reads keep all passes independent.
function copy(fd: number, offset: number, size: number, out?: number): string {
  const h = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  for (let done = 0; done < size;) {
    const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - done), offset + done);
    if (!n) refuse('invalid-bundle');
    const chunk = buffer.subarray(0, n); h.update(chunk);
    if (out !== undefined) for (let written = 0; written < n;) written += writeSync(out, chunk, written, n - written);
    done += n;
  }
  return h.digest('hex');
}
function checkedManifest(fd: number): { m: Manifest; offset: number; digest: string } {
  const size = fstatSync(fd).size, prefix = Buffer.alloc(12);
  if (size > CEILING) refuse('too-large');
  if (readSync(fd, prefix, 0, 12, 0) !== 12 || prefix.toString('ascii', 0, 8) !== 'BYKCONV1') refuse('invalid-bundle');
  const length = prefix.readUInt32BE(8);
  if (!length || length > HEADER_LIMIT || length + 12 > size) refuse('invalid-bundle');
  const raw = Buffer.alloc(length);
  if (readSync(fd, raw, 0, length, 12) !== length) refuse('invalid-bundle');
  let m: Manifest;
  try { m = JSON.parse(raw.toString('utf8')) as Manifest; } catch { return refuse('invalid-bundle'); }
  if (!m || m.version !== 1 || typeof m.kind !== 'string' || typeof m.conversation !== 'string'
    || !new RegExp(`^${uuid}$`).test(m.conversation) || !Array.isArray(m.files) || !m.files.length
    || m.files.length > 20000 || !Number.isSafeInteger(m.bytes) || m.bytes < 0) refuse('invalid-bundle');
  const store = Object.hasOwn(stores, m.kind) ? stores[m.kind] : undefined;
  if (!store) refuse('unsupported');
  const names = new Set<string>(); let offset = length + 12, total = 0;
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !store.accepts(f.path, m.conversation) || names.has(f.path)
      || Object.keys(f).some((key) => !['path', 'size', 'sha256'].includes(key))) refuse('unsafe-path');
    names.add(f.path);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) refuse('invalid-bundle');
    total += f.size;
    if (offset + total > size) refuse('invalid-bundle');
    if (copy(fd, offset + total - f.size, f.size) !== f.sha256) refuse('digest-mismatch');
  }
  // Pi persists a conversation in exactly one JSONL file, not an account-wide directory.
  if (m.kind === 'pi' && m.files.length !== 1 || total !== m.bytes || offset + total !== size) refuse('invalid-bundle');
  return { m, offset, digest: copy(fd, 0, size) };
}
export function conversationFolder(kind: string, env: Record<string, string>): string | undefined {
  const folder = env[stores[kind]?.variable ?? ''];
  return folder && isAbsolute(folder) ? folder : undefined;
}
export async function exportStore(kind: string, folder: string, conversation: string,
  o: { to: string; maxBytes?: number; maxFiles?: number }): Promise<ConversationExport> {
  let fd: number | undefined, temp: string | undefined;
  try {
    const store = Object.hasOwn(stores, kind) ? stores[kind] : undefined; if (!store) return fail('unsupported');
    const maxBytes = o.maxBytes ?? 256 * 1024 ** 2, maxFiles = o.maxFiles ?? 20000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > CEILING || !Number.isSafeInteger(maxFiles) || maxFiles <= 0 || maxFiles > 20000) return fail('too-large');
    const byId = new RegExp(`^${uuid}$`).test(conversation), candidates = byId ? conversationFiles(folder, kind, conversation) : [];
    const rel = byId && candidates.length === 1 ? candidates[0]! : relative(folder, conversation).split('\\').join('/');
    const id = kind === 'claude' ? new RegExp(`(${uuid})\\.jsonl$`).exec(rel)?.[1] : new RegExp(`_(${uuid})\\.jsonl$`).exec(rel)?.[1];
    if (!id || !store.accepts(rel, id)) return fail('unsupported');
    if (resolve(o.to) === resolve(folder, rel)) return fail('unsafe-path');
    fd = regular(safe(folder, rel)); const size = fstatSync(fd).size;
    if (size > maxBytes) return fail('too-large');
    const first = Buffer.alloc(Math.min(size, 64 * 1024)); readSync(fd, first, 0, first.length, 0);
    try {
      const header = JSON.parse(first.subarray(0, first.indexOf(10)).toString('utf8')) as { type?: string; id?: string; sessionId?: string };
      if (kind === 'claude' ? header.sessionId !== id : header.type !== 'session' || header.id !== id) return fail('unsupported');
    } catch { return fail('unsupported'); }
    const m: Manifest = { version: 1, kind, conversation: id, files: [{ path: rel, size, sha256: copy(fd, 0, size) }], bytes: size };
    const header = Buffer.from(JSON.stringify(m)), prefix = Buffer.alloc(12);
    prefix.write('BYKCONV1'); prefix.writeUInt32BE(header.length, 8);
    if (12 + header.length + size > maxBytes) return fail('too-large');
    const dir = safe(dirname(resolve(o.to)));
    temp = join(dir, `.conversation-${randomUUID()}`);
    const out = openSync(temp, 'wx', 0o600);
    try { writeSync(out, prefix); writeSync(out, header); if (copy(fd, 0, size, out) !== m.files[0]!.sha256 || fstatSync(fd).size !== size) refuse('digest-mismatch'); }
    finally { closeSync(out); }
    const check = regular(temp); let digest: string;
    try { digest = checkedManifest(check).digest; } finally { closeSync(check); }
    renameSync(temp, resolve(o.to)); temp = undefined;
    return { ok: true, kind, conversation: id, files: 1, bytes: size, digest };
  } catch (e) { return result(e); }
  finally {
    try {
      if (fd !== undefined) closeSync(fd);
      if (temp) unlinkSync(temp);
    } catch { return fail('write-failed'); }
  }
}
export async function importConversation(o: ConversationImportOptions): Promise<ConversationImport> {
  let fd: number | undefined, stage: string | undefined;
  const created: string[] = [], placed = new Map<string, { path: string; backup?: string; digest?: string }>();
  try {
    fd = regular(safe(dirname(resolve(o.bundle)), relative(dirname(resolve(o.bundle)), resolve(o.bundle))));
    const { m, offset, digest } = checkedManifest(fd);
    if (m.kind !== o.kind || m.conversation !== o.conversation) return fail('invalid-bundle');
    const existing = conversationFiles(o.accountFolder, m.kind, m.conversation);
    if (existing.length && o.overwrite !== true) return fail('exists');
    for (const f of m.files) {
      const path = safe(o.accountFolder, f.path);
      try { if (!lstatSync(path).isFile()) refuse('unsafe-path'); if (!o.overwrite) refuse('exists'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    stage = mkdtempSync(join(o.accountFolder, '.conversation-')); let position = offset;
    for (const [i, f] of m.files.entries()) {
      const out = openSync(join(stage, `new${i}`), 'wx', 0o600);
      try { if (copy(fd, position, f.size, out) !== f.sha256) refuse('digest-mismatch'); }
      finally { closeSync(out); }
      const verify = regular(join(stage, `new${i}`));
      try { if (copy(verify, 0, fstatSync(verify).size) !== f.sha256) refuse('digest-mismatch'); } finally { closeSync(verify); }
      position += f.size;
    }
    for (const [i, rel] of existing.entries()) {
      const path = safe(o.accountFolder, rel), backup = join(stage, `old${i}`), old = regular(path);
      let original: string;
      try { if (fstatSync(old).size > CEILING) refuse('too-large'); original = copy(old, 0, fstatSync(old).size); }
      finally { closeSync(old); }
      linkSync(path, backup); placed.set(path, { path, backup, digest: original });
      if (!m.files.some(f => f.path === rel)) unlinkSync(path);
    }
    for (const [i, f] of m.files.entries()) {
      const path = safe(o.accountFolder, f.path), missing: string[] = [];
      for (let dir = dirname(path); dir !== resolve(o.accountFolder); dir = dirname(dir)) {
        try { if (!lstatSync(dir).isDirectory()) refuse('unsafe-path'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; missing.unshift(dir); }
      }
      for (const dir of missing) { mkdirSync(dir, { mode: 0o700 }); created.push(dir); }
      if (placed.has(path)) renameSync(join(stage, `new${i}`), path);
      else { linkSync(join(stage, `new${i}`), path); placed.set(path, { path }); unlinkSync(join(stage, `new${i}`)); }
    }
    for (const item of placed.values()) if (item.backup) unlinkSync(item.backup);
    rmdirSync(stage); stage = undefined;
    return { ok: true, kind: m.kind, conversation: m.conversation, files: m.files.length, bytes: m.bytes, digest };
  } catch (e) {
    try {
      for (const item of [...placed.values()].reverse()) {
        if (item.backup) {
          const old = lstatSync(item.backup); let unchanged = false;
          try { const live = lstatSync(item.path); unchanged = old.ino === live.ino && old.dev === live.dev; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          if (!unchanged) renameSync(item.backup, item.path);
          const restored = regular(item.path);
          try { if (copy(restored, 0, fstatSync(restored).size) !== item.digest) refuse('rollback-failed'); }
          finally { closeSync(restored); }
        } else unlinkSync(item.path);
      }
      for (const dir of created.reverse()) rmdirSync(dir);
      if (stage) { for (const name of readdirSync(stage)) unlinkSync(join(stage, name)); rmdirSync(stage); stage = undefined; }
    } catch { return fail('rollback-failed'); }
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? fail('exists') : result(e);
  } finally { try { if (fd !== undefined) closeSync(fd); } catch { return fail('write-failed'); } }
}
