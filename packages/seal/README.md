<h1 align="center">@byokit/seal</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/seal"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/seal?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node 22+ | browsers | React Native" src="https://img.shields.io/badge/platform-Node%2022%2B%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>Portable NaCl-compatible box, secretbox and Ed25519 signatures.</strong><br/>
Box, secretbox and Ed25519 signatures for Node 22+, browsers/PWAs and React Native, with no native modules and no
Node runtime imports. For apps that store or send small secrets and need the same bytes libsodium and tweetnacl
produce.</p>

## Quickstart

```sh
npm install @byokit/seal
```

On React Native, install a `crypto.getRandomValues` polyfill before using it (for example
`react-native-get-random-values`).

Seal and open a box, keep a JSON value in a secretbox, and sign and verify a message:

```ts
import {
  boxKeyPairFromSeed, sealBox, openBox,
  sealJson, openJson,
  signingKeyPairFromSeed, signDetached, verifyDetached,
} from '@byokit/seal';

const text = new TextEncoder().encode('hello from the phone');

// Box: anyone with the recipient's public key can seal; only the seed opens.
const recipientSeed = crypto.getRandomValues(new Uint8Array(32));
const recipient = boxKeyPairFromSeed(recipientSeed);
const bundle = sealBox(text, recipient.publicKey);
console.log('box bytes:', bundle.length);
console.log('opened:', new TextDecoder().decode(openBox(bundle, recipientSeed)!));
console.log('wrong seed:', openBox(bundle, crypto.getRandomValues(new Uint8Array(32))));

// Secretbox JSON: one 32-byte key seals and opens data at rest.
const key = crypto.getRandomValues(new Uint8Array(32));
const stored = sealJson({ machines: ['desk'] }, key);
console.log('json:', openJson(stored, key));
stored[stored.length - 1] ^= 1;
console.log('tampered json:', openJson(stored, key));

// Ed25519 detached signatures.
const signing = signingKeyPairFromSeed(crypto.getRandomValues(new Uint8Array(32)));
const signature = signDetached(text, signing.secretKey);
console.log('signature bytes:', signature.length, 'secret key bytes:', signing.secretKey.length);
console.log('verified:', verifyDetached(text, signature, signing.publicKey));
console.log('other message:', verifyDetached(new TextEncoder().encode('changed'), signature, signing.publicKey));
```

Output of running the TypeScript file with `node` (Node 22.18+):

```text
box bytes: 92
opened: hello from the phone
wrong seed: null
json: { machines: [ 'desk' ] }
tampered json: null
signature bytes: 64 secret key bytes: 64
verified: true
other message: false
```

The 92-byte box is 32 (ephemeral public key) + 24 (nonce) + 16 (MAC) + 20 (the message).

## API at a glance

| Export | What it does |
|---|---|
| `boxKeyPairFromSeed(seed)` | X25519 key pair from a 32-byte seed; same as libsodium `crypto_box_seed_keypair` |
| `sealBox(bytes, recipientPublicKey, rng?)` | Seals bytes to a public key with a fresh ephemeral key |
| `openBox(bundle, recipientSeed)` | Opens a box; `Uint8Array` or `null` |
| `sealSecretBox(bytes, key, rng?)` | Seals bytes with a 32-byte secret key |
| `openSecretBox(bundle, key)` | Opens a secretbox; `Uint8Array` or `null` |
| `sealJson(value, key, rng?)` | `JSON.stringify`, UTF-8, then secretbox |
| `openJson(bundle, key)` | Opens and parses; the value or `null` |
| `signingKeyPairFromSeed(seed)` | Ed25519 key pair from a 32-byte seed; tweetnacl-style 64-byte secret key |
| `signDetached(bytes, secretKey)` | 64-byte detached signature |
| `verifyDetached(bytes, signature, publicKey)` | `true` or `false` |
| `RandomBytes` (type) | `(length: number) => Uint8Array`, the optional RNG the seal functions take |

Every call in one place:

```ts
import {
  boxKeyPairFromSeed, sealBox, openBox,
  sealSecretBox, openSecretBox, sealJson, openJson,
  signingKeyPairFromSeed, signDetached, verifyDetached,
} from '@byokit/seal';

const recipient = boxKeyPairFromSeed(recipientSeed); // 32-byte seed; same as libsodium crypto_box_seed_keypair
const bundle = sealBox(plaintext, recipient.publicKey);
const opened = openBox(bundle, recipientSeed); // Uint8Array | null
const sealed = sealSecretBox(plaintext, secretboxKey); // 32-byte key
const unsealed = openSecretBox(sealed, secretboxKey); // Uint8Array | null
const stored = sealJson({ machines: [] }, secretboxKey);
const catalog = openJson(stored, secretboxKey); // unknown | null
const signing = signingKeyPairFromSeed(signingSeed); // 32-byte seed
const signature = signDetached(plaintext, signing.secretKey); // 64-byte signature
verifyDetached(plaintext, signature, signing.publicKey); // boolean
```

## Formats

- `sealBox` emits ephemeral X25519 public key (32) | nonce (24) | `crypto_box_easy` ciphertext (16-byte MAC first).
- `sealSecretBox` emits nonce (24) | `crypto_secretbox_easy` ciphertext.
- `sealJson` uses `JSON.stringify` then UTF-8; `openJson` parses UTF-8 and returns `null` on failure.
- `openBox` and `openSecretBox` return `null` for short, tampered, or wrong-key bundles.
- Invalid key lengths passed to seal/sign throw.

## Randomness and keys

Each seal accepts an optional final `(length: number) => Uint8Array` RNG for deterministic tests; in production the
default is `crypto.getRandomValues`.

```ts
import { sealSecretBox, type RandomBytes } from '@byokit/seal';

// Tests only: a fixed RNG makes the output repeatable. Never in production.
const fixed: RandomBytes = (length) => new Uint8Array(length).fill(7);
const key = new Uint8Array(32).fill(1);
const a = sealSecretBox(new Uint8Array([1, 2, 3]), key, fixed);
```

Never reuse a secretbox nonce with the same key or substitute deterministic RNG in production. Keep secrets in a
platform secure store; this library does not manage storage or keys.

## Dependencies

Uses pinned `@noble/curves`, `@noble/ciphers` and `@noble/hashes`. No native modules or Node runtime imports.

## Tests

The suite checks fixed libsodium/tweetnacl vectors and both directions of interoperability with `sodium-native`,
including tamper and wrong-key cases. Run `npm run build && npm run check && npm test` at the repository root.

## Links

- [byokit](../../README.md), the repository root
- [CHANGELOG.md](CHANGELOG.md)
- [`examples/expo`](../../examples/expo): box, secretbox and signatures on iOS and Android, with the
  `crypto.getRandomValues` polyfill (`expo-crypto`) in `polyfills.ts`

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
