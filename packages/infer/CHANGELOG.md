# Changelog

## Unreleased

## 0.1.0 (2026-10-04)

- FIX: Express the summary prompt's success/insufficient branches in the native JSON grammar schema as well as JS validation: true requires 3–4 single-line strings; false requires an empty array. The exact native false-with-four-lines regression stays invalid; no Boolean coercion or contradictory-output acceptance.
- Improved: Serialize summary lines before the adequacy flag so the local decoder produces facts first. The same strict true/3–4-lines and false/empty union, parser and honest refusal remain unchanged.
- FIX: State the successful summary protocol explicitly instead of only giving a negative JSON example. Enforce enough:true with 3–4 single-line strings or enough:false with an empty array; contradictory flags, newlines, extra fields and overlong strings are invalid, never coerced into success.
- FIX: Model-install storage checks now report a typed failure and truthful failed state when size, free-space or an existing-file hash cannot be read, instead of leaving the app looking not-installed with no usable error.
New: `@byokit/infer` 0.1.0: fully local text generation for React Native through an exact optional `llama.rn@0.12.9` peer, a pinned SmolLM2 360M Instruct Q8_0 model (Apache-2.0, 386,404,992 bytes, SHA-256 verified install and removal), one serial native context with AbortSignal cancellation and release, typed unsupported/not-installed/installing/ready/busy/failed states, input/context/output bounds, `summarizePane()` for 3–4 line pane summaries and a `@byokit/decide` generation backend.

SECURITY: Only the pinned model file is ever downloaded; inference has no network path, telemetry or remote fallback. Pane text is redacted, stripped of terminal escapes and treated as untrusted data; a cut-off or malformed answer is never returned as a summary.

Known issues: not yet measured on a phone. Cold/warm latency, peak memory, battery and summary quality on Android and iPhone are unqualified; `minMemoryBytes` and the token margin are provisional.
- FIX: Pane summaries accept only the expected leading assistant header and whole enclosing JSON markdown fence before strict JSON/body/line validation. Insufficient output stays insufficient; trailing garbage and malformed output are rejected. The failed pure-content native option is not used.
- FIX: Install and generation cancellation work with stock React Native AbortSignal without a global polyfill. A supplied cancellation reason is preserved; runtimes without reasons reject with a fixed-message AbortError, and cancelled storage checks never start a model download.
- NEW: Pin the official Qwen2.5-1.5B-Instruct Q4_K_M default candidate with exact revision, bytes, SHA-256, Apache-2.0 licence and native-asset fixture. Smol360M remains catalogued but is no longer offered after its realistic pane run returned insufficient output; no automatic model fallback.
- FIX: Encode insufficient summary lines as a literal empty array and string bounds in the pattern itself. Stock schema-to-grammar conversion ignores array bounds without `items` and string length keywords alongside `pattern`; real b10256 grammar counterfactuals now reject the exact native false-with-four-lines sample, without changing its meaning or coercing its flag.
- FIX: Give rejected summary output its own truthful “The summary was not usable. Try again.” wording, distinct from runtime failure. The Expo demo shows raw completion receipts only with explicit probe opt-in in a development build, never in product UI.
