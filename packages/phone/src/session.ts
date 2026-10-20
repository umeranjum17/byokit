// A phone session: one agent chat that runs on the phone itself, beside the Herdr panes of the person's computers.
// The person's own sign-in answers (through @byokit/accounts, one account for the whole session, never another),
// the chat is an append-only log the app keeps on the phone, and the only tools are the app's own. Every step is
// written before the next one starts, so a session the phone killed reopens where it stopped and nothing reruns by
// itself: the person's Try again finishes the turn, and a tool cut off mid-run is run again only when it says it is
// safe to (`replaySafe`). The phone gives no background time, so "survives" means "continues correctly on reopen".
import {
  billingWords, IncompleteError, isFunctionCall, KeyRouteError, provider, ResponseError,
  type Account, type Accounts, type Api, type AssistantMessage, type AuthHost, type Billing, type Context, type Member,
  type Model, type ResponseInputItem, type ResponseResult, type ResponseTool,
} from '@byokit/accounts';
import { errorWords, words } from './words.ts';

/** Why a turn did not finish. The account limits share @byokit/accounts' vocabulary (docs/kit-conventions.md §2). */
export type PhoneErrorCode = 'signed-out' | 'resting' | 'rate-limited' | 'not-included' | 'network' | 'out-of-credit'
  | 'cut-short' | 'step-limit' | 'busy' | 'failed';

export class PhoneError extends Error {
  readonly code: PhoneErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: PhoneErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'PhoneError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

/** Where the app keeps the chat: one JSON line per step, appended in order. `read` returns every line written. */
export type PhoneLog = { read(): Promise<string[]>; append(line: string): Promise<void>; clear(): Promise<void> };

/** A log in memory: for tests and demos, or reopened by a second session on the same object as a relaunch would. */
export function memoryLog(): PhoneLog {
  const lines: string[] = [];
  return { read: async () => [...lines], append: async (line) => { lines.push(line); }, clear: async () => { lines.length = 0; } };
}

/** One of the app's own tools. `run`'s answer goes to the model, never to the screen. */
export type PhoneTool = {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** True only when running it again after the phone cut it off gives the same result, because its effect is keyed by
   *  `callId` (for example a file named by it). Otherwise a cut-off call is reported to the model as stopped, never rerun. */
  replaySafe?: boolean;
  run(args: Record<string, unknown>, call: { requestId: string; callId: string; signal?: AbortSignal }): Promise<string>;
};

export type PhoneToolState = 'running' | 'done' | 'interrupted';
export type PhoneTurnState = 'running' | 'done' | 'failed' | 'interrupted';
/** One thing the person sent and what came of it. `words` says why a turn failed or was interrupted. */
export type PhoneTurn = {
  requestId: string; text: string; answer: string; state: PhoneTurnState;
  code?: PhoneErrorCode; words?: string;
  tools: { callId: string; name: string; state: PhoneToolState }[];
};
/** The session as a Home row beside Herdr panes, in the same words as Herdr's `AgentStatus`: `blocked` means a turn
 *  was cut off and waits for the person's Try again. */
export type PhoneSessionStatus = 'idle' | 'working' | 'blocked';
/** Who answers and how it is paid for, in the catalogue's own sentence ("Uses your ChatGPT plan.", "Charged per use to
 *  your OpenRouter account, not a plan."). */
export type PhoneAccount = { id: string; name: string; billing: Billing; words: string; signedIn: boolean };

export type PhoneSessionOptions<M extends Member> = {
  /** The app's own `Accounts`, where the person signed in on this phone. */
  accounts: Pick<Accounts<AuthHost, M>, 'list' | 'respond'>;
  member: M;
  /** The one account this session answers from (`chatgpt`, or an id from `accounts.list`). It never changes. */
  account: string;
  /** The model, for every account but ChatGPT (whose catalogue model is used): the kit never guesses one. */
  model?: Model<Api>;
  instructions: string;
  tools?: readonly PhoneTool[];
  log: PhoneLog;
  /** Model calls one turn may make. Default 8. */
  maxSteps?: number;
  now?: () => number;
  /** A new request id. Default `crypto.randomUUID`. */
  newId?: () => string;
};

export type PhoneSendOptions = { requestId?: string; signal?: AbortSignal; onText?: (answer: string) => void };

type Call = { id: string; name: string; args: Record<string, unknown> };
type Json = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'];
type Entry =
  | { t: 'user'; rid: string; text: string; at: number }
  | { t: 'step'; rid: string; text: string; calls: Call[] }
  | { t: 'tool-start'; rid: string; id: string }
  | { t: 'tool-end'; rid: string; id: string; output: string; error?: boolean }
  | { t: 'end'; rid: string; text: string }
  | { t: 'fail'; rid: string; code: PhoneErrorCode };

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const STOPPED = 'The app closed while this tool was running. It may or may not have acted, and it was not run again: do not assume it ran, and ask the person before trying it again.';

/** The cause of a failed model call, in the shared vocabulary; null for an abort or anything else, which is rethrown. */
function codeOf(e: unknown): PhoneErrorCode | null {
  if (e instanceof IncompleteError) return 'cut-short';
  if (e instanceof ResponseError) return ({ signed_out: 'signed-out', rate_limit: 'rate-limited', overloaded: 'resting',
    not_included: 'not-included', network: 'network' } as const)[e.kind as string] ?? 'failed';
  if (e instanceof KeyRouteError) return e.code === 'aborted' ? null : ({ key_refused: 'signed-out', rate_limited: 'rate-limited',
    out_of_credit: 'out-of-credit' } as const)[e.code as string] ?? 'failed';
  return null;
}

export class PhoneSession<M extends Member = Member> {
  private entries: Entry[];
  private running: string | null = null;
  private readonly o: PhoneSessionOptions<M>;

  private constructor(o: PhoneSessionOptions<M>, entries: Entry[]) {
    this.o = o;
    this.entries = entries;
  }

  /** Read the kept chat. A line the phone was killed while writing is skipped, so every earlier step survives. */
  static async open<M extends Member>(o: PhoneSessionOptions<M>): Promise<PhoneSession<M>> {
    const entries: Entry[] = [];
    for (const line of await o.log.read()) {
      try { const e = JSON.parse(line); if (e && typeof e.t === 'string' && typeof e.rid === 'string') entries.push(e); } catch { /* a torn last line */ }
    }
    return new PhoneSession(o, entries);
  }

  /** The account this session answers from, and how it is billed; `signedIn: false` until it is on this phone. */
  async account(): Promise<PhoneAccount> {
    const row = await this.row();
    if (!row) return { id: this.o.account, name: this.o.account, billing: 'unknown', words: words('phone.signedOut'), signedIn: false };
    let said: string;
    try { said = billingWords({ ...provider(row.provider), billing: row.billing }); } catch { said = row.label; }
    return { id: row.id, name: row.name, billing: row.billing, words: said, signedIn: row.state === 'ready' };
  }

  get turns(): PhoneTurn[] {
    const turns = new Map<string, PhoneTurn>();
    for (const e of this.entries) {
      if (e.t === 'user') { turns.set(e.rid, { requestId: e.rid, text: e.text, answer: '', state: e.rid === this.running ? 'running' : 'interrupted', tools: [] }); continue; }
      const turn = turns.get(e.rid);
      if (!turn) continue;
      if (e.t === 'step') {
        if (e.text) turn.answer = turn.answer ? `${turn.answer}\n\n${e.text}` : e.text;
        for (const c of e.calls) turn.tools.push({ callId: c.id, name: c.name, state: turn.state === 'running' ? 'running' : 'interrupted' });
      } else if (e.t === 'tool-end') {
        const tool = turn.tools.find((x) => x.callId === e.id);
        if (tool) tool.state = 'done';
      } else if (e.t === 'end') Object.assign(turn, { answer: e.text, state: 'done' });
      else if (e.t === 'fail') Object.assign(turn, { state: 'failed', code: e.code, words: errorWords({ code: e.code }) });
    }
    for (const turn of turns.values()) if (turn.state === 'interrupted') turn.words = words('phone.interrupted');
    return [...turns.values()];
  }

  get status(): PhoneSessionStatus {
    if (this.running !== null) return 'working';
    return this.turns.at(-1)?.state === 'interrupted' ? 'blocked' : 'idle';
  }

  /** Send the person's words and run the turn to its end. A `requestId` already sent returns that turn as it stands
   *  and sends nothing, so a retried tap never asks twice. An account failure ends the turn `failed` with its words;
   *  an abort leaves it `interrupted` and rejects with the signal's reason. */
  async send(text: string, o: PhoneSendOptions = {}): Promise<PhoneTurn> {
    const rid = o.requestId ?? this.o.newId?.() ?? globalThis.crypto.randomUUID();
    const known = this.turns.find((t) => t.requestId === rid);
    if (known) return known;
    this.claim();
    try {
      await this.write({ t: 'user', rid, text, at: (this.o.now ?? Date.now)() });
      return await this.run(rid, o);
    } finally { this.running = null; }
  }

  /** Finish an interrupted turn (the person's Try again): it carries on from its last kept step. A tool the phone cut
   *  off is rerun only when `replaySafe`; otherwise the model is told it stopped and may or may not have acted. */
  async resume(requestId: string, o: Omit<PhoneSendOptions, 'requestId'> = {}): Promise<PhoneTurn> {
    const turn = this.turns.find((t) => t.requestId === requestId);
    if (!turn) throw new RangeError(`no turn ${requestId} in this session`);
    if (turn.state !== 'interrupted') return turn;
    this.claim();
    try { return await this.run(requestId, o); } finally { this.running = null; }
  }

  /** Forget the whole chat on this phone (sign-out, or "Clear chat"). */
  async clear(): Promise<void> {
    if (this.running !== null) throw new PhoneError('busy', 'a turn is running');
    await this.o.log.clear();
    this.entries = [];
  }

  private claim() {
    if (this.running !== null) throw new PhoneError('busy', 'a turn is running');
    this.running = '';
  }

  private async write(e: Entry) {
    await this.o.log.append(JSON.stringify(e));
    this.entries.push(e);
    if (e.t === 'user') this.running = e.rid;
  }

  private async row(): Promise<Account | undefined> {
    return (await this.o.accounts.list(this.o.member)).find((a) => a.id === this.o.account);
  }

  private turn(rid: string) { return this.turns.find((t) => t.requestId === rid)!; }

  private async run(rid: string, o: Omit<PhoneSendOptions, 'requestId'>): Promise<PhoneTurn> {
    this.running = rid;
    const tools = this.o.tools ?? [];
    const row = await this.row();
    if (!row || row.state === 'signed_out' || row.state === 'needs_again') return this.fail(rid, 'signed-out');
    if (row.provider !== 'chatgpt' && !this.o.model) throw new TypeError(`a model is needed for ${this.o.account}`);
    let steps = this.entries.filter((e) => e.t === 'step' && e.rid === rid).length;
    for (;;) {
      // Answer every call of the last kept step first: a resumed turn may have stopped between them.
      const last = this.entries.findLast((e) => e.rid === rid && e.t !== 'tool-start' && e.t !== 'tool-end');
      if (last?.t === 'step' && last.calls.length) {
        for (const call of last.calls) await this.answerCall(rid, call, tools, o.signal);
        if (steps >= (this.o.maxSteps ?? 8)) return this.fail(rid, 'step-limit');
      } else if (last?.t === 'step') {
        await this.write({ t: 'end', rid, text: this.turn(rid).answer });
        return this.turn(rid);
      }
      const head = this.turn(rid).answer;
      let step: { text: string; calls: Call[] };
      try {
        step = await this.ask(rid, row.provider === 'chatgpt', (piece) => o.onText?.(head ? `${head}\n\n${piece}` : piece), o.signal);
      } catch (e) {
        const code = o.signal?.aborted ? null : codeOf(e);
        if (code === null) throw o.signal?.aborted ? o.signal.reason : e;
        return this.fail(rid, code);
      }
      steps++;
      await this.write({ t: 'step', rid, ...step });
      o.onText?.(this.turn(rid).answer);
    }
  }

  private async fail(rid: string, code: PhoneErrorCode): Promise<PhoneTurn> {
    await this.write({ t: 'fail', rid, code });
    return this.turn(rid);
  }

  private async answerCall(rid: string, call: Call, tools: readonly PhoneTool[], signal?: AbortSignal) {
    const mine = this.entries.filter((e) => e.rid === rid && 'id' in e && e.id === call.id);
    if (mine.some((e) => e.t === 'tool-end')) return;
    const tool = tools.find((t) => t.name === call.name);
    if (mine.length && !tool?.replaySafe) {
      await this.write({ t: 'tool-end', rid, id: call.id, output: STOPPED, error: true });
      return;
    }
    if (!tool) {
      await this.write({ t: 'tool-end', rid, id: call.id, output: `There is no tool named ${call.name} on this phone.`, error: true });
      return;
    }
    await this.write({ t: 'tool-start', rid, id: call.id });
    let output: string, error = false;
    try { output = await tool.run(call.args, { requestId: rid, callId: call.id, signal }); }
    catch (e) {
      if (signal?.aborted) throw signal.reason;
      output = `The tool failed: ${e instanceof Error ? e.message : String(e)}`; error = true;
    }
    await this.write({ t: 'tool-end', rid, id: call.id, output, ...(error ? { error } : {}) });
  }

  /** One model call over the chat so far: earlier finished turns as words, this turn step by step. */
  private async ask(rid: string, chatgpt: boolean, onText: (piece: string) => void, signal?: AbortSignal): Promise<{ text: string; calls: Call[] }> {
    const done = new Set(this.turns.filter((t) => t.state === 'done').map((t) => t.requestId));
    const history = this.entries.filter((e) => e.rid === rid || (done.has(e.rid) && (e.t === 'user' || e.t === 'end')));
    let piece = '';
    const stream = (d: string) => { piece += d; onText(piece); };
    const tools = this.o.tools ?? [];
    if (chatgpt) {
      const input: ResponseInputItem[] = history.flatMap((e): ResponseInputItem[] =>
        e.t === 'user' ? [{ role: 'user', content: [{ type: 'input_text', text: e.text }] }]
          : e.t === 'end' ? (e.rid === rid ? [] : [{ role: 'assistant', content: e.text }])
          : e.t === 'step' ? [...(e.text ? [{ role: 'assistant' as const, content: e.text }] : []),
            ...e.calls.map((c) => ({ type: 'function_call' as const, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) }))]
          : e.t === 'tool-end' ? [{ type: 'function_call_output', call_id: e.id, output: e.output }] : []);
      const result = await this.o.accounts.respond(this.o.member, {
        instructions: this.o.instructions, input, result: true, signal, onText: stream, select: { account: this.o.account },
        ...(tools.length ? { tools: tools.map((t): ResponseTool => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) } : {}),
      }) as ResponseResult;
      return { text: result.text, calls: result.output.filter(isFunctionCall).map((c) => ({ id: c.call_id ?? c.id ?? '', name: c.name, args: parse(c.arguments) })) };
    }
    const model = this.o.model!;
    const meta = { api: model.api, provider: model.provider, model: model.id, usage: ZERO, timestamp: 0 };
    const messages = history.flatMap((e): Context['messages'] =>
      e.t === 'user' ? [{ role: 'user', content: e.text, timestamp: 0 }]
        : e.t === 'end' ? (e.rid === rid ? [] : [{ role: 'assistant', content: [{ type: 'text', text: e.text }], stopReason: 'stop', ...meta }])
        : e.t === 'step' ? [{ role: 'assistant', stopReason: e.calls.length ? 'toolUse' : 'stop', ...meta, content: [
          ...(e.text ? [{ type: 'text' as const, text: e.text }] : []),
          ...e.calls.map((c) => ({ type: 'toolCall' as const, id: c.id, name: c.name, arguments: c.args as Json }))] }]
        : e.t === 'tool-end' ? [{ role: 'toolResult', toolCallId: e.id, toolName: this.toolName(rid, e.id),
          content: [{ type: 'text', text: e.output }], isError: !!e.error, timestamp: 0 }] : []);
    const context = { systemPrompt: this.o.instructions, messages,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) } : {}) } as Context;
    const message: AssistantMessage = await this.o.accounts.respond(this.o.member, { account: this.o.account, model, context, onText: stream, options: { signal } });
    return {
      text: message.content.flatMap((p) => p.type === 'text' ? [p.text] : []).join(''),
      calls: message.content.flatMap((p) => p.type === 'toolCall' ? [{ id: p.id, name: p.name, args: p.arguments }] : []),
    };
  }

  private toolName(rid: string, id: string) {
    for (const e of this.entries) if (e.t === 'step' && e.rid === rid) for (const c of e.calls) if (c.id === id) return c.name;
    return '';
  }
}

function parse(args: string): Record<string, unknown> {
  try { const v = JSON.parse(args); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
