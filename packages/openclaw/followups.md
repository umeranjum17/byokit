# OpenClaw O14m follow-ups

- Approved as-is: `oc.account.add` has no link op. The link refuses unknown ops, so key refusal for account add is proven at `kit.addAccount` (test "attribution and link frames"). The spec marks the row not shipped; add the op later if a link needs it.
- Approved as-is: the spec (`docs/runtime-kits.md`) and the code land in one PR, with the `createAccounts` `memberOf` line removed and `memberOfAccount` added together.
- `memberOfAccount` reads `accounts/<member>.json` and stats `workspaces/<agent>` from disk on every account-shaped ref (link event filter, approvals, bridge gating). Add a cache or a kit-held index when the per-event read shows up in profiles.
