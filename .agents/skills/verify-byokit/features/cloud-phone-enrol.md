# Cloud phone-key enrol (K-ENROL)

The setup device hands exactly the one authenticated phone's 32-byte public key to the machine through provider delivery, and the machine's host process binds it with `Host.enrol` from the built `@byokit/cloud`. No new pairing crypto; the key travels only as delivery bytes, never in `run.env`, `run.argv`, logs or error text.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). Import public entries only (`@byokit/cloud`, `@byokit/cloud/testing`, `@byokit/pair`); print no key bytes, base64 or grant ids.

- **Write the consumer.** `"$scratch_dir/verify-cloud-phone-enrol.mjs"`: create and install the `web` recipe on `fakeProvider()`, `deliverPhoneKey` the phone key, `Host.open` over an in-memory grant store, `bindPhoneKey` the landed bytes, rebind the same key, refuse another with `owner-enrolled`, reopen the store and repeat, then run `setup()` with `pair: pairEnrol(m2, recipe, phoneKey)` on a fresh fake provider and log the steps.
- **Run and capture.** `feature=cloud-phone-enrol; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-phone-enrol.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `delivered` is 32 bytes at mode 600 owned by the run user; `bind` is bound with one `control`/`phone` grant matching the key; `rebind` is unbound with the same id; `second-key` is `owner-enrolled`; after reopening the store `restart` still holds one grant, the same key rebinds and another is refused; `setup` lists the six steps through `pairing` to `ready`; a 3-byte key is `bad-recipe`.

### Owner re-enrol (K-EXISTS)

A reinstalled app or a new phone (empty store) running `setup()` on its own computer gets `failed` at `inspecting` with cause `error.ownerEnrolled`, `retryable: false`, and nothing on the machine changes; only the same `setup()` with `replaceOwner: true` (after the person confirms) reinstalls in place and delivers the key as `owner.bin`, which the host binds with `replacePhoneKey`: the old phone's grant is gone, the new one bound, and a later `phone.bin` of the old key is refused `owner-enrolled`.

- **Bench.** `sh scripts/test.sh packages/cloud/test/enrol.test.ts` (the `a new phone sees the typed owner cause…` journey: fake provider, real `Host` over a durable grant store, reopened for the restart).
- **Live run (boat.dev).** `feature=cloud-owner-reenrol; entry=@byokit/cloud; drive=(node .agents/skills/verify-byokit/capture/cloud-owner-reenrol.mjs "$boat_key_file" "$tgz")`, where `$boat_key_file` is the fleet's saved Boat key file and `$tgz` is `npm pack` of `packages/cloud` (omit it to install `@byokit/cloud@next` on the machine). Run SKILL.md Evidence's capture block, then `leak_check` the Boat key read into a variable. It creates one `small` sandbox without copies and always deletes it. Pass: `setup-a` ends `ready` and `host-a` holds phone A; `setup-b` is `failed:inspecting:error.ownerEnrolled:retryable=false` with `unchanged-after-refusal: true`; `setup-b-replace` ends `ready` and `host-b` holds phone B only; `after-restart` (a newer `started`) still B only; `stale-a-refused` shows `phone.bin:owner-enrolled`; `removed: "gone"`. First passed 2026-10-18. Follow the Boat rule in `cloud-claim.md` (fleet key never printed or revoked, delete only your own machine, no claim).

## Gotchas

- The inbox file is delivery bytes, not a secret: still print only its length, mode and owner, never its content.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-phone-enrol/` evidence survives.
