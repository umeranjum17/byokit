# The core journey: link an account and get an answer

A person installs byokit's account package into their own app, links their ChatGPT plan with the code the provider shows them, and asks a question that streams an answer back. The drive proves it on the artifact npm ships: the packed `@byokit/accounts` tarball installed into a fresh app outside the monorepo, against the loopback stand-in provider, so no account, no key, no network and no model are needed.

## Sub-features

- `core-journey-install`: the tarball `npm pack` builds from `packages/accounts` (its `prepack` builds the current source, `packages/accounts/package.json:75`) installs into a fresh app outside the monorepo, and the app's import resolves inside that install, never to the monorepo's workspace copy.
- `core-journey-signin`: the app calls `login(1, 'chatgpt')` against the stand-in provider's base URLs (`packages/accounts/src/testing/mock-openai.ts:27`), gets the waiting code `MOCK-…`, the person approves it, and `finished` settles the sign-in.
- `core-journey-status`: `status(1, 'chatgpt')` answers in plain words — `ChatGPT is connected.` (`packages/accounts/src/words.json:15`).
- `core-journey-ask`: `respond` streams the answer and returns it whole — `You said: Plan my day` (`packages/accounts/README.md:58`).
- `core-journey-refusals`: a provider the app does not offer is refused with `AI account not offered here` (`packages/accounts/src/accounts.ts:765`); asking with no account linked is refused with `ResponseError ChatGPT isn't signed in yet.` (`packages/accounts/src/words.json:25`).
- `core-journey-record`: the drive writes the consumer's own transcript and the step record (`steps.json`) into the run's evidence folder, so done-done reads the user steps behind the capture.

## How to get to it (user POV)

- `npm install @byokit/accounts` in your own app, then the README quickstart (`packages/accounts/README.md:51`): construct `Accounts` with the provider's base URLs and your own store, call `login`, show the code, approve it on the provider's page, read `status` and ask with `respond`.
- In an app the provider's base URLs are dropped: the catalogue's own endpoints are used, and the sign-in finishes on the person's own phone or browser.

## Driving it with node scratch consumers

- **Run the maintained capture.** `feature=core-journey; entry=@byokit/accounts; drive=(node .agents/skills/done-done-verify-byokit/capture/core-journey.mjs)`, then SKILL.md Evidence's capture block. Exit code `0`. As a done-done journey it is the `core` journey in `.done-done.yaml`.
- **What the capture does.** It packs the workspace package with `npm pack` (the prepack build runs there), creates a fresh app outside the monorepo, installs the tarball into it, copies the consumer app (`capture/core-journey-consumer.mjs`) next to that install and runs it. The consumer checks that its import resolved inside the installed package, then runs the README quickstart and the two refusals.
- **What the output shows.** `package: @byokit/accounts@0.30.0`, `sign-in: waiting code MOCK-10001`, `status: ChatGPT is connected.`, `streamed: You said: Plan my day`, `answer: You said: Plan my day`, `not offered: Error: AI account not offered here`, `no account: ResponseError: ChatGPT isn't signed in yet.`
- **The capture's own files.** `core-journey.txt` (the transcript) and `steps.json` (the step record) in the run's evidence folder.

## Gotchas

- The install reaches the npm registry for the package's own dependencies, the way any consumer's install does; the provider itself stays on loopback and no credential is ever read.
- The device code is `MOCK-10001` because the stand-in issues it; a real provider's code differs in shape only.
- The consumer asserts that the import resolved inside `node_modules`, so a run against the monorepo's workspace copy fails instead of passing quietly.
- `npm pack` runs the package's `prepack`, so the tarball is the build of the current source; a build error fails the journey loudly.
