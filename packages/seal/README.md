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

## Install

```sh
npm install @byokit/seal
```

[![npm](https://img.shields.io/npm/v/@byokit/seal?style=flat&label=)](https://www.npmjs.com/package/@byokit/seal) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=seal-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/seal
```

On React Native, install a `crypto.getRandomValues` polyfill before using it (for example
`react-native-get-random-values`).

Seal and open a box, keep a JSON value in a secretbox, and sign and verify a message:

```ts
import {
  boxKeyPair, boxPublicKey, boxKeyPairFromSeed, sealBox, openBox, openBoxFromSeed,
  box, openAuthBox, sealNotice, openNotice,
  sealJson, openJson,
  signingKeyPairFromSeed, signDetached, verifyDetached,
} from '@byokit/seal';

const text = new TextEncoder().encode('hello from the phone');

// Box: anyone with the recipient's public key can seal; only the secret opens.
const recipientSeed = crypto.getRandomValues(new Uint8Array(32));
const recipient = boxKeyPairFromSeed(recipientSeed);
const bundle = sealBox(text, recipient.publicKey);
console.log('box bytes:', bundle.length);
console.log('opened:', new TextDecoder().decode(openBox(bundle, recipient.secretKey)!));
console.log('wrong key:', openBox(bundle, crypto.getRandomValues(new Uint8Array(32))));

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
wrong key: null
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
| `boxKeyPair(rng?)` | Fresh raw 32-byte X25519 secret and its public key |
| `boxPublicKey(secret)` | X25519 public key from a raw 32-byte secret |
| `boxKeyPairFromSeed(seed)` | X25519 key pair from a 32-byte seed; same as libsodium `crypto_box_seed_keypair` |
| `sealBox(bytes, recipientPublicKey, rng?)` | Seals bytes to a public key with a fresh ephemeral key |
| `openBox(bundle, recipientSecret)` | Opens with a raw secret; `Uint8Array` or `null` |
| `openBoxFromSeed(bundle, recipientSeed)` | Opens with a seed, as in the original API |
| `box(bytes, theirPublic, mySecret, rng?)` | Known-sender authenticated box |
| `openAuthBox(bundle, theirPublic, mySecret)` | Opens a known-sender box; `Uint8Array` or `null` |
| `sealNotice(value, boxPublicKey, rng?)` | JSON in an anonymous box; `{ v: 1, sealed: string }` |
| `openNotice(data, secret)` | Opens a notice with a raw secret; `unknown` or `null` |
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
  boxKeyPair, boxPublicKey, boxKeyPairFromSeed, sealBox, openBox, openBoxFromSeed,
  box, openAuthBox, sealNotice, openNotice,
  sealSecretBox, openSecretBox, sealJson, openJson,
  signingKeyPairFromSeed, signDetached, verifyDetached,
} from '@byokit/seal';

const recipient = boxKeyPairFromSeed(recipientSeed); // 32-byte seed; same as libsodium crypto_box_seed_keypair
const bundle = sealBox(plaintext, recipient.publicKey);
const opened = openBox(bundle, recipient.secretKey); // Uint8Array | null
const sealed = sealSecretBox(plaintext, secretboxKey); // 32-byte key
const unsealed = openSecretBox(sealed, secretboxKey); // Uint8Array | null
const stored = sealJson({ machines: [] }, secretboxKey);
const catalog = openJson(stored, secretboxKey); // unknown | null
const signing = signingKeyPairFromSeed(signingSeed); // 32-byte seed
const signature = signDetached(plaintext, signing.secretKey); // 64-byte signature
verifyDetached(plaintext, signature, signing.publicKey); // boolean
```

## Raw keys, authenticated boxes and notices

```ts
const sender = boxKeyPair();
const device = boxKeyPair();
const authenticated = box(text, device.publicKey, sender.secretKey);
const opened = openAuthBox(authenticated, sender.publicKey, device.secretKey);
const notice = sealNotice({ kind: 'completed', job: 'build' }, device.publicKey);
const event = openNotice(notice, device.secretKey);
```

`openBox` now takes a raw X25519 secret. For stored seeds, keep `boxKeyPairFromSeed(seed)` and pass its
`secretKey`, or replace the old `openBox(bundle, seed)` call with `openBoxFromSeed(bundle, seed)`.
Stored ciphertext and seed derivation are unchanged. A raw secret and a seed are different inputs.

A known-sender box requires a trusted public key for the peer; both peers can produce its ciphertext, so it is
not a signature. Anonymous boxes and notices do not identify the sender. Validate decrypted notice values in
the app before acting on them. JSON `null` is indistinguishable from an opening failure; undefined values,
cyclic objects and BigInts cannot be sealed as JSON.

## Formats

- `sealBox` emits ephemeral X25519 public key (32) | nonce (24) | `crypto_box_easy` ciphertext (16-byte MAC first).
- `box` emits nonce (24) | `crypto_box_easy` ciphertext (16-byte MAC first).
- `sealNotice` emits `{ v: 1, sealed }`, where `sealed` is unpadded base64url of `sealBox` UTF-8 JSON bytes.
- `sealSecretBox` emits nonce (24) | `crypto_secretbox_easy` ciphertext.
- `sealJson` uses `JSON.stringify` then UTF-8; `openJson` parses UTF-8 and returns `null` on failure.
- `openBox`, `openAuthBox` and `openSecretBox` return `null` for short, tampered, or wrong-key bundles.
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
- [SECURITY.md](SECURITY.md)
- [`examples/expo`](../../examples/expo): box, secretbox and signatures on iOS and Android, with the
  `crypto.getRandomValues` polyfill (`expo-crypto`) in `polyfills.ts`

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
