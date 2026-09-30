// byokit on a phone (iOS and Android): "Sign in with ChatGPT" (@byokit/accounts' device code, kept in the phone's
// secure storage, @byokit/ui-core's sheet phases), asking it with the answer streaming in (expo/fetch), a decision
// with @byokit/decide's answerer, pairing with a computer over @byokit/link, and sealing data with @byokit/seal. For a demo with no account, point it
// at the stand-in OpenAI and a link host on this computer (see e2e-android.sh):
//   EXPO_PUBLIC_OPENAI_BASE=http://10.0.2.2:21455 npx expo run:android   (after `npm run mock` in this folder)
import { useEffect, useRef, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fetch as streamingFetch } from 'expo/fetch';
import { Accounts, say, secureStore, type Status } from '@byokit/accounts';
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
});
const deviceStore = secureDeviceStore(SecureStore, 'byokit.link.home');

function Button({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={s.button}><Text style={s.buttonText}>{label}</Text></Pressable>;
}

function SignInSheet({ onClose }: { onClose: () => void }) {
  const sheet = useSignIn({
    read: async () => ({ ready: await accounts.signedIn(ME, 'chatgpt'), work: (await accounts.plan(ME))?.work, signIn: accounts.view(ME, 'chatgpt') }),
    start: (body) => accounts.login(ME, 'chatgpt', body),
    cancel: async () => accounts.cancel(ME, 'chatgpt'),
    offline: () => false,
    ms: 500,
  });
  useEffect(() => { if (sheet.phase === 'done' || sheet.phase === 'work') onClose(); }, [sheet.phase]);
  const failed = accounts.view(ME, 'chatgpt')?.error;
  return (
    <View testID="sheet" style={s.sheet}>
      <Text testID="phase" style={s.small}>{sheet.phase}</Text>
      {sheet.phase === 'opening' && <Text style={s.words}>{say('signIn.opening', { name: 'ChatGPT' })}</Text>}
      {sheet.phase === 'code' && <>
        <Text style={s.words}>On the ChatGPT page, type this code:</Text>
        <Text testID="code" selectable style={s.code}>{sheet.code}</Text>
        <Button id="open" label="Open ChatGPT" onPress={() => Linking.openURL(sheet.url!)} />
      </>}
      {(sheet.phase === 'failed' || sheet.phase === 'expired' || sheet.phase === 'cancelled') && <>
        <Text testID="failed" style={s.words}>{failed ?? say('signIn.cancelled')}</Text>
        <Button id="again" label="Sign in with ChatGPT" onPress={() => sheet.start()} />
      </>}
      <Button id="close" label="Close" onPress={() => { sheet.close(); onClose(); }} />
    </View>
  );
}

/** Ask the signed-in ChatGPT, the answer streaming in; then a yes/no decision on the same question. */
function Ask() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [decision, setDecision] = useState('');
  const ask = async () => {
    setAnswer(''); setDecision('');
    try {
      const finished = await accounts.respond(ME, { instructions: 'Answer in one short sentence.', input: question, onText: (d) => setAnswer((a) => a + d) });
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
      <TextInput testID="question" value={question} onChangeText={setQuestion} placeholder="Ask ChatGPT something" style={s.input} />
      <Button id="ask" label="Ask" onPress={ask} />
      {!!answer && <Text testID="answer" style={s.words}>{answer}</Text>}
      {!!decision && <Text testID="decision" style={s.small}>{decision}</Text>}
    </View>
  );
}

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
  const [status, setStatus] = useState<Status | null>(null);
  const [plan, setPlan] = useState('');
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState('');
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
  const refresh = async () => {
    setStatus(await accounts.status(ME, 'chatgpt'));
    const p = await accounts.plan(ME);
    setPlan(p ? `${p.email}, ${p.plan} plan` : '');
  };
  useEffect(() => {
    accounts.onChange = () => { refresh(); };
    accounts.signedIn(ME, 'chatgpt').then(() => accounts.keepFresh([ME])).then(refresh);
  }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}><ScrollView contentContainerStyle={s.screen} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>byokit on {Platform.OS}</Text>
      <Text testID="status" style={s.words}>{status?.words ?? '…'}</Text>
      {!!plan && <Text testID="plan" style={s.small}>{plan}</Text>}
      {!!note && <Text testID="note" style={s.small}>{note}</Text>}
      {signing ? <SignInSheet onClose={() => { setSigning(false); refresh(); }} />
        : status?.state === 'ready' ? <>
          <Button id="recheck" label="Check the sign-in" onPress={async () => {
            // Forces a refresh (the token rotates): what the app does when ChatGPT turns a request away.
            setNote((await accounts.recheck(ME, 'chatgpt')) ? 'Still signed in: the sign-in was refreshed.' : 'Signed out.');
            refresh();
          }} />
          <Button id="signout" label="Sign out" onPress={async () => { await accounts.logout(ME, 'chatgpt'); setNote(''); refresh(); }} />
          <Ask />
        </> : <Button id="signin" label="Sign in with ChatGPT" onPress={() => setSigning(true)} />}
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
  words: { fontSize: 18 },
  small: { fontSize: 14, color: '#555' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 2 },
  sheet: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f2' },
  panel: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17 },
});
