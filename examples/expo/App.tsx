// byokit on a phone (iOS and Android): every phone sign-in the catalogue offers, grouped by @byokit/ui's useConnect
// ("Sign in with ChatGPT" via @byokit/accounts' device code, "Sign in with Claude" on its own page, whose code the
// person pastes back, a pasted plan key for a plan with no sign-in such as OpenCode Go), kept in the phone's secure
// storage, @byokit/ui's sheet
// phases; asking either with the answer streaming in (expo/fetch), a decision
// with @byokit/decide's answerer, pairing with a computer over @byokit/pair, and sealing data with @byokit/seal. For a demo with no account, point it
// at the stand-in OpenAI and a link host on this computer (see e2e-android.sh):
//   EXPO_PUBLIC_OPENAI_BASE=http://10.0.2.2:21455 npx expo run:android   (after `npm run mock` in this folder)
//   EXPO_PUBLIC_DEVICE_BASE / EXPO_PUBLIC_CLAUDE_BASE override the device-flow and Claude plan endpoints; unset uses the real providers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { UsageDemo } from './UsageDemo.tsx';
import { CloudM6Demo } from './CloudM6Demo.tsx';
import { ScreenDemo } from './ScreenDemo.tsx';
import { ShareDemo } from './ShareDemo.tsx';
import { InferDemo } from './InferDemo.tsx';
import { Linking, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, StatusBar as NativeStatusBar, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';
import { fetch as streamingFetch } from 'expo/fetch';
import { Accounts, PROVIDERS, planLabel, routeReadiness, say, secureStore, type OpenCodeGoWorkspace, type Status } from '@byokit/accounts';
import { nativeStore } from '@byokit/secrets';
import { answerer, decide } from '@byokit/decide';
import { DeviceLink, secureDeviceStore, type LinkStatus } from '@byokit/pair';
import { boxKeyPairFromSeed, openBox, openSecretBox, sealBox, sealSecretBox, signDetached, signingKeyPairFromSeed, verifyDetached } from '@byokit/seal';
import { forgettableStore, pairInput, pairingGeneration } from './pairing.ts';
import { setupKey, setupProvider, setupWords } from './cloud-setup.ts';
import { errorWords, MachineError, type MachineStore } from '@byokit/cloud';
import { accountsSource, linkWords, pairingView, useAccounts, useConnect, useModelPicker, useSignIn, type ConnectAction, type ConnectView, type ModelPickerSource, type PairPhase, type UseModelPicker, type UseSignIn } from '@byokit/ui';
import { overlay, stateWords, type OverlayState } from '@byokit/bubble';
import { stateWords as chipWords, status as chip } from '@byokit/statusbar';
import { focusedField } from '@byokit/bubble/focused-field';

const ME = 1;
const claudeBase = process.env.EXPO_PUBLIC_CLAUDE_BASE;
const accounts = new Accounts<any, number>({
  app: 'byokit example',
  store: (member) => secureStore(SecureStore, `byokit.${member}`),
  keyStore: (member) => nativeStore({ secureStore: SecureStore, prefix: `byokit.keys.${member}` }), // pasted plan keys
  authBase: process.env.EXPO_PUBLIC_OPENAI_BASE, // unset: the real OpenAI
  apiBase: process.env.EXPO_PUBLIC_OPENAI_BASE,
  deviceBase: process.env.EXPO_PUBLIC_DEVICE_BASE,
  fetch: streamingFetch as unknown as typeof fetch, // streams; React Native's own fetch answers all at once
  // Claude's sign-in needs SHA-256, which React Native doesn't have; expo-crypto supplies it.
  claudePlan: { ...(claudeBase ? {
    authorizeUrl: `${claudeBase}/oauth/authorize`, tokenUrl: `${claudeBase}/v1/oauth/token`, profileUrl: `${claudeBase}/api/oauth/profile`,
  } : {}), crypto: { getRandomValues, subtle: { digest: (_: unknown, data: BufferSource) => digest(CryptoDigestAlgorithm.SHA256, data) } } as unknown as Crypto },
});
/** Phone sign-ins use the offered provider identities; route metadata supplies the method and billing. A provider
 *  with no phone sign-in connects through its plan key route, if it has one. */
const phoneRoutes = accounts.providers.flatMap((p) => {
  const mine = accounts.routes().filter((r) => r.platforms.rn === 'yes' && (r.upstream.id === p.pi || r.name === p.name));
  const r = mine.find((r) => r.via === 'code' || r.via === 'paste') ?? mine.find((r) => r.via === 'plan_key');
  return r ? [{ ...routeReadiness(r, { platform: 'rn' }), id: r.id, provider: p.key, name: p.name }] : [];
});
/** ChatGPT keeps its first testIDs (e2e-android.sh); other providers carry a prefix. */
const tid = (key: string, id: string) => key === 'chatgpt' ? id : `${key}-${id}`;
const deviceStore = secureDeviceStore(SecureStore, 'byokit.link.home');

function Button({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  const s = useStyles();
  return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={s.button}><Text style={s.buttonText}>{label}</Text></Pressable>;
}

function SignInSheet({ k, options, onClose }: { k: string; options: UseSignIn; onClose: () => void }) {
  const s = useStyles();
  const { name } = PROVIDERS[k];
  const [pasted, setPasted] = useState('');
  const sheet = useSignIn(options);
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

/** A plan key, typed hidden and handed straight to the kit (`add` on the key route), never kept on screen. A key that
 *  acts for several workspaces lists them (the kit asks the provider) and is saved with the one picked. */
function KeySheet({ k, route, card, act, onClose }: { k: string; route: string; card: NonNullable<NonNullable<ConnectView['chosen']>['key']>;
  act: (a: ConnectAction) => void; onClose: () => void }) {
  const s = useStyles();
  const [pasted, setPasted] = useState('');
  const [workspaces, setWorkspaces] = useState<OpenCodeGoWorkspace[]>([]);
  const [error, setError] = useState('');
  const save = async (workspace?: string) => {
    const key = pasted.trim();
    if (!key) return;
    setError(''); act({ type: 'submit' });
    try {
      const added = await accounts.add(ME, route, { key, ...(workspace ? { workspace } : {}) });
      if (added.workspaces?.length) { setWorkspaces(added.workspaces); act({ type: 'result', result: 'workspace' }); return; }
      setPasted(''); act({ type: 'result', result: 'ok' }); onClose();
    } catch (e: any) { setError(e.message); act({ type: 'result', result: 'invalid' }); }
  };
  return (
    <View testID={tid(k, 'sheet')} style={s.sheet}>
      <Text style={s.small}>{card.label}</Text>
      <Text testID={tid(k, 'key-status')} style={s.words}>{error || card.message}</Text>
      {card.state === 'workspace' ? workspaces.map((w, i) =>
        <Button key={w.id} id={tid(k, `workspace-${i}`)} label={w.name} onPress={() => save(w.id)} />)
        : card.editable && <>
          <TextInput testID={tid(k, 'paste')} value={pasted} onChangeText={setPasted} placeholder="Paste the key from your plan"
            autoCapitalize="none" autoCorrect={false} secureTextEntry style={s.input} />
          <Button id={tid(k, 'connect')} label="Connect" onPress={() => save()} />
        </>}
      <Button id={tid(k, 'close')} label="Close" onPress={() => { setPasted(''); onClose(); }} />
    </View>
  );
}

/** Ask the signed-in plan, the answer streaming in; then (ChatGPT) a yes/no decision on the same question. */
function Ask({ k, picker }: { k: string; picker: UseModelPicker }) {
  const s = useStyles();
  const { name } = PROVIDERS[k];
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [decision, setDecision] = useState('');
  const ask = async () => {
    setAnswer(''); setDecision('');
    const chosen = picker.picker;
    if (!chosen?.ok) {
      setAnswer(chosen?.rows.find((r) => r.selected)?.detail || 'Choose an available account.');
      return;
    }
    const select = { account: chosen.account! };
    const model = chosen.model!;
    const onText = (d: string) => setAnswer((a) => a + d);
    try {
      if (k === 'claude') {
        setAnswer(await accounts.respond(ME, { provider: 'claude', select, model, max_tokens: 1024,
          system: 'Answer in a few short sentences.', messages: [{ role: 'user', content: question }], onText }));
        return;
      }
      const finished = await accounts.respond(ME, { select, model, instructions: 'Answer in one short sentence.', input: question, onText });
      setAnswer(finished);
      const { urgent } = await decide({ text: question }, { urgent: { kind: 'yesno', question: 'Does this need doing today?' } }, {
        privacy: 'may-leave',
        backends: [answerer({ name: 'chatgpt', leaves: true, ask: (p, signal) => accounts.respond(ME, { select, model, instructions: 'Reply with JSON only.', input: p, signal }) })],
      });
      setDecision(urgent.abstained ? 'Not sure if it needs doing today.' : urgent.answer ? 'Needs doing today.' : 'Can wait.');
    } catch (e: any) { setAnswer(e.message); }
  };
  return (
    <>
      {/* multiline: the question and its placeholder wrap instead of clipping when the system font is large */}
      <TextInput testID={tid(k, 'question')} value={question} onChangeText={setQuestion} placeholder={`Ask ${name} something`} multiline style={s.input} />
      <Button id={tid(k, 'ask')} label="Ask" onPress={ask} />
      {!!answer && <Text testID={tid(k, 'answer')} style={s.words}>{answer}</Text>}
      {!!decision && <Text testID="decision" style={s.small}>{decision}</Text>}
    </>
  );
}

/** Both hooks read the same provider scope; the kit owns room words, Auto and refusal reasons.
 * No usage reader is configured here, so room is honestly unknown, never an invented percentage. */
function providerSource(k: string): ModelPickerSource {
  const room = () => ({ left: 'unknown' as const });
  const base = accountsSource(accounts, ME, room);
  return { ...base,
    accounts: async () => (await base.accounts()).filter((a) => a.provider === k),
    auto: () => accounts.pick(ME, { account: 'auto', provider: k }, room) };
}

function ProviderAccounts({ k, connected }: { k: string; connected: boolean }) {
  const s = useStyles();
  const source = useMemo(() => providerSource(k), [k]);
  const list = useAccounts(source);
  const pick = useModelPicker(source);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    refreshers.set(`rooms:${k}`, () => { void list.refresh(); void pick.refresh(); });
    return () => { refreshers.delete(`rooms:${k}`); };
  }, [k, list.refresh, pick.refresh]);
  const view = pick.picker;
  const chosen = view?.rows.find((r) => r.selected);
  const error = list.error ?? pick.error;
  if (!list.rows.length && !error) return null;
  return (
    <View testID={tid(k, 'accounts')} style={s.sheet}>
      <Text style={s.name}>Accounts</Text>
      {[...list.rows].sort((a, b) => Number(b.state === 'ready') - Number(a.state === 'ready')).map((r) => <View key={r.id}>
        <Text style={s.words}>{r.title}</Text>
        <Text style={s.small}>{r.state === 'ready' ? 'Ready · ' : ''}{r.detail}</Text>
      </View>)}
      {!!error && <Text style={s.words}>{error instanceof Error ? error.message : String(error)}</Text>}
      {!!view && <>
        <Pressable testID={tid(k, 'picker')} accessibilityRole="button" accessibilityState={{ expanded: open }}
          style={s.choice} onPress={() => setOpen(!open)}>
          <Text style={s.words}>{chosen?.title ?? 'Choose an account and model'} {open ? '−' : '+'}</Text>
        </Pressable>
        {open && view.rows.map((r, i) => <View key={r.key}>
          <Pressable testID={tid(k, `pick-${i}`)} accessibilityRole="button" style={s.choice}
            accessibilityState={{ selected: r.selected, disabled: r.disabled }} disabled={r.disabled}
            onPress={() => pick.select({ account: r.key })}>
            <Text style={s.words}>{r.selected ? '✓ ' : ''}{r.title}</Text>
            {!!r.detail && <Text style={s.small}>{r.detail}</Text>}
          </Pressable>
          {r.kind === 'account' && r.models.map((m, j) => <Pressable key={m.id} testID={tid(k, `model-${i}-${j}`)}
            accessibilityRole="button" style={s.choice} accessibilityState={{ selected: r.selected && m.selected }}
            onPress={() => pick.select({ account: r.key, model: m.id })}>
            <Text style={s.small}>{r.selected && m.selected ? '✓ ' : ''}{m.name}{m.available ? '' : ` · ${r.detail || 'Unavailable'}`}</Text>
          </Pressable>)}
        </View>)}
        {!open && !!chosen?.detail && <Text testID={tid(k, 'pick-reason')} style={s.small}>{chosen.detail}</Text>}
      </>}
      {connected && (k === 'chatgpt' || k === 'claude') && <Ask k={k} picker={pick} />}
    </View>
  );
}

/** One plan: signed out, signing in, or a connected card naming the plan ("Claude Max"), with Ask and a quiet sign-out. */
function Plan({ k, options, keyCard, onPick, onClose }: { k: string; options?: UseSignIn; onPick: () => void; onClose: () => void;
  keyCard?: { route: string; card: NonNullable<NonNullable<ConnectView['chosen']>['key']>; act: (a: ConnectAction) => void } }) {
  const s = useStyles();
  const { name } = PROVIDERS[k];
  const [status, setStatus] = useState<Status | null>(null);
  const [plan, setPlan] = useState<{ plan: string; email: string } | null>(null);
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
      {!options && !keyCard && <ProviderAccounts k={k} connected={signedIn(status)} />}
      {options ? <SignInSheet key={k} k={k} options={options} onClose={() => { onClose(); refresh(); }} />
        : keyCard ? <KeySheet key={k} k={k} {...keyCard} onClose={() => { onClose(); refresh(); }} />
        : signedIn(status) ? <>
          {k === 'chatgpt' && <Button id="recheck" label="Check the sign-in" onPress={async () => {
            // Forces a refresh (the token rotates): what the app does when ChatGPT turns a request away.
            setNote((await accounts.recheck(ME, k)) ? 'Still signed in: the sign-in was refreshed.' : 'Signed out.');
            refresh();
          }} />}
          <Pressable testID={tid(k, 'signout')} accessibilityRole="button" onPress={async () => { await accounts.logout(ME, k); setNote(''); refresh(); }}>
            <Text style={s.quiet}>Sign out</Text>
          </Pressable>
        </> : <Button id={tid(k, 'signin')} label={`Sign in with ${name}`} onPress={onPick} />}
    </View>
  );
}
const refreshers = new Map<string, () => void>();
/** Signed in, even while resting or when the plan lacks something: Ask says why, and Sign out stays. */
const signedIn = (s: Status | null) => s?.state === 'ready' || s?.state === 'resting' || s?.state === 'not_included';

/** The cloud computer key: paste the Boat key once; the phone checks it (one
 * identity read, no machine, no spend) and keeps it in its own secure store.
 * The input clears on submit, so the key never stays on screen or in a screenshot. */
const CLOUD_RECORD = 'byokit.cloud.record';
function CloudSetup() {
  const s = useStyles();
  const [pasted, setPasted] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('Make a key on the Boat site, then paste it here.');
  const [stored, setStored] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    SecureStore.getItemAsync(CLOUD_RECORD).then((r) => {
      if (!alive.current) return;
      if (r !== null) { setStored(true); setMessage('A cloud key is saved on this phone.'); }
    }, () => {});
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);
  const store: MachineStore = {
    load: async () => JSON.parse(await SecureStore.getItemAsync(CLOUD_RECORD) ?? 'null'),
    save: async (r) => SecureStore.setItemAsync(CLOUD_RECORD, JSON.stringify(r),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  };
  const connect = async () => {
    if (checking) return;
    const entered = pasted.trim();
    if (entered === '' && stored) return;
    setPasted('');
    const signal = new AbortController();
    abort.current = signal;
    setChecking(true); setMessage('Checking the key…');
    try {
      const result = await setupKey({
        provider: setupProvider({ label: 'Boat', key: entered, baseUrl: process.env.EXPO_PUBLIC_BOAT_BASE,
          fetch: streamingFetch as unknown as typeof fetch, signal: signal.signal }),
        store, key: entered, signal: signal.signal,
      });
      if (!alive.current) return;
      if (result.ok) { setStored(true); setMessage('Cloud key saved on this phone.'); }
      else setMessage(setupWords(result.why, 'Boat'));
    } catch (e: any) {
      if (!alive.current) return;
      setMessage(e instanceof MachineError ? errorWords(e, { app: 'byokit example', label: 'Boat' }) : `Couldn't save the key.`);
    } finally {
      if (alive.current) setChecking(false);
    }
  };
  const remove = async () => {
    await SecureStore.deleteItemAsync(CLOUD_RECORD).catch(() => {});
    if (await SecureStore.getItemAsync(CLOUD_RECORD).catch(() => true)) { setMessage(`Couldn't remove the key.`); return; }
    setStored(false); setMessage('Cloud key removed. Make a key on the Boat site, then paste it here.');
  };
  return (
    <View testID="cloud-setup" style={s.sheet}>
      <Text style={s.name}>Cloud computer</Text>
      <Text testID="cloud-status" style={s.words}>{message}</Text>
      {checking ? <>
        <Button id="cloud-cancel" label="Cancel" onPress={() => abort.current?.abort()} />
      </> : <>
        <TextInput testID="cloud-paste" value={pasted} onChangeText={setPasted} placeholder="Paste the Boat key"
          autoCapitalize="none" autoCorrect={false} secureTextEntry style={s.input} />
        <Button id="cloud-connect" label={stored ? 'Replace the key' : 'Connect'} onPress={connect} />
        {stored && <Button id="cloud-remove" label="Remove the key" onPress={remove} />}
      </>}
    </View>
  );
}

/** Pair with a computer from its pairing code (scanned or pasted), compare the two words, then use the link. */
function Pair() {
  const s = useStyles();
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
        <TextInput testID="hostUrl" value={hostUrl} onChangeText={setHostUrl} placeholder="Computer address for typed codes" autoCapitalize="none" autoCorrect={false} style={s.input} />
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
  const s = useStyles();
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
  const s = useStyles();
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
  if (process.env.EXPO_PUBLIC_CLOUD_M6 === '1') return <CloudM6Demo accounts={accounts} />;
  if (process.env.EXPO_PUBLIC_USAGE_DEMO === '1') return <UsageDemo />;
  if (process.env.EXPO_PUBLIC_SHARE_DEMO === '1') return <ShareDemo />;
  if (process.env.EXPO_PUBLIC_INFER_DEMO === '1') return <InferDemo />;
  return process.env.EXPO_PUBLIC_SCREEN_DEMO === '1' ? <ScreenDemo /> : <KitDemo />;
}

function KitDemo() {
  const s = useStyles();
  const connect = useConnect({
    routes: phoneRoutes,
    read: async ({ provider: k }) => ({ ready: await accounts.signedIn(ME, k), work: (await accounts.plan(ME, k))?.work, signIn: accounts.view(ME, k) }),
    start: ({ provider: k }, body) => accounts.login(ME, k, body),
    cancel: async ({ provider: k }) => accounts.cancel(ME, k),
    offline: () => false, ms: 500,
  });
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
    accounts.onChange = (_member, key) => {
      refreshers.get(key)?.();
      for (const [id, refresh] of refreshers) if (id.startsWith('rooms:')) refresh();
    };
    Promise.all(accounts.providers.map((p) => accounts.signedIn(ME, p.key))).then(() => accounts.keepFresh([ME]));
  }, []);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: s.screen.backgroundColor,
      paddingTop: Platform.OS === 'android' ? NativeStatusBar.currentHeight : 0, paddingBottom: Platform.OS === 'android' ? 24 : 0 }}><StatusBar style={useColorScheme() === 'dark' ? 'light' : 'dark'} /><ScrollView contentContainerStyle={s.screen} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>Umer's AI plans</Text>
      <Text style={s.small}>Sign in with a plan you already pay for. Your sign-ins stay on this phone.</Text>
      {connect.groups.map((group) => <View key={group.id} testID={`connect-${group.id}`} style={s.sheet}>
        <Text style={s.name}>{group.title}</Text>
        <Text style={s.small}>{group.note}</Text>
        {group.rows.map((row) => <View key={row.key}>
          <Text style={s.small}>{row.billingWords} · {row.method}</Text>
          <Plan k={row.provider} options={connect.chosen?.row.key === row.key ? connect.signIn : undefined}
            keyCard={connect.chosen?.row.key === row.key && connect.chosen.key ? { route: row.id, card: connect.chosen.key, act: connect.act } : undefined}
            onPick={() => connect.pick(row.key)} onClose={connect.back} />
        </View>)}
      </View>)}
      <Pair />
      <CloudSetup />
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
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  choice: { minHeight: 44, paddingVertical: 10, gap: 4 },
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
const dark = StyleSheet.create({
  ...s,
  screen: { ...s.screen, backgroundColor: '#161616' },
  card: { ...s.card, backgroundColor: '#161616', borderColor: '#444' },
  sheet: { ...s.sheet, backgroundColor: '#252525' },
  input: { ...s.input, backgroundColor: '#161616', color: '#eee' },
  title: { ...s.title, color: '#eee' }, name: { ...s.name, color: '#eee' },
  words: { ...s.words, color: '#eee' }, code: { ...s.code, color: '#eee' },
  small: { ...s.small, color: '#bbb' }, quiet: { ...s.quiet, color: '#bbb' },
});
const useStyles = () => useColorScheme() === 'dark' ? dark : s;
