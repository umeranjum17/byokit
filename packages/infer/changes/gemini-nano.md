- NEW: Android's built-in Gemini Nano (AICore, through an app-supplied ML Kit GenAI Prompt module) as a second local
  backend: `NanoModel`, with a typed `unsupported` state when AICore is absent, unavailable, silent or failing.
- NEW: `inferBackend({ where: 'local' })` picks Gemini Nano when it is ready, else the downloaded model, labelled by
  `whereWords()`; `stateWords(s, { nano: true })` words Nano's states. `generate()` without a schema returns free text.
