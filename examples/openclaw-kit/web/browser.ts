// The helper's browser on the phone: the "Sign in to {site}" sheet, the chip in the chat, and the live panel. Plain
// DOM, drawn only from @byokit/ui-core's views; `say` is the kit's own `words`. Nothing here keeps what the person
// types: keys and text go straight to `send`, which hands them to the lease-holding live stream.
import type { LivePanel, SignInAction, SignInSheet, SignInVars } from '@byokit/ui-core/kits';

export type Say = (key: string, vars?: Partial<SignInVars> & { note?: string }) => string;

const LABEL: Record<SignInAction, string> = {
  takeover: 'signin.takeover', notNow: 'signin.notNow', done: 'signin.done', cancel: 'signin.cancel',
  reopen: 'signin.reopen', retry: 'signin.retry',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

/**
 * One sign-in request as a card: the site, its full address, the helper's note as a quote, the sentence, and the
 * buttons. A first-time site asks the person to type it before Take over works.
 */
export function signInCard(sheet: SignInSheet, say: Say, act: (a: SignInAction, typedSite?: string) => void): HTMLElement {
  const title = el('p', { className: 'signin-title', textContent: say('signin.title', { site: sheet.site }) });
  const where = el('p', { className: 'origin', textContent: sheet.origin });
  if (!sheet.secure) where.classList.add('error');
  const kids: Node[] = [title, where];
  if (sheet.note) kids.push(el('blockquote', { textContent: say('signin.agentNote', { name: sheet.line.vars.name, note: sheet.note }) }));
  kids.push(el('p', { className: 'status', textContent: say(sheet.line.key, sheet.line.vars) }));
  let typed: HTMLInputElement | undefined;
  if (sheet.confirmSite && sheet.actions.includes('takeover')) {
    const id = `confirm-${sheet.id}`;
    typed = document.createElement('input');
    Object.assign(typed, { id, autocomplete: 'off', spellcheck: false, autocapitalize: 'none' });
    kids.push(el('label', { htmlFor: id, textContent: say('signin.confirmSite', sheet.line.vars) }), typed);
  }
  const buttons = sheet.actions.map((a, i) => el('button', {
    type: 'button', className: i === 0 ? 'primary' : '', textContent: say(LABEL[a]),
    onclick: () => act(a, a === 'takeover' ? typed?.value.trim() : undefined),
  }));
  if (buttons.length) kids.push(el('div', { className: 'choices' }, ...buttons));
  const card = el('li', { className: 'card signin' }, ...kids);
  card.dataset.id = sheet.id;
  return card;
}

/** The chip under the chat: "Sign-in details entered" until verified, then "Signed in to {site}". */
export function signInChip(sheet: SignInSheet, say: Say): HTMLElement | null {
  if (!sheet.chip) return null;
  const text = sheet.chip === 'verified' ? say('signin.verified', { site: sheet.site }) : say('signin.checking');
  return el('span', { className: `chip ${sheet.chip}`, textContent: `${text} ✓` });
}

/**
 * The live panel: frames on a canvas while live, a dimmed last frame under a sentence otherwise. In control it
 * forwards pointer and key input, and offers "Continue on {origin}" while paused on an unexpected address.
 */
export function livePanel(root: HTMLElement, say: Say, on: {
  input(i: { kind: 'pointer'; type: 'down' | 'up' | 'move'; x: number; y: number } | { kind: 'key'; type: 'down' | 'up'; key: string; code: string } | { kind: 'text'; text: string }): void;
  confirmOrigin(origin: string): void;
}) {
  const canvas = el('canvas', { className: 'live', tabIndex: 0 } as Partial<HTMLCanvasElement>);
  canvas.setAttribute('aria-label', say('live.label'));
  const line = el('p', { className: 'status', role: 'status' } as Partial<HTMLParagraphElement>);
  const confirm = el('button', { type: 'button', hidden: true });
  root.replaceChildren(canvas, line, confirm);
  const ctx = canvas.getContext('2d');
  let panel: LivePanel = { showFrames: false, input: false };
  let size = { w: 1, h: 1 };
  const at = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * size.w), y: Math.round(((e.clientY - r.top) / r.height) * size.h) };
  };
  for (const [name, type] of [['pointerdown', 'down'], ['pointerup', 'up'], ['pointermove', 'move']] as const) {
    canvas.addEventListener(name, (e) => { if (panel.input) on.input({ kind: 'pointer', type, ...at(e) }); });
  }
  for (const [name, type] of [['keydown', 'down'], ['keyup', 'up']] as const) {
    canvas.addEventListener(name, (e) => {
      if (!panel.input) return;
      e.preventDefault();
      on.input({ kind: 'key', type, key: e.key, code: e.code });
    });
  }
  canvas.addEventListener('paste', (e) => {
    if (!panel.input) return;
    e.preventDefault();
    on.input({ kind: 'text', text: e.clipboardData?.getData('text/plain') ?? '' });
  });
  return {
    state(next: LivePanel) {
      panel = next;
      canvas.classList.toggle('dim', !next.showFrames);
      line.textContent = next.line ? say(next.line.key) : '';
      confirm.hidden = !next.confirmOrigin;
      if (next.confirmOrigin) {
        const origin = next.confirmOrigin;
        confirm.textContent = say('signin.confirmOrigin', { origin });
        confirm.onclick = () => on.confirmOrigin(origin);
      }
    },
    async frame(f: { w: number; h: number; jpeg: Uint8Array }) {
      if (!panel.showFrames || !ctx) return;
      // A frame that doesn't decode is skipped; the next one replaces it.
      const image = await createImageBitmap(new Blob([f.jpeg as BlobPart], { type: 'image/jpeg' })).catch(() => null);
      if (!image) return;
      size = { w: f.w, h: f.h };
      if (canvas.width !== f.w || canvas.height !== f.h) { canvas.width = f.w; canvas.height = f.h; }
      ctx.drawImage(image, 0, 0);
      image.close();
    },
  };
}
