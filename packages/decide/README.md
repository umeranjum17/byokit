<h1 align="center">@byokit/decide</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/decide"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/decide?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | browsers | React Native" src="https://img.shields.io/badge/platform-Node%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>Typed questions in, a typed answer with confidence out.</strong><br/>
Below a floor it abstains, so your app takes its safe default (ask the person) instead of guessing. Backends are your
own <code>rules</code>, any model you can send a prompt to (on a phone, the person's own ChatGPT), OpenAI general models with Structured Outputs, and
<a href="https://openrouter.ai/docs/guides/community/jev">Jev</a> (API-billed) over TypeSafe's API or OpenRouter. Labelled eval files
set the floors.</p>

## Install

```sh
npm install @byokit/decide
```

[![npm](https://img.shields.io/npm/v/@byokit/decide?style=flat&label=)](https://www.npmjs.com/package/@byokit/decide) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=decide-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/decide
```

A rules-only backend: nothing leaves the device and no key is needed. The obvious case gets an answer; the rest abstains.

```ts
import { decide, rules, type Question } from '@byokit/decide';

const questions: Record<string, Question> = {
  intent: { kind: 'choice', options: { task: 'Something new to do', followup: 'About an earlier job', chat: 'Just talking' } },
};
const backends = [rules((s) => (/^(thanks|thank you)\b/i.test(s.text) ? 'chat' : undefined))];

for (const text of ['thanks, that worked!', 'can you check if the plumber replied?']) {
  const { intent } = await decide({ text }, questions, { privacy: 'stays-here', backends });
  console.log(text, '->', intent);
}
```

```text
thanks, that worked! -> {
  answer: 'chat',
  confidence: 1,
  probabilities: { task: 0, followup: 0, chat: 1 },
  abstained: false,
  by: 'rules',
  ms: 0
}
can you check if the plumber replied? -> {
  answer: null,
  confidence: 0,
  abstained: true,
  reason: 'no answer',
  by: 'rules',
  ms: 0
}
```

Add a model after the rules for the cases they leave open. Jev is API-billed: it needs a TypeSafe or OpenRouter key
that your host holds.

```ts
import { decide, jev, rules } from '@byokit/decide';

const backends = [
  rules((s) => (/^(thanks|thank you)\b/i.test(s.text) ? 'chat' : undefined)), // the obvious cases, free
  jev({ key: hostConfig.jevKey }),            // or jev({ key: openRouterKey, via: 'openrouter' })
];
const { intent } = await decide({ text: 'can you check if the plumber replied?' }, {
  intent: { kind: 'choice', options: { task: 'Something new to do', followup: 'About an earlier job', chat: 'Just talking' } },
}, { privacy: 'may-leave', backends });

if (intent.abstained) askThePerson(); else route(intent.answer);
```

## API at a glance

| Export | What it does |
|---|---|
| `decide(state, questions, { privacy, backends, images?, timeoutMs?, cache? })` | Asks each backend in order for the questions still unanswered; returns an `Answer` per question |
| `rules(fn)` | Your own function as a backend: return the answer for an obvious case, `undefined` otherwise. Stays on the device |
| `answerer({ name, leaves, supportsImages?, ask, text?, maxRetries?, retryBaseMs?, retryMaxMs? })` | A host-owned model: `(prompt, signal, images, request) => text` or `{ text, usage?, rationale?, raw? }`; typed text options and bounded 429 retries |
| `jev({ key, via?, fetch?, maxRetries?, retryBaseMs?, retryMaxMs? })` | Jev as a backend, over TypeSafe's API (default) or OpenRouter (`via: 'openrouter'`). API-billed; retries 429s with backoff |
| `openai({ model, key, request?, ... })` / `openai({ model, auth: 'account', account, request?, ... })` | OpenAI general models used for decisions; explicit API key or consented ChatGPT plan session |
| `parseConfig(objectOrJSON)`, `createDecider(config, options)` | Validate portable config and set it once, with optional per-call overrides |
| `ConfigError`, `UnsupportedAccountError`, `UnsupportedImagesError`, `InvalidImageError`, `OPENAI_ROUTES` | Typed config/account errors and billing labels (API key is never offered by default) |
| `RateLimitError` | An answerer callback exhausted its 429 retries (`status: 429`, `retries`); `decide()` abstains on this failure |
| `MemoryCache`, `cacheKey(state, questions, images?)` | In-memory reference cache for `decide({ cache })`, and the stable request key it uses |
| `resolve(question, raw)` | The floors on one raw answer, for an app that holds a recorded answer |
| `FLOOR` | The default floor, 0.6 |
| `Question`, `QuestionOptions`, `Answer`, `RuleAnswer`, `Raw`, `Usage`, `ImageInput`, `DecisionImage`, `AnswererReply`, `AnswererOptions`, `AnswererRequestOptions`, `AnswererBackend`, `RetryOptions`, `Backend`, `DecideCache`, `Options` | The types |
| `@byokit/decide/eval`: `evaluate`, `evaluateDecisions`, `replay`, `parse`, `format`, `summary` | Run and print an eval report over any backends |
| `byokit-eval` (bin) | Replay or refresh an eval file from the command line |

## Questions and floors

- **Questions**: `choice` (options with a one-line description each), `yesno`, `score` (an ordered rubric, lowest
  first; the answer is the level's index), and `rank` (candidate ids with descriptions, best first).
- **The floors are code, not a prompt** (ported from firstmate's dispatch resolver): a 0.6 floor on the answer's
  confidence by default (`floor` per question). A choice option can declare its own floor (`floors`), checked against
  its own probability; a pick under it falls to the most probable other option that clears its own. A tie abstains.
- An answer whose probabilities are missing an option, out of range or don't sum to 1 is an abstain, never an error.

### Ranking and explanations

```ts
import { decide, rules } from '@byokit/decide';

const { replies } = await decide({ name: 'Umer' }, {
  replies: {
    kind: 'rank',
    candidates: { question: 'Ask a useful question', context: 'Add context', repeat: 'Repeat the post' },
    instructions: 'Order by how much the reply adds to the conversation.',
    personReason: true,
  },
}, { privacy: 'stays-here', backends: [rules(() => ({
  answer: ['context', 'question', 'repeat'],
  scores: { context: 3, question: 2, repeat: 0 },
  personReason: 'The first reply adds useful context.',
}))] });
// replies.answer: ['context', 'question', 'repeat']
// replies.scores: { context: 3, question: 2, repeat: 0 }
// replies.personReason: 'The first reply adds useful context.'
```

`rank.candidates` is a non-empty map of app-owned ids to descriptions. `Answer.answer` is the complete ordered
`string[]`, or `null` on abstention. Every id must appear exactly once; missing, duplicate or unknown ids abstain.
The backend must report confidence in the order, between 0 and 1; the usual `floor` (default 0.6) applies.
Optional `Answer.scores` maps candidate ids to finite numbers on the backend's own scale. Scores need not sum to 1,
may be negative, and are never invented from list positions. Explicit orders may include equal scores.

| Backend | Rank behavior | Person-facing explanation |
|---|---|---|
| `rules` | Return a `string[]`, or `{ answer: string[], scores?, personReason? }`; confidence is 1 | Return `{ answer, personReason }` for any question kind |
| `openai` | Structured output with ranking, self-reported confidence, and scores or null | Requested in the schema only for opted-in questions |
| `answerer` | JSON `{ ranking: string[], confidence: number, scores?: {...}, personReason?: string }` per rank question | Opted-in non-rank questions use `{ probabilities: {...}, personReason?: string }`; legacy probability maps still work |
| `jev` | Fallback: send a Choice, order its probabilities descending, retain them as scores and use provider confidence; ties keep candidate declaration order | Not supported by the documented API; field remains absent |
| Node subscription adapter | Structured schema with ranking, self-reported confidence and optional scores | Requested in the schema only for opted-in questions |

Jev's fallback measures relative Choice preference, not confidence in every pair's order. Its
[API reference](https://docs.typesafe.ai/api) documents Choice, Score and Noul, so no unsupported rank primitive or
explanation field is sent. A custom backend without ranking can return `undefined` for that question; `decide`
tries the next backend. If none answers, it abstains. The app can keep its original order or ask a person.

For custom `Backend.ask`, a rank `Raw` has `{ probabilities: {}, ranking, confidence, scores?, personReason? }`.
`resolve` validates it and carries `usage`/`raw` as usual. Recorded Jev Choice responses can replay as ranks;
`evaluate` compares rank arrays in exact order. Other question kinds keep their existing eval semantics.

`personReason: true` opts a question into a short explanation. It is absent by default, so existing calls request
no extra explanation tokens. `Answer.reason` remains a diagnostic for logs. `Answer.personReason` is trimmed,
limited to 160 characters, and rejected if blank, multiline, contains control characters or HTML/backtick markup.
Malformed explanations do not discard a valid answer. Abstentions and choice runner-up changes omit them.
Render explanations as plain text; generated wording still needs the host's content policy. Backends never turn
errors or diagnostic reasons into person-facing text. A backend unable to explain may still answer without one.
The separate model-supplied `rationale` remains diagnostic metadata, including on abstentions; it is not a
person-facing explanation and is preserved for existing image and structured-answer callers.

### Per-question state and privacy

```ts
import { answerer, decide, rules, type Question } from '@byokit/decide';

const sharedPublicState = { name: 'Umer' };
const publicPost = 'What helped you learn a new skill?';
const publicReplies = ['Practice a little each day.', 'What did you try first?'];
const publicCandidates = { context: publicReplies[0], question: publicReplies[1] };
const localRules = rules((_state, name) => name === 'allowed' ? true : undefined);
// Stand-in response for this example. Replace ask with the app's model call.
const modelBackend = answerer({ name: 'example', leaves: true,
  ask: async () => '{"replies":{"ranking":["context","question"],"confidence":0.8}}',
});
const questions: Record<string, Question> = {
  allowed: { kind: 'yesno', question: 'Allowed by the local rules?',
    state: { privateText: 'Local draft from Umer' }, privacy: 'stays-here', backends: ['rules'] },
  replies: { kind: 'rank', candidates: publicCandidates,
    state: { publicPost, publicReplies } },
};
const answers = await decide(sharedPublicState, questions, {
  privacy: 'may-leave', backends: [localRules, modelBackend],
});
```

`question.state` **replaces** the shared state; it is never merged. An explicitly supplied `null` or `undefined`
also replaces it. `decide` sends each scoped question in its own backend invocation, with only its effective
state and that question; the `state` property is removed from the question passed to `Backend.ask`. Unscoped
questions keep the existing shared-state batch. The timeout budget applies to the whole backend pass, including
all its scoped requests; successful requests survive a later scoped failure or timeout. Scoping can add requests
and API key (billed per use) calls, so pass a small public state when possible.
Image attachments remain shared across the call, as in the image API: `question.images` references criteria,
and `question.state` does not filter attachments. Keep rules-only images out of a model-bound call.

`question.privacy: 'stays-here'` excludes that question from every backend with `leaves: true`, even if local rules
abstain. Question privacy can narrow the whole call's privacy, never widen it. Scope private question descriptions
and candidate text too. `question.backends` optionally allows only the listed `Backend.name` values; `['rules']`
reserves a question for rules even when a model stays on-device. An empty list permits no backend. The host owns
backend names and must give them distinct, accurate names. The allowlist never overrides call or question privacy.
Everything in a model-bound question can leave. A `state` override alone does not make a
question local. This dispatch guarantee belongs to `decide`; direct `Backend.ask` calls take the state supplied
by the host. Cache keys include the question overrides, privacy, backend allowlist and explanation opt-in; cache implementations
must be trusted with answers and any backend raw responses they store.

## Backends

- Backends are tried in order for the questions still unanswered. A backend that fails or takes longer than
  `timeoutMs` (default 5 s) answers nothing.
- `privacy: 'stays-here'` skips every backend the state would leave the device for (Jev, or any answerer with
  `leaves: true`), so private text never goes to one.
- **Any model**: `answerer({ name, leaves, ask })` makes a backend of any `(prompt, signal, images, request) => text`. Existing
  callbacks still work; the third argument remains the image attachments. Structured replies preserve host-supplied
  usage, rationale and raw metadata; plain string replies expose only the recognized answers. On a phone, that
  is the ChatGPT the person signed in to with [`@byokit/accounts`](../accounts), on their own plan:

  ```ts
  import type { Accounts, AuthHost } from '@byokit/accounts';
  import { answerer } from '@byokit/decide';

  // Pass the app's existing Accounts instance and signed-in member (for example, 'Umer').
  function chatgptBackend(accounts: Accounts<AuthHost, string>, me: string) {
    return answerer({
      name: 'chatgpt',
      leaves: true,
      text: { format: { type: 'json_object' } }, // or a json_schema matching the question/probability map
      ask: (p, signal, _images, request) => accounts.respond(me, { ...request, input: p, signal }),
    });
  }
  ```

  It treats state as data in a delimited JSON block and asks for each answer's probability as JSON; any other reply
  is an abstain. Every answer it produces, including abstentions and failures, carries
  `confidenceSource: 'self-reported'`: these estimates are not calibrated provider confidence.
  The callback's fourth argument carries trusted `instructions` and unchanged `text`; forward both to
  `accounts.respond` as above so the state guard also reaches the provider's instruction field.
  HTTP errors with `status: 429` retry twice by default, using `retryAfter` or `headers.get('retry-after')` when
  supplied. Current `accounts.respond` errors expose that metadata. Other errors never retry. Waits use the same
  exponential backoff as Jev/OpenAI (`retryBaseMs: 1000`, `retryMaxMs: 2000`), capped per wait, and stop on abort.
  Calling the backend's `ask` directly throws `RateLimitError` on exhaustion; `decide` abstains and may try the next
  backend. Callback messages and provider bodies are omitted from failure reasons. Each retry uses the same billing
  route as its first call (subscription or API key, billed per use).
  - **Billing**: `rules` costs nothing. `answerer` with the person's ChatGPT uses their subscription. `jev()` is billed
  to the TypeSafe or OpenRouter key you pass.

## OpenAI models used for decisions

As of 2026-09-30, no dedicated OpenAI decision model appears in the official
[model catalogue](https://developers.openai.com/api/docs/models) or
[API changelog](https://developers.openai.com/api/docs/changelog). This backend uses a general model with
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), rather than claiming
native decision confidence or abstention. `model` is required; there is no hidden OpenAI default.
`gpt-6.1-sol`, released September 29, is the current example. Its standard short-context pricing per million tokens
is $2 input, $0.10 cached input, $2.50 cache write and $10 output; check [pricing](https://developers.openai.com/api/docs/pricing)
for longer contexts, other models and processing tiers.

```ts
import { decide, openai } from '@byokit/decide';

const backend = openai({
  model: 'gpt-6.1-sol', key: hostConfig.openaiKey, // API key (billed per use), explicit opt-in
  request: { reasoning: { effort: 'low' }, max_output_tokens: 1024, text: { verbosity: 'low' } },
});
const answers = await decide(state, questions, { privacy: 'may-leave', backends: [backend] });
```

`request` uses the exactly pinned official OpenAI SDK's full Responses request types. Options pass through except
`model`, `input` and `text.format`, which this backend generates. `request.instructions` adds host instructions;
`request.text` keeps other text options. The SDK is used only for types, never imported at runtime.
The backend POSTs to `https://api.openai.com/v1/responses` with a JSON schema for every question's answer keys,
probabilities and pick. It parses `output_text` content from message items, including when reasoning items come first.

The probabilities are **self-reported estimates**, not native calibrated provider confidence. Every OpenAI answer
labels them `confidenceSource: 'self-reported'`. No provider confidence is invented: `resolve` derives confidence
from the picked probability and applies the same floors, option floors, runner-up and tie rules as Jev.
Refusal, incomplete output, missing questions and malformed JSON/probabilities abstain; answered and abstained
answers carry the full response and its reported token counts. Streaming requires a completed terminal response;
text deltas alone cannot answer a question. Fixtures in `test/fixtures/openai-responses.json` are hand-authored saved
API-shape responses from the official documentation, not live model recordings. Tests never call a real model.

### The person's ChatGPT plan

For an app already using Accounts, bind the same person's Codex/ChatGPT subscription login directly:

```ts
import { Accounts, memoryStore } from '@byokit/accounts';
import { openai } from '@byokit/decide';

const accounts = new Accounts({ store: () => memoryStore() }); // use protected storage in your app
// Show the sign-in returned by accounts.login('Umer', 'chatgpt'), then await accounts.finished(...).
const account = accounts.chatgpt('Umer');
const backend = openai({ auth: 'account', account, model: 'gpt-6-sol' });
```

This handle routes through `Accounts.respond`, including its refresh, limit and sign-out handling.
Tokens stay in the app's own store; the handle exposes none. No separate token-sharing session or
API key (billed per use) is needed. ChatGPT subscription sign-in is offered by default. Use this
handle where the sign-in lives, including React Native; Accounts owns its fetch transport.
Supported `request` fields are `instructions`, `text`, `reasoning`, `tools`, `tool_choice`,
`parallel_tool_calls`, `store: false` and `stream: true`; other fields throw `UnsupportedAccountError`.
Answers retain reported token usage and self-reported confidence. Missing usage stays absent.

Apps with an official token-sharing integration can continue using the separate adapter below.

[Official token sharing](https://developers.openai.com/siwc/token-sharing-open-source) permits eligible open-source
and locally hosted apps to request ChatGPT plan usage with the person's explicit consent. Paid/remote apps need
OpenAI's approval; signing in for identity alone is insufficient. The host completes the
[official sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), including ID-token
signature/issuer/audience/nonce checks, and owns protected storage and refresh per person. Then bind that session
through `@byokit/accounts`:

```ts
import { chatgptPlan } from '@byokit/accounts/chatgpt-plan';
import { openai } from '@byokit/decide';

const account = chatgptPlan({
  // Host's official token-sharing integration, scoped to this person; refresh before returning.
  session: async (signal) => {
    const saved = await hostSignIn.validatedSessionFor(me, signal);
    return { accessToken: saved.access_token, scopes: saved.scopes };
  },
});
const backend = openai({ auth: 'account', account, model: chosenModel });
```

The token-sharing adapter consumes a validated session; it does not start a sign-in. The
`accounts.chatgpt(member)` handle uses the existing Codex login through `Accounts.respond()` instead;
it does not convert that credential into a token-sharing session.
`chatgptPlan` checks `resource.invoke` and `chatgpt.tokens.use.direct` on every request; the host supplies refreshed tokens.
The backend verifies `chosenModel` against the selected account's current catalogue, uses the public Responses API,
and sets `store: false`, `stream: true` and array input. It never sends tokens to ChatGPT backend-api endpoints.
[Plan usage request restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
reject unsupported fields (including `max_output_tokens`, `temperature` and `metadata`); options valid for API keys
may be unsupported for accounts.

`UnsupportedAccountError` (`code: 'unsupported_account'`) is thrown for missing consent, missing account sessions,
unavailable chosen models or unsupported account requests, including from `decide`. There is no API-key fallback.
Ordinary transport/429 failures follow decide's existing failed-backend abstention behavior.
`OPENAI_ROUTES.apiKey` labels billing `'api'` with `offer: false`; the account route labels `'subscription'` with consent required.

## Set configuration once

```ts
import { createDecider, parseConfig, MemoryCache } from '@byokit/decide';

// The host can build this from its own environment or file; the kit reads neither.
const config = parseConfig({ backend: 'openai', auth: 'apiKey', model: 'gpt-6.1-sol',
  request: { reasoning: { effort: 'low' } }, maxRetries: 2 });
const decideForApp = createDecider(config, {
  privacy: 'may-leave', cache: new MemoryCache(),
  host: { keys: { jev: hostConfig.jevKey, openai: hostConfig.openaiKey }, account,
    cacheScope: `${me}:${hostConfig.selectedAccountId}` }, // required for account caches
});
const answers = await decideForApp(state, questions);
const viaJev = await decideForApp(state, questions, { backend: 'jev', auth: 'apiKey' });
const viaPlan = await decideForApp(state, questions, { auth: 'account' });
```

Or call `decide(state, questions, { config, host, privacy, images?, timeoutMs?, cache? })` directly.
`parseConfig` accepts a plain object or JSON string and defaults to `{ backend: 'jev', auth: 'apiKey' }`, preserving
Jev's `jev-latest` model and TypeSafe route. OpenAI requires an explicit `model`. Fields are `backend`, `auth`, `model`,
`via` (Jev only), `request` and `supportsImages` (OpenAI only), `maxRetries`, `retryBaseMs`, `retryMaxMs`. Unknown fields, invalid JSON,
wrong types and invalid retry values throw `ConfigError` (`code: 'invalid_config'`); Jev account auth throws
`UnsupportedAccountError`. API-key credentials must be explicitly supplied by the host. A backend switch clears
provider-specific model/route/request settings; an OpenAI switch must specify its model.

Configured cache keys include backend, auth, model, request options and host credential/namespace in the hash,
so switching provider, billing route, model or person cannot return another configuration's answer. When using the
original `backends` API, dedicate each cache to the intended backend/model/person; its original request-only key
semantics remain. Cache hits preserve usage, raw response and self-reported confidence labels.

## Usage, cache and retries

Every `Answer` carries what its backend reported: `usage` (`input_tokens`/`output_tokens` when sent) and the raw
backend response (`raw`), on answered and abstained answers alike, so cost accounting never loses a count. `source`
tells whether the answer was decided live (`'api'`) or served from cache (`'cache'`).

```ts
import { decide, jev, MemoryCache } from '@byokit/decide';

const cache = new MemoryCache(); // reference implementation; bring your own get/set (sync or async) to persist
const backend = jev({ key: hostConfig.jevKey, maxRetries: 2, retryMaxMs: 2000 });

const first = await decide({ text }, questions, { privacy: 'may-leave', backends: [backend], cache });
console.log(first.intent.source, first.intent.usage); // 'api' { input_tokens: 42, output_tokens: 7 }
const second = await decide({ text }, questions, { privacy: 'may-leave', backends: [backend], cache });
console.log(second.intent.source); // 'cache': same usage/raw, no backend call
```

- **Cache**: the key is the sha256 of the canonical `{ state, questions }` body (`cacheKey(state, questions)`), stable
  across key order. The library ships no on-disk cache; a `get`/`set` pair over your own store is enough.
- **Retries**: only 429s retry, never other statuses. A 429 waits for `Retry-After` when present (seconds or HTTP
  date), else an exponential backoff from `retryBaseMs`; each wait is capped at `retryMaxMs`, so the total stays
  under `maxRetries` x `retryMaxMs`. Backoff respects the caller's `timeoutMs`/`AbortSignal`, including an abort
  mid-wait, and each retry uses the same billing route as the first call (API key or subscription).

## Phones and browsers

The main entry is plain TypeScript with `fetch` (the eval CLI is its own entry), so it bundles for React Native and the
web; `test/react-native.test.ts` runs it where there is no Node.

## Keys

`jev()` and API-key `openai()` take the key your host read from its own environment or config. The kit never reads an environment variable,
and the key goes only into the one request header. Never ship a key inside an app: keep it on the home computer and let
paired devices ask it.

## Evals

Each decision gets a labelled file, `evals/<decision>.jsonl`: a header `{ decision, question, note }`, then one case per
line, `{ state, expect, jev, ms }`. `expect` is the right answer, a list of right answers, or `null` when only an abstain
is right; `jev` is a Jev-shaped answer, replayed offline so CI never calls a model. The included example,
`evals/example-urgent.jsonl`, shows the format; it is hand-made, not a live recording.

```sh
npx --package=@byokit/decide byokit-eval evals/intent.jsonl                    # replay stored answers
npx --package=@byokit/decide byokit-eval evals/intent.jsonl --floor 0.7        # try another floor
TYPESAFE_API_KEY=… npx --package=@byokit/decide byokit-eval evals/intent.jsonl --live typesafe --record
```

Replaying the included example from this repo, at the default floor and then at 0.95:

```text
$ npx byokit-eval packages/decide/evals/example-urgent.jsonl
packages/decide/evals/example-urgent.jsonl: urgent (jev, recorded): 5 cases
  agree 4/5   clear-but-wrong 0 (0%)   abstained 1 (20%)   ms min/median/max 165/180/201
$ npx byokit-eval packages/decide/evals/example-urgent.jsonl --floor 0.95
packages/decide/evals/example-urgent.jsonl: urgent (jev, recorded): 5 cases
  agree 2/5   clear-but-wrong 0 (0%)   abstained 3 (60%)   ms min/median/max 165/180/201
```

- Agreement counts right answers and correctly expected abstentions; abstentions are also reported separately.
- Clear-but-wrong (answered, and wrong) is the number that must stay near 0; the command exits 1 when its rate is above
  `--max-clear-wrong` (default 0).
- Set floors from the eval, not by guessing.
- Only `--live` reads a key (`TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` with `--live openrouter`), and each live call
  is API-billed. `--record` keeps previous answers when a live refresh fails and marks a partially refreshed file as
  such.

`evaluate()` in `@byokit/decide/eval` runs the same report over any backends, including your rules. Run
from a byokit checkout, it replays the included example:

```ts
import { readFileSync } from 'node:fs';
import { decide, rules } from '@byokit/decide';
import { evaluate, parse, summary } from '@byokit/decide/eval';

const f = parse(readFileSync('packages/decide/evals/example-urgent.jsonl', 'utf8'));
const backends = [rules((s: string) => (/\b(now|today|before \d)/i.test(s) ? true : undefined))];
const report = await evaluate(f.cases, async (c) => (await decide(c.state, { urgent: f.question }, { privacy: 'stays-here', backends })).urgent);
console.log(summary(f.decision, 'rules', report));
```

```text
urgent (rules): 5 cases
  agree 2/5   clear-but-wrong 0 (0%)   abstained 3 (60%)   ms min/median/max 0/0/1
```

## Images and explanations

Pass `images` alongside the state. Each image has a unique `id`, an image `mime`, and either non-empty
`Uint8Array` `bytes` or a base64 `dataUrl` whose MIME matches. The kit accepts inline data only; the host owns
file reading, screenshots, resizing and any image-size policy. A question's optional `images` list names the
images its criteria refer to; instructions and rubric levels can refer to the same IDs. All supplied images are
attached in order, including reference images.

```ts
import { answerer, decide, type DecisionImage, type Usage } from '@byokit/decide';

// Supplied by the app's subscription lane and screenshot storage.
declare const hostModel: { capabilities: { images: boolean } };
declare const memberLane: { respond(request: { prompt: string; signal: AbortSignal; images: readonly DecisionImage[] }):
  Promise<{ text: string; usage?: Usage }> };
declare const candidatePng: Uint8Array;
declare const referenceDataUrl: string;

const backend = answerer({
  name: 'member-model', leaves: true,
  supportsImages: hostModel.capabilities.images, // capability of the model the app selected
  ask: async (prompt, signal, images) => {
    // Host's kit-backed subscription lane. It owns sign-in and provider image mapping.
    const result = await memberLane.respond({ prompt, signal, images });
    return { text: result.text, usage: result.usage };
  },
});
const { craft } = await decide({ rubric: 'Compare the candidate with the reference.' }, {
  craft: { kind: 'score', levels: ['Needs work', 'Meets the reference'],
    instructions: 'Judge candidate against reference.', images: ['candidate', 'reference'] },
}, {
  privacy: 'may-leave', backends: [backend],
  images: [
    { id: 'candidate', mime: 'image/png', bytes: candidatePng },
    { id: 'reference', mime: 'image/png', dataUrl: referenceDataUrl },
  ],
});
// craft.rationale explains the model's judgment; craft.reason explains a resolver abstention.
// craft.usage carries the model call's reported input_tokens/output_tokens, even if it abstains.
```

The third `ask` argument contains normalized `{ id, mime, dataUrl }` images; prompt text describes their IDs and
order without embedding the bytes. The requested JSON is
`{ "craft": { "probabilities": { "0": 0.2, "1": 0.8 }, "rationale": "Matches the reference." } }`.
Old replies shaped `{ "craft": { "0": 0.2, "1": 0.8 } }` still work. A structured `AnswererReply` can also supply
one call-wide `rationale` as a fallback and `raw` as the safe response body. Missing usage or rationale stays
absent; the kit invents neither. Usage is **per model call**, repeated on each question answered by that call:
count it once, not by summing every question. Cache hits preserve it and the rationale; use `source` to exclude
cached answers from live billing totals. Malformed or missing answers still keep reported usage.

`supportsImages: true` is required on `answerer`, custom model backends and `openai` when the selected model
supports images. The app supplies that capability from its model selection, rather than the kit guessing from
model names. Jev is text only. Kit model backends without image support throw `UnsupportedImagesError`
(`code: 'unsupported_images'`) before sending a request, including when called directly; there is no automatic
provider or billing fallback. `InvalidImageError` (`code: 'invalid_image'`) rejects invalid image data, duplicate IDs
and missing question references. Privacy filtering happens before capability refusal, so `stays-here` never
sends images to a remote backend. Local `rules` can inspect normalized images in their fourth callback argument.

For OpenAI, use `openai({ auth: 'account', account, model: chosenModel, supportsImages: true })` for a consented
subscription, or explicitly supply `key` for API key (billed per use). Image parts use the Responses format on both
routes. `createDecider` accepts images in its third call argument, e.g. `run(state, questions, { images })`.
Cache keys include image bytes, MIME, IDs and order, in addition to the existing model/account configuration.
No sign-in, billing route or stored token behavior changes.

Image evals use the same question and attachment IDs. Each JSONL case may contain `images` and a generic
`recorded` raw answer (`probabilities`, optional `pick`, `usage`, `rationale`), alongside the existing `jev` recordings.
`format` serializes bytes as data URLs; `parse` validates images and the question's references in every case.
`recorded` takes precedence over `jev` in offline replay. This header and case illustrate named image criteria:

```jsonl
{"decision":"craft","question":{"kind":"score","levels":["Candidate falls below reference","Candidate matches reference"],"images":["candidate","reference"]},"note":"Hand-authored example, not a live recording"}
{"state":{"rubric":"Compare composition"},"images":[{"id":"candidate","mime":"image/png","dataUrl":"data:image/png;base64,AQ=="},{"id":"reference","mime":"image/png","dataUrl":"data:image/png;base64,Ag=="}],"expect":1,"recorded":{"probabilities":{"0":0.1,"1":0.9},"rationale":"Matches the reference.","usage":{"input_tokens":12,"output_tokens":5}}}
```

The one-byte payloads above illustrate the schema only; supply actual encoded images for model runs.
`evaluateDecisions(file, { privacy, backends })` forwards each case's images through `decide` automatically,
including subscription-backed answerers; `evaluate(cases, replay(question))` and the CLI replay them offline.
`byokit-eval --live` remains an explicit API-billed Jev path and refuses image cases with `UnsupportedImagesError`.
App-specific rubrics, reference corpora and acceptance thresholds stay in the host.

## Links

- [byokit](../../README.md): the other packages
- [`examples/decide-plan`](../../examples/decide-plan): ChatGPT and Claude plan decisions, visible confidence floors and human handoff
- [`examples/expo`](../../examples/expo): uses `@byokit/decide` in a React Native app
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](https://github.com/umeranjum17/byokit/blob/main/NOTICE).

## Structured generation

`generate<T>({ state, images? }, schema, { backends, cache, budget })` returns a complete, locally validated
`data` value or `data: null` with a fixed `failure` code/message. It keeps `text`, reported `usage`,
`raw`, `by`, `ms` and `source: 'api' | 'cache'`. The generic type is the app's declaration;
validation uses the supplied schema. The runner tries backends in order and stores only successes.
An `IncompleteError` is a failure, even if it contains a usable-looking partial object.

Images use the shared `ImageInput` type: unique IDs plus PNG/JPEG bytes or matching MIME/base64
data URLs. `image/jpg` is normalized to `image/jpeg`; other formats are refused with
`InvalidImageError` and must be converted by the host. The kit never fetches URLs or reads image
files. Generation backends must declare `supportsImages: true`; a text-only backend is refused
with `UnsupportedImagesError`. Image bytes and data URLs for the same payload share a cache key.

The bounded JSON Schema subset supports objects, required fields, additional properties, arrays,
length/item/property counts, unique items, enums/const, numeric bounds, types and boolean/composition
schemas. Unknown constraints, including `$ref`, `pattern` and `format`, fail before a backend runs.
Schemas are snapshotted before awaiting a backend. The same validator runs in the CLI adapter.

The budget defaults to 120 seconds for the backend sequence and 16,384 output tokens. Set
`budget.maxOutputTokens: 8192` for an 8k answer. Hosts implementing `GenerationBackend` must honour
`maxOutputTokens` and reject incomplete answers; the runner enforces the time limit and validates
complete values again. `signal` cancels generation. `privacy: 'stays-here'` skips hosted backends.
There is no default disk cache. `MemoryGenerationCache` is the portable reference; cache keys cover
state, canonical image bytes/MIME/IDs, schema, backend, model, host-supplied account/config identity and output budget. Pin a model
when keeping a durable cache; the CLI's default model selection can change independently.

```ts
import { generate, MemoryGenerationCache, type ImageInput } from '@byokit/decide';
import { claudeCode } from '@byokit/decide/claude-code';

declare const hostConfig: { model: string };
declare const images: readonly ImageInput[]; // PNG/JPEG bytes or matching data URLs supplied by the host
const backend = claudeCode({
  bin: '/absolute/path/to/claude',
  configDir: '/absolute/path/to/app-sign-in',
  model: hostConfig.model,
  timeoutMs: 120_000,
});
const schema = {
  type: 'object', required: ['name', 'scenes'], additionalProperties: false,
  properties: {
    name: { type: 'string' },
    scenes: { type: 'array', items: {
      type: 'object', required: ['duration'], additionalProperties: false,
      properties: { duration: { type: 'number', minimum: 1, maximum: 120 } },
    } },
  },
} as const;
const result = await generate<{ name: string; scenes: { duration: number }[] }>(
  { state: { name: 'Umer', brief: 'A six-second introduction.' }, images }, schema,
  { backends: [backend], cache: new MemoryGenerationCache(), budget: { maxOutputTokens: 8192 } },
);
if (result.data === null) console.log(result.failure?.message);
else console.log(result.data);
```

## Subscription CLI on Node / Electron

The `@byokit/decide/claude-code` subpath is Node-only. The main entry, including `generate`, stays
portable on browsers and React Native. The host supplies the absolute path of the user's own
**unmodified** Claude binary (v2.1.286 or later) and an existing, separate absolute sign-in directory.
The adapter's `billing` is always `'subscription'`; it has no API-key input or fallback. Before
generation, it asks the binary for `auth status` and requires a signed-in first-party `claude.ai`
account. Unknown or API authentication is refused before any model request; status metadata is discarded.

Sign in **yourself**, through the binary's own flow, using the same isolated directory:

```sh
mkdir -p /absolute/path/to/app-sign-in
CLAUDE_CONFIG_DIR=/absolute/path/to/app-sign-in /absolute/path/to/claude auth login
```

Choose your subscription account. Do not copy credentials from an existing installation, sign in
with a Console API key, or point `configDir` at your ordinary `.claude` folder. The kit neither runs
login nor reads, copies or intermediates credentials. Its separate config directory belongs to the
binary and is retained between calls. Its temporary home and working directory are removed after
each call, including cancellation and timeouts. The child's environment is built from a fixed
minimal set: no ambient keys, OAuth tokens, proxy settings or Node preload scripts.

[Claude Code's authentication and credential-use terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
explicitly permit an end user to sign in to the unmodified binary using their own subscription;
sign-in must use Anthropic's own flow, and developers may not collect or intermediate those credentials.
Each user supplies their own installation and account. This adapter adds a route to decide and does
not change accounts' existing sign-in behavior.

Direct API:

```ts
import { claudeCode } from '@byokit/decide/claude-code';
import type { ImageInput } from '@byokit/decide';

declare const images: readonly ImageInput[];
const backend = claudeCode({ bin: '/absolute/path/to/claude',
  configDir: '/absolute/path/to/app-sign-in', timeoutMs: 120_000 });
const controller = new AbortController();
const schema = { type: 'object', required: ['title'],
  properties: { title: { type: 'string' } }, additionalProperties: false } as const;
const { data, text, usage, raw } = await backend.generate({
  system: 'Make a complete storyboard.', prompt: 'Introduce Umer in six seconds.',
  images, schema, signal: controller.signal,
});
```

The adapter runs headless JSON-schema output over stream-JSON input, with built-in tools and MCP
unavailable, customization/hook loading disabled, and no saved session. Invalid JSON or schema
mismatches reject with `ClaudeCodeError`; cut-off output has `name: 'IncompleteError'` and
`code: 'incomplete'`. Failures use fixed text and never include stderr. It is also a `Backend` for
`decide(..., { privacy: 'may-leave', backends: [backend] })` choice, yes/no and score questions;
its confidence estimates are self-reported and still go through decide's ordinary floors.

## Jev from a paired phone

`pairedJev()` sends questions through an existing `@byokit/pair` DeviceLink to the user's
computer. The computer holds the API key (billed per use) and calls Jev; the phone receives
only probabilities and token usage. Pairing does not enable paid decisions. The host app
must ask for billing consent before constructing `jevHost()` with the explicit billing label.

On the computer, compose the handler into the app's existing link host. This example uses
an app-owned, passphrase-sealed `@byokit/secrets` store. The passphrase and key are supplied
through the host app, never a phone bundle or ambient credential lookup.

```ts
import { Host, keyPair, type HostOptions } from '@byokit/pair';
import { fileStore } from '@byokit/secrets';
import { jevHost, PAIRED_JEV_OP } from '@byokit/decide';

async function enablePaidDecisions(passphrase: Uint8Array, consent: boolean, confirm: HostOptions['confirm']) {
  if (!consent) return; // Ask the person: API key (billed per use).
  const secrets = fileStore({ path: '/home/app/data/decision-keys.json', passphrase });
  // Save the key through the host app with secrets.set('jev-typesafe', key).
  const paid = jevHost({
    billing: 'api-key-billed-per-use', via: 'typesafe',
    keys: { get: (_device, via) => secrets.get(`jev-${via}`) },
  });
  return Host.open({
    keys: keyPair(), name: 'Umer computer', confirm,
    // This host offers only paid decisions, to paired control devices.
    allow: (request, device) => device.role === 'control' && request.op === PAIRED_JEV_OP,
    handle: paid,
  }); // Use the app's existing grant store, pairing approval UI and socket wiring in production.
}
```

On the phone, pass the existing paired link (or `null` before pairing):

```ts
import type { DeviceLink } from '@byokit/pair';
import { decide, pairedJev, PairedHostError } from '@byokit/decide';

async function askFromPhone(link: DeviceLink | null) {
  try {
    return await decide({ name: 'Umer', text: 'The roof is leaking' }, {
      urgent: { kind: 'yesno', question: 'Is this urgent?' },
    }, { privacy: 'may-leave', timeoutMs: 30_000, backends: [pairedJev({ link, timeoutMs: 25_000 })] });
  } catch (error) {
    if (error instanceof PairedHostError) return { problem: error.code, words: error.message };
    throw error;
  }
}
```

- `PairedHostError.code` is `host-offline`, `not-paired`, `key-missing`, `disabled`,
  `not-allowed`, `invalid-request`, `request-failed` or `cancelled`. These errors propagate
  through `decide()` so the app can offer reconnection, pairing or host key setup. Error words
  contain no provider or storage details. A missing key never falls back to another billing route.
- `JevHostKeys.get(device, via)` receives the authenticated grant. Adapt an accounts member
  key route here when available, or scope a sealed secrets store to the member the host maps
  from that grant. Never accept a member id, key, model, URL or billing route from request data.
- Link pairing authentication, revocation and `Host.allow` apply before the handler runs.
  Compose `PAIRED_JEV_OP` into an existing host's dispatcher and policy rather than replacing
  its other operations. `enabled(device)` can withdraw host billing consent dynamically.
- The host bounds provider work to 20 seconds by default and accepts at most 100 questions
  with 100 options/levels each. The phone request deadline defaults to 30 seconds and refuses
  to enqueue while offline. Set its request timeout below `decide().timeoutMs` to receive
  typed transport timeouts; the general decide deadline otherwise abstains as usual.
  `privacy: 'stays-here'` skips the paired backend entirely.
- Paired Jev supports choice, yes/no and score questions only; rank questions return
  `invalid-request` before billing. It is text only: image attachments throw `UnsupportedImagesError`
  before any request or billing. Host replies omit person-facing explanations.
- Floors, runner-up selection and abstention remain on the phone. Usage is preserved; arbitrary
  provider JSON (`raw`) is intentionally omitted. Keep caches scoped to a person and paired host;
  cached decisions do not check current host consent or connectivity.
- Cancellation stops waiting on the phone; it cannot undo work or billing already started on the
  host. Link resends a pending request across reconnects with its original deduplication key.
  A fresh application retry is a new billable call. Durable deduplication uses the existing
  link `AnswerStore`; a host crash before saving an answer can still cause a repeat call.
- A hosted proxy is a follow-up, outside this paired-host route.
