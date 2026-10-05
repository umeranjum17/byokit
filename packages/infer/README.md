# @byokit/infer

Text generation on the phone itself, for React Native on Android and iOS: Android's built-in Gemini Nano where the
phone has it, else one pinned, publicly licensed model that your app downloads once with an integrity check; one
native context, and nothing sent anywhere afterwards. It also
gives you a ready 3–4 line terminal-pane summary and a backend for `@byokit/decide`'s `generate()`.

> First public release 0.1.0, published before phone qualification by byk decision: latency, memory, battery
> and summary quality on a real Android phone and iPhone are still unmeasured. See
> [the specification](../../docs/infer-kit.md) for scope, limits and what is still unmeasured.

## Install

```sh
npm install @byokit/infer llama.rn@0.12.9 @dr.pogodin/react-native-fs
```

`llama.rn@0.12.9` (MIT, llama.cpp build 10256) is an optional exact peer: importing the kit never imports or starts a
native module. It needs React Native's New Architecture and a development build (not Expo Go); follow its
[installation notes](https://github.com/mybigday/llama.rn/tree/v0.12.9). Android runs on `arm64-v8a` and `x86_64`.

## Use

Your app imports `initLlama` from `llama.rn` and supplies a store over its own file system. The full adapter over
`@dr.pogodin/react-native-fs` (download with progress and cancel, native SHA-256, free space) is in
[examples/expo/InferDemo.tsx](../../examples/expo/InferDemo.tsx), typechecked against the real packages.

```ts
import { LocalModel, model, summarizePane, stateWords, type InferModelStore, type InitLlama } from '@byokit/infer';

export async function summarize(initLlama: InitLlama, store: InferModelStore, paneLines: string[], signal: AbortSignal,
  show: (text: string) => void) {
  const local = new LocalModel({ model: model(), store, initLlama, device: { platform: 'android' }, onState: s => show(stateWords(s)) });
  await local.install({ onProgress: (got, total) => show(`${got} / ${total}`) }); // only network use: the pinned model file
  const summary = await summarizePane(local, paneLines, { signal });               // { ok: true, lines } | { ok: false, code }
  await local.release();                                                            // also when the app goes to the background
  return summary;
}
```

`model()` is the official Qwen2.5 1.5B Instruct Q4_K_M candidate, 1,117,320,736 bytes, Apache-2.0, pinned to the
publisher's revision and SHA-256. Physical qualification on a real phone is still pending. `models()` retains SmolLM2
360M and Qwen3 0.6B with `offer: false`; it never switches models automatically.

- **One call at a time.** A call while another runs rejects `busy`; cancel the old one with its `AbortSignal`, which
  stops the native decode and rejects with `signal.reason` once it has stopped, or a fixed-message `AbortError` when
  the runtime has no reason (stock React Native). No global polyfill is needed. `release()` stops and frees the context.
- **Bounds.** 2,048-token context, 256 output tokens, 12,000 input characters, four threads, CPU only by default;
  `limits` narrows them. Input that does not fit rejects `too-large`.
- **Truthful states.** `unsupported` (no binding, wrong ABI, too little memory), `not-installed`, `installing`,
  `installed`, `loading`, `ready`, `busy`, `failed`. A download that does not match the pinned size and SHA-256 is
  removed and rejects `integrity`.
- **Private by construction.** Inference has no network path, no telemetry and no remote fallback. Pane text is
  treated as data, never as instructions: no tools, no execution. A cut-off or malformed answer is never shown as a
  summary. `log` never receives prompt, pane or generated text.
- **No account, no billing.** Local inference (Nano or GGUF) uses no sign-in, subscription or API key.

## Gemini Nano

On Android phones whose AICore has Gemini Nano, local generation can use that built-in model instead of the download.
The kit imports no Android code: the app passes its native module over ML Kit GenAI Prompt (`NanoBinding`, typed after
`1.0.0-beta4`). Without one, or when AICore says no, is silent for 3 s or fails, Nano is `unsupported` and local uses
the GGUF model.

```ts
import { inferBackend, NanoModel, whereWords, type LocalModel, type NanoBinding } from '@byokit/infer';

declare const nanoModule: NanoBinding | undefined;
declare const localModel: LocalModel;
declare const show: (text: string) => void;

const nano = new NanoModel({ binding: nanoModule });                           // undefined on iOS: unsupported
const local = await inferBackend({ where: 'local', gguf: localModel, nano });  // Nano when ready, else GGUF
const { text } = await local.generate({ prompt: 'Say hello.' });               // or decide's generate() with a schema
show(whereWords(local));                                                       // "Runs on this phone with its built-in model."
```

The choice is made once per `inferBackend()`; a call never falls back to the other model. `local.local` is the full
typed pass-through (`nano.binding` is the whole Prompt surface the module exposes). Show Nano's state with
`stateWords(s, { nano: true })`: Android owns its download. Nano has no grammar from JavaScript: a schema is asked for
in the instructions and JSON validation stays authoritative. `./testing` has `fakeNano()`.

`generationBackend(local)` plugs the phone's model into `@byokit/decide`'s `generate()` with `privacy: 'stays-here'`.
`./testing` has `fakeLlama()` and `memoryModelStore()` for offline tests.
