// Claude wire names for the CLI Tooling list (ch-cli-tool-prefix): the Claude CLI/SDK wire
// catalog exposes OpenClaw tools as mcp__openclaw__<name>, while the stock CLI prompt prints
// the bare backend names under its "call exact" instruction. This single Claude-scoped edit
// rewrites only that printed list, where the backend is known (isClaudeCli). Every other route
// keeps the stock prompt byte-identical; already-prefixed names are never prefixed again.
import type { PatchFile } from '../src/engine-patches.ts';

export const CLAUDE_TOOL_PREFIX_PATH = 'dist/prepare.runtime-y2eXKhY3.js';

const find =
  'let systemPrompt = !skipsTurnPreparation ? backendResolved.transformSystemPrompt?.({\n' +
  '\t\t\tconfig: params.config,\n' +
  '\t\t\tworkspaceDir,\n' +
  '\t\t\tprovider: params.provider,\n' +
  '\t\t\tmodelId,\n' +
  '\t\t\tmodelDisplay,\n' +
  '\t\t\tagentId: sessionAgentId,\n' +
  '\t\t\tsystemPrompt: builtSystemPrompt\n' +
  '\t\t}) ?? builtSystemPrompt : builtSystemPrompt;\n';

const block =
  '\t\t// BYOKit: Claude wire names for the Tooling list (ch-cli-tool-prefix). The Claude wire catalog\n' +
  '\t\t// exposes OpenClaw tools as mcp__openclaw__<name>, so the printed Tooling list on that route must\n' +
  '\t\t// use those exact names. Every other route keeps the stock prompt byte-identical; already-prefixed\n' +
  '\t\t// names are never prefixed again. Order, summaries and error semantics are unchanged.\n' +
  '\t\tif (!skipsTurnPreparation && isClaudeCli && promptTools.length > 0) {\n' +
  '\t\t\tconst byokitBareNames = new Set(promptTools.map((tool) => tool?.name).filter((name) => typeof name === "string" && name.length > 0 && !name.startsWith("mcp__openclaw__")));\n' +
  '\t\t\tif (byokitBareNames.size > 0) {\n' +
  '\t\t\t\tconst byokitLines = systemPrompt.split("\\n");\n' +
  '\t\t\t\tlet byokitInTooling = false;\n' +
  '\t\t\t\tlet byokitToolingArmed = false;\n' +
  '\t\t\t\tfor (let byokitI = 0; byokitI < byokitLines.length; byokitI++) {\n' +
  '\t\t\t\t\tconst byokitLine = byokitLines[byokitI];\n' +
  '\t\t\t\t\tif (byokitLine.startsWith("## ")) {\n' +
  '\t\t\t\t\t\tbyokitInTooling = byokitLine === "## Tooling";\n' +
  '\t\t\t\t\t\tbyokitToolingArmed = false;\n' +
  '\t\t\t\t\t} else if (byokitInTooling && !byokitToolingArmed) {\n' +
  '\t\t\t\t\t\tif (byokitLine === "Tools policy-filtered. Names case-sensitive; call exact.") byokitToolingArmed = true;\n' +
  '\t\t\t\t\t} else if (byokitInTooling && byokitToolingArmed && byokitLine.startsWith("- ")) {\n' +
  '\t\t\t\t\t\tconst byokitMatch = /^- (\\S+?)(:.*)?$/.exec(byokitLine);\n' +
  '\t\t\t\t\t\tif (byokitMatch && byokitBareNames.has(byokitMatch[1])) byokitLines[byokitI] = `- mcp__openclaw__${byokitMatch[1]}${byokitMatch[2] ?? ""}`;\n' +
  '\t\t\t\t\t}\n' +
  '\t\t\t\t}\n' +
  '\t\t\t\tsystemPrompt = byokitLines.join("\\n");\n' +
  '\t\t\t}\n' +
  '\t\t}\n';

export const claudeToolPrefixEdits: PatchFile['edits'] = [{ find, replace: find + block }];
