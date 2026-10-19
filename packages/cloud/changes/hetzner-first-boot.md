- FEAT: A person with only the phone app can rent a Hetzner server and have the app's host installed on it, with no SSH
  and no install by hand: `hetznerApi()` (portable, React Native) creates, reads and deletes over HTTPS alone, and
  `firstBoot: { recipe, phoneKey }` makes cloud-init install the pinned Node, the recipe, the unit and the owner phone's
  key on first boot, behind a firewall that lets nothing in. `server`, `cloudConfig` and `request()` pass any other
  Hetzner field or call through, typed. The Node `./hetzner` entry is unchanged.
- FEAT: `setupCommand(recipe)` returns one line to paste into the person's own computer or any provider console; it
  installs the same way and ends with the pinned `byokit-ready <name>` line (plus the host's answer, such as a pairing
  code) or `byokit-failed <name> <step>`.
