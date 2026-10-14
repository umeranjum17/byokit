// Thinking-level clamp at run dispatch (5.8): map an unsupported asked level to the nearest
// supported one that still reasons, reading levels from the model catalog the kit already holds.
// Never silently drop to off unless the person asked for off. No catalog levels → pass through.
import type { ThinkingAsked, ThinkingReport, ThinkingUsed } from './types.ts';

const ORDER: readonly ThinkingUsed[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type CatalogModel = {
  id?: string;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  compat?: { supportedReasoningEfforts?: readonly string[] | null };
};

/** Supported thinking level ids from one catalog model row, or undefined when the catalog names none. */
export function levelsOf(model: CatalogModel | undefined): ThinkingUsed[] | undefined {
  if (!model) return undefined;
  const efforts = model.compat?.supportedReasoningEfforts;
  if (Array.isArray(efforts) && efforts.length > 0) {
    const out: ThinkingUsed[] = [];
    const seen = new Set<string>();
    for (const raw of ['off', ...efforts]) {
      const id = raw === 'none' ? 'off' : raw;
      if (!ORDER.includes(id as ThinkingUsed) || seen.has(id)) continue;
      seen.add(id);
      out.push(id as ThinkingUsed);
    }
    return out.length ? out : undefined;
  }
  const map = model.thinkingLevelMap;
  if (!map) return undefined;
  const out = ORDER.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
  return out.length ? out : undefined;
}

/** Nearest supported level for `asked`. Empty/absent catalog levels leave `asked` unchanged. */
export function clampThinking(asked: ThinkingAsked, supported: readonly ThinkingUsed[] | undefined): ThinkingReport {
  if (!supported?.length) return { asked, used: asked };
  if (supported.includes(asked)) return { asked, used: asked };
  const candidates = asked === 'off' ? supported : supported.filter((level) => level !== 'off');
  const pool = candidates.length ? candidates : supported;
  const at = ORDER.indexOf(asked);
  if (at >= 0) {
    for (let i = at; i < ORDER.length; i++) {
      const level = ORDER[i]!;
      if (pool.includes(level)) return { asked, used: level };
    }
    for (let i = at - 1; i >= 0; i--) {
      const level = ORDER[i]!;
      if (pool.includes(level)) return { asked, used: level };
    }
  }
  return { asked, used: pool[0]! };
}

/** The catalog row for `provider`/`modelId` in a `config.get` models.providers map. */
export function catalogModelOf(
  providers: Record<string, { models?: CatalogModel[] }> | undefined,
  provider: string,
  modelId: string,
): CatalogModel | undefined {
  const rows = providers?.[provider]?.models;
  if (!rows) return undefined;
  const needle = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
  return rows.find((row) => row.id === needle || row.id === modelId || row.id === `${provider}/${needle}`);
}
