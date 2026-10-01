// Agent-local key isolation. The engine owns the SQLite transaction and publishes the changed runtime snapshot.
// No key value crosses this method. Only the typed setup.activate request ever carries a secret.
export function registerKeys(api) {
  api.registerGatewayMethod('byokit.keys', async ({ params, respond }) => {
    const member = params?.member;
    if (typeof member !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(member) || member.startsWith('byokit-key-')
      || !['prepare', 'seal', 'ready'].includes(params.action)) {
      respond(true, { ok: false });
      return;
    }
    const diagnostics = params.action === 'ready' && params.diagnostics === true ? { stage: 'imports' } : undefined;
    const reply = (value) => respond(true, { ...value, ...(diagnostics ? { diagnostics } : {}) });
    try {
      const { readFile, writeFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { resolveAgentDir } = await import('openclaw/plugin-sdk/agent-runtime');
      const { updateAuthProfileStoreWithLock } = await import('openclaw/plugin-sdk/provider-auth');
      // Read the current config: activation changes the roster and selection during the same gateway lifetime.
      if (diagnostics) diagnostics.stage = 'config';
      const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      const keyId = `byokit-key-${member}`;
      if (!config.agents?.entries?.[member] || !config.agents?.entries?.[keyId]) {
        reply({ ok: false });
        return;
      }
      const keyDir = resolveAgentDir(config, keyId);
      const marker = join(keyDir, 'byokit-key-ready.json');
      if (params.action === 'ready') {
        if (diagnostics) diagnostics.stage = 'marker';
        const selected = JSON.parse(await readFile(marker, 'utf8'));
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
      await rm(marker, { force: true });
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
        respond(true, { ok: Boolean(cleared) });
        return;
      }
      const ref = config.agents.entries[keyId].model;
      const primary = typeof ref === 'string' ? ref : ref?.primary;
      const at = typeof primary === 'string' ? primary.lastIndexOf('@') : -1;
      if (at < 1) { respond(true, { ok: false }); return; }
      const profileId = primary.slice(at + 1);
      const model = primary.slice(0, at);
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
