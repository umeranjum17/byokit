#!/usr/bin/env node
// `byokit-accounts` — one source of truth for the CLI accounts a pool owner keeps. `list` and `pick` read the
// same rows `cliAccounts` already produces, so the fleet's pick and the captain's list never disagree. Every
// answer is JSON and never carries a secret. Reads `<stateDir>/pool.json`: the absolute path of each CLI
// binary, plus HOME and PATH. Exit 0 ok, 2 usage, 1 anything else, always with a plain message.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Room, Window } from '@byokit/usage';
import { CliAccountError, cliAccounts, type CliAccount, type CliPickRow, type CliProvider } from './cli.ts';
import { REST_MS } from './limits.ts';
import { poolPrepare } from './prepare.ts';

export type CliIo = { stdout(s: string): void; stderr(s: string): void };

const PROVIDERS: CliProvider[] = ['claude', 'codex', 'pi', 'opencode', 'kimi', 'vibe'];
const USAGE = 'byokit-accounts <list|add|status|pick|rest|unrest> [--state <dir>] ...';
/** The command's own two Claude headers; a pool row's room and its Windows need a client that says who it is. */
const CLAUDE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'byokit-accounts' };

class UsageError extends Error {}

/** One account as every command prints it: the account's own row plus its reading, and never a secret. */
export type PoolRow = {
  id: string; tool: CliProvider; name: string; state: CliAccount['state'];
  restUntil?: number; why?: 'api_key' | 'unknown'; email?: string; plan?: string; addedAt?: number;
  room?: Room; windows?: Window[]; readAt?: number;
};

type Flags = { state?: string; until?: string; why?: string; provider?: string; prefer?: string; json: boolean };
type Args = { command?: string; words: string[]; flags: Flags };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parse(argv: string[]): Args {
  const words: string[] = []; const flags: Flags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { flags.json = true; continue; }
    const name = /^--(state|until|why|provider|prefer)$/.exec(arg)?.[1];
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
  if (value === undefined || value === '') throw new UsageError('this command needs a tool: claude, codex, pi, opencode, kimi or vibe');
  if (!PROVIDERS.includes(value as CliProvider)) throw new UsageError(`unknown tool "${value}"`);
  return value as CliProvider;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const emit = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const args = parse(argv);
    const stateDir = needed(args.flags.state, '--state <dir> is required: the pool folder that holds pool.json');
    if (!isAbsolute(stateDir)) throw new UsageError('--state must be an absolute path');
    const config = readPool(stateDir);
    const kit = kitFor(stateDir, config);
    switch (args.command) {
      case 'list': {
        const rows: PoolRow[] = [];
        // Every tool is asked the same question `pick` answers, so `list` is those rows and nothing else.
        for (const tool of PROVIDERS) rows.push(...(await kit.pick(tool)).rows.map(readingRow));
        emit(rows);
        return 0;
      }
      case 'status': {
        emit(rowOf(await kit.status(needed(args.words[0], 'status needs an account id'))));
        return 0;
      }
      case 'pick': {
        const tool = toolArg(args.words[0]);
        const picked = await kit.pick(tool, args.flags.prefer === undefined ? {} : { prefer: args.flags.prefer });
        if (!picked.ok) {
          emit({ ok: false, tool, reason: picked.reason, rows: picked.rows.map(readingRow) });
          io.stderr(`error: ${picked.reason}\n`);
          return 1;
        }
        emit({ ok: true, id: picked.account.id, tool, name: picked.account.name, room: picked.room,
          windows: picked.rows.find((r) => r.account.id === picked.account.id)?.windows ?? [], rows: picked.rows.map(readingRow),
          readAt: picked.rows.find((r) => r.account.id === picked.account.id)?.readAt,
          ...kit.launchEnv(picked.account.id) });
        return 0;
      }
      case 'add': {
        const tool = toolArg(args.words[0]);
        if (tool !== 'pi' && args.flags.provider !== undefined) throw new UsageError('--provider only names a pi subscription');
        const added = tool === 'pi'
          ? await kit.add('pi', { piProvider: needed(args.flags.provider, 'add pi needs --provider <id>') })
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
