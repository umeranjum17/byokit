// Typed Gmail read/search and approval-gated send on a Connection.
/** Why a read, search or send failed. `message` is for logs; never show it to a person. */
export type MailErrorCode = 'invalid' | 'network' | 'signed-out' | 'rate-limited' | 'denied';
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
/** The only credential a reader or sender needs. `Connection` satisfies this structurally. */
export interface MailCredential {
  token(rejectedAccessToken?: string): Promise<string>;
}
export interface MailSenderOptions {
  userId?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface MailReaderOptions extends MailSenderOptions { maxBodyChars?: number }
/** One message. `to` is one or more bare addresses (`name@host`); the sender is the signed-in mailbox. */
export interface MailDraft { to: string | readonly string[]; subject: string; body: string }
/** Exactly what will be sent, frozen: the approval sees the same object the send encodes. */
export interface OutgoingMail { readonly to: readonly string[]; readonly subject: string; readonly body: string }
/** Asked once per message, before any token or provider call. Only `true` sends; anything else, or a throw, denies. */
export type MailApproval = (mail: OutgoingMail) => boolean | Promise<boolean>;
export interface MailSendOptions { signal?: AbortSignal }
export interface SentMail { id: string; threadId: string; labelIds: readonly string[] }
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
class Gmail {
  private credential: MailCredential;
  private userId: string;
  private fetcher: typeof fetch;
  private now: () => number;
  constructor(kind: string, credential: MailCredential, options: MailSenderOptions) {
    if (!credential || typeof credential.token !== 'function') throw new TypeError(`${kind} needs a credential with token()`);
    const { userId = 'me', fetch, now = Date.now } = options ?? {};
    if (typeof userId !== 'string' || !userId.trim()) throw new TypeError(`${kind} needs a non-empty userId`);
    this.credential = credential; this.userId = userId; this.fetcher = fetch ?? globalThis.fetch; this.now = now;
  }
  /** GET with `params`, or POST `body` as JSON. A 401 retries once with a fresh token. */
  protected async call(path: string, params: Record<string, string | readonly string[]>, signal?: AbortSignal, body?: unknown): Promise<unknown> {
    signal?.throwIfAborted();
    const refused = (cause: unknown): MailError => new MailError('signed-out', 'mail credential refused', { cause });
    const send = async (access: string): Promise<Response> => {
      const url = new URL(`${API}/users/${encodeURIComponent(this.userId)}${path}`);
      for (const [key, value] of Object.entries(params)) for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
      try {
        return await this.fetcher(url, body === undefined ? { headers: { authorization: `Bearer ${access}` }, signal }
          : { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
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
export class MailReader extends Gmail {
  private maxBodyChars: number;
  constructor(credential: MailCredential, options: MailReaderOptions = {}) {
    super('MailReader', credential, options);
    const { maxBodyChars = 20_000 } = options ?? {};
    if (!Number.isInteger(maxBodyChars) || maxBodyChars <= 0) throw new RangeError('MailReader maxBodyChars must be a positive integer');
    this.maxBodyChars = maxBodyChars;
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
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 without `Buffer`, so the sender stays portable. */
function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < bytes.length ? B64[n >> 6 & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]+$/;
/** Validates and freezes one draft; rejects header injection and anything but bare addresses. */
function outgoing(draft: MailDraft): OutgoingMail {
  if (!isRecord(draft)) throw new TypeError('mail send takes one draft object');
  const { to: rawTo, subject, body } = draft;
  // Copy first, then check the copy: the approval and the send see exactly what was checked.
  const to = typeof rawTo === 'string' ? [rawTo] : Array.isArray(rawTo) ? Array.from(rawTo as unknown[]) : [];
  if (!to.length || !to.every(a => typeof a === 'string' && ADDRESS.test(a))) throw new TypeError('mail to must be one or more bare addresses');
  if (typeof subject !== 'string' || /[\r\n]/.test(subject)) throw new TypeError('mail subject must be one line of text');
  if (typeof body !== 'string') throw new TypeError('mail body must be text');
  return Object.freeze({ to: Object.freeze(to as string[]), subject, body });
}
/** RFC 2047 encoded words of at most 45 bytes each, so no word splits a character. Plain only when
 *  a reader cannot decode it differently (`=?`) and the line stays short. */
function headerText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && !text.includes('=?') && text.length <= 900) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (utf8(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  words.push(chunk);
  return words.map(w => `=?UTF-8?B?${encodeBase64(utf8(w))}?=`).join('\r\n ');
}
function mime(mail: OutgoingMail): string {
  const body = encodeBase64(utf8(mail.body.replace(/\r?\n/g, '\r\n'))).replace(/.{76}/g, '$&\r\n');
  return [`To: ${mail.to.join(', ')}`, `Subject: ${headerText(mail.subject)}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
}
/** Sends one message at a time from the signed-in Gmail, each only after its own approval. Needs `gmail.send`. */
export class MailSender extends Gmail {
  private approve: MailApproval;
  constructor(credential: MailCredential, approve: MailApproval, options: MailSenderOptions = {}) {
    super('MailSender', credential, options);
    if (typeof approve !== 'function') throw new TypeError('MailSender needs an approval function');
    this.approve = approve;
  }
  /** Asks the approval with the frozen message, then sends it once. Never retried: a failed send asks again. */
  async send(draft: MailDraft, options: MailSendOptions = {}): Promise<SentMail> {
    const mail = outgoing(draft);
    options.signal?.throwIfAborted();
    let approved: unknown;
    try {
      approved = await this.approve(mail);
    } catch (cause) {
      throw new MailError('denied', 'mail send was not approved', { cause });
    }
    if (approved !== true) throw new MailError('denied', 'mail send was not approved');
    const raw = encodeBase64(utf8(mime(mail))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const json = await this.call('/messages/send', {}, options.signal, { raw });
    if (!isRecord(json)) throw mailShape('sent');
    const labels = json.labelIds;
    return { id: field(json.id, 'id'), threadId: field(json.threadId, 'threadId'),
      labelIds: Array.isArray(labels) && labels.every(v => typeof v === 'string') ? [...labels] : [] };
  }
}
