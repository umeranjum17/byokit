# Security boundaries

Seal provides NaCl-compatible encryption and signatures; it does not manage identity, trust, storage, replay
protection or authorization. Store secrets in the app's secure store and obtain peers' public keys through an
authenticated channel. The portable entry imports no Node modules and reads no files or environment variables.

`boxKeyPair` uses a raw 32-byte X25519 secret. `boxKeyPairFromSeed` derives that secret from the first 32 bytes
of SHA-512, as libsodium does. `openBox` accepts the raw secret; `openBoxFromSeed` derives it for seed-based
callers. Never interpret a signing secret as a box secret.

`sealBox` and `sealNotice` use a fresh ephemeral key and nonce. Anyone holding the recipient's public key can
produce them: successful opening proves integrity and confidentiality, not sender identity. `box` and
`openAuthBox` use the peer's known public key and your secret; both peers can produce a valid message, so this
is not a transferable signature. Use detached signatures when that distinction matters.

Every encryption uses `crypto.getRandomValues` by default. React Native hosts must install a secure polyfill.
The injectable RNG is for tests only. Never reuse a nonce with the same encryption key. Opening rejects short,
tampered, wrong-key and low-order peer-key bundles with `null`, without returning unauthenticated plaintext.

Notices are version-1 envelopes containing unpadded base64url ciphertext. The encrypted body is UTF-8 JSON;
opening rejects malformed envelopes, invalid UTF-8 and invalid JSON. The caller validates the decrypted value
and enforces replay/expiry policy before acting. Envelopes reveal their version and ciphertext length; relay
metadata and any separately supplied push title remain visible. Use generic titles and keep private content
inside the envelope.

Derived shared keys, ephemeral encryption secrets and temporary notice plaintext byte arrays are cleared after
use. Caller-owned secrets are never cleared by opening or authentication. JavaScript strings, garbage collection
and crypto internals prevent a guarantee that all copies are erased. The pinned Noble dependencies and the
libsodium/TweetNaCl interoperability tests define the supported byte formats.
