# OpenClaw in-place sign-in (credentialPolicy 'in-place')

Verification recipe for `kit.addAccount(member, { authChoice, credentialPolicy: 'in-place' }, on)` and `kit.accountContext(member, id)` (K3): a fresh sign-in writes only its final store, and no account's credential is moved, copied or overwritten by another account's add.

## Sub-features

- Two ChatGPT sign-ins land on two own stores (neither on the member agent); rows carry `origin: 'managed'` and `capabilities`.
- The same principal again answers `{ view: { state: 'failed', why: 'duplicate', existing } }`: account A's store and the index are unchanged, the provisional store is gone.
- A second sign-in started while one runs answers `why: 'busy'`; no callback is shared.
- `again` signs in on the account's own store; another principal marks it `needs_again` with `unavailable: 'identity_mismatch'` (config reference and recorded principal kept); the correct principal clears it. No rollback is claimed.
- `accountContext` returns only `{ account, agentId }`; an unknown id is refused.
- Without the policy `addAccount` is unchanged (adopt/merge, covered by openclaw-identity-merge).

## How to get to it (user POV)

A person adds a second ChatGPT account from Settings: the new login becomes its own row; signing in as one they already have tells them so and changes nothing.

## Driving it

After SKILL.md Launch and Doctor:

```bash
feature=openclaw-in-place
entry=.agents/skills/done-done-verify-byokit/capture/openclaw-in-place.mjs
drive=(node "$entry")
```

Use SKILL.md's Evidence capture block. Imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing`; no provider, credential or network.
