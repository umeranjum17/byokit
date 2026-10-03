New: `@byokit/infer` 0.1.0 (unreleased): fully local text generation for React Native through an exact optional `llama.rn@0.12.9` peer, a pinned SmolLM2 360M Instruct Q8_0 model (Apache-2.0, 386,404,992 bytes, SHA-256 verified install and removal), one serial native context with AbortSignal cancellation and release, typed unsupported/not-installed/installing/ready/busy/failed states, input/context/output bounds, `summarizePane()` for 3–4 line pane summaries and a `@byokit/decide` generation backend.

SECURITY: Only the pinned model file is ever downloaded; inference has no network path, telemetry or remote fallback. Pane text is redacted, stripped of terminal escapes and treated as untrusted data; a cut-off or malformed answer is never returned as a summary.

Known issues: not yet measured on a phone. Cold/warm latency, peak memory, battery and summary quality on Android and iPhone are unqualified; `minMemoryBytes` and the token margin are provisional.
