import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { logRecord, type LogContext, type HarnessLogEntry, type HarnessLogFormat } from './log-record.ts';
export type { HarnessLogEntry, HarnessLogFormat } from './log-record.ts';

export interface HarnessLogFile { path: string; format: HarnessLogFormat }
export interface HarnessLogOptions {
  /** Exact caller-selected regular files. No directory discovery. At most 256. */
  files: readonly HarnessLogFile[];
  /** Maximum retained line bytes, default 64 KiB, maximum 1 MiB. Longer lines are skipped. */
  maxLineBytes?: number;
  /** Event digests retained for this reader's lifetime, default 100,000, maximum 1,000,000. */
  maxIdentities?: number;
}
export interface HarnessLogReadOptions {
  signal?: AbortSignal;
  /** Wall-clock deadline for this page, default 100 ms, maximum 10 seconds. */
  deadlineMs?: number;
  /** Bytes physically read per page, default 64 KiB, maximum 1 MiB. */
  maxBytes?: number;
  /** Complete lines processed per page, default 256, maximum 10,000. */
  maxLines?: number;
  /** Entries returned per page, default 128, maximum 10,000. */
  maxEntries?: number;
}
export interface HarnessLogWork {
  bytesRead: number;
  readCalls: number;
  filesChecked: number;
  lines: number;
  parserCalls: number;
  malformed: number;
  oversized: number;
  duplicates: number;
  resets: number;
}
export interface HarnessLogPage {
  entries: HarnessLogEntry[];
  /** More bounded pages may be needed; false may still leave an unfinished line awaiting append. */
  more: boolean;
  code?: 'unavailable' | 'cancelled' | 'deadline' | 'capacity' | 'busy';
  work: HarnessLogWork;
}
export interface HarnessLog { read(options?: HarnessLogReadOptions): Promise<HarnessLogPage> }
export class HarnessLogError extends Error {
  readonly code = 'bad-source';
  constructor() { super('Invalid usage log source.'); this.name = 'HarnessLogError'; }
}
interface FileState {
  file: HarnessLogFile;
  identity?: string;
  size: number;
  mtime: number;
  ctime: number;
  offset: number;
  pending: Buffer;
  line: Buffer;
  oversized: boolean;
  context: LogContext;
}
function bound(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw new HarnessLogError();
  return n;
}
/** Append-only, explicit-file event reader. Returned entries are committed even on a stopped page. */
export function harnessLog(options: HarnessLogOptions): HarnessLog {
  if (!options || !Array.isArray(options.files) || !options.files.length || options.files.length > 256) throw new HarnessLogError();
  const paths = new Set<string>();
  const states: FileState[] = options.files.map((file) => {
    if (!file || typeof file.path !== 'string' || !isAbsolute(file.path) || /[\x00-\x1f]/.test(file.path)
      || !['pi', 'omp', 'claude', 'codex'].includes(file.format) || paths.has(file.path)) throw new HarnessLogError();
    paths.add(file.path);
    return { file: { path: file.path, format: file.format }, size: 0, mtime: 0, ctime: 0, offset: 0,
      pending: Buffer.alloc(0), line: Buffer.alloc(0), oversized: false, context: {} };
  });
  const maxLine = bound(options.maxLineBytes, 65536, 1048576);
  const maxIdentities = bound(options.maxIdentities, 100000, 1000000);
  const seen = new Set<string>();
  let cursor = 0;
  let busy = false;
  return { async read(opts = {}) {
    const maxBytes = bound(opts.maxBytes, 65536, 1048576);
    const maxLines = bound(opts.maxLines, 256, 10000);
    const maxEntries = bound(opts.maxEntries, 128, 10000);
    const deadline = performance.now() + bound(opts.deadlineMs, 100, 10000);
    const page: HarnessLogPage = { entries: [], more: false, work: {
      bytesRead: 0, readCalls: 0, filesChecked: 0, lines: 0, parserCalls: 0, malformed: 0, oversized: 0, duplicates: 0, resets: 0 } };
    if (busy) return { ...page, more: true, code: 'busy' };
    const stopped = () => {
      if (opts.signal?.aborted) page.code = 'cancelled';
      else if (performance.now() >= deadline) page.code = 'deadline';
      return page.code !== undefined || page.work.lines >= maxLines || page.entries.length >= maxEntries;
    };
    busy = true;
    try {
      for (let checked = 0; checked < states.length; checked++) {
        if (stopped()) { page.more = true; break; }
        const state = states[cursor];
        let handle;
        try {
          // Fail closed on platforms without final-component no-follow support.
          if (!constants.O_NOFOLLOW) throw new Error();
          handle = await open(state.file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = await handle.stat(); page.work.filesChecked++;
          if (!stat.isFile()) throw new Error();
          if (stopped()) { page.more = true; break; }
          const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
          if (state.identity !== undefined && (state.identity !== identity || stat.size < state.size
            || stat.size === state.size && (stat.mtimeMs !== state.mtime || stat.ctimeMs !== state.ctime))) {
            state.offset = 0; state.pending = Buffer.alloc(0); state.line = Buffer.alloc(0); state.oversized = false; state.context = {};
            page.work.resets++;
          }
          state.identity = identity; state.size = stat.size; state.mtime = stat.mtimeMs; state.ctime = stat.ctimeMs;
          while (state.pending.length || state.offset < stat.size) {
            if (stopped()) { page.more = true; break; }
            if (!state.pending.length) {
              const size = Math.min(16384, stat.size - state.offset, maxBytes - page.work.bytesRead);
              if (!size) { page.more = true; break; }
              const buffer = Buffer.alloc(size);
              const { bytesRead } = await handle.read(buffer, 0, size, state.offset);
              page.work.readCalls++; page.work.bytesRead += bytesRead;
              if (!bytesRead) break;
              state.offset += bytesRead; state.pending = buffer.subarray(0, bytesRead);
              if (stopped()) { page.more = true; break; }
            }
            const newline = state.pending.indexOf(10);
            const length = newline < 0 ? state.pending.length : newline;
            const piece = state.pending.subarray(0, length);
            const oversized = state.oversized || state.line.length + piece.length > maxLine;
            const line = oversized ? Buffer.alloc(0) : Buffer.concat([state.line, piece]);
            if (newline >= 0) {
              const context = { ...state.context };
              let entry;
              if (!oversized) { page.work.parserCalls++; entry = logRecord(line, state.file.format, context); }
              if (entry && entry !== 'malformed' && !seen.has(entry.id) && seen.size >= maxIdentities) {
                page.code = 'capacity'; page.more = true; break;
              }
              state.context = context; page.work.lines++;
              if (oversized) page.work.oversized++;
              else if (entry === 'malformed') page.work.malformed++;
              else if (entry) {
                if (seen.has(entry.id)) page.work.duplicates++;
                else { seen.add(entry.id); page.entries.push(entry); }
              }
              state.line = Buffer.alloc(0); state.oversized = false;
              state.pending = state.pending.subarray(length + 1);
            } else {
              state.line = line; state.oversized = oversized; state.pending = Buffer.alloc(0);
            }
          }
          if (page.more) break;
        } catch { page.code = 'unavailable'; page.more = true; break; }
        finally { await handle?.close().catch(() => {}); }
        cursor = (cursor + 1) % states.length;
      }
      return page;
    } finally { busy = false; }
  } };
}
