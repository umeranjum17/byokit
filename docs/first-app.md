# Build a bring-your-own-plan app in 5 minutes

You have never seen byokit. In five minutes you will: install two packages,
sign in with a ChatGPT plan, get a first answer, make a first decision, and
learn the one-line switch from the offline stand-in to the live plan.

No account, no API key, no network beyond your own machine until step 4.
Steps 1–3 run against the kit's stand-in OpenAI (`mockOpenAI()`), which answers
sign-in and streamed answers on `127.0.0.1`.

## 0. You need: Node 22.18 or newer (30 seconds)

```sh
node --version  # want v22.18.0 or newer
```

Node runs the `.ts` files below directly (type stripping). Older Node cannot —
see error 5.

## 1. Install (1 minute)

```sh
mkdir first-app && cd first-app
npm init -y
npm pkg set type=module # Node runs the `.ts` files below as modules
npm install @byokit/accounts @byokit/decide
```

## 2. Sign in and get a first answer (2 minutes)

Save this as `first-app.ts`. It is complete — paste it verbatim.

```ts
import { Accounts, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';

const mock = await mockOpenAI(); // stand-in OpenAI on 127.0.0.1 — no account, no network
const accounts = new Accounts({ authBase: mock.base, apiBase: mock.base }, portable);

const shown = await accounts.login(1, 'chatgpt', { via: 'code' });
console.log('Open this page:', shown?.url);
console.log('Type this code:', shown?.code);
mock.approve(shown!.code!); // on the live plan, YOU type the code on the provider page
await accounts.finished(1, 'chatgpt');
console.log((await accounts.status(1, 'chatgpt')).words);

console.log(await accounts.respond(1, { instructions: 'Answer briefly.', input: 'Plan my day' }));
await mock.close();
```

```sh
node first-app.ts
```

You should see exactly this (port number varies):

```text
Open this page: http://127.0.0.1:38239/codex/device
Type this code: MOCK-10001
ChatGPT is connected.
You said: Plan my day
```

The stand-in echoes your question. Live, that last line is the model's own
answer. Everything else — sign-in, status words, streaming — is the real path.

## 3. Make a first decision (1 minute)

`@byokit/decide` turns a question into a typed answer with confidence, and
abstains below its floor instead of guessing. Save this as `decide-first.ts` —
it stays on your machine, no sign-in needed:

```ts
import { decide, rules } from '@byokit/decide';

const backends = [rules((s) => (/^(thanks|thank you)\b/i.test(s.text) ? 'chat' : undefined))];
const { intent } = await decide({ text: 'thanks, that worked!' }, {
  intent: { kind: 'choice', options: {
    task: 'Something new to do',
    followup: 'About an earlier job',
    chat: 'Just talking',
  } },
}, { privacy: 'stays-here', backends });
console.log(intent.answer, '| abstained:', intent.abstained);
```

```sh
node decide-first.ts
```

```text
chat | abstained: false
```

Try `'can you check if the plumber replied?'` instead: the rules say nothing
about it, so the answer abstains (`null | abstained: true`) and your app asks
the person. That abstention is the feature — see error 4 for the mock gotcha.

To decide with the plan instead of rules, point a backend at a ChatGPT
sign-in. Save this as `decide-chatgpt.ts` — complete, paste it verbatim
(it signs in on the mock first, so it runs as-is):

```ts
import { Accounts, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { answerer, decide } from '@byokit/decide';

const mock = await mockOpenAI();
const accounts = new Accounts({ authBase: mock.base, apiBase: mock.base }, portable);
const shown = await accounts.login(1, 'chatgpt', { via: 'code' });
mock.approve(shown!.code!);
await accounts.finished(1, 'chatgpt');

const chatgpt = answerer({
  name: 'chatgpt',
  leaves: true,
  ask: (prompt, signal, _images, request) => accounts.respond(1, { ...request, input: prompt, signal }),
});
const { intent } = await decide({ text: 'can you check if the plumber replied?' }, {
  intent: { kind: 'choice', options: {
    task: 'Something new to do',
    followup: 'About an earlier job',
    chat: 'Just talking',
  } },
}, { privacy: 'may-leave', backends: [chatgpt] });
console.log(JSON.stringify(intent.answer), '| abstained:', intent.abstained);
await mock.close();
```

```sh
node decide-chatgpt.ts
```

```text
null | abstained: true
```

That abstention is correct on the mock: the stand-in echoes the prompt,
and an echo is not a decision, so the backend abstains rather than guess.
Live — same file through the step-4 switch — it answers with self-reported
confidence. Rules decide offline; the plan decides live.

## 4. Go live: the one-line switch (1 minute)

One line decides who you talk to — the `new Accounts(...)` line. Everything
else in `first-app.ts` is unchanged, except the two mock-only lines
(`mockOpenAI()` and `mock.approve(...)`) go away, because a real person
approves on the real page.

```diff
-const mock = await mockOpenAI(); // stand-in OpenAI on 127.0.0.1 — no account, no network
-const accounts = new Accounts({ authBase: mock.base, apiBase: mock.base }, portable);
+const accounts = new Accounts(); // the live plan, in your app's store (see below)
```

```diff
-mock.approve(shown!.code!); // on the live plan, YOU type the code on the provider page
+// type shown.code at shown.url on the ChatGPT page, then the app continues by itself
```

```diff
-await mock.close();
```

The live file, complete:

```ts
import { Accounts } from '@byokit/accounts';

const accounts = new Accounts(); // the live plan, in your app's store (see below)

const shown = await accounts.login(1, 'chatgpt', { via: 'code' });
console.log('Open this page:', shown?.url);
console.log('Type this code:', shown?.code);
// type the code on the ChatGPT page, then:
await accounts.finished(1, 'chatgpt');
console.log((await accounts.status(1, 'chatgpt')).words);

console.log(await accounts.respond(1, { instructions: 'Answer briefly.', input: 'Plan my day' }));
```

`new Accounts()` keeps this member's sign-in in memory. A real app names a
store per person instead — sealed file on a computer, Keychain/Keystore on a
phone, IndexedDB in a browser — and drops `via: 'code'` to use each
platform's default flow. Depth, not new concepts:
[`@byokit/accounts` README](../packages/accounts/README.md#on-a-computer)
(§ "On a computer" / "On a phone or in a browser").

## 5. The top 5 errors

| # | What you see | Cause | Fix |
|---|---|---|---|
| 1 | `Cannot find package '@byokit/accounts'` or `Cannot use import statement outside a module` | The terminal is not in the project folder, step 1 never ran, or the project is not a module (`npm init -y` defaults to CommonJS). | `cd first-app`, then `npm pkg set type=module` and `npm install @byokit/accounts @byokit/decide`; run `node` from there. |
| 2 | Sign-in sits at `waiting`, then expires | Nothing approved the code. Mock: `mock.approve(code)` was skipped or runs after `finished()` timed out. Live: the code was never typed at the shown page within 15 minutes. | Mock: keep the approve-before-finished order from step 2. Live: type the code promptly; expired means `login` again for a fresh code. |
| 3 | `respond` throws `…isn't signed in yet` (`signed_out`) | `respond` ran before `await finished()` resolved — or the member signed out. | `await finished()` first, then check `(await accounts.status(1, 'chatgpt')).words` says connected before asking. |
| 4 | Every `decide` answer abstains on the mock | The stand-in echoes the prompt, and an echo is not decision JSON, so the model backend abstains rather than guess. | Nothing is broken. Decide offline with `rules`; expect real answers only on the live plan. |
| 5 | Node refuses the `.ts` file (`ERR_UNKNOWN_FILE_EXTENSION` or similar) | Node older than 22.18 cannot run TypeScript directly. | `node --version`, then upgrade to Node 22.18 or newer and re-run. No build step is needed. |

## Go deeper (the specs, when you want them)

This guide is the 5-minute path; the package READMEs are the contract:

- Sign-in on every platform, stores, asking, limits, isolation:
  [`packages/accounts/README.md`](../packages/accounts/README.md) —
  start at [which sign-in works where](../packages/accounts/README.md#which-sign-in-works-where).
- Questions, floors, backends, evals, images:
  [`packages/decide/README.md`](../packages/decide/README.md).
- What "correct" means for asking (conformance fixtures):
  [`fixtures/README.md`](../fixtures/README.md).
- A full browser app on the plan (sign-in page, pairing, offline shell):
  [`examples/pwa`](../examples/pwa). Plan-backed decisions with a human handoff:
  [`examples/decide-plan`](../examples/decide-plan).
