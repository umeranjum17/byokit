- FIX: an OpenRouter key sign-in now registers the provider's live list beside the model the person chose, so the
  member keeps every model the vendor lists to pick from (the MiniMax models, `minimax/minimax-m3.1-flash` and its
  free variant, among them) and `openrouter/auto` stays beside them. The engine's catalog stops at a registered list,
  so an add that registered the chosen model alone left the member with that one row and nothing else to pick from.
  The rows are deduped by the id the engine keeps, so the Google preview pair is one row and the list is never
  refused, and the chosen model is registered on its own as well, so a list the engine refuses never costs the member
  their own choice.
