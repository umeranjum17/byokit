// "Sign in with ChatGPT" on a phone (iOS and Android), with @byokit/accounts' device-code sign-in kept in the phone's
// secure storage, and @byokit/ui-core's sheet phases. Point it at the stand-in OpenAI for a demo with no account:
//   EXPO_PUBLIC_OPENAI_BASE=http://10.0.2.2:21455 npx expo run:android   (after `npm run mock` in this folder)
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Accounts, say, secureStore, type Status } from '@byokit/accounts';
import { useSignIn } from '@byokit/ui-core';

const ME = 1;
const accounts = new Accounts<any, number>({
  app: 'byokit example',
  store: (member) => secureStore(SecureStore, `byokit.${member}`),
  authBase: process.env.EXPO_PUBLIC_OPENAI_BASE, // unset: the real OpenAI
});

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
    <SafeAreaView style={s.screen}>
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
        </> : <Button id="signin" label="Sign in with ChatGPT" onPress={() => setSigning(true)} />}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', padding: 24, paddingTop: 64, gap: 12 },
  title: { fontSize: 24, fontWeight: '600' },
  words: { fontSize: 18 },
  small: { fontSize: 14, color: '#555' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 2 },
  sheet: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f2' },
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17 },
});
