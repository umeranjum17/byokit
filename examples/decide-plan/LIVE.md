# Live check: Message desk

Status: **first ChatGPT run failed acceptance; corrected question awaiting a fresh live run**.
No live Claude result is claimed.

Current main baseline: `7a692353b13ed41c2522e20ffe21407c06b76c5d`.
First evidence baseline: `40ecf7e9c121ec9a8fc18fc4103453541b8172b7`.
First captured candidate: `5af2c8a93183b866d76838d57632e64e3b5cb734`.

On 2026-10-01, a real ChatGPT plan answered the 12-message browser set using requested
model `gpt-6-luna`. Eleven answers were correct; the median was **2686 ms**. The
embedded instruction was ignored. The missing-deadline question answered false at
99% self-reported confidence, so **no abstain or human handoff was demonstrated**.
The first question asked whether today was explicitly required, conflating a missing
statement with a known deadline. The corrected question asks about the actual deadline
and describes missing timing as unknown. Its live result remains pending.

All failed-run calls (including an initial connectivity call, 13 total), screenshots,
summary and recording are retained under `.lab/evidence/decide-plan/first-run/` with
captions naming the captured commit. The first run is not cited as passing acceptance.
The same evidence is committed in [evidence/first-run](evidence/first-run/CAPTIONS.md).

| Check | ChatGPT plan | Claude plan |
|---|---|---|
| Real provider sign-in | Passed first candidate; fresh candidate pending | Human consent pending; first flow expired |
| All 12 realistic messages | Run on first candidate | Not run |
| Correct typed answers | 11/12; corrected question pending live | Not measured |
| Below-floor abstain with probabilities | Failed first candidate | Not run |
| Human answer visibly handed back | Not captured | Not captured |
| Embedded instruction ignored | Passed: task at 99% | Not run |
| Billing names the person's plan | Captured: Your ChatGPT plan | Implemented; live capture pending |
| Median latency | 2686 ms on first 12-message run | Not measured |

Required evidence: live `transcript.jsonl` (provider, requested model, latency per
call and captured commit), full-resolution answer and abstain stills, captions
and a short mp4. Save under `.lab/evidence/decide-plan/`. Capture uses the real
browser app and authenticated provider calls; mocks are never live evidence.
