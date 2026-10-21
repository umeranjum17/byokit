// The BYOKit bridge plugin (docs/runtime-kits.md 5.9): tool calls gated by the fail-closed unix-socket bridge.
// Runs in the gateway process. Reads its tool table from the sibling tools.json written by writePlugin, so
// schemas and descriptions stay app data. No imports beyond node builtins: nothing here needs resolving in-gateway.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { registerKeys } from './keys.js';
import { registerUsage } from './usage.js';
import { registerAccounts } from './accounts.js';
import { registerCatalog } from './catalog.js';
import { registerCodex } from './codex.js';

/** TypeBox's Kind is a global symbol, so these schemas are valid TypeBox without importing typebox. */
const Kind = Symbol.for('TypeBox.Kind');

const table = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const RUN_PARAM = table.runParam;
const PERMIT_PARAM = table.permitParam;
const RUN_ID_PARAM = `${RUN_PARAM}_id`;
const TOOLS = new Map(table.tools.map((t) => [t.name, t]));
// Absent (a table from before the flag) reads as true: fail closed.
const GATE_BUILTINS = table.gateBuiltins !== false;
const BROWSER = table.browser === true;
const CHANNELS = new Set(table.channels ?? []);
let browserCapabilities = [];
function scrubBrowserCapabilities(value) {
  let serialized = JSON.stringify(value).replace(/\b(?:wss?|https?):\/\/[^\s"'<>\\]+/g, url => {
    try { return new URL(url).pathname.startsWith('/devtools/') ? '[browser transport omitted]' : url; }
    catch { return url; }
  });
  for (const capability of browserCapabilities) serialized = serialized.replaceAll(capability, '[browser capability omitted]');
  return JSON.parse(serialized);
}
const unsafe = new Set(['exec', 'process', 'code_execution', 'bash', 'terminal', 'read', 'write', 'edit', 'apply_patch', 'gateway']);
const browserActions = new Set(['profiles', 'importprofile', 'start', 'stop', 'doctor', 'evaluate']);

// Run before the app gate; never trust a caller's profile, target or nested routing.
function browserParams(params, member) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('browser action refused');
  if (browserActions.has(String(params.action).toLowerCase()) || browserActions.has(String(params.kind).toLowerCase()))
    throw new Error('browser action refused');
  const out = { ...params };
  // Stock merges hook params over the original: omission would retain a hostile node selection.
  out.node = undefined;
  out.profile = `byokit-${member}`;
  out.target = 'host';
  if (out.request !== undefined) out.request = browserParams(out.request, member);
  if (out.actions !== undefined) {
    if (!Array.isArray(out.actions)) throw new Error('browser action refused');
    out.actions = out.actions.map(action => browserParams(action, member));
  }
  return out;
}

/** Minimal JSON Schema -> TypeBox-marked schema converter; output is both valid TypeBox and valid JSON Schema. */
function toTypeBox(schema) {
  if (schema === true) return { [Kind]: 'Any' };
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return { [Kind]: 'Any' };
  const out = { ...schema };
  const kind =
    schema.const !== undefined ? 'Literal'
    : Array.isArray(schema.enum) ? 'Union'
    : schema.anyOf !== undefined ? 'Union'
    : schema.oneOf !== undefined ? 'Union'
    : schema.allOf !== undefined ? 'Intersect'
    : schema.type === 'object' || (schema.type === undefined && (schema.properties !== undefined || schema.required !== undefined)) ? 'Object'
    : schema.type === 'array' ? 'Array'
    : schema.type === 'string' ? 'String'
    : schema.type === 'number' ? 'Number'
    : schema.type === 'integer' ? 'Integer'
    : schema.type === 'boolean' ? 'Boolean'
    : schema.type === 'null' ? 'Null'
    : 'Any';
  out[Kind] = kind;
  if (kind === 'Literal') out.const = schema.const;
  if (Array.isArray(schema.enum)) out.anyOf = schema.enum.map((v) => ({ [Kind]: 'Literal', const: v }));
  if (Array.isArray(schema.anyOf)) out.anyOf = schema.anyOf.map(toTypeBox);
  if (Array.isArray(schema.oneOf)) out.oneOf = schema.oneOf.map(toTypeBox);
  if (Array.isArray(schema.allOf)) out.allOf = schema.allOf.map(toTypeBox);
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, toTypeBox(v)]));
  }
  if (out.items !== undefined) {
    out.items = Array.isArray(out.items) ? out.items.map(toTypeBox) : toTypeBox(out.items);
  }
  if (out.additionalProperties !== undefined && typeof out.additionalProperties === 'object') {
    out.additionalProperties = toTypeBox(out.additionalProperties);
  }
  return out;
}

/** One newline-framed request over the bridge socket: one connection, one request, then close. */
function bridgeRequest(message, { timeoutMs, signal } = {}) {
  const path = process.env.BYOKIT_BRIDGE_SOCK;
  if (!path) return Promise.reject(new Error("can't check this action right now"));
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let done = false;
    let timer;
    const fail = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const abort = () => fail(new Error('the call was cancelled'));
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    socket.once('error', () => fail(new Error("can't check this action right now")));
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 1_000_000) return fail(new Error("can't check this action right now"));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch {
        fail(new Error("can't check this action right now"));
      }
    });
    socket.once('connect', () => {
      timer = setTimeout(() => fail(new Error("can't check this action right now")), timeoutMs ?? 195_000);
      socket.write(JSON.stringify(message) + '\n');
    });
  });
}

async function gate(key, tool, input, signal, runId) {
  const reply = await bridgeRequest({ kind: 'gate', key, tool, input, runId }, { timeoutMs: 195_000, signal });
  return reply && typeof reply === 'object' ? reply : { allow: false, reason: "can't check this action right now" };
}

export default {
  id: table.id,
  name: 'BYOKit bridge',
  description: 'Gates tool calls through the host app before they run.',
  configSchema: {
    safeParse(value) {
      if (value === undefined) return { success: true, data: undefined };
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { success: false, error: 'expected config object' };
      if (Object.keys(value).length > 0) return { success: false, error: 'config must be empty' };
      return { success: true, data: value };
    },
    jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  register(api) {
    registerCodex(api);
    api.on('after_tool_call', async (event, ctx) => {
      if (!['sessions_send', 'sessions_spawn'].includes(event.toolName)) return;
      const d = event.result?.details;
      await bridgeRequest({ kind: 'delegation-receipt', key: ctx?.sessionKey, runId: ctx?.runId ?? event.runId,
        callId: ctx?.toolCallId ?? event.toolCallId,
        result: { details: d && { status: d.status, runId: d.runId, sessionKey: d.sessionKey, childSessionKey: d.childSessionKey } } });
    });
    // A native send carries no system text: an admitted helper child gets its helper's persona from the kit (5.8.3).
    // The engine's reply step bringing a sent child's report back (an inter-session prompt) asks too: the kit binds that
    // exact run as the sender's return run (5.8.4) and answers the sender's persona. Any other run, or no answer, adds
    // nothing; the persona is a voice, never a grant.
    api.on('before_prompt_build', async (event, ctx) => {
      const key = ctx?.sessionKey;
      // 9.33 projects the annotation into runtime context; only native provenance can attest its source.
      const source = ctx?.inputProvenance;
      const header = source?.kind === 'inter_session' && source.sourceTool === 'sessions_send'
        && typeof source.sourceSessionKey === 'string' && /^\S{1,512}$/.test(source.sourceSessionKey)
        ? `[Inter-session message] sourceSession=${source.sourceSessionKey} sourceTool=sessions_send isUser=false` : undefined;
      if (typeof key !== 'string' || (!header && !/^agent:[^:]+:h-[a-z][a-z0-9-]{0,15}:/.test(key))) return undefined;
      try {
        const reply = await bridgeRequest({ kind: 'delegation-persona', key, runId: ctx?.runId, ...(header ? { header } : {}) }, { timeoutMs: 10_000 });
        if (typeof reply?.persona === 'string' && reply.persona) return { appendSystemContext: reply.persona };
      } catch { /* no kit: nothing added */ }
      return undefined;
    });
    api.registerAgentEventSubscription?.({ id: 'byokit-delegated-events', handle(event) {
      if (!['assistant', 'tool', 'thinking', 'lifecycle'].includes(event.stream)) return;
      const data = Object.fromEntries(['text', 'name', 'phase', 'toolCallId', 'isError', 'progressTokens', 'aborted', 'error', 'provider', 'model']
        .filter(key => ['string', 'number', 'boolean'].includes(typeof event.data?.[key]))
        .map(key => [key, event.data[key]]));
      void bridgeRequest({ kind: 'delegation-event', event: { runId: event.runId, sessionKey: event.sessionKey,
        stream: event.stream, data } }).catch(() => {});
    } });
    if (api.registerGatewayMethod) { registerKeys(api); registerUsage(api); registerAccounts(api); registerCatalog(api); }
    if (BROWSER) {
      if (typeof api.registerAgentToolResultMiddleware !== 'function') throw new Error('browser result protection unavailable');
      api.registerAgentToolResultMiddleware(async (event, ctx) => {
        const stopped = { result: { content: [{ type: 'text', text: 'Browser session unavailable.' }],
          details: { status: 'error' }, terminate: true } };
        try {
          const admission = await bridgeRequest({ kind: 'before-agent-run', key: ctx.sessionKey, runId: ctx.runId });
          if (admission.allow !== true) return stopped;
          const reply = await bridgeRequest({ kind: 'browser-capabilities' });
          if (!Array.isArray(reply.capabilities) || reply.capabilities.some(value => typeof value !== 'string' || !value)) return stopped;
          browserCapabilities = [...reply.capabilities].sort((a, b) => b.length - a.length);
          return { result: scrubBrowserCapabilities(event.result) };
        } catch { return stopped; }
      }, { runtimes: ['openclaw', 'codex'] });
      // Transcript-only safety net; live provider protection comes from the awaited middleware above.
      api.on('tool_result_persist', event => ({ message: scrubBrowserCapabilities(event.message) }));
      api.on('before_message_write', event => ({ message: scrubBrowserCapabilities(event.message) }));
    }
    // A turned-on channel's messages belong to the app (5.18): claim each one before the engine dispatches it to any
    // agent, hand it to the host without waiting, and stay claimed when the host is gone, so no agent ever runs from it.
    if (CHANNELS.size) api.on('before_dispatch', (event, ctx) => {
      const channel = ctx?.channelId ?? event?.channel;
      if (!CHANNELS.has(channel)) return undefined;
      void bridgeRequest({ kind: 'channel-message', channel, chat: ctx?.conversationId, from: event?.senderId ?? ctx?.senderId,
        text: event?.content }, { timeoutMs: 10_000 }).catch(() => {});
      return { handled: true };
    });
    for (const spec of table.tools) {
      api.registerTool({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        // App-owned bridge tools remain directly callable on 9.33's compact/deferred tool surface.
        catalogMode: 'direct-only',
        parameters: toTypeBox(spec.parameters),
        async execute(_toolCallId, params, signal) {
          const input = { ...(params ?? {}) };
          const run = input[RUN_PARAM];
          const permit = input[PERMIT_PARAM];
          const runId = input[RUN_ID_PARAM];
          delete input[RUN_PARAM];
          delete input[PERMIT_PARAM];
          delete input[RUN_ID_PARAM];
          // The run key is always required; the permit only rides along when the gate minted one (N1).
          if (typeof run !== 'string') {
            throw new Error('this tool needs approval before it runs');
          }
          const call = { kind: 'call', key: run, runId, tool: spec.name, input };
          if (typeof permit === 'string') call.permit = permit;
          let reply;
          try {
            reply = await bridgeRequest(call, { timeoutMs: 195_000, signal });
          } catch (error) {
            throw new Error(error instanceof Error ? error.message : "can't check this action right now");
          }
          if (reply && typeof reply === 'object' && reply.ok === true && typeof reply.text === 'string') {
            return { content: [{ type: 'text', text: reply.text }], details: {} };
          }
          const reason =
            reply && typeof reply === 'object' && typeof reply.reason === 'string'
              ? reply.reason
              : "can't check this action right now";
          throw new Error(reason);
        },
      });
    }
    if (BROWSER) api.on('before_agent_run', async (_event, ctx) => {
      // A kit-owned refusal seam, NOT an enable flag or an automatic-redispatch qualification.
      const key = ctx?.sessionKey;
      if (typeof key !== 'string' || !key) return { outcome: 'block', reason: 'run unavailable', message: 'run unavailable' };
      try {
        const reply = await bridgeRequest({ kind: 'before-agent-run', key, runId: ctx?.runId },
          { timeoutMs: 10_000, signal: ctx?.abortSignal });
        if (reply?.allow === true) return undefined;
      } catch { /* missing host or timeout refuses before submission */ }
      return { outcome: 'block', reason: 'run unavailable', message: 'run unavailable' };
    });
    api.on('before_tool_call', async (event, ctx) => {
      // Engine builtins (web_fetch, memory, ...) are gated too unless the app opted out; they run in-engine and
      // never call back, so an allow passes them through unchanged.
      const builtin = !TOOLS.has(event.toolName);
      if (builtin && !GATE_BUILTINS && !BROWSER) return undefined;
      const key = ctx?.sessionKey;
      if (typeof key !== 'string' || !key) return { block: true, blockReason: "can't check this action right now" };
      let params = event.params ?? {};
      if (BROWSER) {
        if (unsafe.has(event.toolName) || (builtin && event.toolName !== 'browser'))
          return { block: true, blockReason: 'browser tool policy refused' };
        if (event.toolName === 'browser') {
          // Account agents retain their member identity. A delegate has its own agent id, never the parent's browser.
          const agent = ctx?.agentId ?? /^agent:([^:]+):/.exec(key)?.[1];
          const member = typeof agent === 'string' ? agent.replace(/^byokit-key-/, '') : '';
          if (!/^[a-z][a-z0-9-]{0,31}$/.test(member)) return { block: true, blockReason: 'browser member unavailable' };
          try { params = browserParams(params, member); }
          catch { return { block: true, blockReason: 'browser action refused' }; }
        }
      }
      let decision;
      try {
        decision = await gate(key, event.toolName, params, ctx?.abortSignal, ctx?.runId ?? event.runId);
      } catch (error) {
        return { block: true, blockReason: error instanceof Error ? error.message : "can't check this action right now" };
      }
      if (!decision.allow) {
        return {
          block: true,
          blockReason: typeof decision.reason === 'string' ? decision.reason : "can't check this action right now",
        };
      }
      if (builtin && ['sessions_send', 'sessions_spawn'].includes(event.toolName)) {
        try {
          const prepared = await bridgeRequest({ kind: 'delegation-prepare', key, runId: ctx?.runId ?? event.runId,
            callId: ctx?.toolCallId ?? event.toolCallId, tool: event.toolName, input: params });
          if (prepared.allow === false) return { block: true, blockReason: prepared.reason };
        } catch { return { block: true, blockReason: 'delegation admission unavailable' }; }
        // A tracked spawn into the run's own agent goes without `agentId`, the engine's own-agent spawn, so an app's
        // `subagents.allowAgents` list for other agents never refuses it. The kit already admitted that exact agent.
        // Hook params merge over the model's, so the key is overridden, not left out.
        const own = ctx?.agentId ?? /^agent:([^:]+):/.exec(key)?.[1];
        if (event.toolName === 'sessions_spawn' && typeof own === 'string' && params.agentId === own)
          return { params: { ...params, agentId: undefined } };
      }
      if (builtin) return BROWSER && event.toolName === 'browser' ? { params } : undefined;
      // The bridge mints a permit for permitted tools and admits the rest ticket-side; either way the run key
      // rides along and execute sends back only what the gate gave it (N1).
      return {
        params: {
          ...params,
          [RUN_PARAM]: key,
          ...(typeof (ctx?.runId ?? event.runId) === 'string' ? { [RUN_ID_PARAM]: ctx?.runId ?? event.runId } : {}),
          ...(typeof decision.permit === 'string' ? { [PERMIT_PARAM]: decision.permit } : {}),
        },
      };
    });
  },
};
