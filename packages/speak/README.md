# @byokit/speak

The device path reads replies aloud without a network, provider key or audio file: the web uses `speechSynthesis`,
Android uses `TextToSpeech`, and iOS uses `AVSpeechSynthesizer`. The separate provider path returns audio bytes for host playback.
On Node (and anywhere with no engine) `speaker` is `unsupported` unless the host injects one. Private at 0.1.0.

```ts
import { speaker, SpeakError } from '@byokit/speak';

const voices = await speaker.voices();           // [] where unsupported
const said = speaker.speak('Hi Umer, done', { rate: 1 });
said.on('start', () => console.log('speaking'));
said.on('end', () => console.log('finished'));
said.on('error', ({ error }) => console.log('failed', error.code));
try {
  await said.done;
} catch (e) {
  if (e instanceof SpeakError && e.code === 'unavailable') console.log('silent here');
}
```

`speak(text, { voice, rate, pitch, signal })` returns a handle with `done` (resolves on end, rejects on
error, cancel or abort) and `cancel()` (rejects `done` with code `'interrupted'`). `voice` is a platform
voice id from `voices()`; an unknown id falls back to the platform default. `rate` is 0.25–4 (default 1),
`pitch` is 0–2 (default 1); out-of-range values throw `RangeError`. Empty text rejects with code `'invalid'`.
`stop()` cancels every in-flight utterance. Aborting the `signal` rejects `done` with the signal's reason.

The React Native entry loads the Expo module `ByokitSpeak`. Install into an Expo development build
(Expo Go cannot load it) and rebuild; no permissions or config plugin are needed. A host with its own
engine (tests, Node) injects it:

```ts
import { createSpeaker } from '@byokit/speak';
import type { SpeakEngine } from '@byokit/speak';

declare const engine: SpeakEngine;
const custom = createSpeaker(engine);
await custom.speak('Hi Umer').done;
```

The second example's `engine` is the host's own `SpeakEngine`; `createSpeaker(null)` is the
`unsupported` speaker the default entry uses on Node.

## Use a speech provider

The provider path is separate from the device speaker. The app supplies its own credential and a secure
credential store, and persists the selected provider/voice through its own store. The kit never chooses or
switches either. The reference adapter uses the compatible `/v1/audio/voices` and `/v1/audio/speech` routes;
`speak()` returns MP3 bytes for the host app to play. Device `speaker` remains the labelled fallback.

```ts
import { createProviderSpeech, openAICompatibleSpeech } from '@byokit/speak';
import type { SpeechChoiceStore } from '@byokit/speak';

declare const choiceStore: SpeechChoiceStore;
declare const secureStore: { get(key: string): Promise<string> };
const provider = openAICompatibleSpeech();
const speech = createProviderSpeech([provider], choiceStore); // load/save { provider, voice }
await speech.connect('openai-compatible', {
  apiKey: await secureStore.get('speech-key'), baseUrl: 'https://api.example.com', model: 'tts-1',
});
const voices = await speech.voices('openai-compatible');
await speech.select({ provider: 'openai-compatible', voice: voices[0].id }); // explicit; persist in choiceStore
const mp3 = await speech.speak('Hi Umer'); // play with the host's audio facility
```

The choice store persists selection only, not credentials. The host must retain credentials in secure storage and
reconnect explicitly after restart. A failed provider request rejects with a plain, key-safe error; there is no
fallback to the device voice or another provider.
