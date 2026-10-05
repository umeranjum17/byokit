// @byokit/infer in an app (docs/infer-kit.md WP1): download the pinned model once, then summarise a terminal pane on
// this phone. Flipping panes cancels the running summary; the app going to the background releases the model.
// EXPO_PUBLIC_INFER_DEMO=1 opens it; e2e-infer.sh drives it. Demo panes only: nothing here reads a real terminal.
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { initLlama } from 'llama.rn';
import { requireOptionalNativeModule } from 'expo';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { completionProbe, completionReceiptText } from './infer-probe.ts';
import { REALISTIC_PANE } from './infer-pane-fixture.ts';
import { InferError, LocalModel, NanoModel, type NanoBinding, type NanoRequest, errorWords, model, stateWords, summaryWords, summarizePane, words, type InferModelStore, type InferState,
  type PaneSummary } from '@byokit/infer';

// Fixed-label diagnostics. Separately gated completion receipts below are fixed-synthetic own-lab only.
const PROBE = process.env.EXPO_PUBLIC_INFER_PROBE === '1';
let onReceipt: (label: string) => void = () => {};
const receipt = (label: string) => { if (PROBE) { console.info(`infer-probe ${label}`); onReceipt(label); } };
const DIR = `${RNFS.DocumentDirectoryPath}/models`;
let onCompletionReceipt: (text: string) => void = () => {};
let completionEntries: string[] = [];
async function captureCompletion(entry: Record<string, unknown>) {
  // Fixed synthetic panes only. Request plus result/rejection, bounded in private files and the lab diagnostic log.
  const json = JSON.stringify(entry);
  const bounded = JSON.stringify({ kind: entry.kind, chars: json.length, truncated: json.length > 16384, json: json.slice(0, 16384) });
  completionEntries = entry.kind === 'request' ? [bounded] : [...completionEntries.slice(-1), bounded];
  onCompletionReceipt(completionEntries.join('\n'));
  const chunks = Math.ceil(bounded.length / 512);
  for (let i = 0; i < chunks; i++) console.info(`infer-completion ${entry.kind} ${i + 1}/${chunks} ${bounded.slice(i * 512, (i + 1) * 512)}`);
  try { await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/infer-completion-receipt.txt`, completionEntries.join('\n'), 'utf8'); }
  catch { receipt('completion.capture-file-failed'); }
}
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
    if (o.signal?.aborted) throw new Error('Download cancelled before the request.');
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
  ...(PROBE ? [{ id: 'realistic', label: 'local summary work', lines: REALISTIC_PANE }] : []),
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
const local = new LocalModel({ model: model(), store, initLlama: PROBE ? completionProbe(initLlama, captureCompletion) : initLlama, onState: s => { receipt(`state.${s.phase}`); onState(s); }, device: { platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other' } });

// Gemini Nano through the lab-only ByokitNanoDemo module (modules/nano-demo): AICore's own checkStatus() decides the phase.
// GenAiException codes arrive as `GENAI_<n>` and become the numeric errorCode NanoModel maps; timings go to the lab log.
type NanoDemo = Omit<NanoBinding, 'countTokens' | 'generateContent'> & { countTokens(r: NanoRequest): Promise<{ totalTokens: number }>;
  generateContent(r: NanoRequest): Promise<{ candidates: { text: string; finishReason: number | null }[] }>; lastTiming(): Record<string, number> };
const nanoNative = Platform.OS === 'android' ? requireOptionalNativeModule<NanoDemo>('ByokitNanoDemo') : null;
const coded = <T,>(p: Promise<T>) => p.catch((e: { code?: unknown }) => {
  const n = /^GENAI_(-?\d+)$/.exec(String(e?.code))?.[1];
  throw Object.assign(e instanceof Error ? e : new Error('Gemini Nano error'), n === undefined ? {} : { errorCode: Number(n) });
});
const nanoBinding: NanoBinding | undefined = nanoNative ? {
  checkStatus: () => coded(nanoNative.checkStatus()), getBaseModelName: () => coded(nanoNative.getBaseModelName()),
  getTokenLimit: () => coded(nanoNative.getTokenLimit()), countTokens: r => coded(nanoNative.countTokens(r)),
  cancel: () => nanoNative.cancel(), close: () => nanoNative.close(),
  generateContent: async r => {
    const out = await coded(nanoNative.generateContent(r));
    if (PROBE) {
      const text = out.candidates[0]?.text ?? '';
      // Counted after the timed call, so the stamps cover generation only.
      const tokens = (q: NanoRequest) => nanoNative.countTokens(q).then(c => c.totalTokens, () => -1);
      console.info(`infer-nano-timing ${JSON.stringify({ ...nanoNative.lastTiming(), inputTokens: await tokens(r), outputTokens: await tokens({ text }),
        systemChars: r.systemInstruction?.length ?? 0, promptChars: r.text.length, finishReason: out.candidates[0]?.finishReason })}`);
    }
    return out;
  },
} : undefined;
let onNano: (s: InferState) => void = () => {};
const nano = new NanoModel({ binding: nanoBinding, onState: s => { receipt(`nano.${s.phase}`); onNano(s); } });

export function InferDemo() {
  const [nanoState, setNanoState] = useState<InferState>(nano.state);
  const [state, setState] = useState<InferState>(local.state);
  const [pane, setPane] = useState(PANES[0].id);
  const [summary, setSummary] = useState<PaneSummary | null>(null);
  const [said, setSaid] = useState('');
  const [timing, setTiming] = useState('');
  const [receipts, setReceipts] = useState<string[]>([]);
  const [completionText, setCompletionText] = useState('');
  const debugCompletionText = completionReceiptText(PROBE, __DEV__, completionText);
  const install = useRef<AbortController | null>(null);
  const run = useRef<AbortController | null>(null);
  const last = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    onState = setState;
    onNano = setNanoState;
    void nano.check().catch(fail);
    onReceipt = label => setReceipts(previous => [...previous.slice(-11), label]);
    onCompletionReceipt = setCompletionText;
    void local.check().catch(fail);
    // Backgrounded: stop work and free the native context; nothing runs in the background.
    const sub = AppState.addEventListener('change', s => { if (s !== 'active') { run.current?.abort(new Error('background')); void local.release().catch(fail); void nano.release().catch(fail); } });
    return () => { onState = () => {}; onNano = () => {}; onReceipt = () => {}; onCompletionReceipt = () => {}; sub.remove(); };
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
    catch (e) { if (install.current.signal.aborted) receipt('install.aborted'); else fail(e); }
    finally { install.current = null; }
  };

  const summarize = async (id: string, on: LocalModel | NanoModel = local) => {
    run.current?.abort(new Error('flipped'));
    const ctl = new AbortController();
    run.current = ctl;
    setSummary(null); setSaid(''); setTiming('');
    // A cancelled call rejects only once the native decode has stopped; wait for it instead of reporting busy.
    const previous = last.current;
    let started = 0;
    const job = previous.then(() => {
      started = Date.now();
      return ctl.signal.aborted ? undefined : summarizePane(on, PANES.find(p => p.id === id)!.lines, { signal: ctl.signal });
    });
    last.current = job.catch(() => {});
    try {
      const r = await job;
      if (!r || ctl.signal.aborted) return;
      if (ctl.signal.aborted) return;
      setSummary(r);
      setTiming(`${on === nano ? 'Gemini Nano · ' : ''}${Date.now() - started} ms on this phone${r.ok ? ` · ${r.ms} ms generating` : ''}`);
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
    <Text testID="infer-nano-phase" style={s.small}>{`${nano.id}: ${nanoState.phase}${nanoState.phase === 'unsupported' ? ` (${nanoState.why})` : ''}`}</Text>
    <Text testID="infer-nano-state" style={s.note}>{stateWords(nanoState, { nano: true }) || 'Gemini Nano is answering on this phone…'}</Text>
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
        : summary ? <Text testID="infer-none" style={s.small}>{summaryWords(summary.code)}</Text>
        : state.phase === 'busy' ? <Text style={s.small}>Summarising…</Text>
        : <Text style={s.small}>{installed ? 'Pick a pane, or summarise this one.' : 'Download the model first.'}</Text>}
      {summary?.ok && <Text style={s.small}>{words('infer.summaryLabel', { time: new Date().toLocaleTimeString() })}</Text>}
      {!!timing && <Text testID="infer-timing" style={s.small}>{timing}</Text>}
    </View>
    <View style={s.row}>
      {installed ? button('infer-summarize', 'Summarise', () => void summarize(pane)) : null}
      {nanoState.phase === 'ready' ? button('infer-nano-summarize', 'Summarise with Gemini Nano', () => void summarize(pane, nano)) : null}
      {state.phase === 'busy' ? button('infer-cancel', 'Cancel', () => run.current?.abort(new Error('cancelled'))) : null}
    </View>
    {!!debugCompletionText && <Text testID="infer-completion-receipt" style={s.small}>{debugCompletionText}</Text>}
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
