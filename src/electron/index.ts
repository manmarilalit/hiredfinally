const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const { detectApplicationStatus }   = require('./status');
const { addInProgress, updateCompleted, getStatus, getAll, getByStatus, clearAll } = require('./storage');
const { NotificationManager }       = require('./notifications');

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
}

interface DetectionResult {
    status:     string;
    reasoning:  string[];
    confidence: Confidence;
}

interface JobAppRow { url: string; status: string; }

let mainWindow:          any = null;
let notificationManager: any = null;
let db:                  any = null;

function sendNativeNotification(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => mainWindow?.show?.());
    n.show();
}

app.on('ready', async () => {
    if (process.platform === 'win32') app.setAppUserModelId(app.name);

    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        webPreferences: {
            nodeIntegration:  true,
            contextIsolation: false,
            webviewTag:       true,
            webSecurity:      false,
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'home.html'));

    const dbPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'job_apps.db')
        : './src/electron/job_apps.db';
    db = new Database(dbPath);

    const settingsPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'notification-settings.json')
        : './src/electron/notification-settings.json';
    notificationManager = new NotificationManager(db, settingsPath);

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

    function resetStatus(): void {
        console.log('[RESET] Status reset');
        currentStatus         = 'NOT_STARTED';
        hasStartedApplication = false;
        startingURL           = '';
        lastNotStartedURL     = '';
        lastLoggedURL         = '';
        previousURL           = '';
        pendingConfirmation   = null;
        updateStatusBadge('NOT_STARTED');
        mainWindow?.webContents.send('hide-confirmation-dialog');
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
        await processPageStatus(data);
    });

    ipcMain.on('reset-status', () => resetStatus());

    ipcMain.on('status-confirmation', (_e: any, payload: any) => {
        const isCorrect = typeof payload === 'boolean' ? payload : payload.correct;
        const d: PendingConfirmation | null = typeof payload === 'boolean'
            ? pendingConfirmation
            : (payload.data ?? pendingConfirmation);
        if (!d) return;

        const detectedStatus = (d.newStatus ?? (d as any).status) as Status;

        const SEP = '-'.repeat(60);
        console.log('\n' + SEP);
        console.log('[STATUS CONFIRMATION]');
        console.log(SEP);
        console.log(`  Time:        ${new Date().toLocaleTimeString()}`);
        console.log(`  URL:         ${d.url}`);
        console.log(`  Source:      dom`);
        console.log(`  Detected:    ${detectedStatus}`);
        console.log(`  Was:         ${d.currentStatus}`);
        console.log(`  Confidence:  ${d.confidence}`);
        console.log(`  User says:   ${isCorrect ? 'CORRECT' : 'WRONG'}`);
        console.log(`  Trigger:     ${d.urlChanged ? 'url-change' : d.wasPopup ? 'popup' : 'direct'}`);
        if (d.signals) {
            const s = d.signals;
            console.log(`  Signals:     forms=${s.formCount} inputs=${s.inputCount} files=${s.fileInputCount} required=${s.requiredFieldCount} selects=${s.selectCount} textareas=${s.textareaCount} progress=${s.hasProgressIndicator}`);
            const btns = (s.buttonTexts || []).slice(0, 6).join(' | ');
            if (btns) console.log(`  Buttons:     ${btns}`);
        }
        console.log('\n  REASONING:');
        (d.reasoning || []).forEach((line: string) => console.log('  ' + line));
        console.log(SEP + '\n');

        if (isCorrect) {
            applyStatusChange(detectedStatus, d.url);
            mainWindow?.webContents.send('app-status-updated');
        } else {
            lastLoggedURL = '';
        }

        pendingConfirmation = null;
        mainWindow?.webContents.send('hide-confirmation-dialog');
    });

    ipcMain.on('get-settings', (event: any) => {
        event.sender.send('settings-loaded', notificationManager.getSettings());
    });
    ipcMain.on('save-settings', (_e: any, s: any) => {
        notificationManager.updateSettings(s);
    });
    ipcMain.on('navigate-home', () => {
        mainWindow?.loadFile(path.join(__dirname, 'home.html'));
        mainWindow?.webContents.once('did-finish-load', () => {
            mainWindow?.webContents.send('navigate-home');
        });
    });
    ipcMain.on('set-theme', (_e: any, theme: string) => {
        mainWindow?.webContents.send('apply-theme', theme);
    });
    ipcMain.on('show-notification', (_e: any, { title, body }: any) => {
        sendNativeNotification(title, body);
    });
    ipcMain.on('export-application-data', () => exportApplicationData());
    ipcMain.on('clear-application-data', () => {
        clearAll();
        sendNativeNotification('HiredFinally', 'All application data cleared.');
    });

    ipcMain.on('get-all-apps', (event: any) => {
        try {
            const apps = getAll();
            event.sender.send('all-apps-data', apps);
        } catch (e) {
            console.error('[GET-ALL-APPS]', e);
            event.sender.send('all-apps-data', []);
        }
    });

    ipcMain.on('delete-app', (_e: any, url: string) => {
        try {
            db.prepare("DELETE FROM job_apps WHERE url = ?").run(url);
        } catch (e) {
            console.error('[DELETE-APP]', e);
        }
    });

    ipcMain.on('open-url-in-home', (_e: any, url: string) => {
        mainWindow?.loadFile(path.join(__dirname, 'home.html'));
        mainWindow?.webContents.once('did-finish-load', () => {
            mainWindow?.webContents.send('load-in-webview', url);
        });
    });

    ipcMain.on('open-pipeline', () => {
        mainWindow?.loadFile(path.join(__dirname, 'pipeline.html'));
    });

    ipcMain.on('open-settings', () => {
        mainWindow?.loadFile(path.join(__dirname, 'home.html'));
        mainWindow?.webContents.once('did-finish-load', () => {
            mainWindow?.webContents.send('open-settings-view');
        });
    });
    function exportApplicationData(): void {
        const rows = db.prepare("SELECT * FROM job_apps ORDER BY rowid DESC").all() as JobAppRow[];
        const csv  = ['URL,Status', ...rows.map((r: JobAppRow) => `"${r.url}",${r.status}`)].join('\n');
        if (!mainWindow) return;
        dialog.showSaveDialog(mainWindow, {
            title: 'Export Application Data',
            defaultPath: path.join(app.getPath('downloads'), 'job-applications.csv'),
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
        }).then((result: any) => {
            if (!result.canceled && result.filePath) {
                fs.writeFileSync(result.filePath, csv);
                sendNativeNotification('HiredFinally', 'Application data exported.');
            }
        }).catch((e: Error) => console.error('[EXPORT ERROR]', e));
    }

    // ── Apply a confirmed status change ───────────────────────────────────────
    function applyStatusChange(status: Status, url: string): void {
        const prev = currentStatus;
        console.log(`[STATUS CHANGE] ${prev} -> ${status}  (${url})`);

        if (status === 'NOT_STARTED') {
            // Only schedule follow-up if this is a genuine new NOT_STARTED URL,
            // not just re-confirming we're still on the same type of page
            const isNewUrl = url !== lastNotStartedURL;
            lastNotStartedURL     = url;
            hasStartedApplication = false;
            currentStatus         = 'NOT_STARTED';
            if (isNewUrl && currentJobTitle) {
                notificationManager.scheduleFollowUpNotification(url, currentJobTitle);
            }

        } else if (status === 'IN_PROGRESS') {
            if (!hasStartedApplication) {
                const urlToRecord = lastNotStartedURL || url;
                addInProgress(urlToRecord);
                startingURL           = urlToRecord;
                hasStartedApplication = true;
                sendNativeNotification('HiredFinally', `Application started: ${currentJobTitle || url}`);
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

    function getJobBoardDomain(url: string): string {
        try {
            const parts = new URL(url).hostname.split('.');
            if (parts.length >= 2) return parts.slice(-2).join('.');
            return parts[0] !== undefined ? parts[0] : '';
        } catch { return ''; }
    }

    function isJobListingUrl(url: string): boolean {
        const u = url.toLowerCase();
        const patterns = [
            '/jobs', '/job-search', '/search', '/find-jobs', '/job-listings',
            '/openings', '/opportunities', '/explore',
            'indeed.com/jobs', 'indeed.com/rc/',
            'linkedin.com/jobs/search', 'linkedin.com/jobs/collections',
            'glassdoor.com/job-listing', 'glassdoor.com/jobs',
            'ziprecruiter.com/jobs', 'monster.com/jobs',
            'dice.com/jobs', 'wellfound.com/jobs',
            'joinhandshake.com/explore', 'joinhandshake.com/job-search',
        ];
        return patterns.some(p => u.includes(p));
    }

    function hasLeftJobBoard(newUrl: string): boolean {
        if (!currentJobBoard) return false;
        // Don't reset when going from indeed.com to smartapply.indeed.com —
        // that's the user clicking Apply, not leaving
        const newDomain = getJobBoardDomain(newUrl);
        const newHost   = new URL(newUrl).hostname.toLowerCase();
        const oldHost   = currentJobBoard;

        if (newHost.includes(oldHost) || oldHost.includes(newDomain)) return false;
        if (newDomain && newDomain !== oldHost) {
            console.log(`[DOMAIN CHANGE] ${oldHost} -> ${newDomain}`);
            return true;
        }
        return false;
    }

    function extractJobTitle(bodyText: string, url: string): string {
        const patterns = [
            /job title[:\s]+([^\n]+)/i,
            /position[:\s]+([^\n]+)/i,
            /apply for[:\s]+([^\n]+)/i,
        ];
        for (const p of patterns) {
            const m = bodyText.match(p);
            if (m?.[1]) {
                const t = m[1].trim();
                if (t.length > 5 && t.length < 100) return t;
            }
        }
        try {
            const parts = new URL(url).pathname.split('/').filter(Boolean);
            const last  = parts[parts.length - 1];
            if (last) return last.replace(/[-_]/g, ' ').substring(0, 50);
        } catch {}
        return 'Job Position';
    }

    // ── Main processor ────────────────────────────────────────────────────────
    async function processPageStatus(signals: PageSignals): Promise<void> {
        try {
            const { url, bodyText } = signals;
            if (!url || url.startsWith('file://') || url === 'about:blank') return;

            currentJobTitle  = extractJobTitle(bodyText, url);
            const urlChanged = previousURL !== '' && previousURL !== url;

            // Don't reset when going indeed.com -> smartapply.indeed.com
            const isIndeedApplyFlow =
                previousURL.includes('indeed.com') && url.includes('indeed.com');

            if (!isIndeedApplyFlow && hasLeftJobBoard(url)) {
                console.log('[RESET] Left job board domain');
                resetStatus();
            }
            if (currentStatus === 'IN_PROGRESS' && urlChanged && isJobListingUrl(url)) {
                console.log('[RESET] Back to listing while IN_PROGRESS');
                resetStatus();
            }

            const d = getJobBoardDomain(url);
            if (d) currentJobBoard = d;

            const isNewPage = url !== lastLoggedURL;
            if (!isNewPage && pendingConfirmation !== null) return;

            lastLoggedURL = url;
            console.log(`\n[ANALYSE] ${new Date().toLocaleTimeString()} | ${url}`);

            const dom            = detectApplicationStatus(signals) as DetectionResult;
            const detectedStatus = dom.status as Status;
            const confidence     = dom.confidence;
            const reasoning      = dom.reasoning;

            console.log(`[DETECT] source=dom status=${detectedStatus} confidence=${confidence} currentStatus=${currentStatus}`);

            const wasPopup = signals.fileInputCount > 0 &&
                signals.inputCount <= 3 && signals.formCount === 1 &&
                (bodyText.toLowerCase().includes('upload resume') ||
                 bodyText.toLowerCase().includes('attach resume') ||
                 bodyText.toLowerCase().includes('upload cv'));

            if (detectedStatus !== 'UNKNOWN') {
                pendingConfirmation = {
                    url, newStatus: detectedStatus, currentStatus,
                    reasoning, confidence, urlChanged, wasPopup, signals, source: 'dom',
                };

                mainWindow?.webContents.send('show-confirmation-dialog', {
                    currentStatus, newStatus: detectedStatus, confidence,
                    url, urlChanged, wasPopup, reasoning, source: 'dom',
                    signals: {
                        formCount:            signals.formCount,
                        inputCount:           signals.inputCount,
                        fileInputCount:       signals.fileInputCount,
                        selectCount:          signals.selectCount,
                        textareaCount:        signals.textareaCount,
                        requiredFieldCount:   signals.requiredFieldCount,
                        hasProgressIndicator: signals.hasProgressIndicator,
                        buttonTexts:          signals.buttonTexts,
                    }
                });
            } else {
                console.log(`[DETECT] UNKNOWN — skipping dialog`);
            }

            previousURL = url;
        } catch (err) {
            console.error('[PROCESS ERROR]', err);
        }
    }
});

app.on('before-quit', () => {
    notificationManager?.cleanup();
});