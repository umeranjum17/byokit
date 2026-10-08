# Message desk

A browser example of `@byokit/decide` on the person's ChatGPT and Claude plans.
It uses BYOKit's real plan sign-ins and `Accounts.respond`, with no rules backend,
API key, alternate billing route or installed tool credentials.
Sign-ins are kept sealed at this computer's machine store (`machineStore`, sealed with
`osKeyringSeal({ service: 'byokit' })`), so a restart or another BYOKit app on this computer
reuses them.

From the repository root:

```sh
npm ci
npm run build
node examples/decide-plan/server.ts
```

Open the printed address on the same computer. Sign in with each plan through its
own provider page. For Claude, paste the returned code into the app. Then select a
plan and choose a message, or ask about all 12 messages. The last case intentionally
omits a deadline: below the 85% confidence floor the app asks Umer directly. Tap Yes
or No to make the human decision. This is kept separate from the model's answer.

The message set covers choice, yes/no and numeric score answers; it includes an
embedded instruction that should not change the classification. Expected labels
are declared in `questions.ts` and never sent to the model. Confidence is always
described as self-reported, never as measured provider confidence or accuracy.

The app allows up to an hour for a provider's sign-in, including human verification.
The provider's own code expiry still applies; expired codes require a new sign-in.

The server listens only on a new loopback port. It rejects other Host headers and
cross-origin mutations; do not expose this single-person example to
the internet. It reads and changes only BYOKit's machine store, never another tool's sign-ins. Only the
messages and their question definitions leave the computer for the chosen plan.

## Live evidence

Each call appends an allowlisted record to
`.lab/evidence/decide-plan/transcript.jsonl`. The transcript includes the captured
commit, provider, requested model, elapsed milliseconds, typed answer, probabilities,
floor, expected answer, correctness and outcome. `modelSource: requested` distinguishes
the selected model from provider-reported metadata. No tokens, raw response bodies
or provider errors are recorded. `/transcript` returns the same records and median
latency. Model ids appear only in the developer transcript, never on screen.

Run each provider's complete set once. Review every answer against its expected
label and confirm `missing-deadline` is a `below-floor` abstention with an actual
probability distribution. `unavailable` means a transport, malformed response or
other failure; it does not count as a correct abstention. Report median latency
honestly, including any miss of the approximately two-second target.
When no valid estimate was received, confidence and its source are null in the
transcript and the screen says "No confidence estimate"; a resolver fallback zero
is never labelled as the model's confidence.

Capture the answer and the abstain with its human response on the live browser
surface, plus a short recording. Keep full-resolution originals and captions
naming the exact commit under `.lab/evidence/`. Record results in [LIVE.md](LIVE.md).
Local mock checks and unsigned-in screenshots do not satisfy the live acceptance.
The live browser page sends real calls to the selected provider; serving the page
locally does not replace the provider with a local model or a mock.

After signing in in the running example, capture each plan with the explicit live
driver. Replace the address with the exact one printed by the example:

```sh
npx playwright install chromium
node examples/decide-plan/capture.ts --live http://127.0.0.1:8080/ chatgpt
node examples/decide-plan/capture.ts --live http://127.0.0.1:8080/ claude
```

The driver clicks the real page, asks all 12 messages, captures full-resolution
screens and a video, and records an operator answer of No when the plan abstains.
It saves every result, including failures. It exits unsuccessfully if any expected
answer is wrong, the missing-deadline handoff is absent, the embedded instruction
changes the result, or the page reports an error. It never completes sign-in or
reads a saved credential. Its output is isolated by provider under
`.lab/evidence/decide-plan/`; Playwright's original video is `live.webm`.

## Offline check

```sh
sh scripts/test.sh examples/decide-plan/e2e.test.ts
```

This exercises the server, real answerer parser and real floor resolver with a fake
account transport. It verifies billing labels, below-floor handoff, same-origin
guards and redaction of errors. It is not live provider evidence.
