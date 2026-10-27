# Provider-backed speech

The provider path returns audio bytes for the host app to play; it does not change device speech. Prove from the built `@byokit/speak` public entry against a local HTTP fake: connect with a synthetic credential, list voices, explicitly persist one provider/voice choice, speak and verify exact request body and response bytes. Also prove missing selection and provider HTTP refusal reject without falling back to the device speaker. Keep credentials synthetic and assert they do not appear in captured output. The OpenAI-compatible reference routes are `/v1/audio/voices` and `/v1/audio/speech`.

Run the package integration test with `sh scripts/test.sh 'packages/speak/test/provider.integration.test.ts'` after `npm run build`. No live provider, account, network or audible output is needed.
