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

For browser/PWA and React Native, the main entry has no Node or native imports. Inject `systemEngine(native)` or a `DictateEngine` provided by your app's worker/native binding. The system port must enforce on-device recognition and provide a `stop()` that settles final callbacks before resolving. Capture belongs to the app; shared speech detection lives in [`@byokit/audio`](../audio/README.md). The PCM port delivers mono Int16Array frames at 16 kHz. Its idempotent `stop()` must stop production, unblock iteration and leave every already captured frame available to the iterator before it ends. `finish()` drains those frames before final inference, including audio queued during an in-flight preview; `cancel()` discards them. HTTP providers run on a Node host child and can be exposed through an app-owned engine transport without giving the phone account credentials.

`routes()` lists local and ChatGPT subscription routes by default. OpenAI and OpenRouter API key (billed per use) routes have `offer: false`. OpenRouter can use an accounts-managed sign-in key through `access`, but billing remains per use. The kit applies no experimental flag to ChatGPT; refusal reports `not-included`. It uses its own originator.

Live system recognition emits partial/final text; Whisper rereads once a second and stabilizes partials. The RN engine makes a fresh reading of the complete recording at finish; other reread engines settle on silence. Cloud engines return finals after each utterance rather than native streaming deltas. `onDeviceOnly: true` rejects cloud engines before capture/credential access. `finish()` settles once and releases capture; `cancel()` stops capture and aborts inference. `finish()` after cancellation rejects with `cancelled`. `listen({ maxSeconds: 300 })` bounds app-injected PCM capture to five minutes by default, including silence and previously settled turns; a finite positive setting overrides it. Invalid settings return `unsupported` before opening capture; exceeding the limit stops capture and returns `too-large` from `finish()`. Native system recognizers own their capture limits. Files remain limited to 25 MB, and child inference defaults to a 60-second timeout.

Timestamp support follows the engine: OpenAI word timestamps require `whisper-1`, Whisper CLI uses segment offsets/token offsets where available, and ChatGPT has no language/timestamp controls. Unknown cost/duration is not estimated. `installModel` delegates storage/download to your host and validates size plus SHA-256. Use `./testing` for offline microphone and inference fakes.

See [the specification](../../docs/dictation-kit.md) and the [Android consumer proof](../../examples/dictation-android/README.md). The package is published as `@byokit/dictation`. The emulator flow exercises the public JavaScript entry and app-owned system port through Android SpeechRecognizer with a deterministic local RecognitionService; it does not qualify a downloaded speech model or a vendor recognizer. Native bindings remain the host app's responsibility.

## On-device React Native with whisper.rn

Install `whisper.rn@0.7.2` in your native host app and follow its [native installation instructions](https://github.com/mybigday/whisper.rn/tree/v0.7.2). It is an optional peer: importing the kit does not import or initialize a native module. Expo requires a native development build, rather than Expo Go. Your app supplies `initWhisper`, a downloaded local model path or Metro `require()` asset, and capture. The kit downloads nothing. There is no bundled or silently selected model; `DEFAULT_WHISPER_MODEL` recommends `base.en-q5_1` (about 60 MB), measured below; it is an identity, not a downloaded file or an accuracy guarantee. Choose a multilingual model for other languages and pass `multilingual: true` to default to `auto`, or select an explicit recognition language.

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
| `language` | `en` | English model; `multilingual: true` defaults to `auto`. Explicit two/three-letter Whisper language codes override either |
| `initialPrompt`, `vocabulary` | Empty | Initial context and list of words/names per fresh reading; explicit non-overlapping `chunkMs` also appends the preceding chunk's last 200 characters |
| `threads` | `6` | Integer 1–64; benchmark for your device |
| `gain` | `1` | PCM amplitude multiplier 0.01–16, clipped to Int16 range |
| `chunkMs` | `0` | Automatic 30-second windows with 5-second overlap for recordings over 30 seconds; integers 100–30000 opt into non-overlapping windows |
| `vad.enabled` | `false` | Optional energy VAD removes file silence; disabling preserves all file audio |
| `vad.threshold` | `0.0025` | Raw normalized RMS floor 0–1 after gain (0.01 on the UI's ×4 scale) |
| `vad.relativeThreshold` | `0.1` | Live gate also requires this fraction of the recording's peak RMS; range 0–1 |
| `vad.silenceMs` | `500` | Integer 20–10000; silence needed to end an optional file VAD speech region |
| `vad.paddingMs` | `200` | Integer 0–5000; preserve audio around file speech regions |
| `beamSize` | `-1` | Greedy decoding; integers 2–100 enable beam search |
| `bestOf` | `5` | Integer 1–100; candidates during sampling/fallback |
| `temperature` | `0` | Initial decoder temperature 0–1 |
| `temperatureInc` | `0.2` | Fallback increment 0–1; zero disables temperature fallback |

The built-in energy VAD uses 20 ms frames. When the app passes a `vad` session factory to `whisperRnEngine`, file segmentation and the live turn gate run the shared neural detector from `@byokit/audio` (same `silenceMs`/`paddingMs` settings, one session per stream, released with the stream) instead; without it the energy gate runs unchanged. File VAD is disabled by default to preserve quiet speech and pauses. Live previews require the larger of the RMS floor and 10% of the recording's peak level, compensating for gain. The UI shows captured RMS ×4. This replaces the old 0.06 UI gate that missed quiet phone speech. The final rereads all nonzero captured audio, including quiet material below the preview gate. Capture retains audio across pauses and finishes as one final segment; it never promotes a preview to final text. The configurable five-minute recording cap includes silence.

Finals use full model audio context (`audioCtx: 0`) per chunk, greedy decoding (no `beamSize` option), `tokenTimestamps: false` and `maxLen: 0`. Recordings up to 30 seconds use one reading. Longer recordings use 30-second windows starting every 25 seconds, including the entire last window; shared phrases in the decoded overlap are aligned to remove repetition and recover clipped edge words. Each automatic window receives fresh configured vocabulary/context, without preceding transcript text that can suppress overlapping speech. Matching ignores case and punctuation; exact suffix/prefix matches are removed once. When edge words differ, bounded word alignment joins inside the agreed overlap, retaining the earlier prefix and continuing from the later window; without reliable agreement both readings are retained. This cannot correct arbitrary recognition errors. Merged file ranges have range-level segment offsets. Segment metadata is converted from hundredths of a second for single-window readings, but never used to cut or keep audio. Explicit file VAD/chunking opt out of this automatic overlap and can split words. Upstream whisper.rn 0.7.2 ignores `audioCtx` in its [JSI configuration](https://github.com/mybigday/whisper.rn/blob/v0.7.2/cpp/jsi/RNWhisperJSI.cpp); passing zero also preserves full context in hosts patched to support the option. The portable adapter sends PCM16 bytes matching the native decoder. Word timestamps are unsupported and rejected.

Prompts and vocabulary belong entirely to the host. They are absent from live previews and supplied only to final/file readings, preventing repeated hints from dominating short previews. For the muxr application, the measured example is `initialPrompt: 'muxr, Herdr, Codex, Claude, BYOKit, worktree, npm.'`. These names are an example profile, never kit defaults. User keywords/context may be passed per call. Gain, hints and beam search can help or hurt; measure your microphone and vocabulary before changing them.

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

JSON output reports edit counts, reference words, WER, audio duration, latency and real-time factor per clip/profile. WER normalizes NFKC/lowercase and treats punctuation as word boundaries. Profile WER is total edits divided by total reference words; names remain scored without replacements. Empty-reference insertions have undefined WER (`null`). The CLI backend includes a fresh process/model load per chunk. The original [four-clip baseline](fixtures/wer/baseline.json) records the pre-tuning settings, rather than the current defaults.

### Relayed 34-clip regression and cached CI

The [regression manifest](fixtures/wer/regression/manifest.json) imports 12 core and 22 extended synthetic clips, including noise, fast speech, technical names, pauses, quiet speech and long utterances. [Provenance and regeneration](fixtures/wer/regression/NOTICE.md) identify the authored text, public-domain LJ Speech voice, transformations, source commit and exact supplied bytes. Each clip's SHA-256 is checked before inference. These clips are a reproducible accuracy benchmark, not physical-phone microphone qualification.

To match whisper.rn's vendored whisper.cpp 1.9.1, obtain its exact optional peer source and build the small persistent CPU reader. From the repository root (or use the equivalent paths in an unpacked tarball):

```sh
mkdir -p .lab/wer-source
npm pack whisper.rn@0.7.2 --pack-destination .lab
# Unpack source; this does not install a native runtime into the kit.
tar -xzf .lab/whisper.rn-0.7.2.tgz -C .lab/wer-source
node packages/dictation/scripts/bench/build.mjs \
  --source "$PWD/.lab/wer-source/package" --output "$PWD/.lab/wer-build" --portable
node packages/dictation/dist/wer-cli.js \
  --binary "$PWD/.lab/wer-build/whisperBench" \
  --model /absolute/path/to/ggml-base.en-q5_1.bin --backend rn-bench \
  --manifest packages/dictation/fixtures/wer/regression/manifest.json \
  --profile default --profile application-vocabulary --repeats 3 \
  --output .lab/wer-report.json
node packages/dictation/scripts/bench/gate.mjs .lab/wer-report.json \
  packages/dictation/fixtures/wer/regression/baseline.json
```

The checked-in [baseline](fixtures/wer/regression/baseline.json) records the model hash, native build and all per-clip results. `--repeats 3` selects each clip's median edit count and median timing; `--speed 3` scales measured inference to the report's phone-like wait estimate. Warm model loading is excluded. This multiplier is a simulation, not phone latency evidence. Historical profiles reproduce the old settings and keep-cut loop solely for comparison; no production adapter uses that loop. Floating-point CPU differences and inference timing can change transcripts; reproduction differences are recorded with the baseline.

Measured on the same 34 clips / 734 reference words, three repeats:

| Profile | Supplied report WER / ×3 wait | Kit native run WER / ×3 wait |
| --- | --- | --- |
| Historical fit-window / keep-cut / auto | 10.2% / 0.64 s | 12.9% / 0.69 s |
| Previous whole-recording beam 5 / auto | 5.6% / 2.00 s | 6.4% / 2.57 s |
| Tuned full-window greedy English | 5.7% / 0.94 s | 5.9% / 0.85 s |
| Tuned + app vocabulary | 4.1% / 1.00 s | 3.7% / 0.89 s |

The portable AVX2 CI build measured 5.3% / 3.5% WER and 0.45 / 0.47 s warm host inference without the ×3 multiplier. The historical replay does not reproduce 10.2% exactly: measured inference timing changes segment cuts, and CPU arithmetic changes hypotheses. The current adapter avoids those cuts. Use per-clip results to inspect noisy/name regressions; aggregate improvement does not mean every clip improves.

The path-filtered [WER workflow](../../.github/workflows/dictation-wer.yml) caches the pinned source, CPU build and checksum-verified model, measures both recommended profiles on all 34 clips and the three long clips below, uploads both reports, and gates the short and long sets independently against their baselines with one absolute WER percentage point tolerance. CI uses one repeat with two decoder threads to avoid oversubscribing the runner; the report records that override. Multi-repeat tuning remains available locally. The cache is saved immediately after building so inference failures retain it. The 12-minute timeout is a backstop. `--threads` overrides all selected profiles (1–64); `--progress` prints per-clip timings to stderr while preserving JSON on stdout. Ordinary tests remain offline and model-free. Publishing remains the merged-main release process.

### Long recordings

The [long manifest](fixtures/wer/long/manifest.json) joins existing attributed synthetic recordings into 66.025-, 96.810- and 300-second clips without trimming speech. The five-minute clip also includes quiet speech, pauses and names. [Provenance and regeneration](fixtures/wer/long/NOTICE.md) record source IDs, exact hashes and padding; regeneration needs only Python's standard library. Use the command above with `--manifest packages/dictation/fixtures/wer/long/manifest.json` and gate against [its separate baseline](fixtures/wer/long/baseline.json).

Measured with the pinned model/portable AVX2 reader, two threads and three repeats; times are median warm desktop inference:

| Recording | Default WER / inference | App vocabulary WER / inference |
| --- | --- | --- |
| 66.025 s | 0.53% / 4.83 s | 0.53% / 5.69 s |
| 96.810 s | 3.76% / 7.06 s | 1.13% / 7.65 s |
| 300 s | 7.09% / 24.92 s | 10.10% / 23.72 s |

The two 60–120-second recordings score 0.88% combined with app vocabulary (4 edits / 456 words). The five-minute clip has remaining recognition errors, particularly around quiet material and abrupt transitions; extending the capture limit does not guarantee that accuracy. These measurements are synthetic desktop inference, not phone latency or a paired comparison against another app's recordings.
