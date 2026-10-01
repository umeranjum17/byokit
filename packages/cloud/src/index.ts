// `@byokit/cloud` — the person's own always-on cloud computer for an app's host process.
// The app keeps its own screens, recipe and decisions; the kit supplies the typed, tested
// integration (docs/cloud-kit.md). Portable entry: no `node:*` import.

export { machine } from './machine.ts';
export { boat } from './boat.ts';
/** @deprecated Use boat(). */
export { boat as sandboxApi } from './boat.ts';
export { claim } from './claim.ts';
export type { ClaimStep } from './claim.ts';
export { wakeResolve } from './wake.ts';
export { MachineError } from './errors.ts';
export type { MachineErrorCode } from './errors.ts';
export { estimate } from './cost.ts';
export { words, stateWords, hostWords, keyWords, errorWords, WORDS } from './words.ts';
export type { WordKey } from './words.ts';
export type {
  AsleepWhy, Cost, ExecResult, HostRecipe, HostState, KeyInfo, Machine, MachineRecord, MachineRef,
  MachineState, MachineStore, Plan, Price, Provider, Size, Usage,
} from './types.ts';
