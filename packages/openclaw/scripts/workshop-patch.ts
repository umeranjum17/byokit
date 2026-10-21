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
  { find: 'import { r as getRuntimeConfig } from "./io.runtime-FunTy0y1.mjs";\n',
    replace: 'import { r as getRuntimeConfig } from "./io.runtime-FunTy0y1.mjs";\nimport { openSync as byokitOpen, writeSync as byokitWrite, fsyncSync as byokitFsync, closeSync as byokitClose } from "node:fs";\nimport { join as byokitJoin } from "node:path";\n' },
  { find: 'async function runSkillExperienceReviewInner(candidate) {\n', replace: helper + 'async function runSkillExperienceReviewInner(candidate) {\n' },
  { find: '\tlet outcome;\n\tlet proposalId;\n\tlet usage;\n', replace: '\tlet outcome;\n\tlet proposalId;\n\tlet usage;\n\tlet byokitRunUsage;\n\tconst byokitFact = { chargeId: runId, agentId: foregroundPromptContext.agentId, kind: "workshop-review", provider: candidate.ctx.modelProviderId, model: candidate.ctx.modelId, ...candidate.ctx.authProfileId ? { authProfileId: candidate.ctx.authProfileId } : {}, startedAt: attemptedAtMs, origin: { sessionKey, ...candidate.ctx.runId ? { runId: candidate.ctx.runId } : {} } };\n' },
  { find: '\t\tconst embeddedResult = capability ? await runWithCronCreatorAuthorityCapability(capability, run) : await run();\n',
    replace: '\t\tbyokitUsageFact({ ...byokitFact, phase: "started", at: attemptedAtMs });\n\t\tconst embeddedResult = capability ? await runWithCronCreatorAuthorityCapability(capability, run) : await run();\n\t\tbyokitRunUsage = embeddedResult?.meta?.agentMeta?.usage;\n' },
  { find: '\t} catch (error) {\n\t\tawait recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {\n',
    replace: '\t} catch (error) {\n\t\tbyokitUsageFact({ ...byokitFact, phase: "ended", at: Date.now(), outcome: "failed", ...byokitRunUsage ? { usage: byokitRunUsage } : {} });\n\t\tawait recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {\n' },
  { find: '\t\tclearAgentRunContext(runId);\n\t}\n\tawait recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {\n',
    replace: '\t\tclearAgentRunContext(runId);\n\t}\n\tbyokitUsageFact({ ...byokitFact, phase: "ended", at: Date.now(), outcome, ...byokitRunUsage ? { usage: byokitRunUsage } : {} });\n\tawait recordSkillExperienceReviewOutcome(foregroundPromptContext.agentId, workspaceDir, {\n' },
];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const path = fileURLToPath(new URL('../engine/patches.json', import.meta.url));
const set = JSON.parse(readFileSync(path, 'utf8')) as PatchSet;
const stock = process.argv[2];
if (!stock || stock.startsWith('--')) throw new Error('Pass stock package directory installed from the shipped lock');
assert.equal(JSON.parse(readFileSync(join(stock, 'package.json'), 'utf8')).version, set.upstream.version);
assert.equal(JSON.parse(readFileSync(join(stock, 'dist/build-info.json'), 'utf8')).commit, set.upstream.commit);
assert.equal(readFileSync(join(stock, 'LICENSE'), 'utf8'), readFileSync(new URL('../engine/OPENCLAW-LICENSE', import.meta.url), 'utf8'));
const file: PatchFile = { path: 'dist/experience-review-ClLYopea.mjs', before: '', after: '', edits: workshopEdits };
const text = readFileSync(join(stock, file.path), 'utf8');
file.before = sha256(text);
assert.equal(file.before, '61abd547073af49bf5766c8e8679dd7e72089093edd4010cd5c4c50dde2ddd52', 'Stock pinned Workshop source changed');
file.after = sha256(editText(text, file));
const files = [...set.files.filter(f => f.path !== file.path), file].sort((a, b) => a.path.localeCompare(b.path));
const result = JSON.stringify({ ...set, id: patchId(files), files }, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), result);
else writeFileSync(path, result);
console.log(`Workshop seam ${patchId(files)}: stock ${file.before}, patched ${file.after}`);
}
