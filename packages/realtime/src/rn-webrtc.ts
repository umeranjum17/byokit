import { webRtcPeer as createPeer, type WebRtcOptions } from './webrtc.ts';
export type { WebRtcOptions, WebRtcHandle } from './webrtc.ts';
/** Native media stays unloaded until the app actually starts a voice session. */
export async function webRtcPeer(options: WebRtcOptions) {
  if (options.platform) return createPeer(options);
  const native = await import('react-native-webrtc');
  return createPeer({ ...options, platform: {
    createPeer: () => new native.RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }),
    getUserMedia: () => native.mediaDevices.getUserMedia({ audio: true, video: false }),
  } });
}
export { webRtcPeer as reactNativeWebRtcPeer };
