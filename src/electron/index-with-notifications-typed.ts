const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Import type-checked modules
const { detectApplicationStatus } = require('./status');
const { addInProgress, updateCompleted, getStatus } = require('./storage');
const { NotificationManager } = require('./notifications');

// Type definitions
type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';
type Confidence = 'high' | 'medium' | 'low';

interface BrowserWindowType {
    webContents: {
        send(channel: string, ...args: any[]): void;
    };
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
let settingsWindow: BrowserWindowType | null = null;
let notificationManager: any = null;
let db: any = null;

app.on('ready', () => {
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

    // Initialize database
    const dbPath = app.isPackaged 
        ? path.join(app.getPath('userData'), 'job_apps.db')
        : './src/electron/job_apps.db';
    
    db = new Database(dbPath);
    
    // Initialize notification manager
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

    // Receive full page data from renderer
    ipcMain.on('webview-data', async (_event: any, data: PageSignals) => {
        await processPageStatus(data);
    });

    // Handle user confirmation responses
    ipcMain.on('status-confirmation', (_event: any, isCorrect: boolean) => {
        if (!pendingConfirmation) {
            console.log('[DEBUG] No pending confirmation to process');
            return;
        }

        const { url, status, reasoning, confidence, urlChanged, wasPopup } = pendingConfirmation;
        
        console.log('\n========================================');
        console.log('[CONFIRMATION RECEIVED]');
        console.log('========================================');
        console.log('URL:', url);
        console.log('Detected Status:', status);
        console.log('Confidence:', confidence);
        console.log('URL Changed:', urlChanged ? 'YES' : 'NO');
        console.log('Was Popup:', wasPopup ? 'YES' : 'NO');
        console.log('User Confirmed Status Correct:', isCorrect ? 'YES ✓' : 'NO ✗');
        console.log('\n[REASONING]');
        reasoning.forEach((line: string) => console.log(line));
        console.log('========================================\n');

        if (isCorrect) {
            applyStatusChange(status, url);
        } else {
            console.log('[DEBUG] Status rejected by user - no state change applied');
        }

        pendingConfirmation = null;
        mainWindow?.webContents.send('hide-confirmation-dialog');
    });

    // Settings window handlers
    ipcMain.on('open-settings', () => {
        openSettingsWindow();
    });

    ipcMain.on('get-settings', (event: any) => {
        const settings = notificationManager.getSettings();
        event.sender.send('settings-loaded', settings);
    });

    ipcMain.on('save-settings', (_event: any, newSettings: any) => {
        notificationManager.updateSettings(newSettings);
        console.log('[MAIN] Settings updated');
    });

    ipcMain.on('export-application-data', () => {
        exportApplicationData();
    });

    ipcMain.on('clear-application-data', () => {
        clearApplicationData();
    });

    function openSettingsWindow(): void {
        if (settingsWindow) {
            settingsWindow.focus();
            return;
        }

        settingsWindow = new BrowserWindow({
            width: 1000,
            height: 800,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            parent: mainWindow || undefined,
            modal: false
        }) as BrowserWindowType;

        settingsWindow.setMenuBarVisibility(false);
        settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

        settingsWindow.on('closed', () => {
            settingsWindow = null;
        });
    }

    function exportApplicationData(): void {
        // Get all applications from database
        const applications = db.prepare("SELECT * FROM job_apps ORDER BY rowid DESC").all() as JobAppRow[];
        
        // Convert to CSV
        const headers = ['URL', 'Status'];
        const rows = applications.map((app: JobAppRow) => {
            return [
                `"${app.url}"`,
                app.status
            ].join(',');
        });
        
        const csv = [headers.join(','), ...rows].join('\n');
        
        // Show save dialog
        if (!mainWindow) {
            console.error('[MAIN] Cannot export - no main window');
            return;
        }
        
        dialog.showSaveDialog(mainWindow as any, {
            title: 'Export Application Data',
            defaultPath: path.join(app.getPath('downloads'), 'job-applications.csv'),
            filters: [
                { name: 'CSV Files', extensions: ['csv'] }
            ]
        }).then((result: any) => {
            if (!result.canceled && result.filePath) {
                fs.writeFileSync(result.filePath, csv);
                console.log('[MAIN] Data exported to:', result.filePath);
            }
        }).catch((error: Error) => {
            console.error('[MAIN] Export failed:', error);
        });
    }

    function clearApplicationData(): void {
        db.prepare("DELETE FROM job_apps").run();
        console.log('[MAIN] All application data cleared');
    }

    function applyStatusChange(status: Status, url: string): void {
        console.log(`[DEBUG] Applying confirmed status: ${status} for ${url}`);

        if (status === 'NOT_STARTED') {
            lastNotStartedURL = url;
            hasStartedApplication = false;
            currentStatus = 'NOT_STARTED';
            
            // Schedule follow-up notification for this job
            if (currentJobTitle) {
                notificationManager.scheduleFollowUpNotification(url, currentJobTitle);
            }
        } 
        else if (status === 'IN_PROGRESS') {
            if (!hasStartedApplication && lastNotStartedURL) {
                console.log('[DB] ✓ IN_PROGRESS:', lastNotStartedURL);
                addInProgress(lastNotStartedURL);
                startingURL = lastNotStartedURL;
                hasStartedApplication = true;
                currentStatus = 'IN_PROGRESS';
            } else if (getStatus(url) === 'IN_PROGRESS') {
                startingURL = url;
                currentStatus = 'IN_PROGRESS';
            } else {
                console.log('[DEBUG] Application already started, continuing...');
                currentStatus = 'IN_PROGRESS';
            }
        } 
        else if (status === 'COMPLETED') {
            if (startingURL) {
                console.log('[DB] ✓ COMPLETED:', startingURL);
                updateCompleted(startingURL);
                
                // Notify the notification manager
                if (currentJobTitle) {
                    notificationManager.onApplicationCompleted(startingURL, currentJobTitle);
                }
                
                hasStartedApplication = false;
                lastNotStartedURL = '';
                startingURL = '';
            } else {
                console.log('[DEBUG] No starting URL found for completion');
            }
            currentStatus = 'COMPLETED';
        }

        prevStatus = currentStatus;
        updateStatusBadge(currentStatus);
    }

    function updateStatusBadge(status: Status): void {
        const statusMap: Record<Status, { label: string; className: string }> = {
            NOT_STARTED: { label: 'Not Started', className: 'status-not-started' },
            IN_PROGRESS: { label: 'In Progress', className: 'status-in-progress' },
            COMPLETED: { label: 'Completed', className: 'status-completed' },
            UNKNOWN: { label: 'Unknown', className: 'status-not-started' }
        };

        const info = statusMap[status];
        
        console.log('[MAIN] Updating status badge to:', info.label);
        mainWindow?.webContents.send('update-status-badge', info.label, info.className);
    }

    function getJobBoardDomain(url: string): string {
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname;
            
            const parts = hostname.split('.');
            if (parts.length >= 2) {
                return parts.slice(-2).join('.');
            }
            return hostname;
        } catch {
            return '';
        }
    }

    function hasLeftJobBoard(newUrl: string): boolean {
        if (!currentJobBoard) return false;
        
        const newDomain = getJobBoardDomain(newUrl);
        
        if (newDomain !== currentJobBoard) {
            console.log(`[DEBUG] Left job board: ${currentJobBoard} -> ${newDomain}`);
            return true;
        }
        
        return false;
    }

    function extractJobTitle(bodyText: string, url: string): string {
        // Try to extract job title from page content
        const patterns = [
            /job title[:\s]+([^\n]+)/i,
            /position[:\s]+([^\n]+)/i,
            /<h1[^>]*>([^<]+)<\/h1>/i,
            /apply for[:\s]+([^\n]+)/i
        ];
        
        for (const pattern of patterns) {
            const match = bodyText.match(pattern);
            if (match && match[1]) {
                const title = match[1].trim();
                if (title.length > 5 && title.length < 100) {
                    return title;
                }
            }
        }
        
        // Fallback: use URL
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/').filter(p => p.length > 0);
            if (pathParts.length > 0) {
                const lastPart = pathParts[pathParts.length - 1];
                if (lastPart) {
                    return lastPart
                        .replace(/-/g, ' ')
                        .replace(/_/g, ' ')
                        .substring(0, 50);
                }
            }
        } catch (error) {
            // URL parsing failed, use default
        }
        
        return 'Job Position';
    }

    async function processPageStatus(signals: PageSignals): Promise<void> {
        try {
            const url = signals.url;
            const bodyText = signals.bodyText;
            
            if (!url || url.startsWith('file://')) return;
            
            // Extract job title from page
            currentJobTitle = extractJobTitle(bodyText, url);
            
            const urlChanged = previousURL !== '' && previousURL !== url;
            if (urlChanged) {
                console.log(`[DEBUG] URL changed: ${previousURL} -> ${url}`);
            }
            
            if (hasLeftJobBoard(url)) {
                console.log('[DEBUG] User left job board - resetting to NOT_STARTED');
                currentStatus = 'NOT_STARTED';
                hasStartedApplication = false;
                startingURL = '';
                updateStatusBadge('NOT_STARTED');
            }
            
            const newDomain = getJobBoardDomain(url);
            if (newDomain) {
                currentJobBoard = newDomain;
            }
            
            const isSignificantChange = url !== lastLoggedURL || 
                                        (signals.formCount > 0 && lastLoggedURL === url);

            if (!isSignificantChange) return;

            lastLoggedURL = url;

            console.log('\n========================================');
            console.log('[PAGE ANALYSIS]', new Date().toLocaleTimeString());
            console.log('========================================');
            console.log('URL:', url);
            console.log('Job Title:', currentJobTitle);
            console.log('Body Length:', bodyText.length, 'characters');
            console.log('Forms:', signals.formCount);
            console.log('Inputs:', signals.inputCount);
            console.log('File Inputs:', signals.fileInputCount);
            console.log('Selects:', signals.selectCount);
            console.log('Textareas:', signals.textareaCount);
            console.log('Required Fields:', signals.requiredFieldCount);
            console.log('Progress Indicator:', signals.hasProgressIndicator);
            console.log('Button Texts:', signals.buttonTexts.slice(0, 10).join(', '), signals.buttonTexts.length > 10 ? '...' : '');

            const result: DetectionResult = detectApplicationStatus(signals);
            const detectedStatus = result.status as Status;
            const confidence = result.confidence;
            
            const wasPopup = signals.fileInputCount > 0 && 
                            signals.inputCount <= 3 && 
                            signals.formCount === 1 && 
                            (bodyText.toLowerCase().includes('upload resume') || 
                             bodyText.toLowerCase().includes('attach resume') ||
                             bodyText.toLowerCase().includes('upload cv'));

            console.log('\n[DETECTION RESULT]');
            console.log('Status:', detectedStatus);
            console.log('Confidence:', confidence);
            console.log('URL Changed:', urlChanged ? 'YES' : 'NO');
            console.log('Popup Detected:', wasPopup ? 'YES' : 'NO');
            console.log('\n[REASONING]');
            result.reasoning.forEach((line: string) => console.log(line));
            console.log('========================================\n');

            const isStatusChanging = detectedStatus !== currentStatus && 
                                     detectedStatus !== 'UNKNOWN' &&
                                     (detectedStatus !== prevStatus || currentStatus === 'UNKNOWN');

            if (isStatusChanging && (urlChanged || wasPopup)) {
                pendingConfirmation = {
                    url: url,
                    status: detectedStatus,
                    reasoning: result.reasoning,
                    confidence: confidence,
                    urlChanged: urlChanged,
                    wasPopup: wasPopup
                };

                console.log(`[DEBUG] Status change detected: ${currentStatus} -> ${detectedStatus}`);
                console.log('[DEBUG] Requesting user confirmation (URL changed or popup)...');
                
                mainWindow?.webContents.send('show-confirmation-dialog', {
                    currentStatus: currentStatus,
                    newStatus: detectedStatus,
                    confidence: confidence,
                    url: url,
                    urlChanged: urlChanged,
                    wasPopup: wasPopup
                });
            } else if (isStatusChanging) {
                console.log(`[DEBUG] Status change detected: ${currentStatus} -> ${detectedStatus}`);
                console.log('[DEBUG] Applying automatically (no URL change or popup)');
                applyStatusChange(detectedStatus, url);
            } else {
                console.log(`[DEBUG] No status change (current: ${currentStatus}, detected: ${detectedStatus})`);
            }
            
            previousURL = url;

        } catch (err) {
            console.error('[ERROR]', err);
        }
    }
});

app.on('before-quit', () => {
    // Cleanup notification manager
    if (notificationManager) {
        notificationManager.cleanup();
    }
});