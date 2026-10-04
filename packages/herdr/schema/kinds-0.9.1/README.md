# Pinned kind source

Exact excerpts from Herdr v0.9.1, commit `065ef9d6a531c49fb8bee7e818ef837065b21ee9`.
`provenance.json` records the full-file SHA-256 hashes and the retained source line ranges.
The filenames correspond to `src/detect/mod.rs`, `src/integration/env.rs` and `src/agent_resume.rs`.

Regenerate offline with `node packages/herdr/scripts/gen-kinds.ts`. The generator checks 24 kinds,
12 folder mappings and 18 resume planners; `test/kinds.test.ts` checks byte-equivalent data.
The direct `PI_CODING_AGENT_DIR` override is used for both Pi-family kinds. `PI_CONFIG_DIR`
is a home-relative fallback, not an absolute account folder. `GROK_CONFIG_DIR` is a Herdr-only
hook override; the actual CLI account folder is `GROK_HOME`.

All billing remains unknown/explicit because Herdr delegates login and provider selection to each CLI.
No-folder kinds are tab-only. Resume metadata is capability, not proof of a working native move.
The special Letta planner is listed as resume-capable but has no generic argv template and no managed
folder, so neither account move helper uses it. No real CLI, credential store or native session is probed.
