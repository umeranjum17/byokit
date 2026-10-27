- FEAT: Answer with a button on iOS: a notice whose `data.answer.choices` lists `{ id, label }` is answered by a plain
  button press with no typing and no JavaScript. The phone seals `{ action, choice, event, v: 2 }`; the host opens it
  with the new `openChoice` (`openAnswer` still opens only typed text, `v: 1`). Wire fixture and Swift/TS vectors updated first.
