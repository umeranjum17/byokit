# Message desk

A browser example of `@byokit/decide` on the person's ChatGPT and Claude plans.
It uses BYOKit's real plan sign-ins and `Accounts.respond`, with no rules backend,
API key, alternate billing route, saved account folder or installed tool credentials.
Sign-ins live only in the server's memory and are discarded when it closes.

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
cross-origin mutations; do not expose this memory-only, single-person example to
the internet. It neither reads nor changes the person's other sign-ins. Only the
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

Capture the answer and the abstain with its human response on the live browser
surface, plus a short recording. Keep full-resolution originals and captions
naming the exact commit under `.lab/evidence/`. Record results in [LIVE.md](LIVE.md).
Local mock checks and unsigned-in screenshots do not satisfy the live acceptance.
The live browser page sends real calls to the selected provider; serving the page
locally does not replace the provider with a local model or a mock.

## Offline check

```sh
sh scripts/test.sh examples/decide-plan/e2e.test.ts
```

This exercises the server, real answerer parser and real floor resolver with a fake
account transport. It verifies billing labels, below-floor handoff, same-origin
guards and redaction of errors. It is not live provider evidence.
