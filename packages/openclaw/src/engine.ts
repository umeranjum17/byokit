// Engine supervision: install, spawn, handshake, crash repair, isolated env (5.4, 5.5). Built in O3.
import type { KitOptions } from './kit.ts';
import type { KitState, ToolSpec } from './types.ts';

export type EngineOptions = Pick<
  KitOptions,
  'stateDir' | 'engineDir' | 'npmPath' | 'enginePath' | 'config' | 'installPolicy' | 'log'
> & {
  pluginId: string;
  tools: ToolSpec[];
  spawnEngine: boolean;
  onState(s: KitState): void;
  onExit(code: number | null): void;
};

export class Engine {
  constructor(_o: EngineOptions) {
    throw new Error('not built: O3');
  }

  get root(): string {
    throw new Error('not built: O3');
  }

  get bridgeSock(): string {
    throw new Error('not built: O3');
  }

  prepare(): Promise<void> {
    throw new Error('not built: O3');
  }

  // spawned (or not) and port known
  start(): Promise<{ port: number; token: string; identityPath: string }> {
    throw new Error('not built: O3');
  }

  stop(): Promise<void> {
    throw new Error('not built: O3');
  }

  // offline doctor --fix run
  doctor(_timeoutMs: number): { status: number | null } {
    throw new Error('not built: O3');
  }

  doctorContext(): { entry: string; env: Record<string, string> } {
    throw new Error('not built: O3');
  }
}
