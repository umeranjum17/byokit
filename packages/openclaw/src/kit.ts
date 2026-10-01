// The OpenClawKit facade: state, complete pass-through (D6), members, sign-in, runs, approvals, config (5.3).
// Built in O4 (and O5/O6/O8 for the delegated parts); until then every body refuses to run.
import type { SealingAdapter } from '@byokit/secrets';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from './constants.ts';
import { Approvals } from './approvals.ts';
import { Bridge } from './bridge.ts';
import { Engine } from './engine.ts';
import { gatewayTransport } from './transport.ts';
import { createMembers } from './members.ts';
import { confirmRetainedLogin as confirmLogin, migrateRetainedLogin as migrateLogin } from './migrate.ts';
import { createRuns } from './runs.ts';
import { routes as routeTable } from './routes.ts';
import { providers as engineProviders, signIn as startSignIn, signOut as engineSignOut, type SignInCtx } from './signin.ts';
import { reconcileConfig, memoryLimited as configMemoryLimited } from './config.ts';
import type {
  Approval,
  CallOptions,
  Decision,
  GatewayEventName,
  GatewayEventPayload,
  GatewayMethod,
  GatewayParams,
  GatewayResult,
  GatewayTransport,
  Hello,
  KitState,
  Member,
  Route,
  RunEnd,
  RunEvent,
  RunSpec,
  SignInOptions,
  SignInView,
  ToolHost,
  ToolSpec,
} from './types.ts';

export type KitOptions = {
  stateDir: string;
  authSeal?: SealingAdapter; // host-injected OS-keyring or host-owned-key seal; complete engine state/home at rest
  engineDir?: string; // default join(stateDir, 'openclaw', 'engine')
  npmPath?: string; // default: 'npm' found on PATH (the only env read, D13)
  enginePath?: string[]; // extra dirs appended to the engine's PATH ('/usr/bin:/bin')
  plugin?: { id?: string }; // default 'byokit'
  bridge?: { socketName?: string; paramPrefix?: string }; // defaults 'bridge.sock' / '__byokit'
  tools?: ToolSpec[]; // app tools registered by the bridge plugin; names /^[a-z][a-z0-9_]*$/, not bash or cron
  host?: ToolHost; // required when tools is non-empty
  permitted?: (tool: string) => boolean; // tools needing a one-use permit from their gate; default () => true
  gateBuiltins?: boolean; // default true: every tool call, engine builtins included, goes through host.gate (no host:
  // every call is blocked); false gates only the app's tools and lets builtins run ungated
  config?: object; // app OpenClaw config, deep-merged UNDER the invariants (5.6)
  installPolicy?: { trustedSkills: string; ownRoots: string[] }; // trusted-skills JSON path, own content roots
  callbackPort?: number; // default 1455
  approvalTimeoutMs?: number; // default 180_000
  transport?: (ctx: { port: number; token: string; identityPath: string; bridgeSock: string }) => GatewayTransport; // tests
  spawnEngine?: boolean; // default true; false skips install, doctor and spawn (layout, token, port, config, plugin
  // and bridge still happen)
  onState?: (s: KitState) => void;
  log?: (line: string) => void;
};

export type RetainedLogin = { path: string } | { record: Record<string, unknown> };

const operatorMethods = new Set<string>([
  'agent',
  'agent.identity.get',
  'agent.wait',
  'agents.create',
  'agents.delete',
  'agents.files.get',
  'agents.files.list',
  'agents.files.set',
  'agents.list',
  'agents.update',
  'agents.workspace.get',
  'agents.workspace.list',
  'approval.get',
  'approval.history',
  'approval.resolve',
  'artifacts.download',
  'artifacts.get',
  'artifacts.list',
  'assistant.media.get',
  'attach.grant',
  'attach.revoke',
  'audit.activity.list',
  'audit.list',
  'audit.run.inspect',
  'board.action',
  'board.data.read',
  'board.event',
  'board.get',
  'board.prompt.authorize',
  'board.update',
  'board.widget.appView',
  'board.widget.grant',
  'board.widget.put',
  'channels.logout',
  'channels.pairing.approve',
  'channels.pairing.dismiss',
  'channels.pairing.list',
  'channels.start',
  'channels.status',
  'channels.stop',
  'chat.abort',
  'chat.history',
  'chat.inject',
  'chat.message.get',
  'chat.metadata',
  'chat.send',
  'chat.startup',
  'chat.toolTitles',
  'commands.list',
  'config.apply',
  'config.get',
  'config.openFile',
  'config.patch',
  'config.schema',
  'config.schema.lookup',
  'config.set',
  'connect',
  'controlUi.githubPreview',
  'controlUi.sessionPreview',
  'controlUi.sessionPullRequests.subscribe',
  'conversations.list',
  'conversations.send',
  'conversations.turn',
  'conversations.turn.cancel',
  'cron.add',
  'cron.get',
  'cron.list',
  'cron.remove',
  'cron.run',
  'cron.runs',
  'cron.scratch.get',
  'cron.scratch.set',
  'cron.status',
  'cron.update',
  'desktop.launch',
  'desktop.observe',
  'device.pair.approve',
  'device.pair.list',
  'device.pair.reject',
  'device.pair.remove',
  'device.pair.rename',
  'device.pair.setupCode',
  'device.pair.setupStatus',
  'device.scopes.requestUpgrade',
  'device.scopes.waitUpgrade',
  'device.token.revoke',
  'device.token.rotate',
  'diagnostics.lanes',
  'diagnostics.stability',
  'doctor.memory.backfillDreamDiary',
  'doctor.memory.dedupeDreamDiary',
  'doctor.memory.dreamDiary',
  'doctor.memory.repairDreamingArtifacts',
  'doctor.memory.resetDreamDiary',
  'doctor.memory.resetGroundedShortTerm',
  'doctor.memory.status',
  'environments.create',
  'environments.destroy',
  'environments.list',
  'environments.status',
  'exec.approval.get',
  'exec.approval.grants.list',
  'exec.approval.grants.revoke',
  'exec.approval.list',
  'exec.approval.request',
  'exec.approval.resolve',
  'exec.approval.waitDecision',
  'exec.approvals.get',
  'exec.approvals.node.get',
  'exec.approvals.node.set',
  'exec.approvals.set',
  'fs.listDir',
  'gateway.identity.get',
  'gateway.restart.preflight',
  'gateway.restart.request',
  'gateway.suspend.prepare',
  'gateway.suspend.resume',
  'gateway.suspend.status',
  'health',
  'hooks.status',
  'last-heartbeat',
  'logs.tail',
  'mcp.app.callTool',
  'mcp.app.listResourceTemplates',
  'mcp.app.listResources',
  'mcp.app.listTools',
  'mcp.app.readResource',
  'mcp.app.updateModelContext',
  'mcp.app.view',
  'memory.search',
  'message.action',
  'migrations.memory.apply',
  'migrations.memory.plan',
  'models.authLogout',
  'models.authStatus',
  'models.list',
  'models.probe',
  'nativeHook.invoke',
  'node.describe',
  'node.invoke',
  'node.list',
  'node.pair.approve',
  'node.pair.list',
  'node.pair.reject',
  'node.pair.remove',
  'node.pending.enqueue',
  'node.rename',
  'openclaw.approval.list',
  'openclaw.changes.list',
  'openclaw.chat',
  'openclaw.chat.history',
  'openclaw.setup.activate',
  'openclaw.setup.auth.start',
  'openclaw.setup.detect',
  'openclaw.setup.prepare.start',
  'openclaw.setup.verify',
  'plugin.approval.list',
  'plugin.approval.request',
  'plugin.approval.resolve',
  'plugin.approval.waitDecision',
  'plugin.surface.refresh',
  'plugins.inspect',
  'plugins.install',
  'plugins.list',
  'plugins.refresh',
  'plugins.search',
  'plugins.sessionAction',
  'plugins.setEnabled',
  'plugins.uiDescriptors',
  'plugins.uninstall',
  'poll',
  'portal.close',
  'portal.list',
  'portal.open',
  'progressCard.get',
  'progressCard.put',
  'projects.add',
  'projects.list',
  'projects.register',
  'projects.remove',
  'projects.searchRemote',
  'push.test',
  'push.web.preferences.get',
  'push.web.preferences.set',
  'push.web.subscribe',
  'push.web.test',
  'push.web.unsubscribe',
  'push.web.vapidPublicKey',
  'question.get',
  'question.list',
  'question.request',
  'question.resolve',
  'question.waitAnswer',
  'secrets.reload',
  'secrets.resolve',
  'secrets.store.delete',
  'secrets.store.list',
  'secrets.store.set',
  'send',
  'session.discussion.info',
  'session.discussion.open',
  'session.members.add',
  'session.members.list',
  'session.members.listEvidence',
  'session.members.remove',
  'session.suggestions.add',
  'session.suggestions.list',
  'session.suggestions.resolve',
  'session.typing',
  'session.visibility.set',
  'sessions.abort',
  'sessions.assignOwner',
  'sessions.branches.list',
  'sessions.branches.switch',
  'sessions.catalog.archive',
  'sessions.catalog.continue',
  'sessions.catalog.list',
  'sessions.catalog.read',
  'sessions.catalog.startTerminal',
  'sessions.cleanup',
  'sessions.compact',
  'sessions.compaction.branch',
  'sessions.compaction.list',
  'sessions.compaction.restore',
  'sessions.companion.ask',
  'sessions.companion.reset',
  'sessions.companion.state',
  'sessions.create',
  'sessions.delete',
  'sessions.describe',
  'sessions.diff',
  'sessions.dispatch',
  'sessions.files.get',
  'sessions.files.list',
  'sessions.files.reveal',
  'sessions.files.set',
  'sessions.fork',
  'sessions.get',
  'sessions.github.publish',
  'sessions.goal.clear',
  'sessions.goal.update',
  'sessions.groups.defaults',
  'sessions.groups.delete',
  'sessions.groups.list',
  'sessions.groups.put',
  'sessions.groups.rename',
  'sessions.groups.update',
  'sessions.list',
  'sessions.messages.subscribe',
  'sessions.messages.unsubscribe',
  'sessions.move',
  'sessions.observer.visibility',
  'sessions.patch',
  'sessions.patchMany',
  'sessions.pluginPatch',
  'sessions.preview',
  'sessions.reclaim',
  'sessions.recover',
  'sessions.reset',
  'sessions.resolve',
  'sessions.rewind',
  'sessions.search',
  'sessions.send',
  'sessions.steer',
  'sessions.subscribe',
  'sessions.usage',
  'sessions.usage.logs',
  'sessions.usage.timeseries',
  'sessions.viewers.set',
  'set-heartbeats',
  'skills.curator.pin',
  'skills.curator.restore',
  'skills.curator.status',
  'skills.curator.unpin',
  'skills.detail',
  'skills.install',
  'skills.proposals.apply',
  'skills.proposals.create',
  'skills.proposals.evaluate',
  'skills.proposals.events.list',
  'skills.proposals.historyScan',
  'skills.proposals.historyStatus',
  'skills.proposals.inspect',
  'skills.proposals.list',
  'skills.proposals.quarantine',
  'skills.proposals.reject',
  'skills.proposals.requestRevision',
  'skills.proposals.revise',
  'skills.proposals.update',
  'skills.search',
  'skills.securityVerdicts',
  'skills.skillCard',
  'skills.status',
  'skills.update',
  'skills.upload.begin',
  'skills.upload.chunk',
  'skills.upload.commit',
  'status',
  'system-event',
  'system-presence',
  'system.info',
  'talk.catalog',
  'talk.client.close',
  'talk.client.create',
  'talk.client.steer',
  'talk.client.toolCall',
  'talk.client.transcript',
  'talk.config',
  'talk.mode',
  'talk.session.acknowledgeMark',
  'talk.session.appendAudio',
  'talk.session.cancelOutput',
  'talk.session.close',
  'talk.session.create',
  'talk.session.steer',
  'talk.session.submitToolResult',
  'talk.speak',
  'taskSuggestions.accept',
  'taskSuggestions.create',
  'taskSuggestions.dismiss',
  'taskSuggestions.list',
  'tasks.cancel',
  'tasks.dismiss',
  'tasks.get',
  'tasks.list',
  'tasks.retry',
  'terminal.attach',
  'terminal.close',
  'terminal.input',
  'terminal.list',
  'terminal.open',
  'terminal.resize',
  'terminal.upload',
  'tools.catalog',
  'tools.effective',
  'tools.github.authorize.cancel',
  'tools.github.authorize.poll',
  'tools.github.authorize.start',
  'tools.github.configure',
  'tools.github.status',
  'tools.invoke',
  'tts.convert',
  'tts.disable',
  'tts.enable',
  'tts.personas',
  'tts.providers',
  'tts.setPersona',
  'tts.setProvider',
  'tts.speak',
  'tts.status',
  'ui.command',
  'update.hold',
  'update.run',
  'update.status',
  'usage.cost',
  'usage.status',
  'users.linkEmail',
  'users.list',
  'users.prefs.get',
  'users.prefs.set',
  'users.self',
  'users.setAvatar',
  'users.setDisplayName',
  'users.setRole',
  'voicewake.get',
  'voicewake.routing.get',
  'voicewake.set',
  'wake',
  'web.login.start',
  'web.login.wait',
  'wizard.cancel',
  'wizard.next',
  'wizard.start',
  'wizard.status',
  'worker.desktop.launch',
  'worker.desktop.observe',
  'worktrees.branches',
  'worktrees.create',
  'worktrees.gc',
  'worktrees.list',
  'worktrees.remove',
  'worktrees.restore',
]);
const nodeMethods = new Set<string>([
  'node.event',
  'node.invoke.progress',
  'node.invoke.result',
  'node.pending.ack',
  'node.pending.drain',
  'node.pending.pull',
  'node.pluginSurface.refresh',
  'node.pluginTools.update',
  'node.runnerInventory.update',
  'node.skills.update',
  'skills.bins',
]);

export class OpenClawKit {
  private readonly engine: Engine;
  private readonly o: KitOptions;
  private current: KitState = { phase: 'stopped' };
  private transport?: GatewayTransport;
  private greeting?: Hello;
  private members?: ReturnType<typeof createMembers>;
  // One bridge and one approval surface per kit: listeners and run registrations survive reconnects (B3).
  // Only the socket itself is per-connection. Approvals always reaches the live transport through this.request().
  private readonly bridge: Bridge;
  private readonly approvalsCtl: Approvals;
  private listeners = new Set<(e: { event: string; payload?: unknown }) => void>();
  private off: (() => void)[] = [];
  private starting?: Promise<void>;
  private stopping = false;
  private failures = 0;

  constructor(o: KitOptions) {
    if (o.tools?.length && !o.host) throw new Error('host required when tools are registered');
    // The engine lowercases and alias-maps a tool name before the gate hook sees it (bash -> exec, cron ->
    // automations); a name it would rewrite reaches the gate as a builtin, so refuse it here.
    for (const t of o.tools ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(t.name) || t.name === 'bash' || t.name === 'cron') throw new Error(`invalid tool name: ${t.name}`);
    }
    this.o = o;
    this.engine = new Engine({ ...o, pluginId: o.plugin?.id ?? 'byokit', tools: o.tools ?? [],
      gateBuiltins: o.gateBuiltins !== false, spawnEngine: o.spawnEngine !== false,
      onState: (s) => this.setState(s), onExit: () => this.closed('engine exited') });
    const slot: { bridge?: Pick<Bridge, 'resolveAsk'> } = {};
    this.approvalsCtl = new Approvals({
      request: (method, params, co) => this.request()(method, params, co),
      bridge: { resolveAsk: (id, d) => slot.bridge?.resolveAsk(id, d) ?? false },
    });
    this.bridge = new Bridge({ path: this.engine.bridgeSock, host: o.host, tools: new Set((o.tools ?? []).map((t) => t.name)),
      permitted: o.permitted ?? (() => true), approvalTimeoutMs: o.approvalTimeoutMs ?? 180_000,
      onAsk: (a) => this.approvalsCtl.add(a), onAskGone: (id) => this.approvalsCtl.remove(id) });
    slot.bridge = this.bridge;
  }

  private setState(s: KitState): void { this.current = s; this.o.onState?.(s); }
  get state(): KitState { return this.current; }
  prepare(): Promise<void> { return this.engine.prepare(); }

  start(): Promise<void> {
    if (this.current.phase === 'ready') return Promise.resolve();
    if (this.starting) return this.starting;
    this.stopping = false;
    const task = this.connect();
    this.starting = task;
    void task.finally(() => { if (this.starting === task) this.starting = undefined; }).catch(() => {});
    return task;
  }

  private async connect(): Promise<void> {
    let transport: GatewayTransport | undefined;
    try {
      const ctx = await this.engine.start();
      if (!ctx || this.stopping) return;
      this.setState({ phase: 'starting' });
      transport = (this.o.transport ?? gatewayTransport)({ ...ctx, bridgeSock: this.engine.bridgeSock });
      this.transport = transport;
      this.off = [transport.onEvent((e) => { for (const fn of this.listeners) fn(e); }), transport.onClose((why) => this.closed(why))];
      const hello = await Promise.race([transport.start(), delay(90_000, undefined, { ref: false }).then(() => { throw new Error('gateway handshake timed out'); })]);
      if (this.stopping || this.transport !== transport) return;
      if (hello.protocol !== PROTOCOL_VERSION) {
        this.setState({ phase: 'needs-update', why: 'version' });
        throw new Error(`gateway protocol ${hello.protocol} != ${PROTOCOL_VERSION}`);
      }
      this.greeting = hello;
      for (const name of operatorMethods) if (!hello.methods.includes(name)) this.o.log?.(`gateway missing generated method: ${name}`);
      for (const name of hello.methods) if (!operatorMethods.has(name) && !nodeMethods.has(name)) this.o.log?.(`gateway has unknown method: ${name}`);
      this.members = createMembers({ request: transport.request.bind(transport), root: this.engine.root });
      // The fail-closed tool bridge feeds the kit's single Approval surface (5.9, O5).
      await this.bridge.start();
      this.off.push(transport.onEvent((e) => this.approvalsCtl.handleEvent(e)));
      this.failures = 0;
      this.setState({ phase: 'ready' });
      // Replays the engine's native approval lists over the now-live transport (N9).
      await this.approvalsCtl.resync();
    } catch (error) {
      const needsUpdate = this.current.phase === 'needs-update';
      if (transport && this.transport === transport) await this.disconnect();
      await this.engine.stop();
      if (error instanceof Error && 'code' in error && error.code === 'engine-already-running') {
        this.setState({ phase: 'failed', why: 'engine-already-running' });
        throw error;
      }
      if (needsUpdate) this.setState({ phase: 'needs-update', why: 'version' });
      if (!needsUpdate && !this.stopping) this.setState({ phase: 'failed', why: 'handshake' });
      throw error;
    }
  }

  private async disconnect(): Promise<void> {
    this.off.splice(0).forEach((fn) => fn());
    const transport = this.transport;
    this.transport = undefined; this.greeting = undefined; this.members = undefined;
    this.bridge.stop();
    await transport?.stop();
  }

  private closed(_why: string): void {
    const engineFailed = _why === 'engine exited' && this.current.phase === 'failed' && this.current.why === 'exited';
    if (this.stopping || (this.current.phase !== 'ready' && !engineFailed)) return;
    void this.disconnect();
    if (this.o.spawnEngine === false) { this.setState({ phase: 'failed', why: 'handshake' }); return; }
    const retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** this.failures++);
    this.setState({ phase: 'restarting', retryAt });
    void delay(retryAt - Date.now()).then(() => { if (!this.stopping && this.current.phase === 'restarting') void this.start().catch(() => {}); });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.disconnect();
    await this.engine.stop();
  }

  private request(): GatewayTransport['request'] {
    if (!this.transport || this.current.phase !== 'ready') throw new Error('gateway not ready');
    return this.transport.request.bind(this.transport);
  }
  call<M extends GatewayMethod>(method: M, params: GatewayParams<M>, o?: CallOptions): Promise<GatewayResult<M>> {
    try { return this.request()(method, params, o) as Promise<GatewayResult<M>>; } catch (error) { return Promise.reject(error); }
  }
  callDynamic(method: string, params?: unknown, o?: CallOptions): Promise<unknown> {
    if (operatorMethods.has(method) || nodeMethods.has(method)) return Promise.reject(new Error(`use typed call for generated method: ${method}`));
    try { return this.request()(method, params, o); } catch (error) { return Promise.reject(error); }
  }
  get hello(): Hello | undefined { return this.greeting; }
  onEvent<E extends GatewayEventName>(event: E | '*', fn: (payload: GatewayEventPayload<E>, event: E) => void): () => void {
    const listener = (e: { event: string; payload?: unknown }) => {
      if (event === '*' || e.event === event) fn(e.payload as GatewayEventPayload<E>, e.event as E);
    };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  ensureMember(member: Member): Promise<{ agentId: string; workspace: string }> {
    if (!this.members) return Promise.reject(new Error('gateway not ready'));
    return this.members.ensure(member);
  }

  // sign-in (5.7): every body here is the module's, with this kit's transport, members and ports.
  private signInCtx(): SignInCtx {
    return { request: (method, params, o) => this.request()(method, params, o),
      ensure: (member) => this.ensureMember(member), callbackPort: this.o.callbackPort ?? 1455 };
  }

  routes(): Route[] {
    return routeTable();
  }

  providers(member: Member): Promise<string[]> {
    return engineProviders(this.signInCtx(), member);
  }

  signedIn(member: Member, provider: string): Promise<boolean> {
    return engineProviders(this.signInCtx(), member).then((names) => names.includes(provider)).catch(() => false);
  }

  signIn(
    member: Member,
    o: SignInOptions,
    on: (v: SignInView) => void,
  ): { paste(text: string): void; cancel(): void; done: Promise<SignInView> } {
    return startSignIn(this.signInCtx(), member, o, on);
  }

  signOut(member: Member, provider: string): Promise<void> {
    return engineSignOut(this.signInCtx(), member, provider);
  }

  migrateRetainedLogin(member: Member, source: RetainedLogin): Promise<'staged' | 'nothing' | 'failed'> {
    return migrateLogin({ root: this.engine.root, prepare: () => this.prepare(), doctor: () => this.engine.doctor(120_000),
      seal: this.o.authSeal, log: this.o.log, withStore: (task) => this.engine.withAuthStore(task) }, member, source);
  }

  confirmRetainedLogin(member: Member, source: RetainedLogin): Promise<boolean> {
    return confirmLogin({ ...this.signInCtx(), seal: this.o.authSeal, log: this.o.log }, member, source);
  }

  // runs (5.8): the facade owns no run state; every call delegates to the O8 module
  // with this kit's live transport, member table and bridge (firstmate clearance, O9).
  private runs(): ReturnType<typeof createRuns> {
    return createRuns({
      request: (method, params, o) => this.request()(method, params, o),
      onEvent: (fn) => {
        this.listeners.add(fn);
        return () => {
          this.listeners.delete(fn);
        };
      },
      ensure: (member) => this.ensureMember(member),
      bridge: this.bridge,
      tools: new Set(this.toolNames()),
    });
  }

  /** The app tool names (`KitOptions.tools`): the only names `RunSpec.tools` may carry. */
  toolNames(): string[] {
    return (this.o.tools ?? []).map((t) => t.name);
  }

  run(spec: RunSpec, on?: (e: RunEvent) => void): Promise<RunEnd> {
    return this.runs().run(spec, on);
  }

  steer(sessionKey: string, text: string): Promise<void> {
    return this.runs().steer(sessionKey, text);
  }

  abort(sessionKey: string): Promise<void> {
    return this.runs().abort(sessionKey);
  }

  // approvals (5.9)
  approvals(member?: Member): Approval[] {
    return this.approvalsCtl.list(member);
  }

  onApproval(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void {
    return this.approvalsCtl.on(fn);
  }

  decide(id: string, d: Decision): Promise<void> {
    return this.approvalsCtl.decide(id, d);
  }

  allowOnce(
    rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean },
    ms: number,
  ): void {
    this.bridge.allowOnce(rule, ms);
  }

  disallowOnce(): void {
    this.bridge.disallowOnce();
  }

  // config
  async patchConfig(patch: object, o?: { agentId?: string }): Promise<void> {
    const response = await this.request()('config.get') as { hash: string; config?: object };
    const safe = reconcileConfig(response.config, { root: this.engine.root, stateDir: this.o.stateDir,
      port: Number(readFileSync(join(this.engine.root, 'port'), 'utf8')), pluginId: this.o.plugin?.id ?? 'byokit',
      pluginDir: join(this.engine.root, 'plugin'), policyPath: fileURLToPath(new URL('../policy/policy.mjs', import.meta.url)), app: patch,
      installPolicy: this.o.installPolicy });
    await this.request()('config.patch', { raw: JSON.stringify(safe), baseHash: response.hash, ...(o?.agentId ? { agentId: o.agentId } : {}) });
  }

  memoryLimited(member: Member): boolean {
    const config = JSON.parse(readFileSync(join(this.engine.root, 'openclaw.json'), 'utf8')) as object;
    return configMemoryLimited(config, member);
  }

  doctorContext(): { entry: string; env: Record<string, string> } { return this.engine.doctorContext(); }
}
