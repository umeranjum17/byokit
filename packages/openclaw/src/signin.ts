// Sign-in: the kit drives OpenClaw's own setup wizard loop and holds the ChatGPT callback port during a browser
// sign-in; credentials never pass through kit or app (D11, 5.7). Built in O6.
import type { GatewayTransport, Member, SignInView } from './types.ts';

export type SignInCtx = {
  request: GatewayTransport['request'];
  ensure(member: Member): Promise<{ agentId: string }>;
  callbackPort: number;
};

export function signIn(
  ctx: SignInCtx,
  member: Member,
  o: { authChoice: string; via?: 'browser' | 'code' },
  on: (v: SignInView) => void,
): { paste(text: string): void; cancel(): void; done: Promise<SignInView> } {
  throw new Error('not built: O6');
}

export function providers(ctx: SignInCtx, member: Member, refresh?: boolean): Promise<string[]> {
  throw new Error('not built: O6');
}

export function signOut(ctx: SignInCtx, member: Member, provider: string): Promise<void> {
  throw new Error('not built: O6');
}
