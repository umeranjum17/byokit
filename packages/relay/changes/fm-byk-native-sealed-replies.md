- New: `POST /relay/v1/push/action` accepts an optional bounded `reply`, an opaque sealed ciphertext (for example a
  free-text answer sealed to the host's key) that the relay forwards unchanged to the host's `onAction` as
  `PushAction.reply` and never reads or stores. It must be a non-empty string of at most `MAX_ACTION_REPLY` (8192)
  characters, refused otherwise before the one-use token is spent. Token, action authorization and rate limits are
  unchanged.
