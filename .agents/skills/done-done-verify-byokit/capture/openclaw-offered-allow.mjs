import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';

// File-backed config surface: no gateway, no sockets, but keep the same short-path convention as the other captures.
const defaultsDir = mkdtempSync('.verify-artifacts/offered-defaults-');
const offeredDir = mkdtempSync('.verify-artifacts/offered-');
const allow = (dir) => JSON.parse(readFileSync(join(dir, 'openclaw', 'openclaw.json'), 'utf8')).plugins.allow;
try {
  const defaults = new OpenClawKit({ stateDir: defaultsDir, spawnEngine: false });
  const offered = new OpenClawKit({ stateDir: offeredDir, spawnEngine: false,
    offered: ['chatgpt', 'grok', 'copilot', 'openrouter'] });
  await defaults.prepare();
  await offered.prepare();

  const defaultsAllow = allow(defaultsDir);
  const offeredAllow = allow(offeredDir);
  console.log('defaults-only plugins.allow:', JSON.stringify(defaultsAllow));
  console.log('offered plugins.allow:', JSON.stringify(offeredAllow));

  assert.ok(!defaultsAllow.includes('openrouter'), 'a defaults-only consumer must not allow OpenRouter');
  assert.ok(offeredAllow.includes('openrouter'), 'the offered OpenRouter sign-in must be allowed');
  // Routes nobody offers stay out of either list.
  for (const plugin of ['litellm', 'clawrouter', 'copilot-proxy', 'fal', 'amazon-bedrock']) {
    assert.ok(!defaultsAllow.includes(plugin));
    assert.ok(!offeredAllow.includes(plugin));
  }
  console.log('OFFERED-ALLOW OK');
} finally {
  rmSync(defaultsDir, { recursive: true, force: true });
  rmSync(offeredDir, { recursive: true, force: true });
}
