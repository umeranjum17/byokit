# @byokit/infer

Text generation on the phone itself, for React Native on Android and iOS: one pinned, publicly licensed model that
your app downloads once with an integrity check, one native context, and nothing sent anywhere afterwards. It also
gives you a ready 3–4 line terminal-pane summary and a backend for `@byokit/decide`'s `generate()`.

> Unreleased (`private: true`) until it is qualified on a real Android phone and iPhone. See
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

`model()` is SmolLM2 360M Instruct, Q8_0 GGUF, 386,404,992 bytes, Apache-2.0, pinned to the publisher's revision and
SHA-256. `models()` also lists Qwen3 0.6B (`offer: false` until qualified).

- **One call at a time.** A call while another runs rejects `busy`; cancel the old one with its `AbortSignal`, which
  stops the native decode and rejects with `signal.reason` once it has stopped. `release()` stops and frees the context.
- **Bounds.** 2,048-token context, 256 output tokens, 12,000 input characters, four threads, CPU only by default;
  `limits` narrows them. Input that does not fit rejects `too-large`.
- **Truthful states.** `unsupported` (no binding, wrong ABI, too little memory), `not-installed`, `installing`,
  `installed`, `loading`, `ready`, `busy`, `failed`. A download that does not match the pinned size and SHA-256 is
  removed and rejects `integrity`.
- **Private by construction.** Inference has no network path, no telemetry and no remote fallback. Pane text is
  treated as data, never as instructions: no tools, no execution. A cut-off or malformed answer is never shown as a
  summary. `log` never receives prompt, pane or generated text.
- **No account, no billing.** Local inference uses no sign-in, subscription or API key.

`generationBackend(local)` plugs the phone's model into `@byokit/decide`'s `generate()` with `privacy: 'stays-here'`.
`./testing` has `fakeLlama()` and `memoryModelStore()` for offline tests.
