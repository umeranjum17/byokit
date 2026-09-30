#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { checkWerRegression } from '../../dist/wer.js';
const [reportPath, baselinePath] = process.argv.slice(2);
if (!reportPath || !baselinePath) throw new Error('usage: gate.mjs report.json baseline.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const required = ['default', 'application-vocabulary'];
const missing = required.filter(id => !report.profiles.some(p => p.id === id));
if (missing.length) throw new Error(`Missing measured profiles: ${missing.join(', ')}`);
const errors = checkWerRegression(report, baseline, 0.01);
for (const p of report.profiles) console.log(`${p.id}: ${(p.summary.wer * 100).toFixed(2)}% WER, ${Math.round(p.summary.medianWaitMs)} ms median warm inference`);
if (errors.length) throw new Error(errors.join('\n'));
console.log('WER regression gate passed (1 absolute percentage point tolerance).');
