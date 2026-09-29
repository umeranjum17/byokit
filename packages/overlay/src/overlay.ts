// The JS core over an injected native module (docs/capability-kits.md 7.3): argument checks before any native call,
// and listener sets fed by one native listener. Pure: no platform import, so every entry can use it.
import type { NativeOverlay, Overlay, OverlayEvent, OverlayEventType, StartOptions } from './types.ts';

const MOOD = /^[a-z][a-z0-9_]{0,63}$/;
const SAY_MS = 2500;

function check(o: StartOptions): void {
  if (o.host === 'window' && !o.notice) throw new Error('overlay: host window needs notice');
  if (o.host === 'window' && o.rules) throw new Error('overlay: rules need host accessibility');
  if (o.host === 'window' && o.spots === 'per-app') throw new Error('overlay: per-app spots need host accessibility');
  if (!MOOD.test(o.mood)) throw new Error(`overlay: mood must match ${MOOD}`);
}

const unsupported: Overlay = {
  state: async () => 'unsupported',
  openPermission: async () => {},
  start: async () => 'unsupported',
  stop: async () => {},
  say: () => {},
  setMood: () => {},
  setLabel: () => {},
  setRules: () => {},
  openPanel: async () => {},
  closePanel: async () => {},
  on: () => () => {},
  logTap: async () => {},
  taps: async () => [],
  clearTaps: async () => {},
};

/** The overlay over a native module, or the `unsupported` one when there is none (iOS, web, Node). */
export function createOverlay(native: NativeOverlay | null): Overlay {
  if (!native) return unsupported;
  const sets = new Map<OverlayEventType, Set<(e: OverlayEvent) => void>>();
  let subscribed = false;
  const dispatch = (e: OverlayEvent): void => {
    for (const fn of [...(sets.get(e.type) ?? [])]) {
      try { fn(e); } catch { /* one throwing listener never stops the rest */ }
    }
  };
  return {
    state: () => native.state(),
    openPermission: () => native.openPermission(),
    start: async (o) => { check(o); return native.start(o); },
    stop: () => native.stop(),
    say: (text, mood, ms = SAY_MS, o) => native.say(text, mood ?? null, ms, o?.announce ?? false),
    setMood: (mood) => native.setMood(mood),
    setLabel: (label) => native.setLabel(label),
    setRules: (rules) => native.setRules(rules),
    openPanel: (props = {}) => native.openPanel(props),
    closePanel: () => native.closePanel(),
    on(type, fn) {
      if (!subscribed) { native.addListener('overlay', dispatch); subscribed = true; }
      const set = sets.get(type) ?? new Set();
      sets.set(type, set);
      // Each on() adds its own entry, so the same function added twice is removed once per remover.
      const entry = (e: OverlayEvent): void => fn(e as never);
      set.add(entry);
      return () => { set.delete(entry); };
    },
    logTap: ({ app, action }) => native.logTap(app, action),
    taps: (o) => native.taps(o?.since ?? 0),
    clearTaps: () => native.clearTaps(),
  };
}
