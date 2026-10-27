# @byokit/audio

Shared on-device audio detection. One streaming speech detector, one pinned MIT graph, and
no network, no keys, no microphone: the app supplies the inference session and the model
bytes, the kit owns every decision a consumer can observe.

Consumed by [`@byokit/dictation`](../dictation/README.md): the live turn gate runs through it
whenever the app supplies a detector, while offline segmentation runs through it only
when `vad.enabled` is true. That package's README owns the gating contract.

## What it is

`createVad({ session })` wraps one host-run graph and gives you per-frame speech decisions
and padded speech segments:

```ts
import { createVad } from '@byokit/audio';
import { sileroSession } from '@byokit/audio/node';
import { createRequire } from 'node:module';

const session = await sileroSession('/path/to/silero_vad.onnx', createRequire(import.meta.url)('onnxruntime-node'));
const vad = createVad({ session });
declare const pcmFromYourCapture: Int16Array; // 16 kHz mono PCM16, any length
await vad.push(pcmFromYourCapture);
await vad.flush();                          // score the trailing partial window
vad.ranges();                               // [[216, 2984]] in ms, hangover and padding applied
await vad.release();                        // disposes the session this detector used
```

A session is the only seam. The kit owns the window framing (512 fresh samples plus 64
carried, the published graph's own contract), the recurrent state, the 0.5 threshold, the
hangover and the padding, so a Node, React Native and browser consumer segment identically.
A host on another runtime implements one function:

```ts
type VadSession = {
  run(window: Float32Array, state: Float32Array | null): Promise<{ probability: number; state: Float32Array }>;
  release?(): Promise<void> | void;
};
```

**One stream, one session.** A session carries recurrent state, so two streams sharing one
would interleave it. `release()` disposes the session it was created with; `reset()` clears
the stream without disposing, which is how a host reuses one warm session.

## The pinned model

`SILERO_VAD_5_1` is the pinned graph, verified by content: `sha256 2623a295…`, 2 327 524 bytes,
published tag `v5.1` of `snakers4/silero-vad` under plain MIT, which upstream states covers
the pretrained VAD without restriction. The kit never downloads it — bytes that are not the
pinned graph are rejected before any inference runs, because a wrong graph segments
silently and wrongly and no later check would catch it.

## Why this detector

Chosen by measurement, not by reputation. Against the unchanged energy gate in
`@byokit/dictation`, on this repository's own committed fixtures (`fixtures/vad`, 13 clips,
81.7 s, see its `NOTICE.md` for provenance and limits), at the untuned upstream default of
0.5:

| | energy gate (unchanged) | this detector |
|---|---|---|
| missed speech | 11.87% | **10.10%** |
| false-positive bins on recorded hiss (3 clips) | 150 | **0** |
| false-positive bin share of non-silent nuisance | 83.33% | **28.33%** |
| onset latency p50 / p90 / max | **20 / 40 / 60 ms** | 48 / 112 / 176 ms |
| CPU, warm, one thread | 0.0055% of a core | **1.45% of a core** |
| session init / first frame | – | 50–70 ms / 2.3–2.7 ms |

The quiet clip is the clearest single result: energy misses 92 of its bins, this detector 18.
Onset is the honest cost, 28 ms at the median.

Reproduce it against the real graph, on CPU. `onnxruntime-node` is an optional peer that this
repository deliberately does not install, so install it yourself first:

```sh
npm install --no-save onnxruntime-node@1.24.3   # the exact version these numbers were measured on
node packages/audio/scripts/measureVad.mjs --model /path/to/silero_vad.onnx
```

The run also replays the real dictation consumer through both built exports.

### What these numbers are not

Desktop only, on an unpinned-boost x86_64 core; a handset budget is different and unmeasured,
as is any emulator, device or microphone. The corpus carries 6.0 s of non-silent nuisance, so
read the false-trigger result as a separation, not a real-world rate. Babble is other speech
and this detector fires on it: it detects speech, it does not identify a speaker. `1.45% of a
core` is what this kit's Node adapter costs through `onnxruntime-node`; the graph alone
measured 0.24% under a leaner Python reference loop, so roughly five-sixths of the shipped
figure is the JavaScript/native boundary, not the model.

## Platform support

`.` is portable: no Node, no React Native, no browser-only API. `./node` is the Node/desktop
adapter and is the only entry that imports `onnxruntime-node`, declared as an **optional**
peer — an app on another runtime never installs it and supplies its own session instead.
`./react-native` is the React Native adapter and mirrors `./node`: `sileroSession(bytes, onnxruntime-react-native)` takes the
app's bundled copy of the pinned graph (verified by size and a pure-JS SHA-256, no `node:*` import) and runs it on the CPU provider.
`onnxruntime-react-native` 1.24.3 is a second **optional** peer; the app installs it and passes it in. Its unit proof is a
deterministic fake runtime, so handset CPU and battery are unmeasured.
Nothing here starts a GPU or a local service; the CPU execution provider is the only one used.
## Wake word (Android)

`createWake({ session })` listens for a wake word with a graph **you supply**; this kit bundles, pins and
downloads no wake model, so no model licence or training-data provenance is implied by installing it.
On Android, `wakeSession(bytes, onnxruntime-react-native)` from `@byokit/audio/react-native` runs your graph on the CPU provider:

```ts
import { createWake } from '@byokit/audio';
import { wakeSession } from '@byokit/audio/react-native';
declare const graphBytes: Uint8Array; // your wake graph, from your app's assets
declare const pcm16kMono: Int16Array;
const wake = createWake({ session: await wakeSession(graphBytes, require('onnxruntime-react-native')) });
for (const hit of await wake.push(pcm16kMono)) console.log(hit.atMs, hit.score);
```

The graph contract: input `audio`, float32 `[1, 24000]` (the trailing 1.5 s of 16 kHz mono PCM in [-1, 1],
zero-filled before the stream began); output `score`, float32, first element in [0, 1]. It is stateless
and does its own feature extraction. The kit scores it every 80 ms and owns the window, the 0.5 threshold,
`patience` (2 consecutive hops) and a 2 s cooldown. A score outside [0, 1] is `bad-model`.

**iOS: wake works only while the app is foregrounded.** iOS suspends an app's microphone in the background,
so `createWake` can listen only while your app is open and on screen; there is no always-listening path
on iPhone. Its unit proof is a deterministic fake runtime; handset CPU, battery and accuracy are unmeasured.
