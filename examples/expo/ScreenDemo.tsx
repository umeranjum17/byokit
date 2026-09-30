import { useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { overlay } from '@byokit/overlay';
import { screenFrame, type ScreenFrameResult } from '@byokit/overlay/screen-frame';

/** Account-free native proof: opt in at build time with EXPO_PUBLIC_SCREEN_DEMO=1. */
export function ScreenDemo() {
  const target = useRef<View>(null);
  const [frame, setFrame] = useState<Extract<ScreenFrameResult, { status: 'captured' }> | null>(null);
  const [message, setMessage] = useState('Take a picture, then show Umer where to tap.');
  const [point, setPoint] = useState('');
  const [taps, setTaps] = useState(0);
  const capture = async () => {
    setFrame(null);
    setMessage('Waiting for your permission.');
    const result = await screenFrame.frame();
    if (result.status === 'captured') { setFrame(result); setMessage('Opening your picture.'); }
    else setMessage(result.status === 'cancelled' ? 'Picture cancelled.' : result.status === 'failed' ? 'Could not take a picture.' : result.status === 'busy' ? 'A picture is already being taken.' : 'This phone cannot take a screen picture.');
  };
  const start = async () => {
    const state = await overlay.start({ host: 'window', mood: 'bubble',
      notice: { channel: 'guide', title: 'Umer’s guide', text: 'Ready to point.', icon: 'byokit_notification' } });
    if (state === 'needs-permission') await overlay.openPermission();
    else setPoint(state === 'on' ? 'Guide ready.' : 'This phone cannot show a guide.');
  };
  const mark = (ms: number) => target.current?.measureInWindow(async (x, y, width, height) => {
    if (!frame) return;
    const result = await overlay.pointHere({ x: (x + width / 2) * frame.space.density, y: (y + height / 2) * frame.space.density, label: 'Umer, tap here', space: frame.space, ms });
    setPoint(result === 'shown' ? 'Follow the ring.' : result === 'display-changed' ? 'Take a new picture after turning the phone.' : 'Start the guide first.');
  });
  return <View style={s.screen}>
    <Text style={s.eyebrow}>BYOKIT · SCREEN GUIDE</Text>
    <Text style={s.title}>A little help for Umer</Text>
    <Text style={s.detail}>One picture with your permission. A ring to follow. You stay in control.</Text>
    <Pressable testID="screenCapture" style={s.button} onPress={capture}><Text style={s.buttonText}>Take one screen picture</Text></Pressable>
    <Text testID="screenResult" style={s.detail}>{message}</Text>
    <Pressable testID="screenGuide" style={s.secondary} onPress={start}><Text style={s.secondaryText}>Start the guide</Text></Pressable>
    <View style={s.targetArea}>
      <Text style={s.caption}>A demo button beneath the marker</Text>
      <View ref={target} collapsable={false}>
        <Pressable testID="screenTarget" style={s.target} onPress={() => setTaps((n) => n + 1)}><Text style={s.targetText}>Umer’s next step</Text></Pressable>
      </View>
      <Text testID="screenTaps" style={s.detail}>{taps ? `Umer tapped through ${taps} time${taps === 1 ? '' : 's'}.` : 'The ring will let your tap reach this button.'}</Text>
    </View>
    <View style={s.row}>
      <Pressable testID="screenPoint" disabled={!frame} style={s.smallButton} onPress={() => mark(15000)}><Text style={s.secondaryText}>Point here</Text></Pressable>
      <Pressable testID="screenPointShort" disabled={!frame} style={s.smallButton} onPress={() => mark(1000)}><Text style={s.secondaryText}>Brief ring</Text></Pressable>
      <Pressable testID="screenDismiss" style={s.smallButton} onPress={async () => { await overlay.dismissPoint(); setPoint('Ring dismissed.'); }}><Text style={s.secondaryText}>Dismiss</Text></Pressable>
    </View>
    <Text testID="screenPointResult" style={s.detail}>{point}</Text>
    {frame && <Image testID="screenImage" source={{ uri: frame.uri }} style={s.preview} resizeMode="contain"
      onLoad={() => setMessage(`Picture ready. ${frame.width} × ${frame.height} pixels.`)} onError={() => setMessage('Could not open the picture.')} />}
  </View>;
}
const s = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 64, paddingBottom: 32, backgroundColor: '#f4f6ef', gap: 14 },
  eyebrow: { color: '#00674e', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { fontSize: 30, fontWeight: '700', color: '#163a2d' },
  detail: { color: '#40564a', fontSize: 15, lineHeight: 21 },
  button: { padding: 16, borderRadius: 12, backgroundColor: '#00674e', alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { padding: 12, borderRadius: 10, backgroundColor: '#e0e8d9', alignItems: 'center' },
  secondaryText: { color: '#163a2d', fontWeight: '600', fontSize: 14 },
  targetArea: { marginVertical: 12, gap: 16, padding: 20, borderRadius: 16, backgroundColor: '#fff' },
  caption: { fontSize: 12, color: '#52695c' },
  target: { padding: 22, borderRadius: 12, backgroundColor: '#e0e8d9', alignItems: 'center' },
  targetText: { fontSize: 17, fontWeight: '700', color: '#163a2d' },
  row: { flexDirection: 'row', gap: 8 },
  smallButton: { padding: 12, borderRadius: 10, backgroundColor: '#e0e8d9' },
  preview: { flex: 1, minHeight: 70, width: '100%', borderRadius: 12, backgroundColor: '#e0e8d9' },
});
