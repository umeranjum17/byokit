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
| `answerer({ name, leaves, supportsImages?, ask })` | A host-owned model: `(prompt, signal, images) => text` or `{ text, usage?, rationale?, raw? }` |
| `jev({ key, via?, fetch?, maxRetries?, retryBaseMs?, retryMaxMs? })` | Jev as a backend, over TypeSafe's API (default) or OpenRouter (`via: 'openrouter'`). API-billed; retries 429s with backoff |
| `openai({ model, key, request?, ... })` / `openai({ model, auth: 'account', account, request?, ... })` | OpenAI general models used for decisions; explicit API key or consented ChatGPT plan session |
| `parseConfig(objectOrJSON)`, `createDecider(config, options)` | Validate portable config and set it once, with optional per-call overrides |
| `ConfigError`, `UnsupportedAccountError`, `UnsupportedImagesError`, `InvalidImageError`, `OPENAI_ROUTES` | Typed config/account errors and billing labels (API key is never offered by default) |
| `MemoryCache`, `cacheKey(state, questions, images?)` | In-memory reference cache for `decide({ cache })`, and the stable request key it uses |
| `resolve(question, raw)` | The floors on one raw answer, for an app that holds a recorded answer |
| `FLOOR` | The default floor, 0.6 |
| `Question`, `Answer`, `Raw`, `Usage`, `ImageInput`, `DecisionImage`, `AnswererReply`, `AnswererOptions`, `Backend`, `DecideCache`, `Options` | The types |
| `@byokit/decide/eval`: `evaluate`, `evaluateDecisions`, `replay`, `parse`, `format`, `summary` | Run and print an eval report over any backends |
| `byokit-eval` (bin) | Replay or refresh an eval file from the command line |

## Questions and floors

- **Questions**: `choice` (options with a one-line description each), `yesno`, and `score` (an ordered rubric, lowest
  first; the answer is the level's index).
- **The floors are code, not a prompt** (ported from firstmate's dispatch resolver): a 0.6 floor on the answer's
  confidence by default (`floor` per question). A choice option can declare its own floor (`floors`), checked against
  its own probability; a pick under it falls to the most probable other option that clears its own. A tie abstains.
- An answer whose probabilities are missing an option, out of range or don't sum to 1 is an abstain, never an error.

## Backends

- Backends are tried in order for the questions still unanswered. A backend that fails or takes longer than
  `timeoutMs` (default 5 s) answers nothing.
- `privacy: 'stays-here'` skips every backend the state would leave the device for (Jev, or any answerer with
  `leaves: true`), so private text never goes to one.
- **Any model**: `answerer({ name, leaves, ask })` makes a backend of any `(prompt, signal) => text`. On a phone, that
  is the ChatGPT the person signed in to with [`@byokit/accounts`](../accounts), on their own plan:

  ```ts
  import { answerer } from '@byokit/decide';

  const chatgpt = answerer({
    name: 'chatgpt',
    leaves: true,
    ask: (p, signal) => accounts.respond(me, { instructions: 'Reply with JSON only.', input: p, signal }),
  });
  ```

  It asks for each answer's probability as JSON; any other reply is an abstain.
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

This accounts adapter consumes a validated session; it does not start a sign-in. The existing
`Accounts.login()` Codex flow and `Accounts.respond()` are separate and cannot supply this token-sharing credential.
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
- [`examples/expo`](../../examples/expo): uses `@byokit/decide` in a React Native app
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](https://github.com/umeranjum17/byokit/blob/main/NOTICE).
