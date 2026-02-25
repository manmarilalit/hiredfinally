// Type definitions for HiredFinally Job Tracker

// Database types
export interface JobAppRow {
    url: string;
    status: 'IN_PROGRESS' | 'COMPLETED';
    created_at?: string;
    updated_at?: string;
}

export interface DatabaseInterface {
    prepare(query: string): {
        get(param?: any): any;
        run(...params: any[]): any;
        all(...params: any[]): any[];
    };
    exec(sql: string): void;
}

// Page signals from preload script
export interface PageSignals {
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

// Status detection results
export type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';
export type Confidence = 'high' | 'medium' | 'low';

export interface DetectionResult {
    status: Status;
    reasoning: string[];
    confidence: Confidence;
}

// Notification types
export interface NotificationSettings {
    enabled: boolean;
    followUpEnabled: boolean;
    followUpDelay: number; // hours
    dailyReminderEnabled: boolean;
    dailyReminderTime: string; // "HH:MM" format
    emailCheckEnabled: boolean;
    emailCheckInterval: number; // minutes
    inactivityReminderEnabled: boolean;
    inactivityDelay: number; // days
    weeklyGoalEnabled: boolean;
    weeklyGoal: number; // number of applications
    soundEnabled: boolean;
}

export interface NotificationOptions {
    title: string;
    body: string;
    tag: string;
    urgency: 'low' | 'normal' | 'critical';
    actions?: Array<{ type: string; text: string }>;
}

export interface NotificationData {
    type: 'followup' | 'daily-reminder' | 'email-response' | 'inactivity-reminder' | 'weekly-goal' | 'deadline' | 'celebration';
    [key: string]: any;
}

export type MilestoneType = 'first' | '5' | '10' | '25' | '50' | '100';

// Confirmation dialog data
export interface ConfirmationDialogData {
    currentStatus: Status;
    newStatus: Status;
    confidence: Confidence;
    url: string;
    urlChanged: boolean;
    wasPopup: boolean;
}

export interface PendingConfirmation {
    url: string;
    status: Status;
    reasoning: string[];
    confidence: Confidence;
    urlChanged: boolean;
    wasPopup: boolean;
}

// Job board data
export interface JobBoard {
    name: string;
    url: string;
    logo: string;
}

// IPC Message types
export type IPCChannel = 
    | 'webview-data'
    | 'status-confirmation'
    | 'load-in-webview'
    | 'update-status-badge'
    | 'show-confirmation-dialog'
    | 'hide-confirmation-dialog'
    | 'open-settings'
    | 'get-settings'
    | 'save-settings'
    | 'settings-loaded'
    | 'export-application-data'
    | 'clear-application-data'
    | 'test-message'
    | 'page-data';

// Electron types (for better autocomplete)
export interface BrowserWindowType {
    webContents: {
        send(channel: string, ...args: any[]): void;
    };
    setMenuBarVisibility(visible: boolean): void;
    loadFile(path: string): Promise<void>;
    on(event: string, callback: Function): void;
    focus(): void;
}

// Export types for external use
export type UrlType = string;
export type JobTitle = string;
export type EmailAddress = string;