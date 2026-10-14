# Cloud phone-key enrol (K-ENROL)

The setup device hands exactly the one authenticated phone's 32-byte public key to the machine through provider delivery, and the machine's host process binds it with `Host.enrol` from the built `@byokit/cloud`. No new pairing crypto; the key travels only as delivery bytes, never in `run.env`, `run.argv`, logs or error text.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). Import public entries only (`@byokit/cloud`, `@byokit/cloud/testing`, `@byokit/pair`); print no key bytes, base64 or grant ids.

- **Write the consumer.** `"$scratch_dir/verify-cloud-phone-enrol.mjs"`: create and install the `web` recipe on `fakeProvider()`, `deliverPhoneKey` the phone key, `Host.open` over an in-memory grant store, `bindPhoneKey` the landed bytes, rebind the same key, refuse another with `exists`, reopen the store and repeat, then run `setup()` with `pair: pairEnrol(m2, recipe, phoneKey)` on a fresh fake provider and log the steps.
- **Run and capture.** `feature=cloud-phone-enrol; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-phone-enrol.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `delivered` is 32 bytes at mode 600 owned by the run user; `bind` is bound with one `control`/`phone` grant matching the key; `rebind` is unbound with the same id; `second-key` is `exists`; after reopening the store `restart` still holds one grant, the same key rebinds and another is refused; `setup` lists the six steps through `pairing` to `ready`; a 3-byte key is `bad-recipe`.

## Gotchas

- The inbox file is delivery bytes, not a secret: still print only its length, mode and owner, never its content.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-phone-enrol/` evidence survives.
