// Simple test preload to verify it's loading
console.log('=================================');
console.log('[PRELOAD] ✓ Script is loading!');
console.log('[PRELOAD] Location:', window.location.href);
console.log('=================================');

const { ipcRenderer } = require('electron');

// Test if ipcRenderer works
try {
    ipcRenderer.sendToHost('test-message', { test: true });
    console.log('[PRELOAD] ✓ ipcRenderer.sendToHost working');
} catch (err) {
    console.error('[PRELOAD] ✗ ipcRenderer error:', err);
}

// Send page data to renderer whenever DOM changes
function sendPageData() {
    try {
        console.log('[PRELOAD] sendPageData called');
        
        const forms = document.querySelectorAll('form');
        const inputs = document.querySelectorAll('input:not([type="hidden"])');
        const fileInputs = document.querySelectorAll('input[type="file"]');
        const selects = document.querySelectorAll('select');
        const textareas = document.querySelectorAll('textarea');
        const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
        
        const progressIndicators = document.querySelectorAll('[class*="progress"], [class*="step"], [id*="progress"], [id*="step"]');
        const hasProgressText = document.body.innerText.match(/step \d+ of \d+|page \d+ of \d+/i);
        
        const requiredFields = document.querySelectorAll('[required], [aria-required="true"]');
        const requiredAsterisks = document.body.innerHTML.match(/<[^>]*>\s*\*\s*<\/[^>]*>/g);
        
        const data = {
            url: window.location.href,
            bodyText: document.body?.innerText || '',
            formCount: forms.length,
            inputCount: inputs.length,
            fileInputCount: fileInputs.length,
            selectCount: selects.length,
            textareaCount: textareas.length,
            buttonTexts: Array.from(buttons)
                .map(b => {
                    const text = (b as any).innerText || (b as any).value || '';
                    return text.toLowerCase().trim();
                })
                .filter(t => t.length > 0),
            hasProgressIndicator: progressIndicators.length > 0 || hasProgressText !== null,
            requiredFieldCount: requiredFields.length + (requiredAsterisks ? requiredAsterisks.length : 0)
        };
        
        console.log('[PRELOAD] Sending data:', {
            url: data.url,
            forms: data.formCount,
            inputs: data.inputCount,
            buttons: data.buttonTexts.length
        });
        
        ipcRenderer.sendToHost('page-data', data);
    } catch (err) {
        console.error('[PRELOAD ERROR]', err);
    }
}

// Send data when page loads
window.addEventListener('load', () => {
    console.log('[PRELOAD] Page loaded event fired');
    setTimeout(() => {
        console.log('[PRELOAD] Calling sendPageData after 2s delay');
        sendPageData();
    }, 2000);
});

// Watch for dynamic content changes (for single-page apps)
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        console.log('[PRELOAD] DOM changed, re-scanning...');
        sendPageData();
    }, 1000);
});

// Start observing once DOM is ready
if (document.body) {
    observer.observe(document.body, { 
        childList: true, 
        subtree: true 
    });
    console.log('[PRELOAD] ✓ MutationObserver attached');
} else {
    document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { 
            childList: true, 
            subtree: true 
        });
        console.log('[PRELOAD] ✓ MutationObserver attached (after DOMContentLoaded)');
    });
}

console.log('[PRELOAD] ✓ All event listeners registered');