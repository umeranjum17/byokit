- NEW: opt-in prompt-identity logging for `summarizePane`: `PaneSummaryOptions.identity` (`{ tracker, onIdentity }`,
  off unless set) records `{ inputTokens, hash }` per prompt that reaches the engine — never any content — and
  `PromptIdentityLog` counts consecutive-identical / identical-non-consecutive / changed prompts as bench-readable
  JSON, so a later device session can measure how often the GGUF warm-cache path is actually reachable.
  `commonPrefixLength` quantifies the shared prefix of consecutive pane prompts for the same analysis.
