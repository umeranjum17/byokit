import React, { useEffect, useState } from 'react';
import { Button, PermissionsAndroid, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import { RTCPeerConnection } from 'react-native-webrtc';
import { realtimeClient } from '@byokit/realtime';
import type { RealtimeHostFrame } from '@byokit/realtime';
import { webRtcPeer } from '@byokit/realtime/webrtc';

// The provider stand-in is another native peer in this app. No account, key,
// signaling server or external endpoint; the only RTP is between local peers.
function App() {
  const [phase, setPhase] = useState('starting');
  const [client, setClient] = useState<ReturnType<typeof realtimeClient>>();
  useEffect(() => {
    let voice: ReturnType<typeof realtimeClient> | undefined;
    const remote = new RTCPeerConnection({ iceServers: [] });
    let disposed = false;
    const report = (value: string) => { if (!disposed) { setPhase(value); console.log(`BYOKIT_RT_PROOF ${value}`); } };
    void (async () => {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Permission required.');
      if (disposed) return;
      let deliver: (frame: RealtimeHostFrame) => void = () => {};
      let acquired = false;
      voice = realtimeClient({ capture: 'lazy', webrtc: webRtcPeer,
        audio: {
          microphone: { async acquire() { acquired = true; }, release() { acquired = false; } },
          async route() {}, async unroute() {}, async capture() { throw new Error('PCM is unused.'); },
          player: { ensure() {}, bind() {}, unbind() {}, admit() { return 'ok'; }, clear() {}, stop() {}, release() {}, finish() { return false; }, afterDrain() { return false; } },
        },
        onStatus(status) { if (status === 'connected') report('warm'); if (status === 'disconnected' && !disposed) report('failed'); },
        onTurn() {},
        open: async () => ({
          onFrame(fn) { deliver = fn; }, onClose() {}, close() {},
          start() { deliver({ type: 'realtime.webrtc.start', dataChannelLabel: 'proof' }); },
          send(frame) {
            if (frame.type === 'realtime.webrtc.offer') void (async () => {
              await remote.setRemoteDescription({ type: 'offer', sdp: frame.sdp });
              await remote.setLocalDescription(await remote.createAnswer());
              const deadline = Date.now() + 5000;
              while (remote.iceGatheringState !== 'complete' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
              if (remote.iceGatheringState !== 'complete') throw new Error('Local answer timed out.');
              deliver({ type: 'realtime.webrtc.answer', sdp: remote.localDescription!.sdp });
            })().catch(() => report('failed'));
            return true;
          },
        }),
      });
      setClient(voice);
      // Keep the app-owned lease observable independently of Android recording.
      if (acquired) throw new Error('Warm capture acquired a lease.');
    })().catch(() => report('failed'));
    return () => { disposed = true; voice?.stop(); remote.close(); };
  }, []);
  const act = async (attach: boolean) => {
    try {
      if (!client) throw new Error('Voice is unavailable.');
      if (attach) await client.attachMic(); else await client.releaseMic();
      setPhase(attach ? 'attached' : 'released');
      console.log(`BYOKIT_RT_PROOF ${attach ? 'attached' : 'released'}`);
    } catch { setPhase('failed'); console.log('BYOKIT_RT_PROOF failed'); }
  };
  return React.createElement(View, { style: { flex: 1, justifyContent: 'center', padding: 24 } },
    React.createElement(Text, {}, `Umer: ${phase}`),
    React.createElement(Button, { title: 'Attach microphone', onPress: () => { void act(true); } }),
    React.createElement(Button, { title: 'Release microphone', onPress: () => { void act(false); } }));
}
registerRootComponent(App);
