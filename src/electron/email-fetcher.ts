/**
 * email-fetcher.ts
 *
 * Fetches recent emails from Gmail (via Google API) and/or Outlook (via
 * Microsoft Graph API) and normalizes them into a shared EmailMessage shape
 * for email-parser.ts to consume.
 *
 * Auth tokens are passed in by the caller — this module does not handle
 * OAuth flows. Wire those up in your main/ipcMain handlers.
 *
 * Usage:
 *   const emails = await fetchJobEmails({ gmailToken, outlookToken });
 *   const parsed = await parseJobEmails(emails);
 */



// ─── Types (mirrored from email-parser.ts) ────────────────────────────────────

interface EmailMessage {
    id: string;
    from: string;
    subject: string;
    bodyText: string;
    receivedAt: string;
    provider: 'gmail' | 'outlook';
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** How many emails to pull per provider per sync. Keep low for a 3b model. */
const MAX_EMAILS_PER_PROVIDER = 30;

/**
 * Gmail search query — narrows fetch to job-related mail only so the LLM
 * isn't wasting time on newsletters or receipts.
 */
const GMAIL_QUERY =
    'subject:(application OR interview OR offer OR "thank you for applying" OR "we regret" OR "next steps" OR "your application" OR "moved forward" OR "not moving forward")';

/** Microsoft Graph filter — equivalent subject keyword filter */
const GRAPH_SUBJECT_FILTER = [
    'application',
    'interview',
    'offer',
    'thank you for applying',
    'we regret',
    'next steps',
    'your application',
    'moved forward',
    'not moving forward',
].map(k => `contains(subject,'${k}')`).join(' or ');

// ─── Types ────────────────────────────────────────────────────────────────────

interface FetchOptions {
    gmailToken?: string;  // OAuth access token for Gmail
    outlookToken?: string;  // OAuth access token for Microsoft Graph
    maxPerProvider?: number;
}

// ─── HTML → plain text ────────────────────────────────────────────────────────

function stripHtml(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

async function fetchGmailEmails(
    accessToken: string,
    max: number,
): Promise<EmailMessage[]> {
    // 1. Search for matching message IDs
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', GMAIL_QUERY);
    listUrl.searchParams.set('maxResults', String(max));

    const listRes = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);

    const listData = await listRes.json();
    const messages: { id: string }[] = listData.messages || [];

    // 2. Fetch each message in parallel (format=metadata for fast first pass)
    const results = await Promise.all(
        messages.map(m => fetchGmailMessage(accessToken, m.id)),
    );

    return results.filter((m): m is EmailMessage => m !== null);
}

async function fetchGmailMessage(
    accessToken: string,
    id: string,
): Promise<EmailMessage | null> {
    try {
        const res = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!res.ok) return null;

        const msg = await res.json();
        const headers: { name: string; value: string }[] = msg.payload?.headers || [];

        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const dateHeader = headers.find(h => h.name === 'Date')?.value || '';
        const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

        const bodyText = extractGmailBody(msg.payload);

        return { id, from, subject, bodyText, receivedAt, provider: 'gmail' };
    } catch {
        return null;
    }
}

function extractGmailBody(payload: any): string {
    if (!payload) return '';

    // Prefer plain text part
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }

    // Fall back to HTML, then strip tags
    if (payload.mimeType === 'text/html' && payload.body?.data) {
        const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
        return stripHtml(html);
    }

    // Recurse into multipart
    if (payload.parts && Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
            const text = extractGmailBody(part);
            if (text) return text;
        }
    }

    return '';
}

// ─── Outlook / Microsoft Graph ────────────────────────────────────────────────

async function fetchOutlookEmails(
    accessToken: string,
    max: number,
): Promise<EmailMessage[]> {
    const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
    url.searchParams.set('$filter', GRAPH_SUBJECT_FILTER);
    url.searchParams.set('$top', String(max));
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$select', 'id,subject,from,receivedDateTime,body');

    const res = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
    });
    if (!res.ok) throw new Error(`Outlook fetch failed: ${res.status}`);

    const data = await res.json();
    const items = data.value || [];

    return items.map((item: any): EmailMessage => {
        const bodyContent: string = item.body?.content || '';
        const bodyText = item.body?.contentType === 'html'
            ? stripHtml(bodyContent)
            : bodyContent;

        return {
            id: item.id,
            from: item.from?.emailAddress?.address || '',
            subject: item.subject || '(no subject)',
            bodyText,
            receivedAt: item.receivedDateTime || new Date().toISOString(),
            provider: 'outlook',
        };
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch recent job-related emails from Gmail and/or Outlook.
 * Pass whichever tokens are available — omitting a token skips that provider.
 * Returns a combined, deduped list sorted newest-first.
 */
async function fetchJobEmails(opts: FetchOptions): Promise<EmailMessage[]> {
    const max = opts.maxPerProvider ?? MAX_EMAILS_PER_PROVIDER;
    const fetches: Promise<EmailMessage[]>[] = [];

    if (opts.gmailToken) {
        fetches.push(
            fetchGmailEmails(opts.gmailToken, max).catch(err => {
                console.error('[email-fetcher] Gmail error:', err);
                return [];
            }),
        );
    }

    if (opts.outlookToken) {
        fetches.push(
            fetchOutlookEmails(opts.outlookToken, max).catch(err => {
                console.error('[email-fetcher] Outlook error:', err);
                return [];
            }),
        );
    }

    const batches = await Promise.all(fetches);
    const combined = batches.flat();

    // Sort newest first
    combined.sort(
        (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );

    return combined;
}

module.exports = { fetchJobEmails };