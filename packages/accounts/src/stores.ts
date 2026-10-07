// Credential stores behind Pi's own CredentialStore seam: one per person, never a shared fallback. Each platform's
// storage is only "load the record, save the record"; this file keeps every one of them serialized the same way, so a
// refresh and a sign-out never interleave. No Node import here: phones and browsers use it too (see node-stores.ts).
import type { Defaults } from './multi.ts';
import type { Billing } from './catalogue.ts';
import type { EndpointRecord } from './endpoints.ts';
import type { CloudAccount } from './cloud.ts';
import type { Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';

/** Non-secret per-account route configuration. Secret values belong only in keyStore, never here. */
export type AccountMetadata = {
  route: string; billing: Billing; baseUrl?: string; compat?: 'openai' | 'anthropic'; region?: string;
  profile?: string; keyFile?: string; accountId?: string; gatewayId?: string; endpoint?: EndpointRecord;
  cloud?: CloudAccount;
};
export type AccountsIndex = { accounts?: { [id: string]: AccountMetadata }; names: { [id: string]: string }; emails: { [id: string]: string }; plans: { [id: string]: string }; addedAt: { [id: string]: number }; defaults: Defaults };
export const emptyIndex = (): AccountsIndex => ({ names: {}, emails: {}, plans: {}, addedAt: {}, defaults: {} });
export type Record = { [providerId: string]: Credential | AccountsIndex };
export type IndexStore = { index(fn?: (index: AccountsIndex, data: Record) => void, options?: { signal?: AbortSignal }): Promise<AccountsIndex> };
const credential = (data: Record, id: string): Credential | undefined => id.startsWith('.') ? undefined : data[id] as Credential | undefined;
type RefreshState = { generation: number; state: 'ready' | 'attempted' | 'uncertain' | 'terminal' };
/** Extends the credential seam so two durable writes can bracket a refresh while holding the same lock. */
export type RefreshStore = CredentialStore & {
  refresh(id: string, due: (c: OAuthCredential) => boolean, rotate: (c: OAuthCredential) => Promise<OAuthCredential>): Promise<OAuthCredential | undefined>;
};
export type AccountStore = RefreshStore & { end(id: string, fn: (c: Credential | undefined) => Promise<void>): Promise<void> };
export type EndingStore = AccountStore & IndexStore;

/** No provider response or credential is included in this error. `status` lets Accounts ask for sign-in again. */
export class RefreshRequiredError extends Error {
  readonly status = 401;
  constructor() { super('This sign-in needs to be connected again.'); this.name = 'RefreshRequiredError'; }
}

/** Whether a token endpoint's refusal proves the grant revoked: OAuth's invalid_grant (RFC 6749 §5.2), or OpenAI's own
 *  codes for it (as Codex reads them). A 400, 401 or 403 alone does not: an edge or a provider hiccup sends those too. */
export function revoked(status: number, body: string) {
  if (status < 400 || status > 499) return false;
  try {
    const error = JSON.parse(body)?.error;
    return ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(typeof error === 'string' ? error : error?.code);
  } catch { return false; }
}

/** Legacy credentials have no marker. Unknown or incomplete state fails closed. */
export function needsReauth(c: Credential | undefined): boolean {
  if (c?.type !== 'oauth' || c.byokitRefresh === undefined) return false;
  const marker = c.byokitRefresh as RefreshState | null;
  return !marker || marker.state !== 'ready' || !Number.isSafeInteger(marker.generation) || marker.generation < 0;
}

/** Bare CredentialStore implementations cannot persist inside their modify callback. Require the transaction seam
 *  rather than send a grant without its attempt marker; custom stores can use recordStore(load, save). */
export async function refreshCredential(store: CredentialStore, id: string, due: (c: OAuthCredential) => boolean, rotate: (c: OAuthCredential) => Promise<OAuthCredential>) {
  const refresh = (store as Partial<RefreshStore>).refresh;
  if (refresh) return refresh.call(store, id, due, rotate);
  const c = await store.read(id);
  if (c?.type !== 'oauth') return undefined;
  if (needsReauth(c)) throw new RefreshRequiredError();
  if (!due(c)) return c;
  throw new Error('Refresh requires a transactional credential store; use recordStore(load, save).');
}

/** A store over one whole record the platform loads and saves. Writes are serialized within this process, and across
 *  processes through `lock` when the platform has one; a write re-reads first, so a sign-in that took minutes never
 *  overwrites a provider that changed meanwhile. */
export function recordStore(load: () => Promise<Record>, save: (data: Record) => Promise<void>, lock = <T>(fn: () => Promise<T>) => fn()): EndingStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(() => lock(fn)); chain = r.catch(() => {}); return r; };
  return {
    // Reading the index takes no turn, like read and list.
    index: (fn, options) => (fn ? serial : <T>(f: () => Promise<T>) => f())(async () => {
      const data = { ...await load() };
      const before = fn && options?.signal ? JSON.parse(JSON.stringify(data)) as Record : undefined;
      const stored = data['.accounts'] as AccountsIndex | undefined;
      const index: AccountsIndex = stored ? { names: { ...stored.names }, emails: { ...stored.emails }, plans: { ...stored.plans }, addedAt: { ...stored.addedAt }, defaults: { ...stored.defaults }, ...(stored.accounts ? { accounts: JSON.parse(JSON.stringify(stored.accounts)) } : {}) } : emptyIndex();
      if (options?.signal?.aborted) throw new Error('Login cancelled');
      if (fn) {
        fn(index, data);
        data['.accounts'] = index;
        await save(data);
        if (options?.signal?.aborted) { await save(before!); throw new Error('Login cancelled'); }
      }
      return index;
    }),
    read: async (id) => credential(await load(), id),
    list: async () => Object.entries(await load()).filter(([id]) => !id.startsWith('.')).map(([providerId, c]) => ({ providerId, type: (c as Credential).type })),
    modify: (id, fn, options) => serial(async () => {
      if (id.startsWith('.')) throw new Error('Use the account index seam for metadata.');
      const current = credential(await load(), id);
      const next = await fn(current);
      if (next === undefined) return current;
      if (options?.signal?.aborted) throw new Error('Login cancelled');
      await save({ ...(await load()), [id]: next });
      return next;
    }),
    refresh: (id, due, rotate) => serial(async () => {
      const current = credential(await load(), id);
      if (current?.type !== 'oauth') return undefined;
      if (needsReauth(current)) throw new RefreshRequiredError();
      if (!due(current)) return current;
      const generation = (current.byokitRefresh as RefreshState | undefined)?.generation ?? 0;
      const attempted = { ...current, byokitRefresh: { generation, state: 'attempted' } satisfies RefreshState };
      const write = async (c: OAuthCredential) => save({ ...(await load()), [id]: c });
      // Never send if this write fails. The marker stays in the same sealed record as the old pair.
      await write(attempted);
      const settle = async (state: RefreshState['state']) => {
        // The before-send marker already prevents replay if this write also fails.
        await write({ ...attempted, byokitRefresh: { generation, state } }).catch(() => {});
      };
      let next: OAuthCredential;
      try { next = await rotate(current); }
      catch (e: any) {
        // Only the provider proving the grant revoked (`revoked`, as invalid_grant) ends the sign-in. An accepted but
        // unreadable 2xx may have spent it. No answer or any other refusal keeps it, the stored grant tried again next
        // time as @byokit/connect does.
        const status = e?.status;
        if (e?.revoked === true) { await settle('terminal'); throw new RefreshRequiredError(); }
        if (typeof status === 'number' && status >= 200 && status <= 299) { await settle('uncertain'); throw new RefreshRequiredError(); }
        await settle('ready');
        throw new Error(`The sign-in could not be refreshed over the network${status ? ` (the provider answered ${status})` : ''}; it is kept for the next try.`);
      }
      if (next.refresh === current.refresh || (current.accountId && next.accountId !== current.accountId)) {
        await settle(next.refresh === current.refresh ? 'uncertain' : 'terminal');
        throw new RefreshRequiredError();
      }
      const committed = { ...current, ...next, byokitRefresh: { generation: generation + 1, state: 'ready' } satisfies RefreshState };
      try { await write(committed); }
      catch { throw new RefreshRequiredError(); }
      return committed;
    }),
    delete: (id) => serial(async () => { const data = await load(); if (id in data) { delete data[id]; await save(data); } }),
    end: (id, fn) => serial(async () => {
      try { await fn(credential(await load(), id)); }
      finally { const data = await load(); if (id in data) { delete data[id]; await save(data); } }
    }),
  };
}

export function memoryStore(): EndingStore {
  let data: Record = {};
  return recordStore(async () => ({ ...data }), async (d) => { data = d; });
}

/** The parts of `expo-secure-store` this uses (Keychain on iOS, Keystore-encrypted on Android); pass the module itself.
 *  Every method takes the same optional `options` (e.g. `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`). */
export type SecureStoreLike = {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
};

/** One person's sign-ins in the phone's secure storage: `secureStore(SecureStore, 'byokit.1')`. Keys may hold letters,
 *  digits, `.`, `-` and `_`. The record is split into pieces under the 2048 bytes expo-secure-store warns about, written
 *  as a new generation, then `name` is pointed at it: a crash mid-write leaves the old sign-ins whole. `options` (e.g.
 *  `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`) is passed to every get, set and delete;
 *  without it Expo's default (`WHEN_UNLOCKED`) applies. */
export function secureStore(secure: SecureStoreLike, name: string, options?: object): EndingStore {
  const head = async () => { const [gen = '0', n = '0'] = (await secure.getItemAsync(name, options))?.split(':') ?? []; return { gen: Number(gen), n: Number(n) }; };
  const load = async () => {
    const { gen, n } = await head();
    let text = '';
    for (let i = 0; i < n; i++) text += (await secure.getItemAsync(`${name}.${gen}.${i}`, options)) ?? '';
    return text ? JSON.parse(text) : {};
  };
  const save = async (data: Record) => {
    const old = await head();
    const gen = old.gen + 1;
    const parts = (Object.keys(data).length ? JSON.stringify(data) : '').match(/[\s\S]{1,1800}/g) ?? [];
    for (const [i, part] of parts.entries()) await secure.setItemAsync(`${name}.${gen}.${i}`, part, options);
    await secure.setItemAsync(name, `${gen}:${parts.length}`, options);
    for (let i = 0; i < old.n; i++) await secure.deleteItemAsync(`${name}.${old.gen}.${i}`, options);
    // Leftovers of a write that crashed at this generation before.
    for (let i = parts.length; (await secure.getItemAsync(`${name}.${gen}.${i}`, options)) !== null; i++) await secure.deleteItemAsync(`${name}.${gen}.${i}`, options);
  };
  return recordStore(load, save);
}

/** One person's sign-ins in the browser's IndexedDB (a PWA, or Electron's renderer), under `name`. A browser has no
 *  keychain: anything running on this page could read them, so keep the page free of scripts you don't control. */
export function browserStore(name: string, db = 'byokit'): EndingStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(db, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('signins');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) => {
    const d = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = d.transaction('signins', mode);
        const r = fn(t.objectStore('signins'));
        t.oncomplete = () => resolve(r.result);
        t.onerror = t.onabort = () => reject(t.error);
      });
    } finally { d.close(); }
  };
  const store = recordStore(async () => (await run<Record | undefined>('readonly', (s) => s.get(name))) ?? {}, (data) => run('readwrite', (s) => s.put(data, name)));
  // Every write replaces the whole record, so tabs must share a record lock, including the entire refresh.
  const locked = async <T>(fn: () => Promise<T>): Promise<T> =>
    typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request<Promise<T>>(`byokit:${db}:${name}`, fn) : fn();
  return {
    ...store,
    index: (fn, options) => locked(() => store.index(fn, options)),
    modify: (id, fn, options) => locked(() => store.modify(id, fn, options)),
    refresh: (id, due, rotate) => locked(() => store.refresh(id, due, rotate)),
    delete: (id, options) => locked(() => store.delete(id, options)),
    end: (id, fn) => locked(() => store.end(id, fn)),
  };
}

/** A device-owned @byokit/secrets backend, supplied by the host; no runtime Node import. One store per member/name. */
export function keystoreStore(keystore: { get(name: string): Promise<string | null>; set(name: string, secret: string): Promise<void> }, name: string): EndingStore {
  return recordStore(async () => JSON.parse(await keystore.get(name) ?? '{}'), async (data) => keystore.set(name, JSON.stringify(data)));
}

/** An engine sees only its provider slot, mapped to one public account's credential. */
export function viewStore(store: EndingStore, providerId: string, accountId: string): AccountStore {
  const key = (id: string) => {
    if (id !== providerId) throw new Error('This account does not provide that sign-in.');
    return accountId;
  };
  return {
    read: (id, options) => store.read(key(id), options),
    list: async () => { const c = await store.read(accountId); return c ? [{ providerId, type: c.type }] : []; },
    modify: (id, fn, options) => store.modify(key(id), fn, options),
    refresh: (id, due, rotate) => store.refresh(key(id), due, rotate),
    delete: (id, options) => store.delete(key(id), options),
    end: (id, fn) => store.end(key(id), fn),
  };
}
