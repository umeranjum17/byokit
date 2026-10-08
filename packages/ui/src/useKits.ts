// The runtime kits' view state as React hooks (React and React Native alike). Each hook reads one of the
// framework-free stores from `@byokit/ui/kits`; pass the same device client each render (e.g. from useMemo),
// since a new one starts following afresh.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { approvalsStore, type Approval, type ApprovalsSource, type FollowOptions } from './approvals.ts';
import { agentIn, blockedView, herdrStore, herdrTreeView, type HerdrSource } from './herdr.ts';
import { runStore, runView, type RunSource, type RunWordsOptions } from './run.ts';
import type { Store } from './follow.ts';

const useStore = <T>(s: Store<T>) => useSyncExternalStore(s.subscribe, s.get, s.get);

/** One run at a time: `send(message)` streams the reply in; `words` says how a failed run ended. */
export function useRun(source: RunSource, o: RunWordsOptions) {
  const run = useMemo(() => runStore(source), [source]);
  useEffect(() => run.stop, [run]); // leaving the screen stops listening
  const state = useStore(run);
  return { ...runView(state, o), send: run.send, stop: run.stop };
}

/** The approvals waiting for a yes, live; `decide` answers one (it leaves the list when the computer says so). */
export function useApprovals(source: ApprovalsSource & { decide(id: string, d: { allow: boolean; reason?: string; answer?: unknown }): Promise<void> },
  o?: FollowOptions) {
  const approvals: Approval[] = useStore(useMemo(() => approvalsStore(source, o), [source]));
  return { approvals, decide: (id: string, d: { allow: boolean; reason?: string; answer?: unknown }) => source.decide(id, d) };
}

/** Herdr's agents grouped by where they run, live; `agent(paneId)` finds one. `ready` once the computer has said. */
export function useHerdrTree(source: HerdrSource) {
  const { tree } = useStore(herdrStore(source));
  return { ready: tree !== null, tree, groups: useMemo(() => herdrTreeView(tree), [tree]), agent: (paneId: string) => agentIn(tree, paneId) };
}

/** The agents waiting for an answer, live; `answer` sends keys to one, with the revision it was asked at. */
export function useBlocked(source: HerdrSource & { answer(paneId: string, keys: string[], revision: number): Promise<void> }) {
  const state = useStore(herdrStore(source));
  return { blocked: useMemo(() => blockedView(state), [state]), answer: (paneId: string, keys: string[], revision: number) => source.answer(paneId, keys, revision) };
}
