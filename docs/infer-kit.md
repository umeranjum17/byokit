# On-device text generation: `@byokit/infer`

Status: **foundation (2026-10-02)**. Source skeleton, offline tests and this spec are on main; the package is
`private: true` and is not published until the qualification gates in §6 are recorded. Names, errors, state, words and
construction follow [kit-conventions.md](kit-conventions.md); this spec adds what is specific to this kit and is
binding for its builders. A signature or decision change is a spec change first.

## 1. Goal

A React Native app on Android and iOS writes a 3–4 line summary of a terminal pane **on the phone**. After one
explicit, integrity-checked model download, no pane text, prompt, summary, metric or log leaves the phone, and there
is no remote fallback. Every app consumes the published kit; no app installs a raw model SDK of its own.

Feasibility and the gap this fills: `@byokit/decide` 0.6.x already has portable `generate()` with schema validation
and `privacy: 'stays-here'`, but no native model loader, inference binding, verified model catalogue or device
support check. `@byokit/dictation` is speech, not text. This kit is that missing native runtime adapter.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| I1 | Package `@byokit/infer`, first version **0.1.0**, `private: true` until §6 passes. Name accepted by Root for first publication (kit-conventions §1.2). | One plain word for the capability (run a model here). `generate`/`decide` are already function names. |
| I2 | Native binding: stock published **`llama.rn@0.12.9`** (npm, MIT, 2026-08-04, gitHead `2a20c13e6665cc7278f68c6b2b5819899d0e84fd`, llama.cpp build `10256`/`6c8dcaa`), an **exact optional peer**. The kit types a structural subset and the host injects `initLlama`, as dictation does with whisper.rn. | Same engine family as the shipped dictation kit; one GGUF path for Android and iOS; prebuilt Android JNI libs and iOS XCFramework pinned by SHA-256 in its own `install/native-artifacts.json`. Latest stable, not the `0.13.0-rc.*` `latest` tag. No fork or patch. |
| I3 | First model: **SmolLM2-360M-Instruct Q8_0 GGUF** (§3). Qwen3-0.6B Q8_0 is catalogued with `offer: false` as the fallback if SmolLM2 cannot keep technical detail. | Smallest candidate with an official GGUF, Apache-2.0, card lists summarisation. Gemma 3 270M has no official GGUF and a separate licence; not a first choice. |
| I4 | One `LocalModel` per model: at most one native context; calls never queue (`busy`). | A pane summary is only useful for the card on screen; queued stale work wastes battery. |
| I5 | Greedy decoding (`temperature: 0`, `seed: 0`), CPU only (`n_gpu_layers: 0`), `n_ctx` 2048, ≤256 output tokens, 4 threads, `use_mmap`, no `mlock`. Thinking off through the template (`enable_thinking: false`). | Repeatable output, predictable memory; GPU offload is device-specific (Android OpenCL is Adreno-only) and is a later measured opt-in. |
| I6 | Summaries are grammar-constrained JSON `{enough, lines[≤4]}` (llama.rn `response_format: json_schema` with stock `force_pure_content: true`) and validated again in JS. The pure-content flag avoids Jinja assistant headers/fences in schema completions; validation never strips those wrappers. | The model cannot ramble or emit a partial structure that looks complete; `enough: false` is the honest "not enough output" path. |
| I7 | Storage is the host's (`InferModelStore`, e.g. over `@dr.pogodin/react-native-fs@2.40.3`: `downloadFile`, native `hash(path, 'sha256')`, `getFSInfo`). The kit checks free space, size and SHA-256, and removes a mismatching file. | Hashing a 386 MB file must be native; storage location is an app choice. |
| I8 | No dependency on `@byokit/decide`: `generationBackend()` returns a structurally identical `GenerationBackend`, pinned by `test/backend.test.ts`. | decide pulls `openai`/accounts; a phone that only summarises does not need them. |

## 3. Model and binding facts (verified 2026-10-02; builders must not re-derive)

Verified from the publisher's Hugging Face API (`?blobs=true`) and `HEAD` of the `resolve` URL at the pinned
revision (`x-repo-commit`, `x-linked-size`, `x-linked-etag`). No weights were downloaded.

| | SmolLM2-360M-Instruct (first) | Qwen3-0.6B (fallback, `offer: false`) |
|---|---|---|
| repo | `HuggingFaceTB/SmolLM2-360M-Instruct-GGUF` | `Qwen/Qwen3-0.6B-GGUF` |
| revision | `593b5a2e04c8f3e4ee880263f93e0bd2901ad47f` | `23749fefcc72300e3a2ad315e1317431b06b590a` |
| file | `smollm2-360m-instruct-q8_0.gguf` | `Qwen3-0.6B-Q8_0.gguf` |
| bytes | 386,404,992 | 639,446,688 |
| SHA-256 | `48ab3034d0dd401fbc721eb1df3217902fee7dab9078992d66431f09b7750201` | `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` |
| licence | Apache-2.0 (card metadata; repo has no LICENSE file) | Apache-2.0 (LICENSE file in repo) |
| trained context | 8,192 (`max_position_embeddings`) | 32,768 (card) |
| template | ChatML, no thinking | ChatML with thinking; disabled via `enable_thinking: false` |

llama.rn 0.12.9: requires the New Architecture (since 0.10); Android ABIs `arm64-v8a` and `x86_64` only; iOS
podspec minimum 13.0; its `postinstall` downloads `llama-rn-android-jni-libs.tar.gz`
(`cda945a7…65ac`) and `llama-rn-ios-xcframework.tar.gz` (`ae9a37ae…c4ae`) from its own GitHub release `v0.12.9`
and checks those SHA-256s. npm tarball integrity
`sha512-uRsTVARp1KnDkDg00FvOGIrN6SZfMqYVJfCOdxN9FSyGufLC+Aad6oFWZVEO8vmtNqu+JBlsCGevP4sJGifAvg==`. The byokit
monorepo does **not** install it (offline CI); the lab app does.

## 4. Module seams (`packages/infer/src`)

| file | owns |
|---|---|
| `types.ts` | `InferError`/`InferErrorCode`, `InferModel`, `InferState`, `InferDevice`, `InferLimits`, `InferModelStore`, `CompleteRequest`, `Completion` |
| `model.ts` | llama.rn structural subset (`InitLlama`, `LlamaRnContext`, params/result), `LocalModel`, `DEFAULT_LIMITS`, model/limit validation |
| `backend.ts` | `generationBackend(local)` for decide's `generate()` |
| `summary.ts` | `summarizePane`, `paneText`, `plainText`, `redact` |
| `models.json` | the pinned catalogue (§3); `index.ts` validates every entry at import |
| `words.json`/`words.ts` | `infer.*` sentences, `stateWords`, `errorWords` |
| `testing.ts` (`./testing`) | `fakeLlama()`, `memoryModelStore()` |

`LocalModel` API: `new LocalModel({ model, store, initLlama?, device?, limits?, onState?, log? })` (no I/O);
`state`; `check()`; `install({ signal, onProgress })`; `remove()`; `complete({ system?, prompt, maxOutputTokens?,
jsonSchema?, signal })`; `release()`. Errors: `unsupported`, `not-installed`, `invalid`, `integrity`, `no-space`,
`network`, `busy`, `too-large`, `incomplete`, `failed`; aborts reject with `signal.reason` when provided, otherwise an
`Error` named `AbortError` with a fixed cancellation message. Guards use `aborted` and listeners only: stock React Native
AbortSignal has neither `throwIfAborted()` nor `reason`; no global polyfill or upstream patch is required.

`summarizePane(local, lines, { signal, maxLines = 80, maxChars = 6000 })` →
`{ ok: true, lines, model, ms, inputLines } | { ok: false, code: 'not-enough-output' | 'incomplete' | 'invalid-output' }`.
Under 40 visible characters returns `not-enough-output` without loading the model.

Privacy invariants (each has a test): the kit imports nothing from Node or React Native; the bundled main entry has
no `fetch`, `XMLHttpRequest` or `WebSocket`; the only URL a store is asked to fetch is `model.url` (https, pinned
revision); `log` receives fixed diagnostics only; native exception text never reaches `message`; every prompt has
the template's control tokens (`<|…|>`, `<think>`) made inert, and pane text has every `<`/`>` replaced so no tag or
token can be formed; redaction and escape stripping are linear and run on capped lines (newest `4 × maxLines`, 2,000
characters each) so hostile output cannot stall the JS thread.

Cancellation detail (verified in llama.rn 0.12.9 sources): `stopCompletion()` only sets `is_interrupted`, and the
native completion's `rewind()` clears it, so a stop that lands while llama.rn is still formatting the chat is lost.
`complete()` therefore re-checks the signal and `release()` before decoding and re-asserts the stop from the
per-token callback.

## 5. Work packages (builders)

Native heavy jobs use their own short scratch `HOME`/`TMPDIR`, hold `state/heavy-jobs.lock` (fd 9) with a separate
bounded wait and execution, clean up only their own children, and keep raw failures, model/licence/hash receipts and
measurement logs outside the pooled worktree before cleanup.

- **WP1 — Lab app wiring (Android).** *Source done:* `examples/expo` pins `llama.rn@0.12.9`,
  `@dr.pogodin/react-native-fs@2.40.3` and `@byokit/infer`; `InferDemo.tsx` (opened by `EXPO_PUBLIC_INFER_DEMO=1`)
  uses the README's store adapter and shows the typed phase, download progress, stop download, remove,
  three fixed demo panes (a test run with one hanging test, a Kotlin build failure, an idle shell), summary lines with
  timing, cancel, and flip-to-cancel. Going to the background releases the context. Typecheck and Metro Android
  bundle pass locally; no native build has been run. **Still to do on a device-capable runner:**
  `CI=1 npx expo prebuild -p android --no-install`, then `assembleRelease` with `EXPO_PUBLIC_INFER_DEMO=1` (CI's
  overlay/share Android jobs already compile the new native modules). The first `npm ci` in `examples/expo` runs
  llama.rn's postinstall, which fetches its SHA-256-pinned prebuilt libraries from its v0.12.9 GitHub release.
  Confirm the APK contains `lib/arm64-v8a/librnllama*.so` (`e2e-infer.sh` refuses without it).
- **WP2 — Real-binding contract.** A device-run script (no CI network) that runs the kit's offline assertions against
  the real `initLlama`: one context, abort → `interrupted` and the supplied reason (or `AbortError` when unavailable),
  `release()` mid-decode, JSON schema
  honoured, `tokenize` count vs `tokens_evaluated` (set `TEMPLATE_TOKENS` from it), `stopped_limit` on a tiny budget.
- **WP3 — Android qualification on test phone a4b93ea2** under the discovered keeper lock (never bypassed, never
  shared). Own lab app only; never open, read or screenshot personal apps, change accounts or uninstall anything.
  Run, holding the keeper lock and `state/heavy-jobs.lock` for the build:
  `OUT=<receipts dir outside the worktree> RUNS=10 examples/expo/e2e-infer.sh a4b93ea2` (`KEEP_MODEL=1` reuses
  a downloaded model; `SKIP_BUILD=1` reuses a verified APK). It writes `receipts.txt` and the screenshots listed below:
  - receipts: device, OS and ABI; APK SHA-256 and size; download and verify seconds; cold time (fresh process:
    load + hash + first summary) and `RUNS` warm times; PSS/RSS after cold, after warm and after backgrounding;
    battery level, temperature and charger before and after.
  - screenshots: `01-start` … `08-resumed`.

  Add by hand: screen brightness and state, charging off, ambient conditions; a longer fixed battery run
  (e.g. 30 summaries) if the level delta is 0; an airplane-mode rerun with `KEEP_MODEL=1` to show summaries need no
  network. Tune `minMemoryBytes` from the data.
- **WP4 — Summary quality.** Score the three demo panes plus ≥20 recorded synthetic panes (no personal data) for
  invented completion, missed failure and noise; if SmolLM2 fails, re-run with Qwen3 and propose flipping `offer`.
- **WP5 — iOS.** Same lab app on a physical iPhone once Root/main grants the Mac and Xcode 26.2 is installed; same
  measurements as WP3. Simulator results are labelled Simulator and never stand in for the phone.
- **WP6 — Release prep.** Owner confirms the name; flip `private`; add `infer` to CI pack smoke; New/Fixed/Improved/
  Known issues lines from `changes/`; sole publisher `byk-launch-env` publishes after exact-main CI and an installed
  public-tarball proof.

## 6. Acceptance checklist

Source (CI, offline) — done in the foundation unless marked:
- [x] `npm run build`, `npm run check`, `npm test` green; main entry bundles for React Native with nothing from Node.
- [x] Catalogue pins revision, URL, bytes, SHA-256, licence; validated at import.
- [x] Install downloads only `model.url`; size + SHA-256 checked; mismatch removed (`integrity`); `no-space`,
      `network`, abort distinct; re-hash before first load.
- [x] One context; second call `busy`; abort stops native decode and rejects with the supplied reason (or `AbortError`), including an
      abort during tokenize or before llama.rn's decode starts; `release()` stops (also while loading), waits and
      frees; `remove()` releases then deletes; no failure path leaves `installing` or `loading` behind.
- [x] Input over characters or context → `too-large`; cut-off → `stop: 'limit'`, never a summary.
- [x] Pane text: escapes stripped, secrets redacted (best-effort: env names, flags, URL userinfo, key blocks, long
      key-like runs), chrome collapsed, no tag or chat control token can be formed, system prompt says
      data-not-instructions, linear on hostile input; `enough: false` → `not-enough-output`.
- [x] decide `generate()` with `privacy: 'stays-here'` uses the backend; cut-off → `incomplete`.
- [x] WP1 source: lab screen, exact pins, store adapter, device driver script; typecheck and Metro bundle pass.
- [ ] WP1 lab app builds with the real binding (Android `assembleRelease`, APK has arm64 `librnllama`), and the iOS prebuild.
- [ ] WP2 real-binding contract passes on a4b93ea2.

Device qualification (not provable by fixtures, typechecks or emulators):
- [ ] WP3 Android numbers and demo screenshots, with exact device, OS, conditions and limits.
- [ ] Airplane-mode run: summaries still produced after install; no network traffic from the lab app during inference.
- [ ] WP4 quality notes; no fabricated completion on the demo set.
- [ ] WP5 iPhone numbers and screenshots on a physical device.
- [ ] Owner-confirmed name; publication by the sole publisher only.

Known limits now: no measured latency, memory, battery or quality on any phone; redaction is pattern-based; Android
download does not resume (RNFS resumes on iOS only); first load re-hashes the file (native, a few seconds, unmeasured).
