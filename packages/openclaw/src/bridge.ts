// The fail-closed tool bridge: plugin hook -> unix socket -> app gate, with parked asks and one-use permits (5.9, O5).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { words } from './words.ts';
import type { Approval, Decision, Member, RunRef, ToolHost, ToolSpec } from './types.ts';

/** Newline-framed JSON, one request per connection; anything larger is not a gate request. */
const FRAME_CAP = 1_000_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const memberOfKey = (key: string): Member | undefined => {
  const m = /^agent:([a-z][a-z0-9-]{0,31}):/.exec(key);
  return m?.[1];
};

/**
 * Write the bridge plugin's generated files into the engine's plugin dir: the manifest OpenClaw discovers
 * ownership from, and the tool table the shipped `plugin/index.js` registers at load. Deterministic: rewriting
 * with the same tools leaves bytes identical.
 */
export function writePlugin(
  dir: string,
  o: { id: string; tools: ToolSpec[]; paramPrefix: '__byokit' | '__crewhouse' },
): void {
  const runParam = `${o.paramPrefix}_run`;
  const permitParam = `${o.paramPrefix}_permit`;
  const manifest = {
    id: o.id,
    name: 'BYOKit bridge',
    activation: { onStartup: true },
    contracts: { tools: o.tools.map((t) => t.name) },
    configSchema: { type: 'object', additionalProperties: false },
  };
  const table = {
    id: o.id,
    runParam,
    permitParam,
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  };
  for (const [file, data] of [['openclaw.plugin.json', manifest], ['tools.json', table]] as const) {
    const text = JSON.stringify(data, null, 2) + '\n';
    const path = `${dir}/${file}`;
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text, { mode: 0o600 });
  }
}

type Permit = { permit: string; key: string; tool: string; input: string };
type Ticket = { key: string; tool: string; input: string };
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
  private readonly permitted: (tool: string) => boolean;
  private readonly approvalTimeoutMs: number;
  private readonly onAsk: (a: Approval) => void;
  private readonly onAskGone: (id: string) => void;
  private server?: Server;
  private readonly runs = new Map<string, RunRef>();
  private readonly permits = new Map<string, Permit>();
  private readonly tickets: Ticket[] = [];
  private armed: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean; until: number } | undefined;
  private readonly parked = new Map<string, Parked>();
  private stopped = false;

  constructor(o: {
    path: string;
    host?: ToolHost;
    permitted: (tool: string) => boolean;
    approvalTimeoutMs: number;
    onAsk(a: Approval): void;
    onAskGone(id: string): void;
  }) {
    this.path = o.path;
    this.host = o.host;
    this.permitted = o.permitted;
    this.approvalTimeoutMs = o.approvalTimeoutMs;
    this.onAsk = o.onAsk;
    this.onAskGone = o.onAskGone;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.stopped = false;
    // A stale socket file from a crashed run is not a listener; a live one survives unlinking.
    rmSync(this.path, { force: true });
    this.server = createServer((socket) => this.serve(socket));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.path, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    for (const [, p] of this.parked) {
      clearTimeout(p.timer);
      this.reply(p.socket, { allow: false, reason: words('approval.expired') });
    }
    this.parked.clear();
    this.server?.close();
    this.server = undefined;
    void rm(this.path, { force: true }).catch(() => {});
  }

  register(run: RunRef): void {
    this.runs.set(run.sessionKey, run);
  }

  unregister(sessionKey: string): void {
    this.runs.delete(sessionKey);
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
    if (d.allow) {
      const permit = this.mint(p.run.sessionKey, p.tool, p.input);
      this.reply(p.socket, { allow: true, permit });
    } else {
      this.reply(p.socket, { allow: false, reason: d.reason ?? words('approval.expired') });
    }
    this.onAskGone(id);
    return true;
  }

  private mint(key: string, tool: string, input: Record<string, unknown>): string {
    const permit = randomBytes(16).toString('hex');
    this.permits.set(permit, { permit, key, tool, input: JSON.stringify(input) });
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
    if (message.kind === 'gate') return void this.gate(socket, message);
    if (message.kind === 'call') return void this.call(socket, message);
    return this.deny(socket, 'not a gate request');
  }

  private gate(socket: Socket, message: Record<string, unknown>): void {
    const key = message.key;
    const tool = message.tool;
    const input = message.input;
    if (typeof key !== 'string' || typeof tool !== 'string' || !isRecord(input)) {
      return this.deny(socket, 'not a gate request');
    }
    const run = this.runs.get(key);
    if (run) return void this.gateRun(socket, run, tool, input);
    const armed = this.armed;
    if (
      armed && Date.now() < armed.until && key.startsWith(armed.keyPrefix) && tool === armed.tool &&
      (!armed.input || armed.input(input))
    ) {
      this.armed = undefined;
      const member = memberOfKey(key) ?? 'unknown';
      const runRef: RunRef = { sessionKey: key, member };
      return void this.gateRun(socket, runRef, tool, input);
    }
    return this.deny(socket, 'unknown run');
  }

  private async gateRun(socket: Socket, run: RunRef, tool: string, input: Record<string, unknown>): Promise<void> {
    if (!this.host) return this.deny(socket, "can't check this action right now");
    let result;
    try {
      result = await this.host.gate(run, tool, input);
    } catch {
      return this.deny(socket, "can't check this action right now");
    }
    if (this.stopped) return;
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
      this.onAsk(approval);
      return;
    }
    if (result.allow) {
      const permit = this.mint(run.sessionKey, tool, input);
      if (!this.permitted(tool)) {
        this.tickets.push({ key: run.sessionKey, tool, input: JSON.stringify(input) });
        while (this.tickets.length > 1024) this.tickets.shift();
      }
      this.reply(socket, { allow: true, permit });
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
    const wanted = JSON.stringify(input);
    const permit = message.permit;
    if (typeof permit === 'string') {
      const p = this.permits.get(permit);
      if (!p || p.key !== key || p.tool !== tool || p.input !== wanted) {
        return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
      }
      this.permits.delete(permit);
    } else {
      const run = this.runs.get(key);
      if (!run || this.permitted(tool)) {
        return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
      }
      const ticket = this.tickets.findIndex((t) => t.key === key && t.tool === tool && t.input === wanted);
      if (ticket < 0) return this.reply(socket, { ok: false, reason: 'this call was not allowed' });
      this.tickets.splice(ticket, 1);
    }
    if (!this.host) return this.reply(socket, { ok: false, reason: "can't run this action right now" });
    const run = this.runs.get(key) ?? { sessionKey: key, member: memberOfKey(key) ?? 'unknown' };
    try {
      const controller = new AbortController();
      const text = await this.host.call(run, tool, input, controller.signal);
      this.reply(socket, { ok: true, text });
    } catch (error) {
      this.reply(socket, { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'the call failed' });
    }
  }
}
