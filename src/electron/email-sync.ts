/**
 * email-sync.ts
 *
 * Wires email-fetcher + email-parser into the existing notifStore.
 * Paste the require() calls at the top of main.ts alongside your other requires,
 * then call initEmailSync(notifStore, _store) after notifStore is initialised.
 *
 * Tokens are persisted in electron-store under 'gmailToken' / 'outlookToken'.
 * The sync runs once on startup and then every SYNC_INTERVAL_MS.
 */

// ── Add these requires to the top of main.ts ──────────────────────────────────
//
//   const { fetchJobEmails }  = require('./email-fetcher');
//   const { parseJobEmails, checkOllamaAvailable } = require('./email-parser');
//   const { initEmailSync }   = require('./email-sync');
//
// ── Then call this after notifStore is ready (around line ~notifStore init): ──
//
//   initEmailSync(notifStore, _store, mainWindow);
//
// ─────────────────────────────────────────────────────────────────────────────

const { fetchJobEmails }              = require('./email-fetcher');
const { parseJobEmails, checkOllamaAvailable } = require('./email-parser');
const crypto                          = require('crypto');

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

// Maps email parser status → notification type understood by notifications.html
const STATUS_TO_NOTIF_TYPE: Record<string, string> = {
    APPLIED:       'email',
    UNDER_REVIEW:  'email',
    INTERVIEW:     'interview',
    OFFER:         'milestone',
    REJECTED:      'inactivity',
    WITHDRAWN:     'email',
};

// Maps email parser status → human-readable title prefix
const STATUS_TO_TITLE: Record<string, string> = {
    APPLIED:       'Application confirmed',
    UNDER_REVIEW:  'Application under review',
    INTERVIEW:     'Interview invite',
    OFFER:         'Job offer received',
    REJECTED:      'Application update',
    WITHDRAWN:     'Application withdrawn',
};

function buildNotification(parsed: any): object {
    const type    = STATUS_TO_NOTIF_TYPE[parsed.status] ?? 'email';
    const prefix  = STATUS_TO_TITLE[parsed.status]      ?? 'Email update';
    const company = parsed.company ? ` — ${parsed.company}` : '';
    const title   = `${prefix}${company}`;

    // desc shows job title if available, falls back to the LLM summary
    const desc = parsed.jobTitle
        ? `<strong>${parsed.jobTitle}</strong>: ${parsed.summary}`
        : parsed.summary;

    // Only INTERVIEW and OFFER get action buttons
    const actions = (parsed.status === 'INTERVIEW' || parsed.status === 'OFFER')
        ? [{ label: 'View pipeline', action: 'open-pipeline', style: 'primary' },
           { label: 'Dismiss',       action: 'dismiss',       style: 'ghost'   }]
        : [{ label: 'Dismiss',       action: 'dismiss',       style: 'ghost'   }];

    return {
        id:             crypto.randomUUID(),
        type,
        title,
        desc,
        actions,
        unread:         true,
        actionRequired: parsed.status === 'INTERVIEW' || parsed.status === 'OFFER',
        timestamp:      new Date(parsed.receivedAt).getTime() || Date.now(),
        // Extra fields for open-url action if needed later
        jobUrl:         parsed.raw?.id ?? null,
        provider:       parsed.provider,
    };
}

async function runEmailSync(notifStore: any, store: any, mainWindow: any): Promise<void> {
    try {
        const ollamaReady = await checkOllamaAvailable();
        if (!ollamaReady) {
            console.log('[email-sync] Ollama not available, skipping sync');
            return;
        }

        const gmailToken   = store.get('gmailToken')   as string | undefined;
        const outlookToken = store.get('outlookToken') as string | undefined;

        if (!gmailToken && !outlookToken) {
            console.log('[email-sync] No email tokens configured, skipping sync');
            return;
        }

        console.log('[email-sync] Fetching emails...');
        const emails = await fetchJobEmails({ gmailToken, outlookToken });
        if (!emails.length) {
            console.log('[email-sync] No emails matched job filters');
            return;
        }

        console.log(`[email-sync] Parsing ${emails.length} emails with Ollama...`);
        const parsed = await parseJobEmails(emails);
        if (!parsed.length) {
            console.log('[email-sync] No job-related emails found after parsing');
            return;
        }

        // Deduplicate: skip email IDs we've already stored
        const seenIds: string[] = store.get('seenEmailIds') as string[] ?? [];
        const seenSet = new Set(seenIds);

        let added = 0;
        for (const result of parsed) {
            if (seenSet.has(result.emailId)) continue;

            const notif = buildNotification(result);

            // Push into the notifStore (same as NotificationManager does)
            notifStore.add(notif);

            // Push to the renderer if the notifications page is open
            mainWindow?.webContents.send('push-notification-ui', notif);

            seenSet.add(result.emailId);
            added++;
        }

        // Persist seen IDs (cap at 500 to avoid unbounded growth)
        const updatedIds = [...seenSet].slice(-500);
        store.set('seenEmailIds', updatedIds);

        console.log(`[email-sync] Added ${added} new notification(s) from email`);
    } catch (err: any) {
        console.error('[email-sync] Sync error:', err?.message ?? String(err));
    }
}

function initEmailSync(notifStore: any, store: any, mainWindow: any): void {
    // Run immediately on startup (after a short delay so the window is ready)
    setTimeout(() => runEmailSync(notifStore, store, mainWindow), 8_000);

    // Then on an interval
    setInterval(() => runEmailSync(notifStore, store, mainWindow), SYNC_INTERVAL_MS);

    // Allow the renderer to trigger a manual sync (e.g. from settings page)
    const { ipcMain } = require('electron');
    ipcMain.on('sync-emails-now', async (event: any) => {
        console.log('[email-sync] Manual sync triggered');
        await runEmailSync(notifStore, store, mainWindow);
        event.sender.send('email-sync-done');
    });

    // Allow storing tokens from the OAuth flow (wire these up in your auth handler)
    ipcMain.on('save-gmail-token', (_e: any, token: string) => {
        store.set('gmailToken', token);
        console.log('[email-sync] Gmail token saved');
    });

    ipcMain.on('save-outlook-token', (_e: any, token: string) => {
        store.set('outlookToken', token);
        console.log('[email-sync] Outlook token saved');
    });
}

module.exports = { initEmailSync };
