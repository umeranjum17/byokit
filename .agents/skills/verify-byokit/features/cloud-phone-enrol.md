# Cloud phone-key enrol (K-ENROL, K-RECEIPT, K-PUBLIC)

The setup device hands exactly the one authenticated phone's 32-byte public key to the machine through provider delivery, and the machine's host process binds it with `Host.enrol` from the built `@byokit/cloud`. No new pairing crypto; the key travels only as delivery bytes, never in `run.env`, `run.argv`, logs or error text. The host answers with a receipt of public values (`phoneReceipt`, outbox `receipt.json`); `setup()` secures the address first (`securing`: tailnet name joined or confirmed, app port served privately) and the `pairing` step carries `receipt: { host, device, urls }`, which is all the phone needs to open a real `@byokit/pair` link.

## Sub-features

- `enrol-bind`: delivery, bind, rebind, `exists` for another key, restart-safe (the node scratch consumer below).
- `pair-receipt-bench`: `capture/cloud-pair-receipt.mjs bench` — fake provider with a joined tailnet, real `Host` in-process: steps `checking-access … installing, securing:<name>, pairing:receipt, ready`; serve `7300 → 127.0.0.1:7300`; the receipt's host key matches; the phone links (`online`) with only the receipt and answers one `get.state`; another phone holding the same receipt is refused (`removed`); an unserved route ends `failed:securing:state.failed:true`. A resolver stands in for MagicDNS + `tailscale serve`.
- `pair-receipt-live`: `capture/cloud-pair-receipt.mjs live` — one real Boat machine: create, install a small pair host from a packed `@byokit/cloud` + `@byokit/pair`, `setup()` with `address` (the tailnet owner opens the printed sign-in link), then this computer, on the same tailnet, links to `ws://<tailnet name>:7300` with only the receipt, makes one request, and a stranger phone is refused. Always logs the machine out of the tailnet and deletes it.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md). Import public entries only (`@byokit/cloud`, `@byokit/cloud/testing`, `@byokit/pair`); print no key bytes, base64 or grant ids.

- **Write the consumer.** `"$scratch_dir/verify-cloud-phone-enrol.mjs"`: create and install the `web` recipe on `fakeProvider()`, `deliverPhoneKey` the phone key, `Host.open` over an in-memory grant store, `bindPhoneKey` the landed bytes, rebind the same key, refuse another with `exists`, reopen the store and repeat. The `setup()` leg is the receipt bench below (`pairEnrol` now waits for the host's receipt).
- **Run and capture.** `feature=cloud-phone-enrol; entry=@byokit/cloud; drive=(node "$scratch_dir/verify-cloud-phone-enrol.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **What it proves.** `delivered` is 32 bytes at mode 600 owned by the run user; `bind` is bound with one `control`/`phone` grant matching the key; `rebind` is unbound with the same id; `second-key` is `exists`; after reopening the store `restart` still holds one grant, the same key rebinds and another is refused; a 3-byte key is `bad-recipe`.

## Receipt and secure address (maintained capture)

- **Bench.** `feature=cloud-phone-enrol; entry=@byokit/cloud; drive=(node .agents/skills/verify-byokit/capture/cloud-pair-receipt.mjs bench)`, then SKILL.md Evidence's capture block. Exit `0` and `result: "PASS"`.
- **Live (lab).** Needs the fleet Boat key file, a person who can sign a machine into the tailnet within the run, and this computer on that tailnet with MagicDNS. Pack the built kit outside the repo (`npm pack --pack-destination <scratch>` in `packages/cloud`), then run with `BOAT_KEY_FILE=<key file> EVIDENCE_DIR=<outside the repo> CLOUD_TGZ=<scratch>/byokit-cloud-<version>.tgz node .agents/skills/verify-byokit/capture/cloud-pair-receipt.mjs live`. It records the machine in `owned.json` before anything else, writes the sign-in link to `login-link.txt` (and stdout), retries a timed-out `securing` for up to 30 minutes, and ends with `tailnet-logout`, `removed`, `still-listed: false` and `result`. Never print the key; the driver's guard throws if it reaches an output line.

## Gotchas

- The inbox file is delivery bytes, not a secret: still print only its length, mode and owner, never its content.
- Remove only `"$scratch_dir"` in cleanup; the `.verify-artifacts/cloud-phone-enrol/` evidence survives.
