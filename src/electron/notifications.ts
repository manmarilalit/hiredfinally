//notifications.ts
const { Notification } = require('electron');
const path = require('path');

// Type definitions
interface NotificationSettings {
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

    constructor(db: DatabaseInterface, settingsPath: string) {
        this.db = db;
        this.settingsPath = settingsPath;
        this.scheduledNotifications = new Map();
        this.lastApplicationTime = Date.now();
        this.applicationsThisWeek = 0;
        
        // Load settings from storage
        this.settings = this.loadSettings();
        
        // Initialize weekly counter
        this.resetWeeklyCounterIfNeeded();
        
        // Start periodic checks
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
        
        // Return defaults
        return {
            enabled: true,
            followUpEnabled: true,
            followUpDelay: 24, // 24 hours after viewing job
            dailyReminderEnabled: true,
            dailyReminderTime: "10:00", // 10 AM
            emailCheckEnabled: false, // Disabled by default until email is connected
            emailCheckInterval: 30, // 30 minutes
            inactivityReminderEnabled: true,
            inactivityDelay: 3, // 3 days
            weeklyGoalEnabled: true,
            weeklyGoal: 5, // 5 applications per week
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
        
        // Restart periodic checks with new settings
        this.startPeriodicChecks();
    }

    public getSettings(): NotificationSettings {
        return { ...this.settings };
    }

    // ============================================================
    // NOTIFICATION TYPE 1: Follow-up on viewed job
    // ============================================================
    public scheduleFollowUpNotification(jobUrl: string, jobTitle: string): void {
        if (!this.settings.enabled || !this.settings.followUpEnabled) return;

        const notificationId = `followup-${jobUrl}`;
        
        // Cancel existing notification for this job if any
        this.cancelNotification(notificationId);

        const delay = this.settings.followUpDelay * 60 * 60 * 1000; // hours to ms
        
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
                jobUrl: jobUrl,
                jobTitle: jobTitle
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
        
        const hoursStr: string = timeParts[0];
        const minutesStr: string = timeParts[1];
        
        const hours = parseInt(hoursStr, 10);
        const minutes = parseInt(minutesStr, 10);
        
        // Validate parsed values
        if (isNaN(hours) || isNaN(minutes)) {
            console.error('[NOTIFICATIONS] Invalid time values:', this.settings.dailyReminderTime);
            return;
        }
        
        const now = new Date();
        const scheduledTime = new Date();
        scheduledTime.setHours(hours, minutes, 0, 0);

        // If time has passed today, schedule for tomorrow
        if (scheduledTime <= now) {
            scheduledTime.setDate(scheduledTime.getDate() + 1);
        }

        const delay = scheduledTime.getTime() - now.getTime();
        const notificationId = 'daily-reminder';

        // Cancel existing
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
            }, {
                type: 'daily-reminder'
            });

            // Schedule tomorrow's reminder
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
        const interval = this.settings.emailCheckInterval * 60 * 1000; // minutes to ms

        // Cancel existing
        this.cancelNotification(notificationId);

        const intervalId = setInterval(async () => {
            await this.checkForEmailResponses();
        }, interval);

        // Store as timeout for consistency (even though it's an interval)
        this.scheduledNotifications.set(notificationId, intervalId as any);
        
        console.log(`[NOTIFICATIONS] Email checking scheduled every ${this.settings.emailCheckInterval} minutes`);
    }

    private async checkForEmailResponses(): Promise<void> {
        // TODO: Implement email checking logic
        // This would connect to Gmail/Outlook API
        // For now, this is a placeholder
        
        console.log('[NOTIFICATIONS] Checking for email responses...');
        
        // Example: If we detect response emails
        // const responses = await checkEmail();
        // if (responses.length > 0) {
        //     this.showNotification({
        //         title: '📧 New Response Detected!',
        //         body: `You have ${responses.length} new response${responses.length > 1 ? 's' : ''} from employers`,
        //         tag: 'email-response',
        //         urgency: 'critical'
        //     }, {
        //         type: 'email-response',
        //         count: responses.length
        //     });
        // }
    }

    // ============================================================
    // NOTIFICATION TYPE 4: Inactivity reminder
    // ============================================================
    private scheduleInactivityCheck(): void {
        if (!this.settings.enabled || !this.settings.inactivityReminderEnabled) return;

        const notificationId = 'inactivity-check';
        const checkInterval = 24 * 60 * 60 * 1000; // Check daily

        // Cancel existing
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
                    daysSinceLastApplication: daysSinceLastApplication
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
        const checkInterval = 6 * 60 * 60 * 1000; // Check every 6 hours

        // Cancel existing
        this.cancelNotification(notificationId);

        const intervalId = setInterval(() => {
            const progress = this.applicationsThisWeek;
            const goal = this.settings.weeklyGoal;
            const remaining = goal - progress;
            
            // Only notify on specific milestones
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
            const hour = now.getHours();

            // Wednesday check (midweek)
            if (dayOfWeek === 3 && hour === 18) { // Wednesday 6 PM
                if (progress < goal / 2) {
                    this.showNotification({
                        title: '📊 Midweek Check-in',
                        body: `You're at ${progress}/${goal} applications this week. Let's pick up the pace!`,
                        tag: `${notificationId}-midweek`,
                        urgency: 'normal'
                    }, {
                        type: 'weekly-goal',
                        progress: progress,
                        goal: goal
                    });
                } else {
                    this.showNotification({
                        title: '🎉 Great Progress!',
                        body: `${progress}/${goal} applications this week. You're on track!`,
                        tag: `${notificationId}-midweek`,
                        urgency: 'low'
                    }, {
                        type: 'weekly-goal',
                        progress: progress,
                        goal: goal
                    });
                }
            }

            // Friday check (end of week)
            if (dayOfWeek === 5 && hour === 18) { // Friday 6 PM
                if (progress >= goal) {
                    this.showNotification({
                        title: '🏆 Goal Achieved!',
                        body: `Awesome! You've applied to ${progress} jobs this week (goal: ${goal})!`,
                        tag: `${notificationId}-achieved`,
                        urgency: 'low'
                    }, {
                        type: 'weekly-goal',
                        progress: progress,
                        goal: goal
                    });
                } else if (remaining <= 2) {
                    this.showNotification({
                        title: '🎯 Almost There!',
                        body: `Just ${remaining} more application${remaining > 1 ? 's' : ''} to hit your weekly goal!`,
                        tag: `${notificationId}-almostthere`,
                        urgency: 'normal'
                    }, {
                        type: 'weekly-goal',
                        progress: progress,
                        goal: goal
                    });
                } else {
                    this.showNotification({
                        title: '📈 Weekend Push',
                        body: `${remaining} applications left to reach your weekly goal. You've got this!`,
                        tag: `${notificationId}-weekend`,
                        urgency: 'normal'
                    }, {
                        type: 'weekly-goal',
                        progress: progress,
                        goal: goal
                    });
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
        
        // Schedule notifications at strategic times before deadline
        const now = Date.now();
        const deadlineTime = deadline.getTime();
        const timeUntilDeadline = deadlineTime - now;

        // Cancel existing
        this.cancelNotification(notificationId);

        // 24 hours before
        if (timeUntilDeadline > 24 * 60 * 60 * 1000) {
            const delay24h = timeUntilDeadline - (24 * 60 * 60 * 1000);
            setTimeout(() => {
                this.showNotification({
                    title: '⏳ Deadline Tomorrow!',
                    body: `Application deadline for "${jobTitle}" is tomorrow`,
                    tag: `${notificationId}-24h`,
                    urgency: 'normal'
                }, {
                    type: 'deadline',
                    jobUrl: jobUrl,
                    jobTitle: jobTitle,
                    hoursRemaining: 24
                });
            }, delay24h);
        }

        // 6 hours before
        if (timeUntilDeadline > 6 * 60 * 60 * 1000) {
            const delay6h = timeUntilDeadline - (6 * 60 * 60 * 1000);
            setTimeout(() => {
                this.showNotification({
                    title: '⚠️ Deadline in 6 Hours!',
                    body: `Final reminder: "${jobTitle}" deadline is in 6 hours`,
                    tag: `${notificationId}-6h`,
                    urgency: 'critical'
                }, {
                    type: 'deadline',
                    jobUrl: jobUrl,
                    jobTitle: jobTitle,
                    hoursRemaining: 6
                });
            }, delay6h);
        }

        console.log(`[NOTIFICATIONS] Deadline reminders scheduled for "${jobTitle}"`);
    }

    // ============================================================
    // NOTIFICATION TYPE 7: Success celebration
    // ============================================================
    public showCelebration(milestone: 'first' | '5' | '10' | '25' | '50' | '100', count: number): void {
        if (!this.settings.enabled) return;

        const messages = {
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
        }, {
            type: 'celebration',
            milestone: milestone,
            count: count
        });
    }

    // ============================================================
    // Helper methods
    // ============================================================
    
    private showNotification(options: NotificationOptions, data?: NotificationData): void {
        if (!this.settings.enabled) return;

        try {
            const notification = new Notification(options);
            
            notification.on('click', () => {
                console.log('[NOTIFICATIONS] Notification clicked:', data);
                // TODO: Handle notification click based on type
                // This could open the app to a specific job, open settings, etc.
            });

            notification.show();
            
            if (this.settings.soundEnabled) {
                // Play notification sound (system default)
            }
            
            console.log(`[NOTIFICATIONS] Showed notification: ${options.title}`);
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
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Query database for applications completed today
        // Note: This requires a timestamp column in your database
        // For now, return 0 as placeholder
        // TODO: Add created_at/updated_at columns to job_apps table
        return 0;
    }

    private getApplicationsInProgressToday(): number {
        // Query database for applications started today
        // Note: This requires a timestamp column in your database
        // For now, return 0 as placeholder
        // TODO: Add created_at/updated_at columns to job_apps table
        return 0;
    }

    private getDaysSinceLastApplication(): number {
        const now = Date.now();
        const daysSince = Math.floor((now - this.lastApplicationTime) / (24 * 60 * 60 * 1000));
        return daysSince;
    }

    private resetWeeklyCounterIfNeeded(): void {
        const now = new Date();
        const dayOfWeek = now.getDay();
        
        // Reset on Monday (day 1)
        if (dayOfWeek === 1) {
            this.applicationsThisWeek = 0;
        }
    }

    // ============================================================
    // Public API
    // ============================================================
    
    public onApplicationCompleted(jobUrl: string, jobTitle: string): void {
        this.lastApplicationTime = Date.now();
        this.applicationsThisWeek++;
        
        // Cancel follow-up for this job since it's now completed
        this.cancelNotification(`followup-${jobUrl}`);
        
        // Check for milestones
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
        // Query database for total completed applications
        const result = this.db.prepare("SELECT COUNT(*) as count FROM job_apps WHERE status = 'COMPLETED'").get() as { count: number } | undefined;
        return result ? result.count : 0;
    }

    public startPeriodicChecks(): void {
        // Cancel all existing periodic checks
        this.scheduledNotifications.forEach((timeout, id) => {
            if (['daily-reminder', 'email-check', 'inactivity-check', 'weekly-goal'].includes(id)) {
                this.cancelNotification(id);
            }
        });

        // Start new periodic checks
        this.scheduleDailyReminder();
        this.scheduleEmailCheck();
        this.scheduleInactivityCheck();
        this.scheduleWeeklyGoalCheck();
        
        console.log('[NOTIFICATIONS] Periodic checks started');
    }

    public cleanup(): void {
        // Cancel all scheduled notifications
        this.scheduledNotifications.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.scheduledNotifications.clear();
        
        console.log('[NOTIFICATIONS] Cleanup complete');
    }
}

module.exports = { NotificationManager };