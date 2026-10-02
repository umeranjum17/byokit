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
  { find: 'import { n as getRuntimeConfig } from "./io.runtime-CNGn9TXj.js";\n',
    replace: 'import { n as getRuntimeConfig } from "./io.runtime-CNGn9TXj.js";\nimport { openSync as byokitOpen, writeSync as byokitWrite, fsyncSync as byokitFsync, closeSync as byokitClose } from "node:fs";\nimport { join as byokitJoin } from "node:path";\n' },
  { find: 'async function runSkillExperienceReviewInner(candidate, deps) {\n', replace: helper + 'async function runSkillExperienceReviewInner(candidate, deps) {\n' },
  { find: '\tlet outcome;\n\tlet proposalId;\n\tlet usage;\n', replace: '\tlet outcome;\n\tlet proposalId;\n\tlet usage;\n\tlet byokitRunUsage;\n\tconst byokitFact = { chargeId: runId, agentId: foregroundPromptContext.agentId, kind: "workshop-review", provider: modelProviderId, model: modelId, startedAt: attemptedAtMs, origin: { sessionKey: foregroundSessionKey, ...candidate.ctx.runId ? { runId: candidate.ctx.runId } : {} } };\n' },
  { find: '\ttry {\n\t\tlet embeddedResult;\n', replace: '\tbyokitUsageFact({ ...byokitFact, phase: "started", at: attemptedAtMs });\n\ttry {\n\t\tlet embeddedResult;\n' },
  { find: '\t\t} finally {\n\t\t\tpreparedRunAdmission.close();\n\t\t}\n\t\tassertSkillReviewRunSucceeded(embeddedResult);\n', replace: '\t\t} finally {\n\t\t\tpreparedRunAdmission.close();\n\t\t}\n\t\tbyokitRunUsage = embeddedResult?.meta?.agentMeta?.usage;\n\t\tassertSkillReviewRunSucceeded(embeddedResult);\n' },
  { find: '\t} catch (error) {\n\t\trecordSkillExperienceReviewOutcome(workspaceDir, {\n', replace: '\t} catch (error) {\n\t\tbyokitUsageFact({ ...byokitFact, phase: "ended", at: Date.now(), outcome: "failed", ...byokitRunUsage ? { usage: byokitRunUsage } : {} });\n\t\trecordSkillExperienceReviewOutcome(workspaceDir, {\n' },
  { find: '\t} finally {\n\t\tclearAgentRunContext(runId);\n\t}\n\trecordSkillExperienceReviewOutcome(workspaceDir, {\n', replace: '\t} finally {\n\t\tclearAgentRunContext(runId);\n\t}\n\tbyokitUsageFact({ ...byokitFact, phase: "ended", at: Date.now(), outcome, ...byokitRunUsage ? { usage: byokitRunUsage } : {} });\n\trecordSkillExperienceReviewOutcome(workspaceDir, {\n' },
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const path = fileURLToPath(new URL('../engine/patches.json', import.meta.url));
const set = JSON.parse(readFileSync(path, 'utf8')) as PatchSet;
const stock = process.argv[2];
if (!stock || stock.startsWith('--')) throw new Error('Pass stock package directory installed from the shipped lock');
assert.equal(JSON.parse(readFileSync(join(stock, 'package.json'), 'utf8')).version, set.upstream.version);
assert.equal(JSON.parse(readFileSync(join(stock, 'dist/build-info.json'), 'utf8')).commit, set.upstream.commit);
assert.equal(readFileSync(join(stock, 'LICENSE'), 'utf8'), readFileSync(new URL('../engine/OPENCLAW-LICENSE', import.meta.url), 'utf8'));
const file: PatchFile = { path: 'dist/experience-review-default-6DPIIJds.js', before: '', after: '', edits: workshopEdits };
const text = readFileSync(join(stock, file.path), 'utf8');
file.before = sha256(text); file.after = sha256(editText(text, file));
const files = [...set.files.filter(f => f.path !== file.path), file].sort((a, b) => a.path.localeCompare(b.path));
const result = JSON.stringify({ ...set, id: patchId(files), files }, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), result);
else writeFileSync(path, result);
console.log(`Workshop seam ${patchId(files)}: stock ${file.before}, patched ${file.after}`);
}
