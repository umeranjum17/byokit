# Quiet-hours hold and transport failure coverage

- Added `quietHours: { start, end }` (UTC `HH:MM`, overnight windows wrap midnight):
  notifications inside the window are held and delivered in order when it ends;
  `urgency: 'high'` always sends at once. `notify()` reports `{ held: true }`.
- Push delivery failures (service 500, unreachable service) lose the one
  notification, never the subscription, so the retry after recovery still sends.
- `findHost` failure paths report a wrong code, an unreachable relay, and a
  forged address distinctly.
