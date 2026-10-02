// @byokit/share in an app (docs/capability-kits.md 14): share text or files to this app from another app and they
// show here, with the kit's plain words when something could not be opened. EXPO_PUBLIC_SHARE_DEMO=1 opens it.
import { SafeAreaView, ScrollView, Pressable, StyleSheet, Text, View } from 'react-native';
import { shareSupported, useShareIntent } from '@byokit/share';

export function ShareDemo() {
  const { isReady, hasShareIntent, shareIntent, error, errorCode, skipped, resetShareIntent } = useShareIntent();
  const files = shareIntent.files ?? [];
  return <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={s.screen}>
    <Text style={s.title}>Shared with this app</Text>
    <Text testID="share-ready" style={s.small}>
      {!shareSupported ? "This phone can't share to this app." : isReady ? 'Share text, a link or files to this app from any other app.' : 'Getting ready.'}
    </Text>
    {!!error && <Text testID="share-error" accessibilityRole="alert" style={s.note}>{error}</Text>}
    {errorCode === 'partial' && <Text testID="share-partial" style={s.note}>{`${skipped} left out. Some of the shared files couldn't be opened.`}</Text>}
    {hasShareIntent && <View testID="share-shown" style={s.card}>
      {!!shareIntent.text && <Text testID="share-text" style={s.text}>{shareIntent.text}</Text>}
      {!!shareIntent.webUrl && <Text style={s.small}>{`Link: ${shareIntent.webUrl}`}</Text>}
      {files.map((f, i) => <View key={`${i}-${f.path}`} style={s.row}>
        <Text style={s.text}>{f.fileName}</Text>
        <Text style={s.small}>{[f.mimeType, f.size != null && `${Math.ceil(f.size / 1024)} KB`, f.width && f.height && `${f.width}×${f.height}`].filter(Boolean).join(' · ')}</Text>
      </View>)}
    </View>}
    {(hasShareIntent || !!error) && <Pressable testID="share-clear" accessibilityRole="button" onPress={() => resetShareIntent()} style={s.button}><Text style={s.buttonText}>Done</Text></Pressable>}
  </ScrollView></SafeAreaView>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' }, screen: { padding: 24, paddingTop: 64, gap: 12 },
  title: { fontSize: 24, fontWeight: '600' }, small: { fontSize: 14, color: '#555' }, text: { fontSize: 17 },
  note: { backgroundColor: '#f6efe2', padding: 12, borderRadius: 12, fontSize: 14, lineHeight: 20 },
  card: { gap: 10, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: '#e4e2dc' },
  row: { gap: 2, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' }, buttonText: { color: '#fff', fontSize: 17 },
});
