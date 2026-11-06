// Derive the Gateway Workshop seam from the shipped pin; preserves independently owned R1 entries.
// node packages/openclaw/scripts/workshop-patch.ts <stock-openclaw-package-dir> [--check]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editText, patchId, sha256, type PatchFile, type PatchSet } from '../src/engine-patches.ts';
const helper = `/** BYOKit R4-1: content-free durable Gateway Workshop facts, inert without kit env. */
function byokitUsageFact(fact) {
\tconst dir = process.env.BYOKIT_ENGINE_USAGE_LEDGER;
\tconst bootId = process.env.BYOKIT_ENGINE_BOOT;
\tif (!dir || !bootId) return;
\tconst key = Symbol.for("byokit.engine-usage.v1");
\tconst live = globalThis[key] ??= { bootId, months: {}, inFlight: {} };
\tconst month = new Date(fact.at).toISOString().slice(0, 7);
\tconst counter = live.months[month] ??= { lastSeq: 0, failed: 0 };
\tconst seq = ++counter.lastSeq;
\tif (fact.phase === "started") live.inFlight[fact.chargeId] = { startedAt: fact.startedAt };
\telse delete live.inFlight[fact.chargeId];
\ttry {
\t\tconst fd = byokitOpen(byokitJoin(dir, "engine-started-" + month + ".jsonl"), "a", 0o600);
\t\ttry {
\t\t\tconst line = Buffer.from(JSON.stringify({ v: 1, ...fact, bootId, seq }) + "\\n");
\t\t\tif (byokitWrite(fd, line) !== line.length) throw new Error("short accounting write");
\t\t\tbyokitFsync(fd);
\t\t} finally { byokitClose(fd); }
\t} catch { counter.failed++; }
}
`;
export const workshopEdits: PatchFile['edits'] = [
  { find: 'import { randomUUID } from "node:crypto";\n',
    replace: 'import { randomUUID } from "node:crypto";\nimport { openSync as byokitOpen, writeSync as byokitWrite, fsyncSync as byokitFsync, closeSync as byokitClose } from "node:fs";\nimport { join as byokitJoin } from "node:path";\n' },
  { find: 'async function runSkillExperienceReviewInner(candidate) {\n', replace: helper + 'async function runSkillExperienceReviewInner(candidate) {\n' },
  { find: '\t\ttry {\n\t\t\tassertSkillReviewRunSucceeded(capability ? await runWithCronCreatorAuthorityCapability(capability, run) : await run());\n\t\t} finally {\n',
    replace: '\t\tconst byokitStartedAt = Date.now();\n\t\tconst byokitFact = { chargeId: runId, agentId, kind: "workshop-review", provider: candidate.ctx.modelProviderId, model: candidate.ctx.modelId, ...candidate.ctx.authProfileId ? { authProfileId: candidate.ctx.authProfileId } : {}, startedAt: byokitStartedAt, origin: { sessionKey, ...candidate.ctx.runId ? { runId: candidate.ctx.runId } : {} } };\n\t\tlet byokitRunUsage;\n\t\tlet byokitOutcome = "failed";\n\t\tbyokitUsageFact({ ...byokitFact, phase: "started", at: byokitStartedAt });\n\t\ttry {\n\t\t\tconst byokitRun = capability ? await runWithCronCreatorAuthorityCapability(capability, run) : await run();\n\t\t\tbyokitRunUsage = byokitRun?.meta?.agentMeta?.usage;\n\t\t\tassertSkillReviewRunSucceeded(byokitRun);\n\t\t\tbyokitOutcome = "completed";\n\t\t} finally {\n\t\t\tbyokitUsageFact({ ...byokitFact, phase: "ended", at: Date.now(), outcome: byokitOutcome, ...byokitRunUsage ? { usage: byokitRunUsage } : {} });\n' },
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const path = fileURLToPath(new URL('../engine/patches.json', import.meta.url));
const set = JSON.parse(readFileSync(path, 'utf8')) as PatchSet;
const stock = process.argv[2];
if (!stock || stock.startsWith('--')) throw new Error('Pass stock package directory installed from the shipped lock');
assert.equal(JSON.parse(readFileSync(join(stock, 'package.json'), 'utf8')).version, set.upstream.version);
assert.equal(JSON.parse(readFileSync(join(stock, 'dist/build-info.json'), 'utf8')).commit, set.upstream.commit);
assert.equal(readFileSync(join(stock, 'LICENSE'), 'utf8'), readFileSync(new URL('../engine/OPENCLAW-LICENSE', import.meta.url), 'utf8'));
const file: PatchFile = { path: 'dist/experience-review-D4E30NcE.mjs', before: '', after: '', edits: workshopEdits };
const text = readFileSync(join(stock, file.path), 'utf8');
file.before = sha256(text);
assert.equal(file.before, 'afc6c16e2a8281fcca601275f9adc541ec78f1e0c4b1f67431ec8d88824635a9', 'Stock pinned Workshop source changed');
file.after = sha256(editText(text, file));
const files = set.files.map(f => f.path === file.path ? file : f);
if (!files.some(f => f.path === file.path)) files.push(file);
const result = JSON.stringify({ ...set, id: patchId(files), files }, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), result);
else writeFileSync(path, result);
console.log(`Workshop seam ${patchId(files)}: stock ${file.before}, patched ${file.after}`);
}
