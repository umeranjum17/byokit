// The browser sign-in sheet and live view as a person sees them: which sentence to show, which buttons to offer, and
// the chip under the chat. Framework-free; typed structurally against `@byokit/openclaw`'s `NeedSignIn` and
// `LiveViewState` (spec 5.17), so nothing here imports a kit. Sentences are the kit's word keys plus their values,
// for the kit's own `words` to say. Nothing here ever holds what the person types.
import { retrying, store, type Store } from './follow.ts';
import type { FollowOptions } from './approvals.ts';

/** One sign-in request as the OpenClaw kit reports it (`NeedSignIn`). */
export type SignInRequest = {
  id: string;
  gen: number;
  member: string;
  origin: string;
  site: string;
  secure: boolean;
  firstTime: boolean;
  agentNote?: string;
  hints: string[];
  choices: { kind: 'takeover' | 'not-now' | 'cancel' }[];
  state: 'waiting' | 'held' | 'checking' | 'parked' | 'settled';
  settled?: {
    state: 'verified' | 'entered-unverified' | 'cancelled' | 'expired' | 'failed';
    reason?: string;
    resume?: { state: 'pending' | 'accepted' | 'submitted' | 'indeterminate' | 'failed' };
  };
  expires: number;
};

export type SignInAction = 'takeover' | 'notNow' | 'cancel' | 'done' | 'reopen' | 'retry';
export type SignInWordKey =
  | 'signin.waiting' | 'signin.private' | 'signin.checking' | 'signin.parked' | 'signin.verified'
  | 'signin.noVerifier' | 'signin.stillSignedOut' | 'signin.expired' | 'signin.cancelled' | 'signin.runReplaced'
  | 'signin.superseded' | 'signin.originMismatch' | 'signin.browserGone' | 'signin.resumeFailed'
  | 'signin.resumeUnknown' | 'signin.insecureRemote';
export type SignInVars = { site: string; name: string; origin: string };

export type SignInSheet = {
  id: string;
  gen: number;
  /** `signin.title` with `site`. */
  site: string;
  /** The address the person is signing in on, shown in full; it states the address bar, never that a site is safe. */
  origin: string;
  secure: boolean;
  /** First time on this site: `signin.confirmSite`, and the person types or picks the site before taking over. */
  confirmSite: boolean;
  /** The helper's own words, to show only as a quote (`signin.agentNote`), never as a title or button. */
  note?: string;
  hints: string[];
  /** The one sentence under the title. */
  line: { key: SignInWordKey; vars: SignInVars };
  /** Buttons, in order. Empty while someone else signs in or the check runs. */
  actions: SignInAction[];
  /** The chip in the chat: `entered` ("Sign-in details entered"), `verified` ("Signed in to {site}"). */
  chip?: 'entered' | 'verified';
  /** Still waiting on the person: every outcome but a verified sign-in the helper went on from. */
  needsYou: boolean;
};

const settledLine = (s: NonNullable<SignInRequest['settled']>): SignInWordKey => {
  switch (s.state) {
    case 'verified':
      return s.resume?.state === 'failed' ? 'signin.resumeFailed'
        : s.resume?.state === 'indeterminate' ? 'signin.resumeUnknown' : 'signin.verified';
    case 'entered-unverified': return s.reason === 'still-signed-out' ? 'signin.stillSignedOut' : 'signin.noVerifier';
    case 'cancelled':
      return s.reason === 'run-replaced' ? 'signin.runReplaced' : s.reason === 'superseded' ? 'signin.superseded' : 'signin.cancelled';
    case 'expired': return 'signin.expired';
    case 'failed': return s.reason === 'origin-mismatch' ? 'signin.originMismatch' : 'signin.browserGone';
  }
};

/**
 * What to draw for one request. `holder` is whether this device holds the takeover lease; `name` is the helper's
 * name for the sentences.
 */
export function signInSheetView(r: SignInRequest, { name, holder = false }: { name: string; holder?: boolean }): SignInSheet {
  const vars = { site: r.site, name, origin: r.origin };
  const can = (k: 'takeover' | 'not-now' | 'cancel') => r.choices.some((c) => c.kind === k);
  const base = {
    id: r.id, gen: r.gen, site: r.site, origin: r.origin, secure: r.secure, hints: r.hints,
    confirmSite: r.firstTime && r.state === 'waiting', ...(r.agentNote ? { note: r.agentNote } : {}),
  };
  const line = (key: SignInWordKey) => ({ key, vars });
  switch (r.state) {
    case 'waiting': {
      const actions: SignInAction[] = [];
      if (can('takeover')) actions.push('takeover');
      if (can('not-now')) actions.push('notNow');
      return { ...base, line: line(r.secure ? 'signin.waiting' : 'signin.insecureRemote'), actions, needsYou: true };
    }
    case 'held':
      return holder
        ? { ...base, line: line('signin.waiting'), actions: ['done', 'notNow', 'cancel'], needsYou: true }
        : { ...base, line: line('signin.private'), actions: [], needsYou: true };
    case 'checking': return { ...base, line: line('signin.checking'), actions: [], chip: 'entered', needsYou: true };
    case 'parked': return { ...base, line: line('signin.parked'), actions: ['reopen'], needsYou: true };
    case 'settled': {
      const s = r.settled ?? { state: 'failed' as const };
      const key = settledLine(s);
      const verified = s.state === 'verified';
      const chip = verified ? 'verified' as const : s.state === 'entered-unverified' ? 'entered' as const : undefined;
      return {
        ...base, line: line(key), actions: verified ? [] : ['retry'], ...(chip ? { chip } : {}),
        needsYou: key !== 'signin.verified',
      };
    }
  }
}

/** A frame of the kit's event stream; only `byokit.browser` sign-in pings matter here. */
export type BrowserFrame = { event: string; payload?: unknown };
/** What `signInsStore` needs from a device client: the kit's device client fits once its browser ops land (O22). */
export type SignInsSource = { signIns(): Promise<SignInRequest[]>; events(): AsyncIterable<BrowserFrame> };

const ping = (f: BrowserFrame) =>
  f.event === 'byokit.browser' && (f.payload as { kind?: unknown } | undefined)?.kind === 'signin';

/**
 * The member's sign-in requests, live: listed once the event stream is open (so no ping falls between the two), and
 * listed again on every sign-in ping, which carries no origin or URL. Opened again after the link comes back.
 */
export function signInsStore(source: SignInsSource, { retryMs = 2000 }: Pick<FollowOptions, 'retryMs'> = {}): Store<SignInRequest[]> {
  return store<SignInRequest[]>([], (set) => retrying(async (live) => {
    const it = source.events()[Symbol.asyncIterator]();
    live.hold(it);
    try {
      const first = it.next();
      first.catch(() => {});
      set(await source.signIns());
      if (live.stopped()) return;
      live.ok();
      for (let r = await first; !r.done && !live.stopped(); r = await it.next()) {
        if (ping(r.value)) set(await source.signIns());
      }
    } finally {
      void it.return?.();
    }
  }, retryMs));
}

/** One live view's state as the kit reports it (`LiveViewState`), as far as drawing it needs. */
export type LiveState = {
  phase: 'connecting' | 'live' | 'reconnecting' | 'private' | 'ended' | 'failed';
  mode: 'observe' | 'control';
  origin?: string;
  offOrigin?: boolean;
};
export type LivePanel = {
  /** Draw frames; otherwise keep the last one dimmed under `line`, or a blank panel. */
  showFrames: boolean;
  /** Input goes to the page only while this is true: in control, live, and not paused on an unexpected address. */
  input: boolean;
  /** `confirmOrigin` button: the page moved to `origin`, which the person hasn't confirmed for this sign-in. */
  confirmOrigin?: string;
  line?: { key: 'live.reconnecting' | 'signin.private' | 'signin.offOrigin' };
};

/** What to draw for one live view. Watching never asks the helper anything. */
export function livePanelView(s: LiveState): LivePanel {
  switch (s.phase) {
    case 'live':
      if (s.mode === 'control' && s.offOrigin) {
        return { showFrames: true, input: false, line: { key: 'signin.offOrigin' }, ...(s.origin ? { confirmOrigin: s.origin } : {}) };
      }
      return { showFrames: true, input: s.mode === 'control' };
    case 'connecting': case 'reconnecting': return { showFrames: false, input: false, line: { key: 'live.reconnecting' } };
    case 'private': return { showFrames: false, input: false, line: { key: 'signin.private' } };
    case 'ended': case 'failed': return { showFrames: false, input: false };
  }
}
