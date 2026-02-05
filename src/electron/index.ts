const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { detectApplicationStatus } = require('./status');
const { addInProgress, updateCompleted, getStatus } = require('./storage');

type BrowserWindowType = typeof BrowserWindow.prototype;
type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';

let mainWindow: BrowserWindowType | null = null;

app.on('ready', () => {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            webSecurity: false  // Allow reading from webview
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'home.html'));

    let lastLoggedURL = '';
    let prevStatus: Status = 'UNKNOWN';
    let currentStatus: Status = 'UNKNOWN';
    let startingURL = '';
    let underlyingStatus: Status = 'UNKNOWN';
    let displayStatus: Status = 'UNKNOWN';
    let lastNotStartedURL = '';
    let hasStartedApplication = false;

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

    // Receive full page data from renderer (which gets it from preload script)
    ipcMain.on('webview-data', async (_event: any, data: any) => {
        await processPageStatus(data);
    });

    function updateStatusBadge(status: Status) {
        const statusMap: Record<Status, { label: string; className: string }> = {
            NOT_STARTED: { label: 'Not Started', className: 'status-not-started' },
            IN_PROGRESS: { label: 'In Progress', className: 'status-in-progress' },
            COMPLETED: { label: 'Completed', className: 'status-completed' },
            UNKNOWN: { label: 'Unknown', className: 'status-not-started' }
        };

        const info = statusMap[status];
        
        // Send to renderer process via IPC instead of executeJavaScript
        console.log('[MAIN] Updating status badge to:', info.label);
        mainWindow?.webContents.send('update-status-badge', info.label, info.className);
    }

    async function processPageStatus(signals: any) {
        try {
            const url = signals.url;
            const bodyText = signals.bodyText;
            
            if (!url || url.startsWith('file://')) return;
            if (url === lastLoggedURL) return;

            lastLoggedURL = url;

            console.log('[PAGE]', url);
            console.log('[BODY]', bodyText.length, 'characters');
            console.log('[FORMS]', signals.formCount, 'forms,', signals.inputCount, 'inputs');

            const result = detectApplicationStatus(signals);
            underlyingStatus = result.status as Status;

            if (underlyingStatus === 'COMPLETED') displayStatus = 'COMPLETED';
            else if (underlyingStatus === 'IN_PROGRESS') displayStatus = 'IN_PROGRESS';
            else if (underlyingStatus === 'UNKNOWN' && displayStatus === 'IN_PROGRESS') displayStatus = 'IN_PROGRESS';
            else displayStatus = underlyingStatus;

            currentStatus = displayStatus;

            if (underlyingStatus === 'NOT_STARTED') {
                lastNotStartedURL = url;
                hasStartedApplication = false;
            }

            if (displayStatus === 'IN_PROGRESS' && !hasStartedApplication && lastNotStartedURL) {
                console.log('[DB] IN_PROGRESS:', lastNotStartedURL);
                addInProgress(lastNotStartedURL);
                startingURL = lastNotStartedURL;
                hasStartedApplication = true;
            }

            if (getStatus(url) === 'IN_PROGRESS') startingURL = url;

            if (currentStatus === 'COMPLETED' && startingURL) {
                console.log('[DB] COMPLETED:', startingURL);
                updateCompleted(startingURL);
                hasStartedApplication = false;
                lastNotStartedURL = '';
            }

            prevStatus = currentStatus;
            updateStatusBadge(displayStatus);

            console.log('[STATUS]', displayStatus);
            console.log('[REASONING]', result.reasoning.join('\n'));
            console.log('---');

        } catch (err) {
            console.error('[ERROR]', err);
        }
    }
});