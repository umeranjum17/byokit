// `@byokit/cloud` — the person's own always-on cloud computer for an app's host process.
// The app keeps its own screens, recipe and decisions; the kit supplies the typed, tested
// integration (docs/cloud-kit.md). Portable entry: no `node:*` import.

export { machine } from './machine.ts';
export { setup } from './setup.ts';
export type { SetupStep, SetupStepName } from './setup.ts';
export { OWNER_KEY_FILE, PHONE_KEY_FILE, RECEIPT_FILE, bindPhoneKey, deliverPhoneKey, pairEnrol, phoneReceipt, replacePhoneKey } from './enrol.ts';
export type { EnrolHost, OwnerHost, PairContext, PairReceipt, ReceiptHost } from './enrol.ts';
export { status } from './status.ts';
export type { Status } from './status.ts';
export { boat } from './boat.ts';
export { sshVm, sshHostKey } from './ssh-vm.ts';
export type { SshPins, SshTarget, SshTransport, SshTransportHostKeyOptions, SshTransportOptions } from './ssh-vm.ts';
/** @deprecated Use boat(). */
export { boat as sandboxApi } from './boat.ts';
export { claim, revokeClaim } from './claim.ts';
export type { ClaimStep } from './claim.ts';
export { wakeResolve } from './wake.ts';
export { hetznerApi } from './hetzner-api.ts';
export type { HetznerApiOptions, HetznerApiProvider, HetznerServerExtras } from './hetzner-api.ts';
export { installScript, setupCommand } from './script.ts';
export type { InstallScriptOptions } from './script.ts';
export { MachineError } from './errors.ts';
export type { MachineErrorCode } from './errors.ts';
export { estimate } from './cost.ts';
export { words, stateWords, hostWords, keyWords, errorWords, errorKey, WORDS } from './words.ts';
export type { WordKey } from './words.ts';
export type {
  AsleepWhy, Cost, Disk, ExecResult, HostRecipe, HostState, KeyInfo, Machine, MachineRecord, MachineRef,
  MachineState, MachineStore, Plan, Price, Provider, Size, Snapshot, Tailnet, TailnetStep, Usage,
} from './types.ts';
