# @byokit/decide

Typed questions in, a typed answer with confidence out, and an abstain below a floor, so your app takes its safe
default (ask the person) instead of guessing. Backends: your own `rules`, and [Jev](https://openrouter.ai/docs/guides/community/jev)
over TypeSafe's API or OpenRouter.

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
// { answer: 'followup', confidence: 0.91, probabilities: {...}, abstained: false, by: 'jev', ms: 214 }
```

- **Questions**: `choice` (options with a one-line description each), `yesno`, and `score` (an ordered rubric, lowest
  first; the answer is the level's index).
- **The floors are code, not a prompt** (ported from firstmate's dispatch resolver): a 0.6 floor on the answer's
  confidence by default (`floor` per question); a choice option can declare its own floor (`floors`), checked against its
  own probability, and a pick under it falls to the most probable other option that clears its own; a tie abstains.
  An answer whose probabilities are missing an option, out of range or don't sum to 1 is an abstain, never an error.
- **Backends** are tried in order for the questions still unanswered. A backend that fails or takes longer than
  `timeoutMs` (default 5 s) answers nothing. `privacy: 'stays-here'` skips every backend the state would leave the
  device for (Jev), so private text never goes to one.
- **Keys**: `jev()` takes the key your host read from its own environment or config. The kit never reads an environment
  variable, and the key goes only into the one request header. Never ship a key inside an app: keep it on the home
  computer and let paired devices ask it.

## Evals

Each decision gets a labelled file, `evals/<decision>.jsonl`: a header `{ decision, question, note }`, then one case per
line, `{ state, expect, jev, ms }`. `expect` is the right answer, a list of right answers, or `null` when only an abstain
is right; `jev` is Jev's answer, replayed offline so CI never calls a model.

```sh
npx byokit-eval evals/intent.jsonl                    # replay: agreement, clear-but-wrong, abstains, latency
npx byokit-eval evals/intent.jsonl --floor 0.7        # try another floor on the same answers
TYPESAFE_API_KEY=… npx byokit-eval evals/intent.jsonl --live typesafe --record   # ask Jev, write its answers back
```

Clear-but-wrong (answered, and wrong) is the number that must stay near 0; the command exits 1 when its rate is above
`--max-clear-wrong` (default 0). Set floors from the eval, not by guessing. `evaluate()` in `@byokit/decide/eval` runs the
same report over any backends, including your rules. `evals/example-urgent.jsonl` shows the format.
