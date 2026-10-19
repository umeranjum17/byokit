- FIX: A lost answer from a cloud computer create no longer bills a second computer. `machine().create` saves the
  create's idempotency key in the store (`MachineRecord.pending`) before it asks the provider, so a retry, even after
  an app restart, sends the same key and gets back the computer already made; a retry with another name, size or
  `keepCopies` rejects `exists` while that create is pending.
- NOTE: Boat keeps an idempotency key for 24 hours; a retry after that cannot find the earlier computer by key.
