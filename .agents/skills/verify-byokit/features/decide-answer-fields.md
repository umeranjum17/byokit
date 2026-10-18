# Decide additional answer fields

A caller requests extra model answer keys with `answerFields`; returned values appear on the `Answer`, while missing values stay absent.

## Sub-features

- The built `@byokit/decide` answerer path retains a requested `missingWidth` value through answer resolution.
- Unrequested values and absent requested fields are not synthesized.

## How to get to it (user POV)

An app declares `answerFields: ['missingWidth']` on a `Question`, then receives the model-provided value on that question's `Answer`.

## Driving it with node scratch consumers

Baseline build per the parent verification skill, then run the maintained integration journey:

```sh
sh scripts/test.sh packages/decide/test/decide.test.ts
```

The journey imports the built `@byokit/decide` entry and uses an offline answerer callback. It asserts the actual decision plus `missingWidth: 42` on the returned answer. No screenshot applies to this non-visual feature.

## Gotchas

- The callback is an offline fixture, not a live provider; real credentials and network are intentionally not used.
- Do not infer a result for missing model-supplied fields.
