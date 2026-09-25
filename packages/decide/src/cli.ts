#!/usr/bin/env node
// byokit-eval <file.jsonl>... [--floor N] [--max-clear-wrong RATE] [--live typesafe|openrouter [--record]]
// Offline by default: replays each case's recorded Jev answer. --live asks Jev with the key the person running it put in
// TYPESAFE_API_KEY (or OPENROUTER_API_KEY with --live openrouter), and --record writes the answers back into the file.
// Exits 1 when a file's clear-but-wrong rate is above --max-clear-wrong (default 0).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decide, jev, type Answer } from './index.ts';
import { evaluate, format, parse, replay, summary, type Case } from './eval.ts';

const { values: o, positionals: files } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { floor: { type: 'string' }, 'max-clear-wrong': { type: 'string', default: '0' }, live: { type: 'string' }, record: { type: 'boolean' } },
    });
  } catch {
    console.error('invalid arguments');
    process.exit(2);
  }
})();
const validRate = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
if (!files.length || (o.live && o.live !== 'typesafe' && o.live !== 'openrouter') ||
    (o.floor !== undefined && !validRate(o.floor)) || !validRate(o['max-clear-wrong'])) {
  console.error('usage: byokit-eval <file.jsonl>... [--floor N] [--max-clear-wrong RATE] [--live typesafe|openrouter [--record]]');
  process.exit(2);
}
const via = o.live as 'typesafe' | 'openrouter' | undefined;
const key = via && process.env[via === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY'];
if (via && !key) {
  console.error(`--live ${via} needs ${via === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY'} set for this one command`);
  process.exit(2);
}

let failed = false;
for (const path of files) {
  const f = parse(readFileSync(path, 'utf8'));
  const q = o.floor ? { ...f.question, floor: Number(o.floor) } : f.question;
  let ask = replay(q);
  let refreshed = 0;
  if (via && key) {
    let last: unknown;
    // Keeps Jev's own answer for --record; the key stays inside jev().
    const keep: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      last = res.ok ? (await res.clone().json())?.answers?.[f.decision] : undefined;
      return res;
    };
    const backend = jev({ key, via, fetch: keep });
    ask = async (c: Case): Promise<Answer> => {
      last = undefined;
      const a = (await decide(c.state, { [f.decision]: q }, { privacy: 'may-leave', backends: [backend] }))[f.decision];
      if (o.record && a.probabilities) {
        Object.assign(c, { jev: last, ms: a.ms });
        refreshed++;
      }
      return a;
    };
  }
  const r = await evaluate(f.cases, ask);
  console.log(summary(`${path}: ${f.decision}`, via ? `jev via ${via}` : 'jev, recorded', r));
  if (via && o.record && refreshed) writeFileSync(path, format({ ...f, note: refreshed === f.cases.length
    ? `answers recorded live from Jev via ${via}, ${new Date().toISOString().slice(0, 10)}`
    : `partial live refresh ${refreshed}/${f.cases.length} via ${via}; ${f.note ?? 'previous provenance unknown'}` }));
  if (r.cases && r.clearWrong / r.cases > Number(o['max-clear-wrong'])) failed = true;
}
process.exit(failed ? 1 : 0);
