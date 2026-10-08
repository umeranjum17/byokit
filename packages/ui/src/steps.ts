// The rows a stepper or inline checks draw, shared by a terminal and a phone: each step keeps the id its caller
// chose, the state it is in, the plain words to show, and the one next action when it failed. Framework-free, so any
// UI draws the same rows: a CLI prints them with stepsText, a phone draws them in its own list.
export type StepState = 'todo' | 'checking' | 'ok' | 'failed';

/** One step as its caller reports it: `label` names the check ("Agent runner"), `detail` says how it stands
 *  ("ready", "not installed on this computer"), and `fix` is the one next action when it fails. Ids are the
 *  caller's own; nothing here knows any app's steps. */
export type StepInput = { id: string; state: StepState; label: string; detail?: string; fix?: string };

/** One row to draw: `words` is the plain sentence, `fix` the next action ("" until the step fails). */
export type StepRow = { id: string; state: StepState; words: string; fix: string };

/** Turn the caller's steps into the rows to draw, in order. A failed step without its own `fix` says "Try again." */
export function stepsView(steps: StepInput[]): StepRow[] {
  return steps.map((s) => ({
    id: s.id,
    state: s.state,
    words: s.detail ? `${s.label}: ${s.detail}` : s.label,
    fix: s.state === 'failed' ? (s.fix || 'Try again.') : '',
  }));
}

const mark: Record<StepState, string> = { ok: '✓', checking: '…', todo: '○', failed: '✗' };

/** The same rows as text lines for a terminal: `✓` done, `…` checking, `○` waiting, `✗` failed with its fix.
 *  A phone draws the rows itself; this keeps the terminal showing the same words. */
export function stepsText(rows: StepRow[], opts?: { title?: string }): string {
  const lines = rows.map((r) => `  ${mark[r.state]} ${r.words}${r.state === 'failed' && r.fix ? ` ${r.fix}` : ''}`);
  return opts?.title ? `${opts.title}\n${lines.join('\n')}` : lines.join('\n');
}
