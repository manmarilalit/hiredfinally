const { ipcRenderer } = require('electron');

const _originalOpen = window.open.bind(window);
window.open = function (url?: string | URL, target?: string, features?: string) {
    if (url && url !== 'about:blank' && url !== '') {
        ipcRenderer.sendToHost('page-popup', url.toString());
        return null;
    }
    return _originalOpen(url, target, features);
};

document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[target="_blank"]') as HTMLAnchorElement | null;
    if (a && a.href && !a.href.startsWith('javascript') && a.href !== 'about:blank') {
        e.preventDefault();
        e.stopImmediatePropagation();
        ipcRenderer.sendToHost('page-popup', a.href);
    }
}, true); // capture phase — runs before Handshake's own handlers

let lastSentUrl = '';
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let visionTimer: ReturnType<typeof setTimeout> | null = null;

interface SignalSnapshot {
    url: string;
    formCount: number;
    inputCount: number;
    fileInputCount: number;
    selectCount: number;
    textareaCount: number;
    requiredFieldCount: number;
    hasProgressIndicator: boolean;
    hasSubmitButton: boolean;
    hasApplyButton: boolean;
    hasCompletionText: boolean;
    hasResumeUpload: boolean;
    hasOverlay: boolean;
    hasEmbeddedATS: boolean;   // ← new
    buttonFingerprint: string;
}

let lastSnapshot: SignalSnapshot | null = null;

// -- Helpers -------------------------------------------------------------------

function getBodyText(): string {
    return document.body?.innerText || '';
}

function getVisibleText(): string {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
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
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw) {
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
    return visibleParts.join(' ').replace(/\s+/g, ' ').trim();
}

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
    const candidates = document.querySelectorAll<HTMLElement>(
        'button, a[role="button"], a.apply, [data-testid*="apply"], ' +
        '[aria-label*="apply" i], [class*="apply-btn" i], [class*="applyBtn" i], ' +
        'input[type="submit"], input[type="button"]'
    );
    for (const el of Array.from(candidates)) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const text = (el.innerText || (el as HTMLInputElement).value || '').toLowerCase().trim();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${text} ${ariaLabel}`;
        if (APPLY_PATTERNS.find(p => combined.includes(p))) return true;
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
    if (resumeKeywords.find(kw => bodyLower.includes(kw))) return true;
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

    const falsePositivePhrases = [
        'apply on company website',
        'apply externally',
        'application started',
        'start your application',
        'continue your application',
    ];

    const bodyLower = getBodyText().toLowerCase();

    // If any false positive phrase is present, bail out early
    if (falsePositivePhrases.some(p => bodyLower.includes(p))) return false;

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
                if (completionPhrases.find(p => text.includes(p))) return true;
            }
        } catch { /* skip */ }
    }
    return !!completionPhrases.find(p => bodyLower.includes(p));
}

// -- Embedded ATS iframe detection --------------------------------------------
//
// Some company career pages (e.g. spothero.com/careers/123?gh_jid=456) embed
// the actual application form in an iframe from a third-party ATS.
// The preload script runs in the top-level page context and cannot see inside
// cross-origin iframes, so form/input counts come back as zero even though a
// full application form is visible on screen.
//
// We detect this by checking:
//   1. Whether any iframe src matches a known ATS domain
//   2. Whether the URL contains known ATS query parameters (gh_jid, lever_job etc.)
//   3. Whether the page contains ATS-specific embed container elements
//
// Any of these is sufficient to conclude the page is hosting an embedded
// application form and should be treated as IN_PROGRESS.

const ATS_IFRAME_DOMAINS = [
    'greenhouse.io',
    'boards.greenhouse.io',
    'lever.co',
    'jobs.lever.co',
    'myworkdayjobs.com',
    'workday.com',
    'icims.com',
    'taleo.net',
    'jobvite.com',
    'apply.workable.com',
    'bamboohr.com',
    'smartapply.indeed.com',
    'indeedapply.com',
    'recruitingbypaycor.com',
    'applicantpro.com',
    'breezy.hr',
    'jazz.co',
];

// Query parameters that ATS platforms inject when embedding on a host page
const ATS_QUERY_PARAMS = [
    'gh_jid',       // Greenhouse
    'lever_job',    // Lever
    'gh_src',       // Greenhouse source tracking
    'jid',          // various
    'ats=greenhouse',
    'ats=lever',
];

// DOM containers that ATS platforms render their embed into
const ATS_EMBED_SELECTORS = [
    '#grnhse_app',              // Greenhouse
    '#lever-jobs-container',    // Lever
    '.greenhouse-job-board',
    '[id*="greenhouse"]',
    '[id*="lever-job"]',
    '[class*="greenhouse"]',
    'iframe[src*="greenhouse.io"]',
    'iframe[src*="lever.co"]',
    'iframe[src*="myworkdayjobs"]',
    'iframe[src*="workday.com"]',
    'iframe[src*="jobvite.com"]',
    'iframe[src*="bamboohr.com"]',
    'iframe[src*="icims.com"]',
    'iframe[src*="taleo.net"]',
    'iframe[src*="breezy.hr"]',
    'iframe[src*="workable.com"]',
];

function detectEmbeddedATS(): boolean {
    // 1. Check iframe src attributes
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of Array.from(iframes)) {
        const src = (iframe.getAttribute('src') || '').toLowerCase();
        if (!src) continue;
        if (ATS_IFRAME_DOMAINS.some(d => src.includes(d))) return true;
    }

    // 2. Check URL query parameters
    const urlLower = window.location.href.toLowerCase();
    if (ATS_QUERY_PARAMS.some(p => urlLower.includes(p))) return true;

    // 3. Check for ATS embed container elements
    for (const sel of ATS_EMBED_SELECTORS) {
        try {
            const el = document.querySelector(sel);
            if (el) {
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') return true;
            }
        } catch { /* invalid selector, skip */ }
    }

    return false;
}

// -- Collect full page signals -------------------------------------------------
function collectSignals() {
    const forms = document.querySelectorAll('form');
    const inputs = document.querySelectorAll('input:not([type="hidden"])');
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const selects = document.querySelectorAll('select');
    const textareas = document.querySelectorAll('textarea');
    const buttons = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button, input[type="submit"], input[type="button"]'
    );
    const required = document.querySelectorAll('[required], [aria-required="true"]');
    const progress = document.querySelectorAll(
        '[class*="progress"], [class*="step"], [id*="progress"], [id*="step"]'
    );
    const hasProgressText = /step \d+ of \d+|page \d+ of \d+/i.test(getBodyText());

    const bodyText = getBodyText();
    const visibleText = getVisibleText();
    const buttonTexts = Array.from(buttons)
        .map(b => (b.innerText || b.value || '').toLowerCase().trim())
        .filter(t => t.length > 0 && t.length < 60);

    return {
        url: window.location.href,
        pageTitle: document.title || '',
        bodyText,
        visibleText,
        formCount: forms.length,
        inputCount: inputs.length,
        fileInputCount: fileInputs.length,
        selectCount: selects.length,
        textareaCount: textareas.length,
        buttonTexts,
        hasProgressIndicator: progress.length > 0 || hasProgressText,
        requiredFieldCount: required.length,
        hasOverlay: detectOverlay(),
        hasResumeUpload: detectResumeUpload(),
        hasCompletionToast: detectCompletionToast(),
        hasApplyButton: detectApplyButton(),
        hasEmbeddedATS: detectEmbeddedATS(),   // ← new
    };
}

// -- Build snapshot for change comparison -------------------------------------
function buildSnapshot(signals: ReturnType<typeof collectSignals>): SignalSnapshot {
    const bodyLower = signals.bodyText.toLowerCase();
    const hasSubmitButton = signals.buttonTexts.some(t =>
        t.includes('submit') || t.includes('submit application') ||
        t.includes('send application') || t.includes('finish') ||
        t.includes('complete application')
    );
    const hasCompletionText = signals.hasCompletionToast || [
        'application submitted', 'application received', 'thank you for applying',
        'thanks for applying', 'successfully applied', 'submission confirmed',
        'your application has been submitted', 'we have received your application',
        'application complete',
    ].some(p => bodyLower.includes(p));

    return {
        url: signals.url,
        formCount: signals.formCount,
        inputCount: signals.inputCount,
        fileInputCount: signals.fileInputCount,
        selectCount: signals.selectCount,
        textareaCount: signals.textareaCount,
        requiredFieldCount: signals.requiredFieldCount,
        hasProgressIndicator: signals.hasProgressIndicator,
        hasSubmitButton,
        hasApplyButton: signals.hasApplyButton,
        hasCompletionText,
        hasResumeUpload: signals.hasResumeUpload,
        hasOverlay: signals.hasOverlay,
        hasEmbeddedATS: signals.hasEmbeddedATS,   // ← new
        buttonFingerprint: signals.buttonTexts.slice(0, 8).join('|'),
    };
}

// -- Detect meaningful change --------------------------------------------------
function hasMeaningfulChange(prev: SignalSnapshot, next: SignalSnapshot): boolean {
    if (prev.url !== next.url) return true;
    if (prev.formCount !== next.formCount) return true;
    if (prev.requiredFieldCount !== next.requiredFieldCount) return true;
    if (prev.fileInputCount !== next.fileInputCount) return true;
    if (prev.hasSubmitButton !== next.hasSubmitButton) return true;
    if (prev.hasApplyButton && !next.hasApplyButton) return true;
    if (!prev.hasCompletionText && next.hasCompletionText) return true;
    if (!prev.hasProgressIndicator && next.hasProgressIndicator) return true;
    if (!prev.hasOverlay && next.hasOverlay) return true;
    if (prev.hasOverlay && !next.hasOverlay) return true;
    if (!prev.hasResumeUpload && next.hasResumeUpload) return true;
    if (!prev.hasEmbeddedATS && next.hasEmbeddedATS) return true;   // ← new
    if (Math.abs(next.inputCount - prev.inputCount) >= 4) return true;
    if (prev.textareaCount !== next.textareaCount) return true;
    if (prev.buttonFingerprint !== next.buttonFingerprint &&
        (next.hasSubmitButton || next.requiredFieldCount > 0 || next.hasOverlay))
        return true;
    return false;
}

// -- Send to main process ------------------------------------------------------
function sendPageData(): void {
    if (document.readyState !== 'complete') {
        scheduleSend(500);
        return;
    }
    try {
        const data = collectSignals();
        ipcRenderer.sendToHost('page-data', data);
        lastSentUrl = data.url;
        lastSnapshot = buildSnapshot(data);
    } catch { /* ignore */ }
}

function scheduleSend(delayMs: number): void {
    clearTimeout(sendTimer ?? undefined);
    sendTimer = setTimeout(() => sendPageData(), delayMs);
}

// -- Trigger 1: Page load ------------------------------------------------------
function onPageReady(): void {
    if (document.readyState === 'complete') {
        scheduleSend(300);
    } else {
        window.addEventListener('load', () => scheduleSend(300), { once: true });
    }
}

window.addEventListener('DOMContentLoaded', () => onPageReady());
window.addEventListener('load', () => scheduleSend(300), { once: true });

// -- Trigger 2: URL change -----------------------------------------------------
function onUrlChange(): void {
    if (window.location.href !== lastSentUrl) {
        scheduleSend(800);
    }
}

const origPush = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState = function (...args: Parameters<typeof history.pushState>) { origPush(...args); onUrlChange(); };
history.replaceState = function (...args: Parameters<typeof history.replaceState>) { origReplace(...args); onUrlChange(); };
window.addEventListener('popstate', () => onUrlChange());

// -- Trigger 3: DOM mutation ---------------------------------------------------
let lastFormCount = 0;
let lastFileCount = 0;

const observer = new MutationObserver(() => {
    clearTimeout(visionTimer ?? undefined);
    visionTimer = setTimeout(() => {
        const forms = document.querySelectorAll('form').length;
        const files = document.querySelectorAll('input[type="file"]').length;
        const inputs = document.querySelectorAll('input:not([type="hidden"])').length;
        if (files > lastFileCount || (forms > lastFormCount && inputs > 3)) {
            scheduleSend(500);
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

// -- Trigger 4: Poll at 2s -----------------------------------------------------
setInterval(() => {
    if (document.readyState !== 'complete') return;
    try {
        const signals = collectSignals();
        const snap = buildSnapshot(signals);
        if (lastSnapshot === null) {
            lastSnapshot = snap;
            return;
        }
        if (hasMeaningfulChange(lastSnapshot, snap)) {
            sendPageData();
        }
    } catch { /* ignore */ }
}, 2000);