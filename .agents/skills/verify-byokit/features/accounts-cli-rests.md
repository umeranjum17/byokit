# Managed CLI persisted rests

## Drive

From the built workspace baseline and Doctor in SKILL.md:

```bash
feature=accounts-cli-rests; entry='@byokit/accounts/cli'
drive=(node .agents/skills/verify-byokit/capture/accounts-cli-rests.mjs)
```

Run SKILL.md's Evidence capture block (use the dispatched task's external evidence directory when required).
The maintained consumer imports only the built public `@byokit/accounts/cli` entry, runs an isolated fake Claude CLI, and removes its exclusive scratch directory on exit.

## Feature-map proof route

- `cli-rest-status`: after `rest(id, { until, why })`, `status` returns `resting` with that `until`.
- `cli-rest-launch`: `launch` refuses with `code: 'resting'` and `status.resting` words; no `set`/`unset`.
- `cli-rest-file`: `rests-v1.json` is mode 0600 and holds `{ version: 1, rests: [{ id, until, why }] }`.
- `cli-rest-expiry`: an expired rest reads as `ready` again; the next write prunes it.
- `cli-rest-corrupt`: a corrupt rests file reads as no rests and is rewritten empty at 0600.

A passing drive prints the refusal JSON and OK lines, with exit 0.

## Limits

Offline SDK qualification only: fake Claude binary, throwaway state dir, no live login or paid request.
