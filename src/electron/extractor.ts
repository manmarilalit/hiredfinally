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

const DEBUG = process.env['EXTRACTOR_DEBUG'] === '1' || false;

function dbg(...args: unknown[]): void {
    if (DEBUG) console.log('[EXTRACTOR:DBG]', ...args);
}

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
        const queuePos = queue.length + (queueRunning ? 1 : 0);
        if (queuePos > 0) {
            console.log(`[EXTRACTOR] Queued (position ${queuePos}) — Ollama is busy with a previous job`);
        }
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
    url: string
): Promise<ExtractedMeta | null> {
    console.log('[EXTRACTOR] ──────────────────────────────────────────────────');
    console.log(`[EXTRACTOR] → Sending screenshot to Ollama (model: ${MODEL})`);
    console.log(`[EXTRACTOR] → URL:            ${url}`);
    console.log(`[EXTRACTOR] → Image size:     ${Math.round(screenshotBase64.length * 0.75 / 1024)}KB (base64: ${screenshotBase64.length} chars)`);
    console.log(`[EXTRACTOR] → Timeout:        ${TIMEOUT_MS / 60000} minutes`);

    dbg('─── PROMPT ───');
    dbg(PROMPT);
    dbg('─────────────');

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startMs    = Date.now();

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

    const elapsedMs  = Date.now() - startMs;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.warn(`[EXTRACTOR] ← Ollama HTTP ${response.status} after ${elapsedSec}s: ${errBody.slice(0, 200)}`);
        return null;
    }

    const data        = await response.json();
    const raw: string = (data.response || '').trim();

    console.log(`[EXTRACTOR] ← Raw response (${elapsedSec}s): ${raw}`);
    dbg(`← Full Ollama response: ${JSON.stringify(data, null, 2)}`);

    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.warn(`[EXTRACTOR] ← No JSON found in response after ${elapsedSec}s: "${raw.slice(0, 120)}"`);
        return null;
    }

    const parsed   = JSON.parse(jsonMatch[0]);
    const jobTitle = sanitize(parsed.jobTitle);
    const company  = sanitize(parsed.company);

    if (!jobTitle && !company) {
        console.log(`[EXTRACTOR] ← Both fields empty after ${elapsedSec}s — skipping`);
        return null;
    }

    console.log(`[EXTRACTOR] ✓  Completed in ${elapsedSec}s  (${(elapsedMs / 1000 / 60).toFixed(2)} min)`);
    console.log(`[EXTRACTOR] ✓  title="${jobTitle}"  company="${company}"`);
    console.log('[EXTRACTOR] ──────────────────────────────────────────────────');
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
                const waitSec = attempt * 5; // 5s, 10s, 15s... gives Ollama time to warm up
                console.log(`[EXTRACTOR] Retrying in ${waitSec}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }
            try {
                const result = await attemptExtraction(base64, url);
                if (result !== null) return result;
                return null;
            } catch (err: any) {
                const isLast     = attempt === MAX_RETRIES;
                const timeoutMin = TIMEOUT_MS / 60000;
                if (err?.name === 'AbortError') {
                    console.warn(`[EXTRACTOR] ✗ Timeout after ${timeoutMin}min${isLast ? ' — giving up' : ' — will retry'}`);
                } else if (err?.code === 'ECONNREFUSED') {
                    console.warn(`[EXTRACTOR] ✗ Ollama not running${isLast ? ' — giving up' : ' — will retry'}`);
                } else {
                    console.warn(`[EXTRACTOR] ✗ Error: ${err?.message || err}${isLast ? ' — giving up' : ' — will retry'}`);
                }
                if (isLast) return null;
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
            const data    = await res.json();
            const models: string[] = (data.models || []).map((m: any) => m.name as string);
            const modelPrefix = MODEL.split(':')[0] ?? MODEL;
            const hasModel    = models.some(m => m.startsWith(modelPrefix));
            if (!hasModel) {
                console.warn(`[EXTRACTOR] Ollama running but model "${MODEL}" not found.`);
                console.warn(`[EXTRACTOR] Run: ollama pull ${MODEL}`);
                console.warn(`[EXTRACTOR] Available models: ${models.join(', ') || '(none)'}`);
            } else {
                console.log(`[EXTRACTOR] ✓ Ollama ready — model ${MODEL} available`);
                console.log(`[EXTRACTOR]   Timeout: ${TIMEOUT_MS / 60000} min per request`);
                console.log(`[EXTRACTOR]   Tip: set EXTRACTOR_DEBUG=1 to see full prompt + response`);
            }
            return true;
        }
        return false;
    } catch {
        console.warn('[EXTRACTOR] Ollama not detected — job meta extraction disabled.');
        console.warn('[EXTRACTOR] To enable: install Ollama and run: ollama pull ' + MODEL);
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