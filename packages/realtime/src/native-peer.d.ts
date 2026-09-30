// The optional RN peer is absent from the Node build. The kit consumes only this
// structural boundary; no native module is loaded by portable imports.
declare module 'react-native-webrtc' {
  export const RTCPeerConnection: { new(options: RTCConfiguration): globalThis.RTCPeerConnection };
  export const mediaDevices: { getUserMedia(options: MediaStreamConstraints): Promise<MediaStream> };
}
