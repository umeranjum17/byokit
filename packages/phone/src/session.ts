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
  /** Set when the tool acts for the person (sends, spends, deletes): `run` waits until the session's `ask` says yes. `button`
   *  labels the person's yes ("Send the email"), `reason` says what it will do. A no reaches the model as declined. */
  approval?: { button: string; reason: string };
  run(args: Record<string, unknown>, call: { requestId: string; callId: string; signal?: AbortSignal }): Promise<string>;
};

/** `asking`: the tool waits for the person's yes or no. */
export type PhoneToolState = 'running' | 'asking' | 'done' | 'interrupted';
export type PhoneTurnState = 'running' | 'done' | 'failed' | 'interrupted';
/** One thing the person sent and what came of it. `words` says why a turn failed or was interrupted. */
export type PhoneTurn = {
  requestId: string; text: string; answer: string; state: PhoneTurnState;
  code?: PhoneErrorCode; words?: string;
  tools: { callId: string; name: string; state: PhoneToolState }[];
};
/** The session as a Home row beside Herdr panes, in the same words as Herdr's `AgentStatus`: `blocked` means a turn
 *  was cut off and waits for the person's Try again, or a tool waits for their yes or no. */
export type PhoneSessionStatus = 'idle' | 'working' | 'blocked';
/** Who answers and how it is paid for, in the catalogue's own sentence ("Uses your ChatGPT plan.", "Charged per use to
 *  your OpenRouter account, not a plan."). */
export type PhoneAccount = { id: string; name: string; billing: Billing; words: string; signedIn: boolean };

/** What the person is asked to allow: one tool call, with the words of its `approval`. */
export type PhoneApproval = { requestId: string; callId: string; tool: string; args: Record<string, unknown>; button: string; reason: string };
/** What `onChange` hands over: the turn that moved, as it now stands, and the session's status after the move. */
export type PhoneChange = { turn: PhoneTurn; status: PhoneSessionStatus };

export type PhoneSessionOptions<M extends Member> = {
  /** The app's own `Accounts`, where the person signed in on this phone. */
  accounts: Pick<Accounts<AuthHost, M>, 'list' | 'respond'>;
  member: M;
  /** The one account this session answers from (`chatgpt`, or an id from `accounts.list`). It never changes. */
  account: string;
  /** The model: an id from `accounts.models()` for ChatGPT, a `Model` for every other account. The kit never guesses one. */
  model?: Model<Api> | string;
  instructions: string;
  tools?: readonly PhoneTool[];
  /** Asks the person to allow a tool call that has an `approval`: show it (a sheet, a notification) and resolve with
   *  their answer. Required when any tool has one. The answer is kept: a turn cut off while asking asks again on Try
   *  again, a turn cut off after the answer does not. A rejection or an abort leaves the turn `interrupted`. */
  ask?(approval: PhoneApproval): Promise<boolean>;
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
  | { t: 'tool-ask'; rid: string; id: string }
  | { t: 'tool-answer'; rid: string; id: string; allow: boolean }
  | { t: 'tool-end'; rid: string; id: string; output: string; error?: boolean }
  | { t: 'end'; rid: string; text: string }
  | { t: 'fail'; rid: string; code: PhoneErrorCode };

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const DECLINED = 'The person declined to let this tool run. It did not run: do not try it again unless they ask.';
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
  private readonly listeners = new Set<(change: PhoneChange) => void>();
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
    if (!o.ask && o.tools?.some((t) => t.approval)) throw new TypeError('a tool needs approval, so the session needs an ask');
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
      } else if (e.t === 'tool-ask' || e.t === 'tool-answer') {
        const tool = turn.tools.find((x) => x.callId === e.id);
        if (tool) tool.state = e.t === 'tool-ask' ? (tool.state === 'running' ? 'asking' : tool.state) : (tool.state === 'asking' ? 'running' : tool.state);
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
    if (this.running !== null) return this.turns.find((t) => t.requestId === this.running)?.tools.some((t) => t.state === 'asking') ? 'blocked' : 'working';
    return this.turns.at(-1)?.state === 'interrupted' ? 'blocked' : 'idle';
  }

  /** Hear every move of the chat: a turn starts, a step lands, a tool starts, waits for the person's yes or no, or
   *  ends, a turn finishes, fails or is cut off. Each call carries the turn as it now stands and the session's status,
   *  enough for a Home row or a local notification. Returns the way to stop listening. A listener that throws does not
   *  stop the chat; its error is rethrown outside it. */
  onChange(fn: (change: PhoneChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
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
    } finally { this.release(rid); }
  }

  /** Finish an interrupted turn (the person's Try again): it carries on from its last kept step. A tool the phone cut
   *  off is rerun only when `replaySafe`; otherwise the model is told it stopped and may or may not have acted. */
  async resume(requestId: string, o: Omit<PhoneSendOptions, 'requestId'> = {}): Promise<PhoneTurn> {
    const turn = this.turns.find((t) => t.requestId === requestId);
    if (!turn) throw new RangeError(`no turn ${requestId} in this session`);
    if (turn.state !== 'interrupted') return turn;
    this.claim();
    try { return await this.run(requestId, o); } finally { this.release(requestId); }
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
    this.emit(e.rid);
  }

  private release(rid: string) {
    this.running = null;
    this.emit(rid);
  }

  private emit(rid: string) {
    if (!this.listeners.size) return;
    const turn = this.turns.find((t) => t.requestId === rid);
    if (!turn) return;
    const change = { turn, status: this.status };
    for (const fn of this.listeners) {
      try { fn(change); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
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
    if (row.provider === 'chatgpt' ? !this.o.model : typeof this.o.model !== 'object') throw new TypeError(`a model is needed for ${this.o.account}`);
    let steps = this.entries.filter((e) => e.t === 'step' && e.rid === rid).length;
    for (;;) {
      // Answer every call of the last kept step first: a resumed turn may have stopped between them.
      const last = this.entries.findLast((e) => e.rid === rid && e.t !== 'tool-start' && e.t !== 'tool-end' && e.t !== 'tool-ask' && e.t !== 'tool-answer');
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
    if (mine.some((e) => e.t === 'tool-start') && !tool?.replaySafe) {
      await this.write({ t: 'tool-end', rid, id: call.id, output: STOPPED, error: true });
      return;
    }
    if (!tool) {
      await this.write({ t: 'tool-end', rid, id: call.id, output: `There is no tool named ${call.name} on this phone.`, error: true });
      return;
    }
    if (tool.approval && !(await this.allowed(rid, call, tool, tool.approval, signal))) {
      await this.write({ t: 'tool-end', rid, id: call.id, output: DECLINED });
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

  /** The person's kept answer for this call, asking first when there is none. */
  private async allowed(rid: string, call: Call, tool: PhoneTool, approval: { button: string; reason: string }, signal?: AbortSignal): Promise<boolean> {
    const mine = this.entries.filter((e) => e.rid === rid && 'id' in e && e.id === call.id);
    const kept = mine.find((e) => e.t === 'tool-answer');
    if (kept?.t === 'tool-answer') return kept.allow;
    if (!mine.some((e) => e.t === 'tool-ask')) await this.write({ t: 'tool-ask', rid, id: call.id });
    if (signal?.aborted) throw signal.reason;
    const allow = await new Promise<boolean>((yes, no) => {
      signal?.addEventListener('abort', () => no(signal.reason), { once: true });
      this.o.ask!({ requestId: rid, callId: call.id, tool: tool.name, args: call.args, ...approval }).then(yes, no);
    });
    await this.write({ t: 'tool-answer', rid, id: call.id, allow });
    return allow;
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
        model: typeof this.o.model === 'string' ? this.o.model : this.o.model!.id,
        instructions: this.o.instructions, input, result: true, signal, onText: stream, select: { account: this.o.account },
        ...(tools.length ? { tools: tools.map((t): ResponseTool => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) } : {}),
      }) as ResponseResult;
      return { text: result.text, calls: result.output.filter(isFunctionCall).map((c) => ({ id: c.call_id ?? c.id ?? '', name: c.name, args: parse(c.arguments) })) };
    }
    const model = this.o.model as Model<Api>;
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
