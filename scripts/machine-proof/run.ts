import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dryRun } from './dry-run.ts';
import { liveRun, type LiveConfig } from './live.ts';
import { markdown, type Report } from './proof.ts';

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const dry = args.includes('--dry-run');
const live = args.includes('--live');
if (dry === live || (live && !value('--config'))) throw new Error('Use --dry-run, or --live --config <app lab module.ts>. --live authorizes billable lab operations.');
const output = resolve(value('--output') ?? '.lab/m6-report.json');
const { mkdir } = await import('node:fs/promises');
await mkdir(resolve(output, '..'), { recursive: true });
const record = async (report: Report) => {
  // Atomic replacement: interrupted runs leave the previous complete checkpoint readable.
  await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(`${output}.tmp`, output);
};
let report: Report;
if (dry) report = await dryRun(record);
else {
  const module = await import(pathToFileURL(resolve(value('--config')!)).href) as { default: LiveConfig };
  report = await liveRun(module.default, record);
}
// Opt-in recorded section update. Never marks a simulated run as a real proof.
if (args.includes('--record-doc')) {
  const path = resolve('docs/cloud-kit.md');
  const doc = await readFile(path, 'utf8');
  const marker = '**M7 — sleep and wake**';
  if (!doc.includes(marker)) throw new Error('M6 section boundary missing');
  await writeFile(path, doc.replace(marker, `${markdown(report)}\n${marker}`));
}
process.stdout.write(`M6 ${report.mode}: ${report.results.length} recorded checks; qualified=${report.complete}; ${output}\n`);
if (report.results.some(r => r.status === 'fail') || (live && !report.complete)) process.exitCode = 1;
