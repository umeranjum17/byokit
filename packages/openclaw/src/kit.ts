// The OpenClawKit facade: state, complete pass-through (D6), members, sign-in, runs, approvals, config (5.3).
// Built in O4 (and O5/O6/O8 for the delegated parts); until then every body refuses to run.
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
  SignInView,
  ToolHost,
  ToolSpec,
} from './types.ts';

export type KitOptions = {
  stateDir: string;
  engineDir?: string; // default join(stateDir, 'openclaw', 'engine')
  npmPath?: string; // default: 'npm' found on PATH (the only env read, D13)
  enginePath?: string[]; // extra dirs appended to the engine's PATH ('/usr/bin:/bin')
  plugin?: { id?: string }; // default 'byokit'; Crewhouse passes 'crewhouse'
  tools?: ToolSpec[]; // app tools registered by the bridge plugin
  host?: ToolHost; // required when tools is non-empty
  permitted?: (tool: string) => boolean; // tools needing a one-use permit from their gate; default () => true
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

export class OpenClawKit {
  constructor(_o: KitOptions) {
    throw new Error('not built: O4');
  }

  get state(): KitState {
    throw new Error('not built: O4');
  }

  prepare(): Promise<void> {
    throw new Error('not built: O4');
  }

  start(): Promise<void> {
    throw new Error('not built: O4');
  }

  stop(): Promise<void> {
    throw new Error('not built: O4');
  }

  // complete pass-through (D6)
  call<M extends GatewayMethod>(_method: M, _params: GatewayParams<M>, _o?: CallOptions): Promise<GatewayResult<M>> {
    throw new Error('not built: O4');
  }

  callDynamic(_method: string, _params?: unknown, _o?: CallOptions): Promise<unknown> {
    throw new Error('not built: O4');
  }

  get hello(): Hello | undefined {
    throw new Error('not built: O4');
  }

  onEvent<E extends GatewayEventName>(
    _event: E | '*',
    _fn: (payload: GatewayEventPayload<E>, event: E) => void,
  ): () => void {
    throw new Error('not built: O4');
  }

  // members
  ensureMember(_member: Member): Promise<{ agentId: string; workspace: string }> {
    throw new Error('not built: O4');
  }

  // sign-in (5.7)
  routes(): Route[] {
    throw new Error('not built: O6');
  }

  providers(_member: Member): Promise<string[]> {
    throw new Error('not built: O6');
  }

  signedIn(_member: Member, _provider: string): Promise<boolean> {
    throw new Error('not built: O6');
  }

  signIn(
    _member: Member,
    _o: { authChoice: string; via?: 'browser' | 'code' },
    _on: (v: SignInView) => void,
  ): { paste(text: string): void; cancel(): void; done: Promise<SignInView> } {
    throw new Error('not built: O6');
  }

  signOut(_member: Member, _provider: string): Promise<void> {
    throw new Error('not built: O6');
  }

  migrateRetainedLogin(_member: Member, _source: RetainedLogin): Promise<'staged' | 'nothing' | 'failed'> {
    throw new Error('not built: O6');
  }

  confirmRetainedLogin(_member: Member, _source: RetainedLogin): Promise<boolean> {
    throw new Error('not built: O6');
  }

  // runs (5.8)
  run(_spec: RunSpec, _on?: (e: RunEvent) => void): Promise<RunEnd> {
    throw new Error('not built: O8');
  }

  steer(_sessionKey: string, _text: string): Promise<void> {
    throw new Error('not built: O8');
  }

  abort(_sessionKey: string): Promise<void> {
    throw new Error('not built: O8');
  }

  // approvals (5.9)
  approvals(_member?: Member): Approval[] {
    throw new Error('not built: O5');
  }

  onApproval(_fn: (a: Approval, change: 'added' | 'resolved') => void): () => void {
    throw new Error('not built: O5');
  }

  decide(_id: string, _d: Decision): Promise<void> {
    throw new Error('not built: O5');
  }

  allowOnce(
    _rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean },
    _ms: number,
  ): void {
    throw new Error('not built: O5');
  }

  disallowOnce(): void {
    throw new Error('not built: O5');
  }

  // config
  patchConfig(_patch: object, _o?: { agentId?: string }): Promise<void> {
    throw new Error('not built: O4');
  }

  memoryLimited(_member: Member): boolean {
    throw new Error('not built: O4');
  }

  doctorContext(): { entry: string; env: Record<string, string> } {
    throw new Error('not built: O4');
  }
}
