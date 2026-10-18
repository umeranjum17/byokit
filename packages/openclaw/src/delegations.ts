// Native receipts, never session-prefix authority. Persist identity/tool policy only, not prompts or credentials.
import { existsSync, readFileSync } from 'node:fs';
import { atomic } from './engine-patches.ts';
import type { DelegatedEvent, DelegatedRun, GatewayTransport, RunRef } from './types.ts';

type Grant = { ref: DelegatedRun; tools: string[]; delegates: Record<string, string[]>; sourceKey: string };
type Pending = { parent: Grant; agent: string; key?: string; expires: number };
type Root = Omit<Grant, 'ref'> & { ref: RunRef & { runId: string; root: { sessionKey: string; runId: string } } };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const agentOf = (key: string) => /^agent:([^:]+):.+/.exec(key)?.[1];
const actionKey = (m: Record<string, any>) => JSON.stringify([m.key, m.runId, m.callId]);

export class Delegations {
  private loaded = false;
  private roots = new Map<string, Root>();
  private children = new Map<string, Grant>();
  private pending = new Map<string, Pending>();
  private changed = new Set<() => void>();
  private early = new Map<string, Record<string, any>[]>();
  constructor(privateOptions: {
    file: string; tools: ReadonlySet<string>; memberOf(agent: string): string | undefined;
    request: GatewayTransport['request']; emit(e: DelegatedEvent): void; revoke(key: string, runId: string): void;
  }) { this.o = privateOptions; }
  private readonly o;

  private load(): void {
    if (this.loaded) return;
    if (existsSync(this.o.file)) {
      const saved = JSON.parse(readFileSync(this.o.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.children) || !Array.isArray(saved.pending)) throw new Error('invalid delegated run journal');
      this.children = new Map(saved.children);
      this.pending = new Map(saved.pending);
    }
    this.loaded = true;
  }
  private save(): void {
    for (const [key, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(key);
    const bytes = JSON.stringify({ version: 1, children: [...this.children], pending: [...this.pending] });
    atomic(this.o.file, bytes);
    for (const notify of this.changed) notify();
  }
  validate(delegates: Record<string, string[]>): void {
    if (!object(delegates) || Object.keys(delegates).length > 64) throw new Error('invalid delegates');
    for (const [agent, tools] of Object.entries(delegates)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent) || !this.o.memberOf(agent) || !Array.isArray(tools)
        || tools.some(t => !this.o.tools.has(t))) throw new Error(`invalid delegate: ${agent}`);
    }
  }
  register(ref: RunRef, runId: string, tools: readonly string[] | undefined, delegates: Record<string, string[]>, sourceKey = ref.sessionKey): () => void {
    this.load(); this.validate(delegates);
    const root: Root = { ref: { ...ref, runId, root: { sessionKey: ref.sessionKey, runId } },
      tools: [...tools ?? this.o.tools], delegates: structuredClone(delegates), sourceKey };
    this.roots.set(runId, root);
    return () => { if (this.roots.get(runId) === root) this.roots.delete(runId); };
  }
  list(): DelegatedRun[] { this.load(); return [...this.children.values()].map(g => structuredClone(g.ref)); }
  has(key: string, runId: string): boolean {
    this.load(); return (this.roots.get(runId) ?? this.children.get(runId))?.ref.sessionKey === key;
  }
  prepare(m: Record<string, any>): boolean {
    this.load();
    const parent = this.roots.get(m.runId) ?? this.children.get(m.runId);
    if (!parent || parent.ref.sessionKey !== m.key) return false;
    if (typeof m.callId !== 'string' || !m.callId || !object(m.input)) throw new Error('delegation identity unavailable');
    const send = m.tool === 'sessions_send';
    if (!send && m.tool !== 'sessions_spawn') throw new Error('unsupported delegation tool');
    const agent = send ? typeof m.input.sessionKey === 'string' && agentOf(m.input.sessionKey) : m.input.agentId;
    if (typeof agent !== 'string' || !Object.hasOwn(parent.delegates, agent)
      || (send && (m.input.timeoutSeconds !== 0 || m.input.label !== undefined))
      || (!send && m.input.runtime !== undefined && m.input.runtime !== 'subagent')) throw new Error('delegation target or mode refused');
    for (const [id, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(id);
    if (this.pending.size + this.children.size >= 1024) throw new Error('delegated run journal is full');
    this.pending.set(actionKey(m), { parent: structuredClone(parent) as Grant, agent,
      ...(send ? { key: m.input.sessionKey } : {}), expires: Date.now() + 60_000 });
    this.save(); return true;
  }
  receipt(m: Record<string, any>): void {
    this.load();
    const id = actionKey(m), p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const d = m.result?.details;
    const key = d?.childSessionKey ?? d?.sessionKey;
    if (p.expires < Date.now() || !object(d) || !['accepted', 'ok', 'queued'].includes(d.status)
      || typeof d.runId !== 'string' || !d.runId || typeof key !== 'string' || agentOf(key) !== p.agent
      || (p.key !== undefined && p.key !== key)) { this.save(); return; }
    const member = this.o.memberOf(p.agent);
    if (!member) { this.save(); return; }
    const ref: DelegatedRun = { sessionKey: key, member, runId: d.runId, agentId: p.agent,
      parent: { sessionKey: p.parent.ref.sessionKey, runId: p.parent.ref.runId }, root: p.parent.ref.root };
    const grant = { ref, delegates: p.parent.delegates, sourceKey: p.parent.sourceKey,
      tools: p.parent.tools.filter(t => p.parent.delegates[p.agent]!.includes(t)) };
    // A steered/already-admitted run keeps its original parent and cannot acquire a broader grant.
    if (this.children.has(ref.runId)) { this.save(); return; }
    this.children.set(ref.runId, grant); this.save();
    this.o.emit({ type: 'admitted', run: structuredClone(ref) });
    for (const event of this.early.get(ref.runId) ?? []) this.event(event);
    this.early.delete(ref.runId);
  }
  async resolve(key: string, runId?: string): Promise<Grant | undefined> {
    this.load();
    if (!runId) return undefined;
    const get = () => { const g = this.children.get(runId); return g?.ref.sessionKey === key ? g : undefined; };
    if (!get() && [...this.pending.values()].some(p => p.expires > Date.now())) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.changed.delete(check); resolve(); };
        const check = () => { if (get() || !this.pending.size) done(); };
        const timer = setTimeout(done, 5_000); this.changed.add(check); check();
      });
    }
    return get();
  }
  event(event: Record<string, any>): void {
    this.load();
    const grant = this.children.get(event.runId);
    if (!grant) {
      if (this.pending.size && typeof event.runId === 'string' && this.early.size < 64) {
        const events = this.early.get(event.runId) ?? []; if (events.length < 32) events.push(event);
        this.early.set(event.runId, events);
      }
      return;
    }
    if (event.sessionKey !== grant.ref.sessionKey) return;
    this.o.emit({ type: 'event', run: structuredClone(grant.ref), event: { stream: event.stream, data: event.data } });
    if (event.stream === 'lifecycle' && ['end', 'error'].includes(event.data?.phase)) this.end(grant);
  }
  private end(grant: Grant): void {
    this.children.delete(grant.ref.runId); this.save();
    this.o.revoke(grant.ref.sessionKey, grant.ref.runId);
    this.o.emit({ type: 'ended', run: structuredClone(grant.ref), reason: 'terminal' });
  }
  async reconcile(): Promise<void> {
    for (const ref of this.list()) {
      const end = await this.o.request('agent.wait', { runId: ref.runId, timeoutMs: 1 }) as { status?: string };
      const grant = this.children.get(ref.runId);
      if (grant && ['ok', 'error'].includes(end.status ?? '')) this.end(grant);
    }
  }
  async abort(key: string): Promise<void> {
    this.load();
    const ids = new Set<string>();
    for (const g of [...this.roots.values(), ...this.children.values()])
      if (g.ref.sessionKey === key || g.ref.parent?.sessionKey === key || g.ref.root.sessionKey === key || g.sourceKey === key) ids.add(g.ref.runId);
    for (;;) {
      const size = ids.size;
      for (const g of this.children.values()) if (ids.has(g.ref.parent.runId)) ids.add(g.ref.runId);
      if (ids.size === size) break;
    }
    let removed = false;
    for (const [id, p] of this.pending) if (ids.has(p.parent.ref.runId) || p.parent.ref.sessionKey === key || p.parent.ref.root.sessionKey === key || p.parent.sourceKey === key) { this.pending.delete(id); removed = true; }
    if (!ids.size && !removed) return;
    const cancelled = [...this.children.values()].filter(g => ids.has(g.ref.runId));
    const revoked = [...this.roots.values(), ...cancelled].filter(g => ids.has(g.ref.runId));
    for (const id of ids) this.roots.delete(id);
    for (const g of cancelled) this.children.delete(g.ref.runId);
    this.save(); // revoke durably before any awaited transport call
    for (const g of revoked) this.o.revoke(g.ref.sessionKey, g.ref.runId);
    for (const g of cancelled) this.o.emit({ type: 'ended', run: structuredClone(g.ref), reason: 'cancelled' });
    await Promise.all(cancelled.map(g => this.o.request('chat.abort', { sessionKey: g.ref.sessionKey, runId: g.ref.runId })));
  }
}
