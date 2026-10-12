import { useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter, Pressable, SafeAreaView, ScrollView, StatusBar, Text, TextInput } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';
import { boat, machine, type MachineRecord } from '@byokit/cloud';
import { DeviceLink, pairWithOffer, secureDeviceStore } from '@byokit/pair';
import { ClaudePlanExpiredError, ResponseError, type Accounts } from '@byokit/accounts';
import { claudeToolCall, cloudRecipe, diagnostic, stopAndRemove, M6_API, M6_KEY, pairedTurn, trialBudget } from './cloud-m6.ts';
// One create and one turn per approved run: the build names the run, so an approved retry starts clean (pm clear is blocked on some phones).
const run = process.env.EXPO_PUBLIC_M6_RUN ? '.' + process.env.EXPO_PUBLIC_M6_RUN : '';
const recordKey = 'byokit.m6.machine' + run, identityKey = 'byokit.m6.identity' + run, turnKey = 'byokit.m6.turn' + run;
const store = secureDeviceStore(SecureStore, 'byokit.m6.link');
const readKey = async () => { const key = await SecureStore.getItemAsync(M6_KEY); if (!key) throw new Error('The lab provider key is missing.'); return key; };
export function CloudM6Demo({ accounts }: { accounts: Accounts<any, number> }) {
  useKeepAwake();
  const [note, say] = useState('Checking the lab sign-ins…'), [id, setId] = useState(''), [ready, setReady] = useState(false);
  const [model, setModel] = useState(false), [signins, setSignins] = useState('Reading sign-ins…'), [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false);
  const [signUrl, setSignUrl] = useState(''), [code, setCode] = useState('');
  const link = useRef<DeviceLink | null>(null), started = useRef(0), budget = useRef<ReturnType<typeof trialBudget> | null>(null);
  const locked = useRef(false), cause = useRef('');
  const api = async (path: string) => {
    const r = await fetch(M6_API + path, { headers: { Authorization: `Bearer ${await readKey()}` }, redirect: 'error' });
    if (!r.ok) throw new Error(`Boat account read returned HTTP ${r.status}.`); return r.json();
  };
  const provider = useRef(boat({ baseUrl: M6_API, label: 'Boat', prices: [], key: readKey, fetch: async (url, init) => {
    const r = await fetch(url, { ...init, redirect: 'error' });
    if (init?.method !== 'GET' && !String(url).endsWith('/sandboxes') && r.status >= 500) {
      cause.current = `Boat returned HTTP ${r.status}; the machine action may have happened. No retry was sent.`; throw new Error(cause.current);
    } return r;
  } })).current;
  const computer = useRef(machine({ provider, store: {
    load: async () => JSON.parse(await SecureStore.getItemAsync(recordKey) ?? 'null'),
    save: async (r: MachineRecord) => { await SecureStore.setItemAsync(recordKey, JSON.stringify(r)); setId(r.ref?.id ?? ''); },
  } })).current;
  useEffect(() => {
    const create = provider.create!;
    provider.create = async o => {
      const old = await SecureStore.getItemAsync(identityKey);
      if (old && old !== o.idempotencyKey) throw new Error('The single lab creation was already attempted.');
      await SecureStore.setItemAsync(identityKey, o.idempotencyKey); return create(o);
    };
    const sub = DeviceEventEmitter.addListener('byokitM6Key', async (key: string) => {
      if (!key) { await purge(); say('Lab key removed.'); return; }
      if (key.length > 8192) { say('The USB key import was invalid.'); return; }
      await SecureStore.setItemAsync(M6_KEY, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      setReady(true); say('Lab key ready. It will be removed after this run.');
    });
    Promise.all([SecureStore.getItemAsync(M6_KEY), accounts.list(1), SecureStore.getItemAsync(identityKey),
      SecureStore.getItemAsync(recordKey)]).then(([key, rows, identity, record]) => {
      setSignins(rows.length ? rows.map(r => `${r.name} (${r.provider}, ${r.state})`).join('; ') : 'none');
      setReady(!!key); setModel(rows.some(r => r.provider === 'claude' && r.state === 'ready')); setAttempted(!!identity); setId(record ? JSON.parse(record).ref?.id ?? '' : '');
      say(key ? 'Lab key ready.' : 'No lab key. Waiting for the approved USB import.');
    }).catch(e => say(e.message));
    return () => { sub.remove(); provider.create = create; link.current?.stop(); };
  }, []);
  const purge = async () => { await SecureStore.deleteItemAsync(M6_KEY); if (await SecureStore.getItemAsync(M6_KEY)) throw new Error('The lab key was not removed.'); setReady(false); };
  const stop = async () => {
    link.current?.stop();
    // A failed removal keeps the key (so `ready`, the Stop button and the watchdog stay live) and shows why.
    await stopAndRemove({
      remove: async () => { const asleep = !!id && (await computer.state()) === 'asleep'; if (computer.ref) { if (!asleep) { await computer.sleep(); say('Cloud computer stopped.'); } await computer.remove(computer.ref.id); say('Cloud computer stopped and removed.'); } },
      purge: async () => { await purge(); await store.clear(); },
    });
    say('Cloud computer stopped and removed. Lab key removed.');
  };
  const act = async (run: () => Promise<void>) => {
    if (locked.current) return; locked.current = true; setBusy(true); cause.current = '';
    try { await run(); } catch (e) { console.warn(diagnostic(e)); const key = await SecureStore.getItemAsync(M6_KEY); say(cause.current || (key ? String((e as Error).message).split(key).join('[private]') : e instanceof ResponseError || e instanceof ClaudePlanExpiredError ? e.message : `Lab step failed (${(e as Error & { code?: string }).code ?? (e as Error).name}).`)); }
    finally { locked.current = false; setBusy(false); }
  };
  // The one approved Claude plan sign-in: Main opens the link and pastes the code here; nothing leaves this phone.
  const claude = async () => { const v = await accounts.login(1, 'claude'); if (!v?.url) throw new Error('Claude did not offer a sign-in link.'); setSignUrl(v.url); say('Open the Claude link, then paste the code.'); };
  const finish = async () => {
    accounts.paste(1, 'claude', code); setCode(''); await accounts.finished(1, 'claude');
    const rows = await accounts.list(1); const ok = rows.some(r => r.provider === 'claude' && r.state === 'ready');
    setSignins(rows.map(r => `${r.name} (${r.provider}, ${r.state})`).join('; ') || 'none'); setModel(ok); setSignUrl('');
    say(ok ? 'Claude sign-in ready.' : 'Claude sign-in did not finish.');
  };
  const create = async () => {
    if (!model) throw new Error('An existing phone-local Claude sign-in is required; no new sign-in is authorized.');
    const l = await api('/limits'), list = await api('/sandboxes?limit=200');
    if (!Array.isArray(list.sandboxes) || list.pageInfo?.hasMore) throw new Error('The complete machine count is unavailable.');
    budget.current = trialBudget(l, list.sandboxes.length); started.current = Date.now(); setAttempted(true);
    say('Creating one cloud computer within the free trial…'); await computer.create({ name: 'm6-' + [...crypto.getRandomValues(new Uint8Array(8))].map(n => n.toString(16).padStart(2, '0')).join(''), size: 'small', keepCopies: true });
    say('Cloud computer created. Ready to install.');
  };
  useEffect(() => {
    if (!id || !ready) return;
    const timer = setInterval(() => { if (!locked.current) void act(async () => {
      const l = await api('/limits').catch(() => null);
      if (!l) return stop();
      const used = Math.max(0, (budget.current?.remaining ?? 0) - Math.min(l.subscriptionRemainingSeconds, l.creditBalanceSeconds)) + l.liveUsageSeconds;
      if (!budget.current || !Number.isFinite(used) || l.sandboxPlanKey !== 'trial' || Date.now() - started.current > 1200000 ||
          l.subscriptionRemainingSeconds < 900 || used >= Math.min(budget.current.budget, budget.current.stop) - 900) return stop();
      if (used >= budget.current.warn) say('USD 10 warning: stop now.');
    }); }, 15000);
    return () => clearInterval(timer);
  }, [id, ready]);
  const install = async () => {
    say('Installing the cloud host…'); const until = Date.now() + 300000;
    while (await computer.state() !== 'on') { if (Date.now() > until) throw new Error('Cloud creation did not finish within five minutes.'); await new Promise(r => setTimeout(r, 2000)); }
    const url = await computer.url(7300); if (!url) throw new Error('Boat returned no relay address.'); await computer.install(cloudRecipe(url, computer.ref!.name));
    if (await computer.host() !== 'running') throw new Error('The installed cloud host is not running.'); say('Host installed and running. Ready to pair.');
  };
  const pair = async () => {
    const result = await provider.exec(computer.ref!, ['cat', '/home/user/byokit-m6/offer.json'], { timeoutMs: 30000 });
    if (result.code) throw new Error('The cloud host has not published its pairing offer.');
    const grant = await pairWithOffer(JSON.parse(result.stdout).text, { name: 'Umer lab phone', onWords: w => say(`Pairing words: ${w}`) });
    await store.save(grant); link.current = new DeviceLink(grant, { store, onStatus: s => { if (s === 'online') say("Paired with Umer's cloud computer."); } });
    say("Paired with Umer's cloud computer.");
  };
  // No machine, no Boat key: one Claude call shows whether the phone's plan answers, and why not.
  const check = async () => {
    say('Checking Claude…'); const r = await claudeToolCall(accounts);
    say(r.raw.content.some(c => c.type === 'tool_use' && c.name === 'get_machine') ? 'Claude answered with the approved tool call.' : 'Claude answered without the tool call.');
  };
  const turn = async () => {
    if (!link.current) throw new Error('Pair the lab phone first.');
    if (await SecureStore.getItemAsync(turnKey)) throw new Error('The single agent turn was already attempted.');
    await SecureStore.setItemAsync(turnKey, 'attempted'); say('The phone agent is checking the paired cloud computer…');
    const answer = await pairedTurn(accounts, link.current); say(`One paired agent turn completed. ${answer.text}`);
  };
  const button = (name: string, label: string, run: () => Promise<void>, enabled = true) => <Pressable testID={name} accessibilityRole="button" disabled={busy || !enabled} onPress={() => void act(run)} style={{ padding: 14, backgroundColor: '#ddd', opacity: busy || !enabled ? .4 : 1 }}><Text style={{ color: '#111', fontSize: 17 }}>{label}</Text></Pressable>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}><StatusBar barStyle="dark-content" /><ScrollView contentContainerStyle={{ padding: 24, paddingTop: 48, gap: 16 }}>
    <Text style={{ color: '#111', fontSize: 24, fontWeight: '600' }}>Umer's cloud computer</Text><Text style={{ color: '#111' }}>One Boat free-trial lab run. Model sign-in stays on this phone.</Text>
    <Text testID="m6-key" style={{ color: '#111' }}>{ready ? 'Lab key present.' : 'No lab key stored.'}</Text><Text testID="m6-model" style={{ color: '#111' }}>{model ? 'Existing Claude sign-in available.' : 'No Claude sign-in. Main approval needed.'}</Text><Text testID="m6-signins" style={{ color: '#111' }}>{`Sign-ins on this phone: ${signins}`}</Text>
    <Text testID="m6-note" style={{ color: '#111', fontSize: 18 }}>{note}</Text><Text testID="m6-resource" style={{ color: '#111' }} selectable>{id ? `Machine: ${id}` : 'No task machine.'}</Text>
    {!model && !signUrl && button('m6-claude', 'Sign in to Claude', claude)}{model && button('m6-claude-check', 'Check Claude (no machine)', check)}
    {!!signUrl && <><Text testID="m6-claude-url" style={{ color: '#111' }} selectable>{signUrl}</Text>
      <TextInput testID="m6-claude-code" value={code} onChangeText={setCode} secureTextEntry autoCorrect={false} autoCapitalize="none" placeholder="Paste the Claude code" placeholderTextColor="#555" style={{ color: '#111', borderWidth: 1, borderColor: '#888', padding: 12 }} />
      {button('m6-claude-finish', 'Finish sign-in', finish, !!code)}</>}
    {button('m6-create', 'Create', create, ready && model && !attempted)}{button('m6-install', 'Install', install, !!id && ready)}
    {button('m6-pair', 'Pair', pair, !!id && ready)}{button('m6-turn', 'One agent turn', turn, !!id && ready)}
    {button('m6-stop', 'Stop and remove', stop, !!id && ready)}{button('m6-purge', 'Remove lab key', async () => { await purge(); say('Lab key removed.'); })}
  </ScrollView></SafeAreaView>;
}
