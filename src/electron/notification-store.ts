// notification-store.ts
// ─────────────────────────────────────────────────────────────────────────────
// Owns the persistent list of UI notifications shown in notifications.html.
// Separate from NotificationManager (which fires OS-level alerts) — this layer
// writes to a JSON file and exposes IPC handlers so the renderer can read,
// dismiss, snooze, and mark-read entries without touching main.ts directly.
//
// Usage in main.ts:
//
//   const { NotificationStore } = require('./notification-store');
//   const notifStore = new NotificationStore(storePath, mainWindow);
//
// Then wherever NotificationManager would fire a notification, also call:
//   notifStore.push({ type: 'followup', title: '...', desc: '...', ... });
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const { ipcMain } = require('electron');

// ── Types ────────────────────────────────────────────────────────────────────

export interface UINotificationAction {
  label: string;
  style: 'primary' | 'ghost';
  action: string;   // matches action strings handled in notifications.html
}

export interface UINotificationProgress {
  value: number;
  max: number;
}

export interface UINotification {
  id: string;
  type: 'followup' | 'thankyou' | 'email' | 'interview' | 'weekly' |
  'deadline' | 'inactivity' | 'milestone' | 'daily';
  title: string;
  desc: string;               // may contain <strong> tags
  timestamp: number;
  unread: boolean;
  actionRequired: boolean;
  dismissed: boolean;
  jobUrl?: string;               // used by 'open-url' action
  progress?: UINotificationProgress;
  actions?: UINotificationAction[];
  snoozeUntil?: number | undefined;  // epoch ms; set by snooze-notification IPC
}

// ── NotificationStore ────────────────────────────────────────────────────────

export class NotificationStore {
  private storePath: string;
  private mainWindow: any;
  private notifications: UINotification[] = [];
  private snoozeTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(storePath: string, mainWindow: any) {
    this.storePath = storePath;
    this.mainWindow = mainWindow;

    this.load();
    this.rehydrateSnoozes();
    this.registerIpcHandlers();

    console.log(`[NOTIF-STORE] loaded ${this.notifications.length} notifications`);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        this.notifications = JSON.parse(raw);
      }
    } catch (e) {
      console.error('[NOTIF-STORE] load error:', e);
      this.notifications = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.notifications, null, 2));
    } catch (e) {
      console.error('[NOTIF-STORE] save error:', e);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Push a new notification. Deduplicates by id if one is provided.
   * Sends it to the renderer immediately if the notifications page is open.
   *
   * `id`, `timestamp`, `unread`, and `dismissed` are all optional — the store
   * fills in sensible defaults so callers only need to provide the meaningful fields.
   */
  public push(notif: Partial<Pick<UINotification, 'id' | 'timestamp' | 'unread' | 'dismissed' | 'snoozeUntil'>>
    & Omit<UINotification, 'id' | 'timestamp' | 'unread' | 'dismissed' | 'snoozeUntil'>): void {
    const {
      id,
      timestamp,
      unread,
      dismissed,
      snoozeUntil,
      ...rest
    } = notif as UINotification;
    const record: UINotification = {
      ...rest,
      id: id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: timestamp ?? Date.now(),
      unread: unread ?? true,
      dismissed: dismissed ?? false,
      ...(typeof snoozeUntil === 'number' ? { snoozeUntil } : {}),
    };

    // Remove existing entry with same id (dedup / update)
    this.notifications = this.notifications.filter(n => n.id !== record.id);

    // Prepend so newest appears first
    this.notifications.unshift(record);

    // Cap history at 200 entries (dismissed ones pruned first)
    if (this.notifications.length > 200) {
      const dismissed = this.notifications.filter(n => n.dismissed);
      const active = this.notifications.filter(n => !n.dismissed);
      this.notifications = [...active, ...dismissed].slice(0, 200);
    }

    this.save();

    // Push to renderer if it's currently showing notifications.html
    try {
      this.mainWindow?.webContents?.send('push-notification-ui', record);
    } catch (_) { /* window not ready */ }

    console.log(`[NOTIF-STORE] pushed: [${record.type}] ${record.title}`);
  }

  /** Return the full list (used by get-notifications IPC handler). */
  public getAll(): UINotification[] {
    return this.notifications;
  }

  /** Unread count — useful for tray badge or other UI. */
  public unreadCount(): number {
    return this.notifications.filter(n => n.unread && !n.dismissed).length;
  }

  // ── Snooze re-hydration (survive app restarts) ─────────────────────────────

  private rehydrateSnoozes(): void {
    const now = Date.now();
    for (const n of this.notifications) {
      if (n.snoozeUntil && n.snoozeUntil > now && !n.dismissed) {
        const delay = n.snoozeUntil - now;
        const timer = setTimeout(() => this.unsnoozePush(n), delay);
        this.snoozeTimers.set(n.id, timer);
      }
    }
  }

  private unsnoozePush(original: UINotification): void {
    this.snoozeTimers.delete(original.id);
    // Re-push without snoozeUntil — destructure it out so we never pass undefined
    // to a field that exactOptionalPropertyTypes won't allow
    const { snoozeUntil: _dropped, ...rest } = original;
    this.push({ ...rest, dismissed: false });
  }

  // ── IPC Handlers ──────────────────────────────────────────────────────────
  // Register once; safe to call from constructor.

  private registerIpcHandlers(): void {
    // Renderer requests the full list on page load
    ipcMain.on('get-notifications', (event: any) => {
      event.sender.send('notifications-data', this.notifications);
    });

    // Mark a single notification as read
    ipcMain.on('mark-notification-read', (_e: any, id: string) => {
      const n = this.notifications.find(x => x.id === id);
      if (n) { n.unread = false; this.save(); }
    });

    // Mark all as read
    ipcMain.on('mark-all-notifications-read', () => {
      this.notifications.forEach(n => n.unread = false);
      this.save();
    });

    // Dismiss a single notification
    ipcMain.on('dismiss-notification', (_e: any, id: string) => {
      const n = this.notifications.find(x => x.id === id);
      if (n) {
        n.dismissed = true;
        n.unread = false;
        n.actionRequired = false;
        this.save();
      }
    });

    // Clear all notifications
    ipcMain.on('clear-all-notifications', () => {
      this.notifications = [];
      this.save();
    });

    // Snooze: hide for configurable duration then re-push
    // Accepts either a plain id string (legacy) or { id, durationMins } object
    ipcMain.on('snooze-notification', (_e: any, payload: string | { id: string; durationMins?: number }) => {
      const id = typeof payload === 'string' ? payload : payload.id;
      const durationMins = typeof payload === 'object' && payload.durationMins ? payload.durationMins : 120;
      const n = this.notifications.find(x => x.id === id);
      if (!n) return;

      // Cancel any existing snooze timer
      const existing = this.snoozeTimers.get(id);
      if (existing) clearTimeout(existing);

      const durationMs = durationMins * 60 * 1000;
      const snoozeUntil = Date.now() + durationMs;
      n.snoozeUntil = snoozeUntil;
      n.dismissed = true; // hide from the list while snoozed
      this.save();

      const timer = setTimeout(() => this.unsnoozePush(n), durationMs);
      this.snoozeTimers.set(id, timer);

      console.log(`[NOTIF-STORE] snoozed ${id} for ${durationMins}m`);
    });

    // Test notification: inject a real card into the feed (fired from settings)
    ipcMain.on('push-test-notification', (_e: any, partial: Partial<UINotification>) => {
      this.push({
        type: (partial.type as UINotification['type']) || 'daily',
        title: partial.title || 'HiredFinally Test',
        desc: partial.desc || 'This is a test notification.',
        actionRequired: false,
        actions: [{ label: 'Dismiss', style: 'ghost', action: 'dismiss' }],
      });
    });

    // Navigate to notifications page (from other pages' sidebar bell)
    ipcMain.on('open-notifications', () => {
      const path = require('path');
      this.mainWindow?.loadFile(path.join(__dirname, 'notifications.html'));
    });
  }

  public cleanup(): void {
    this.snoozeTimers.forEach(t => clearTimeout(t));
    this.snoozeTimers.clear();
  }
}

module.exports = { NotificationStore };