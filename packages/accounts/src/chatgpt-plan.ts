/** A host-owned, validated Sign in with ChatGPT token-sharing session. The host completes the official
 * OAuth flow (including ID-token verification), stores it per person, and refreshes it before returning it.
 * This adapter never discovers credentials, starts a login, or substitutes a Codex credential. */
export type ChatGPTPlanSession = { accessToken: string; scopes: readonly string[] };
export type ChatGPTPlanAccount = {
  readonly billing: 'subscription';
  access(signal: AbortSignal): Promise<string>;
};

/** The selected account, consent or model cannot support this request. Never falls back to API billing. */
export class UnsupportedAccountError extends Error {
  readonly code = 'unsupported_account';
  constructor(message: string) { super(message); this.name = 'UnsupportedAccountError'; }
}

/** Bind one person's official token-sharing session to this app. Eligibility and identity verification
 * belong to the host's sign-in integration; granted plan-usage scopes are checked on every request. */
export function chatgptPlan(o: {
  session(signal: AbortSignal): Promise<ChatGPTPlanSession>;
}): ChatGPTPlanAccount {
  return {
    billing: 'subscription',
    async access(signal) {
      const session = await o.session(signal);
      if (!session || !Array.isArray(session.scopes) || !session.scopes.includes('chatgpt.tokens.use.direct') ||
          !session.scopes.includes('resource.invoke') || typeof session.accessToken !== 'string' || !session.accessToken.trim()) {
        throw new UnsupportedAccountError('This needs a ChatGPT sign-in that allows plan use.');
      }
      return session.accessToken;
    },
  };
}
