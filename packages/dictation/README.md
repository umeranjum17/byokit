# @byokit/dictation

Dictation and recording transcription using your subscription or an on-device engine. Returns text to your app with stable partials, final segments, language, timestamps and usage. Never sends the transcript anywhere on your behalf.

```ts
import { Dictation, type AudioMic } from '@byokit/dictation';
import { chatgptEngine } from '@byokit/dictation/node';
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

See [the specification](../../docs/dictation-kit.md) and the [Android consumer proof](../../examples/dictation-android/README.md). The package is publishable as `@byokit/dictation` 0.1.0. The emulator flow exercises the public JavaScript entry and app-owned system port through Android SpeechRecognizer with a deterministic local RecognitionService; it does not qualify a downloaded speech model or a vendor recognizer. Native bindings remain the host app's responsibility.

## On-device React Native with whisper.rn

Install `whisper.rn@0.7.2` in your native host app and follow its [native installation instructions](https://github.com/mybigday/whisper.rn/tree/v0.7.2). It is an optional peer: importing the kit does not import or initialize a native module. Expo requires a native development build, rather than Expo Go. Your app supplies `initWhisper`, a downloaded local model path or Metro `require()` asset, and capture. The kit downloads nothing. There is no bundled or silently selected model; `base.en-q5_1` is the initial English benchmark model, not an accuracy guarantee. Choose a multilingual model for other languages.

Your React Native host imports `initWhisper` from `whisper.rn` and passes it to this function with a host-owned model and a PCM16 mono 16 kHz WAV recording:

```ts
import { Dictation, whisperRnEngine } from '@byokit/dictation';

export async function transcribeRecording(
  modelPath: string,
  wavBytes: Uint8Array,
  initWhisper: Parameters<typeof whisperRnEngine>[0]['initWhisper'],
) {
  const engine = whisperRnEngine({
    model: modelPath,
    initWhisper,
    settings: { language: 'en', vocabulary: ['TypeScript', 'React Native', 'Byokit'] },
  });
  try {
    return await new Dictation({ engine }).transcribe(wavBytes, { onDeviceOnly: true });
  } finally {
    await engine.release();
  }
}
```

For live dictation, retain the engine between taps and pass your `AudioMic` to `new Dictation({engine, audio})`; use `listen()`, `on('partial', ...)`, `on('final', ...)` and `finish()` as above. One context stays warm until the host calls `engine.release()`, which drains pending inference before freeing it. A later transcription initializes it again. Inference is serialized because a Whisper context handles one job at a time. Abort calls the native job's `stop()` and waits for its promise to settle before reusing the context; cancellation returns no words. The host should release on shutdown or after its chosen idle timeout (the previous consumer used three minutes).

`settings` are validated before native initialization; invalid values report `bad-model`. Recognition language is a Whisper code such as `en`, `fr`, or `auto`, rather than a locale such as `en-US`. Per-call `languages[0]`, `prompt`, and `keywords` override the language or add hints. Vocabulary guides recognition; final-only `replacements` remain a separate explicit correction step.

| Setting | Default | Meaning / range |
| --- | --- | --- |
| `model` (engine option) | Required from host | Local file path or Metro numeric asset; no remote URL |
| `language` | `auto` | Detect language, or a two/three-letter Whisper language code |
| `initialPrompt`, `vocabulary` | Empty | Initial context and list of words/names; preceding chunk's last 200 characters are appended |
| `threads` | `6` | Integer 1–64; benchmark for your device |
| `gain` | `1` | PCM amplitude multiplier 0.01–16, clipped to Int16 range |
| `chunkMs` | `30000` | Integer 100–30000; split longer recordings into non-overlapping windows |
| `vad.enabled` | `false` | Optional energy VAD removes file silence; disabling preserves all file audio |
| `vad.threshold` | `0.015` | Raw normalized RMS 0–1, measured after gain; live energy gate uses the same threshold |
| `vad.silenceMs` | `500` | Integer 20–10000; silence needed to end speech / settle live finals |
| `vad.paddingMs` | `200` | Integer 0–5000; preserve audio around file speech regions |
| `beamSize` | `-1` | Greedy decoding; integers 2–100 enable beam search |
| `bestOf` | `5` | Integer 1–100; candidates during sampling/fallback |
| `temperature` | `0` | Initial decoder temperature 0–1 |
| `temperatureInc` | `0.2` | Fallback increment 0–1; zero disables temperature fallback |

Energy VAD is implemented in the kit over 20 ms frames; it is not a neural speech detector. Live capture continues to discard silent windows even with file VAD disabled. The live energy gate compensates for gain before deciding whether to reread; the UI level remains the captured level. Chunk boundaries can split words; compare chunk sizes in the fixture harness before reducing them. Hints, higher gain, and beam search can improve or degrade a recording, so defaults remain conservative until regression evidence arrives.

Segment times from whisper.rn are converted from hundredths of a second and offset to the original recording after trimming/chunking. Word timestamps are unsupported and rejected explicitly. Short segments use `tokenTimestamps: true` and `maxLen: 60`. The previous consumer's short-audio `audioCtx` hint is intentionally omitted: whisper.rn 0.7.2 does not read it in its [Whisper JSI configuration](https://github.com/mybigday/whisper.rn/blob/v0.7.2/cpp/jsi/RNWhisperJSI.cpp). The portable adapter sends PCM16 bytes, matching that binding's decoder, rather than Float32 samples or a WAV header.

## Desktop WER fixtures

After `npm run build` in this repository, run the same gain, energy VAD, chunking and prompt pipeline against an explicitly supplied [whisper.cpp](https://github.com/ggml-org/whisper.cpp) CLI and model:

```sh
node packages/dictation/dist/wer-cli.js \
  --binary /absolute/path/to/whisper-cli \
  --model /absolute/path/to/ggml-base.en-q5_1.bin \
  --output /absolute/path/to/report.json
```

The installed package exposes the same command as `byokit-dictation-wer`. `--profile default` selects a profile (repeat for more), `--manifest /path/to/manifest.json` supplies your own clips/profiles, and `--timeout-ms 120000` bounds each chunk. A profile's optional `model` path is resolved relative to its manifest, allowing model comparisons with the same clips. Ordinary tests use a fake CLI and no models or network.

The shipped [manifest](fixtures/wer/manifest.json) includes clean, noisy (12 dB SNR), fast, and technical-name synthetic clips, exact references, generator/source attribution, SHA-256 integrity checks, and three settings profiles. All four audio files and [voice attribution](fixtures/wer/NOTICE.txt) ship in the tarball. Regenerate them with `python3 packages/dictation/scripts/generate-wer.py --flite /absolute/path/to/flite` using the recorded Flite revision and its `slt` voice. No user recording or commercial voice service is used.

JSON output reports substitutions, deletions, insertions, reference words, WER, audio duration, wall-clock latency and real-time factor per clip and per profile. WER normalizes NFKC/lowercase, removes punctuation, then counts whitespace-delimited words; names remain scored rather than replaced. Profile WER is total edits divided by total reference words. Empty-reference insertions have undefined WER (`null`). Desktop latency includes loading the model in a fresh CLI process for each chunk and is not a prediction of warm-context phone latency. Record the CLI revision, model hash and machine alongside reports; native backend/model versions can differ. The recorded [baseline](fixtures/wer/baseline.json) includes CLI/model provenance and one synthetic desktop run: 10.9% default WER versus 8.7% with English/vocabulary and beam search. Synthetic clips are a reproducible smoke benchmark, not proof of microphone accuracy. Add relayed real regression clips with their consent/license provenance before tuning defaults for a shipping app.
