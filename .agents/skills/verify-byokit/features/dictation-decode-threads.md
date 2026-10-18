# Dictation decode threads

A person dictates on a small phone. The built `@byokit/dictation` engines decode with at most as many threads as the device has cores. The old fixed default of 6 threads made a 2-core device decode 5 s of speech in about 52–79 s instead of about 4 s.

## Sub-features

- `threads-from-cores`: with no `settings.threads`, `whisperSettings().threads` is the cores the platform reports (`navigator.hardwareConcurrency`), at most 8. 2 cores give 2 and 16 cores give 8. `whisperRnEngine` sends that count as `maxThreads`.
- `threads-react-native`: React Native reports no core count. There `threads` is `undefined` and `whisperRnEngine` sends no `maxThreads`, so whisper.rn picks from the native core count (`cores == 4 ? 2 : min(4, cores)`).
- `threads-cli`: `whisperEngine` from `@byokit/dictation/node` passes `-t` = `os.availableParallelism()`, at most 8, to the app's whisper.cpp CLI.
- `threads-explicit`: an explicit `threads` (1–64) from the app wins on every path.

## How to get to it (user POV)

- The consumer builds `whisperRnEngine({ model, initWhisper })` or `whisperEngine({ binary, modelPath })` without `threads` and transcribes. The decode runs on the device's cores.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-dictation-threads.mjs"` importing `{ Dictation, whisperRnEngine, whisperSettings }` from `@byokit/dictation` and `{ whisperEngine }` from `@byokit/dictation/node`. Override `globalThis.navigator` with `Object.defineProperty(globalThis, 'navigator', { value, configurable: true })`, and restore it afterwards. Then print:
  - `whisperSettings().threads` for `{ hardwareConcurrency: 2 }`, `{ hardwareConcurrency: 16 }` and `undefined` (expect 2, 8 and `undefined`).
  - For each of those three, build a `whisperRnEngine` with a stub `initWhisper`, transcribe a short WAV, and print the `maxThreads` that `transcribeData` received. Expect 2, 8, and no key at all. Do it again with `settings: { threads: 3 }`; expect 3 every time.
  - Write a fake CLI script that records its `-t` argument and writes the expected JSON. Run `whisperEngine({ binary, modelPath })` with it, and again with `threads: 3`. Expect `min(os.availableParallelism(), 8)`, then 3.
- **Run and capture.** `feature=dictation-decode-threads; entry=@byokit/dictation; drive=(node "$scratch_dir/verify-dictation-threads.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Extreme case.** 2 cores: the unfixed build (`@byokit/dictation` 0.5.1) sends `maxThreads: 6` and `-t 6`. The fixed build sends 2, and sends nothing when there is no count.

## Native cost on a device

The stubs prove which count is sent. The cost was measured with whisper.rn 0.7.2's own vendored whisper.cpp, which drove the built kit's `whisperRnEngine` on the 5.2 s `x-clean-1.wav` take.

- On a private 2-core x86_64 API 35 emulator, 6 threads took 56–79 s to text. With no count sent, whisper.rn chose 2 threads, which took 4–7 s.
- On a 32-core host, 6 threads took about 3.2 s and the new default of 8 took about 2.5 s. All 32 cores on the busy host took 3.7–20.6 s, which is why the default is capped at 8.

The harness and logs are in the PR's private evidence page.

## Gotchas

- Import from the published entries; never from `packages/dictation/src`. No model, device or network is needed for the stub proof.
- Node exposes `navigator.hardwareConcurrency` (= `os.availableParallelism()`). To act like React Native, override `navigator` to `undefined`, or run Node with `--no-experimental-global-navigator`.
- `whisperRnEngine` resolves settings when it is built, so set the core count before you build the engine.
