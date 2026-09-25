// "Sign in with …" as a headless React hook: starts the sign-in as the sheet opens, polls the app's back end, and
// reports the phase to draw. The app keeps its own look (and its own tab for the provider's page); this is the
// behaviour every sign-in sheet shares.
import { useEffect, useState } from 'react';
import { phaseOf, type AccountView, type Phase } from './phase.ts';

export type UseSignIn = {
  /** This account, fresh from the back end. A rejection counts as the home computer being out of reach unless `offline` says otherwise. */
  read: () => Promise<AccountView | null>;
  start: (body?: { via?: 'code'; fresh?: boolean }) => Promise<unknown>;
  cancel: () => Promise<unknown>;
  offline?: (e: unknown) => boolean;
  ms?: number;
  /** Draw one phase regardless (design review, screenshots): nothing starts and nothing polls. */
  pinned?: Phase | null;
};

export function useSignIn({ read, start, cancel, offline: isOffline = () => true, ms = 1500, pinned }: UseSignIn) {
  const [value, setValue] = useState<AccountView | null>(null);
  const [offline, setOffline] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [keepWork, setKeepWork] = useState(false);
  useEffect(() => {
    if (pinned) return;
    let alive = true;
    const pull = () => read().then((v) => { if (alive) { setValue(v); setOffline(false); } }, (e) => alive && isOffline(e) && setOffline(true));
    pull();
    const t = setInterval(pull, ms);
    return () => { alive = false; clearInterval(t); };
  }, [ms, pinned]);
  const begin = (body: { via?: 'code'; fresh?: boolean } = {}) => { setCancelled(false); start(body).catch(() => {}); };
  useEffect(() => { if (!pinned) begin(); }, []);
  const phase = pinned ?? phaseOf(value, { offline, cancelled, keepWork });
  return {
    phase, account: value, code: value?.signIn?.code, url: value?.signIn?.url,
    /** Start again: `{ via: 'code' }` for "Having trouble?", `{ fresh: true }` to pick the account again. */
    start: begin,
    cancel: () => { setCancelled(true); cancel().catch(() => {}); },
    /** "Keep this one": a work plan the person chose to use anyway. */
    keepWork: () => setKeepWork(true),
    /** Closing the sheet mid-way cancels the sign-in too. */
    close: () => { if (phase === 'waiting' || phase === 'opening' || phase === 'code') cancel().catch(() => {}); },
  };
}
