# Infer token probabilities

Drive the built `@byokit/infer` public entry with the existing consumer journey test:

```sh
sh scripts/test.sh 'packages/infer/test/*.test.ts'
```

The `complete()` journey requests `n_probs`, observes it at the llama.rn boundary, and asserts `completion_probabilities` on the returned `Completion`. It also decodes through `sampledReply` from `@byokit/infer/testing`, which samples like llama.rn 0.12.9's default chain (top-k/top-p/min-p cut, temperature 0 keeps only the argmax, `n_probs` read after sampling): for an ambiguous and a peaked logit set the read must equal the model's softmax over distinct tokens, sum to at most 1, give the returned token mass, spread over at least two tokens when ambiguous, read near 1 when peaked, and match greedy's argmax when `n_probs` is unset. Before the fix this fails with `A reads 1, the model gives 0.39…`. This fixture-backed integration journey is the available offline host proof; physical-device llama.rn behavior remains unverified here.
