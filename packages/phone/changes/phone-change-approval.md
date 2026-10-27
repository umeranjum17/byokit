- FEAT: `session.onChange(fn)` reports every move of the chat (turn started, step kept, tool started or ended, turn done,
  failed or cut off) with the turn and the session status, and returns the way to stop. A `PhoneTool` with
  `approval: { button, reason }` waits for the session's new `ask(approval)` before it runs: the tool reads `asking` and
  the session `blocked` while it waits, a no reaches the model as declined, and the answer is kept so a turn cut off
  while asking asks again and one cut off after the answer does not.
