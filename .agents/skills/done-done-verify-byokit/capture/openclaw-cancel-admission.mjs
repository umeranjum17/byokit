// Cancel a sign-in, then sign in again at once: the next start is admitted, never `busy` (docs/runtime-kits.md 5.7).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';

const scratch = process.env.CANCEL_SCRATCH;
assert.ok(scratch, 'CANCEL_SCRATCH names the exclusive scratch dir');
// OpenRouter's code sign-in builds its authorize URL locally, so the journey stays offline until a paste.
const kit = new OpenClawKit({ stateDir: join(scratch, 'state'),
  engineDir: process.env.BYOKIT_TEST_ENGINE_DIR ?? join(scratch, 'engine'), offered: ['openrouter'] });
const t0 = Date.now();
const log = (label, value) => console.log(JSON.stringify({ ms: Date.now() - t0, label, ...value }));
const bare = (view) => (view.url ? { ...view, url: new URL(view.url).origin + new URL(view.url).pathname } : view);
async function until(fn, what) {
  const end = Date.now() + 120_000;
  while (!fn()) { assert.ok(Date.now() < end, `timed out waiting for ${what}`); await delay(20); }
}
const start = (name) => {
  const views = [];
  let shown;
  const first = new Promise((resolve) => { shown = resolve; });
  const handle = kit.signIn('m1', { authChoice: 'openrouter-oauth', via: 'code' }, (view) => {
    views.push(view);
    log(`${name} view`, { view: bare(view) });
    shown();
  });
  return { views, handle, first };
};

try {
  await kit.start();
  log('ready', { engine: ENGINE_VERSION, entry: import.meta.resolve('@byokit/openclaw'), phase: kit.state.phase });
  const first = start('first');
  await until(() => first.views.some((view) => view.prompt), 'the first sign-in to ask for the pasted code');
  // Error case: the engine has one setup admission, so a sign-in started while the first one waits is refused.
  const rival = await start('rival').handle.done;
  assert.equal(rival.why, 'busy', `a second sign-in during the first is busy: ${JSON.stringify(rival)}`);
  const cancelAt = Date.now();
  first.handle.cancel();
  const cancelled = await first.handle.done;
  const doneAt = Date.now();
  log('first done', { view: cancelled, cancelToDoneMs: doneAt - cancelAt });
  assert.equal(cancelled.why, 'declined');
  // No retry and no wait: the next sign-in starts the moment done settles.
  const again = start('again');
  await again.first;
  log('again answered', { doneToViewMs: Date.now() - doneAt });
  assert.equal(again.views[0].state, 'waiting', `the next sign-in is admitted: ${JSON.stringify(again.views[0])}`);
  assert.ok(again.views[0].url?.startsWith('https://openrouter.ai/'), 'it shows its own authorize URL');
  again.handle.cancel();
  assert.equal((await again.handle.done).why, 'declined');
  console.log('CANCEL-ADMISSION OK');
} finally {
  await kit.stop();
}
