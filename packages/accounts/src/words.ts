// Every sentence a person can see, in one file other languages can read too (words.json). Plain words only: no codes,
// commands, paths, model ids or percentages; test/words.test.ts holds the line.
import WORDS from './words.json' with { type: 'json' };

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled. */
export const say = (key: WordKey, slots: Record<string, string> = {}) => WORDS[key].replace(/\{(\w+)\}/g, (_, k) => slots[k] ?? '');

/** "3:40pm", or "Fri 3:40pm" when it isn't today. */
export const clock = (t: number) => (new Date(t).toDateString() === new Date().toDateString() ? '' : new Date(t).toLocaleDateString('en-US', { weekday: 'short' }) + ' ') +
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

/** Why a sign-in failed, from the engine's own error. */
export type Why = 'expired' | 'declined' | 'offline' | 'deviceCodeOff' | 'busy' | 'tooLong' | 'failed';
export function failure(error: string): Why {
  if (/token exchange failed|missing fields|accountId/i.test(error)) return 'failed'; // said yes on the page, refused after
  if (/expired|expire/i.test(error)) return 'expired';
  if (/denied|declined|access_denied|rejected|cancel/i.test(error)) return 'declined';
  if (/fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONN|timed? ?out|socket/i.test(error)) return 'offline';
  if (/device code.*(disabled|not enabled)|enable device/i.test(error)) return 'deviceCodeOff';
  return 'failed';
}

/** A failed sign-in in one plain sentence with one next step. */
export const signInError = (name: string, error: string) => say(`signIn.${failure(error)}`, { name });

/** The app's own page for the browser tab a provider sends back: it says how it really went, never "success" before it is. */
export const callbackPage = (title: string, words: string, close = false) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  `<title>${title.replace(/[<&]/g, '')}</title><body style="font:18px system-ui;margin:3em auto;max-width:26em;padding:0 1em;text-align:center;color:#2e2a40">${words.replace(/[<&]/g, '')}` +
  (close ? '<script>setTimeout(() => window.close(), 1500)</script>' : '') + '</body>';
