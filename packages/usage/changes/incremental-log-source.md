- FIX: Local harness usage had no kit incremental source. Add an explicit-file,
  bounded incremental JSONL source for fixture-qualified
  Pi/OMP, Claude and Codex usage records, with normalized counts, event deduplication,
  partial-line retention and rotation handling. Account, run, route and billing
  attribution remain caller-owned; other harness stores and ccusage extras are unsupported.
