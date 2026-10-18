// The fail-closed tool bridge: plugin hook -> unix socket -> app gate, with parked asks and one-use permits (5.9, O5).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { words } from './words.ts';
import type { Delegations } from './delegations.ts';
import type { Approval, ChannelMessage, Decision, Member, RunRef, ToolHost, ToolSpec } from './types.ts';

/** Newline-framed JSON, one request per connection; anything larger is not a gate request. */
const FRAME_CAP = 1_000_000;

/**
 * Asks must expire before the plugin's 195 s gate timeout, or the run gets a generic block while the approval
 * lingers (N3). The kit passes its `approvalTimeoutMs` through; anything above is clamped to this.
 */
export const MAX_APPROVAL_TIMEOUT_MS = 190_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const DEFAULT_SOCKET_NAME = 'bridge.sock';
export const DEFAULT_PARAM_PREFIX = '__byokit';

/** Resolve the bridge naming options, validating explicit values; defaults keep prior behavior. */
export function resolveBridge(o?: { socketName?: string; paramPrefix?: string }): { socketName: string; paramPrefix: string } {
  const socketName = o?.socketName ?? DEFAULT_SOCKET_NAME;
  const paramPrefix = o?.paramPrefix ?? DEFAULT_PARAM_PREFIX;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.sock$/.test(socketName)) throw new Error(`invalid bridge socketName: ${socketName}`);
  if (!/^__[A-Za-z0-9]+$/.test(paramPrefix)) throw new Error(`invalid bridge paramPrefix: ${paramPrefix}`);
  return { socketName, paramPrefix };
}

/**
 * Write the bridge plugin's generated files into the engine's plugin dir: the manifest OpenClaw discovers
 * ownership from, and the tool table the shipped `plugin/index.js` registers at load. Deterministic: rewriting
 * with the same tools leaves bytes identical.
 */
export function writePlugin(
  dir: string,
  o: { id: string; tools: ToolSpec[]; paramPrefix: string; gateBuiltins: boolean; browser?: boolean; channels?: string[] },
): void {
  resolveBridge({ paramPrefix: o.paramPrefix });
  const runParam = `${o.paramPrefix}_run`;
  const permitParam = `${o.paramPrefix}_permit`;
  const manifest = {
    id: o.id,
    name: 'BYOKit bridge',
    activation: { onStartup: true },
    cliBackends: ['openai-codex'],
    contracts: { tools: o.tools.map((t) => t.name), ...(o.browser ? { agentToolResultMiddleware: ['openclaw', 'codex'] } : {}) },
    configSchema: { type: 'object', additionalProperties: false },
  };
  const table = {
    id: o.id,
    runParam,
    permitParam,
    // true: engine builtins (web_fetch, memory, ...) are gated too, not only the app's tools.
    gateBuiltins: o.gateBuiltins,
    ...(o.browser ? { browser: true } : {}),
    // The channels whose every inbound message the plugin claims for the app (5.18).
    ...(o.channels?.length ? { channels: o.channels } : {}),
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  };
  for (const [file, data] of [['openclaw.plugin.json', manifest], ['tools.json', table]] as const) {
    const text = JSON.stringify(data, null, 2) + '\n';
    const path = `${dir}/${file}`;
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text, { mode: 0o600 });
  }
}

type Permit = { permit: string; key: string; tool: string; input: string; runId?: string };
type Ticket = Omit<Permit, 'permit'>;
type Parked = {
  socket: Socket;
  timer: NodeJS.Timeout;
  approval: Approval;
  run: RunRef;
  tool: string;
  input: Record<string, unknown>;
};

export class Bridge {
  private readonly path: string;
  private readonly host?: ToolHost;
  private readonly tools: ReadonlySet<string>;
  private readonly permitted: (tool: string) => boolean;
  private readonly approvalTimeoutMs: number;
  private readonly memberOf: (ref: string) => Member | undefined;
  private readonly onAsk: (a: Approval) => void;
  private readonly onAskGone: (id: string) => void;
  private readonly beforeAgentRun?: (key: string, runId?: string) => Promise<boolean>;
  private readonly browserCapabilities?: () => readonly string[];
  private readonly onChannelMessage?: (m: ChannelMessage) => void;
  private server?: Server;
  private closing: Promise<void> = Promise.resolve();
  private readonly sockets = new Set<Socket>();
  private readonly owners = new Map<Socket, { key: string; runId?: string }>();
  private readonly delegations?: Delegations;
  private readonly runs = new Map<string, RunRef>();
  // Every live registration per session key, each with its run's subset of the app's tools (RunSpec.tools; none: all
  // of them). Runs sharing a key share the narrowest: a tool must be in every live subset.
  private readonly live = new Map<string, { tools?: ReadonlySet<string>; runId?: string }[]>();
  private readonly permits = new Map<string, Permit>();
  private readonly tickets: Ticket[] = [];
  private armed: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean; until: number } | undefined;
  private readonly parked = new Map<string, Parked>();
  private stopped = false;

  constructor(o: {
    path: string;
    delegations?: Delegations;
    host?: ToolHost;
    tools: ReadonlySet<string>; // the app's registered tool names; any other name is an engine builtin
    permitted: (tool: string) => boolean;
    approvalTimeoutMs: number;
    memberOf(ref: string): Member | undefined; // the member a session key or agent id belongs to (accounts index)
    onAsk(a: Approval): void;
    onAskGone(id: string): void;
    beforeAgentRun?: (key: string, runId?: string) => Promise<boolean>;
    browserCapabilities?: () => readonly string[];
    onChannelMessage?: (m: ChannelMessage) => void; // a turned-on channel's inbound messages (5.18)
  }) {
    this.path = o.path;
    this.delegations = o.delegations;
    this.host = o.host;
    this.tools = o.tools;
    this.permitted = o.permitted;
    this.approvalTimeoutMs = Math.min(o.approvalTimeoutMs, MAX_APPROVAL_TIMEOUT_MS);
    this.memberOf = o.memberOf;
    this.onAsk = o.onAsk;
    this.onAskGone = o.onAskGone;
    this.beforeAgentRun = o.beforeAgentRun;
    this.browserCapabilities = o.browserCapabilities;
    this.onChannelMessage = o.onChannelMessage;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.stopped = false;
    await this.closing;
    if (this.stopped || this.server) return;
    // Old listener teardown must finish before it can unlink a newly rebound Unix socket.
    rmSync(this.path, { force: true });
    const server = createServer(socket => {
      this.sockets.add(socket);
      socket.once('close', () => { this.sockets.delete(socket); this.owners.delete(socket); });
      this.serve(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    for (const [id, p] of this.parked) {
      clearTimeout(p.timer);
      this.reply(p.socket, { allow: false, reason: words('approval.expired') });
      // Parked gates end here; without this their approvals outlive the connection (N9).
      this.onAskGone(id);
    }
    this.parked.clear();
    // Tool subsets survive reconnect (B3); submission authority does not survive a lost engine transport.
    for (const entries of this.live.values()) for (const entry of entries) entry.runId = undefined;
    // Preserve already-ended refusal replies; abort outstanding calls through their close signal (N7).
    for (const socket of this.sockets) if (!socket.writableEnded) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) this.closing = new Promise<void>(resolve => server.close(() => resolve()))
      .then(() => rm(this.path, { force: true }).catch(() => {}));
  }

  revoke(key: string, runId: string): void {
    for (const entry of this.live.get(key) ?? []) if (entry.runId === runId) entry.runId = undefined;
    for (const [id, p] of this.parked) if (p.run.sessionKey === key && p.run.runId === runId) {
      clearTimeout(p.timer); this.parked.delete(id); this.onAskGone(id); p.socket.destroy();
    }
    for (const [socket, owner] of this.owners) if (owner.key === key && owner.runId === runId) socket.destroy();
    for (const [id, p] of this.permits) if (p.key === key && p.runId === runId) this.permits.delete(id);
    for (let i = this.tickets.length - 1; i >= 0; i--) if (this.tickets[i].key === key && this.tickets[i].runId === runId) this.tickets.splice(i, 1);
  }

  isRegisteredRun(key: string, runId?: string): boolean {
    return !this.stopped && typeof runId === 'string' && !!runId
      && (this.live.get(key) ?? []).some(entry => entry.runId === runId);
  }

  /** Register one run; release revokes only this exact registration, even when sessions overlap. */
  register(run: RunRef, tools?: readonly string[], runId?: string): () => void {
    this.runs.set(run.sessionKey, run);
    const entry = { ...(tools ? { tools: new Set(tools) } : {}), runId };
    const list = this.live.get(run.sessionKey);
    if (list) list.push(entry);
    else this.live.set(run.sessionKey, [entry]);
    return () => {
      const now = this.live.get(run.sessionKey);
      const at = now?.indexOf(entry) ?? -1;
      if (!now || at < 0) return;
      now.splice(at, 1);
      if (!now.length) this.unregister(run.sessionKey);
    };
  }

  unregister(sessionKey: string): void {
    this.runs.delete(sessionKey);
    this.live.delete(sessionKey);
    for (const [permit, p] of this.permits) if (p.key === sessionKey) this.permits.delete(permit);
    for (let i = this.tickets.length - 1; i >= 0; i--) if (this.tickets[i].key === sessionKey) this.tickets.splice(i, 1);
  }

  allowOnce(
    rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean },
    ms: number,
  ): void {
    this.armed = { ...rule, until: Date.now() + ms };
  }

  disallowOnce(): void {
    this.armed = undefined;
  }

  /** Resolve a parked `{ ask }` gate. Returns false when the id is not a parked ask. */
  resolveAsk(id: string, d: Decision): boolean {
    const p = this.parked.get(id);
    if (!p) return false;
    this.parked.delete(id);
    clearTimeout(p.timer);
    if (d.allow) this.admit(p.socket, p.run.sessionKey, p.tool, p.input);
    else this.reply(p.socket, { allow: false, reason: d.reason ?? words('approval.expired') });
    this.onAskGone(id);
    return true;
  }

  /**
   * Admit one call: permitted tools get a permit, the rest get a single-use ticket (N1: never both, so no
   * orphan ticket outlives the approval that created it). Builtins run inside the engine and never call back,
   * so they get neither.
   */
  private admit(socket: Socket, key: string, tool: string, input: Record<string, unknown>): void {
    if (!this.tools.has(tool)) {
      this.reply(socket, { allow: true });
      return;
    }
    if (this.permitted(tool)) {
      this.reply(socket, { allow: true, permit: this.mint(key, tool, input, this.owners.get(socket)?.runId) });
      return;
    }
    this.tickets.push({ key, tool, input: JSON.stringify(input), runId: this.owners.get(socket)?.runId });
    while (this.tickets.length > 1024) this.tickets.shift();
    this.reply(socket, { allow: true });
  }

  private mint(key: string, tool: string, input: Record<string, unknown>, runId?: string): string {
    const permit = randomBytes(16).toString('hex');
    this.permits.set(permit, { permit, key, tool, input: JSON.stringify(input), runId });
    // Single-use entries are consumed on the next call; evict the oldest if the plugin never calls back.
    while (this.permits.size > 1024) this.permits.delete(this.permits.keys().next().value!);
    return permit;
  }

  private reply(socket: Socket, message: Record<string, unknown>): void {
    try {
      socket.write(JSON.stringify(message) + '\n');
    } catch { /* the plugin is gone; the deny stands */ }
    socket.end();
  }

  private deny(socket: Socket, reason: string): void {
    this.reply(socket, { allow: false, reason });
  }

  private serve(socket: Socket): void {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      if (buffer.length > FRAME_CAP) return this.deny(socket, 'request too large');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      this.handle(socket, line);
    });
    socket.on('error', () => {});
  }

  private handle(socket: Socket, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.deny(socket, 'not a gate request');
    }
    if (!isRecord(message) || typeof message.kind !== 'string') return this.deny(socket, 'not a gate request');
    if (message.kind === 'browser-capabilities') {
      if (!this.browserCapabilities || this.stopped) return this.deny(socket, 'browser unavailable');
      try { this.reply(socket, { capabilities: this.browserCapabilities() }); }
      catch { this.deny(socket, 'browser unavailable'); }
      return;
    }
    if (message.kind === 'before-agent-run') {
      if (typeof message.key !== 'string' || !message.key || !this.beforeAgentRun) return this.deny(socket, 'run unavailable');
      void this.beforeAgentRun(message.key, typeof message.runId === 'string' ? message.runId : undefined)
        .then(allow => this.reply(socket, { allow }), () => this.deny(socket, 'run unavailable'));
      return;
    }
    if (message.kind === 'channel-message') {
      const { channel, chat, from, text } = message;
      if (!this.onChannelMessage || this.stopped || channel !== 'telegram' || typeof chat !== 'string' || !chat
        || typeof from !== 'string' || typeof text !== 'string') return this.deny(socket, 'channel unavailable');
      this.reply(socket, { ok: true });
      try { this.onChannelMessage({ chat: { channel, id: chat }, from, text }); } catch { /* the app's handler, not the engine's */ }
      return;
    }
    if (message.kind.startsWith('delegation-') && this.delegations) {
      try {
        if (message.kind === 'delegation-prepare') {
          if (typeof message.key !== 'string' || typeof message.runId !== 'string'
            || (!this.isRegisteredRun(message.key, message.runId) && !this.delegations.has(message.key, message.runId)))
            return this.deny(socket, 'unknown delegation parent');
          this.reply(socket, { tracked: this.delegations.prepare(message) });
        }
        else if (message.kind === 'delegation-receipt') { this.delegations.receipt(message); this.reply(socket, { ok: true }); }
        else if (message.kind === 'delegation-event' && isRecord(message.event)) { this.delegations.event(message.event); this.reply(socket, { ok: true }); }
        else this.deny(socket, 'invalid delegation message');
      } catch (error) { this.deny(socket, error instanceof Error ? error.message : 'delegation unavailable'); }
      return;
    }
    if (message.kind === 'gate') return void this.gate(socket, message).catch(() => this.deny(socket, 'run unavailable'));
    if (message.kind === 'call') return void this.call(socket, message).catch(() => this.reply(socket, { ok: false, reason: 'run unavailable' }));
    return this.deny(socket, 'not a gate request');
  }

  private async gate(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const key = message.key;
    const tool = message.tool;
    const input = message.input;
    if (typeof key !== 'string' || typeof tool !== 'string' || !isRecord(input)) {
      return this.deny(socket, 'not a gate request');
    }
    const runId = typeof message.runId === 'string' ? message.runId : undefined;
    this.owners.set(socket, { key, runId });
    const delegated = await this.delegations?.resolve(key, runId);
    if (this.stopped || socket.destroyed) return;
    const run = delegated?.ref ?? (!runId || this.isRegisteredRun(key, runId) ? this.runs.get(key) : undefined);
    if (run) return void this.gateRun(socket, run, tool, input, delegated?.tools);
    const armed = this.armed;
    if (
      armed && Date.now() < armed.until && key.startsWith(armed.keyPrefix) && tool === armed.tool &&
      (!armed.input || armed.input(input))
    ) {
      this.armed = undefined;
      // '' when unattributable: never a member id (B2).
      const member = this.memberOf(key) ?? '';
      const runRef: RunRef = { sessionKey: key, member };
      return void this.gateRun(socket, runRef, tool, input);
    }
    return this.deny(socket, 'unknown run');
  }

  private async gateRun(socket: Socket, run: RunRef, tool: string, input: Record<string, unknown>, subset?: readonly string[]): Promise<void> {
    if (!this.host) return this.deny(socket, "can't check this action right now");
    // An app tool outside the run's own subset never reaches the host; builtins stay with the gate.
    if (this.tools.has(tool) && ((subset && !subset.includes(tool)) || (this.live.get(run.sessionKey) ?? []).some((e) => e.tools && !e.tools.has(tool))))
      return this.deny(socket, 'this tool is not available in this run');
    let result;
    try {
      result = await this.host.gate(run, tool, input, { builtin: !this.tools.has(tool) });
    } catch {
      return this.deny(socket, "can't check this action right now");
    }
    if (this.stopped || socket.destroyed) return;
    if ('ask' in result) {
      const now = Date.now();
      const approval: Approval = {
        id: randomBytes(12).toString('base64url'),
        source: 'gate',
        member: run.member,
        sessionKey: run.sessionKey,
        tool,
        summary: result.ask.summary,
        input,
        at: now,
        expires: now + this.approvalTimeoutMs,
      };
      const parked: Parked = {
        socket,
        timer: setTimeout(() => {
          if (this.parked.delete(approval.id)) {
            this.reply(socket, { allow: false, reason: words('approval.expired') });
            this.onAskGone(approval.id);
          }
        }, this.approvalTimeoutMs),
        approval,
        run,
        tool,
        input,
      };
      parked.timer.unref?.();
      this.parked.set(approval.id, parked);
      // A dead caller (run abort, hook timeout) must not leave an approval nothing will use (N2).
      socket.once('close', () => {
        if (this.parked.delete(approval.id)) {
          clearTimeout(parked.timer);
          this.onAskGone(approval.id);
        }
      });
      this.onAsk(approval);
      return;
    }
    if (result.allow) {
      this.admit(socket, run.sessionKey, tool, input);
      return;
    }
    this.deny(socket, result.reason);
  }

  private async call(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const key = message.key;
    const tool = message.tool;
    const input = message.input;
    if (typeof key !== 'string' || typeof tool !== 'string' || !isRecord(input)) {
      return this.reply(socket, { ok: false, reason: 'not a call request' });
    }
    // Only the app's own tools run through host.call; a builtin never calls back.
    if (!this.tools.has(tool)) return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
    const runId = typeof message.runId === 'string' ? message.runId : undefined;
    this.owners.set(socket, { key, runId });
    const wanted = JSON.stringify(input);
    const permit = message.permit;
    if (typeof permit === 'string') {
      const p = this.permits.get(permit);
      if (!p || p.key !== key || p.runId !== runId || p.tool !== tool || p.input !== wanted) {
        return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
      }
      this.permits.delete(permit);
    } else {
      // Permitted tools travel by permit only. A ticket is itself proof of a gate allow for this exact
      // key + tool + input, so no run registration is needed (N10: allowOnce admits unregistered keys).
      if (this.permitted(tool)) return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
      const ticket = this.tickets.findIndex((t) => t.key === key && t.runId === runId && t.tool === tool && t.input === wanted);
      if (ticket < 0) return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
      this.tickets.splice(ticket, 1);
    }
    if (!this.host) return this.reply(socket, { ok: false, reason: "can't run this action right now" });
    const delegated = await this.delegations?.resolve(key, runId);
    if (this.stopped || socket.destroyed) return;
    const run = delegated?.ref ?? this.runs.get(key) ?? { sessionKey: key, member: this.memberOf(key) ?? '' };
    // The plugin destroys its socket when the run aborts (run abort, hook timeout); without this the host's
    // sandboxed command keeps running after the tool is gone.
    const controller = new AbortController();
    const onSocketGone = (): void => controller.abort();
    if (socket.destroyed) controller.abort();
    else {
      socket.once('close', onSocketGone);
      socket.once('error', onSocketGone);
    }
    try {
      const text = await this.host.call(run, tool, input, controller.signal);
      this.reply(socket, { ok: true, text });
    } catch (error) {
      this.reply(socket, { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'the call failed' });
    } finally {
      socket.removeListener('close', onSocketGone);
      socket.removeListener('error', onSocketGone);
    }
  }
}
