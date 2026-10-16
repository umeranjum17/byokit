- FIX: the short-code host lookup (`findHost`) is bounded, so a relay that accepts the request but never
  answers now fails in seconds with a typed `RelayLookupError` (`timeout`) instead of hanging for the
  platform's own ~140 s and leaving the socket open. `timeoutMs` sets the bound (default `RELAY_LOOKUP_MS`,
  8 s: link dials the host with the same 8 s budget); the request is aborted on timeout, so consumers get a
  bounded, plain-words failure instead of a long spin.
