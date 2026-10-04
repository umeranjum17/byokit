// Offline extraction from the exact v0.9.1 source excerpts; no installed CLI is inspected.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AccountKind } from '../src/kinds.ts';

const input = new URL('../schema/kinds-0.9.1/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, input), 'utf8');
const provenance = JSON.parse(read('provenance.json')) as { version: string; revision: string };

export function generateKinds(): AccountKind[] {
  const detect = read('mod-detect.rs');
  const env = read('env.rs');
  const resume = read('agent_resume.rs');
  const labels = [...detect.matchAll(/Agent::(\w+) => "([^"]+)"/g)];
  const constants = new Map([...env.matchAll(/const (\w+): &str = "([^"]+)"/g)].map((m) => [m[1], m[2]!]));
  const rows = labels.map(([, variant, kind]): AccountKind => {
    assert.ok(kind);
    const aliasLine = detect.split('\n').find((line) => line.includes(`Some(Agent::${variant})`));
    assert.ok(aliasLine);
    const aliases = [...aliasLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((name) => name !== kind);
    const functionName = kind === 'agy' ? 'antigravity_cli' : kind;
    const folderBody = env.split(`fn ${functionName}_`)[1]?.split('\npub(crate) fn ')[0] ?? '';
    // Both Pi-family CLIs honor the direct agent-dir override. PI_CONFIG_DIR is a
    // home-relative config name for omp, not an absolute account folder.
    const constant = kind === 'pi' || kind === 'omp' ? 'PI_CODING_AGENT_DIR_ENV_VAR'
      : kind === 'grok' ? 'GROK_HOME_ENV_VAR'
      : /config_dir_from_env_or_home\((\w+)/.exec(folderBody)?.[1]
        ?? /var_os\((HERMES_HOME_ENV_VAR)\)/.exec(folderBody)?.[1];
    const folderVar = constant === undefined ? undefined : constants.get(constant);
    const plan = new RegExp(`\\("([^"]+)", "${kind}", AgentSessionRefKind::([^)]*)\\) => \\{([\\s\\S]*?)(?=\\n        \\("|\\n        _ =>)`).exec(resume);
    const sessionKinds: ('id' | 'path')[] = plan === null ? [] : plan[2]!.includes('Path') ? ['id', 'path'] : ['id'];
    const args = plan === null || kind === 'letta' ? undefined
      : [...plan[3]!.matchAll(/"(--[^"]+|resume)"\.into\(\)|session_ref\.value\.clone\(\)|format!\("([^"]+)", session_ref\.value\)/g)]
        .map((m) => m[1] ?? m[2]?.replace('{}', '{session}') ?? '{session}');
    if (folderVar !== undefined) assert.ok(args?.length, `missing resume args for ${kind}`);
    return { kind, aliases, ...(kind === 'muse' ? { aliasPattern: '^muse-bin-[0-9]' } : {}),
      ...(folderVar === undefined ? {} : { folderVar }), resume: plan !== null, sessionKinds,
      ...(args === undefined ? {} : { resumeArgs: args }),
      loginLabel: folderVar === undefined ? 'One sign-in per computer user' : 'Sign in to this account on this computer',
      billing: 'unknown', offer: 'explicit',
      upstream: { version: provenance.version, revision: provenance.revision, source: 'src/detect/mod.rs; src/integration/env.rs; src/agent_resume.rs' } };
  });
  assert.equal(rows.length, 24);
  assert.equal(rows.filter((r) => r.folderVar).length, 12);
  assert.equal(rows.filter((r) => r.resume).length, 18);
  return rows.sort((a, b) => a.kind.localeCompare(b.kind, 'en'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('../src/kinds.json', import.meta.url), JSON.stringify(generateKinds(), null, 2) + '\n');
}
