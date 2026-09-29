# Changelog

## Unreleased

## 0.2.0

- `answerer({ name, leaves, ask })` makes a decision backend of any `(prompt, signal) => text`, such as the ChatGPT the person signed in to; any reply that is not the requested JSON is an abstain.
- The main entry is plain TypeScript with `fetch`, so it bundles for React Native and the web.

## 0.1.1

- The Apache-2.0 LICENSE ships in the tarball.

## 0.1.0

- Typed decisions with rules and Jev backends, abstaining below a confidence floor, and the `byokit-eval` runner.
