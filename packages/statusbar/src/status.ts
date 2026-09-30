// The JS core over an injected native module (docs/capability-kits.md 12.3): option checks before any native call, on
// every platform, and listener sets fed by one native listener. Pure: no platform import, so every entry can use it.
import type { NativeStatus, ShowOptions, Status, StatusEvent, StatusEventType } from './types.ts';
import { words } from './words.ts';

const ACTION_ID = /^[a-z][a-z0-9_]{0,31}$/;
const ICON = /^[a-z][a-z0-9_]{0,63}$/;
const CHIP_MAX = 7;
const ACTIONS_MAX = 3;

function check(o: ShowOptions): void {
  if (!o.title.trim()) throw new Error('status: title must not be empty');
  if ([...o.chip].length > CHIP_MAX) throw new Error(`status: chip must be at most ${CHIP_MAX} characters`);
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs < 1000) throw new Error('status: timeoutMs must be an integer of at least 1000');
  if (o.icon !== undefined && !ICON.test(o.icon)) throw new Error(`status: icon must match ${ICON}`);
  const actions = o.actions ?? [];
  if (actions.length > ACTIONS_MAX) throw new Error(`status: at most ${ACTIONS_MAX} actions`);
  for (const a of actions) {
    if (!ACTION_ID.test(a.id)) throw new Error(`status: action id must match ${ACTION_ID}`);
    if (!a.label.trim()) throw new Error('status: action label must not be empty');
  }
  if (new Set(actions.map((a) => a.id)).size !== actions.length) throw new Error('status: action ids must be unique');
}

/** The status over a native module, or the `unsupported` one when there is none (iOS, web, Node). */
export function createStatus(native: NativeStatus | null): Status {
  if (!native) {
    return { show: check, clear: () => {}, on: () => () => {}, state: async () => 'unsupported', openSettings: async () => {} };
  }
  const sets = new Map<StatusEventType, Set<(e: StatusEvent) => void>>();
  let subscribed = false;
  const dispatch = (e: StatusEvent): void => {
    for (const fn of [...(sets.get(e.type) ?? [])]) {
      try { fn(e); } catch { /* one throwing listener never stops the rest */ }
    }
  };
  return {
    show: (o) => { check(o); native.show({ ...o, channel: words('status.channel') }); },
    clear: () => native.clear(),
    on(type, fn) {
      if (!subscribed) { native.addListener('status', dispatch); subscribed = true; }
      const set = sets.get(type) ?? new Set();
      sets.set(type, set);
      // Each on() adds its own entry, so the same function added twice is removed once per remover.
      const entry = (e: StatusEvent): void => fn(e as never);
      set.add(entry);
      return () => { set.delete(entry); };
    },
    state: () => native.state(),
    openSettings: () => native.openSettings(),
  };
}
