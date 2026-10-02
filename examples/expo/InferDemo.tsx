// @byokit/infer in an app (docs/infer-kit.md WP1): download the pinned model once, then summarise a terminal pane on
// this phone. Flipping panes cancels the running summary; the app going to the background releases the model.
// EXPO_PUBLIC_INFER_DEMO=1 opens it; e2e-infer.sh drives it. Demo panes only: nothing here reads a real terminal.
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { initLlama } from 'llama.rn';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { InferError, LocalModel, errorWords, model, stateWords, summarizePane, words, type InferModelStore, type InferState,
  type PaneSummary } from '@byokit/infer';

// Fixed-label diagnostics for the own-lab counterfactual only; never pane text or raw native exception messages.
const PROBE = process.env.EXPO_PUBLIC_INFER_PROBE === '1';
let onReceipt: (label: string) => void = () => {};
const receipt = (label: string) => { if (PROBE) { console.info(`infer-probe ${label}`); onReceipt(label); } };
const DIR = `${RNFS.DocumentDirectoryPath}/models`;
const store: InferModelStore = {
  path: m => `${DIR}/${m.id}.gguf`,
  size: async m => {
    receipt('store.size.begin');
    const size = (await RNFS.exists(store.path(m))) ? Number((await RNFS.stat(store.path(m))).size) : undefined;
    receipt('store.size.done');
    return size;
  },
  download: async (m, o) => {
    receipt('store.mkdir.begin');
    await RNFS.mkdir(DIR);
    receipt('download.request');
    const job = RNFS.downloadFile({ fromUrl: m.url, toFile: store.path(m), progressInterval: 500, progressDivider: 1,
      begin: () => receipt('download.response'),
      progress: p => { receipt('download.progress'); o.onProgress?.(p.bytesWritten, p.contentLength); } });
    const stop = () => RNFS.stopDownload(job.jobId);
    o.signal?.addEventListener('abort', stop, { once: true });
    try {
      const r = await job.promise;
      receipt(`download.status.${r.statusCode}`);
      if (r.statusCode !== 200) throw new Error(`download ${r.statusCode}`);
    } finally { o.signal?.removeEventListener('abort', stop); }
  },
  sha256: async m => { receipt('store.hash.begin'); const hash = await RNFS.hash(store.path(m), 'sha256'); receipt('store.hash.done'); return hash; },
  remove: async m => { if (await RNFS.exists(store.path(m))) await RNFS.unlink(store.path(m)); },
  freeBytes: async () => { receipt('store.space.begin'); const bytes = (await RNFS.getFSInfo()).freeSpace; receipt('store.space.done'); return bytes; },
};

/** Umer's demo panes: what a Herdr agent card shows mid-task. Fixed text, never a real terminal. */
const PANES: { id: string; label: string; lines: string[] }[] = [
  { id: 'tests', label: 'byokit tests', lines: [
    '❯ npm test', '> byokit-monorepo@ test', '> sh scripts/test.sh',
    '✔ install downloads only the pinned URL, verifies size and hash (2.8ms)',
    '✔ one call at a time: a second call is busy (1.7ms)',
    '✖ release stops a running call, frees the context (5003ms)',
    "  'test timed out after 5000ms'",
    'ℹ tests 1862', 'ℹ pass 1836', 'ℹ fail 1',
    '⏺ One test hangs: release() waits for a decode that never stops. Looking at model.ts next.',
  ] },
  { id: 'build', label: 'muxr Android build', lines: [
    '❯ ./gradlew assembleRelease', '> Task :app:mergeReleaseNativeLibs',
    '> Task :app:compileReleaseKotlin FAILED',
    "e: file:///work/muxr/apps/mobile/android/app/src/main/java/MainApplication.kt:41:5 Unresolved reference 'ReactNativeHostWrapper'.",
    'FAILURE: Build failed with an exception.',
    "* What went wrong: Execution failed for task ':app:compileReleaseKotlin'.",
    'BUILD FAILED in 1m 52s', '214 actionable tasks: 31 executed, 183 up-to-date',
  ] },
  { id: 'idle', label: 'idle shell', lines: ['❯', '❯ clear', '❯'] },
];

let onState: (s: InferState) => void = () => {};
const local = new LocalModel({ model: model(), store, initLlama, onState: s => { receipt(`state.${s.phase}`); onState(s); }, device: { platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other' } });

export function InferDemo() {
  const [state, setState] = useState<InferState>(local.state);
  const [pane, setPane] = useState(PANES[0].id);
  const [summary, setSummary] = useState<PaneSummary | null>(null);
  const [said, setSaid] = useState('');
  const [timing, setTiming] = useState('');
  const [receipts, setReceipts] = useState<string[]>([]);
  const install = useRef<AbortController | null>(null);
  const run = useRef<AbortController | null>(null);
  const last = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    onState = setState;
    onReceipt = label => setReceipts(previous => [...previous.slice(-11), label]);
    void local.check().catch(fail);
    // Backgrounded: stop work and free the native context; nothing runs in the background.
    const sub = AppState.addEventListener('change', s => { if (s !== 'active') { run.current?.abort(new Error('background')); void local.release().catch(fail); } });
    return () => { onState = () => {}; onReceipt = () => {}; sub.remove(); };
  }, []);

  const fail = (e: unknown) => {
    receipt(`exception.${e instanceof InferError ? e.code : e instanceof Error ? 'untyped-error' : 'untyped-value'}`);
    setSaid(e instanceof InferError ? errorWords(e) : words('infer.failed'));
  };

  const download = async () => {
    receipt('download.handler');
    setSaid('');
    install.current = new AbortController();
    try { receipt('install.request'); await local.install({ signal: install.current.signal }); receipt('install.done'); }
    catch (e) { fail(e); } finally { install.current = null; }
  };

  const summarize = async (id: string) => {
    run.current?.abort(new Error('flipped'));
    const ctl = new AbortController();
    run.current = ctl;
    setSummary(null); setSaid(''); setTiming('');
    // A cancelled call rejects only once the native decode has stopped; wait for it instead of reporting busy.
    const previous = last.current;
    let started = 0;
    const job = previous.then(() => {
      started = Date.now();
      return ctl.signal.aborted ? undefined : summarizePane(local, PANES.find(p => p.id === id)!.lines, { signal: ctl.signal });
    });
    last.current = job.catch(() => {});
    try {
      const r = await job;
      if (!r || ctl.signal.aborted) return;
      if (ctl.signal.aborted) return;
      setSummary(r);
      setTiming(`${Date.now() - started} ms on this phone${r.ok ? ` · ${r.ms} ms generating` : ''}`);
    } catch (e) { if (!ctl.signal.aborted) fail(e); }
  };

  const flip = (id: string) => { setPane(id); if (state.phase === 'ready' || state.phase === 'installed' || state.phase === 'busy') void summarize(id); };
  const installed = ['installed', 'loading', 'ready', 'busy'].includes(state.phase);
  const button = (id: string, label: string, onPress: () => void) =>
    <Pressable key={id} testID={id} accessibilityRole="button" onPressIn={() => receipt(`press-in.${id}`)}
      onPress={() => { receipt(`press.${id}`); onPress(); }} style={s.button}><Text style={s.buttonText}>{label}</Text></Pressable>;

  return <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={s.screen}>
    <Text style={s.small}>Umer’s panes</Text><Text style={s.title}>On-device summary</Text>
    <Text style={s.small}>{`${model().label} · ${model().licence} · stays on this phone`}</Text>
    <Text testID="infer-phase" style={s.small}>{state.phase}</Text>
    <Text testID="infer-state" style={s.note}>{stateWords(state) || 'Summarising on this phone…'}</Text>
    {PROBE && <Text testID="infer-probe" style={s.small}>{receipts.join(' → ')}</Text>}
    {!!said && <Text testID="infer-error" accessibilityRole="alert" style={s.note}>{said}</Text>}
    <View style={s.row}>
      {state.phase === 'not-installed' || state.phase === 'failed' ? button('infer-download', 'Download model', download) : null}
      {state.phase === 'installing' ? button('infer-cancel-download', 'Stop download', () => install.current?.abort(new Error('stopped'))) : null}
      {installed ? button('infer-remove', 'Remove model', () => { run.current?.abort(new Error('removed')); void local.remove().catch(fail); }) : null}
    </View>
    <View style={s.tabs}>{PANES.map(p => <Pressable key={p.id} testID={`infer-pane-${p.id}`} accessibilityRole="button" accessibilityState={{ selected: p.id === pane }}
      onPress={() => flip(p.id)} style={[s.tab, p.id === pane && s.selected]}><Text style={[s.tabText, p.id === pane && s.selectedText]}>{p.label}</Text></Pressable>)}</View>
    <View testID="infer-card" style={s.card}>
      {summary?.ok ? summary.lines.map((l, i) => <Text key={i} testID={`infer-line-${i}`} style={s.text}>{l}</Text>)
        : summary ? <Text testID="infer-none" style={s.small}>{words(summary.code === 'not-enough-output' ? 'infer.notEnough' : summary.code === 'incomplete' ? 'infer.incomplete' : 'infer.failed')}</Text>
        : state.phase === 'busy' ? <Text style={s.small}>Summarising…</Text>
        : <Text style={s.small}>{installed ? 'Pick a pane, or summarise this one.' : 'Download the model first.'}</Text>}
      {summary?.ok && <Text style={s.small}>{words('infer.summaryLabel', { time: new Date().toLocaleTimeString() })}</Text>}
      {!!timing && <Text testID="infer-timing" style={s.small}>{timing}</Text>}
    </View>
    <View style={s.row}>
      {installed ? button('infer-summarize', 'Summarise', () => void summarize(pane)) : null}
      {state.phase === 'busy' ? button('infer-cancel', 'Cancel', () => run.current?.abort(new Error('cancelled'))) : null}
    </View>
    <View style={s.pane}>{PANES.find(p => p.id === pane)!.lines.map((l, i) => <Text key={i} style={s.mono}>{l}</Text>)}</View>
  </ScrollView></SafeAreaView>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' }, screen: { padding: 24, paddingTop: 44, gap: 10 },
  title: { fontSize: 30, fontWeight: '700', color: '#172c43' }, small: { fontSize: 14, color: '#52677d', lineHeight: 21 },
  note: { backgroundColor: '#edf3f9', padding: 12, borderRadius: 12, fontSize: 13, lineHeight: 20, color: '#172c43' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { backgroundColor: '#214f79', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10 }, buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginVertical: 6 }, tab: { borderRadius: 20, borderWidth: 1, borderColor: '#c1d1e2', paddingHorizontal: 12, paddingVertical: 8 },
  selected: { backgroundColor: '#214f79', borderColor: '#214f79' }, tabText: { color: '#172c43', fontSize: 13 }, selectedText: { color: '#fff' },
  card: { borderWidth: 1, borderColor: '#d9e4ef', borderRadius: 14, padding: 14, gap: 4, minHeight: 120 },
  text: { fontSize: 15, color: '#172c43', lineHeight: 22 },
  pane: { backgroundColor: '#1b1b1a', borderRadius: 12, padding: 12, gap: 2 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, color: '#e8e6df' },
});
