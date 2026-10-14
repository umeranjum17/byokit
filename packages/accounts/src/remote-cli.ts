// Sign an agent CLI in on a remote computer from a phone, over a paired link.
//
// The sign-in runs ON the computer: the host starts the agent CLI's own device-code (Codex) or
// link-and-paste-code (Claude) login there, sends only the verification URL, the user code and the
// expiry to the phone, the phone shows them (open the link, type the code), and the host reports
// success or one plain failure. The credential is written only by the CLI on the computer; it never
// travels to the phone or anywhere else, and neither side logs it.
//
// This file is portable (phones, browsers, Node): no platform import. The host side that spawns the
// CLI lives in `remote-cli-host.ts` (Node only, re-exported from `./cli`).

/** Agent CLIs a remote sign-in can report on. */
export type RemoteCliProvider = 'claude' | 'codex' | 'pi' | 'opencode';
export const REMOTE_CLI_PROVIDERS: readonly RemoteCliProvider[] = ['claude', 'codex', 'pi', 'opencode'];

/** Paired-link operations. Compose `remoteCliHost(...).handle` into the pair `Host`'s `handle`. */
export const REMOTE_CLI_OPS = {
  state: 'accounts.cli.state',
  start: 'accounts.cli.signin.start',
  wait: 'accounts.cli.signin.wait',
  paste: 'accounts.cli.signin.paste',
  cancel: 'accounts.cli.signin.cancel',
} as const;

/** The least the device needs to call the host: mirrors `DeviceLink` without importing `@byokit/pair`. */
export type RemoteCliLink = {
  readonly status: string;
  request(op: string, args?: unknown, opts?: { timeoutMs?: number; notValidAfter?: number }): Promise<unknown>;
};

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
export const isRemoteCliProvider = (v: unknown): v is RemoteCliProvider =>
  v === 'claude' || v === 'codex' || v === 'pi' || v === 'opencode';

const label: Record<RemoteCliProvider, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode' };
export const remoteCliLabel = (provider: RemoteCliProvider): string => label[provider];

/** Every way a remote CLI sign-in ends, in words the phone shows as-is. */
export const REMOTE_CLI_WORDS = {
  unsupported: (provider: RemoteCliProvider) =>
    `${label[provider]} can't sign in from your phone. Sign in on the computer itself.`,
  missing: (provider: RemoteCliProvider) => `${label[provider]} isn't installed on your computer.`,
  busy: (provider: RemoteCliProvider) =>
    `${label[provider]} is already signing in on your computer. Wait for it to finish.`,
  already: (provider: RemoteCliProvider) => `${label[provider]} on your computer is already signed in.`,
  expired: () => 'That code ran out. Start the sign-in again for a fresh code.',
  denied: (provider: RemoteCliProvider) =>
    `The sign-in was declined on the ${label[provider]} page. Try again.`,
  failed: (provider: RemoteCliProvider) => `The ${label[provider]} sign-in didn't finish on your computer. Try again.`,
  cancelled: () => 'The sign-in was stopped.',
  unknown: () => "That sign-in isn't running on your computer any more. Start it again.",
} as const;

export type RemoteCliProblem = 'unsupported' | 'missing' | 'busy' | 'already' | 'expired' | 'denied' | 'failed' | 'cancelled' | 'unknown';

/** A failure with the words to show and a code for the app. */
export class RemoteCliError extends Error {
  readonly code: RemoteCliProblem | 'link';
  constructor(code: RemoteCliProblem | 'link', message: string) {
    super(message);
    this.name = 'RemoteCliError';
    this.code = code;
  }
}

/** Read-only signed-in state for one CLI. Labels come from the CLI's own status, never secrets. */
export type RemoteCliState = {
  provider: RemoteCliProvider;
  /** Agent-CLI logins are the person's subscription, never API billing. */
  billing: 'subscription';
  /** The app passed an executable binary for this CLI on the host. */
  installed: boolean;
  /** A managed login on the host answers signed in. */
  signedIn: boolean;
  /** This CLI has a phone-startable login flow on the host. */
  supported: boolean;
  /** Account label the CLI exposes without secrets (email, else display name). */
  label?: string;
  /** Plan the CLI names, when it names one. */
  plan?: string;
};

/** What the phone shows: open the link, type the code. */
export type RemoteCliDisplay = {
  id: string;
  provider: RemoteCliProvider;
  verificationUri: string;
  /** Absent on link-and-paste-code flows (Claude): the page shows the code, the phone sends it back. */
  userCode?: string;
  /** Absent when the CLI does not say (Claude): show no countdown. */
  expiresInSeconds?: number;
};

export type RemoteCliFailure = { ok: false; error: RemoteCliProblem; words: string };

export type RemoteCliStart =
  | { ok: true; signIn: RemoteCliDisplay }
  | RemoteCliFailure;

export type RemoteCliResult =
  | { ok: true; provider: RemoteCliProvider }
  | RemoteCliFailure;

/** Wire format. Failures carry only words and a code: never a code, URL, token or CLI output. */
export type RemoteCliReply =
  | { v: 1; ok: true; value: unknown }
  | { v: 1; ok: false; error: string; words: string };

const problem = (v: unknown): v is RemoteCliProblem =>
  typeof v === 'string' && ['unsupported', 'missing', 'busy', 'already', 'expired', 'denied', 'failed', 'cancelled', 'unknown'].includes(v);

const wordsFor = (provider: RemoteCliProvider, error: RemoteCliProblem): string => {
  switch (error) {
    case 'unsupported': return REMOTE_CLI_WORDS.unsupported(provider);
    case 'missing': return REMOTE_CLI_WORDS.missing(provider);
    case 'busy': return REMOTE_CLI_WORDS.busy(provider);
    case 'already': return REMOTE_CLI_WORDS.already(provider);
    case 'expired': return REMOTE_CLI_WORDS.expired();
    case 'denied': return REMOTE_CLI_WORDS.denied(provider);
    case 'failed': return REMOTE_CLI_WORDS.failed(provider);
    case 'cancelled': return REMOTE_CLI_WORDS.cancelled();
    case 'unknown': return REMOTE_CLI_WORDS.unknown();
  }
};

/** The phone side: typed calls over the paired link. The credential never arrives here. */
export function remoteCliDevice(link: RemoteCliLink): {
  state(): Promise<RemoteCliState[]>;
  start(provider: RemoteCliProvider): Promise<RemoteCliStart>;
  wait(id: string, opts?: { timeoutMs?: number }): Promise<RemoteCliResult>;
  paste(id: string, pasteText: string): Promise<void>;
  cancel(id: string): Promise<void>;
} {
  const call = async (op: string, args: unknown, opts?: { timeoutMs?: number; notValidAfter?: number }): Promise<unknown> => {
    let reply: unknown;
    try {
      reply = await link.request(op, args, opts ?? {});
    } catch (e) {
      // The link's own sealed errors (removed, not-allowed, offline) pass through untouched.
      throw e;
    }
    if (!record(reply) || reply.v !== 1 || typeof reply.ok !== 'boolean') {
      throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
    }
    if (reply.ok === true) return (reply as { value: unknown }).value;
    const error = (reply as { error: unknown }).error;
    const words = (reply as { words: unknown }).words;
    throw new RemoteCliError(problem(error) ? error : 'link', typeof words === 'string' && words ? words : 'Your computer could not do that.');
  };
  const stateOf = (value: unknown): RemoteCliState[] => {
    if (!Array.isArray(value)) throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
    return value.map((row) => {
      if (!record(row) || !isRemoteCliProvider(row.provider) || typeof row.installed !== 'boolean' ||
        typeof row.signedIn !== 'boolean' || typeof row.supported !== 'boolean' || row.billing !== 'subscription') {
        throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
      }
      const state: RemoteCliState = { provider: row.provider, billing: 'subscription',
        installed: row.installed, signedIn: row.signedIn, supported: row.supported };
      if (text(row.label) && row.label.length <= 320) state.label = row.label;
      if (typeof row.plan === 'string' && /^[a-zA-Z][a-zA-Z0-9 _+-]{0,63}$/.test(row.plan)) state.plan = row.plan;
      return state;
    });
  };
  const displayOf = (provider: RemoteCliProvider, value: unknown): RemoteCliDisplay => {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128 ||
      value.provider !== provider || typeof value.verificationUri !== 'string' || !value.verificationUri.startsWith('https://')) {
      throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
    }
    const display: RemoteCliDisplay = { id: value.id, provider, verificationUri: value.verificationUri };
    if (typeof value.userCode === 'string' && value.userCode && value.userCode.length <= 64) display.userCode = value.userCode;
    if (typeof value.expiresInSeconds === 'number' && Number.isFinite(value.expiresInSeconds) && value.expiresInSeconds > 0) {
      display.expiresInSeconds = Math.min(value.expiresInSeconds, 2 ** 31 - 1);
    }
    return display;
  };
  const resultOf = (value: unknown): RemoteCliResult => {
    if (!record(value)) throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
    if (value.ok === true && isRemoteCliProvider(value.provider)) return { ok: true, provider: value.provider };
    if (value.ok === false && problem(value.error)) {
      // The host always sends words; the fallback is provider-agnostic on purpose (wait carries no provider).
      const words = typeof value.words === 'string' && value.words ? value.words : 'The sign-in on your computer did not finish. Try again.';
      return { ok: false, error: value.error, words };
    }
    throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
  };
  return {
    state: async () => stateOf(await call(REMOTE_CLI_OPS.state, { v: 1 })),
    start: async (provider) => {
      if (!isRemoteCliProvider(provider)) throw new RemoteCliError('link', 'Unknown agent app.');
      const value = await call(REMOTE_CLI_OPS.start, { v: 1, provider });
      if (record(value) && value.ok === true) return { ok: true, signIn: displayOf(provider, value.signIn) };
      if (record(value) && value.ok === false && problem(value.error)) {
        const words = typeof value.words === 'string' && value.words ? value.words : wordsFor(provider, value.error);
        return { ok: false, error: value.error, words };
      }
      throw new RemoteCliError('link', 'Your computer answered in a way this phone does not understand. Update it there.');
    },
    wait: async (id, opts) => {
      if (!text(id) || !id || id.length > 128) throw new RemoteCliError('link', 'Unknown sign-in.');
      const timeoutMs = opts?.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1)) {
        throw new RemoteCliError('link', 'Bad wait timeout.');
      }
      // A late link timeout never cancels the host sign-in: call wait again for the same id.
      return resultOf(await call(REMOTE_CLI_OPS.wait, { v: 1, id, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
        timeoutMs === undefined ? {} : { timeoutMs: timeoutMs + 5000, notValidAfter: Date.now() + timeoutMs + 5000 }));
    },
    paste: async (id, pasteText) => {
      if (!text(id) || !id || id.length > 128) throw new RemoteCliError('link', 'Unknown sign-in.');
      if (!text(pasteText) || !pasteText || pasteText.length > 2000) throw new RemoteCliError('link', 'Nothing to send.');
      await call(REMOTE_CLI_OPS.paste, { v: 1, id, text: pasteText });
    },
    cancel: async (id) => {
      if (!text(id) || !id || id.length > 128) throw new RemoteCliError('link', 'Unknown sign-in.');
      await call(REMOTE_CLI_OPS.cancel, { v: 1, id });
    },
  };
}
