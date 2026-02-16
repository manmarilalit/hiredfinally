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
    let lastNotStartedURL = '';
    let hasStartedApplication = false;
    let currentJobBoard = ''; // Track which job board we're on
    let previousURL = ''; // Track previous URL to detect changes
    let pendingConfirmation: {url: string, status: Status, reasoning: string[], confidence: string, urlChanged: boolean, wasPopup: boolean} | null = null;

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
            // User confirmed the status is correct - apply the state change
            applyStatusChange(status, url);
        } else {
            console.log('[DEBUG] Status rejected by user - no state change applied');
        }

        // Clear pending confirmation and hide the dialog
        pendingConfirmation = null;
        mainWindow?.webContents.send('hide-confirmation-dialog');
    });

    function applyStatusChange(status: Status, url: string) {
        console.log(`[DEBUG] Applying confirmed status: ${status} for ${url}`);

        if (status === 'NOT_STARTED') {
            lastNotStartedURL = url;
            hasStartedApplication = false;
            currentStatus = 'NOT_STARTED';
        } 
        else if (status === 'IN_PROGRESS') {
            if (!hasStartedApplication && lastNotStartedURL) {
                console.log('[DB] âœ" IN_PROGRESS:', lastNotStartedURL);
                addInProgress(lastNotStartedURL);
                startingURL = lastNotStartedURL;
                hasStartedApplication = true;
                currentStatus = 'IN_PROGRESS';
            } else if (getStatus(url) === 'IN_PROGRESS') {
                // Already in progress from before
                startingURL = url;
                currentStatus = 'IN_PROGRESS';
            } else {
                console.log('[DEBUG] Application already started, continuing...');
                currentStatus = 'IN_PROGRESS';
            }
        } 
        else if (status === 'COMPLETED') {
            if (startingURL) {
                console.log('[DB] âœ" COMPLETED:', startingURL);
                updateCompleted(startingURL);
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

    function updateStatusBadge(status: Status) {
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
            
            // Extract main domain (e.g., indeed.com, linkedin.com)
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
        
        // If we're on a completely different domain, we've left
        if (newDomain !== currentJobBoard) {
            console.log(`[DEBUG] Left job board: ${currentJobBoard} -> ${newDomain}`);
            return true;
        }
        
        return false;
    }

    async function processPageStatus(signals: any) {
        try {
            const url = signals.url;
            const bodyText = signals.bodyText;
            
            if (!url || url.startsWith('file://')) return;
            
            // Check if URL changed
            const urlChanged = previousURL !== '' && previousURL !== url;
            if (urlChanged) {
                console.log(`[DEBUG] URL changed: ${previousURL} -> ${url}`);
            }
            
            // Check if we've left the job board
            if (hasLeftJobBoard(url)) {
                console.log('[DEBUG] User left job board - resetting to NOT_STARTED');
                currentStatus = 'NOT_STARTED';
                hasStartedApplication = false;
                startingURL = '';
                updateStatusBadge('NOT_STARTED');
            }
            
            // Update current job board
            const newDomain = getJobBoardDomain(url);
            if (newDomain) {
                currentJobBoard = newDomain;
            }
            
            // Allow re-processing same URL if content might have changed significantly
            const isSignificantChange = url !== lastLoggedURL || 
                                        (signals.formCount > 0 && lastLoggedURL === url);

            if (!isSignificantChange) return;

            lastLoggedURL = url;

            console.log('\n========================================');
            console.log('[PAGE ANALYSIS]', new Date().toLocaleTimeString());
            console.log('========================================');
            console.log('URL:', url);
            console.log('Body Length:', bodyText.length, 'characters');
            console.log('Forms:', signals.formCount);
            console.log('Inputs:', signals.inputCount);
            console.log('File Inputs:', signals.fileInputCount);
            console.log('Selects:', signals.selectCount);
            console.log('Textareas:', signals.textareaCount);
            console.log('Required Fields:', signals.requiredFieldCount);
            console.log('Progress Indicator:', signals.hasProgressIndicator);
            console.log('Button Texts:', signals.buttonTexts.slice(0, 10).join(', '), signals.buttonTexts.length > 10 ? '...' : '');

            const result = detectApplicationStatus(signals);
            const detectedStatus = result.status as Status;
            const confidence = result.confidence;
            
            // Detect if this looks like a popup
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

            // Check if status is changing (and not just staying UNKNOWN)
            const isStatusChanging = detectedStatus !== currentStatus && 
                                     detectedStatus !== 'UNKNOWN' &&
                                     (detectedStatus !== prevStatus || currentStatus === 'UNKNOWN');

            // Only show confirmation dialog if URL changed OR popup detected
            if (isStatusChanging && (urlChanged || wasPopup)) {
                // Store pending confirmation
                pendingConfirmation = {
                    url: url,
                    status: detectedStatus,
                    reasoning: result.reasoning,
                    confidence: confidence,
                    urlChanged: urlChanged,
                    wasPopup: wasPopup
                };

                // Show confirmation dialog to user
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
                // Status changed but no URL change or popup - just apply it automatically
                console.log(`[DEBUG] Status change detected: ${currentStatus} -> ${detectedStatus}`);
                console.log('[DEBUG] Applying automatically (no URL change or popup)');
                applyStatusChange(detectedStatus, url);
            } else {
                console.log(`[DEBUG] No status change (current: ${currentStatus}, detected: ${detectedStatus})`);
            }
            
            // Update previous URL for next comparison
            previousURL = url;

        } catch (err) {
            console.error('[ERROR]', err);
        }
    }
});