/**
 * extractor.ts
 *
 * Extracts job title + company from a screenshot using qwen2.5vl:3b (vision model).
 * Runs entirely offline — requires Ollama running at localhost:11434.
 *
 * The screenshot is a compressed JPEG of the visible webview at the moment
 * the user was viewing the job listing. The vision model can see the full
 * page layout including which job is selected/expanded, making it much more
 * accurate than text extraction.
 */

const OLLAMA_URL  = 'http://localhost:11434/api/generate';
const MODEL       = 'qwen2.5vl:3b';
const TIMEOUT_MS  = 1_800_000;
const MAX_RETRIES = 3;

type QueueItem = { fn: () => Promise<ExtractedMeta | null>; resolve: (v: ExtractedMeta | null) => void };
const queue: QueueItem[] = [];
let queueRunning = false;

async function drainQueue(): Promise<void> {
    if (queueRunning) return;
    queueRunning = true;
    while (queue.length > 0) {
        const item = queue.shift()!;
        try {
            const result = await item.fn();
            item.resolve(result);
        } catch {
            item.resolve(null);
        }
    }
    queueRunning = false;
}

function enqueue(fn: () => Promise<ExtractedMeta | null>): Promise<ExtractedMeta | null> {
    return new Promise(resolve => {
        queue.push({ fn, resolve });
        drainQueue();
    });
}

interface ExtractedMeta {
    jobTitle: string;
    company:  string;
}

const PROMPT = `This is a screenshot of a job listing page. Extract the job title and company name of the job being viewed.

Rules:
- Return ONLY valid JSON: {"jobTitle":"...","company":"..."}
- Use empty string if you cannot determine a value
- The job title is a role name like "Software Engineer", "Registered Behavior Technician", "Marketing Manager"
- The company is the employer name like "Google", "Centria Autism", "Panda Express"
- If multiple jobs are visible, extract the one that is most prominently displayed or expanded on screen
- Remove suffixes like "| LinkedIn", "| Indeed", "- Jobs" from values
- No markdown, no code fences, no explanation — only the JSON object`;

async function attemptExtraction(
    screenshotBase64: string,
): Promise<ExtractedMeta | null> {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(OLLAMA_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
            model:  MODEL,
            prompt: PROMPT,
            images: [screenshotBase64],
            stream: false,
            options: {
                temperature:    0.0,
                num_predict:    80,
                top_p:          0.9,
                repeat_penalty: 1.1,
            },
        }),
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data        = await response.json();
    const raw: string = (data.response || '').trim();

    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed   = JSON.parse(jsonMatch[0]);
    const jobTitle = sanitize(parsed.jobTitle);
    const company  = sanitize(parsed.company);

    if (!jobTitle && !company) return null;

    return { jobTitle, company };
}

async function extractJobMeta(
    screenshot: Buffer,
    url: string
): Promise<ExtractedMeta | null> {
    return enqueue(async () => {
        const base64 = screenshot.toString('base64');

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const waitSec = attempt * 5;
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }
            try {
                const result = await attemptExtraction(base64);
                if (result !== null) return result;
                return null;
            } catch {
                if (attempt === MAX_RETRIES) return null;
            }
        }
        return null;
    });
}

async function checkOllamaAvailable(): Promise<boolean> {
    try {
        const res = await fetch('http://localhost:11434/api/tags', {
            signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
            const data        = await res.json();
            const models: string[] = (data.models || []).map((m: any) => m.name as string);
            const modelPrefix = MODEL.split(':')[0] ?? MODEL;
            return models.some(m => m.startsWith(modelPrefix));
        }
        return false;
    } catch {
        return false;
    }
}

function sanitize(val: unknown): string {
    if (typeof val !== 'string') return '';
    return val
        .trim()
        .replace(/\s*[|\-–—]\s*(linkedin|indeed|glassdoor|handshake|ziprecruiter|monster|dice|wellfound|jobs?)\s*$/i, '')
        .trim()
        .slice(0, 120);
}

module.exports = { extractJobMeta, checkOllamaAvailable };