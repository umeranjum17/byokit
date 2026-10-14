- FIX: After `removeAccount` on a member-agent account (`authLogout`), a late token refresh that rewrites
  `state/agents/<member>` is dropped on the next `prepare`: the removal records the provider in the index's `dropped`
  list (parallel to account-agent `gone`), and the orphan sweep removes that provider's member-store auth profiles
  (JSON and native store) while no member-agent index entry names it again. A live subscription the index has not yet
  named is left alone, so listing can still synthesize it.
