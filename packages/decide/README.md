<h1 align="center">@byokit/decide</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/decide"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/decide?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node | browsers | React Native" src="https://img.shields.io/badge/platform-Node%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>Typed questions in, a typed answer with confidence out.</strong><br/>
Below a floor it abstains, so your app takes its safe default (ask the person) instead of guessing. Backends are your
own <code>rules</code>, any model you can send a prompt to (on a phone, the person's own ChatGPT), and
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
| `decide(state, questions, { privacy, backends, timeoutMs? })` | Asks each backend in order for the questions still unanswered; returns an `Answer` per question |
| `rules(fn)` | Your own function as a backend: return the answer for an obvious case, `undefined` otherwise. Stays on the device |
| `answerer({ name, leaves, ask })` | Any `(prompt, signal) => text` model as a backend |
| `jev({ key, via?, fetch? })` | Jev as a backend, over TypeSafe's API (default) or OpenRouter (`via: 'openrouter'`). API-billed |
| `resolve(question, raw)` | The floors on one raw answer, for an app that holds a recorded answer |
| `FLOOR` | The default floor, 0.6 |
| `Question`, `Answer`, `Raw`, `Backend`, `Options` | The types |
| `@byokit/decide/eval`: `evaluate`, `replay`, `parse`, `format`, `summary` | Run and print an eval report over any backends |
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

## Phones and browsers

The main entry is plain TypeScript with `fetch` (the eval CLI is its own entry), so it bundles for React Native and the
web; `test/react-native.test.ts` runs it where there is no Node.

## Keys

`jev()` takes the key your host read from its own environment or config. The kit never reads an environment variable,
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

## Links

- [byokit](../../README.md): the other packages
- [`examples/expo`](../../examples/expo): uses `@byokit/decide` in a React Native app
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](https://github.com/umeranjum17/byokit/blob/main/NOTICE).
