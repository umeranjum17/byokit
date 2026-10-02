import { useState } from 'react';
import { SafeAreaView, ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { demoView, providers, tokenText, before } from '../usage-demo.ts';
import { planLabel } from '@byokit/usage/view';
import type { Provider } from '@byokit/usage';

export function UsageDemo() {
  const [provider, setProvider] = useState<Provider>('codex');
  const [legacy, setLegacy] = useState(false);
  const view = demoView(provider); const old = before();
  const row = (name: string, value: string) => <View key={name} style={s.row}><Text style={s.text}>{name}</Text><Text style={s.count}>{value}</Text></View>;
  return <SafeAreaView style={s.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={s.screen}>
    <Text style={s.small}>Umer’s plans</Text><Text style={s.title}>Usage</Text><Text style={s.small}>Sample activity · October 1</Text>
    <View style={s.tabs}>{providers.map((p) => <Pressable key={p} testID={`usage-${p}`} accessibilityRole="button" accessibilityState={{ selected: p === provider }} onPress={() => { setProvider(p); setLegacy(false); }} style={[s.tab, p === provider && s.selected]}><Text style={[s.tabText, p === provider && s.selectedText]}>{planLabel(p)}</Text></Pressable>)}</View>
    <Text style={s.heading}>{legacy ? old.label : view.label}</Text>
    <Text style={s.room}>{legacy ? old.room : view.roomText}</Text>
    {legacy ? <>{row('Today', old.today)}<Text style={s.small}>{old.activity}</Text><Text style={s.heading}>Who used this plan</Text>{row('Recorded', old.people)}<Text style={s.note}>Before: reproduced independent selectors on the sample ledger.</Text></> : <>
      <Text style={s.note}>{view.quotaText}</Text>
      {'resetsAt' in view.room && view.room.resetsAt && <Text style={s.small}>Refills October 2 · weekly allowance</Text>}
      {row('Today · recorded', tokenText(view.today))}<Text style={s.heading}>Activity</Text><Text style={s.small}>{view.activity.text}</Text>
      {row('30 days · recorded', tokenText(view.activity))}<Text style={s.heading}>Who used this plan · 30 days</Text>
      {view.people.map((person) => row(person.member === 'umer' ? 'Umer' : 'Another person', tokenText(person)))}
      <Text style={s.heading}>Models · recorded</Text>{view.models.map((model) => row(model.label, tokenText(model)))}
    </>}
    <Pressable testID="usage-before" accessibilityRole="button" onPress={() => setLegacy(!legacy)}><Text style={s.small}>{legacy ? 'Show fixed view' : 'Compare before'}</Text></Pressable>
  </ScrollView></SafeAreaView>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' }, screen: { padding: 24, paddingTop: 44, gap: 10 },
  title: { fontSize: 30, fontWeight: '700', color: '#172c43' }, heading: { fontSize: 19, fontWeight: '600', color: '#172c43', marginTop: 12 },
  small: { fontSize: 14, color: '#52677d', lineHeight: 21 }, room: { fontSize: 26, fontWeight: '600', color: '#172c43' },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginVertical: 12 }, tab: { borderRadius: 20, borderWidth: 1, borderColor: '#c1d1e2', paddingHorizontal: 12, paddingVertical: 8 },
  selected: { backgroundColor: '#214f79', borderColor: '#214f79' }, tabText: { color: '#172c43', fontSize: 13 }, selectedText: { color: '#fff' },
  note: { backgroundColor: '#edf3f9', padding: 12, borderRadius: 12, fontSize: 13, lineHeight: 20, color: '#172c43' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, paddingVertical: 13, borderTopWidth: 1, borderTopColor: '#d9e4ef' },
  text: { fontSize: 14, color: '#172c43' }, count: { fontSize: 14, fontWeight: '600', color: '#172c43' },
});
