// byokit on a phone (iOS and Android): "Sign in with ChatGPT" (@byokit/accounts' device code, kept in the phone's
// secure storage, @byokit/ui-core's sheet phases), asking it with the answer streaming in (expo/fetch), a decision
// with @byokit/decide's answerer, and pairing with a computer over @byokit/link. For a demo with no account, point it
// at the stand-in OpenAI and a link host on this computer (see e2e-android.sh):
//   EXPO_PUBLIC_OPENAI_BASE=http://10.0.2.2:21455 npx expo run:android   (after `npm run mock` in this folder)
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fetch as streamingFetch } from 'expo/fetch';
import { Accounts, say, secureStore, type Status } from '@byokit/accounts';
import { answerer, decide } from '@byokit/decide';
import { DeviceLink, secureDeviceStore, type LinkStatus } from '@byokit/link';
import { forgettableStore, pairInput } from './pairing.ts';
import { linkWords, pairingView, useSignIn, type PairPhase } from '@byokit/ui-core';

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
  const use = (grant: Awaited<ReturnType<typeof pairInput>>) => {
    setHostName(grant.hostName); setPhase('paired');
    link.current = new DeviceLink(grant, { store: kept.current, onStatus: setStatus });
  };
  useEffect(() => { kept.current.load().then((g) => g && use(g)); return () => link.current?.stop(); }, []);
  const pair = async () => {
    setError(undefined);
    try {
      use(await pairInput(offer, hostUrl, { name: `${Platform.OS} phone`, onWords: (w) => { setWords(w); setPhase('compare'); } }));
      await kept.current.save(link.current!.grant);
    } catch (e: any) { setError(e.message); setPhase('failed'); }
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
          link.current?.stop();
          try {
            await kept.current.forget();
            kept.current = forgettableStore(deviceStore); link.current = null;
            setPhase('scan'); setStatus(undefined); setReply(''); setHostName(undefined); setWords(undefined);
          } catch (e: any) { setError(e.message); }
          finally { forgetting.current = false; }
        }} />
        {!!error && <Text style={s.small}>{error}</Text>
      </> : <>
        <TextInput testID="offer" value={offer} onChangeText={setOffer} placeholder="Pairing code or link" autoCapitalize="none" autoCorrect={false} style={s.input} />
        <TextInput testID="hostUrl" value={hostUrl} onChangeText={setHostUrl} placeholder="Computer address for typed codes (ws://…)" autoCapitalize="none" autoCorrect={false} style={s.input} />
        <Button id="pair" label="Pair" onPress={pair} />
      </>}
    </View>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [plan, setPlan] = useState('');
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState('');
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
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17 },
});
