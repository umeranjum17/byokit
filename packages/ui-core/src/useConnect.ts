// The connect view as a React hook: holds the step, recomputes the view from the routes the app passes, and hands
// the chosen sign-in row's options to `useSignIn`. Keys never enter it: the app sends the input to its kit and
// reports only the result.
import { useState } from 'react';
import { connectStep, connectView, signInFor, type ConnectAction, type ConnectRoute, type ConnectStep, type ConnectWords, type UseConnectSignIn } from './connect.ts';

export type UseConnect = UseConnectSignIn & { routes: readonly ConnectRoute[]; words?: ConnectWords };

export function useConnect({ routes, words, ...o }: UseConnect) {
  const [step, setStep] = useState<ConnectStep>({ at: 'list' });
  const view = connectView(routes, step, words);
  const act = (a: ConnectAction) => setStep((s) => connectStep(s, a));
  return {
    ...view, step, act,
    pick: (key: string) => act({ type: 'pick', key }),
    back: () => act({ type: 'back' }),
    /** Pass to `useSignIn` in a sheet keyed by `chosen.row.key`; undefined unless a ready sign-in row is chosen. */
    signIn: signInFor(view, o),
  };
}
