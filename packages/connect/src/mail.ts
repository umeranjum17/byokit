// Typed Gmail read/search on a Connection. Sends are out of scope (write/outbox).
/** Why a read or search failed. `message` is for logs; never show it to a person. */
export type MailErrorCode = 'invalid' | 'network' | 'signed-out' | 'rate-limited';
export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly status?: number;
  readonly until?: number;
  constructor(code: MailErrorCode, message: string, o: { status?: number; until?: number; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'MailError'; this.code = code;
    if (o.status !== undefined) this.status = o.status;
    if (o.until !== undefined) this.until = o.until;
  }
}
/** The only credential a reader needs. `Connection` satisfies this structurally. */
export interface MailCredential {
  token(rejectedAccessToken?: string): Promise<string>;
}
export interface MailReaderOptions {
  userId?: string;
  fetch?: typeof fetch;
  maxBodyChars?: number;
  now?: () => number;
}
/** Headers plus snippet. Absent headers read as `''`. */
export interface MailEnvelope {
  id: string; threadId: string; subject: string; from: string; to: string; date: string;
  snippet: string; labelIds: readonly string[];
}
/** Decoded `text/plain` body. `text/html`-only mail reads as `''`; the snippet still shows. */
export interface MailBody { text: string; truncated: boolean }
export interface MailMessage extends MailEnvelope { body: MailBody }
/** One page. `nextPageToken` is absent on the last page. */
export interface MailPage { messages: MailEnvelope[]; nextPageToken?: string; resultSizeEstimate?: number }
export interface MailListOptions { maxResults?: number; pageToken?: string; signal?: AbortSignal }
export interface MailGetOptions { signal?: AbortSignal }
const API = 'https://gmail.googleapis.com/gmail/v1';
const MAX_RESULTS = 500;
const HEADERS = ['Subject', 'From', 'To', 'Date'];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function mailShape(what: string): MailError { return new MailError('invalid', `mail provider answered outside its shape (${what})`); }
function field(value: unknown, what: string): string {
  if (typeof value !== 'string') throw mailShape(what);
  return value;
}
/** Base64url without `Buffer`, so the reader stays portable. */
function decodeBase64Url(data: string): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const clean = data.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4) + 1);
  let n = 0, bits = 0, acc = 0;
  for (const ch of clean) {
    const v = abc.indexOf(ch);
    if (v < 0) throw mailShape('body data');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
  }
  return new TextDecoder().decode(out.subarray(0, n));
}
export class MailReader {
  private credential: MailCredential;
  private userId: string;
  private fetcher: typeof fetch;
  private maxBodyChars: number;
  private now: () => number;
  constructor(credential: MailCredential, options: MailReaderOptions = {}) {
    if (!credential || typeof credential.token !== 'function') throw new TypeError('MailReader needs a credential with token()');
    const { userId = 'me', fetch, maxBodyChars = 20_000, now = Date.now } = options ?? {};
    if (typeof userId !== 'string' || !userId.trim()) throw new TypeError('MailReader needs a non-empty userId');
    if (!Number.isInteger(maxBodyChars) || maxBodyChars <= 0) throw new RangeError('MailReader maxBodyChars must be a positive integer');
    this.credential = credential; this.userId = userId; this.fetcher = fetch ?? globalThis.fetch;
    this.maxBodyChars = maxBodyChars; this.now = now;
  }
  /** `q` is Gmail search syntax. */
  async search(query: string, options: MailListOptions = {}): Promise<MailPage> {
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('mail search needs a non-empty query');
    return this.page({ q: query.trim() }, options);
  }
  async list(options: MailListOptions = {}): Promise<MailPage> {
    return this.page({}, options);
  }
  /** Envelope plus the body, decoded and cut at `maxBodyChars`. */
  async get(id: string, options: MailGetOptions = {}): Promise<MailMessage> {
    if (typeof id !== 'string' || !id) throw new TypeError('mail message id must be a non-empty string');
    const json = await this.call(`/messages/${encodeURIComponent(id)}`, { format: 'full' }, options.signal);
    const text = this.bodyText(isRecord(json) && isRecord(json.payload) ? json.payload : {});
    const truncated = text.length > this.maxBodyChars;
    return { ...this.envelope(json), body: { text: truncated ? text.slice(0, this.maxBodyChars) : text, truncated } };
  }
  private async page(extra: Record<string, string>, options: MailListOptions): Promise<MailPage> {
    const { maxResults = 20, pageToken, signal } = options ?? {};
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) throw new RangeError('mail maxResults is 1..500');
    if (pageToken !== undefined && typeof pageToken !== 'string') throw new TypeError('mail pageToken must be a string');
    const params: Record<string, string | readonly string[]> = { maxResults: String(maxResults), ...extra };
    if (pageToken) params.pageToken = pageToken;
    const json = await this.call('/messages', params, signal);
    if (!isRecord(json)) throw mailShape('list');
    if (json.messages !== undefined && !Array.isArray(json.messages)) throw mailShape('list');
    const messages: MailEnvelope[] = [];
    for (const item of json.messages ?? []) {
      if (!isRecord(item)) throw mailShape('list');
      messages.push(this.envelope(await this.call(`/messages/${encodeURIComponent(field(item.id, 'message id'))}`,
        { format: 'metadata', metadataHeaders: HEADERS }, signal)));
    }
    const token = json.nextPageToken, size = json.resultSizeEstimate;
    if (token !== undefined && (typeof token !== 'string' || !token)) throw mailShape('list');
    if (size !== undefined && typeof size !== 'number') throw mailShape('list');
    return { messages, ...(typeof token === 'string' && token ? { nextPageToken: token } : {}),
      ...(typeof size === 'number' ? { resultSizeEstimate: size } : {}) };
  }
  private envelope(json: unknown): MailEnvelope {
    if (!isRecord(json)) throw mailShape('message');
    const headers = isRecord(json.payload) && Array.isArray(json.payload.headers) ? json.payload.headers : [];
    const find = (name: string): string => {
      for (const h of headers) if (isRecord(h) && typeof h.name === 'string' && h.name.toLowerCase() === name.toLowerCase()) return typeof h.value === 'string' ? h.value : '';
      return '';
    };
    const rawLabels = json.labelIds;
    const labelIds: readonly string[] = Array.isArray(rawLabels) && rawLabels.every(v => typeof v === 'string') ? [...rawLabels] : [];
    return { id: field(json.id, 'id'), threadId: field(json.threadId, 'threadId'),
      subject: find('Subject'), from: find('From'), to: find('To'), date: find('Date'),
      snippet: typeof json.snippet === 'string' ? json.snippet : '', labelIds };
  }
  private bodyText(part: unknown): string {
    if (!isRecord(part)) return '';
    const texts: string[] = [];
    if (part.mimeType === 'text/plain' && isRecord(part.body) && typeof part.body.data === 'string' && part.body.data) texts.push(decodeBase64Url(part.body.data));
    if (Array.isArray(part.parts)) for (const child of part.parts) texts.push(this.bodyText(child));
    return texts.join('\n');
  }
  private async call(path: string, params: Record<string, string | readonly string[]>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const refused = (cause: unknown): MailError => new MailError('signed-out', 'mail credential refused', { cause });
    const send = async (access: string): Promise<Response> => {
      const url = new URL(`${API}/users/${encodeURIComponent(this.userId)}${path}`);
      for (const [key, value] of Object.entries(params)) for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
      try {
        return await this.fetcher(url, { headers: { authorization: `Bearer ${access}` }, signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw new MailError('network', 'mail provider could not be reached', { cause: error });
      }
    };
    const access = await this.credential.token().catch(cause => { throw refused(cause); });
    let res = await send(access);
    if (res.status === 401) res = await send(await this.credential.token(access).catch(cause => { throw refused(cause); }));
    if (res.status === 401 || res.status === 403) throw new MailError('signed-out', 'mail sign-in is gone or refused', { status: res.status });
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      const until = Number.isFinite(after) && after >= 0 ? this.now() + after * 1000 : undefined;
      throw new MailError('rate-limited', 'mail provider is rate limited', { status: 429, ...(until === undefined ? {} : { until }) });
    }
    if (!res.ok) throw new MailError('network', `mail provider answered HTTP ${res.status}`, { status: res.status });
    try {
      return await res.json();
    } catch (error) {
      throw new MailError('invalid', 'mail provider answered outside its shape (json)', { cause: error });
    }
  }
}
