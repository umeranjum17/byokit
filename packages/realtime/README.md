# @byokit/realtime

Realtime voice sessions with injected audio and provider adapters in a child process. First consumer: muxr.

```ts
import { realtimeClient, type AudioPorts, type RealtimeHostFrame, type RealtimeStream } from '@byokit/realtime';
import { realtimeEngine, toolBridge } from '@byokit/realtime/node';

// The app supplies its sign-in, carrier, audio implementation and authorized planner.
declare const accounts: { access(member: number, signal?: AbortSignal): Promise<{ access: string; accountId: string }> };
declare const emit: (frame: RealtimeHostFrame) => void;
declare const runPlanner: (request: string, signal: AbortSignal) => Promise<string>;
declare const openVoiceStream: () => Promise<RealtimeStream>;
declare const audio: AudioPorts;
const member = 1;
const tools = [{ name: 'delegate', description: 'Handle a spoken request', parameters: { type: 'object', properties: { request: { type: 'string' } } } }];
const bridge = toolBridge({
  tools, handlers: { delegate: async (args, { signal }) => runPlanner(String(args.request), signal) },
  emit, failure: () => 'That request could not be completed.',
});
const engine = realtimeEngine({
  engine: 'chatgpt', auth: { kind: 'plan', access: signal => accounts.access(member, signal) },
  tools, bridge, instructions: 'Answer briefly.', emit,
});
// Forward device frames to engine.receive(frame); engine.close() ends the child.
const client = realtimeClient({
  open: openVoiceStream, audio,
  onStatus: status => console.log(status),
  onTurn: (role, text) => console.log(role, text),
});
```

For ChatGPT voice register a `delegate` tool handler receiving `{ request }` and supply the app's planner. API routes use `auth: { kind: 'key', key }`, with billing per use. The subscription route uses the person's ChatGPT sign-in from `@byokit/accounts`; it never reads Codex credentials or starts the Codex CLI. Backend refusal is reported as `not-included`.

The main entry is portable for web and React Native and loads no native code. `./webrtc` supplies `webRtcPeer` for browsers and selects its native implementation under the `react-native` condition; install the optional `react-native-webrtc` 124.0.8 peer in the RN app. All media APIs can be injected for tests. `./node` requires Node 22.18+ and is for the credential host. It starts its own adapter child with an empty environment; credentials travel over private stdin. No provider key or plan token is sent to the device.

`AudioPorts` requires microphone acquisition/release, PCM capture, playback admission/drain and audio routing. The app owns permissions and its microphone service. Acquire must resolve only after that service is ready. The client awaits it before capture. Each client owns its ports; the app must arbitrate shared microphones.

Close the client and engine when the call ends. Reconnect and new barge-in policy are follow-up work. Existing provider interruption behavior is retained. No STT/LLM/TTS chain is exported. See [the lift contract](../../docs/realtime-kit.md) for bounds, events and usage.
