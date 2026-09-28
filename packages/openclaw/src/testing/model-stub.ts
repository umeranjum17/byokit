// The scripted OpenAI-compatible model the contract and engine tests run against (5.11): ported from Crewhouse's
// test/openclaw-stub.ts with its script grammar unchanged. Built in O7.
import type { OpenClawKit } from '../kit.ts';

export type ModelStub = { port: number; close(): Promise<void> };

export function startModelStub(script?: string[]): Promise<ModelStub> {
  throw new Error('not built: O7');
}

// provider id 'byokit-stub', model 'test' (Crewhouse configureModelProvider).
export function useModelStub(kit: OpenClawKit, stub: ModelStub): Promise<void> {
  throw new Error('not built: O7');
}
