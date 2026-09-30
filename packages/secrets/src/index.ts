// @byokit/secrets: one secret per name, from the OS keyring, a passphrase-sealed file,
// or a host-passed override for CI. This Node entry spawns keyring CLIs and uses node:crypto.
export { KeystoreError } from './errors.ts';
export type { KeystoreErrorCode } from './errors.ts';
export type { Keystore } from './types.ts';
export { keyringEnv, keyringStore } from './keyring.ts';
export type { KeyringOptions, KeyringTool } from './keyring.ts';
export { fileStore } from './file.ts';
export type { FileOptions } from './file.ts';
export { writeFileAtomic } from './atomic.ts';
export { overrideStore } from './override.ts';
export { osKeyring, osKeyringStore } from './os-keyring.ts';
export type { KeyringBackend, KeyringEntry, OSKeyringOptions } from './os-keyring.ts';
export { osKeyringSeal, hostKeySeal } from './sealing.ts';
export type { SealingAdapter, HostKey, HostKeySealOptions, OSKeyringSealOptions, OSKeyringSeal } from './sealing.ts';
