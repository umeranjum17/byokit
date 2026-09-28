// The kit facade (docs/runtime-kits.md 6.2). H1 freezes the surface; H3 builds start/stop and the connection,
// H4 the CLI runner and terminal stream, H5 the agent, close and approval helpers.

import type {
  AgentRef, AgentStatus, BlockedAgent, HerdrEvent, HerdrEventName, HerdrEventOf, HerdrKitOptions, HerdrMethod,
  HerdrParams, HerdrResult, HerdrSnapshot, HerdrState, HerdrSubscription, PromptReceipt, StartAgent, TerminalSession,
} from './types.ts';

const todo = (what: string): never => { throw new Error(`@byokit/herdr: ${what} is not built yet (docs/runtime-kits.md §11.3).`); };

export class HerdrKit {
  private readonly o: HerdrKitOptions;

  constructor(o: HerdrKitOptions) { this.o = o; }

  get state(): HerdrState { return { phase: 'stopped' }; }

  start(): Promise<void> { return todo('start (H3)'); }
  stop(): Promise<void> { return todo('stop (H3)'); }

  // complete pass-through (D7)
  call<M extends HerdrMethod>(method: M, params: HerdrParams<M>, o?: { timeoutMs?: number }): Promise<HerdrResult<M>> {
    return todo('call (H3)');
  }
  subscribe<E extends HerdrEventName>(subs: HerdrSubscription<E>[], on: (e: HerdrEventOf<E>) => void): () => void {
    return todo('subscribe (H3)');
  }
  cli(args: string[], o?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    return todo('cli (H4)');
  }
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession {
    return todo('terminal (H4)');
  }

  // live tree
  snapshot(): HerdrSnapshot { return todo('snapshot (H3)'); }
  onChange(fn: (s: HerdrSnapshot) => void): () => void { return todo('onChange (H3)'); }

  // helpers
  startAgent(o: StartAgent): Promise<AgentRef> { return todo('startAgent (H5)'); }
  prompt(target: AgentRef, text: string, o?: { wait?: { until?: AgentStatus[]; timeoutMs: number } }): Promise<PromptReceipt> {
    return todo('prompt (H5)');
  }
  sendKeys(target: AgentRef, keys: string[]): Promise<void> { return todo('sendKeys (H5)'); }
  wait(target: AgentRef, o: { until?: AgentStatus[]; timeoutMs: number }): Promise<AgentStatus> { return todo('wait (H5)'); }
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number; ansi?: boolean }):
    Promise<{ text: string; truncated: boolean }> { return todo('read (H5)'); }
  blocked(): BlockedAgent[] { return todo('blocked (H5)'); }
  onBlocked(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void { return todo('onBlocked (H5)'); }
  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> { return todo('answer (H5)'); }
  closePane(paneId: string): Promise<void> { return todo('closePane (H5)'); }
  closeTab(tabId: string): Promise<void> { return todo('closeTab (H5)'); }
  closeWorkspace(workspaceId: string): Promise<void> { return todo('closeWorkspace (H5)'); }
  agentKinds(): Promise<string[]> { return todo('agentKinds (H5)'); }
  installedAgentKinds(kinds: readonly string[], o: { path: string[] }): string[] { return todo('installedAgentKinds (H5)'); }
}
