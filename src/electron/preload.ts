/**
 * HiredFinally preload
 *
 * Triggers:
 *   1. Page load
 *   2. URL change (pushState / replaceState / popstate)
 *   3. DOM mutation — form/file/overlay appeared
 *   4. Poll every 2s — catches SPA modals, multi-step forms, toast notifications
 *
 * Performance notes:
 *   - Page-load send is deferred until document.readyState === 'complete' so
 *     we never analyse a half-painted page.
 *   - The poll interval is 2 s (was 1.5 s) — still fast enough to catch modal
 *     overlays while reducing unnecessary IPC chatter.
 *   - scheduleSend deduplicates rapid-fire triggers so only one payload is
 *     sent per burst.
 */

console.log('[PRELOAD] Loading...');

const { ipcRenderer } = require('electron');

let lastSentUrl = '';
let sendTimer:   ReturnType<typeof setTimeout> | null = null;
let visionTimer: ReturnType<typeof setTimeout> | null = null;

interface SignalSnapshot {
    url:                  string;
    formCount:            number;
    inputCount:           number;
    fileInputCount:       number;
    selectCount:          number;
    textareaCount:        number;
    requiredFieldCount:   number;
    hasProgressIndicator: boolean;
    hasSubmitButton:      boolean;
    hasApplyButton:       boolean;
    hasCompletionText:    boolean;
    hasResumeUpload:      boolean;
    hasOverlay:           boolean;
    buttonFingerprint:    string;
}

let lastSnapshot: SignalSnapshot | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBodyText(): string {
    return document.body?.innerText || '';
}

/**
 * Returns only the text from elements visible in the viewport.
 * Used by Ollama so it sees exactly what the user sees.
 */
function getVisibleText(): string {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        null
    );

    const visibleParts: string[] = [];
    const seen = new Set<Element>();

    let node = walker.nextNode() as Element | null;
    while (node) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            node = walker.nextNode() as Element | null;
            continue;
        }

        const tag = node.tagName?.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') {
            node = walker.nextNode() as Element | null;
            continue;
        }

        const rect = node.getBoundingClientRect();

        if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < vh &&
            rect.right > 0 &&
            rect.left < vw
        ) {
            const childElementCount = node.children?.length ?? 0;
            if (childElementCount === 0 || node.childElementCount === 0) {
                const text = (node as HTMLElement).innerText?.trim();
                if (text && text.length > 0 && !seen.has(node)) {
                    seen.add(node);
                    visibleParts.push(text);
                }
            }
        }

        node = walker.nextNode() as Element | null;
    }

    return visibleParts
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getButtonTexts(): string[] {
    const buttons = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button, input[type="submit"], input[type="button"]'
    );
    return Array.from(buttons)
        .map(b => (b.innerText || b.value || '').toLowerCase().trim())
        .filter(t => t.length > 0 && t.length < 60);
}

/**
 * Detect a visible Apply / Easy Apply / Quick Apply / Apply Now button.
 *
 * This is used in main.ts to gate the NOT_STARTED → IN_PROGRESS transition:
 * if such a button is present, the page is a job detail page, not a form.
 *
 * Checks both button text AND common aria-label patterns so it works on
 * sites that render icon-only buttons (e.g. some newer ATS portals).
 */
function detectApplyButton(): boolean {
    const APPLY_PATTERNS = [
        'apply now', 'easy apply', 'quick apply',
        'apply for this job', 'apply for job',
        'apply to this job', 'apply for this position',
        'start application', 'begin application',
        'apply on', 'apply at', 'apply externally',
        'apply with', 'apply on handshake',
        'continue to application',
    ];

    // Check all interactive elements that could be an apply trigger
    const candidates = document.querySelectorAll<HTMLElement>(
        'button, a[role="button"], a.apply, [data-testid*="apply"], ' +
        '[aria-label*="apply" i], [class*="apply-btn" i], [class*="applyBtn" i], ' +
        'input[type="submit"], input[type="button"]'
    );

    for (const el of Array.from(candidates)) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const text      = (el.innerText || (el as HTMLInputElement).value || '').toLowerCase().trim();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined  = `${text} ${ariaLabel}`;

        if (APPLY_PATTERNS.some(p => combined.includes(p))) return true;
    }

    return false;
}

function detectOverlay(): boolean {
    const overlaySelectors = [
        '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
        '.modal', '.drawer', '.overlay', '.sheet', '.panel',
        '[class*="modal"]', '[class*="drawer"]', '[class*="overlay"]',
        '[class*="slide-over"]', '[class*="dialog"]',
        '[data-testid*="modal"]', '[data-testid*="drawer"]', '[data-testid*="overlay"]',
    ];
    for (const sel of overlaySelectors) {
        try {
            const el = document.querySelector(sel);
            if (el) {
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return true;
                }
            }
        } catch { /* invalid selector */ }
    }
    return false;
}

function detectResumeUpload(): boolean {
    const bodyLower = getBodyText().toLowerCase();
    const resumeKeywords = [
        'upload resume', 'attach resume', 'upload cv', 'attach cv',
        'upload your resume', 'drop your resume', 'drop resume here',
        'choose a resume', 'select a resume', 'drag and drop',
        'supported file types', 'pdf, doc', '.pdf .doc',
    ];
    if (resumeKeywords.some(kw => bodyLower.includes(kw))) return true;
    const dropzones = document.querySelectorAll(
        '[class*="dropzone"], [class*="drop-zone"], [class*="file-drop"], ' +
        '[data-testid*="resume"], [data-testid*="upload"], ' +
        'input[type="file"][accept*="pdf"], input[type="file"][accept*="doc"]'
    );
    return dropzones.length > 0;
}

function detectCompletionToast(): boolean {
    const completionPhrases = [
        'application submitted', 'successfully applied', 'application received',
        'application complete', 'you have applied', 'applied successfully',
        'your application was submitted', 'application was received',
    ];
    const toastSelectors = [
        '[role="alert"]', '[role="status"]',
        '[class*="toast"]', '[class*="snackbar"]', '[class*="notification"]',
        '[class*="banner"]', '[class*="alert"]',
        '[data-testid*="toast"]', '[data-testid*="alert"]', '[data-testid*="notification"]',
    ];
    for (const sel of toastSelectors) {
        try {
            const elements = document.querySelectorAll(sel);
            for (const el of Array.from(elements)) {
                const text = (el as HTMLElement).innerText?.toLowerCase() || '';
                if (completionPhrases.some(p => text.includes(p))) return true;
            }
        } catch { /* skip */ }
    }
    const bodyLower = getBodyText().toLowerCase();
    return completionPhrases.some(p => bodyLower.includes(p));
}

// ── Collect full page signals ─────────────────────────────────────────────────
function collectSignals() {
    const forms      = document.querySelectorAll('form');
    const inputs     = document.querySelectorAll('input:not([type="hidden"])');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const selects    = document.querySelectorAll('select');
    const textareas  = document.querySelectorAll('textarea');
    const buttons    = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button, input[type="submit"], input[type="button"]'
    );
    const required = document.querySelectorAll('[required], [aria-required="true"]');
    const progress = document.querySelectorAll(
        '[class*="progress"], [class*="step"], [id*="progress"], [id*="step"]'
    );
    const hasProgressText = /step \d+ of \d+|page \d+ of \d+/i.test(getBodyText());

    return {
        url:                  window.location.href,
        pageTitle:            document.title || '',
        bodyText:             getBodyText(),
        visibleText:          getVisibleText(),
        formCount:            forms.length,
        inputCount:           inputs.length,
        fileInputCount:       fileInputs.length,
        selectCount:          selects.length,
        textareaCount:        textareas.length,
        buttonTexts:          Array.from(buttons)
                                .map(b => (b.innerText || b.value || '').toLowerCase().trim())
                                .filter(t => t.length > 0 && t.length < 60),
        hasProgressIndicator: progress.length > 0 || hasProgressText,
        requiredFieldCount:   required.length,
        hasOverlay:           detectOverlay(),
        hasResumeUpload:      detectResumeUpload(),
        hasCompletionToast:   detectCompletionToast(),
        // Forward the apply-button signal so main.ts can gate IN_PROGRESS
        hasApplyButton:       detectApplyButton(),
    };
}

// ── Build snapshot for change comparison ─────────────────────────────────────
function buildSnapshot(signals: ReturnType<typeof collectSignals>): SignalSnapshot {
    const bodyLower = signals.bodyText.toLowerCase();

    const hasSubmitButton = signals.buttonTexts.some(t =>
        t.includes('submit') || t.includes('submit application') ||
        t.includes('send application') || t.includes('finish') ||
        t.includes('complete application')
    );
    const hasApplyButton = signals.hasApplyButton;
    const hasCompletionText = signals.hasCompletionToast || [
        'application submitted', 'application received', 'thank you for applying',
        'thanks for applying', 'successfully applied', 'submission confirmed',
        'your application has been submitted', 'we have received your application',
        'application complete',
    ].some(p => bodyLower.includes(p));

    return {
        url:                  signals.url,
        formCount:            signals.formCount,
        inputCount:           signals.inputCount,
        fileInputCount:       signals.fileInputCount,
        selectCount:          signals.selectCount,
        textareaCount:        signals.textareaCount,
        requiredFieldCount:   signals.requiredFieldCount,
        hasProgressIndicator: signals.hasProgressIndicator,
        hasSubmitButton,
        hasApplyButton,
        hasCompletionText,
        hasResumeUpload:      signals.hasResumeUpload,
        hasOverlay:           signals.hasOverlay,
        buttonFingerprint:    signals.buttonTexts.slice(0, 8).join('|'),
    };
}

// ── Detect meaningful change ──────────────────────────────────────────────────
function hasMeaningfulChange(prev: SignalSnapshot, next: SignalSnapshot): string | null {
    if (prev.url !== next.url)                                    return `url changed`;
    if (prev.formCount !== next.formCount)                        return `forms: ${prev.formCount}→${next.formCount}`;
    if (prev.requiredFieldCount !== next.requiredFieldCount)      return `required: ${prev.requiredFieldCount}→${next.requiredFieldCount}`;
    if (prev.fileInputCount !== next.fileInputCount)              return `files: ${prev.fileInputCount}→${next.fileInputCount}`;
    if (prev.hasSubmitButton !== next.hasSubmitButton)            return `submit btn: ${prev.hasSubmitButton}→${next.hasSubmitButton}`;
    if (prev.hasApplyButton && !next.hasApplyButton)              return `apply btn disappeared`;
    if (!prev.hasCompletionText && next.hasCompletionText)        return `completion text appeared`;
    if (!prev.hasProgressIndicator && next.hasProgressIndicator) return `progress appeared`;
    if (!prev.hasOverlay && next.hasOverlay)                      return `overlay appeared`;
    if (prev.hasOverlay && !next.hasOverlay)                      return `overlay closed`;
    if (!prev.hasResumeUpload && next.hasResumeUpload)            return `resume upload appeared`;
    if (Math.abs(next.inputCount - prev.inputCount) >= 4)        return `inputs: ${prev.inputCount}→${next.inputCount}`;
    if (prev.textareaCount !== next.textareaCount)                return `textareas: ${prev.textareaCount}→${next.textareaCount}`;
    if (prev.buttonFingerprint !== next.buttonFingerprint &&
        (next.hasSubmitButton || next.requiredFieldCount > 0 || next.hasOverlay))
                                                                  return `buttons changed on form/overlay`;
    return null;
}

// ── Send to main process ──────────────────────────────────────────────────────
function sendPageData(reason: string): void {
    // Guard: don't send if the page isn't fully loaded yet
    if (document.readyState !== 'complete') {
        scheduleSend(reason + ':readyState-wait', 500);
        return;
    }

    try {
        const data = collectSignals();
        console.log(
            `[PRELOAD] Sending (${reason}) url=${data.url} ` +
            `title="${data.pageTitle}" forms=${data.formCount} inputs=${data.inputCount} ` +
            `applyBtn=${data.hasApplyButton} visibleChars=${data.visibleText.length}`
        );
        ipcRenderer.sendToHost('page-data', data);
        lastSentUrl  = data.url;
        lastSnapshot = buildSnapshot(data);
    } catch (err) {
        console.error('[PRELOAD ERROR]', err);
    }
}

function scheduleSend(reason: string, delayMs: number): void {
    clearTimeout(sendTimer ?? undefined);
    sendTimer = setTimeout(() => sendPageData(reason), delayMs);
}

// ── Trigger 1: Page load ──────────────────────────────────────────────────────
// Wait for document.readyState === 'complete' before sending so we never
// analyse a partially-rendered page. Reduced initial delay from 2000 ms.
function onPageReady(reason: string): void {
    if (document.readyState === 'complete') {
        scheduleSend(reason, 300);
    } else {
        window.addEventListener('load', () => scheduleSend(reason, 300), { once: true });
    }
}

window.addEventListener('DOMContentLoaded', () => onPageReady('DOMContentLoaded'));
window.addEventListener('load',             () => scheduleSend('page-load', 300), { once: true });

// ── Trigger 2: URL change ─────────────────────────────────────────────────────
function onUrlChange(): void {
    const current = window.location.href;
    if (current !== lastSentUrl) {
        console.log(`[PRELOAD] URL: ${lastSentUrl} → ${current}`);
        // Wait for the page to settle after a SPA navigation before reading DOM
        scheduleSend('url-change', 800);
    }
}

const origPush    = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState    = function(...args: Parameters<typeof history.pushState>)    { origPush(...args);    onUrlChange(); };
history.replaceState = function(...args: Parameters<typeof history.replaceState>) { origReplace(...args); onUrlChange(); };
window.addEventListener('popstate', onUrlChange);

// ── Trigger 3: DOM mutation ───────────────────────────────────────────────────
let lastFormCount = 0;
let lastFileCount = 0;

const observer = new MutationObserver(() => {
    clearTimeout(visionTimer ?? undefined);
    visionTimer = setTimeout(() => {
        const forms  = document.querySelectorAll('form').length;
        const files  = document.querySelectorAll('input[type="file"]').length;
        const inputs = document.querySelectorAll('input:not([type="hidden"])').length;
        const newFileInput = files > lastFileCount;
        const formAppeared = forms > lastFormCount && inputs > 3;
        if (newFileInput || formAppeared) {
            console.log(`[PRELOAD] DOM: forms ${lastFormCount}→${forms}, files ${lastFileCount}→${files}`);
            scheduleSend('dom-mutation', 500);
        }
        lastFormCount = forms;
        lastFileCount = files;
    }, 300);
});

if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
} else {
    document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

// ── Trigger 4: Poll at 2s ─────────────────────────────────────────────────────
// 2 s is still fast enough to catch SPA overlays and toast notifications,
// while reducing unnecessary IPC traffic vs the previous 1.5 s interval.
setInterval(() => {
    try {
        if (document.readyState !== 'complete') return; // skip polls on loading pages
        const signals = collectSignals();
        const snap    = buildSnapshot(signals);
        if (lastSnapshot === null) { lastSnapshot = snap; return; }
        const changeReason = hasMeaningfulChange(lastSnapshot, snap);
        if (changeReason) {
            console.log(`[PRELOAD] Poll: ${changeReason}`);
            sendPageData(`poll:${changeReason}`);
        }
    } catch { /* silent */ }
}, 2000);

console.log('[PRELOAD] Ready — triggers: DOMContentLoaded, page-load, url-change, dom-mutation, poll(2s)');