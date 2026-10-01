# Live check: Message desk

Status: **not yet run live**. No model answer, latency or correctness result is
claimed from an offline test or unsigned-in screen.

Source baseline: current main `40ecf7e9c121ec9a8fc18fc4103453541b8172b7`.
Captured candidate commit: pending capture.

| Check | ChatGPT plan | Claude plan |
|---|---|---|
| Real provider sign-in | Pending human completion | Pending human completion |
| All 12 realistic messages | Not run | Not run |
| Correct typed answers | Not measured | Not measured |
| Below-floor abstain with probabilities | Not run | Not run |
| Human answer visibly handed back | Not captured | Not captured |
| Embedded instruction ignored | Not run | Not run |
| Billing names the person's plan | Implemented; live capture pending | Implemented; live capture pending |
| Median latency | Not measured | Not measured |

Required evidence: live `transcript.jsonl` (provider, requested model, latency per
call and captured commit), full-resolution answer and abstain stills, captions
and a short mp4. Save under `.lab/evidence/decide-plan/`. Live capture also requires
an approved real browser surface; loopback preparation alone is insufficient.
