// debug-logger.ts
// Logs all detection events to human-readable text files for debugging

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface DebugLogEntry {
    timestamp: string;
    url: string;
    detectedStatus: string;
    confidence: string;
    currentStatus: string;
    signals: {
        formCount: number;
        inputCount: number;
        requiredFieldCount: number;
        fileInputCount: number;
        selectCount: number;
        textareaCount: number;
        hasApplyButton: boolean;
        hasOverlay: boolean;
        hasResumeUpload: boolean;
        hasCompletionToast: boolean;
        hasProgressIndicator: boolean;
        hasEmbeddedATS: boolean;
        buttonTexts: string[];
    };
    bodyTextSample: string;
    applied: boolean;
    reason?: string;
    manualOverride?: {
        from: string;
        to: string;
        timestamp: string;
    };
}

class DebugLogger {
    private logFilePath: string;

    constructor() {
        const userDataPath = app.getPath('userData');
        const logsDir = path.join(userDataPath, 'logs');

        // Create logs directory if it doesn't exist
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Single log file that continuously updates
        this.logFilePath = path.join(logsDir, `application-tracker.txt`);

        console.log(`[DEBUG-LOGGER] Logging to: ${this.logFilePath}`);

        // Write header only if file doesn't exist
        if (!fs.existsSync(this.logFilePath)) {
            this.writeLog('='.repeat(80));
            this.writeLog('JOB APPLICATION TRACKER - DEBUG LOG');
            this.writeLog(`Started: ${new Date().toLocaleString()}`);
            this.writeLog('='.repeat(80));
            this.writeLog('');
        } else {
            // Add session separator
            this.writeLog('');
            this.writeLog('═'.repeat(80));
            this.writeLog(`NEW SESSION: ${new Date().toLocaleString()}`);
            this.writeLog('═'.repeat(80));
            this.writeLog('');
        }
    }

    private writeLog(content: string): void {
        try {
            fs.appendFileSync(this.logFilePath, content + '\n', 'utf8');
        } catch (err) {
            console.error('[DEBUG-LOGGER] Failed to write log:', err);
        }
    }

    logDetection(entry: Omit<DebugLogEntry, 'timestamp'>): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        // Format the log entry
        const lines: string[] = [];
        lines.push(`[${timeStr}] ${entry.detectedStatus} (${entry.confidence})`);
        lines.push(`  Current Status: ${entry.currentStatus}`);
        lines.push(`  URL: ${entry.url}`);
        lines.push('');
        lines.push('  DOM Signals:');
        lines.push(`    Forms: ${entry.signals.formCount}, Inputs: ${entry.signals.inputCount}, Required: ${entry.signals.requiredFieldCount}`);
        lines.push(`    File Inputs: ${entry.signals.fileInputCount}, Selects: ${entry.signals.selectCount}, Textareas: ${entry.signals.textareaCount}`);
        lines.push(`    Apply Button: ${entry.signals.hasApplyButton ? 'YES' : 'NO'}, Overlay: ${entry.signals.hasOverlay ? 'YES' : 'NO'}`);
        lines.push(`    Resume Upload: ${entry.signals.hasResumeUpload ? 'YES' : 'NO'}, Completion Toast: ${entry.signals.hasCompletionToast ? 'YES' : 'NO'}`);
        lines.push(`    Progress Indicator: ${entry.signals.hasProgressIndicator ? 'YES' : 'NO'}, Embedded ATS: ${entry.signals.hasEmbeddedATS ? 'YES' : 'NO'}`);

        if (entry.signals.buttonTexts && entry.signals.buttonTexts.length > 0) {
            lines.push(`    Buttons: ${entry.signals.buttonTexts.slice(0, 5).join(', ')}${entry.signals.buttonTexts.length > 5 ? '...' : ''}`);
        }

        lines.push('');
        lines.push(`  Applied: ${entry.applied ? 'YES' : 'NO'}`);
        if (entry.reason) {
            lines.push(`  Reason: ${entry.reason}`);
        }

        if (entry.bodyTextSample && entry.bodyTextSample.length > 0) {
            lines.push('');
            lines.push('  Body Text Sample:');
            lines.push(`    ${entry.bodyTextSample.slice(0, 200).replace(/\n/g, ' ')}${entry.bodyTextSample.length > 200 ? '...' : ''}`);
        }

        lines.push('');
        lines.push('-'.repeat(80));
        lines.push('');

        // Write to log
        lines.forEach(line => this.writeLog(line));
    }

    logManualOverride(from: string, to: string, url: string, reason?: string): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push('');
        lines.push('*'.repeat(80));
        lines.push(`[${timeStr}] MANUAL OVERRIDE`);
        lines.push(`  Changed: ${from} → ${to}`);
        lines.push(`  URL: ${url}`);
        lines.push(`  Reason: ${reason || 'User manual override'}`);
        lines.push('*'.repeat(80));
        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    logEvent(eventType: string, message: string, details?: any): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push(`[${timeStr}] 🔔 ${eventType.toUpperCase()}`);
        lines.push(`  ${message}`);

        if (details) {
            if (typeof details === 'string') {
                lines.push(`  Details: ${details}`);
            } else {
                lines.push(`  Details: ${JSON.stringify(details, null, 2).split('\n').join('\n  ')}`);
            }
        }

        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    logNotification(title: string, body: string, type?: string): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push(`[${timeStr}] 🔔 NOTIFICATION SENT`);
        lines.push(`  Type: ${type || 'general'}`);
        lines.push(`  Title: ${title}`);
        lines.push(`  Body: ${body}`);
        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    logPopup(url: string, action: string): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push(`[${timeStr}] 🪟 POPUP ${action.toUpperCase()}`);
        lines.push(`  URL: ${url}`);
        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    logStatusChange(from: string, to: string, url: string, reason?: string): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push('');
        lines.push('▓'.repeat(80));
        lines.push(`[${timeStr}] ⚡ STATUS CHANGE: ${from} → ${to}`);
        lines.push(`  URL: ${url}`);
        if (reason) {
            lines.push(`  Reason: ${reason}`);
        }
        lines.push('▓'.repeat(80));
        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    logScreenshot(url: string, action: string): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push(`[${timeStr}] 📸 SCREENSHOT ${action.toUpperCase()}`);
        lines.push(`  URL: ${url}`);
        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    logNavigation(from: string, to: string): void {
        const timestamp = new Date();
        const timeStr = timestamp.toLocaleString();

        const lines: string[] = [];
        lines.push(`[${timeStr}] 🧭 NAVIGATION`);
        lines.push(`  From: ${from || '(none)'}`);
        lines.push(`  To: ${to}`);
        lines.push('');

        lines.forEach(line => this.writeLog(line));
    }

    private getDomain(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return '';
        }
    }

    getLogFilePath(): string {
        return this.logFilePath;
    }
}

export const debugLogger = new DebugLogger();
export type { DebugLogEntry };
