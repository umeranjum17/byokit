// @byokit/accounts/keys on phones and in browsers: the key-route runtime, opted into on its own so the main entry's
// graph stays free of vendor SDKs. The pinned adapters still load only on the first key request.
import type { Platform } from './accounts.ts';
import type { KeyRuntime } from './key-routes.ts';

export type { KeyRuntime } from './key-routes.ts';
/** The typed Pi factories and adapters (one recorded Hermes `throwIfAborted` guard), for explicit native (client-owned) use too. */
export const keys = (): Promise<KeyRuntime> => import('./portable-keys.ts').then((m) => m.runtime);
/** That platform, able to answer key routes: `new Accounts(options, withKeys(portable))`. */
export const withKeys = (platform: Platform): Platform => ({ ...platform, keys });
