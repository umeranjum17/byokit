// Lab-only consumer: the subscription stays on the phone; the cloud host holds only its own pairing keys.
import { type Accounts, type AnthropicToolUse } from '@byokit/accounts';
import type { DeviceLink } from '@byokit/pair';
import type { HostRecipe } from '@byokit/cloud';
export const M6_KEY = 'byokit.m6.provider';
export const M6_API = 'https://boat.dev/api/v1';
export function trialBudget(l: Record<string, any>, count: number, now = Date.now()) {
  if (l.teamId || l.sandboxPlanKey !== 'trial' || l.sandboxPlanDollars !== 0 || l.billingStatus !== 'trialing' ||
      l.subscriptionStatus !== 'trialing' || l.hasPaymentHistory !== false || l.unlimited !== false ||
      l.packBalanceSeconds !== 0 || l.creditPurchasedSeconds !== 0) throw new Error('A free personal trial is required.');
  for (const k of ['subscriptionQuotaSeconds', 'subscriptionRemainingSeconds', 'creditBalanceSeconds', 'creditSecondsPerDollar', 'creditUsedSeconds', 'liveUsageSeconds', 'activeSandboxes', 'maxActiveSandboxes'])
    if (!Number.isFinite(l[k]) || l[k] < 0) throw new Error(`Cannot establish trial allowance: ${k}.`);
  const remaining = Math.min(l.subscriptionRemainingSeconds, l.creditBalanceSeconds), rate = l.creditSecondsPerDollar;
  if (!rate || l.subscriptionRemainingSeconds > l.subscriptionQuotaSeconds || Math.min(remaining, 10 * rate) < 8100 ||
      Date.parse(l.subscriptionTrialEndsAt) - now < 8100000 || !Number.isFinite(Date.parse(l.subscriptionTrialEndsAt))) throw new Error('Not enough free trial time for setup and safe stop.');
  if (!l.canStart || !Number.isInteger(count) || count < 0 || count + 1 > 2 || l.activeSandboxes >= l.maxActiveSandboxes)
    throw new Error('The trial machine limit would be exceeded.');
  for (const period of ['minute', 'hour', 'day']) if (!(l.starts?.[period]?.remaining > 0)) throw new Error(`No confirmed ${period} start allowance.`);
  return { remaining, rate, budget: Math.min(remaining, 10 * rate), warn: 10 * rate, stop: 15 * rate };
}
export const M6_HOST = `import { WebSocketServer } from 'ws';
import { hostname, platform } from 'node:os';
import { writeFileSync } from 'node:fs';
import { Host, keyPair } from '@byokit/pair';
let paired = false, turns = 0;
const host = await Host.open({ keys: keyPair(), name: "Umer's cloud computer",
 confirm: p => { if (paired) return false; paired = true; writeFileSync('paired.json', JSON.stringify({ words: p.words }), { mode: 384 }); return true; },
 handle: r => { if (r.op !== 'get.state' || turns) throw new Error('Only one machine-state tool call is allowed.');
 const result = { machine: hostname(), platform: platform(), toolCalls: ++turns };
 writeFileSync('turn.json', JSON.stringify(result), { mode: 384 }); return result; } });
const server = new WebSocketServer({ host: '127.0.0.1', port: 7300 });
server.on('connection', ws => host.accept(ws));
server.on('listening', () => writeFileSync('offer.json', JSON.stringify(host.offer({ role: 'control',
 urls: ['ws://127.0.0.1:7300'] })), { mode: 384 }));
process.on('SIGTERM', () => { writeFileSync('stopped.json', JSON.stringify({ turns }), { mode: 384 }); process.exit(0); });
`;
/** The lab host on the machine's loopback only: the phone reaches it through an SSH forward, never a tailnet or a public port. */
export function cloudRecipe(name: string): HostRecipe {
  return { name, workDir: '/home/user/byokit-m6', node: { version: '22.22.3', sha256: {
    'linux-x64': '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f',
    'linux-arm64': '1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7' } },
    install: [['npm', 'install', '--no-audit', '--no-fund', '--save-exact', '@byokit/pair@0.9.0', 'ws@8.22.0'],
      ['node', '-e', `require('node:fs').writeFileSync('host.mjs', ${JSON.stringify(M6_HOST)}, {mode:384})`]],
    run: { argv: ['node', '/home/user/byokit-m6/host.mjs'], env: {} } };
}
const prompt = 'Use get_machine to check my cloud computer, then greet Umer and summarize its operating system in one sentence.';
const schema = { type: 'object' as const, properties: { input: { type: 'string', maxLength: 512 } }, required: ['input'], additionalProperties: false };
const checked = (args: unknown) => {
  const a = args as Record<string, unknown> | null;
  if (typeof a?.input !== 'string' || a.input.length > 512 || Object.keys(a).some(k => k !== 'input')) throw new Error('The machine tool arguments were invalid.');
};
/** One agent turn: the model calls the one machine-state tool, the paired cloud host answers it, and the model replies. */
// Names the turn step that failed (the error keeps its safe message, status and reason).
const step = <T>(call: string, run: () => Promise<T>) => run().catch((e: unknown) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { call }); });
/** Stop and remove the run's machine. The Boat key is purged only once removal is confirmed: it is the only way to retry. */
export async function stopAndRemove(steps: { remove: () => Promise<void>; purge: () => Promise<void> }) {
  try { await steps.remove(); }
  catch (e) { throw new Error(`Removing the cloud computer failed; the lab key is kept so Stop and remove can retry. (${(e as Error)?.message ?? e})`); }
  await steps.purge();
}
/** The lab's diagnostic line: which call, HTTP status, kind and reason, never a message body or credential. */
export const diagnostic = (e: unknown) => {
  const x = (e ?? {}) as { call?: unknown; status?: unknown; kind?: unknown; reason?: unknown; name?: unknown };
  const safe = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^[A-Za-z0-9 _.-]{1,64}$/.test(v)) ? v : undefined;
  const detail = typeof (x as { detail?: unknown }).detail === 'string' ? (x as { detail: string }).detail.slice(0, 300) : undefined; // already credential-redacted by the kit
  return 'M6 diagnostic ' + JSON.stringify({ call: safe(x.call), status: safe(x.status), kind: safe(x.kind), reason: safe(x.reason) ?? safe(x.name), detail });
};
const ask = { provider: 'claude' as const, model: 'claude-opus-5-5', max_tokens: 1024 }; // the lab's own pick: the kit keeps no default model
const tools = [{ name: 'get_machine', description: 'Read the paired cloud computer state.', input_schema: schema }];
/** The turn's first Claude call on its own: the no-machine check that the phone's Claude plan answers. */
export const claudeToolCall = (accounts: Accounts<any, number>) => step('tool call', () => accounts.respond(1, { ...ask, system: 'Call only the approved machine-state tool.',
  messages: [{ role: 'user', content: prompt }], tools, tool_choice: { type: 'auto' } })); // the plan's strong model refuses a forced tool ('tool'/'any')
export async function pairedTurn(accounts: Accounts<any, number>, link: Pick<DeviceLink, 'request'>) {
  const first = await claudeToolCall(accounts);
  const calls = first.raw.content.filter((c): c is AnthropicToolUse => c.type === 'tool_use');
  if (calls.length !== 1 || calls[0].name !== 'get_machine') throw new Error('The model did not return the single approved machine-state tool call.');
  checked(calls[0].input);
  const state = await step('machine state', () => link.request('get.state'));
  // Anthropic refuses tool_use/tool_result history without the tools defined; 'none' keeps the answer to text.
  const { text } = await step('answer', () => accounts.respond(1, { ...ask, system: 'Use the tool result, not a guess. Answer in one short sentence.', tools, tool_choice: { type: 'none' }, messages: [{ role: 'user', content: prompt },
    { role: 'assistant', content: first.raw.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls[0].id, content: JSON.stringify(state) }] }] }));
  if (!text.trim()) throw new Error('The agent returned no final answer.');
  return { text, state };
}
