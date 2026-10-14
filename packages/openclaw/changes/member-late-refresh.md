- FIX: After `removeAccount` on a member-agent account (`authLogout`), a late token refresh that rewrites
  `state/agents/<member>` is dropped on the next `prepare`: the orphan sweep now also removes member-store auth
  profiles (JSON and native store) whose provider no account index entry names, so a removed sign-in cannot come
  back while every remaining account stays.
