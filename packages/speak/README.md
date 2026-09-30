# @byokit/speak

Read a reply aloud through the platform's own text-to-speech. No network, no provider keys, no audio files:
the web speaks through `speechSynthesis`, Android through `TextToSpeech`, iOS through `AVSpeechSynthesizer`.
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
