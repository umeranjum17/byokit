# @byokit/dictate

Private working name for dictation and recording transcription. Returns text to your app with stable partials, final segments, language, timestamps and usage. Never sends the transcript anywhere on your behalf.

```ts
import { Dictation, type AudioMic } from '@byokit/dictate';
import { chatgptEngine } from '@byokit/dictate/node';
import { provider, type Accounts } from '@byokit/accounts';

// Supplied by your app: its accounts instance, selected member and microphone.
declare const accounts: Accounts;
declare const person: string;
declare const yourMicrophonePort: AudioMic;
declare function showText(text: string): void;
const engine = chatgptEngine({
  access: async signal => {
    signal?.throwIfAborted();
    const runtime = await accounts.runtime(person);
    const id = provider('chatgpt').pi;
    const auth = await runtime.getAuth(id); // refresh under the accounts store's lock
    const credential = await runtime.readCredential(id);
    return { access: auth?.auth.apiKey ?? '',
      accountId: credential?.type === 'oauth' && typeof credential.accountId === 'string' ? credential.accountId : undefined };
  },
});
const dictation = new Dictation({ engine, audio: yourMicrophonePort });
const listening = dictation.listen();
listening.on('final', ({ segment }) => showText(segment.text));
const result = await listening.finish();
// Your app decides whether to insert or send result.text.
```

For on-device Node transcription, import `whisperEngine` from `./node` and pass absolute `binary` and `modelPath` paths. The kit never discovers a CLI, model, sign-in, environment key or another tool's state. `transcribe(bytesOrBlob, options)` accepts recordings; Uint8Array input is WAV, while Blob supplies a media type for compressed files. Language uses `languages[0]` (one recognition language at a time); replacements apply only to finals. Whisper expects 16 kHz WAV; your app decodes other formats first.

For browser/PWA and React Native, the main entry has no Node or native imports. Inject `systemEngine(native)` or a `DictateEngine` provided by your app's worker/native binding. The system port must enforce on-device recognition and provide a `stop()` that settles final callbacks before resolving. Capture belongs to the app. There is no shared audio package; the PCM port delivers mono Int16Array frames at 16 kHz and `stop()` must unblock the iterator. HTTP providers run on a Node host child and can be exposed through an app-owned engine transport without giving the phone account credentials.

`routes()` lists local and ChatGPT subscription routes by default. OpenAI and OpenRouter API key (billed per use) routes have `offer: false`. OpenRouter can use an accounts-managed sign-in key through `access`, but billing remains per use. The kit applies no experimental flag to ChatGPT; refusal reports `not-included`. It uses its own originator.

Live system recognition emits partial/final text; Whisper rereads once a second, stabilizes partials and settles on silence. Cloud engines return finals after each utterance rather than native streaming deltas. `onDeviceOnly: true` rejects cloud engines before capture/credential access. `finish()` settles once and releases capture; `cancel()` stops capture and aborts inference. `finish()` after cancellation rejects with `cancelled`. Uninterrupted live utterances are limited to 60 seconds, files to 25 MB, and child inference defaults to a 60-second timeout.

Timestamp support follows the engine: OpenAI word timestamps require `whisper-1`, Whisper CLI uses segment offsets/token offsets where available, and ChatGPT has no language/timestamp controls. Unknown cost/duration is not estimated. `installModel` delegates storage/download to your host and validates size plus SHA-256. Use `./testing` for offline microphone and inference fakes.

See [the specification](../../docs/dictation-kit.md). Publishing stays blocked on the final name and real consumer Android emulator proof; this change supplies fixture/fake qualification only.
