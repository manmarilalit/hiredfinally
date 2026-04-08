/**
 * email-parser.ts
 *
 * Parses job application update emails using qwen2.5:3b (text model).
 * Runs entirely offline — requires Ollama running at localhost:11434.
 *
 * Accepts a normalized EmailMessage (from email-fetcher.ts) and returns
 * a ParsedJobEmail with a status classification and a short summary.
 *
 * Same queue/retry architecture as extractor.ts.
 */

const OLLAMA_URL  = 'http://localhost:11434/api/generate';
const MODEL       = 'qwen2.5:3b';
const TIMEOUT_MS  = 60_000;
const MAX_RETRIES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

type JobApplicationStatus =
    | 'APPLIED'        // confirmation of submission
    | 'UNDER_REVIEW'   // application received / being reviewed
    | 'INTERVIEW'      // interview invite or scheduling
    | 'OFFER'          // job offer received
    | 'REJECTED'       // rejection / no longer in consideration
    | 'WITHDRAWN'      // candidate withdrew
    | 'NOT_JOB_EMAIL'; // unrelated email — skip

interface EmailMessage {
    id:        string;
    from:      string;
    subject:   string;
    bodyText:  string;  // plain text body (strip HTML before passing)
    receivedAt: string; // ISO 8601
    provider:  'gmail' | 'outlook';
}

interface ParsedJobEmail {
    emailId:   string;
    status:    JobApplicationStatus;
    company:   string;
    jobTitle:  string;
    summary:   string;          // 1-2 sentence human-readable summary
    receivedAt: string;
    provider:  'gmail' | 'outlook';
    raw:       EmailMessage;
}

// ─── Queue (identical pattern to extractor.ts) ────────────────────────────────

type QueueItem = {
    fn:      () => Promise<ParsedJobEmail | null>;
    resolve: (v: ParsedJobEmail | null) => void;
};

const queue: QueueItem[] = [];
let queueRunning = false;

async function drainQueue(): Promise<void> {
    if (queueRunning) return;
    queueRunning = true;
    while (queue.length > 0) {
        const item = queue.shift()!;
        try {
            item.resolve(await item.fn());
        } catch {
            item.resolve(null);
        }
    }
    queueRunning = false;
}

function enqueue(fn: () => Promise<ParsedJobEmail | null>): Promise<ParsedJobEmail | null> {
    return new Promise(resolve => {
        queue.push({ fn, resolve });
        drainQueue();
    });
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(email: EmailMessage): string {
    // Truncate body to keep the context window manageable for a 3b model
    const body = email.bodyText.slice(0, 1_500);

    return `You are parsing a job application email. Extract structured data from the email below.

FROM: ${email.from}
SUBJECT: ${email.subject}
BODY:
${body}

Rules:
- Return ONLY valid JSON, no markdown, no code fences, no explanation
- "status" must be exactly one of: APPLIED, UNDER_REVIEW, INTERVIEW, OFFER, REJECTED, WITHDRAWN, NOT_JOB_EMAIL
- "company" is the hiring company name (not a recruiting platform like LinkedIn or Indeed)
- "jobTitle" is the role being applied for — use empty string if not mentioned
- "summary" is 1-2 sentences describing what this email says about the application
- If this email has nothing to do with a job application, set status to NOT_JOB_EMAIL and leave other fields empty

Respond with this exact shape:
{"status":"...","company":"...","jobTitle":"...","summary":"..."}`;
}

// ─── Ollama call ──────────────────────────────────────────────────────────────

async function attemptParse(email: EmailMessage): Promise<ParsedJobEmail | null> {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(OLLAMA_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
            model:  MODEL,
            prompt: buildPrompt(email),
            stream: false,
            options: {
                temperature:    0.0,
                num_predict:    200,
                top_p:          0.9,
                repeat_penalty: 1.1,
            },
        }),
    });

    clearTimeout(timeout);
    if (!response.ok) return null;

    const data      = await response.json();
    const raw: string = (data.response || '').trim();

    // Strip any accidental markdown fences
    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    const status    = sanitizeStatus(parsed.status);
    const company   = sanitizeString(parsed.company);
    const jobTitle  = sanitizeString(parsed.jobTitle);
    const summary   = sanitizeString(parsed.summary, 400);

    return {
        emailId:    email.id,
        status,
        company,
        jobTitle,
        summary,
        receivedAt: email.receivedAt,
        provider:   email.provider,
        raw:        email,
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a single email. Returns null if Ollama is unavailable or parsing fails.
 * Queues requests so the model isn't hammered in parallel.
 */
async function parseJobEmail(email: EmailMessage): Promise<ParsedJobEmail | null> {
    return enqueue(async () => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, attempt * 5_000));
            }
            try {
                const result = await attemptParse(email);
                if (result !== null) return result;
            } catch {
                if (attempt === MAX_RETRIES) return null;
            }
        }
        return null;
    });
}

/**
 * Parse a batch of emails. Non-job emails are filtered out automatically.
 * Results maintain chronological order (newest first).
 */
async function parseJobEmails(emails: EmailMessage[]): Promise<ParsedJobEmail[]> {
    const results = await Promise.all(emails.map(parseJobEmail));
    return results
        .filter((r): r is ParsedJobEmail => r !== null && r.status !== 'NOT_JOB_EMAIL')
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
}

/**
 * Check that Ollama is running and the model is available.
 */
async function checkOllamaAvailable(): Promise<boolean> {
    try {
        const res = await fetch('http://localhost:11434/api/tags', {
            signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) return false;
        const data         = await res.json();
        const models: string[] = (data.models || []).map((m: any) => m.name as string);
        const modelPrefix  = MODEL.split(':')[0] ?? MODEL;
        return models.some(m => m.startsWith(modelPrefix));
    } catch {
        return false;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set<JobApplicationStatus>([
    'APPLIED', 'UNDER_REVIEW', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'NOT_JOB_EMAIL',
]);

function sanitizeStatus(val: unknown): JobApplicationStatus {
    if (typeof val === 'string' && VALID_STATUSES.has(val as JobApplicationStatus)) {
        return val as JobApplicationStatus;
    }
    return 'NOT_JOB_EMAIL';
}

function sanitizeString(val: unknown, maxLen = 120): string {
    if (typeof val !== 'string') return '';
    return val.trim().slice(0, maxLen);
}

module.exports = { parseJobEmail, parseJobEmails, checkOllamaAvailable };
