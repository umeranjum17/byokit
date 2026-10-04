// `useShareIntent` with everything injected (docs/capability-kits.md 14): no runtime imports, so it runs and is
// tested anywhere; `rn.ts` binds React, React Native, expo-linking and the native modules. It keeps upstream
// expo-share-intent 8.0.1's result and AppState rules (useShareIntent.js:18-125) and adds `errorCode`, `skipped` and
// `skipReasons`. Android reads the kit's own `ByokitShare` by seq; iOS calls upstream only for a genuine share link.
import type { useEffect, useRef, useState } from 'react';
import type {
  AndroidShareIntent, NativeShare, NativeShareRead, ShareErrorCode, ShareIntent, ShareIntentModuleLike, ShareIntentOptions,
  ShareIntentState, ShareSkipReason,
} from './types.ts';
import { androidPayload } from './adapter.ts';
import { isValidShareUrl } from './url.ts';
import { errorWords } from './words.ts';

export type ShareHookDeps = {
  module: ShareIntentModuleLike | null;
  native?: NativeShare | null;                       // Android path
  useLinkingURL?: () => string | null;               // iOS path (expo-linking)
  parse: (v: string | AndroidShareIntent, o: ShareIntentOptions) => ShareIntent;
  getScheme: (o?: ShareIntentOptions) => string | null;
  getShareExtensionKey: (o?: ShareIntentOptions) => string;
  react: { useState: typeof useState; useEffect: typeof useEffect; useRef: typeof useRef };
  appState: { currentState?: string | null; addEventListener(e: 'change', f: (s: string) => void): { remove(): void } };
  os: string;
};

type View = Pick<ShareIntentState, 'shareIntent' | 'error' | 'errorCode' | 'skipped' | 'skipReasons'>;

/** Upstream's SHAREINTENT_DEFAULTVALUE (useShareIntent.js:6-11). */
export const EMPTY_SHARE: ShareIntent = { files: null, text: null, webUrl: null, type: null };
const CLEAN: View = { shareIntent: EMPTY_SHARE, error: null, errorCode: null, skipped: 0, skipReasons: [] };
const hasValue = (s: ShareIntent | null | undefined) => !!(s?.text || s?.webUrl || s?.files);
const fail = (code: ShareErrorCode, v: Partial<View> = {}): Partial<View> => ({ error: errorWords({ code }), errorCode: code, ...v });

export function createUseShareIntent(d: ShareHookDeps): (options?: ShareIntentOptions) => ShareIntentState {
  const { useState: useS, useEffect: useE, useRef: useR } = d.react;
  return function useShareIntent(options?: ShareIntentOptions): ShareIntentState {
    // Merged once and passed everywhere, parse included: upstream's parseShareIntent reads options.debug unguarded.
    const o: ShareIntentOptions = { debug: false, resetOnBackground: true, disabled: d.os === 'web', ...options };
    const url = d.useLinkingURL?.() ?? null;
    const [view, setView] = useS<View>(CLEAN);
    const [isReady, setReady] = useS(false);
    const applied = useR(0);          // highest seq applied (Android)
    const resetGen = useR(0);         // bumped by every reset, so a read issued before it never restores `failed` (X19)
    const appState = useR(d.appState.currentState ?? null);
    // The listeners outlive a render: they read the latest view and options through this ref.
    const latest = useR({ view, o, url });
    latest.current = { view, o, url };
    const debug = (...a: unknown[]) => { if (latest.current.o.debug) console.debug('useShareIntent', ...a); };

    const resetShareIntent = (clearNativeModule = true) => {
      const { o, view } = latest.current;
      if (o.disabled) return;
      resetGen.current++;
      if (clearNativeModule) {
        if (d.native) { if (applied.current > 0) d.native.clear(applied.current); }
        else void d.module?.clearShareIntent(d.getShareExtensionKey(o))?.catch?.(() => {});
      }
      const had = hasValue(view.shareIntent);
      setView({ ...CLEAN, shareIntent: had ? EMPTY_SHARE : view.shareIntent });
      if (had) o.onResetShareIntent?.();
    };

    const map = (r: Exclude<NativeShareRead, { kind: 'none' }>): View => {
      const skipReasons: readonly ShareSkipReason[] = r.skipReasons;
      if (r.kind === 'unreadable') return { ...CLEAN, ...fail('unreadable'), skipped: skipReasons.length, skipReasons };
      let shareIntent: ShareIntent;
      try { shareIntent = d.parse(androidPayload(r), latest.current.o); } catch (e) { debug('parse', e); return { ...CLEAN, ...fail('failed') }; }
      return { ...CLEAN, shareIntent, errorCode: skipReasons.length ? 'partial' : null, skipped: skipReasons.length, skipReasons };
    };

    // Android: one effect, subscribe first, then AppState, then read (X1); `alive` belongs to this run, not a ref,
    // so React StrictMode's mount, cleanup, mount still applies (H18).
    useE(() => {
      const native = d.native;
      if (o.disabled || !native) return;
      let alive = true;
      const refresh = () => {
        const at = applied.current, gen = resetGen.current;
        native.read().then(
          (r) => {
            if (!alive || r.kind === 'none' || r.seq <= applied.current) return;   // a newer share applies even across a reset (H6)
            applied.current = r.seq;
            setView(map(r));
          },
          (e) => {
            debug('read', e);
            // X10, X19: only when nothing newer applied and no reset came since this read was asked for.
            if (alive && applied.current === at && resetGen.current === gen) setView((v) => ({ ...v, ...fail('failed') }));
          });
      };
      const share = native.addListener('onShare', refresh);
      const app = d.appState.addEventListener('change', (next) => onAppState(next, refresh));
      setReady(true);
      refresh();
      return () => { alive = false; share.remove(); app.remove(); };
    }, [o.disabled]);

    // iOS: upstream's flow (useShareIntent.js:38-117), with the link checked before any native call.
    const refreshIos = () => {
      const { o, url } = latest.current;
      const scheme = d.getScheme(o);
      if (!url || !scheme || !url.includes(`${scheme}://dataUrl=`)) return debug('not a share link', url);
      if (!isValidShareUrl(url, scheme)) { setView((v) => ({ ...v, ...fail('invalid_share_url') })); return; }
      void d.module?.getShareIntent(url)?.catch?.((e: unknown) => debug('getShareIntent', e));
    };
    useE(() => { if (!o.disabled && !d.native) refreshIos(); }, [url, o.disabled]);
    useE(() => {
      const m = d.module;
      if (o.disabled || d.native || !m) return;
      const change = m.addListener('onChange', (e) => {
        try { const shareIntent = d.parse(e.value, latest.current.o); setView((v) => ({ ...v, shareIntent })); }
        catch (err) { debug('onChange', err); setView((v) => ({ ...v, ...fail('failed') })); }
      });
      const error = m.addListener('onError', (e) => setView((v) => ({ ...v, error: e?.value ?? null, errorCode: 'failed' })));
      const app = d.appState.addEventListener('change', (next) => onAppState(next, refreshIos));
      setReady(true);
      return () => { change.remove(); error.remove(); app.remove(); };
    }, [o.disabled]);

    // Upstream's AppState rules (useShareIntent.js:62-82): refresh on active; reset leaving active.
    function onAppState(next: string, refresh: () => void) {
      if (next === 'active') refresh();
      else if (latest.current.o.resetOnBackground !== false && appState.current === 'active' && (next === 'inactive' || next === 'background')) {
        resetShareIntent(true);
      }
      appState.current = next;
    }

    return { isReady: !o.disabled && isReady, hasShareIntent: hasValue(view.shareIntent), resetShareIntent, ...view };
  };
}
