# Infer token probabilities

Drive the built `@byokit/infer` public entry with the existing consumer journey test:

```sh
sh scripts/test.sh 'packages/infer/test/*.test.ts'
```

The `complete()` journey requests `n_probs`, observes it at the llama.rn boundary, and asserts `completion_probabilities` on the returned `Completion`. This fixture-backed integration journey is the available offline host proof; physical-device llama.rn behavior remains unverified here.
