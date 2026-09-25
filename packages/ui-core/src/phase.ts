// The phases a "Sign in with …" sheet walks through, from what the app's back end says. Framework-free, so any UI can use it.
//   opening   getting the provider's page or a code ready        waiting   say yes on the provider's own page
//   code      type this code on the provider's page instead      done      signed in, and it works
//   work      signed in with a work plan: offer a personal one   cancelled declined on the page, or cancelled here
//   busy      something else on this computer is signing in      expired   the page or code ran out of time
//   failed    anything else, with a plain sentence               offline   the home computer isn't answering
export type Phase = 'opening' | 'waiting' | 'code' | 'done' | 'work' | 'cancelled' | 'busy' | 'expired' | 'failed' | 'offline';

/** A sign-in in progress, as `@byokit/accounts` `view()` reports it. */
export type SignInView = { state: 'waiting' | 'done' | 'failed'; via?: 'browser' | 'code'; url?: string; code?: string; error?: string; why?: string };
/** One account as the app's back end reports it; `work` is set when the sign-in is a work plan. */
export type AccountView = { ready?: boolean; work?: string | boolean; signIn?: SignInView | null };

export function phaseOf(a: AccountView | null, { offline = false, cancelled = false, keepWork = false } = {}): Phase {
  const s = a?.signIn;
  if (offline) return 'offline';
  if (cancelled) return 'cancelled';
  if (a?.ready) return a.work && !keepWork ? 'work' : 'done';
  if (s?.state === 'waiting') return s.code ? 'code' : s.url ? 'waiting' : 'opening';
  if (s?.state === 'failed') {
    if (s.why === 'busy') return 'busy';
    if (s.why === 'declined') return 'cancelled';
    return s.why === 'expired' || s.why === 'tooLong' || /expired|too long/i.test(s.error ?? '') ? 'expired' : 'failed';
  }
  return 'opening';
}

/** Where the three-step progress bar ("Open", "Say yes", "Done") stands. */
export const stepOf = (p: Phase) => (p === 'done' || p === 'work' ? 3 : p === 'waiting' || p === 'code' ? 1 : 0);
