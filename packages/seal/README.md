# @byokit/seal

Portable NaCl-compatible bytes for Node 22+, browsers/PWAs and React Native. No native modules or Node runtime imports. Install `@byokit/seal`; on React Native, install a `crypto.getRandomValues` polyfill before using it (for example `react-native-get-random-values`). Uses pinned `@noble/curves`, `@noble/ciphers`, and `@noble/hashes`.

```ts
import {
  boxKeyPairFromSeed, sealBox, openBox,
  sealSecretBox, openSecretBox, sealJson, openJson,
  signingKeyPairFromSeed, signDetached, verifyDetached,
} from '@byokit/seal';

const recipient = boxKeyPairFromSeed(recipientSeed); // 32-byte seed; same as libsodium crypto_box_seed_keypair
const bundle = sealBox(plaintext, recipient.publicKey);
const opened = openBox(bundle, recipientSeed); // Uint8Array | null
const stored = sealJson({ machines: [] }, secretboxKey); // 32-byte key
const catalog = openJson(stored, secretboxKey); // unknown | null
const signing = signingKeyPairFromSeed(signingSeed); // 32-byte seed
const signature = signDetached(plaintext, signing.secretKey); // 64-byte seed | public key secret
verifyDetached(plaintext, signature, signing.publicKey); // boolean
```

`sealBox` emits ephemeral X25519 public key (32) | nonce (24) | `crypto_box_easy` ciphertext (16-byte MAC first). `sealSecretBox` emits nonce (24) | `crypto_secretbox_easy` ciphertext. `openBox` and `openSecretBox` return `null` for short, tampered, or wrong-key bundles. `sealJson` uses JSON.stringify then UTF-8; `openJson` parses UTF-8 and returns `null` on failure. Each seal accepts an optional final `(length: number) => Uint8Array` RNG for deterministic tests; in production the default is `crypto.getRandomValues`. Never reuse a secretbox nonce with the same key or substitute deterministic RNG in production. Keep secrets in a platform secure store; this library does not manage storage or keys. Invalid key lengths passed to seal/sign throw.

The suite checks fixed libsodium/tweetnacl vectors and both directions of interoperability with `sodium-native`, including tamper and wrong-key cases. Run `npm run build && npm run check && npm test` at the repository root.
