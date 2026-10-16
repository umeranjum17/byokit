# Herdr kind sign-in label

The built `@byokit/herdr` publishes each account kind's `loginLabel`. A kind that keeps its sign-in
per account reads "Sign in to this account on this computer"; a kind with no account-private home
keeps "One sign-in per computer user". Gemini reads the per-account wording because Gemini CLI 0.56.0
keeps its sign-in in files under `GEMINI_CLI_HOME` (else `HOME`) even though Herdr 0.9.1 exposes no
`folderVar` for it (packages/herdr/README.md). `packages/herdr/scripts/gen-kinds.ts` is the producer
of `packages/herdr/src/kinds.json`, so regeneration is part of the proof.

## Sub-features

- `gemini-per-account`: `accountKind('gemini')` reads the per-account wording with no `folderVar`.
- `no-folder-unchanged`: `accountKind('amp'|'cline'|'devin'|'muse'|'opencode')` keep the per-user wording.
- `vibe-preserved`: the vendor-docs `vibe` kind survives regeneration (`folderVar: 'VIBE_HOME'`,
  `resumeArgs: ['--resume', '{session}']`, per-account wording).
- `unknown-undefined`: `accountKind('not-a-real-kind')` is `undefined`.
- `generator-idempotent`: re-running the generator reproduces `src/kinds.json` byte for byte.

## How to get to it (user POV)

- A consumer app imports `accountKind`/`accountKinds` from the built `@byokit/herdr` and reads
  `loginLabel` (packages/herdr/README.md, Account-specific sign-ins and moves).

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); `npm run build` exited 0. No real Herdr, CLI, account
or egress: this reads the built kind table only.

- **Write the consumer.** `"$scratch_dir/verify-herdr-login-label.mjs"` importing `accountKind` and
  `accountKinds` from `@byokit/herdr`. It asserts: `accountKind('gemini').loginLabel` is the
  per-account wording and its `folderVar` is `undefined`; `accountKind('mistral vibe')` resolves with
  `kind: 'vibe'`, `folderVar: 'VIBE_HOME'`, `resumeArgs: ['--resume', '{session}']` and the
  per-account wording; `amp`, `cline`, `devin`, `muse` and `opencode` keep the per-user wording;
  `accountKind('not-a-real-kind')` is `undefined`; and `accountKinds()` has 25 rows whose
  per-account set is `agy,claude,codex,copilot,cursor,gemini,grok,hermes,kimi,omp,pi,qodercli,qwen,vibe`.
  It prints every label and exits non-zero on any mismatch.
- **Run and capture.** `feature=herdr-login-label; entry=@byokit/herdr; drive=(node "$scratch_dir/verify-herdr-login-label.mjs")`;
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **gemini-per-account shows.** `gemini.loginLabel = "Sign in to this account on this computer"`, `gemini.folderVar = undefined`.
- **no-folder-unchanged shows.** `amp`, `cline`, `devin`, `muse` and `opencode` print `"One sign-in per computer user"`.
- **vibe-preserved shows.** `vibe.folderVar = "VIBE_HOME"`, `vibe.resumeArgs = ['--resume', '{session}']`, `vibe.loginLabel = "Sign in to this account on this computer"`.
- **unknown-undefined shows.** `accountKind(not-a-real-kind) = undefined`.
- **generator-idempotent shows.** As a producer check in the same evidence run,
  `cp packages/herdr/src/kinds.json "$tmp.json" && node packages/herdr/scripts/gen-kinds.ts && cmp "$tmp.json" packages/herdr/src/kinds.json`
  prints nothing and exits `0`, and `git diff --stat packages/herdr/src/kinds.json` names only the
  `gemini` `loginLabel` line.

## Gotchas

- `accountKind` matches `kind`, `aliases` and `aliasPattern` case-sensitively; gemini has no alias.
- Vibe is a vendor-docs kind outside the pinned v0.9.1 excerpts; it is listed in
  `documentedKinds` in the generator so regeneration cannot drop it.
