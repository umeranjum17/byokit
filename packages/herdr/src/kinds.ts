import table from './kinds.json' with { type: 'json' };

/** Pinned capability data, not login readiness or native move qualification. */
export type AccountKind = {
  kind: string; aliases: string[]; aliasPattern?: string; folderVar?: string;
  resume: boolean; sessionKinds: ('id' | 'path')[]; resumeArgs?: string[];
  loginLabel: string; billing: 'unknown'; offer: 'explicit';
  upstream: { version: string; revision: string; source: string };
};

export function accountKinds(): AccountKind[] { return structuredClone(table) as AccountKind[]; }
export function accountKind(kind: string): AccountKind | undefined {
  return accountKinds().find((row) => row.kind === kind || row.aliases.includes(kind)
    || (row.aliasPattern !== undefined && new RegExp(row.aliasPattern).test(kind)));
}
