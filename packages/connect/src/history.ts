// Owner-bound mail history and export. The credential (a Connection) stays the
// only authentication; every call names its principal and anything but the bound
// owner is denied before any provider fetch. Sends are out of scope.
import { MailReader, MailError, type MailCredential, type MailEnvelope, type MailReaderOptions } from './mail.ts';

export type HistoryFormat = 'json' | 'csv';
export type HistoryErrorCode = 'denied' | 'invalid' | 'network' | 'signed-out' | 'rate-limited';
export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  readonly status?: number;
  readonly until?: number;
  constructor(code: HistoryErrorCode, message: string, o: { status?: number; until?: number; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'HistoryError'; this.code = code;
    if (o.status !== undefined) this.status = o.status;
    if (o.until !== undefined) this.until = o.until;
  }
}
export interface MailHistoryOptions extends MailReaderOptions {
  /** Person the host seated this credential for; all other principals are denied. */
  owner: string;
}
export interface HistoryQuery {
  principal: string;
  /** Gmail search syntax; absent lists recent mail. */
  query?: string;
  /** Envelopes collected across pages, default 100, at most 500. */
  maxMessages?: number;
  /** Provider page size, 1..500, default 20. */
  pageSize?: number;
  signal?: AbortSignal;
}
export interface HistoryExportQuery extends HistoryQuery {
  format: HistoryFormat;
}
const MAX_MESSAGES = 500;
const int = (value: number | undefined, fallback: number, what: string): number => {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > MAX_MESSAGES) throw new RangeError(`mail history ${what} is 1..500`);
  return n;
};
const cell = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
function toCsv(rows: MailEnvelope[]): string {
  const lines = ['id,threadId,subject,from,to,date,snippet,labelIds'];
  for (const m of rows) lines.push([m.id, m.threadId, m.subject, m.from, m.to, m.date, m.snippet, m.labelIds.join('|')].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
export class MailHistory {
  private reader: MailReader;
  private owner: string;
  constructor(credential: MailCredential, options: MailHistoryOptions) {
    if (!credential || typeof credential.token !== 'function') throw new TypeError('mail history needs a credential with token()');
    if (!options || typeof options.owner !== 'string' || !options.owner.trim()) throw new TypeError('mail history needs a non-empty owner');
    this.owner = options.owner; this.reader = new MailReader(credential, options);
  }
  private allow(principal: unknown): string {
    if (typeof principal !== 'string' || !principal) throw new TypeError('mail history needs a non-empty principal');
    if (principal !== this.owner) throw new HistoryError('denied', 'mail history is not shared with this principal');
    return principal;
  }
  /** Envelopes across pages, oldest page token first, cut at `maxMessages`. */
  async messages(query: HistoryQuery): Promise<MailEnvelope[]> {
    this.allow(query?.principal);
    const { query: q, signal } = query ?? {};
    if (q !== undefined && (typeof q !== 'string' || !q.trim())) throw new TypeError('mail history needs a non-empty query');
    const max = int(query?.maxMessages, 100, 'maxMessages'), size = int(query?.pageSize, 20, 'pageSize');
    const rows: MailEnvelope[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const page = q ? await this.reader.search(q.trim(), { maxResults: size, ...(pageToken ? { pageToken } : {}), ...(signal ? { signal } : {}) })
          : await this.reader.list({ maxResults: size, ...(pageToken ? { pageToken } : {}), ...(signal ? { signal } : {}) });
        rows.push(...page.messages);
        pageToken = rows.length < max ? page.nextPageToken : undefined;
      } while (pageToken);
    } catch (error) {
      if (error instanceof MailError) throw new HistoryError(error.code, `mail history ${error.code === 'signed-out' ? 'sign-in is gone or refused' : 'provider failed'}`, { ...(error.status !== undefined ? { status: error.status } : {}), ...(error.until !== undefined ? { until: error.until } : {}) });
      throw error;
    }
    return rows.slice(0, max);
  }
  /** `json` array or `csv` rows of the same envelopes; bodies are never exported. */
  async export(query: HistoryExportQuery): Promise<string> {
    if (query?.format !== 'json' && query?.format !== 'csv') throw new TypeError('mail history export format is json or csv');
    const rows = await this.messages(query);
    return query.format === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows);
  }
}
