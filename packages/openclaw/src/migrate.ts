// Retained-login migration (D15, 5.7): stage a Pi auth.json-shaped record into the engine's own store, then confirm
// only when the Gateway itself reports every provider signed in. Built in O6.
import type { RetainedLogin } from './kit.ts';
import type { SignInCtx } from './signin.ts';
import type { Member } from './types.ts';

export type DoctorRunner = () => { status: number | null };

export function migrateRetainedLogin(
  ctx: { root: string; prepare(): Promise<void>; doctor: DoctorRunner },
  member: Member,
  source: RetainedLogin,
): Promise<'staged' | 'nothing' | 'failed'> {
  throw new Error('not built: O6');
}

export function confirmRetainedLogin(ctx: SignInCtx, member: Member, source: RetainedLogin): Promise<boolean> {
  throw new Error('not built: O6');
}
