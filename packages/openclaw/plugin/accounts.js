// Account sealing (5.15, O14): the gateway method `byokit.accounts` over one agent's own auth-profile store.
// list/seal/ready/adopt/clear. Runs beside the other plugin methods; no credential value ever crosses an answer.
// `who` is a one-way identity: the first 16 hex digits of sha256(`<provider>\n<accountId>`), so the account id
// itself never leaves the engine.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Local-only store I/O (as keys.js): never read through inherited auth and never sync an external CLI.
const LOCAL = { filterExternalAuthProfiles: false, syncExternalCli: false };
// An account agent is `<member>--<6 hex>` (D9); a member id never contains `--`.
const ACCOUNT_AGENT = /--[0-9a-f]{6}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const EXPIRING_MS = 300_000;      // auth selection's refresh margin: at or under this, a token is "expiring"
const OAUTH_WARN_MS = 86_400_000; // auth-health's default oauth warn window: a day out is still "expiring"

const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const primaryOf = (entry) => {
  const ref = entry?.model;
  return typeof ref === 'string' ? ref : object(ref) && typeof ref.primary === 'string' ? ref.primary : undefined;
};
const hasSecret = (value, ref) => (typeof value === 'string' && value.length > 0) || object(ref);
/** The sign-in identity for an OAuth profile that stores the provider's account id; api_key/token never have one. */
const whoOf = (credential) => credential?.type === 'oauth' && typeof credential.accountId === 'string' && credential.accountId.length > 0
  ? createHash('sha256').update(`${credential.provider}\n${credential.accountId}`).digest('hex').slice(0, 16) : undefined;
/** The engine's token expiry state (credential-state.ts): missing, invalid, expired, or valid. */
const expiryState = (expires, now) => {
  if (expires === undefined) return 'missing';
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0 || expires > 8.64e13) return 'invalid';
  return expires <= now ? 'expired' : 'valid';
};
/** The engine's profile status (auth-health.ts), from the credential alone: static, ok, expiring, expired or missing. */
const statusOf = (credential, now) => {
  if (credential.type === 'api_key') return hasSecret(credential.key, credential.keyRef) ? 'static' : 'missing';
  if (credential.type === 'token') {
    if (!hasSecret(credential.token, credential.tokenRef)) return 'missing';
    const state = expiryState(credential.expires, now);
    if (state === 'invalid') return 'missing';
    if (state === 'expired') return 'expired';
    if (credential.expires === undefined) return 'static';
    return credential.expires - now <= EXPIRING_MS ? 'expiring' : 'ok';
  }
  if (!hasSecret(credential.access, undefined) && !hasSecret(credential.refresh, undefined)) return 'missing';
  const state = expiryState(credential.expires, now);
  if (state === 'invalid' || state === 'missing') return 'missing';
  if (state === 'expired') return 'expired';
  return credential.expires - now <= OAUTH_WARN_MS ? 'expiring' : 'ok';
};

/** A read (`fn` returns nothing) or a write when `fn` sets `store.changed`. Resolves the store, or null on lock contention. */
function withStore(updateAuthProfileStoreWithLock, agentDir, fn) {
  return updateAuthProfileStoreWithLock({ agentDir, saveOptions: LOCAL, updater(store) { return fn(store); } });
}
/** Keep only `profileId` of `provider`; on an account agent drop every other provider too. */
const sealProfiles = (profiles, provider, profileId, account) => account
  ? { [profileId]: { ...profiles[profileId] } }
  : Object.fromEntries(Object.entries(profiles).filter(([id, p]) => p.provider !== provider || id === profileId));

export function registerAccounts(api) {
  api.registerGatewayMethod('byokit.accounts', async ({ params, respond }) => {
    // Every failure answers { ok: false }; no engine error or store contents ever leave this method.
    try { respond(true, await handle(params)); }
    catch { respond(true, { ok: false }); }
  }, { scope: 'operator.admin' });
}

async function handle(params) {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
  const { resolveAgentDir } = await import('openclaw/plugin-sdk/agent-runtime');
  const { updateAuthProfileStoreWithLock } = await import('openclaw/plugin-sdk/provider-auth');
  // adopt names both agents itself: it is the one action that does not address a single agent.
  if (params?.action === 'adopt') return adopt(params, config, resolveAgentDir, updateAuthProfileStoreWithLock);

  const agentId = params?.agentId;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return { ok: false };
  const entry = config.agents?.entries?.[agentId];
  if (!entry) return { ok: false };
  const agentDir = resolveAgentDir(config, agentId);
  const read = (fn) => withStore(updateAuthProfileStoreWithLock, agentDir, fn);

  if (params.action === 'list') {
    const now = Date.now();
    let rows;
    const store = await read((s) => {
      rows = Object.entries(s.profiles ?? {}).map(([profileId, credential]) => {
        const row = { provider: credential.provider, profileId, type: credential.type, status: statusOf(credential, now) };
        const who = whoOf(credential);
        if (who) row.who = who;
        return row;
      });
    });
    return store && rows ? { ok: true, profiles: rows } : { ok: false };
  }

  if (params.action === 'ready') {
    const provider = params.provider;
    if (typeof provider !== 'string' || !provider) return { ok: false };
    const now = Date.now();
    let answer;
    const store = await read((s) => {
      const order = s.order?.[provider];
      const profileId = Array.isArray(order) && order.length === 1 ? order[0] : undefined;
      const credential = profileId ? s.profiles?.[profileId] : undefined;
      if (!credential || credential.provider !== provider) return;
      const status = statusOf(credential, now);
      if (status === 'missing' || status === 'expired') return;
      answer = { type: credential.type };
      if (typeof credential.expires === 'number') answer.expiresAt = credential.expires;
      const who = whoOf(credential);
      if (who) answer.who = who;
    });
    return store && answer ? { ok: true, ...answer } : { ok: false };
  }

  if (params.action === 'seal') {
    const provider = params.provider;
    if (typeof provider !== 'string' || !provider) return { ok: false };
    const primary = primaryOf(entry);
    const at = typeof primary === 'string' ? primary.lastIndexOf('@') : -1;
    if (at < 1) return { ok: false };
    const profileId = primary.slice(at + 1);
    const account = ACCOUNT_AGENT.test(agentId);
    let who;
    let sealed = false;
    const store = await updateAuthProfileStoreWithLock({ agentDir, saveOptions: LOCAL, updater(s) {
      const credential = s.profiles?.[profileId];
      // No such profile, or the named profile belongs to another provider; on a member agent an api_key is refused.
      if (!credential || credential.provider !== provider || (!account && credential.type === 'api_key')) return false;
      who = whoOf(credential);
      s.profiles = sealProfiles(s.profiles, provider, profileId, account);
      s.order = account ? { [provider]: [profileId] } : { ...(s.order ?? {}), [provider]: [profileId] };
      if (object(s.lastGood) && provider in s.lastGood) delete s.lastGood[provider];
      sealed = true;
      return true;
    } });
    return store && sealed ? { ok: true, ...(who ? { who } : {}) } : { ok: false };
  }

  if (params.action === 'clear') {
    const provider = params.provider;
    if (typeof provider === 'string' && provider) {
      const cleared = await updateAuthProfileStoreWithLock({ agentDir, saveOptions: LOCAL, updater(s) {
        for (const [id, credential] of Object.entries(s.profiles ?? {}))
          if (credential?.provider === provider) delete s.profiles[id];
        if (s.order?.[provider]) delete s.order[provider];
        if (object(s.lastGood) && provider in s.lastGood) delete s.lastGood[provider];
        return true;
      } });
      return cleared ? { ok: true } : { ok: false };
    }
    const cleared = await updateAuthProfileStoreWithLock({ agentDir, saveOptions: LOCAL, updater(s) {
      s.profiles = {}; s.order = {}; delete s.lastGood; return true;
    } });
    return cleared ? { ok: true } : { ok: false };
  }

  return { ok: false };
}

/** Move `from`'s sealed profile of `provider` into `to` and point `to`'s model at it, or answer { ok: false } with both
 * stores and the model as they were. The three writes are separate transactions, so any failure after the first is
 * undone in reverse: a partial move (or a model pin to a profile no store holds) must never outlive the answer. */
async function adopt(params, config, resolveAgentDir, updateAuthProfileStoreWithLock) {
  const { from, to, provider, who } = params;
  if (typeof from !== 'string' || !AGENT_ID.test(from) || typeof to !== 'string' || !AGENT_ID.test(to)
    || typeof provider !== 'string' || !provider || typeof who !== 'string' || !who) return { ok: false };
  if (from === to) return { ok: false };
  if (!config.agents?.entries?.[from] || !config.agents?.entries?.[to]) return { ok: false };
  const fromDir = resolveAgentDir(config, from);
  const toDir = resolveAgentDir(config, to);
  // from's sealed profile (order[provider] names exactly it) must carry exactly this who, or nothing changes.
  let fromId;
  let moved;
  await withStore(updateAuthProfileStoreWithLock, fromDir, (s) => {
    const order = s.order?.[provider];
    fromId = Array.isArray(order) && order.length === 1 ? order[0] : undefined;
    const credential = fromId ? s.profiles?.[fromId] : undefined;
    if (credential && credential.provider === provider && whoOf(credential) === who) moved = credential;
  });
  if (!moved) return { ok: false };
  // The model's current primary names the shape (string or object) and the base ref the new pin keeps.
  const target = primaryOf(config.agents.entries[to]);
  if (typeof target !== 'string') return { ok: false };
  const cut = target.lastIndexOf('@');
  const base = cut > 0 ? target.slice(0, cut) : target;
  const { updateConfig } = await import('openclaw/plugin-sdk/config-runtime');
  const { setAgentEffectiveModelPrimary } = await import('openclaw/plugin-sdk/agent-runtime');
  const pin = (primary) => updateConfig((cfg) => { setAgentEffectiveModelPrimary(cfg, to, primary, { forceAgent: true }); return cfg; });

  const account = ACCOUNT_AGENT.test(to);
  let pre;
  const restoreTo = () => updateAuthProfileStoreWithLock({ agentDir: toDir, saveOptions: LOCAL, updater(s) {
    s.profiles = pre.profiles;
    if (pre.order === undefined) delete s.order; else s.order = pre.order;
    if (pre.lastGood === undefined) delete s.lastGood; else s.lastGood = pre.lastGood;
    return true;
  } });
  try {
    // Rewrite to's model primary @ suffix to from's sealed id before any store move: the pin would otherwise keep
    // pinning the profile we are about to delete.
    await pin(`${base}@${fromId}`);
    // Move the record unchanged into to's store, sealed to it (dropping to's old profile of provider), then clear it
    // from from. The grant stays shared; each agent holds only its own view (D11).
    const sealed = await updateAuthProfileStoreWithLock({ agentDir: toDir, saveOptions: LOCAL, updater(s) {
      pre = { profiles: s.profiles, order: s.order, lastGood: object(s.lastGood) ? { ...s.lastGood } : s.lastGood };
      s.profiles = { ...sealProfiles(s.profiles, provider, fromId, account), [fromId]: moved };
      s.order = { ...(s.order ?? {}), [provider]: [fromId] };
      if (object(s.lastGood) && provider in s.lastGood) delete s.lastGood[provider];
      return true;
    } });
    if (!sealed) { await pin(target); return { ok: false }; }
    let clearedOk = false;
    const cleared = await updateAuthProfileStoreWithLock({ agentDir: fromDir, saveOptions: LOCAL, updater(s) {
      // A refresh between the read and this clear must not be deleted with the stale snapshot: refuse when the
      // live record no longer equals the moved one (a who check alone would miss it; the account id never
      // changes on refresh), and the caller rolls the move back.
      if (!isDeepStrictEqual(s.profiles?.[fromId], moved)) return false;
      if (s.profiles) delete s.profiles[fromId];
      if (s.order?.[provider]) {
        s.order[provider] = s.order[provider].filter((id) => id !== fromId);
        if (!s.order[provider].length) delete s.order[provider];
      }
      clearedOk = true;
      return true;
    } });
    if (cleared && clearedOk) return { ok: true };
    await restoreTo();
    await pin(target);
    return { ok: false };
  } catch {
    await pin(target).catch(() => {});
    if (pre) await restoreTo().catch(() => {});
    return { ok: false };
  }
}
