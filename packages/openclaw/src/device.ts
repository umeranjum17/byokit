// The device side (7.2): portable — browsers, React Native, Node; no node:* or Node-only imports may reach here
// (test/portable.test.ts guards it). Built in O9.
import type { DeviceLink } from '@byokit/link';
import type { AccountView } from './words.ts';
import type {
  Approval,
  Decision,
  KitState,
  Route,
  RunEnd,
  RunEvent,
  SignInView,
} from './types.ts';

export function openclawDevice(link: DeviceLink): {
  state(): Promise<{ state: KitState; words: string }>;
  routes(): Promise<Route[]>;
  signIn: {
    start(p: string, via: 'browser' | 'code'): Promise<SignInView>;
    view(p: string): Promise<AccountView>;
    paste(p: string, t: string): Promise<void>;
    cancel(p: string): Promise<void>;
  };
  run(message: string, o?: { sessionKey?: string }): AsyncIterable<RunEvent | { type: 'end'; end: RunEnd }>;
  steer(k: string, t: string): Promise<void>;
  abort(k: string): Promise<void>;
  approvals(): Promise<Approval[]>;
  decide(id: string, d: Decision): Promise<void>;
  events(): AsyncIterable<unknown>;
  registerNotices(seed: Uint8Array): Promise<void>; // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null;
  call(method: string, params?: unknown): Promise<unknown>;
} {
  throw new Error('not built: O9');
}

// Portable, re-exported by ./device (7.3).
export { openNotice } from './notices.ts';
