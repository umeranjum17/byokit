// The contract suite (4.5, 5.11): the same assertions run against the fake in npm test and against the real pinned
// engine in the engine job (O11 runs them). Built in O7.
import type { OpenClawKit } from '../kit.ts';
import type { ModelStub } from './model-stub.ts';

export function openclawContract(make: () => Promise<{ kit: OpenClawKit; model?: ModelStub }>): void {
  throw new Error('not built: O7');
}
