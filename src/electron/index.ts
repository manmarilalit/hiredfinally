const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { detectApplicationStatus } = require('./status');
const { addInProgress, updateCompleted, getStatus } = require('./storage');
const { NotificationManager } = require('./notifications');

type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';
type Confidence = 'high' | 'medium' | 'low';

interface BrowserWindowType {
    webContents: { send(channel: string, ...args: any[]): void; };
    setMenuBarVisibility(visible: boolean): void;
    loadFile(path: string): Promise<void>;
    on(event: string, callback: Function): void;
    focus(): void;
    close(): void;
}

interface PendingConfirmation {
    url: string;
    status: Status;
    reasoning: string[];
    confidence: Confidence;
    urlChanged: boolean;
    wasPopup: boolean;
}

interface PageSignals {
    url: string;
    bodyText: string;
    formCount: number;
    inputCount: number;
    fileInputCount: number;
    selectCount: number;
    textareaCount: number;
    buttonTexts: string[];
    hasProgressIndicator: boolean;
    requiredFieldCount: number;
}

interface DetectionResult {
    status: string;
    reasoning: string[];
    confidence: Confidence;
}

interface JobAppRow {
    url: string;
    status: string;
}

let mainWindow: BrowserWindowType | null = null;
let notificationManager: any = null;
let db: any = null;

// ── Native notification helper ────────────────────────────────────────────────
function sendNativeNotification(title: string, body: string): void {
    if (!Notification.isSupported()) {
        console.warn('[NOTIFICATION] Notifications not supported on this platform');
        return;
    }
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
        if (mainWindow) (mainWindow as any).show?.();
    });
    n.show();
    console.log(`[NOTIFICATION] Sent: "${title}" — ${body}`);
}

app.on('ready', () => {
    if (process.platform === 'win32') {
        app.setAppUserModelId(app.name);
    }

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            webSecurity: false
        }
    }) as BrowserWindowType;

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'home.html'));

    // Database
    const dbPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'job_apps.db')
        : './src/electron/job_apps.db';
    db = new Database(dbPath);

    // Notification manager
    const settingsPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'notification-settings.json')
        : './src/electron/notification-settings.json';
    notificationManager = new NotificationManager(db, settingsPath);
    console.log('[MAIN] Notification manager initialized');

    let lastLoggedURL: string = '';
    let prevStatus: Status = 'UNKNOWN';
    let currentStatus: Status = 'UNKNOWN';
    let startingURL: string = '';
    let lastNotStartedURL: string = '';
    let hasStartedApplication: boolean = false;
    let currentJobBoard: string = '';
    let previousURL: string = '';
    let pendingConfirmation: PendingConfirmation | null = null;
    let currentJobTitle: string = '';

    // Intercept popups from webviews
    app.on('web-contents-created', (_event: any, contents: any) => {
        if (contents.getType() === 'webview') {
            contents.setWindowOpenHandler(({ url }: { url: string }) => {
                console.log('[POPUP]', url);
                mainWindow?.webContents.send('load-in-webview', url);
                return { action: 'deny' };
            });
        }
    });

    // Page data from renderer
    ipcMain.on('webview-data', async (_event: any, data: PageSignals) => {
        await processPageStatus(data);
    });

    // User confirmation response
    ipcMain.on('status-confirmation', (_event: any, isCorrect: boolean) => {
        if (!pendingConfirmation) return;
        const { url, status, reasoning, confidence } = pendingConfirmation;

        console.log('\n========================================');
        console.log('[CONFIRMATION RECEIVED]');
        console.log('URL:', url, '| Status:', status, '| Confidence:', confidence);
        console.log('User confirmed:', isCorrect ? 'YES' : 'NO');
        reasoning.forEach((l: string) => console.log(l));
        console.log('========================================\n');

        if (isCorrect) {
            applyStatusChange(status, url);
        } else {
            console.log('[DEBUG] Status rejected by user');
        }

        pendingConfirmation = null;
        mainWindow?.webContents.send('hide-confirmation-dialog');
    });

    // ── Settings ──────────────────────────────────────────────────────────────
    // Reply to whoever asked (mainWindow or the settings webview)
    ipcMain.on('get-settings', (event: any) => {
        const settings = notificationManager.getSettings();
        event.sender.send('settings-loaded', settings);
    });

    ipcMain.on('save-settings', (_event: any, newSettings: any) => {
        notificationManager.updateSettings(newSettings);
        console.log('[MAIN] Settings updated');
    });

    // ── Navigate home (from settings Cancel button) ───────────────────────────
    ipcMain.on('navigate-home', () => {
        mainWindow?.webContents.send('navigate-home');
    });

    // ── Theme change: settings → main → home.html ─────────────────────────────
    ipcMain.on('set-theme', (_event: any, theme: string) => {
        console.log('[MAIN] Theme changed to:', theme);
        mainWindow?.webContents.send('apply-theme', theme);
    });

    // ── Native notification ───────────────────────────────────────────────────
    ipcMain.on('show-notification', (_event: any, { title, body }: { title: string; body: string }) => {
        sendNativeNotification(title, body);
    });

    ipcMain.on('export-application-data', () => exportApplicationData());
    ipcMain.on('clear-application-data', () => clearApplicationData());

    // ── Helpers ───────────────────────────────────────────────────────────────
    function exportApplicationData(): void {
        const applications = db.prepare("SELECT * FROM job_apps ORDER BY rowid DESC").all() as JobAppRow[];
        const csv = [
            'URL,Status',
            ...applications.map((a: JobAppRow) => `"${a.url}",${a.status}`)
        ].join('\n');

        if (!mainWindow) return;
        dialog.showSaveDialog(mainWindow as any, {
            title: 'Export Application Data',
            defaultPath: path.join(app.getPath('downloads'), 'job-applications.csv'),
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
        }).then((result: any) => {
            if (!result.canceled && result.filePath) {
                fs.writeFileSync(result.filePath, csv);
                console.log('[MAIN] Exported to:', result.filePath);
                sendNativeNotification('HiredFinally', 'Application data exported successfully.');
            }
        }).catch((err: Error) => console.error('[MAIN] Export failed:', err));
    }

    function clearApplicationData(): void {
        db.prepare("DELETE FROM job_apps").run();
        console.log('[MAIN] Application data cleared');
        sendNativeNotification('HiredFinally', 'All application data has been cleared.');
    }

    function applyStatusChange(status: Status, url: string): void {
        console.log(`[DEBUG] Applying status: ${status} for ${url}`);

        if (status === 'NOT_STARTED') {
            lastNotStartedURL = url;
            hasStartedApplication = false;
            currentStatus = 'NOT_STARTED';
            if (currentJobTitle) notificationManager.scheduleFollowUpNotification(url, currentJobTitle);
        } else if (status === 'IN_PROGRESS') {
            if (!hasStartedApplication && lastNotStartedURL) {
                console.log('[DB] IN_PROGRESS:', lastNotStartedURL);
                addInProgress(lastNotStartedURL);
                startingURL = lastNotStartedURL;
                hasStartedApplication = true;
                currentStatus = 'IN_PROGRESS';
                sendNativeNotification('HiredFinally', `Application started: ${currentJobTitle || url}`);
            } else if (getStatus(url) === 'IN_PROGRESS') {
                startingURL = url;
                currentStatus = 'IN_PROGRESS';
            } else {
                currentStatus = 'IN_PROGRESS';
            }
        } else if (status === 'COMPLETED') {
            if (startingURL) {
                console.log('[DB] COMPLETED:', startingURL);
                updateCompleted(startingURL);
                if (currentJobTitle) notificationManager.onApplicationCompleted(startingURL, currentJobTitle);
                sendNativeNotification('HiredFinally', `Application submitted: ${currentJobTitle || startingURL}`);
                hasStartedApplication = false;
                lastNotStartedURL = '';
                startingURL = '';
            }
            currentStatus = 'COMPLETED';
        }

        prevStatus = currentStatus;
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
            return parts[0] ?? '';
        } catch { return ''; }
    }

    function hasLeftJobBoard(newUrl: string): boolean {
        if (!currentJobBoard) return false;
        const d = getJobBoardDomain(newUrl);
        if (d && d !== currentJobBoard) {
            console.log(`[DEBUG] Left job board: ${currentJobBoard} -> ${d}`);
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
            if (m && m[1]) {
                const t = m[1].trim();
                if (t.length > 5 && t.length < 100) return t;
            }
        }
        try {
            const parts = new URL(url).pathname.split('/').filter(Boolean);
            const last = parts[parts.length - 1];
            if (last) return last.replace(/[-_]/g, ' ').substring(0, 50);
        } catch {}
        return 'Job Position';
    }

    async function processPageStatus(signals: PageSignals): Promise<void> {
        try {
            const { url, bodyText } = signals;
            if (!url || url.startsWith('file://')) return;

            currentJobTitle = extractJobTitle(bodyText, url);
            const urlChanged = previousURL !== '' && previousURL !== url;

            if (hasLeftJobBoard(url)) {
                currentStatus = 'NOT_STARTED';
                hasStartedApplication = false;
                startingURL = '';
                updateStatusBadge('NOT_STARTED');
            }

            const d = getJobBoardDomain(url);
            if (d) currentJobBoard = d;

            const isSignificant = url !== lastLoggedURL || (signals.formCount > 0 && lastLoggedURL === url);
            if (!isSignificant) return;
            lastLoggedURL = url;

            console.log('\n[PAGE ANALYSIS]', new Date().toLocaleTimeString(), url);

            const result: DetectionResult = detectApplicationStatus(signals);
            const detectedStatus = result.status as Status;
            const confidence = result.confidence;

            const wasPopup = signals.fileInputCount > 0 &&
                signals.inputCount <= 3 &&
                signals.formCount === 1 &&
                (bodyText.toLowerCase().includes('upload resume') ||
                    bodyText.toLowerCase().includes('attach resume') ||
                    bodyText.toLowerCase().includes('upload cv'));

            const isChanging = detectedStatus !== currentStatus &&
                detectedStatus !== 'UNKNOWN' &&
                (detectedStatus !== prevStatus || currentStatus === 'UNKNOWN');

            if (isChanging && (urlChanged || wasPopup)) {
                pendingConfirmation = { url, status: detectedStatus, reasoning: result.reasoning, confidence, urlChanged, wasPopup };
                mainWindow?.webContents.send('show-confirmation-dialog', {
                    currentStatus, newStatus: detectedStatus, confidence, url, urlChanged, wasPopup
                });
            } else if (isChanging) {
                applyStatusChange(detectedStatus, url);
            }

            previousURL = url;
        } catch (err) {
            console.error('[ERROR]', err);
        }
    }
});

app.on('before-quit', () => {
    if (notificationManager) notificationManager.cleanup();
});