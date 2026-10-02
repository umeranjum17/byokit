// `ShareIntentModule` as apps see it (docs/capability-kits.md 14): on Android an adapter over the kit's own
// `ByokitShare` (upstream's module is not linked there), on iOS upstream's module with `getShareIntent` guarded.
// Native-free, so it is tested anywhere.
import type {
  AndroidShareIntent, NativeShare, NativeShareRead, ShareIntentModuleEvents, ShareIntentModuleLike,
} from './types.ts';
import { isValidShareUrl } from './url.ts';
import { errorWords, ShareError } from './words.ts';

type Events = ShareIntentModuleEvents;
type Listener = (...a: unknown[]) => void;

/** A read share in upstream's Android payload shape, ready for upstream's parseShareIntent. */
export const androidPayload = (r: Extract<NativeShareRead, { kind: 'shared' }>): AndroidShareIntent => ({
  type: r.files.length ? 'file' : 'text', text: r.text, meta: { title: r.title ?? undefined }, files: r.files,
});

/** Android: upstream's events over `ByokitShare` reads; errors carry words, never a URI. */
export function createAndroidShareModule(native: NativeShare): ShareIntentModuleLike {
  const sets = new Map<keyof Events, Set<Listener>>();
  let lastSeq = 0;
  const emit = <E extends keyof Events>(event: E, ...args: Parameters<Events[E]>) => {
    for (const f of [...(sets.get(event) ?? [])]) f(...args);
  };
  const removeListener = <E extends keyof Events>(event: E, f: Events[E]) => { sets.get(event)?.delete(f as Listener); };
  return {
    async getShareIntent() {
      let r: NativeShareRead;
      try { r = await native.read(); } catch { emit('onError', { value: errorWords({ code: 'failed' }) }); return; }
      if (r.kind === 'none') return;
      lastSeq = r.seq;
      if (r.kind === 'unreadable') { emit('onError', { value: errorWords({ code: 'unreadable' }) }); return; }
      emit('onStateChange', { value: 'pending' });
      emit('onChange', { value: androidPayload(r) });
    },
    async clearShareIntent() { if (lastSeq > 0) native.clear(lastSeq); },   // the key is ignored, as upstream's Android ignores it
    hasShareIntent: () => native.hasPending(),
    addListener(event, f) {
      let s = sets.get(event);
      if (!s) sets.set(event, (s = new Set()));
      s.add(f as Listener);
      return { remove: () => removeListener(event, f) };
    },
    removeListener,
    removeAllListeners(event) { sets.delete(event); },
    emit,
    listenerCount: (event) => sets.get(event)?.size ?? 0,
  };
}

/** iOS: upstream's module, but `getShareIntent` reaches native only for the extension's own link. */
export function guardIosShareModule(m: ShareIntentModuleLike, scheme: () => string | null): ShareIntentModuleLike {
  return {
    getShareIntent: (url) => isValidShareUrl(url, scheme()) ? m.getShareIntent(url) : Promise.reject(new ShareError('invalid_share_url', 'share: not the share extension link')),
    clearShareIntent: (key) => m.clearShareIntent(key),
    hasShareIntent: (key) => m.hasShareIntent(key),
    addListener: (event, f) => m.addListener(event, f),
    removeListener: (event, f) => m.removeListener(event, f),
    removeAllListeners: (event) => m.removeAllListeners(event),
    emit: (event, ...args) => m.emit(event, ...args),
    listenerCount: (event) => m.listenerCount(event),
  };
}
