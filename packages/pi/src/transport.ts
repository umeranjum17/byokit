// The one module that talks to Pi: its launch flags and variables, its JSONL records and its package name live here and
// nowhere else, and the rest of the kit speaks types.ts. Replacing Pi means replacing this file (test/isolation.test.ts holds the line).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiError, type BotEvent, type BotSpec, type Launch } from './types.ts';

const PI = '@earendil-works/pi-coding-agent';
const PINNED = (createRequire(import.meta.url)('../package.json') as { peerDependencies: Record<string, string> }).peerDependencies[PI]!;
const GRACE_MS = 3000;

export type When = 'now' | 'steer' | 'followUp';
export type PiLink = {
  pid: number | undefined;
  say(text: string, when: When): Promise<void>;
  abort(): Promise<void>;
  /** Whether Pi has nothing running or queued. */
  quiet(): Promise<boolean>;
  close(): Promise<void>;
};

type Waiter = { resolve(data: Record<string, unknown>): void; reject(error: Error): void };
type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: { totalTokens?: number } };
type PiRecord = Record<string, unknown> & { type?: string };

/** The pinned Pi beside this kit: a different version is refused, because Pi's protocol moves between releases. */
function piEntry(): string {
  let entry: string;
  try { entry = fileURLToPath(import.meta.resolve(`${PI}/rpc-entry`)); } catch {
    throw new PiError('pi-missing', `${PI} ${PINNED} is not installed: add it beside @byokit/pi.`);
  }
  const { version } = JSON.parse(readFileSync(join(dirname(entry), '..', '..', 'package.json'), 'utf8')) as { version: string };
  if (version !== PINNED) throw new PiError('pi-version', `@byokit/pi needs ${PI} ${PINNED}, but ${version} is installed.`);
  return entry;
}

/** Only what the spec names reaches Pi: discovery is off (parent folders' AGENTS.md included) and the bot's own files are passed by path. */
function launchArgs(spec: BotSpec, sessions: string): string[] {
  const context = join(spec.folder, 'AGENTS.md');
  const skills = join(spec.folder, 'skills');
  return ['--session-dir', sessions, '--session-id', spec.session,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--no-approve',
    '--exclude-tools', 'bash',
    ...(spec.extensions ?? []).flatMap((path) => ['--extension', path]),
    ...existsSync(skills) ? ['--skill', skills] : [],
    ...existsSync(context) ? ['--append-system-prompt', context] : []];
}

/** What runs: the kit's own command, or what the bot's `launch` makes of it. A launch that fails stops the start, so Pi never runs without it. */
function launched(spec: BotSpec, pi: Launch): Launch {
  if (spec.launch === undefined) return pi;
  let answer: Launch;
  try { answer = spec.launch(pi); } catch (error) {
    throw new PiError('bad-launch', `Bot ${spec.id} did not start: its launch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { command, args } = (answer ?? {}) as Partial<Launch>;
  if (typeof command !== 'string' || !command || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new PiError('bad-launch', `Bot ${spec.id} did not start: its launch must return a command and its args.`);
  }
  return { command, args };
}

const textOf = (message: Message) => Array.isArray(message.content)
  ? (message.content as { type?: string; text?: string }[]).filter((part) => part.type === 'text').map((part) => part.text).join('') : '';

export function openPi(spec: BotSpec, stateDir: string, on: (event: BotEvent) => void, maxToolCalls: number, exited: (detail: string) => void): PiLink {
  const entry = piEntry();
  const home = join(stateDir, 'pi', spec.id);
  const sessions = join(spec.folder, 'sessions');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const { command, args } = launched(spec, { command: process.execPath, args: [entry, ...launchArgs(spec, sessions)] });
  const child = spawn(command, args, {
    cwd: spec.folder,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', ...spec.env, HOME: home, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  });

  const waiting = new Map<string, Waiter>();
  let sent = 0;
  let running = false;
  let closing = false;
  let text = '';
  let failure: string | undefined;
  let toolCalls = 0;
  let capped: string | undefined;
  let diagnostics = '';
  const note = (part: string) => { diagnostics = (diagnostics + part).slice(-2000); };
  const write = (record: object) => { child.stdin.write(`${JSON.stringify(record)}\n`); };
  const ask = (command: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
    sent += 1;
    waiting.set(String(sent), { resolve, reject });
    write({ ...command, id: String(sent) });
  });

  const read = (record: PiRecord) => {
    switch (record.type) {
      case 'response': {
        const waiter = waiting.get(String(record.id));
        if (!waiter) return;
        waiting.delete(String(record.id));
        if (record.success === true) waiter.resolve((record.data ?? {}) as Record<string, unknown>);
        else waiter.reject(new PiError('pi-refused', String(record.error)));
        return;
      }
      case 'agent_start': running = true; toolCalls = 0; capped = undefined; on({ type: 'started' }); return;
      case 'message_update': {
        const update = record.assistantMessageEvent as { type?: string; delta?: string };
        if (update.type === 'text_delta') on({ type: 'text', text: update.delta ?? '' });
        if (update.type === 'thinking_start') on({ type: 'thinking' });
        return;
      }
      case 'tool_execution_start': on({ type: 'tool', name: String(record.toolName), phase: 'start' }); return;
      case 'tool_execution_end': on({ type: 'tool', name: String(record.toolName), phase: 'end', ...record.isError === true ? { error: true } : {} }); return;
      case 'message_end': {
        const message = record.message as Message;
        if (message.role !== 'assistant') return;
        text = textOf(message);
        failure = message.stopReason === 'error' ? message.errorMessage ?? 'The model call failed.' : undefined;
        if (message.usage?.totalTokens) on({ type: 'usage', tokens: message.usage.totalTokens });
        // Judged when the model asks, so the call that trips the cap may already be running and still finishes. Both stops go out at once, queue first, as abort() does.
        const wanted = Array.isArray(message.content) ? (message.content as { type?: string }[]).filter((part) => part.type === 'toolCall').length : 0;
        if (wanted > 0 && capped === undefined && toolCalls + wanted > maxToolCalls) {
          capped = `Stopped: this turn reached its limit of ${maxToolCalls} tool calls (maxToolCalls), so the run was ended.`;
          on({ type: 'limit', toolCalls, limit: maxToolCalls });
          for (const stop of ['clear_queue', 'abort']) ask({ type: stop }).catch(() => {});
        } else toolCalls += wanted;
        return;
      }
      case 'agent_settled':
        running = false;
        on({ type: 'end', end: capped !== undefined ? { ok: false, message: capped } : record.aborted === true ? { ok: false, aborted: true } : failure !== undefined ? { ok: false, message: failure } : { ok: true, text } });
        text = ''; failure = undefined; capped = undefined;
        return;
      // Nobody can answer a dialog yet, and an unanswered one blocks the bot for good.
      case 'extension_ui_request':
        if (['select', 'confirm', 'input', 'editor'].includes(String(record.method))) write({ type: 'extension_ui_response', id: record.id, cancelled: true });
        return;
    }
  };

  // Split on LF only: Pi's strings may hold U+2028, which a line reader would break on.
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (part: string) => {
    buffer += part;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let record: PiRecord;
      try { record = JSON.parse(line) as PiRecord; } catch { note(`${line}\n`); continue; }
      read(record);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', note);
  child.stdin.on('error', note); // A write racing Pi's exit: the close below reports it.

  let gone: () => void = () => {};
  const closed = new Promise<void>((resolve) => { gone = resolve; });
  let finished = false;
  const finish = (detail: string) => {
    if (finished) return; // A command that cannot start emits both error and close, and a late close must not touch the bot's next process.
    finished = true;
    for (const waiter of waiting.values()) waiter.reject(new PiError('pi-exited', detail));
    waiting.clear();
    if (running) on({ type: 'end', end: closing ? { ok: false, aborted: true } : { ok: false, message: detail } });
    running = false;
    exited(detail);
    gone();
  };
  child.on('error', (error) => { if (child.pid === undefined) finish(`Pi did not start: ${error.message}`); });
  child.on('close', (code, signal) => finish(`Pi stopped (${signal ?? `exit ${code}`}). ${diagnostics.trim()}`.trim()));

  return {
    pid: child.pid,
    say: async (message, when) => { await ask({ type: 'prompt', message, ...when === 'now' ? {} : { streamingBehavior: when } }); },
    // Pi carries on with queued messages after an abort, so the queue goes first.
    abort: async () => { await ask({ type: 'clear_queue' }); await ask({ type: 'abort' }); },
    quiet: async () => {
      const state = await ask({ type: 'get_state' });
      return state.isStreaming !== true && state.isCompacting !== true && !state.pendingMessageCount;
    },
    close: async () => {
      closing = true;
      child.stdin.end();
      const term = setTimeout(() => child.kill('SIGTERM'), GRACE_MS);
      const kill = setTimeout(() => child.kill('SIGKILL'), GRACE_MS * 2);
      await closed;
      clearTimeout(term); clearTimeout(kill);
    },
  };
}
