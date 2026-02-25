/**
 * HiredFinally preload
 *
 * Triggers:
 *   1. Page load
 *   2. URL change (pushState / replaceState / popstate)
 *   3. DOM mutation — form/file/overlay appeared
 *   4. Poll every 1.5s — catches SPA modals, multi-step forms, toast notifications
 *
 * Poll is 1.5s (not 3s) specifically because Handshake's "Application submitted"
 * toast disappears after ~2-3s. We need to catch it before it vanishes.
 */

console.log('[PRELOAD] Loading...');

const { ipcRenderer } = require('electron');

let lastSentUrl = '';
let sendTimer:   ReturnType<typeof setTimeout> | null = null;
let visionTimer: ReturnType<typeof setTimeout> | null = null;

// ── Snapshot for change detection ─────────────────────────────────────────────
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

function getButtonTexts(): string[] {
    const buttons = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button, input[type="submit"], input[type="button"]'
    );
    return Array.from(buttons)
        .map(b => (b.innerText || b.value || '').toLowerCase().trim())
        .filter(t => t.length > 0 && t.length < 60);
}

/**
 * Detect overlays / drawers / modals that are NOT standard <form> elements.
 * Handshake's resume upload and apply panels are div-based overlays.
 */
function detectOverlay(): boolean {
    // Common overlay/modal/drawer selectors
    const overlaySelectors = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]',
        '.modal',
        '.drawer',
        '.overlay',
        '.sheet',
        '.panel',
        '[class*="modal"]',
        '[class*="drawer"]',
        '[class*="overlay"]',
        '[class*="slide-over"]',
        '[class*="dialog"]',
        // Handshake specific
        '[data-testid*="modal"]',
        '[data-testid*="drawer"]',
        '[data-testid*="overlay"]',
    ];

    for (const sel of overlaySelectors) {
        try {
            const el = document.querySelector(sel);
            if (el) {
                // Make sure it's actually visible (not hidden/display:none)
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return true;
                }
            }
        } catch { /* invalid selector on some pages */ }
    }
    return false;
}

/**
 * Detect resume upload widget — Handshake uses a div-based dropzone, not a
 * standard file input in many cases.
 */
function detectResumeUpload(): boolean {
    const bodyLower = getBodyText().toLowerCase();
    const resumeKeywords = [
        'upload resume', 'attach resume', 'upload cv', 'attach cv',
        'upload your resume', 'drop your resume', 'drop resume here',
        'choose a resume', 'select a resume', 'drag and drop',
        'supported file types', 'pdf, doc', '.pdf .doc',
    ];
    if (resumeKeywords.some(kw => bodyLower.includes(kw))) return true;

    // Also check for file input or dropzone elements
    const dropzones = document.querySelectorAll(
        '[class*="dropzone"], [class*="drop-zone"], [class*="file-drop"], ' +
        '[data-testid*="resume"], [data-testid*="upload"], ' +
        'input[type="file"][accept*="pdf"], input[type="file"][accept*="doc"]'
    );
    return dropzones.length > 0;
}

/**
 * Detect completion toast / confirmation banner.
 * These are short-lived elements — we need to catch them fast.
 */
function detectCompletionToast(): boolean {
    const completionPhrases = [
        'application submitted',
        'successfully applied',
        'application received',
        'application complete',
        'you have applied',
        'applied successfully',
        'your application was submitted',
        'application was received',
    ];

    // Check visible toast/snackbar/notification elements specifically
    const toastSelectors = [
        '[role="alert"]',
        '[role="status"]',
        '[class*="toast"]',
        '[class*="snackbar"]',
        '[class*="notification"]',
        '[class*="banner"]',
        '[class*="alert"]',
        '[data-testid*="toast"]',
        '[data-testid*="alert"]',
        '[data-testid*="notification"]',
    ];

    for (const sel of toastSelectors) {
        try {
            const elements = document.querySelectorAll(sel);
            for (const el of Array.from(elements)) {
                const text = (el as HTMLElement).innerText?.toLowerCase() || '';
                if (completionPhrases.some(p => text.includes(p))) {
                    return true;
                }
            }
        } catch { /* skip invalid selectors */ }
    }

    // Also check the full body text as fallback
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
        bodyText:             getBodyText(),
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
        // Extended signals for overlay/toast detection
        hasOverlay:           detectOverlay(),
        hasResumeUpload:      detectResumeUpload(),
        hasCompletionToast:   detectCompletionToast(),
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
    const hasApplyButton = signals.buttonTexts.some(t =>
        t.includes('apply') || t.includes('easy apply') || t.includes('quick apply')
    );
    const hasCompletionText = signals.hasCompletionToast || [
        'application submitted', 'application received', 'thank you for applying',
        'thanks for applying', 'successfully applied', 'submission confirmed',
        'your application has been submitted', 'we have received your application',
        'application complete',
    ].some(p => bodyLower.includes(p));

    const buttonFingerprint = signals.buttonTexts.slice(0, 8).join('|');

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
        buttonFingerprint,
    };
}

// ── Detect meaningful change ──────────────────────────────────────────────────
function hasMeaningfulChange(prev: SignalSnapshot, next: SignalSnapshot): string | null {
    if (prev.url !== next.url)                                       return `url changed`;
    if (prev.formCount !== next.formCount)                           return `forms: ${prev.formCount}→${next.formCount}`;
    if (prev.requiredFieldCount !== next.requiredFieldCount)         return `required fields: ${prev.requiredFieldCount}→${next.requiredFieldCount}`;
    if (prev.fileInputCount !== next.fileInputCount)                 return `file inputs: ${prev.fileInputCount}→${next.fileInputCount}`;
    if (prev.hasSubmitButton !== next.hasSubmitButton)               return `submit button: ${prev.hasSubmitButton}→${next.hasSubmitButton}`;
    if (prev.hasApplyButton && !next.hasApplyButton)                 return `apply button disappeared`;
    if (!prev.hasCompletionText && next.hasCompletionText)           return `completion text appeared`;
    if (!prev.hasProgressIndicator && next.hasProgressIndicator)     return `progress indicator appeared`;
    if (!prev.hasOverlay && next.hasOverlay)                         return `overlay/modal appeared`;
    if (prev.hasOverlay && !next.hasOverlay)                         return `overlay/modal closed`;
    if (!prev.hasResumeUpload && next.hasResumeUpload)               return `resume upload appeared`;

    // Significant input count change — new form step
    if (Math.abs(next.inputCount - prev.inputCount) >= 4)           return `inputs changed: ${prev.inputCount}→${next.inputCount}`;
    if (prev.textareaCount !== next.textareaCount)                   return `textareas: ${prev.textareaCount}→${next.textareaCount}`;

    // Button set changed while on a form or overlay
    if (prev.buttonFingerprint !== next.buttonFingerprint &&
        (next.hasSubmitButton || next.requiredFieldCount > 0 || next.hasOverlay))
                                                                     return `buttons changed on form/overlay`;

    return null;
}

// ── Send to main process ──────────────────────────────────────────────────────
function sendPageData(reason: string): void {
    try {
        const data = collectSignals();
        console.log(
            `[PRELOAD] Sending (${reason}) url=${data.url} ` +
            `forms=${data.formCount} inputs=${data.inputCount} ` +
            `required=${data.requiredFieldCount} overlay=${data.hasOverlay} ` +
            `resume=${data.hasResumeUpload} toast=${data.hasCompletionToast}`
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
window.addEventListener('load', () => {
    console.log('[PRELOAD] Page load');
    scheduleSend('page-load', 2000);
});

// ── Trigger 2: URL change ─────────────────────────────────────────────────────
function onUrlChange(): void {
    const current = window.location.href;
    if (current !== lastSentUrl) {
        console.log(`[PRELOAD] URL changed: ${lastSentUrl} → ${current}`);
        scheduleSend('url-change', 1500);
    }
}

const origPush    = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState = function(...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    onUrlChange();
};
history.replaceState = function(...args: Parameters<typeof history.replaceState>) {
    origReplace(...args);
    onUrlChange();
};
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
            scheduleSend('dom-mutation', 600);
        }

        lastFormCount = forms;
        lastFileCount = files;
    }, 400);
});

if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
} else {
    document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
    });
}

// ── Trigger 4: Poll at 1.5s ───────────────────────────────────────────────────
// 1.5s interval specifically to catch Handshake's ~2-3s toast before it vanishes.
// Also catches overlay opens, step changes, and submit confirmations that don't
// change the URL.
setInterval(() => {
    try {
        const signals = collectSignals();
        const snap    = buildSnapshot(signals);

        if (lastSnapshot === null) {
            lastSnapshot = snap;
            return;
        }

        const changeReason = hasMeaningfulChange(lastSnapshot, snap);
        if (changeReason) {
            console.log(`[PRELOAD] Poll: ${changeReason}`);
            sendPageData(`poll:${changeReason}`);
        }
    } catch { /* silent */ }
}, 1500);

console.log('[PRELOAD] Ready — triggers: page-load, url-change, dom-mutation, poll(1.5s)');