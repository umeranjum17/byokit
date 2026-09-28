// The BYOKit bridge plugin (docs/runtime-kits.md 5.9): app tools gated by the fail-closed unix-socket bridge.
// Runs in the gateway process. Reads its tool table from the sibling tools.json written by writePlugin, so
// schemas and descriptions stay app data. No imports beyond node builtins: nothing here needs resolving in-gateway.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

/** TypeBox's Kind is a global symbol, so these schemas are valid TypeBox without importing typebox. */
const Kind = Symbol.for('TypeBox.Kind');

const table = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const RUN_PARAM = table.runParam;
const PERMIT_PARAM = table.permitParam;
const TOOLS = new Map(table.tools.map((t) => [t.name, t]));

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

async function gate(key, tool, input, signal) {
  const reply = await bridgeRequest({ kind: 'gate', key, tool, input }, { timeoutMs: 195_000, signal });
  return reply && typeof reply === 'object' ? reply : { allow: false, reason: "can't check this action right now" };
}

export default {
  id: table.id,
  name: 'BYOKit bridge',
  description: 'Gates app tools through the host app before they run.',
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
    for (const spec of table.tools) {
      api.registerTool({
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: toTypeBox(spec.parameters),
        async execute(_toolCallId, params, signal) {
          const input = { ...(params ?? {}) };
          const run = input[RUN_PARAM];
          const permit = input[PERMIT_PARAM];
          delete input[RUN_PARAM];
          delete input[PERMIT_PARAM];
          if (typeof run !== 'string' || typeof permit !== 'string') {
            throw new Error('this tool needs approval before it runs');
          }
          let reply;
          try {
            reply = await bridgeRequest(
              { kind: 'call', key: run, permit, tool: spec.name, input },
              { timeoutMs: 195_000, signal },
            );
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
    api.on('before_tool_call', async (event, ctx) => {
      if (!TOOLS.has(event.toolName)) return undefined;
      const key = ctx?.sessionKey;
      if (typeof key !== 'string' || !key) return { block: true, blockReason: "can't check this action right now" };
      let decision;
      try {
        decision = await gate(key, event.toolName, event.params ?? {}, ctx?.abortSignal);
      } catch (error) {
        return { block: true, blockReason: error instanceof Error ? error.message : "can't check this action right now" };
      }
      if (!decision.allow) {
        return {
          block: true,
          blockReason: typeof decision.reason === 'string' ? decision.reason : "can't check this action right now",
        };
      }
      if (typeof decision.permit !== 'string') {
        return { block: true, blockReason: "can't check this action right now" };
      }
      return { params: { ...(event.params ?? {}), [RUN_PARAM]: key, [PERMIT_PARAM]: decision.permit } };
    });
  },
};
