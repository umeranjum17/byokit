# OpenClaw O14m follow-ups

- `oc.account.add` has no link op. The link refuses unknown ops, so key refusal for account add is proven at `kit.addAccount` (test "attribution and link frames"). Accepted as-is: `kit.addAccount` is the intended target. `docs/runtime-kits.md` still lists `oc.account.add` as a link op; correct the spec or add the op later.
- `memberOfAccount` reads `accounts/<member>.json` from disk on every account-shaped ref (link event filter, approvals, bridge gating). Add a cache or move the lookup to a kit-held index when the per-event read shows up in profiles.
- Legacy member ids ending in `--<hex6>` (for example `work--c0ffee`) attribute to `work` or nothing, not to themselves. Fixing this needs a way to tell a legacy member from an unindexed account agent with the same id shape; the engine roster cannot tell them apart. Decide the rule before changing attribution.
