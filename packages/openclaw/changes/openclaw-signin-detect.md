- FIX: a key sign-in through `@byokit/openclaw` no longer fires one slow `openclaw.setup.detect` per reader: the
  readiness read, the account list and a sign-in share one detection per agent (one probe in flight, its answer reused
  briefly, and every sign-in, sign-out, key change and account change drops it), and the pin's own status and the
  detection now run together. The app's poll after a sign-in costs one probe instead of fifteen.
- FIX: a key lane lists the models the provider's live catalog offers, so a model the picker showed (MiniMax Flash)
  stays listed and pickable instead of being refused as "not included" while the engine's own list still lags the
  registration. The kit keeps no model list of its own: the rows are the ones it registered from the live catalog.
