const redactCredentials = (value: unknown) => String(value ?? '')
    .normalize('NFKC')
    .replace(/["'](?:[A-Za-z][A-Za-z0-9]*_)*(?:api[_-]?key|access[_-]?token|token|secret|password)["']\s*[:=]\s*["']?[^"'{}\s,;]+["']?/gi, '[credential redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [redacted]')
    .replace(/\b(?:[A-Za-z][A-Za-z0-9]*_)+(?:api_key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]')
    .replace(/\b((?:api[_-]?)?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[credential redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi, '[credential redacted]');

export const cleanProse = (value: unknown, fallback: string, max: number, redact: RegExp[] = []) => {
    const clean = redact.reduce((text, pattern) => text.replace(pattern, '[hidden]'), redactCredentials(value))
        .replace(/(?<![A-Za-z0-9_/])\/(?!\/)(?:[^\s\/<>"']+\/)+[^\s\/<>"']+/gm, '[path hidden]')
        .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s,;]*/g, '[path hidden]')
        .replace(/[\u0000-\u001F\u007F<>`{}\\/]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, max);
    return clean || fallback;
};

/**
 * The provider explains a refusal in the HTTP body; the close code does not.
 * An out-of-credits 403 is otherwise indistinguishable from a dropped network,
 * and reporting only the code costs a debugging session to rediscover.
 */
export function providerRefusal(status: number | undefined, body: string, redact: RegExp[] = []) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.error === 'string') detail = parsed.error;
        else if (typeof parsed?.error?.message === 'string') detail = parsed.error.message;
        else if (typeof parsed?.error?.status === 'string') detail = parsed.error.status;
        else if (typeof parsed?.code === 'string') detail = parsed.code;
    } catch { /* not JSON: fall back to the raw body */ }
    if (detail === '') detail = body.trim();
    const safe = cleanProse(detail, '', 300, redact);
    return safe === ''
        ? `Voice provider refused the connection (HTTP ${status}).`
        : `Voice provider refused the connection (HTTP ${status}): ${safe}`;
}

