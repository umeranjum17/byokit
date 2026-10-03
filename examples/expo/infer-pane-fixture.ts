/** Fixed synthetic lab transcript, never a live terminal/personal input source. Kept below existing pane/context bounds. */
export const REALISTIC_PANE = `
$ cd byokit
$ git status --short
 M packages/infer/src/model.ts
 M packages/infer/test/infer.test.ts
$ node --test packages/infer/test/infer.test.ts
TAP version 13
# Task: fix cancellation and release for local Android text generation.
# A running native decode must stop before the kit releases its context.
# No network provider or cloud fallback is involved in this task.
ok 1 - the catalogue pins exact official files and licences
ok 2 - construction performs no storage or native calls
ok 3 - missing model reports not-installed without attempting generation
ok 4 - unsupported device remains unsupported instead of pretending ready
ok 5 - install downloads only the pinned URL
ok 6 - install verifies the complete file size before accepting weights
ok 7 - install verifies SHA-256 and removes a corrupt download
ok 8 - failed storage preflight reports a typed storage failure
ok 9 - cancelled download can be resumed without losing verified bytes
ok 10 - insufficient free space prevents the download
ok 11 - completion loads one CPU context and checks the model hash
ok 12 - grammar-constrained generation forwards the expected schema
ok 13 - a second completion is rejected while the first is busy
ok 14 - a stopped decode never returns a partial answer as complete
ok 15 - abort before load rejects with the supplied cancellation reason
ok 16 - abort after the first token asks the native decoder to stop
ok 17 - context input overflow reports too-large before starting a decode
ok 18 - summaries remove terminal control sequences from input
ok 19 - summary input redacts token-like strings and private keys
ok 20 - terminal text cannot inject a model chat control token
ok 21 - malformed JSON cannot become a successful summary
ok 22 - insufficient terminal output returns an honest empty result
not ok 23 - release stops a running call and frees the context
  duration_ms: 5003
  failureType: testTimeoutFailure
  error: test timed out after 5000ms
  location: packages/infer/test/infer.test.ts
# Tests: 23
# Passed: 22
# Failed: 1
# The failure is isolated to release during the native formatting gap.
# The same test passes when cancellation happens after a first token.
$ rg -n 'stopCompletion|release|tokenize' packages/infer/src/model.ts
188: const stop = () => { void ctx.stopCompletion().catch(() => {}); };
225: async release(): Promise<void> {
# Read the caller and the fake native decoder before changing the code.
# The binding clears its stop flag when decode starts after chat formatting.
# A stop sent during formatting can therefore be lost before the first token.
# release waits for the active operation, then frees the native context.
# If the decode never observes cancellation, that wait never finishes.
# We must preserve the caller's abort reason and keep public errors typed.
# Existing install, integrity and busy-state tests are still passing.
# Do not change the model, schema, input bounds or the binding version here.
$ npm run check
> byokit-monorepo check
> tsc --noEmit
TypeScript check passed with no errors.
# Current work: add a cancellation guard after tokenization and reassert stop on tokens.
# Keep the release wait; freeing a context under an active decode is unsafe.
# Next: run the single release regression, then run the complete offline test suite.
# Android device confirmation has not been performed for this proposed repair.
# Status: investigation ongoing; the timed-out release test is the current blocker.
`.trim().split('\n');
