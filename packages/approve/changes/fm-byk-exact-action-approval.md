- FEAT: New kit: `Approvals` raises a request naming its action, button label, app and reason, and mints a grant
  when the person presses that request's button; `authorizeApproval(grant, request)` is a pure exact-match check
  refusing a different or mutated request (`action`/`button`/`app`/`reason`), a later raise of the same words
  (`stale-identity`) or a past deadline (`expired`), with supersession and unknown-id refusals on `approve`. No
  dependencies; Node 22+, browsers and React Native.
