// byokit on a phone (iOS and Android): "Sign in with ChatGPT" (@byokit/accounts' device code) and "Sign in with Claude"
// (its own page, whose code the person pastes back), kept in the phone's secure storage, @byokit/ui-core's sheet
// phases; asking either with the answer streaming in (expo/fetch), a decision
// with @byokit/decide's answerer, pairing with a computer over @byokit/link, and sealing data with @byokit/seal. For a demo with no account, point it
// at the stand-in OpenAI and a link host on this computer (see e2e-android.sh):
//   EXPO_PUBLIC_OPENAI_BASE=http://10.0.2.2:21455 npx expo run:android   (after `npm run mock` in this folder)
import { useEffect, useRef, useState } from 'react';
import { UsageDemo } from './UsageDemo.tsx';
import { ScreenDemo } from './ScreenDemo.tsx';
import { ShareDemo } from './ShareDemo.tsx';
import { Linking, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';
import { fetch as streamingFetch } from 'expo/fetch';
import { Accounts, PROVIDERS, planLabel, say, secureStore, type Status } from '@byokit/accounts';
import { answerer, decide } from '@byokit/decide';
import { DeviceLink, secureDeviceStore, type LinkStatus } from '@byokit/link';
import { boxKeyPairFromSeed, openBox, openSecretBox, sealBox, sealSecretBox, signDetached, signingKeyPairFromSeed, verifyDetached } from '@byokit/seal';
import { forgettableStore, pairInput, pairingGeneration } from './pairing.ts';
import { linkWords, pairingView, useSignIn, type PairPhase } from '@byokit/ui-core';
import { overlay, stateWords, type OverlayState } from '@byokit/overlay';
import { stateWords as chipWords, status as chip } from '@byokit/statusbar';
import { focusedField } from '@byokit/overlay/focused-field';

const ME = 1;
const accounts = new Accounts<any, number>({
  app: 'byokit example',
  store: (member) => secureStore(SecureStore, `byokit.${member}`),
  authBase: process.env.EXPO_PUBLIC_OPENAI_BASE, // unset: the real OpenAI
  apiBase: process.env.EXPO_PUBLIC_OPENAI_BASE,
  fetch: streamingFetch as unknown as typeof fetch, // streams; React Native's own fetch answers all at once
  // Claude's sign-in needs SHA-256, which React Native doesn't have; expo-crypto supplies it.
  claudePlan: { crypto: { getRandomValues, subtle: { digest: (_: unknown, data: BufferSource) => digest(CryptoDigestAlgorithm.SHA256, data) } } as unknown as Crypto },
});
type Key = 'chatgpt' | 'claude';
/** The ChatGPT card keeps its first testIDs (e2e-android.sh); Claude's carry a prefix. */
const tid = (key: Key, id: string) => key === 'chatgpt' ? id : `${key}-${id}`;
const deviceStore = secureDeviceStore(SecureStore, 'byokit.link.home');

function Button({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={s.button}><Text style={s.buttonText}>{label}</Text></Pressable>;
}

function SignInSheet({ k, onClose }: { k: Key; onClose: () => void }) {
  const { name } = PROVIDERS[k];
  const [pasted, setPasted] = useState('');
  const sheet = useSignIn({
    read: async () => ({ ready: await accounts.signedIn(ME, k), work: (await accounts.plan(ME, k))?.work, signIn: accounts.view(ME, k) }),
    start: (body) => accounts.login(ME, k, body),
    cancel: async () => accounts.cancel(ME, k),
    offline: () => false,
    ms: 500,
  });
  useEffect(() => { if (sheet.phase === 'done' || sheet.phase === 'work') onClose(); }, [sheet.phase]);
  const failed = accounts.view(ME, k)?.error;
  return (
    <View testID={tid(k, 'sheet')} style={s.sheet}>
      {sheet.phase === 'opening' && <Text style={s.words}>{say('signIn.opening', { name })}</Text>}
      {sheet.phase === 'code' && <>
        <Text style={s.words}>On the {name} page, type this code:</Text>
        <Text testID={tid(k, 'code')} selectable style={s.code}>{sheet.code}</Text>
        <Button id={tid(k, 'open')} label={`Open ${name}`} onPress={() => Linking.openURL(sheet.url!)} />
      </>}
      {sheet.phase === 'waiting' && <>
        <Text style={s.words}>Sign in on the {name} page, then copy the code it shows and paste it here.</Text>
        <Button id={tid(k, 'open')} label={`Open ${name}`} onPress={() => Linking.openURL(sheet.url!)} />
        <TextInput testID={tid(k, 'paste')} value={pasted} onChangeText={setPasted} placeholder={`Paste the code from the ${name} page`}
          autoCapitalize="none" autoCorrect={false} style={s.input} />
        <Button id={tid(k, 'connect')} label="Connect" onPress={() => {
          if (!pasted.trim()) return;
          try { accounts.paste(ME, k, pasted); setPasted(''); } catch {}
        }} />
      </>}
      {(sheet.phase === 'failed' || sheet.phase === 'expired' || sheet.phase === 'cancelled') && <>
        <Text testID={tid(k, 'failed')} style={s.words}>{failed ?? say('signIn.cancelled')}</Text>
        <Button id={tid(k, 'again')} label={`Sign in with ${name}`} onPress={() => sheet.start()} />
      </>}
      <Button id={tid(k, 'close')} label="Close" onPress={() => { sheet.close(); onClose(); }} />
    </View>
  );
}

/** Ask the signed-in plan, the answer streaming in; then (ChatGPT) a yes/no decision on the same question. */
function Ask({ k }: { k: Key }) {
  const { name } = PROVIDERS[k];
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [decision, setDecision] = useState('');
  const ask = async () => {
    setAnswer(''); setDecision('');
    const onText = (d: string) => setAnswer((a) => a + d);
    try {
      if (k === 'claude') {
        setAnswer(await accounts.respond(ME, { provider: 'claude', model: PROVIDERS.claude.models.strong, max_tokens: 1024,
          system: 'Answer in a few short sentences.', messages: [{ role: 'user', content: question }], onText }));
        return;
      }
      const finished = await accounts.respond(ME, { instructions: 'Answer in one short sentence.', input: question, onText });
      setAnswer(finished);
      const { urgent } = await decide({ text: question }, { urgent: { kind: 'yesno', question: 'Does this need doing today?' } }, {
        privacy: 'may-leave',
        backends: [answerer({ name: 'chatgpt', leaves: true, ask: (p, signal) => accounts.respond(ME, { instructions: 'Reply with JSON only.', input: p, signal }) })],
      });
      setDecision(urgent.abstained ? 'Not sure if it needs doing today.' : urgent.answer ? 'Needs doing today.' : 'Can wait.');
    } catch (e: any) { setAnswer(e.message); }
  };
  return (
    <View style={s.sheet}>
      <TextInput testID={tid(k, 'question')} value={question} onChangeText={setQuestion} placeholder={`Ask ${name} something`} style={s.input} />
      <Button id={tid(k, 'ask')} label="Ask" onPress={ask} />
      {!!answer && <Text testID={tid(k, 'answer')} style={s.words}>{answer}</Text>}
      {!!decision && <Text testID="decision" style={s.small}>{decision}</Text>}
    </View>
  );
}

/** One plan: signed out, signing in, or a connected card naming the plan ("Claude Max"), with Ask and a quiet sign-out. */
function Plan({ k }: { k: Key }) {
  const { name } = PROVIDERS[k];
  const [status, setStatus] = useState<Status | null>(null);
  const [plan, setPlan] = useState<{ plan: string; email: string } | null>(null);
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState('');
  const drawing = useRef(0);
  const refresh = async () => {
    const mine = ++drawing.current;
    const now = await accounts.status(ME, k);
    const named = signedIn(now) ? await accounts.plan(ME, k) : null;
    if (mine !== drawing.current) return; // a later refresh (a sign-out, say) already said how things are
    setStatus(now); setPlan(named);
  };
  useEffect(() => { refreshers.set(k, refresh); refresh(); return () => { refreshers.delete(k); }; }, []);
  return (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={s.name}>{name}</Text>
        {!!plan?.plan && <Text testID={tid(k, 'plan')} style={s.badge}>{planLabel(name, plan.plan)}</Text>}
      </View>
      <Text testID={tid(k, 'status')} style={s.small}>{status?.words ?? '…'}</Text>
      {!!plan?.email && <Text testID={tid(k, 'who')} style={s.small}>Signed in as {plan.email}</Text>}
      {!!note && <Text testID={tid(k, 'note')} style={s.small}>{note}</Text>}
      {signing ? <SignInSheet k={k} onClose={() => { setSigning(false); refresh(); }} />
        : signedIn(status) ? <>
          <Ask k={k} />
          {k === 'chatgpt' && <Button id="recheck" label="Check the sign-in" onPress={async () => {
            // Forces a refresh (the token rotates): what the app does when ChatGPT turns a request away.
            setNote((await accounts.recheck(ME, k)) ? 'Still signed in: the sign-in was refreshed.' : 'Signed out.');
            refresh();
          }} />}
          <Pressable testID={tid(k, 'signout')} accessibilityRole="button" onPress={async () => { await accounts.logout(ME, k); setNote(''); refresh(); }}>
            <Text style={s.quiet}>Sign out</Text>
          </Pressable>
        </> : <Button id={tid(k, 'signin')} label={`Sign in with ${name}`} onPress={() => setSigning(true)} />}
    </View>
  );
}
const refreshers = new Map<Key, () => void>();
/** Signed in, even while resting or when the plan lacks something: Ask says why, and Sign out stays. */
const signedIn = (s: Status | null) => s?.state === 'ready' || s?.state === 'resting' || s?.state === 'not_included';

/** Pair with a computer from its pairing code (scanned or pasted), compare the two words, then use the link. */
function Pair() {
  const [offer, setOffer] = useState('');
  const [hostUrl, setHostUrl] = useState(process.env.EXPO_PUBLIC_LINK_URL ?? '');
  const [phase, setPhase] = useState<PairPhase>('scan');
  const [words, setWords] = useState<string>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<LinkStatus>();
  const [hostName, setHostName] = useState<string>();
  const [reply, setReply] = useState('');
  const link = useRef<DeviceLink | null>(null);
  const kept = useRef(forgettableStore(deviceStore));
  const forgetting = useRef(false);
  const generation = useRef(pairingGeneration());
  const use = (grant: Awaited<ReturnType<typeof pairInput>>, current: number) => {
    if (!generation.current.isCurrent(current)) return;
    setHostName(grant.hostName); setPhase('paired');
    link.current = new DeviceLink(grant, { store: kept.current, onStatus: (s) => { if (generation.current.isCurrent(current)) setStatus(s); } });
  };
  useEffect(() => {
    const current = generation.current.next();
    kept.current.load().then(
      (g) => { if (g) use(g, current); },
      (e) => { if (generation.current.isCurrent(current)) { setError(String(e?.message ?? e)); setPhase('failed'); } },
    );
    return () => { generation.current.next(); link.current?.stop(); };
  }, []);
  const pair = async () => {
    if (forgetting.current) return;
    const current = generation.current.begin();
    if (current === null) return;
    setError(undefined);
    try {
      const grant = await pairInput(offer, hostUrl, { name: `${Platform.OS} phone`, onWords: (w) => {
        if (generation.current.isCurrent(current)) { setWords(w); setPhase('compare'); }
      } });
      if (!generation.current.isCurrent(current)) return;
      use(grant, current);
      await kept.current.save(link.current!.grant);
    } catch (e: any) { if (generation.current.isCurrent(current)) { setError(e.message); setPhase('failed'); } }
    finally { generation.current.finish(); }
  };
  const view = pairingView({ phase, hostName, words, error });
  return (
    <View style={s.sheet}>
      <Text testID="pairing" style={s.words}>{view.title}</Text>
      {!!view.words && <Text testID="words" style={s.code}>{view.words}</Text>}
      {phase === 'paired' ? <>
        {!!status && <Text testID="link" style={s.small}>{linkWords(status, hostName)}</Text>}
        <Button id="ping" label="Ask the computer" onPress={async () => {
          try { setReply(JSON.stringify(await link.current!.request('get.state'))); } catch (e: any) { setReply(e.message); }
        }} />
        {!!reply && <Text testID="reply" style={s.small}>{reply}</Text>}
        <Button id="unpair" label="Forget this computer" onPress={async () => {
          if (forgetting.current) return;
          forgetting.current = true;
          generation.current.next();
          link.current?.stop();
          try {
            await kept.current.forget();
            kept.current = forgettableStore(deviceStore); link.current = null;
            setPhase('scan'); setStatus(undefined); setReply(''); setHostName(undefined); setWords(undefined);
          } catch (e: any) { setError(e.message); }
          finally { forgetting.current = false; }
        }} />
        {!!error && <Text style={s.small}>{error}</Text>}
      </> : <>
        <TextInput testID="offer" value={offer} onChangeText={setOffer} placeholder="Pairing code or link" autoCapitalize="none" autoCorrect={false} style={s.input} />
        <TextInput testID="hostUrl" value={hostUrl} onChangeText={setHostUrl} placeholder="Computer address for typed codes (ws://…)" autoCapitalize="none" autoCorrect={false} style={s.input} />
        <Button id="pair" label="Pair" onPress={pair} />
      </>}
    </View>
  );
}

/**
 * The bubble over other apps (Android): Start/Stop, and a tap opens the panel registered in index.ts. The tap log, and
 * the focused field once the example's accessibility service (modules/a11y-demo) is on: a long press on the bubble
 * reads it in any app.
 */
function Bubble() {
  const [state, setState] = useState<OverlayState>('off');
  const [taps, setTaps] = useState('');
  const [typed, setTyped] = useState('');
  const [field, setField] = useState('');
  useEffect(() => {
    overlay.state().then(setState);
    const offState = overlay.on('state', (e) => setState(e.state));
    const offTap = overlay.on('tap', () => { overlay.logTap({ app: 'io.github.umeranjum17.byokit.example', action: 'tap' }); });
    // A long press reads the field in focus, in any app: the bubble's window never takes the focus.
    const offLong = overlay.on('longPress', async () => {
      const read = await focusedField.read();
      setField(`available: ${await focusedField.available()}, read: ${JSON.stringify(read)}`);
      overlay.say(read ? `Read: ${read.text}` : 'No text field in focus.');
    });
    return () => { offState(); offTap(); offLong(); };
  }, []);
  const start = async () => {
    const s = await overlay.start({
      host: 'window', mood: 'bubble', panel: 'bubblePanel',
      notice: { channel: 'bubble', title: 'byokit example', text: 'The bubble is on.', icon: 'byokit_notification' },
    });
    if (s === 'needs-permission') await overlay.openPermission();
  };
  return (
    <View style={s.sheet}>
      <Text testID="bubble" style={s.words}>{stateWords(state)}</Text>
      {state === 'on' ? <Button id="bubbleStop" label="Stop the bubble" onPress={() => overlay.stop()} />
        : <Button id="bubbleStart" label="Start the bubble" onPress={start} />}
      <Button id="taps" label="Show the taps" onPress={async () => setTaps(JSON.stringify(await overlay.taps()))} />
      {!!taps && <Text testID="tapLog" style={s.small}>{taps}</Text>}
      <Button id="fieldRead" label="Read the focused field" onPress={async () => {
        setField(`available: ${await focusedField.available()}, read: ${JSON.stringify(await focusedField.read())}`);
      }} />
      {!!field && <Text testID="field" style={s.small}>{field}</Text>}
      <TextInput testID="fieldInput" value={typed} onChangeText={setTyped} placeholder="Type here, then read it (above)" style={s.input} />
    </View>
  );
}

/** The panel a bubble tap opens, in its own translucent activity. */
export function BubblePanel() {
  return (
    <View style={s.panel}>
      <View testID="panel" style={s.sheet}>
        <Text style={s.words}>Opened from the bubble.</Text>
        <Button id="panelClose" label="Close" onPress={() => overlay.closePanel()} />
      </View>
    </View>
  );
}

/** One ongoing job as a status-bar chip (@byokit/statusbar): show with three actions, clear, and what came back. */
function Chip() {
  const [said, setSaid] = useState('');
  const [n, setN] = useState(1);
  useEffect(() => {
    const offs = [chip.on('action', (e) => setSaid(`Action: ${e.id}`)), chip.on('dismissed', () => setSaid('Dismissed.'))];
    return () => offs.forEach((off) => off());
  }, []);
  const show = async (busy: number) => {
    if (Platform.OS === 'android') await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
    chip.show({
      title: `Scribe and ${busy} more are working`, text: '2 need you', chip: `${busy} busy`, publicText: `${busy} working · 2 need you`,
      icon: 'byokit_notification', promote: true, timeoutMs: 15 * 60_000,
      actions: [{ id: 'needs', label: 'See what needs you' }, { id: 'ask', label: 'Ask Chief' }, { id: 'open', label: 'Open' }],
    });
    setN(busy + 1);
    setSaid(chipWords(await chip.state()));
  };
  return (
    <View style={s.sheet}>
      <Button id="chip-show" label="Show the chip" onPress={() => show(n)} />
      <Button id="chip-clear" label="Clear the chip" onPress={() => { chip.clear(); setN(1); setSaid('Cleared.'); }} />
      {!!said && <Text testID="chip-said" style={s.small}>{said}</Text>}
    </View>
  );
}

export default function App() {
  if (process.env.EXPO_PUBLIC_USAGE_DEMO === '1') return <UsageDemo />;
  if (process.env.EXPO_PUBLIC_SHARE_DEMO === '1') return <ShareDemo />;
  return process.env.EXPO_PUBLIC_SCREEN_DEMO === '1' ? <ScreenDemo /> : <KitDemo />;
}

function KitDemo() {
  const [sealed, setSealed] = useState('');
  const trySeal = () => {
    try {
      const bytes = new TextEncoder().encode('byokit on a phone');
      const key = crypto.getRandomValues(new Uint8Array(32));
      const box = boxKeyPairFromSeed(key);
      const signer = signingKeyPairFromSeed(key);
      const matches = (opened: Uint8Array | null) => opened !== null && new TextDecoder().decode(opened) === 'byokit on a phone';
      setSealed(matches(openBox(sealBox(bytes, box.publicKey), box.secretKey)) &&
        matches(openSecretBox(sealSecretBox(bytes, key), key)) &&
        verifyDetached(bytes, signDetached(bytes, signer.secretKey), signer.publicKey) ? 'Seal works.' : 'Seal failed.');
    } catch (e) { setSealed(`Seal failed: ${String(e)}`); }
  };
  useEffect(() => {
    accounts.onChange = (_member, key) => { refreshers.get(key as Key)?.(); };
    Promise.all([accounts.signedIn(ME, 'chatgpt'), accounts.signedIn(ME, 'claude')]).then(() => accounts.keepFresh([ME]));
  }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}><ScrollView contentContainerStyle={s.screen} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>Umer's AI plans</Text>
      <Text style={s.small}>Sign in with a plan you already pay for. Your sign-ins stay on this phone.</Text>
      <Plan k="chatgpt" />
      <Plan k="claude" />
      <Pair />
      <Bubble />
      <Chip />
      <Button id="seal" label="Try sealing" onPress={trySeal} />
      {!!sealed && <Text testID="sealed" style={s.small}>{sealed}</Text>}
    </ScrollView></SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: '#fff', padding: 24, paddingTop: 64, gap: 12 },
  input: { fontSize: 17, borderWidth: 1, borderColor: '#bbb', borderRadius: 8, padding: 10, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600' },
  card: { gap: 10, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: '#e4e2dc', backgroundColor: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 19, fontWeight: '600' },
  badge: { fontSize: 13, fontWeight: '600', backgroundColor: '#ecebe6', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden' },
  quiet: { fontSize: 15, color: '#6b6a66', textDecorationLine: 'underline', paddingVertical: 6 },
  words: { fontSize: 18 },
  small: { fontSize: 14, color: '#555' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 2 },
  sheet: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f2' },
  panel: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17 },
});
