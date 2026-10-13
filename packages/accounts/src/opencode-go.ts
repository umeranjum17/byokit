/** A member-bound OpenCode Go plan account (route `opencode:plan_key:opencode-go`). Credentials stay
 * inside Accounts: `access` reads the member's own saved plan key. Never falls back to API billing. */
export type OpenCodeGoAccount = {
  readonly billing: 'subscription';
  /** Provider tag: a plan handle only reaches its own provider's endpoint. */
  readonly provider: 'opencode-go';
  access(signal: AbortSignal): Promise<string>;
};
