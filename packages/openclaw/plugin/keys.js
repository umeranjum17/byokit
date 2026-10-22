// Agent-local key isolation. The engine owns the SQLite transaction and publishes the changed runtime snapshot.
// No key value crosses this method. Only the typed setup.activate request ever carries a secret.
export function registerKeys(api) {
  api.registerGatewayMethod('byokit.keys', async ({ params, respond }) => {
    const member = params?.member;
    if (typeof member !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(member) || member.startsWith('byokit-key-')
      || !['prepare', 'seal', 'ready', 'clear'].includes(params.action)) {
      respond(true, { ok: false });
      return;
    }
    const diagnostics = params.action === 'ready' && params.diagnostics === true ? { stage: 'imports' } : undefined;
    const reply = (value) => respond(true, { ...value, ...(diagnostics ? { diagnostics } : {}) });
    try {
      const { readFile, writeFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { resolveAgentDir } = await import('openclaw/plugin-sdk/agent-scope-runtime');
      const { updateAuthProfileStoreWithLock } = await import('openclaw/plugin-sdk/provider-auth');
      // Read the current config: activation changes the roster and selection during the same gateway lifetime.
      if (diagnostics) diagnostics.stage = 'config';
      const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      const keyId = `byokit-key-${member}`;
      // A clear for a lane that was never created (or whose entries are gone) has nothing left to drop and reports absent.
      if (!config.agents?.entries?.[keyId] || (params.action !== 'clear' && !config.agents?.entries?.[member])) {
        reply(params.action === 'clear' ? { ok: false, absent: true } : { ok: false });
        return;
      }
      const keyDir = resolveAgentDir(config, keyId);
      const marker = join(keyDir, 'byokit-key-ready.json');
      if (params.action === 'ready') {
        if (diagnostics) diagnostics.stage = 'marker';
        let text;
        try { text = await readFile(marker, 'utf8'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; reply({ ok: false, absent: true }); return; }
        const selected = JSON.parse(text);
        let ready = false;
        if (diagnostics) diagnostics.stage = 'store';
        await updateAuthProfileStoreWithLock({ agentDir: keyDir, updater(store) {
          if (diagnostics) {
            diagnostics.profiles = Object.entries(store.profiles).map(([id, p]) => ({ id, apiKey: p.type === 'api_key', local: p.copyToAgents === false }));
            diagnostics.order = store.order;
            diagnostics.selected = selected.profileId;
            diagnostics.stage = 'checked';
          }
          const profile = store.profiles[selected.profileId];
          ready = profile?.type === 'api_key' && profile.copyToAgents === false
            && store.order?.[profile.provider]?.length === 1 && store.order[profile.provider][0] === selected.profileId;
          return false;
        } });
        reply({ ok: ready, ...(ready ? { model: selected.model } : {}) });
        return;
      }
      if (params.action === 'prepare') {
        // Only local profiles are loaded by this transaction: no shared-store read-through or CLI sync.
        const normal = await updateAuthProfileStoreWithLock({
          agentDir: resolveAgentDir(config, member),
          saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
          updater(store) {
            if (Object.values(store.profiles).some((p) => p.type === 'api_key'))
              throw new Error('The normal agent already has a key.');
            const providers = new Set([params.provider, ...Object.values(store.profiles).map((p) => p.provider)].filter((p) => typeof p === 'string'));
            store.order ??= {};
            for (const provider of providers) store.order[provider] = Object.entries(store.profiles)
              .filter(([, p]) => p.provider === provider && p.type === 'oauth').map(([id]) => id);
            return true;
          },
        });
        if (!normal) { respond(true, { ok: false }); return; }
        // A replacement starts empty. During activation this agent is unavailable to kit.run.
        const cleared = await updateAuthProfileStoreWithLock({ agentDir: keyDir,
          saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
          updater(store) { store.profiles = {}; store.order = {}; return true; } });
        // The marker goes only once the replacement passes its own checks: a refused prepare keeps it.
        if (cleared) await rm(marker, { force: true });
        respond(true, { ok: Boolean(cleared) });
        return;
      }
      if (params.action === 'clear') {
        // A failed add drops the key it activated; if this clear never reaches the engine, the unsealed key stays but is
        // unusable until the next add's prepare or the next kit start's sweep.
        const cleared = await updateAuthProfileStoreWithLock({ agentDir: keyDir,
          saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
          updater(store) { store.profiles = {}; store.order = {}; delete store.lastGood; return true; } });
        if (cleared) await rm(marker, { force: true });
        respond(true, { ok: Boolean(cleared) });
        return;
      }
      const ref = config.agents.entries[keyId].model;
      const primary = typeof ref === 'string' ? ref : ref?.primary;
      const at = typeof primary === 'string' ? primary.lastIndexOf('@') : -1;
      if (at < 1) { respond(true, { ok: false }); return; }
      const profileId = primary.slice(at + 1);
      const model = params.model ?? primary.slice(0, at);
      // The kit checks the route catalog before seal; a direct call still cannot cross the activated provider.
      if (typeof model !== 'string' || !model || model.split('/')[0] !== primary.split('/')[0]) {
        respond(true, { ok: false }); return;
      }
      let found = false;
      const sealed = await updateAuthProfileStoreWithLock({ agentDir: keyDir,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater(store) {
          const profile = store.profiles[profileId];
          if (profile?.type !== 'api_key') return false;
          found = true;
          profile.copyToAgents = false;
          store.profiles = { [profileId]: profile };
          // A stored agent-local order wins over global config and contains exactly this key, never a sign-in.
          store.order = { [profile.provider]: [profileId] };
          store.lastGood = {};
          return true;
        },
      });
      if (!sealed || !found) { respond(true, { ok: false }); return; }
      await writeFile(marker, JSON.stringify({ profileId, model }), { mode: 0o600 });
      respond(true, { ok: true });
    } catch {
      // Neither engine errors nor store contents (which contain secrets) ever leave this method.
      reply({ ok: false });
    }
  }, { scope: 'operator.admin' });
}
