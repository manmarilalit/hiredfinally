//notifications.ts
const { Notification } = require('electron');
const path = require('path');

// Type definitions
interface NotificationSettings {
  enabled: boolean;
  // viewed-job follow-up (fires when user leaves a job page without applying)
  followUpEnabled: boolean;
  followUpDelay: number;          // hours
  // post-application follow-up email nudge (fires X days after COMPLETED)
  postApplyFollowUpEnabled: boolean;
  postApplyFollowUpDelay: number; // days, default 10
  // spam folder check (fires X days after COMPLETED)
  spamCheckEnabled: boolean;
  spamCheckDelay: number;         // days, default 3
  // keep-applying nudge (fires when apps are waiting with no new activity)
  keepApplyingEnabled: boolean;
  // milestone celebrations (1, 5, 10, 25, 50, 100 apps)
  milestoneEnabled: boolean;
  dailyReminderEnabled: boolean;
  dailyReminderTime: string;      // "HH:MM"
  emailCheckEnabled: boolean;
  emailCheckInterval: number;     // minutes
  inactivityReminderEnabled: boolean;
  inactivityDelay: number;        // days
  weeklyGoalEnabled: boolean;
  weeklyGoal: number;
  soundEnabled: boolean;
}

interface ScheduledNotification {
  id: string;
  type: string;
  scheduledTime: number;
  data: any;
}

interface NotificationOptions {
  title: string;
  body: string;
  tag: string;
  urgency: 'low' | 'normal' | 'critical';
  actions?: Array<{ type: string; text: string }>;
}

interface NotificationData {
  type: string;
  [key: string]: any;
}

interface DatabaseInterface {
  prepare(query: string): {
    get(param?: any): any;
    run(...params: any[]): any;
    all(...params: any[]): any[];
  };
}

interface JobAppCountResult {
  count: number;
}

class NotificationManager {
  private settings: NotificationSettings;
  private scheduledNotifications: Map<string, NodeJS.Timeout>;
  private lastApplicationTime: number;
  private applicationsThisWeek: number;
  private settingsPath: string;
  private db: DatabaseInterface;
  private notifStore: any; // NotificationStore instance — optional

  constructor(db: DatabaseInterface, settingsPath: string, notifStore?: any) {
    this.db = db;
    this.settingsPath = settingsPath;
    this.notifStore = notifStore ?? null;
    this.scheduledNotifications = new Map();
    this.lastApplicationTime = Date.now();
    this.applicationsThisWeek = 0;

    this.settings = this.loadSettings();
    this.resetWeeklyCounterIfNeeded();
    this.startPeriodicChecks();
  }

  private loadSettings(): NotificationSettings {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.log('[NOTIFICATIONS] Could not load settings, using defaults:', error);
    }

    return {
      enabled: true,
      followUpEnabled: true,
      followUpDelay: 24,
      postApplyFollowUpEnabled: true,
      postApplyFollowUpDelay: 10,
      spamCheckEnabled: true,
      spamCheckDelay: 3,
      keepApplyingEnabled: true,
      milestoneEnabled: true,
      dailyReminderEnabled: true,
      dailyReminderTime: "10:00",
      emailCheckEnabled: false,
      emailCheckInterval: 30,
      inactivityReminderEnabled: true,
      inactivityDelay: 3,
      weeklyGoalEnabled: true,
      weeklyGoal: 5,
      soundEnabled: true
    };
  }

  private saveSettings(): void {
    try {
      const fs = require('fs');
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('[NOTIFICATIONS] Failed to save settings:', error);
    }
  }

  public updateSettings(newSettings: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.saveSettings();
    this.startPeriodicChecks();
  }

  public getSettings(): NotificationSettings {
    return { ...this.settings };
  }

  // ── mapToPushPayload ──────────────────────────────────────────────────────
  // Converts an OS-level notification into a UINotification payload for the
  // in-app feed (notifications.html via NotificationStore).

  private mapToPushPayload(options: NotificationOptions, data?: NotificationData) {
    const TYPE_ACTION_MAP: Record<string, { actionRequired: boolean; actions: any[] }> = {
      'followup': {
        actionRequired: true,
        actions: [
          { label: 'Open job', style: 'primary', action: 'open-url' },
          { label: 'Dismiss', style: 'ghost', action: 'dismiss' },
        ],
      },
      'daily-reminder': {
        actionRequired: false,
        actions: [],
      },
      'inactivity-reminder': {
        actionRequired: false,
        actions: [
          { label: 'Start applying', style: 'primary', action: 'navigate-home' },
          { label: 'Dismiss', style: 'ghost', action: 'dismiss' },
        ],
      },
      'weekly-goal': {
        actionRequired: false,
        actions: [
          { label: 'View pipeline', style: 'ghost', action: 'open-pipeline' },
        ],
      },
      'celebration': {
        actionRequired: false,
        actions: [
          { label: 'View pipeline', style: 'ghost', action: 'open-pipeline' },
        ],
      },
      'deadline': {
        actionRequired: true,
        actions: [
          { label: 'Open listing', style: 'primary', action: 'open-url' },
          { label: 'Dismiss', style: 'ghost', action: 'dismiss' },
        ],
      },
      'interview': {
        actionRequired: true,
        actions: [
          { label: 'Open job listing', style: 'primary', action: 'open-url' },
          { label: 'Dismiss', style: 'ghost', action: 'dismiss' },
        ],
      },
      'thankyou': {
        actionRequired: true,
        actions: [
          { label: 'Mark done', style: 'primary', action: 'dismiss' },
          { label: 'Remind me in 2h', style: 'ghost', action: 'snooze' },
        ],
      },
      'post-apply-followup': {
        actionRequired: true,
        actions: [
          { label: 'Open application', style: 'primary', action: 'open-url' },
          { label: 'Dismiss', style: 'ghost', action: 'dismiss' },
        ],
      },
      'spam-check': {
        actionRequired: true,
        actions: [
          { label: 'Got it', style: 'primary', action: 'dismiss' },
        ],
      },
      'keep-applying': {
        actionRequired: false,
        actions: [
          { label: 'Start applying', style: 'primary', action: 'navigate-home' },
          { label: 'Dismiss', style: 'ghost', action: 'dismiss' },
        ],
      },
    };

    const mapped = TYPE_ACTION_MAP[data?.type ?? ''] ?? { actionRequired: false, actions: [] };

    return {
      type: (data?.type ?? 'daily') as any,
      title: options.title,
      desc: options.body,
      actionRequired: mapped.actionRequired,
      actions: mapped.actions,
      jobUrl: data?.jobUrl,
      ...(data?.type === 'weekly-goal'
        ? { progress: { value: data.progress ?? 0, max: this.settings.weeklyGoal } }
        : {}),
    };
  }

  // ============================================================
  // NOTIFICATION TYPE 1: Follow-up on viewed job
  // ============================================================
  public scheduleFollowUpNotification(jobUrl: string, jobTitle: string): void {
    if (!this.settings.enabled || !this.settings.followUpEnabled) return;

    const notificationId = `followup-${jobUrl}`;
    this.cancelNotification(notificationId);

    const delay = this.settings.followUpDelay * 60 * 60 * 1000;

    const timeout = setTimeout(() => {
      this.showNotification({
        title: '⏰ Follow-up Reminder',
        body: `Don't forget to apply to: ${jobTitle}`,
        tag: notificationId,
        urgency: 'normal',
        actions: [
          { type: 'button', text: 'Apply Now' },
          { type: 'button', text: 'Remind Me Later' },
          { type: 'button', text: 'Dismiss' }
        ]
      }, {
        type: 'followup',
        jobUrl,
        jobTitle,
      });
    }, delay);

    this.scheduledNotifications.set(notificationId, timeout);
    console.log(`[NOTIFICATIONS] Scheduled follow-up for "${jobTitle}" in ${this.settings.followUpDelay} hours`);
  }

  // ============================================================
  // NOTIFICATION TYPE 2: Daily reminder to apply
  // ============================================================
  private scheduleDailyReminder(): void {
    if (!this.settings.enabled || !this.settings.dailyReminderEnabled) return;

    const timeParts = this.settings.dailyReminderTime.split(':');
    if (timeParts.length !== 2 || !timeParts[0] || !timeParts[1]) {
      console.error('[NOTIFICATIONS] Invalid time format:', this.settings.dailyReminderTime);
      return;
    }

    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);

    if (isNaN(hours) || isNaN(minutes)) {
      console.error('[NOTIFICATIONS] Invalid time values:', this.settings.dailyReminderTime);
      return;
    }

    const now = new Date();
    const scheduledTime = new Date();
    scheduledTime.setHours(hours, minutes, 0, 0);

    if (scheduledTime <= now) {
      scheduledTime.setDate(scheduledTime.getDate() + 1);
    }

    const delay = scheduledTime.getTime() - now.getTime();
    const notificationId = 'daily-reminder';
    this.cancelNotification(notificationId);

    const timeout = setTimeout(() => {
      const completedToday = this.getApplicationsCompletedToday();
      const inProgressToday = this.getApplicationsInProgressToday();

      let message = '';
      if (completedToday === 0 && inProgressToday === 0) {
        message = '🎯 Good morning! Ready to apply to some jobs today?';
      } else if (inProgressToday > 0 && completedToday === 0) {
        message = `📝 You have ${inProgressToday} application${inProgressToday > 1 ? 's' : ''} in progress. Finish strong!`;
      } else {
        message = `✨ Great job! You've applied to ${completedToday} job${completedToday > 1 ? 's' : ''} today. Keep it up!`;
      }

      this.showNotification({
        title: '☀️ Daily Application Reminder',
        body: message,
        tag: notificationId,
        urgency: 'normal'
      }, { type: 'daily-reminder' });

      this.scheduleDailyReminder();
    }, delay);

    this.scheduledNotifications.set(notificationId, timeout);
    console.log(`[NOTIFICATIONS] Daily reminder scheduled for ${scheduledTime.toLocaleString()}`);
  }

  // ============================================================
  // NOTIFICATION TYPE 3: Email response detection
  // ============================================================
  public scheduleEmailCheck(): void {
    if (!this.settings.enabled || !this.settings.emailCheckEnabled) return;

    const notificationId = 'email-check';
    const interval = this.settings.emailCheckInterval * 60 * 1000;

    this.cancelNotification(notificationId);

    const intervalId = setInterval(async () => {
      await this.checkForEmailResponses();
    }, interval);

    this.scheduledNotifications.set(notificationId, intervalId as any);
    console.log(`[NOTIFICATIONS] Email checking scheduled every ${this.settings.emailCheckInterval} minutes`);
  }

  private async checkForEmailResponses(): Promise<void> {
    console.log('[NOTIFICATIONS] Checking for email responses...');
  }

  // ============================================================
  // NOTIFICATION TYPE 4: Inactivity reminder
  // ============================================================
  private scheduleInactivityCheck(): void {
    if (!this.settings.enabled || !this.settings.inactivityReminderEnabled) return;

    const notificationId = 'inactivity-check';
    const checkInterval = 24 * 60 * 60 * 1000;

    this.cancelNotification(notificationId);

    const intervalId = setInterval(() => {
      const daysSinceLastApplication = this.getDaysSinceLastApplication();

      if (daysSinceLastApplication >= this.settings.inactivityDelay) {
        let message = '';
        if (daysSinceLastApplication === this.settings.inactivityDelay) {
          message = `⚠️ It's been ${daysSinceLastApplication} days since your last application. Time to get back in the game!`;
        } else if (daysSinceLastApplication === 7) {
          message = '🔔 A week without applications! Your dream job is waiting for you.';
        } else if (daysSinceLastApplication === 14) {
          message = '❗ Two weeks of inactivity. Let\'s break this streak together!';
        } else if (daysSinceLastApplication >= 30) {
          message = '🚨 It\'s been a month! Don\'t give up - consistency is key to landing your next role.';
        } else {
          message = `It's been ${daysSinceLastApplication} days. Ready to apply to some jobs?`;
        }

        this.showNotification({
          title: '💼 Time to Apply!',
          body: message,
          tag: notificationId,
          urgency: 'normal'
        }, {
          type: 'inactivity-reminder',
          daysSinceLastApplication,
        });
      }
    }, checkInterval);

    this.scheduledNotifications.set(notificationId, intervalId as any);
    console.log('[NOTIFICATIONS] Inactivity checking enabled');
  }

  // ============================================================
  // NOTIFICATION TYPE 5: Weekly goal progress
  // ============================================================
  private scheduleWeeklyGoalCheck(): void {
    if (!this.settings.enabled || !this.settings.weeklyGoalEnabled) return;

    const notificationId = 'weekly-goal';
    const checkInterval = 6 * 60 * 60 * 1000;

    this.cancelNotification(notificationId);

    const intervalId = setInterval(() => {
      const progress = this.applicationsThisWeek;
      const goal = this.settings.weeklyGoal;
      const remaining = goal - progress;

      const now = new Date();
      const dayOfWeek = now.getDay();
      const hour = now.getHours();

      if (dayOfWeek === 3 && hour === 18) {
        if (progress < goal / 2) {
          this.showNotification({
            title: '📊 Midweek Check-in',
            body: `You're at ${progress}/${goal} applications this week. Let's pick up the pace!`,
            tag: `${notificationId}-midweek`,
            urgency: 'normal'
          }, { type: 'weekly-goal', progress, goal });
        } else {
          this.showNotification({
            title: '🎉 Great Progress!',
            body: `${progress}/${goal} applications this week. You're on track!`,
            tag: `${notificationId}-midweek`,
            urgency: 'low'
          }, { type: 'weekly-goal', progress, goal });
        }
      }

      if (dayOfWeek === 5 && hour === 18) {
        if (progress >= goal) {
          this.showNotification({
            title: '🏆 Goal Achieved!',
            body: `Awesome! You've applied to ${progress} jobs this week (goal: ${goal})!`,
            tag: `${notificationId}-achieved`,
            urgency: 'low'
          }, { type: 'weekly-goal', progress, goal });
        } else if (remaining <= 2) {
          this.showNotification({
            title: '🎯 Almost There!',
            body: `Just ${remaining} more application${remaining > 1 ? 's' : ''} to hit your weekly goal!`,
            tag: `${notificationId}-almostthere`,
            urgency: 'normal'
          }, { type: 'weekly-goal', progress, goal });
        } else {
          this.showNotification({
            title: '📈 Weekend Push',
            body: `${remaining} applications left to reach your weekly goal. You've got this!`,
            tag: `${notificationId}-weekend`,
            urgency: 'normal'
          }, { type: 'weekly-goal', progress, goal });
        }
      }
    }, checkInterval);

    this.scheduledNotifications.set(notificationId, intervalId as any);
    console.log('[NOTIFICATIONS] Weekly goal checking enabled');
  }

  // ============================================================
  // NOTIFICATION TYPE 6: Application deadline reminder
  // ============================================================
  public scheduleDeadlineReminder(jobUrl: string, jobTitle: string, deadline: Date): void {
    if (!this.settings.enabled) return;

    const notificationId = `deadline-${jobUrl}`;
    const now = Date.now();
    const deadlineTime = deadline.getTime();
    const timeUntilDeadline = deadlineTime - now;

    this.cancelNotification(notificationId);

    if (timeUntilDeadline > 24 * 60 * 60 * 1000) {
      const delay24h = timeUntilDeadline - (24 * 60 * 60 * 1000);
      setTimeout(() => {
        this.showNotification({
          title: '⏳ Deadline Tomorrow!',
          body: `Application deadline for "${jobTitle}" is tomorrow`,
          tag: `${notificationId}-24h`,
          urgency: 'normal'
        }, { type: 'deadline', jobUrl, jobTitle, hoursRemaining: 24 });
      }, delay24h);
    }

    if (timeUntilDeadline > 6 * 60 * 60 * 1000) {
      const delay6h = timeUntilDeadline - (6 * 60 * 60 * 1000);
      setTimeout(() => {
        this.showNotification({
          title: '⚠️ Deadline in 6 Hours!',
          body: `Final reminder: "${jobTitle}" deadline is in 6 hours`,
          tag: `${notificationId}-6h`,
          urgency: 'critical'
        }, { type: 'deadline', jobUrl, jobTitle, hoursRemaining: 6 });
      }, delay6h);
    }

    console.log(`[NOTIFICATIONS] Deadline reminders scheduled for "${jobTitle}"`);
  }

  // ============================================================
  // NOTIFICATION TYPE 7: Success celebration
  // ============================================================
  public showCelebration(milestone: 'first' | '5' | '10' | '25' | '50' | '100', count: number): void {
    if (!this.settings.enabled || !this.settings.milestoneEnabled) return;

    const messages: Record<'first' | '5' | '10' | '25' | '50' | '100', string> = {
      'first': '🎉 Your first application is complete! Great start!',
      '5': '🌟 5 applications completed! You\'re building momentum!',
      '10': '💪 10 applications! You\'re getting good at this!',
      '25': '🚀 25 applications! You\'re a job-hunting machine!',
      '50': '🏅 50 applications! Your persistence is inspiring!',
      '100': '👑 100 applications! You\'re a legend! Your dream job is closer than ever!'
    };

    this.showNotification({
      title: '🎊 Milestone Achieved!',
      body: messages[milestone],
      tag: `celebration-${milestone}`,
      urgency: 'low'
    }, { type: 'celebration', milestone, count });
  }

  // ============================================================
  // Core: show a native OS notification + push to in-app feed
  // ============================================================
  private showNotification(options: NotificationOptions, data?: NotificationData): void {
    if (!this.settings.enabled) return;

    try {
      // Windows requires appUserModelId to be set — verify Notification is supported
      if (!Notification.isSupported()) {
        console.log('[NOTIFICATIONS] Notifications not supported on this platform');
        // Still push to in-app feed even if OS notification fails
        if (this.notifStore) {
          this.notifStore.push(this.mapToPushPayload(options, data));
        }
        return;
      }

      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: !this.settings.soundEnabled,
        // Windows: icon helps notifications appear reliably
        icon: require('path').join(__dirname, 'icon.png'),
      });

      notification.on('click', () => {
        console.log('[NOTIFICATIONS] Notification clicked:', data?.type);
      });

      notification.on('failed', (e: any) => {
        console.error('[NOTIFICATIONS] Notification failed to show:', e);
      });

      notification.show();
      console.log(`[NOTIFICATIONS] OS notification fired: ${options.title}`);

      if (this.notifStore) {
        this.notifStore.push(this.mapToPushPayload(options, data));
      }

    } catch (error) {
      console.error('[NOTIFICATIONS] Failed to show notification:', error);
    }
  }

  private cancelNotification(notificationId: string): void {
    const timeout = this.scheduledNotifications.get(notificationId);
    if (timeout) {
      clearTimeout(timeout);
      this.scheduledNotifications.delete(notificationId);
      console.log(`[NOTIFICATIONS] Cancelled notification: ${notificationId}`);
    }
  }

  private getApplicationsCompletedToday(): number {
    try {
      const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      const todayPct = `${today}%`;
      const result = this.db.prepare(
        // Use completed_at; fall back to applied_at for legacy rows.
        // Single param reused via SQLite's ?1 positional syntax.
        `SELECT COUNT(*) as count FROM job_apps
                 WHERE status = 'COMPLETED'
                 AND (
                     (completed_at IS NOT NULL AND completed_at LIKE ?1)
                     OR (completed_at IS NULL AND applied_at LIKE ?1)
                 )`
      ).get(todayPct) as { count: number } | undefined;
      return result ? result.count : 0;
    } catch { return 0; }
  }

  private getApplicationsInProgressToday(): number {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const result = this.db.prepare(
        "SELECT COUNT(*) as count FROM job_apps WHERE status = 'IN_PROGRESS' AND applied_at LIKE ?"
      ).get(`${today}%`) as { count: number } | undefined;
      return result ? result.count : 0;
    } catch { return 0; }
  }

  // ── Returns all COMPLETED apps with days since submission ───────────────────
  // Uses completed_at (set when status changes to COMPLETED) so timers are
  // based on actual submission time, not when the form was first opened.
  // Falls back to applied_at for legacy rows that pre-date the completed_at column.
  private getCompletedAppsByAge(): Array<{
    url: string;
    job_title: string;
    company: string;
    applied_at: string;
    completed_at: string | null;
    daysSince: number;
  }> {
    try {
      const rows = this.db.prepare(
        "SELECT url, job_title, company, applied_at, completed_at FROM job_apps WHERE status = 'COMPLETED' ORDER BY completed_at DESC"
      ).all() as Array<{ url: string; job_title: string; company: string; applied_at: string; completed_at: string | null }>;

      const now = Date.now();
      return rows.map(r => {
        // Prefer completed_at; fall back to applied_at for legacy rows
        const raw = r.completed_at || r.applied_at;
        const ms = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z').getTime();
        const daysSince = Math.floor((now - ms) / (24 * 60 * 60 * 1000));
        return { ...r, daysSince };
      });
    } catch { return []; }
  }

  private getDaysSinceLastApplication(): number {
    // Prefer DB query over in-memory counter — more accurate after restarts
    // Uses completed_at as "last submitted", falls back to applied_at for legacy rows
    try {
      const row = this.db.prepare(`
                SELECT
                    COALESCE(completed_at, applied_at) as last_ts
                FROM job_apps
                WHERE status = 'COMPLETED'
                ORDER BY COALESCE(completed_at, applied_at) DESC
                LIMIT 1
            `).get() as { last_ts: string } | undefined;

      if (row?.last_ts) {
        const raw = row.last_ts;
        const ms = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z').getTime();
        return Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
      }
    } catch { /* fall through */ }

    // Fallback to in-memory counter (covers the current session before first DB write)
    return Math.floor((Date.now() - this.lastApplicationTime) / (24 * 60 * 60 * 1000));
  }

  private resetWeeklyCounterIfNeeded(): void {
    if (new Date().getDay() === 1) {
      this.applicationsThisWeek = 0;
    }
  }

  // ============================================================
  // NOTIFICATION TYPE 8: Post-application spam check
  // Fires ~spamCheckDelay days after a COMPLETED application.
  // Runs on a daily interval and checks the DB for apps that just hit the threshold.
  // ============================================================
  private scheduleSpamCheck(): void {
    if (!this.settings.enabled || !this.settings.spamCheckEnabled) return;

    const notificationId = 'spam-check';
    this.cancelNotification(notificationId);

    const intervalId = setInterval(() => {
      if (!this.settings.spamCheckEnabled) return;

      const apps = this.getCompletedAppsByAge();
      for (const app of apps) {
        // Only fire on the exact day it crosses the threshold (within a 24h window)
        if (app.daysSince === this.settings.spamCheckDelay) {
          const appId = `spam-check-${app.url}`;
          // Don't re-fire if already sent (track via scheduledNotifications keys)
          if (this.scheduledNotifications.has(appId)) continue;

          const title = app.job_title || 'your recent application';
          const company = app.company ? ` at ${app.company}` : '';

          this.showNotification({
            title: '📧 Check Your Spam Folder',
            body: `It's been ${app.daysSince} days since you applied for ${title}${company}. Recruiter replies often land in spam — worth a quick check.`,
            tag: appId,
            urgency: 'normal',
          }, { type: 'spam-check', jobUrl: app.url });

          // Mark as fired so it doesn't repeat
          this.scheduledNotifications.set(appId, setTimeout(() => {
            this.scheduledNotifications.delete(appId);
          }, 25 * 60 * 60 * 1000) as any); // expire after 25h
        }
      }
    }, 60 * 60 * 1000); // check every hour

    this.scheduledNotifications.set(notificationId, intervalId as any);
    console.log('[NOTIFICATIONS] Spam check scheduling enabled');
  }

  // ============================================================
  // NOTIFICATION TYPE 9: Post-application follow-up email nudge
  // Fires ~postApplyFollowUpDelay days after a COMPLETED application.
  // "You applied X days ago — send a polite follow-up email."
  // ============================================================
  private schedulePostApplyFollowUp(): void {
    if (!this.settings.enabled || !this.settings.postApplyFollowUpEnabled) return;

    const notificationId = 'post-apply-followup';
    this.cancelNotification(notificationId);

    const intervalId = setInterval(() => {
      if (!this.settings.postApplyFollowUpEnabled) return;

      const apps = this.getCompletedAppsByAge();
      for (const app of apps) {
        if (app.daysSince === this.settings.postApplyFollowUpDelay) {
          const appId = `post-apply-followup-${app.url}`;
          if (this.scheduledNotifications.has(appId)) continue;

          const title = app.job_title || 'a job';
          const company = app.company ? ` at ${app.company}` : '';

          this.showNotification({
            title: '⏰ Time to Follow Up',
            body: `It's been ${app.daysSince} days since you applied for ${title}${company}. Send a short, polite follow-up email to stay on their radar.`,
            tag: appId,
            urgency: 'normal',
          }, { type: 'post-apply-followup', jobUrl: app.url });

          this.scheduledNotifications.set(appId, setTimeout(() => {
            this.scheduledNotifications.delete(appId);
          }, 25 * 60 * 60 * 1000) as any);
        }
      }
    }, 60 * 60 * 1000);

    this.scheduledNotifications.set(notificationId, intervalId as any);
    console.log('[NOTIFICATIONS] Post-apply follow-up scheduling enabled');
  }

  // ============================================================
  // NOTIFICATION TYPE 10: Keep applying nudge
  // Fires when the user has pending applications but hasn't applied
  // to anything new in keepApplyingDelay days.
  // Different from inactivity — this is specifically "don't put all
  // your eggs in one basket while waiting."
  // ============================================================
  private scheduleKeepApplyingCheck(): void {
    if (!this.settings.enabled || !this.settings.keepApplyingEnabled) return;

    const notificationId = 'keep-applying';
    this.cancelNotification(notificationId);

    const KEEP_APPLYING_THRESHOLD_DAYS = 3; // if no new apps in 3 days but have pending

    const intervalId = setInterval(() => {
      if (!this.settings.keepApplyingEnabled) return;

      try {
        // Count apps submitted in the last N days, using completed_at
        // (falls back to applied_at for legacy rows without completed_at)
        const cutoff = new Date(Date.now() - KEEP_APPLYING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        const recentResult = this.db.prepare(
          `SELECT COUNT(*) as count FROM job_apps
                     WHERE status = 'COMPLETED'
                     AND (
                         (completed_at IS NOT NULL AND completed_at >= ?1)
                         OR (completed_at IS NULL AND applied_at >= ?1)
                     )`
        ).get(cutoff) as { count: number } | undefined;
        const recentCount = recentResult ? recentResult.count : 0;

        // Count total pending (completed but presumably awaiting response)
        const pendingResult = this.db.prepare(
          "SELECT COUNT(*) as count FROM job_apps WHERE status = 'COMPLETED'"
        ).get() as { count: number } | undefined;
        const pendingCount = pendingResult ? pendingResult.count : 0;

        // Only fire if: no recent apps AND has pending apps waiting
        if (recentCount === 0 && pendingCount >= 1) {
          const now = new Date();
          // Fire once per day at noon
          if (now.getHours() === 12) {
            this.showNotification({
              title: '💼 Keep Your Pipeline Full',
              body: `You have ${pendingCount} application${pendingCount > 1 ? 's' : ''} waiting on responses. Don't stop — keep applying while you wait.`,
              tag: `keep-applying-${now.toISOString().slice(0, 10)}`,
              urgency: 'normal',
            }, { type: 'keep-applying' });
          }
        }
      } catch { /* ignore DB errors */ }
    }, 60 * 60 * 1000); // check every hour

    this.scheduledNotifications.set(notificationId, intervalId as any);
    console.log('[NOTIFICATIONS] Keep-applying check enabled');
  }

  // ============================================================
  // Public API
  // ============================================================
  public onApplicationCompleted(jobUrl: string, jobTitle: string): void {
    this.lastApplicationTime = Date.now();
    this.applicationsThisWeek++;

    this.cancelNotification(`followup-${jobUrl}`);

    const totalCompleted = this.getTotalApplicationsCompleted();
    if (totalCompleted === 1) this.showCelebration('first', 1);
    else if (totalCompleted === 5) this.showCelebration('5', 5);
    else if (totalCompleted === 10) this.showCelebration('10', 10);
    else if (totalCompleted === 25) this.showCelebration('25', 25);
    else if (totalCompleted === 50) this.showCelebration('50', 50);
    else if (totalCompleted === 100) this.showCelebration('100', 100);

    console.log(`[NOTIFICATIONS] Application completed: ${jobTitle}`);
  }

  private getTotalApplicationsCompleted(): number {
    const result = this.db.prepare("SELECT COUNT(*) as count FROM job_apps WHERE status = 'COMPLETED'").get() as { count: number } | undefined;
    return result ? result.count : 0;
  }

  public startPeriodicChecks(): void {
    const periodicIds = [
      'daily-reminder', 'email-check', 'inactivity-check',
      'weekly-goal', 'spam-check', 'post-apply-followup', 'keep-applying',
    ];
    this.scheduledNotifications.forEach((_timeout, id) => {
      if (periodicIds.includes(id)) this.cancelNotification(id);
    });

    this.scheduleDailyReminder();
    this.scheduleEmailCheck();
    this.scheduleInactivityCheck();
    this.scheduleWeeklyGoalCheck();
    this.scheduleSpamCheck();
    this.schedulePostApplyFollowUp();
    this.scheduleKeepApplyingCheck();

    console.log('[NOTIFICATIONS] Periodic checks started');
  }

  public cleanup(): void {
    this.scheduledNotifications.forEach((timeout) => {
      clearTimeout(timeout);
    });
    this.scheduledNotifications.clear();
    console.log('[NOTIFICATIONS] Cleanup complete');
  }
}

module.exports = { NotificationManager };