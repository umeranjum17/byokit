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

## Structured delegation and named targets

`delegationHandler` dispatches a JSON request of the form `{ name, arguments }`
directly through an app-supplied `toolBridge`. For ordinary spoken requests it
uses the optional app planner. Invalid structured requests never enter the planner.
Keep the action bridge separate from the outer `delegate` bridge:

```ts
import { delegationHandler, toolBridge } from '@byokit/realtime/node';
import type { ToolHandler } from '@byokit/realtime/node';
import type { RealtimeHostFrame } from '@byokit/realtime';

declare const emit: (frame: RealtimeHostFrame) => void;
declare const sendAuthorizedMessage: ToolHandler;
declare const plan: (request: string, context: Parameters<ToolHandler>[1]) => Promise<string>;
const actionTools = [{ name: 'message', description: 'Message a named agent', parameters: {
  type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' } },
  required: ['agent', 'text'], additionalProperties: false,
} }];
const actions = toolBridge({ tools: actionTools, handlers: { message: sendAuthorizedMessage },
  emit, failure: () => 'The message could not be confirmed.', timeoutFor: () => 75000 });
const delegate = delegationHandler({ bridge: actions, plan });
const tools = [{ name: 'delegate', description: 'Delegate a spoken request', parameters: { type: 'object' } }];
const bridge = toolBridge({ tools, handlers: { delegate }, emit,
  timeoutFor: () => 340000, failure: () => 'The request could not be confirmed.' });
// Pass the outer bridge and its delegate tool to realtimeEngine.
// A structured request can be:
// {"name":"message","arguments":{"agent":"Avery","text":"Please report progress"}}
// Close actions as well as the outer bridge when the session ends.
```

The kit preserves arguments and operation ids; retries with the same call id
share a result. Named targets, target lookup, ambiguity checks, authorization,
argument validation and mutation receipts belong to the app's handlers. Tool
JSON schemas describe the provider catalog; they are not runtime authorization.
The app planner owns its model, conversation memory, tool budget and deadline;
the kit does not add a planner model or any agent runtime dependency. Aborted
calls must stop in the app too; completed side effects are never rolled back.
The host bridge owns every tool watchdog and failure message; the child has no
second deadline. A 340-second planner or a 290-second watch can therefore use
the app's declared budget. An ordinary ChatGPT user turn preserves unfinished
delegations and their retransmission cache. Explicit `interrupt` or close aborts
them; a new turn id still identifies a new request.

## Advisory auth check

Pass a read-only saved-sign-in lookup as `authCheck` on the engine. It starts
independently, is never awaited by startup, and cannot close the session. It
does not call `auth.access`, refresh a token, run a CLI or initiate login.
The app's `peek` callback must also never refresh, prompt or start login.

```ts
import { realtimeEngine, toolBridge } from '@byokit/realtime/node';
import type { RealtimeAuth, RealtimeHostFrame, RealtimeTool, RealtimeAuthPeekResult, RealtimeAuthResult } from '@byokit/realtime';

declare const auth: Extract<RealtimeAuth, { kind: 'plan' }>;
declare const tools: RealtimeTool[];
declare const bridge: ReturnType<typeof toolBridge>;
declare const emit: (frame: RealtimeHostFrame) => void;
declare const peekSavedSignIn: (signal: AbortSignal) => Promise<RealtimeAuthPeekResult>;
declare const updateSettingsBadge: (status: 'ready' | 'signed-out' | 'unknown') => void;
declare const showSignInMessage: (result: RealtimeAuthResult) => void;
const engine = realtimeEngine({
  engine: 'chatgpt', auth,
  tools, bridge, emit,
  authCheck: { peek: peekSavedSignIn, onStatus: status => updateSettingsBadge(status), onResult: showSignInMessage },
});
```

`ready` means the app reports a saved sign-in, not provider entitlement.
`signed-out` means the lookup returned false or found an unusable saved sign-in.
Unrecognized errors or a timeout produce `unknown`; the default timeout is one second, capped at ten seconds. Close
cancels pending checks and suppresses late notifications. Normal session
authentication still needs the credential from `auth.access`.
For a standalone settings lookup, `realtimeAuthCheck({ peek })` is also exported
from the portable entry and returns `{ result, details, close }`. `result` still
resolves to the status string; `details` resolves to `{ state, reason?, message? }`,
and engine `onResult` receives the same diagnostic object. A boolean or
`{ state }` peek keeps the previous behavior without adding a reason.

To report an expired saved sign-in, the read-only peek can return
`{ state: 'signed-out', reason: 'login-expired' }`. Built-in reasons are
`credential-permissions`, `login-expired`, `missing` and `unknown`; apps can
supply additional reason strings. Messages use fixed plain wording and never
copy exception text or credential paths. Missing-file errors map to `missing`,
permission errors to `credential-permissions`, and expired-login errors to
`login-expired`; unrecognized errors and timeouts report `unknown`. Do not await this check
before opening a voice session or show a login prompt from its result.

## Lifecycle announcements and semantic app tools

Feed app-confirmed lifecycle reports into the existing speech path. The kit
does not watch agents or infer their outcome:

```ts
import type { realtimeClient } from '@byokit/realtime';
import type { realtimeEngine } from '@byokit/realtime/node';
declare const client: ReturnType<typeof realtimeClient>;
declare const engine: ReturnType<typeof realtimeEngine>;

// Called by the app's lifecycle subscription; use bounded, sanitized app wording.
client.speak('Avery has finished the task.');
// A host can inject the same report directly:
engine.receive({ type: 'realtime.say', text: 'Avery has finished the task.' });
```

`speak` queues at most sixteen reports until the call is ready, waits for local
playback drain and does not replay sent speech on reconnect. `onTurn` observes
transcripts and `onStatus` observes playback states; a transcript alone does
not prove the report was audible. The app owns push delivery, deduplication,
waking a sleeping call and stopping it after reports.
When `player.finish(callback)` returns false, the client reports connected
immediately. True means the player will call back after draining. Clearing
audio also rechecks queued speech, including while the microphone is muted.

Compose `appBridge` with `toolBridge` to round-trip semantic phone requests:

```ts
import { appBridge, toolBridge } from '@byokit/realtime/node';
import type { RealtimeHostFrame } from '@byokit/realtime';
declare const emit: (frame: RealtimeHostFrame) => void;
const app = appBridge(emit);
const navigation = [{ name: 'navigate', description: 'Open an app destination',
  parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } }];
const bridge = toolBridge({ tools: navigation, app, emit,
  handlers: { navigate: (args, { signal }) => app.run('navigate', String(args.target), signal) },
  failure: () => 'The app could not complete that request.',
});
// client.onAppRequest handles view/navigate/activate; forward all client frames
// to engine.receive, which routes app results back to this app bridge.
// Closing the engine also cancels pending app requests.
```

The main entry is portable for web and React Native and loads no native code. `./webrtc` supplies `webRtcPeer` for browsers and selects its native implementation under the `react-native` condition; install the optional `react-native-webrtc` 124.0.8 peer in the RN app. All media APIs can be injected for tests. `./node` requires Node 22.18+ and is for the credential host. It starts its own adapter child with an empty environment; credentials travel over private stdin. No provider key or plan token is sent to the device.

`AudioPorts` requires microphone acquisition/release, PCM capture, playback admission/drain and audio routing. The app owns permissions and its microphone service. Acquire must resolve only after that service is ready. The client awaits it before capture. Each client owns its ports; the app must arbitrate shared microphones.

## Preconnect without microphone capture

Set `capture: 'lazy'` for a browser or React Native WebRTC session. Startup
negotiates one `sendrecv` audio transceiver with no sender track: it calls
neither `audio.microphone.acquire()` nor `getUserMedia`, so the app's microphone
foreground service stays stopped. The playback route remains available.

```ts
import { realtimeClient, type AudioPorts, type RealtimeStream } from '@byokit/realtime';
import { webRtcPeer } from '@byokit/realtime/webrtc';
declare const audio: AudioPorts;
declare const openVoiceStream: () => Promise<RealtimeStream>;
const client = realtimeClient({
  open: openVoiceStream, audio, webrtc: webRtcPeer, capture: 'lazy',
  onStatus() {}, onTurn() {},
});
// Once WebRTC setup has started, await this before accepting speech:
async function beginTalking() { await client.attachMic(); }
// When idle, release hardware capture while keeping the call connected:
async function becomeIdle() { await client.releaseMic(); }
// End the call and release all media:
function endCall() { client.stop(); }
```

`attachMic()` awaits the app's microphone permission/service lease, captures
an audio track and uses `sender.replaceTrack(track)` before enabling the sender's
encoding. Lazy peers negotiate `sendrecv` with an inactive encoding: Android's
audio device cannot start recording just because an answer is applied.
`releaseMic()` disables that encoding before `replaceTrack(null)`, stops capture tracks and releases the lease so the app
can stop its microphone service and clear the OS indicator. Neither operation
renegotiates. Repeated calls are safe; release or stop during pending capture
cleans up when that capture resolves. Reconnecting starts another lazy peer;
the app explicitly attaches again when it needs input.

The built-in `webRtcPeer` handle also exposes both methods for direct use.
Custom peer factories may implement these optional methods; client attach
rejects if the current peer does not support them or setup has not started.
The default is eager capture, and PCM capture is unchanged. `setMuted()` still
only toggles track delivery; use `releaseMic()` to relinquish capture. Mute
state persists when a new track is attached. Each client owns its `AudioPorts`;
`microphone.release()` must stop the app-owned foreground service.

Close the client and engine when the call ends. `client.interrupt()` clears playback and aborts unfinished tools; old response output is fenced. Transient provider and transport failures retry twice, after 500 and 1,000 ms, with a fresh budget after 30 healthy seconds. Sent audio, speech and tool calls are never replayed. The app can mark transport closure terminal with `retryableClose`. Explicit ChatGPT interruption opens a fresh call; explicit Gemini interruption rotates its provider session. Native speech interruption remains provider-driven. No STT/LLM/TTS chain is exported. See [the lift contract](../../docs/realtime-kit.md) for bounds, events and usage.

## Reconnect and host policy

Set `preserveMediaOnReconnect: true` on the client to retain a ready PCM
recorder, microphone lease, audio route and playback tail across a carrier
reconnect. Audio captured while the carrier is down is discarded. Pending
microphone acquisition still releases before retry; WebRTC always creates a
fresh peer for a fresh call. A changed PCM format releases the old recorder
before acquiring another. Stop releases retained media even during backoff.
The default remains release/clear/reacquire.

The engine accepts app phrase policy and credential-error wording:

```ts
import { realtimeEngine, toolBridge } from '@byokit/realtime/node';
import type { RealtimeAuth, RealtimeHostFrame, RealtimeTool } from '@byokit/realtime';
declare const auth: Extract<RealtimeAuth, { kind: 'plan' }>;
declare const tools: RealtimeTool[];
declare const bridge: ReturnType<typeof toolBridge>;
declare const emit: (frame: RealtimeHostFrame) => void;

const engine = realtimeEngine({ engine: 'chatgpt',
  auth, tools, bridge, emit,
  hangup: text => /^goodbye[.!]?$/i.test(text.trim()),
  authFailure: () => 'Sign in again from Settings.',
  signalingIdentity: { originator: 'voice-app', userAgent: 'voice-app/1' },
});
```

Hangup ends after the next completed agent transcript so the provider can
give a farewell. It is a transcript-level policy, not proof that playback
drained. Credential errors are sanitized, bounded and emitted as the close
reason; the kit initiates no login or prompt. Transcripts preserve up to
4,000 UTF-8 bytes, state details up to 500 bytes, and close reasons up to
2,048 bytes. Empty ChatGPT transcripts are ignored.

ChatGPT emits `realtime.webrtc.start` while the isolated child starts and
access is being resolved. Device frames remain bounded and queued until the
credential/config line is sent. This overlaps local setup without sending a
signaling request before credentials are available. `signalingIdentity`
lets the app name its own originator/user-agent; the default for both is
`byokit`, and identity values must be printable ASCII of at most 160 characters.
Credentials, endpoint restrictions and redirect rejection are unchanged.
The identity option allows a consumer to compare signaling latency; offline
tests prove startup ordering, not a reduction in the remote provider's POST time.

For an explicitly live microphone and subscription-provider proof, run [the bounded voice demo](../../examples/realtime-voice/README.md). It signs in through accounts, keeping the sign-in at this computer's machine store, and records connection facts and turn counts. Offline tests do not establish a live pass.
