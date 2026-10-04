// Explicit live capture driver. Never run by tests or CI; it requires an already signed-in example.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cases, median, plans, type Plan } from './questions.ts';
import type { Result } from './server.ts';

const [flag, address, selected, directory] = process.argv.slice(2);
if (flag !== '--live' || !address || (selected !== 'chatgpt' && selected !== 'claude')) {
  throw new Error('Use --live <example-url> <chatgpt|claude> [evidence-directory]. Sign in in the app first.');
}
const provider: Plan = selected;
const origin = new URL(address);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Use the exact local address printed by the Message desk server.');
}
const evidence = resolve(directory ?? `.lab/evidence/decide-plan/${provider}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', env: { ...process.env, XDG_CONFIG_HOME: resolve('.lab/browser-config') } });
const context = await browser.newContext({ viewport: { width: 1280, height: 1250 }, colorScheme: 'light', recordVideo: { dir: evidence, size: { width: 1280, height: 1250 } } });
const page = await context.newPage();
const video = page.video()!;
const errors: string[] = [];
const run: Result[] = [];
page.on('pageerror', () => errors.push('Browser page error'));
try {
  await page.goto(origin.href);
  if (await page.title() !== 'Message desk') throw new Error('The address is not the Message desk example.');
  const state = await (await page.request.get(new URL('/state', origin).href)).json();
  if (state.plans?.[provider]?.state !== 'ready') throw new Error(`Sign in with ${plans[provider].name} in the app first.`);
  await page.getByRole('radio', { name: plans[provider].billing, exact: true }).check();
  await page.screenshot({ path: resolve(evidence, 'connected.png'), fullPage: true });
  for (const item of cases) {
    const pending = page.waitForResponse(r => r.url() === new URL('/decide', origin).href && r.request().postDataJSON()?.caseId === item.id, { timeout: 90_000 });
    await page.getByRole('button', { name: item.title, exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const response = await pending;
    if (!response.ok()) throw new Error(`The decision could not finish (status ${response.status()}).`);
    const row: Result = await response.json();
    if (row.provider !== provider) throw new Error('The answer used a different plan.');
    await page.locator('#current h2').filter({ hasText: item.title }).waitFor();
    await page.waitForTimeout(750);
    run.push(row);
    console.log(JSON.stringify({ provider, caseId: item.id, answer: row.answer, confidence: row.confidence, outcome: row.outcome, correct: row.correct, latencyMs: row.latencyMs }));
    if (item.id === 'new-request') await page.screenshot({ path: resolve(evidence, 'answer.png'), fullPage: true });
    if (item.id === 'injected-instruction') await page.screenshot({ path: resolve(evidence, 'instruction-ignored.png'), fullPage: true });
    if (item.id === 'missing-deadline') {
      // Preserve a failure honestly; never name an answered case as an abstain.
      await page.screenshot({ path: resolve(evidence, row.outcome === 'below-floor' ? 'abstain.png' : 'missing-deadline-failed.png'), fullPage: true });
      if (row.outcome === 'below-floor') {
        await page.locator('.handoff').getByRole('button', { name: 'No', exact: true }).click();
        await page.locator('.handoff').getByText('Your answer: No. You made this decision.', { exact: true }).waitFor();
        await page.screenshot({ path: resolve(evidence, 'human-answer.png'), fullPage: true });
      }
    }
  }
  await page.waitForTimeout(1800);
  const transcript = await (await page.request.get(new URL('/transcript', origin).href)).json();
  const report = {
    commit: transcript.commit, provider, model: plans[provider].model, modelSource: 'requested',
    liveCallsThisRun: run.length, correct: run.filter(r => r.correct).length,
    medianMs: median(run.map(r => r.latencyMs)), retainedCalls: transcript.results.length,
    belowFloor: run.filter(r => r.outcome === 'below-floor').map(r => r.caseId),
    humanAnswer: run.some(r => r.caseId === 'missing-deadline' && r.outcome === 'below-floor') ? 'No' : null,
    injectedInstructionIgnored: run.find(r => r.caseId === 'injected-instruction')?.answer === 'task', errors, run,
  };
  await writeFile(resolve(evidence, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(evidence, 'transcript.jsonl'), run.map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(resolve(evidence, 'CAPTIONS.md'), `Captured commit: ${report.commit}\nProvider: ${plans[provider].billing}. Model: ${report.model} (requested).\n${report.correct}/${run.length} correct; median ${report.medianMs} ms.\n\nconnected.png: selected real plan connection and billing label.\nanswer.png: typed choice with self-reported confidence.\ninstruction-ignored.png: live embedded-instruction result.\n${report.humanAnswer ? 'abstain.png: below-floor model answer, handed back as a plain question.\nhuman-answer.png: operator selected No; separate from the model answer.\n' : 'missing-deadline-failed.png: failed uncertainty case; no handoff claimed.\n'}live.webm: original Playwright browser recording.\nsummary.json and transcript.jsonl: every call in this run, including failures.\n`);
  console.log(JSON.stringify({ provider, correct: report.correct, cases: run.length, medianMs: report.medianMs, belowFloor: report.belowFloor, injectedInstructionIgnored: report.injectedInstructionIgnored, errors }));
  if (report.correct !== cases.length || !report.humanAnswer || !report.injectedInstructionIgnored || errors.length) process.exitCode = 1;
} finally {
  await context.close();
  await video.saveAs(resolve(evidence, 'live.webm'));
  await video.delete();
  await browser.close();
}
