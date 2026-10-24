#!/usr/bin/env node
// `byokit-accounts` — one source of truth for the CLI accounts a pool owner keeps. `list` and `pick` read the
// same rows `cliAccounts` already produces, so the pool's pick and the person's list never disagree.
// Output formats and pool setup: ../README.md#the-byokit-accounts-command. Never prints a secret.
// Reads `<stateDir>/pool.json`: the absolute path of each CLI
// binary, plus HOME and PATH. Writes `<stateDir>/readings-v1.json` after every read, so `list --json
// --cached` answers with no read at all. Exit 0 ok, 2 usage, 1 anything else, always with a plain message.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Room, Window } from '@byokit/usage';
import { versionLabel } from '@byokit/usage/version';
import { packageVersion } from '@byokit/usage/version/node';
import { CliAccountError, cliAccounts, type CliAccount, type CliPickRow, type CliProvider } from './cli.ts';
import { REST_MS } from './limits.ts';
import { poolPrepare } from './prepare.ts';
import { clock } from './words.ts';

export type CliIo = { stdout(s: string): void; stderr(s: string): void };

const PROVIDERS: CliProvider[] = ['claude', 'codex', 'pi', 'opencode', 'kimi', 'vibe', 'cursor'];
const USAGE = 'byokit-accounts <list|add|status|pick|use|env|rest|unrest> [--state <dir>] [--json] [--cached] ...';
/** The command's own two Claude headers; a pool row's room and its Windows need a client that says who it is. */
const CLAUDE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'byokit-accounts' };

/** `byokit-accounts 0.31.0`: the command's own package, read from its package.json beside `dist/` and `src/`. */
const VERSION = `byokit-accounts ${versionLabel(packageVersion(new URL('../package.json', import.meta.url)))}`;

class UsageError extends Error {}

/** One account as every command prints it: the account's own row plus its reading, and never a secret. */
export type PoolRow = {
  id: string; tool: CliProvider; name: string; state: CliAccount['state'];
  restUntil?: number; why?: 'api_key' | 'unknown'; email?: string; plan?: string; addedAt?: number;
  room?: Room; windows?: Window[]; readAt?: number;
};

type Flags = { state?: string; until?: string; why?: string; provider?: string; model?: string; prefer?: string; json: boolean; cached: boolean; clear: boolean };
type Args = { command?: string; words: string[]; flags: Flags };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parse(argv: string[]): Args {
  const words: string[] = []; const flags: Flags = { json: false, cached: false, clear: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { flags.json = true; continue; }
    if (arg === '--cached') { flags.cached = true; continue; }
    if (arg === '--clear') { flags.clear = true; continue; }
    const name = /^--(state|until|why|provider|model|prefer)$/.exec(arg)?.[1];
    if (name) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      flags[name as 'state'] = value;
      continue;
    }
    if (arg.startsWith('-')) throw new UsageError(`unknown flag "${arg}"`);
    words.push(arg);
  }
  const [command, ...rest] = words;
  return { command, words: rest, flags };
}

/** An absolute `--until` time: epoch milliseconds, an ISO time, or a short wait from now such as `45m`. */
export function parseUntil(value: string, nowMs: number = Date.now()): number {
  const wait = /^(\d+)(s|m|h)$/.exec(value);
  if (wait) return nowMs + Number(wait[1]) * (wait[2] === 's' ? 1_000 : wait[2] === 'm' ? 60_000 : 3_600_000);
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return at;
  throw new UsageError(`--until wants epoch milliseconds, an ISO time or a short wait such as 45m (got "${value}")`);
}

type PoolConfig = { bins: Partial<Record<CliProvider, string>>; home: string; path: string };

/** The pool folder's own config. Only binary paths, HOME and PATH live here: nothing a secret can hide in. */
export function readPool(stateDir: string): PoolConfig {
  const file = join(stateDir, 'pool.json');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`cannot read ${file}: write a pool.json with your CLI binary paths, HOME and PATH`); }
  if (!record(raw) || !record(raw.bins) || typeof raw.home !== 'string' || !raw.home || typeof raw.path !== 'string' || !raw.path) {
    throw new Error(`${file} must be {"bins":{"<tool>":"<absolute path>"},"home":"<absolute path>","path":"<PATH>"}`);
  }
  const bins = Object.fromEntries(Object.entries(raw.bins).filter(([, v]) => typeof v === 'string' && v !== '')) as Partial<Record<CliProvider, string>>;
  return { bins, home: raw.home, path: raw.path };
}

/** The history folder each tool keeps in its own default login, shared with a new pool folder when it exists. */
function historyFrom(home: string): Partial<Record<CliProvider, string>> {
  const shared: [CliProvider, string[]][] = [['claude', ['.claude', 'projects']], ['codex', ['.codex', 'sessions']], ['pi', ['.pi', 'agent', 'sessions']]];
  return Object.fromEntries(shared.filter(([, parts]) => existsSync(join(home, ...parts))).map(([tool, parts]) => [tool, join(home, ...parts)]));
}

function kitFor(stateDir: string, config: PoolConfig) {
  return cliAccounts({
    stateDir, bins: config.bins, env: { HOME: config.home, PATH: config.path },
    historyFrom: historyFrom(config.home), claudeHeaders: CLAUDE_HEADERS, prepare: poolPrepare({ home: config.home }),
  });
}

/** The same age rule `@byokit/usage` applies to a stored reading: older than a day is stale. A row with
 * no `readAt` has no reading, so it is stale too. */
const STALE_MS = 86_400_000;
export const isStale = (readAt: number | undefined, nowMs: number): boolean =>
  readAt === undefined || !Number.isFinite(readAt) || nowMs > readAt + STALE_MS;

/** One listed row: the reading row plus the two fields only a listing adds, never a secret. */
export type ListedRow = PoolRow & { stale: boolean; preferred?: true };

/** The last reading of every row: `list` and `pick` write it whole, `list --json --cached` answers from it. */
export type ReadingsRecord = { version: 1; rows: PoolRow[] };

const readingsFile = (stateDir: string) => join(stateDir, 'readings-v1.json');
const savedRow = (v: unknown): v is PoolRow => record(v) && typeof v.id === 'string' && typeof v.tool === 'string'
  && typeof v.name === 'string' && typeof v.state === 'string';

/** Every saved row, whole. An unreadable or older file answers nothing rather than guessing. */
export function loadReadings(stateDir: string): PoolRow[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(readingsFile(stateDir), 'utf8'));
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.rows)) return [];
    return raw.rows.filter(savedRow);
  } catch { return []; }
}

/** Replace this tool's rows with the ones just read, keep the other tools', and write the file whole through
 * a temporary file in the same folder, renamed over the old one, 0600. */
export function saveReadings(stateDir: string, rows: PoolRow[]): void {
  const tools = new Set(rows.map((row) => row.tool));
  const file = readingsFile(stateDir); const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const kept = loadReadings(stateDir).filter((row) => !tools.has(row.tool));
    writeFileSync(tmp, JSON.stringify({ version: 1, rows: [...kept, ...rows] } satisfies ReadingsRecord), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

export function rowOf(account: CliAccount): PoolRow {
  return { id: account.id, tool: account.provider, name: account.name, state: account.state,
    ...(account.until !== undefined ? { restUntil: account.until } : {}), ...(account.why !== undefined ? { why: account.why } : {}),
    ...(account.email !== undefined ? { email: account.email } : {}), ...(account.plan !== undefined ? { plan: account.plan } : {}),
    ...(account.addedAt !== undefined ? { addedAt: account.addedAt } : {}) };
}

/** The same row with its reading: exactly what `pick` returns and `list` prints for one account. */
export function readingRow(row: CliPickRow): PoolRow {
  return { ...rowOf(row.account), room: row.room, windows: row.windows, ...(row.readAt !== undefined ? { readAt: row.readAt } : {}) };
}

const needed = (value: string | undefined, message: string): string => {
  if (value === undefined || value === '') throw new UsageError(message);
  return value;
};

function toolArg(value: string | undefined): CliProvider {
  if (value === undefined || value === '') throw new UsageError('this command needs a tool: claude, codex, pi, opencode, kimi, vibe or cursor');
  if (!PROVIDERS.includes(value as CliProvider)) throw new UsageError(`unknown tool "${value}"`);
  return value as CliProvider;
}

/** A value a shell reads back exactly: folder paths only, so nothing a secret can hide in. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const roomText = (room: Room | undefined): string => room === undefined || room.left === 'unknown' ? 'unknown' : `${room.left}%`;

/** The reading's own reset, else the tightest window's reset, else nothing. */
const resetText = (row: PoolRow): string => {
  const room = row.room;
  const at = room !== undefined && 'resetsAt' in room && room.resetsAt !== undefined ? room.resetsAt
    : row.windows?.map((w) => w.resetsAt).filter((t): t is number => typeof t === 'number').sort((a, b) => a - b)[0];
  return at === undefined ? '-' : clock(at);
};

/** Plain words for the one note a row carries: the account this tool prefers, and its rest. */
const noteText = (row: ListedRow): string => {
  const notes: string[] = [];
  if (row.preferred === true) notes.push('preferred');
  if (row.state === 'resting' && row.restUntil !== undefined) notes.push(`resting until ${clock(row.restUntil)}`);
  return notes.join(', ');
};

/** One plain aligned line per account: no colour, no jargon, never a secret. */
export function table(rows: ListedRow[]): string {
  const head = ['id', 'tool', 'name', 'state', 'room', 'reset', 'note'];
  const cells = rows.map((row): string[] => [row.id, row.tool, row.name, row.state, roomText(row.room), resetText(row), noteText(row)]);
  const widths = head.map((label, i) => Math.max(label.length, ...cells.map((row) => row[i]!.length)));
  const line = (values: string[]) => values.map((value, i) => value.padEnd(widths[i]!)).join('  ').trimEnd();
  return `${[line(head), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n')}\n`;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') { io.stdout(`${VERSION}\n${USAGE}\n`); return 0; }
  if (argv.length === 1 && argv[0] === '--version') { io.stdout(`${VERSION}\n`); return 0; }
  const emit = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const args = parse(argv);
    const stateDir = needed(args.flags.state, '--state <dir> is required: the pool folder that holds pool.json');
    if (!isAbsolute(stateDir)) throw new UsageError('--state must be an absolute path');
    const config = readPool(stateDir);
    const kit = kitFor(stateDir, config);
    /** The rows a listing adds `stale` and `preferred` to, in one place for the live and cached paths. */
    const listed = (rows: PoolRow[], nowMs: number = Date.now()): ListedRow[] => rows.map((row) => ({
      ...row, stale: isStale(row.readAt, nowMs), ...(row.id === kit.preferOf(row.tool) ? { preferred: true as const } : {}) }));
    /** Every tool's rows, saved whole so `list --json --cached` can answer them without a read. */
    const readAll = async (): Promise<PoolRow[]> => {
      const read: PoolRow[] = [];
      // Every tool is asked the same question `pick` answers, so `list` is those rows and nothing else.
      for (const tool of PROVIDERS) read.push(...(await kit.pick(tool)).rows.map(readingRow));
      saveReadings(stateDir, read);
      return read;
    };
    switch (args.command) {
      case 'list': {
        // `--cached` answers from the saved file alone: no binary runs and no reading is taken.
        const rendered = listed(args.flags.cached ? loadReadings(stateDir) : await readAll());
        if (args.flags.json) emit(rendered); else io.stdout(table(rendered));
        return 0;
      }
      case 'status': {
        emit(rowOf(await kit.status(needed(args.words[0], 'status needs an account id'))));
        return 0;
      }
      case 'pick': {
        const tool = toolArg(args.words[0]);
        const picked = await kit.pick(tool, args.flags.prefer === undefined ? {} : { prefer: args.flags.prefer });
        const saved = picked.rows.map(readingRow);
        const rows = listed(saved);
        saveReadings(stateDir, saved);
        if (!picked.ok) {
          emit({ ok: false, tool, reason: picked.reason, rows });
          io.stderr(`error: ${picked.reason}\n`);
          return 1;
        }
        emit({ ok: true, id: picked.account.id, tool, name: picked.account.name, room: picked.room,
          windows: picked.rows.find((r) => r.account.id === picked.account.id)?.windows ?? [], rows,
          readAt: picked.rows.find((r) => r.account.id === picked.account.id)?.readAt,
          ...kit.launchEnv(picked.account.id, args.flags.model) });
        return 0;
      }
      case 'use': {
        // `use --clear <tool>` ends a tool's preference; it succeeds even when there is none.
        if (args.flags.clear) {
          const tool = toolArg(args.words[0]);
          kit.setPrefer(tool);
          emit({ ok: true, tool, cleared: true });
          return 0;
        }
        const account = await kit.status(needed(args.words[0], 'use needs an account id, or --clear <tool>'));
        kit.setPrefer(account.provider, account.id);
        emit({ ok: true, tool: account.provider, id: account.id, name: account.name, preferred: true });
        return 0;
      }
      case 'env': {
        // Folder paths only, for `eval "$(byokit-accounts env <id>)"`: no key, no read, no secret.
        const env = kit.launchEnv(needed(args.words[0], 'env needs an account id'), args.flags.model);
        for (const [key, value] of Object.entries(env.set)) io.stdout(`export ${key}=${shellQuote(value)}\n`);
        for (const key of env.unset) io.stdout(`unset ${key}\n`);
        return 0;
      }
      case 'add': {
        const tool = toolArg(args.words[0]);
        if (tool !== 'pi' && args.flags.provider !== undefined) throw new UsageError('--provider only names a pi subscription');
        const added = tool === 'pi'
          ? await kit.add('pi', { piProvider: needed(args.flags.provider, 'add pi needs --provider <id>'), model: needed(args.flags.model, 'add pi needs --model <id>') })
          : await kit.add(tool);
        emit({ account: rowOf(added.account), signIn: added.signIn });
        if (added.signIn.shell !== ':') io.stderr(`next: ${added.signIn.shell}\n`);
        return 0;
      }
      case 'rest': {
        const id = needed(args.words[0], 'rest needs an account id');
        const until = args.flags.until === undefined ? Date.now() + REST_MS.rate_limit : parseUntil(args.flags.until);
        emit(rowOf(await kit.rest(id, { until, why: args.flags.why ?? 'manual' })));
        return 0;
      }
      case 'unrest': {
        emit(rowOf(await kit.unrest(needed(args.words[0], 'unrest needs an account id'))));
        return 0;
      }
      default:
        throw new UsageError(args.command === undefined ? 'a command is required' : `unknown command "${args.command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) { io.stderr(`error: ${error.message}\nhelp: ${USAGE}\n`); return 2; }
    if (error instanceof CliAccountError) { io.stderr(`error: ${error.message}\n`); return 1; }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  const io: CliIo = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
