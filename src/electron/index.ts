const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const { detectApplicationStatus, isDefiniteApplicationPage } = require('./status');
const {
    addInProgress, updateCompleted, updateMeta, clearScreenshot,
    incrementExtractionAttempts, getPendingExtraction, resetExtractionAttempts,
    getStatus, getAll, getByStatus, clearAll,
    deleteApp, upsertInProgress, upsertCompleted,
} = require('./storage');
const { NotificationManager }            = require('./notifications');
const { extractJobMeta, checkOllamaAvailable } = require('./extractor');

if (process.platform === 'win32') {
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

type Status     = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';
type Confidence = 'high' | 'medium' | 'low';

interface PendingConfirmation {
    url:           string;
    newStatus:     Status;
    currentStatus: Status;
    reasoning:     string[];
    confidence:    Confidence;
    urlChanged:    boolean;
    wasPopup:      boolean;
    signals:       PageSignals;
    source:        'dom';
}

interface PageSignals {
    url:                  string;
    bodyText:             string;
    pageTitle:            string;
    formCount:            number;
    inputCount:           number;
    fileInputCount:       number;
    selectCount:          number;
    textareaCount:        number;
    buttonTexts:          string[];
    hasProgressIndicator: boolean;
    requiredFieldCount:   number;
    hasOverlay?:          boolean;
    hasResumeUpload?:     boolean;
    hasCompletionToast?:  boolean;
    // New: passed from preload to avoid re-detection
    hasApplyButton?:      boolean;
}

interface DetectionResult {
    status:     string;
    reasoning:  string[];
    confidence: Confidence;
}

interface PendingRow {
    url:        string;
    screenshot: Buffer | null;
}

let mainWindow:          any = null;
let notificationManager: any = null;
let db:                  any = null;

function sendNativeNotification(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => mainWindow?.show?.());
    n.show();
}

let runExtractionWorkerFn: () => void = () => {};

// ── Ollama ────────────────────────────────────────────────────────────────────
const MODEL = 'qwen2.5vl:3b';

function spawnOllamaServe(): void {
    const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    try {
        const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        console.log('[OLLAMA] Spawned ollama serve');
    } catch { /* not installed yet */ }
}

function ensureOllamaRunning(): void {
    spawnOllamaServe();
    // Reduced from 2000ms — ollama is usually ready almost immediately after spawn
    setTimeout(() => checkAndPullModel(true), 800);
}

async function checkAndPullModel(allowInstall = false): Promise<void> {
    try {
        const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) { mainWindow?.webContents.send('ollama-status', { status: 'error' }); return; }

        const data     = await res.json();
        const models   = (data.models || []).map((m: any) => m.name as string);
        const hasModel = models.some((m: string) => m.startsWith('qwen2.5vl'));

        if (hasModel) {
            console.log('[OLLAMA] ✓ Ready');
            mainWindow?.webContents.send('ollama-status', { status: 'ready' });
            resetExtractionAttempts();
            // Reduced from 3000ms — kick off extraction immediately
            runExtractionWorkerFn();
            return;
        }

        console.log('[OLLAMA] Pulling ' + MODEL + '...');
        mainWindow?.webContents.send('ollama-status', { status: 'pulling', model: MODEL });
        const pull = await fetch('http://localhost:11434/api/pull', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: MODEL, stream: false }),
            signal: AbortSignal.timeout(60 * 60 * 1000),
        });
        if (pull.ok) {
            mainWindow?.webContents.send('ollama-status', { status: 'ready' });
            resetExtractionAttempts();
            runExtractionWorkerFn();
        } else {
            mainWindow?.webContents.send('ollama-status', { status: 'pull-failed' });
        }
    } catch (err: any) {
        const notRunning = err?.code === 'ECONNREFUSED' || err?.name === 'AbortError' || err?.message?.includes('ECONNREFUSED');
        if (notRunning && allowInstall) {
            mainWindow?.webContents.send('ollama-status', { status: 'installing' });
            await installOllama();
        } else {
            mainWindow?.webContents.send('ollama-status', { status: 'error' });
        }
    }
}

async function installOllama(): Promise<void> {
    try {
        if (process.platform === 'win32')       await installOllamaWindows();
        else if (process.platform === 'darwin') await installOllamaMac();
        else                                    await installOllamaLinux();
        await new Promise(r => setTimeout(r, 5000));
        spawnOllamaServe();
        await new Promise(r => setTimeout(r, 3000));
        await checkAndPullModel(false);
    } catch {
        mainWindow?.webContents.send('ollama-status', { status: 'install-failed' });
    }
}

function installOllamaWindows(): Promise<void> {
    return new Promise((resolve, reject) => {
        const wg = spawn('winget', ['install','--id','Ollama.Ollama','--silent','--accept-package-agreements','--accept-source-agreements'], { stdio:'pipe', windowsHide:true, shell:true });
        wg.on('close', (c: number) => c === 0 ? resolve() : installOllamaWindowsDirect().then(resolve).catch(reject));
        wg.on('error', () => installOllamaWindowsDirect().then(resolve).catch(reject));
    });
}
async function installOllamaWindowsDirect(): Promise<void> {
    const os = require('os'), tmp = path.join(os.tmpdir(), 'OllamaSetup.exe');
    mainWindow?.webContents.send('ollama-status', { status: 'downloading' });
    await downloadFile('https://ollama.com/download/OllamaSetup.exe', tmp);
    await new Promise<void>((resolve, reject) => {
        const i = spawn(tmp, ['/S'], { detached:true, stdio:'ignore', windowsHide:false });
        i.on('close', (c: number) => c === 0 ? resolve() : reject(new Error('code:' + c)));
        i.on('error', reject);
    });
}
function installOllamaMac(): Promise<void> {
    return new Promise((resolve, reject) => {
        const b = spawn('brew', ['install', 'ollama'], { stdio:'pipe', shell:true });
        b.on('close', (c: number) => c === 0 ? resolve() : installOllamaMacDirect().then(resolve).catch(reject));
        b.on('error', () => installOllamaMacDirect().then(resolve).catch(reject));
    });
}
async function installOllamaMacDirect(): Promise<void> {
    const os = require('os'), tmp = path.join(os.tmpdir(), 'Ollama.dmg');
    mainWindow?.webContents.send('ollama-status', { status: 'downloading' });
    await downloadFile('https://ollama.com/download/Ollama-darwin.zip', tmp);
    spawn('open', [tmp], { detached:true, stdio:'ignore' }).unref();
    mainWindow?.webContents.send('ollama-status', { status: 'manual-install-required' });
    throw new Error('Manual install required');
}
function installOllamaLinux(): Promise<void> {
    return new Promise((resolve, reject) => {
        const sh = spawn('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio:'pipe', shell:true });
        sh.on('close', (c: number) => c === 0 ? resolve() : reject(new Error('exit:' + c)));
        sh.on('error', reject);
    });
}
function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const https = require('https'), fsSync = require('fs'), file = fsSync.createWriteStream(dest);
        https.get(url, (res: any) => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); })
             .on('error', (e: any) => { fsSync.unlink(dest, () => {}); reject(e); });
    });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.on('ready', async () => {
    if (process.platform === 'win32') app.setAppUserModelId(app.name);

    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true, webSecurity: false },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'home.html'));

    autoUpdater.checkForUpdatesAndNotify();
    autoUpdater.on('update-available',  () => sendNativeNotification('HiredFinally', 'Update available! Downloading now...'));
    autoUpdater.on('update-downloaded', () => sendNativeNotification('HiredFinally', 'Update downloaded! Restart to apply.'));

    const dbPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'job_apps.db')
        : './src/electron/job_apps.db';
    db = new Database(dbPath);

    const settingsPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'notification-settings.json')
        : './src/electron/notification-settings.json';
    notificationManager = new NotificationManager(db, settingsPath);

    ensureOllamaRunning();

    // ── Session state ─────────────────────────────────────────────────────────
    let lastLoggedURL:         string  = '';
    let currentStatus:         Status  = 'NOT_STARTED';
    let startingURL:           string  = '';
    let lastNotStartedURL:     string  = '';
    let hasStartedApplication: boolean = false;
    let currentJobBoard:       string  = '';
    let previousURL:           string  = '';
    let pendingConfirmation:   PendingConfirmation | null = null;
    let currentJobTitle:       string  = '';
    let lastPageSignals:       PageSignals | null = null;
    let lastResetDomain:       string  = '';  // debounce duplicate domain-change resets

    // ── Screenshot state ──────────────────────────────────────────────────────
    // TWO-DEEP buffer: previousScreenshot is almost always the job detail page
    // (the page before the apply form). We prefer it over listingScreenshot
    // when picking what to store for IN_PROGRESS.
    let listingScreenshot:  Buffer | null = null; // most recent capture
    let previousScreenshot: Buffer | null = null; // one capture before that
    let screenshotFrozen:   boolean       = false;

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Wait until the webview page is genuinely ready to screenshot.
     *
     * Three conditions must ALL be true before we capture:
     *
     *   1. document.readyState === 'complete'
     *      The HTML, CSS, and synchronous scripts have finished executing.
     *
     *   2. Network idle for >= 500 ms
     *      No new <img>, fetch(), or XHR requests started in the last 500 ms.
     *      Implemented inside the renderer by patching fetch/XHR and watching
     *      PerformanceObserver resource entries. This catches lazy-loaded images
     *      and SPA data fetches that fire after readyState is already 'complete'.
     *
     *   3. Main content container is visible
     *      At least one of the common content landmark selectors (main, article,
     *      [role="main"], #content, .content, .job-details, etc.) has a
     *      non-zero bounding rect, meaning the layout has painted real content
     *      rather than a blank skeleton or spinner.
     *
     * Hard cap: 10 s total. If any condition hasn't resolved by then we proceed
     * anyway so a slow ATS never blocks the screenshot indefinitely.
     */
    async function waitForPageReady(webview: any): Promise<void> {
        // Step 1 — wait for the Electron-level load event first.
        // This avoids running executeJavaScript on a page that hasn't
        // started loading yet (which throws).
        if (webview.isLoading()) {
            await new Promise<void>(resolve => {
                const done = () => resolve();
                webview.once('did-finish-load', done);
                setTimeout(done, 10_000); // hard cap
            });
        }

        // Step 2 — run the three-condition check inside the renderer.
        // We inject a self-contained script that resolves as soon as all
        // three gates pass, or after a 10 s safety timeout.
        try {
            await webview.executeJavaScript(`
                (() => {
                    const NETWORK_IDLE_MS  = 500;   // quiet period required
                    const CONTENT_TIMEOUT  = 10000; // overall cap (ms)

                    return new Promise(resolve => {
                        const timer = setTimeout(resolve, CONTENT_TIMEOUT);

                        // -- Condition 1: readyState --------------------------
                        function readyStateOk() {
                            return document.readyState === 'complete';
                        }

                        // -- Condition 2: network idle ------------------------
                        // We track in-flight requests by patching fetch and XHR,
                        // and watching new PerformanceResourceTiming entries.
                        let inFlight = 0;
                        let idleTimer = null;

                        function resetIdle() {
                            clearTimeout(idleTimer);
                            idleTimer = setTimeout(checkAll, NETWORK_IDLE_MS);
                        }
                        function networkIdle() {
                            return inFlight === 0;
                        }

                        // Patch fetch
                        const origFetch = window.fetch;
                        window.fetch = function(...args) {
                            inFlight++;
                            resetIdle();
                            return origFetch.apply(this, args).finally(() => {
                                inFlight = Math.max(0, inFlight - 1);
                                resetIdle();
                            });
                        };

                        // Patch XHR
                        const origOpen = XMLHttpRequest.prototype.open;
                        XMLHttpRequest.prototype.open = function(...args) {
                            this.addEventListener('loadend', () => {
                                inFlight = Math.max(0, inFlight - 1);
                                resetIdle();
                            });
                            inFlight++;
                            resetIdle();
                            return origOpen.apply(this, args);
                        };

                        // Watch resource timing for images / scripts loaded
                        // after the initial parse (PerformanceObserver is
                        // non-blocking so it won't delay resolution itself)
                        try {
                            const po = new PerformanceObserver(() => resetIdle());
                            po.observe({ type: 'resource', buffered: false });
                        } catch (_) { /* not available in all contexts */ }

                        // -- Condition 3: main content visible ----------------
                        function contentVisible() {
                            const selectors = [
                                'main', 'article', '[role="main"]',
                                '#main', '#content', '#job-details',
                                '.job-description', '.job-details', '.job-content',
                                '.content', '.container', '.page-content',
                                '[data-testid*="job"]', '[class*="jobDetail"]'
                            ];
                            for (const sel of selectors) {
                                try {
                                    const el = document.querySelector(sel);
                                    if (el) {
                                        const r = el.getBoundingClientRect();
                                        if (r.width > 0 && r.height > 50) return true;
                                    }
                                } catch (_) {}
                            }
                            // Fallback: body has meaningful text content
                            return (document.body?.innerText?.trim().length ?? 0) > 200;
                        }

                        // -- Poll until all three pass ------------------------
                        function checkAll() {
                            if (readyStateOk() && networkIdle() && contentVisible()) {
                                clearTimeout(timer);
                                resolve(undefined);
                            } else {
                                // Re-check after one more idle period
                                setTimeout(checkAll, NETWORK_IDLE_MS);
                            }
                        }

                        // Kick off: if readyState isn't complete yet, wait for it
                        if (document.readyState === 'complete') {
                            resetIdle(); // start the idle countdown immediately
                        } else {
                            window.addEventListener('load', () => resetIdle(), { once: true });
                        }
                    });
                })()
            `);
        } catch (err) {
            // executeJavaScript can throw if the webview navigated away mid-wait;
            // log and proceed so we still take a screenshot rather than hanging.
            console.warn('[CAPTURE] waitForPageReady script error (proceeding):', err);
        }
    }

    async function captureCurrentPage(url: string): Promise<void> {
        try {
            const allContents = require('electron').webContents.getAllWebContents();
            const webview = allContents.find((wc: any) => wc.getType() === 'webview');
            if (!webview) return;

            await waitForPageReady(webview);

            const image   = await webview.capturePage();
            const resized = image.resize({ width: Math.min(image.getSize().width, 1280) });

            // Roll the buffer before overwriting
            previousScreenshot = listingScreenshot;
            listingScreenshot  = resized.toJPEG(70);

            const sizeKB = Math.round(listingScreenshot!.length / 1024);
            const prevKB = previousScreenshot ? Math.round(previousScreenshot.length / 1024) + 'KB' : 'none';
            console.log(`[SCREENSHOT] Captured ${sizeKB}KB  prev=${prevKB}  ${url}`);
        } catch (err) {
            console.warn(`[EXTRACTOR] Capture failed for ${url}:`, err);
        }
    }

    function resetStatus(clearScreenshots = true): void {
        console.log('[RESET] Status reset');
        currentStatus         = 'NOT_STARTED';
        hasStartedApplication = false;
        startingURL           = '';
        pendingConfirmation   = null;
        lastPageSignals       = null;
        // lastNotStartedURL and lastLoggedURL are intentionally NOT cleared here.
        // On a domain change (clearScreenshots=false) these still point to the
        // source job detail page (e.g. the LinkedIn card the user clicked Apply
        // from). Keeping them means the manual override and applyStatusChange
        // can use them as the record URL when IN_PROGRESS fires on the ATS domain.
        // They are only wiped when the user explicitly resets to NOT_STARTED or
        // navigates back to a job listing page.
        if (clearScreenshots) {
            lastNotStartedURL  = '';
            lastLoggedURL      = '';
            previousURL        = '';
            listingScreenshot  = null;
            previousScreenshot = null;
            screenshotFrozen   = false;
        }
        updateStatusBadge('NOT_STARTED');
        mainWindow?.webContents.send('hide-confirmation-dialog');
    }

    function clearScreenshotState(): void {
        listingScreenshot  = null;
        previousScreenshot = null;
        screenshotFrozen   = false;
    }

    app.on('web-contents-created', (_e: any, contents: any) => {
        if (contents.getType() === 'webview') {
            contents.setWindowOpenHandler(({ url }: { url: string }) => {
                mainWindow?.webContents.send('load-in-webview', url);
                return { action: 'deny' };
            });
        }
    });

    // ── IPC ───────────────────────────────────────────────────────────────────
    ipcMain.on('webview-data', async (_e: any, data: PageSignals) => {
        lastPageSignals = data;
        await processPageStatus(data);
    });

    ipcMain.on('reset-status', () => resetStatus(true));

    ipcMain.on('status-confirmation', (_e: any, payload: any) => {
        const isCorrect      = typeof payload === 'boolean' ? payload : payload.correct;
        const d              = typeof payload === 'boolean' ? pendingConfirmation : (payload.data ?? pendingConfirmation);
        if (!d) return;
        const detectedStatus = (d.newStatus ?? (d as any).status) as Status;
        const SEP = '-'.repeat(60);
        console.log('\n' + SEP + '\n[STATUS CONFIRMATION]');
        console.log(`  URL: ${d.url}  Detected: ${detectedStatus}  Was: ${d.currentStatus}  User: ${isCorrect ? 'CORRECT' : 'WRONG'}`);
        console.log(SEP + '\n');
        if (isCorrect) { applyStatusChange(detectedStatus, d.url); mainWindow?.webContents.send('app-status-updated'); }
        else           { lastLoggedURL = ''; }
        pendingConfirmation = null;
        mainWindow?.webContents.send('hide-confirmation-dialog');
    });

    // ── Manual Status Override ────────────────────────────────────────────────
    ipcMain.on('manual-status-override', async (_e: any, payload: { newStatus: string }) => {
        const { newStatus } = payload;
        const url = lastLoggedURL || lastNotStartedURL || startingURL;

        const SEP = '═'.repeat(68);
        console.log('\n' + SEP);
        console.log('[MANUAL OVERRIDE] User triggered status change from UI dropdown');
        console.log(SEP);
        console.log(`  Time:              ${new Date().toLocaleTimeString()}`);
        console.log(`  Requested:         ${newStatus}`);
        console.log(`  Current:           ${currentStatus}`);
        console.log(`  Resolved URL:      ${url || '(none)'}`);
        console.log(`  lastLoggedURL:     ${lastLoggedURL || '(none)'}`);
        console.log(`  lastNotStartedURL: ${lastNotStartedURL || '(none)'}`);
        console.log(`  startingURL:       ${startingURL || '(none)'}`);
        console.log(`  currentJobTitle:   ${currentJobTitle || '(none)'}`);
        console.log(`  currentJobBoard:   ${currentJobBoard || '(none)'}`);
        console.log(`  previousURL:       ${previousURL || '(none)'}`);
        console.log(`  listingScreenshot: ${listingScreenshot  ? Math.round(listingScreenshot.length  / 1024) + 'KB' : 'none'}`);
        console.log(`  previousScreenshot:${previousScreenshot ? Math.round(previousScreenshot.length / 1024) + 'KB' : 'none'}`);
        console.log(`  screenshotFrozen:  ${screenshotFrozen}`);
        console.log(`  hasStartedApp:     ${hasStartedApplication}`);
        console.log(SEP);

        if (!url) {
            console.warn('[MANUAL OVERRIDE] ✗ No URL — user has not navigated anywhere yet');
            mainWindow?.webContents.send('manual-override-result', { success: false, reason: 'no-url' });
            return;
        }

        if (newStatus === currentStatus) {
            console.log(`[MANUAL OVERRIDE] Already ${currentStatus} — no-op`);
            mainWindow?.webContents.send('manual-override-result', { success: true, newStatus: currentStatus, noChange: true });
            return;
        }

        const prevStatus = currentStatus;

        try {
            if (newStatus === 'NOT_STARTED') {
                const urlToRemove = startingURL || lastNotStartedURL || url;
                if (hasStartedApplication && urlToRemove) {
                    console.log(`[MANUAL OVERRIDE] Deleting DB row: ${urlToRemove}`);
                    const r = deleteApp(urlToRemove);
                    console.log(`[MANUAL OVERRIDE] deleteApp: ${r.changes} row(s) removed`);
                } else {
                    console.log(`[MANUAL OVERRIDE] hasStartedApplication=false — no DB row to remove`);
                }
                currentStatus         = 'NOT_STARTED';
                hasStartedApplication = false;
                startingURL           = '';
                lastNotStartedURL     = url;
                lastLoggedURL         = url;
                pendingConfirmation   = null;
                listingScreenshot     = null;
                previousScreenshot    = null;
                screenshotFrozen      = false;
                console.log(`[MANUAL OVERRIDE] ✓ NOT_STARTED — session cleared`);
                updateStatusBadge('NOT_STARTED');
                mainWindow?.webContents.send('app-status-updated');
                mainWindow?.webContents.send('manual-override-result', { success: true, newStatus: 'NOT_STARTED' });

            } else if (newStatus === 'IN_PROGRESS') {
                let screenshotToUse: Buffer | null;
                let screenshotSource: string;

                const snapshotPrevious = previousScreenshot as Buffer | null;
                const snapshotListing  = listingScreenshot  as Buffer | null;

                if (snapshotPrevious) {
                    screenshotToUse  = snapshotPrevious;
                    screenshotSource = `previousScreenshot (${Math.round(snapshotPrevious.length / 1024)}KB) — job detail page`;
                } else if (snapshotListing) {
                    screenshotToUse  = snapshotListing;
                    screenshotSource = `listingScreenshot (${Math.round(snapshotListing.length / 1024)}KB) — apply form fallback`;
                } else {
                    console.log(`[MANUAL OVERRIDE] No screenshot in buffer — capturing current webview`);
                    await captureCurrentPage(url);
                    const captured   = listingScreenshot as Buffer | null;
                    screenshotToUse  = captured;
                    screenshotSource = captured
                        ? `live capture (${Math.round(captured.length / 1024)}KB)`
                        : 'live capture failed';
                }

                console.log(`[MANUAL OVERRIDE] Screenshot source: ${screenshotSource}`);

                const urlToRecord = lastNotStartedURL || url;
                console.log(`[MANUAL OVERRIDE] Upserting IN_PROGRESS for: ${urlToRecord}`);
                upsertInProgress(urlToRecord, screenshotToUse);

                startingURL           = urlToRecord;
                hasStartedApplication = true;
                currentStatus         = 'IN_PROGRESS';
                screenshotFrozen      = true;

                console.log(`[MANUAL OVERRIDE] ✓ IN_PROGRESS — triggering extraction`);
                runExtractionWorker();
                updateStatusBadge('IN_PROGRESS');
                mainWindow?.webContents.send('app-status-updated');
                mainWindow?.webContents.send('manual-override-result', { success: true, newStatus: 'IN_PROGRESS' });

            } else if (newStatus === 'COMPLETED') {
                const urlToComplete = startingURL || lastNotStartedURL || url;
                console.log(`[MANUAL OVERRIDE] Upserting COMPLETED for: ${urlToComplete}`);
                upsertCompleted(urlToComplete);
                if (currentJobTitle) {
                    console.log(`[MANUAL OVERRIDE] Firing completion notification: "${currentJobTitle}"`);
                    notificationManager?.onApplicationCompleted(urlToComplete, currentJobTitle);
                } else {
                    console.log(`[MANUAL OVERRIDE] No currentJobTitle — skipping completion notification`);
                }
                hasStartedApplication = false;
                startingURL           = '';
                currentStatus         = 'COMPLETED';
                console.log(`[MANUAL OVERRIDE] ✓ COMPLETED`);
                updateStatusBadge('COMPLETED');
                mainWindow?.webContents.send('app-status-updated');
                mainWindow?.webContents.send('manual-override-result', { success: true, newStatus: 'COMPLETED' });

            } else {
                console.warn(`[MANUAL OVERRIDE] ✗ Unknown status: "${newStatus}"`);
                mainWindow?.webContents.send('manual-override-result', { success: false, reason: 'unknown-status' });
                return;
            }

            console.log(`[MANUAL OVERRIDE] Transition complete: ${prevStatus} → ${newStatus}`);
            console.log(SEP + '\n');

        } catch (err: any) {
            console.error(`[MANUAL OVERRIDE] ✗ Error:`, err?.message || err);
            mainWindow?.webContents.send('manual-override-result', {
                success: false, reason: 'error', message: err?.message || String(err),
            });
        }
    });

    ipcMain.on('get-settings',  (event: any) => { event.sender.send('settings-loaded', notificationManager.getSettings()); });
    ipcMain.on('save-settings', (_e: any, s: any) => { notificationManager.updateSettings(s); });
    ipcMain.on('navigate-home', () => {
        mainWindow?.loadFile(path.join(__dirname, 'home.html'));
        mainWindow?.webContents.once('did-finish-load', () => mainWindow?.webContents.send('navigate-home'));
    });
    ipcMain.on('set-theme',          (_e: any, theme: string) => mainWindow?.webContents.send('apply-theme', theme));
    ipcMain.on('show-notification',  (_e: any, { title, body }: any) => sendNativeNotification(title, body));
    ipcMain.on('export-application-data', () => exportApplicationData());
    ipcMain.on('clear-application-data',  () => { clearAll(); sendNativeNotification('HiredFinally', 'All application data cleared.'); });

    ipcMain.on('get-all-apps', (event: any) => {
        try { event.sender.send('all-apps-data', getAll()); }
        catch (e) { console.error('[GET-ALL-APPS]', e); event.sender.send('all-apps-data', []); }
    });

    ipcMain.on('delete-app', (_e: any, url: string) => {
        try { db.prepare('DELETE FROM job_apps WHERE url = ?').run(url); }
        catch (e) { console.error('[DELETE-APP]', e); }
    });

    ipcMain.on('open-url-in-home', (_e: any, url: string) => {
        mainWindow?.loadFile(path.join(__dirname, 'home.html'));
        mainWindow?.webContents.once('did-finish-load', () => mainWindow?.webContents.send('load-in-webview', url));
    });

    ipcMain.on('open-pipeline', () => mainWindow?.loadFile(path.join(__dirname, 'pipeline.html')));
    ipcMain.on('open-settings', () => {
        mainWindow?.loadFile(path.join(__dirname, 'home.html'));
        mainWindow?.webContents.once('did-finish-load', () => mainWindow?.webContents.send('open-settings-view'));
    });

    function exportApplicationData(): void {
        const rows = db.prepare('SELECT * FROM job_apps ORDER BY rowid DESC').all() as any[];
        const csv  = [
            'URL,Status,Applied At,Job Title,Company',
            ...rows.map((r: any) => `"${r.url}",${r.status},"${r.applied_at}","${r.job_title || ''}","${r.company || ''}"`)
        ].join('\n');
        if (!mainWindow) return;
        dialog.showSaveDialog(mainWindow, {
            title: 'Export Application Data',
            defaultPath: path.join(app.getPath('downloads'), 'job-applications.csv'),
            filters: [{ name: 'CSV Files', extensions: ['csv'] }],
        }).then((result: any) => {
            if (!result.canceled && result.filePath) {
                fs.writeFileSync(result.filePath, csv);
                sendNativeNotification('HiredFinally', 'Application data exported.');
            }
        }).catch((e: Error) => console.error('[EXPORT ERROR]', e));
    }

    // ── URL helpers ───────────────────────────────────────────────────────────
    function getJobBoardDomain(url: string): string {
        try { const p = new URL(url).hostname.split('.'); return p.length >= 2 ? p.slice(-2).join('.') : (p[0] ?? ''); }
        catch { return ''; }
    }

    function isJobListingUrl(url: string): boolean {
        const u = url.toLowerCase();
        return [
            '/jobs', '/job-search', '/search', '/find-jobs', '/job-listings',
            '/openings', '/opportunities', '/explore',
            'indeed.com/jobs', 'indeed.com/rc/',
            'linkedin.com/jobs/search', 'linkedin.com/jobs/collections',
            'glassdoor.com/job-listing', 'glassdoor.com/jobs',
            'ziprecruiter.com/jobs', 'monster.com/jobs',
            'dice.com/jobs', 'wellfound.com/jobs',
            'joinhandshake.com/explore', 'joinhandshake.com/job-search',
        ].some(p => u.includes(p));
    }

    function isExcludedFromTracking(url: string): boolean {
        const u = url.toLowerCase();
        return /joinhandshake\.com\/inbox/i.test(u)         ||
               /joinhandshake\.com\/notifications/i.test(u) ||
               /linkedin\.com\/messaging/i.test(u)          ||
               /linkedin\.com\/notifications/i.test(u)      ||
               /indeed\.com\/account/i.test(u)              ||
               /chrome-error:\/\//i.test(u)                 ||
               // ATS login/auth pages — the user hasn't started an application,
               // they're just being asked to sign in before the form loads.
               // Storing these as lastNotStartedURL or startingURL produces
               // ugly /login URLs in the pipeline and wrong screenshot targets.
               /\/login(\?|$|\/)/i.test(u)                  ||
               /\/signin(\?|$|\/)/i.test(u)                 ||
               /\/auth(\?|$|\/)/i.test(u)                   ||
               /\/sso(\?|$|\/)/i.test(u);
    }

    function isJobDetailUrl(url: string): boolean {
        const u = url.toLowerCase();
        return /[?&]vjk=[a-z0-9]+/i.test(u)                             ||
               /indeed\.com\/viewjob/i.test(u)                           ||
               /linkedin\.com\/jobs\/view\/\d+/i.test(u)                 ||
               /[?&]currentjobid=\d+/i.test(u)                           ||
               /glassdoor\.com\/job-listing\/.*-\d+\.htm/i.test(u)       ||
               /ziprecruiter\.com\/jobs\/[^/]+\/[a-f0-9-]{8,}/i.test(u) ||
               /joinhandshake\.com\/job-search\/\d+/i.test(u)            ||
               /joinhandshake\.com\/jobs\/\d+/i.test(u);
    }

    function canonicaliseUrl(url: string): string {
        const m = url.match(/[?&]vjk=([a-z0-9]+)/i);
        return m?.[1] ? `https://www.indeed.com/viewjob?jk=${m[1]}` : url;
    }

    function hasLeftJobBoard(newUrl: string): boolean {
        if (!currentJobBoard) return false;
        const newDomain = getJobBoardDomain(newUrl);
        const newHost   = new URL(newUrl).hostname.toLowerCase();
        if (newHost.includes(currentJobBoard) || currentJobBoard.includes(newDomain)) return false;
        if (newDomain && newDomain !== currentJobBoard) {
            console.log(`[DOMAIN CHANGE] ${currentJobBoard} → ${newDomain}`);
            return true;
        }
        return false;
    }

    function extractJobTitle(bodyText: string, url: string): string {
        for (const p of [/job title[:\s]+([^\n]+)/i, /position[:\s]+([^\n]+)/i, /apply for[:\s]+([^\n]+)/i]) {
            const m = bodyText.match(p);
            if (m?.[1]) { const t = m[1].trim(); if (t.length > 5 && t.length < 100) return t; }
        }
        try {
            const parts = new URL(url).pathname.split('/').filter(Boolean);
            const last  = parts[parts.length - 1];
            if (last) return last.replace(/[-_]/g, ' ').substring(0, 50);
        } catch {}
        return 'Job Position';
    }

    // ── Apply status change ───────────────────────────────────────────────────
    async function applyStatusChange(status: Status, url: string): Promise<void> {
        console.log(`\n[STATUS CHANGE] ${currentStatus} → ${status}`);
        console.log(`[STATUS URL]    ${url}`);

        if (status === 'NOT_STARTED') {
            if (!screenshotFrozen) lastNotStartedURL = url;
            hasStartedApplication = false;
            currentStatus         = 'NOT_STARTED';
            if (url !== lastNotStartedURL && currentJobTitle)
                notificationManager.scheduleFollowUpNotification(url, currentJobTitle);

        } else if (status === 'IN_PROGRESS') {
            if (!hasStartedApplication) {
                const urlToRecord    = lastNotStartedURL || url;
                const screenshotUsed = previousScreenshot ?? listingScreenshot;
                addInProgress(urlToRecord, screenshotUsed);
                startingURL           = urlToRecord;
                hasStartedApplication = true;
                const usedKB     = screenshotUsed ? Math.round(screenshotUsed.length / 1024) : 0;
                const usedSource = previousScreenshot ? 'previousScreenshot (job detail)' : listingScreenshot ? 'listingScreenshot (current page)' : 'none';
                console.log(`[SCREENSHOT] Attaching ${usedKB}KB [${usedSource}]`);
                console.log(`[SCREENSHOT] URL    ${urlToRecord}`);
                console.log(`[SCREENSHOT] Bufs   listing=${listingScreenshot ? Math.round(listingScreenshot.length/1024)+'KB' : 'null'}  previous=${previousScreenshot ? Math.round(previousScreenshot.length/1024)+'KB' : 'null'}`);
                sendNativeNotification('HiredFinally', `Application started: ${currentJobTitle || url}`);
                runExtractionWorker();
            } else {
                if (!startingURL) startingURL = url;
            }
            currentStatus = 'IN_PROGRESS';

        } else if (status === 'COMPLETED') {
            const urlToComplete = startingURL || lastNotStartedURL || url;
            if (urlToComplete) {
                updateCompleted(urlToComplete);
                if (currentJobTitle) notificationManager.onApplicationCompleted(urlToComplete, currentJobTitle);
                sendNativeNotification('HiredFinally', `Application submitted: ${currentJobTitle || urlToComplete}`);
            }
            hasStartedApplication = false;
            lastNotStartedURL     = '';
            startingURL           = '';
            currentStatus         = 'COMPLETED';
        }

        updateStatusBadge(currentStatus);
    }

    // ── Background extraction worker ──────────────────────────────────────────
    let workerRunning = false;

    async function runExtractionWorker(): Promise<void> {
        runExtractionWorkerFn = runExtractionWorker;
        if (workerRunning) { console.log('[WORKER] Already running — skipping'); return; }

        const pending = getPendingExtraction() as PendingRow[];
        if (pending.length === 0) return;

        workerRunning = true;
        console.log(`\n[WORKER] Found ${pending.length} job(s) pending extraction`);

        for (const row of pending) {
            console.log(`[WORKER] Processing: ${row.url} (${Math.round((row.screenshot?.length || 0) / 1024)}KB)`);
            incrementExtractionAttempts(row.url);
            try {
                const meta = await extractJobMeta(row.screenshot, row.url);
                if (meta) {
                    updateMeta(row.url, meta.jobTitle, meta.company);
                    clearScreenshot(row.url);
                    console.log(`[WORKER] ✓ title="${meta.jobTitle}"  company="${meta.company}"`);
                    mainWindow?.webContents.send('app-status-updated');
                } else {
                    const still = (getPendingExtraction() as PendingRow[]).find((r: PendingRow) => r.url === row.url);
                    if (!still) { clearScreenshot(row.url); console.log(`[WORKER] ✗ Max attempts — screenshot cleared`); }
                    else          console.log(`[WORKER] ✗ No result — will retry`);
                }
            } catch (err) { console.warn(`[WORKER] Error for ${row.url}:`, err); }
        }

        workerRunning = false;
        console.log('[WORKER] Cycle complete');
    }

    setInterval(runExtractionWorker, 60_000);

    function updateStatusBadge(status: Status): void {
        const map: Record<Status, { label: string; cls: string }> = {
            NOT_STARTED: { label: 'Not Started', cls: 'not-started' },
            IN_PROGRESS: { label: 'In Progress', cls: 'in-progress' },
            COMPLETED:   { label: 'Completed',   cls: 'completed'   },
            UNKNOWN:     { label: 'Unknown',      cls: 'not-started' },
        };
        const { label, cls } = map[status];
        mainWindow?.webContents.send('update-status-badge', label, cls);
    }

    // ── Main processor ────────────────────────────────────────────────────────
    async function processPageStatus(signals: PageSignals): Promise<void> {
        try {
            const { url, bodyText } = signals;
            if (!url || url.startsWith('file://') || url === 'about:blank') return;

            if (isExcludedFromTracking(url)) {
                console.log(`[SKIP] Excluded URL: ${url}`);
                previousURL = url;
                return;
            }

            currentJobTitle  = extractJobTitle(bodyText, url);

            // ── Domain change check ───────────────────────────────────────────
            // Must run BEFORE computing urlChanged/firstSignalAfterReset so that
            // a domain-reset signal correctly triggers firstSignalAfterReset=true
            // and captures the new page immediately.
            const isIndeedApplyFlow = previousURL.includes('indeed.com') && url.includes('indeed.com');
            const newDomainForReset = getJobBoardDomain(url);
            if (!isIndeedApplyFlow && hasLeftJobBoard(url) && newDomainForReset !== lastResetDomain) {
                lastResetDomain = newDomainForReset;
                console.log('\n[RESET] Left job board');
                screenshotFrozen = false;
                resetStatus(false);
                // Null previousScreenshot — it belongs to the old domain and
                // would be wrongly preferred over the new capture via the
                // `previousScreenshot ?? listingScreenshot` logic in applyStatusChange.
                previousScreenshot = null;
                // Leave previousURL as '' so firstSignalAfterReset=true fires
                // below, triggering an immediate capture of the new page without
                // waiting for the next navigation event.
            }

            // urlChanged: true when we moved from one page to another.
            // firstSignalAfterReset: true when previousURL was just wiped by a
            // domain reset above — triggers an immediate capture on this signal.
            const urlChanged            = previousURL !== '' && previousURL !== url;
            const firstSignalAfterReset = previousURL === '' && url !== '';

            // ── Screenshot capture ─────────────────────────────────────────────
            //
            // Rules (evaluated in order):
            //
            //  1. Not frozen + URL changed/first-after-reset
            //     → Capture normally. If it's a job detail URL, freeze it.
            //
            //  2. Frozen + new job detail URL (user browsed to a different card)
            //     → Re-capture and re-freeze on the new card. This ensures the
            //       screenshot we save is always the last job detail the user
            //       looked at before hitting Apply.
            //
            //  3. Frozen + heading to a known ATS apply page
            //     → Do NOT capture, do NOT clear. Keep the frozen job-detail
            //       screenshot so it gets attached when IN_PROGRESS fires.
            //
            //  4. Frozen + anything else (unrecognised page, not apply flow)
            //     → Clear unless we're already IN_PROGRESS (mid-form navigation).
            //
            const headingToApplyPage = urlChanged && isDefiniteApplicationPage(url);

            if ((urlChanged || firstSignalAfterReset) && !screenshotFrozen) {
                // Rule 1 — normal capture
                await captureCurrentPage(url);
                if (isJobDetailUrl(url)) {
                    screenshotFrozen  = true;
                    lastNotStartedURL = canonicaliseUrl(url);
                    console.log(`[SCREENSHOT] Frozen (job detail) → ${lastNotStartedURL}`);
                }
            } else if (urlChanged && screenshotFrozen && isJobDetailUrl(url) && currentStatus !== 'IN_PROGRESS') {
                // Rule 2 — user browsed to a different job card; re-freeze
                clearScreenshotState();
                await captureCurrentPage(url);
                screenshotFrozen  = true;
                lastNotStartedURL = canonicaliseUrl(url);
                console.log(`[SCREENSHOT] Re-frozen (new job detail) → ${lastNotStartedURL}`);
            } else if (headingToApplyPage) {
                // Rule 3 — entering apply flow; preserve frozen screenshot
                console.log(`[SCREENSHOT] Entering apply flow — frozen screenshot preserved`);
            } else if (urlChanged && screenshotFrozen) {
                // Rule 4 — left the flow
                if (currentStatus !== 'IN_PROGRESS') {
                    clearScreenshotState();
                }
            }

            if (currentStatus === 'IN_PROGRESS' && urlChanged && isJobListingUrl(url)) {
                console.log('\n[RESET] Back to listing while IN_PROGRESS');
                resetStatus(true);
                clearScreenshotState();
            }

            const d = getJobBoardDomain(url);
            if (d) { currentJobBoard = d; if (d !== lastResetDomain) lastResetDomain = ''; }

            const dom            = detectApplicationStatus(signals) as DetectionResult;
            const detectedStatus = dom.status as Status;
            const confidence     = dom.confidence;

            // ── Apply-button gate for IN_PROGRESS ─────────────────────────────
            // If the detected status is IN_PROGRESS but the page still shows a
            // prominent "Apply" / "Easy Apply" / "Apply Now" button, this page
            // is a job detail page — NOT an actual application form. Keep status
            // as NOT_STARTED. This prevents double-apply-page false positives
            // universally, regardless of which job board or ATS is in use.
            //
            // Exception: we allow the transition if we're already IN_PROGRESS
            // (multi-step form, user advanced past step 1) or if this is a known
            // definite ATS URL (already handled as a fast path inside status.ts).
            let effectiveDetectedStatus = detectedStatus;
            if (
                detectedStatus === 'IN_PROGRESS' &&
                currentStatus  !== 'IN_PROGRESS' &&
                signals.hasApplyButton === true
            ) {
                console.log(`[GATE]    IN_PROGRESS blocked — Apply button visible, treating as NOT_STARTED`);
                effectiveDetectedStatus = 'NOT_STARTED';
            }

            if (effectiveDetectedStatus === 'IN_PROGRESS' && !screenshotFrozen) {
                screenshotFrozen = true;
                console.log(`[SCREENSHOT] Frozen (fallback) — apply form detected`);
            }

            const isNewPage = url !== lastLoggedURL;
            lastLoggedURL   = url;

            console.log(`\n${'─'.repeat(72)}`);
            console.log(`[ANALYSE] ${new Date().toLocaleTimeString()} | ${url}`);
            console.log(`[DETECT]  status=${effectiveDetectedStatus}  confidence=${confidence}  current=${currentStatus}`);

            if (effectiveDetectedStatus !== 'UNKNOWN' && isNewPage) {
                const changed = effectiveDetectedStatus !== currentStatus;
                if (confidence === 'high' && changed) {
                    console.log(`[AUTO]    ${currentStatus} → ${effectiveDetectedStatus}  (high)`);
                    await applyStatusChange(effectiveDetectedStatus, url);
                    mainWindow?.webContents.send('app-status-updated');
                } else if (confidence === 'medium' && changed &&
                    (effectiveDetectedStatus === 'IN_PROGRESS' || effectiveDetectedStatus === 'COMPLETED')) {
                    console.log(`[AUTO]    ${currentStatus} → ${effectiveDetectedStatus}  (medium, forward)`);
                    await applyStatusChange(effectiveDetectedStatus, url);
                    mainWindow?.webContents.send('app-status-updated');
                } else {
                    console.log(`[AUTO]    no change — ${confidence}, detected=${effectiveDetectedStatus}`);
                }
            }

            previousURL = url;
        } catch (err) {
            console.error('[PROCESS ERROR]', err);
        }
    }
});

app.on('before-quit', () => { notificationManager?.cleanup(); });