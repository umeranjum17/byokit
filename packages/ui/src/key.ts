/** A key-entry card never holds a credential: the host submits the input directly to kit.addKey.
 *  `workspace`: the key acts for several workspaces and nothing is saved yet; the host lists the kit's workspaces
 *  and submits again with the one picked. */
export type KeyState = 'entry' | 'checking' | 'workspace' | 'ok' | 'invalid' | 'not_included';
export type KeyAction = { type: 'submit' } | { type: 'edit' } | { type: 'result'; result: 'workspace' | 'ok' | 'invalid' | 'not_included' };
export type KeyWords = (key: 'key.label' | 'key.entry' | 'key.checking' | 'key.workspace' | 'key.ok' | 'key.invalid' | 'key.notIncluded') => string;

export function keyStep(state: KeyState, action: KeyAction): KeyState {
  if (action.type === 'submit') return 'checking';
  if (action.type === 'edit') return 'entry';
  return state === 'checking' ? action.result : state;
}

export function keyView(state: KeyState, words: KeyWords): {
  state: KeyState; label: string; message: string; busy: boolean; editable: boolean;
} {
  const keys = { entry: 'key.entry', checking: 'key.checking', workspace: 'key.workspace', ok: 'key.ok', invalid: 'key.invalid', not_included: 'key.notIncluded' } as const;
  return { state, label: words('key.label'), message: words(keys[state]), busy: state === 'checking',
    editable: state === 'entry' || state === 'invalid' };
}
