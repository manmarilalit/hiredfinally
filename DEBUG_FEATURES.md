# Debug Features - Comprehensive Event Logging

## Overview
Every event in the app is now logged to easy-to-read text files. Track the complete journey from browsing to completion, including notifications, popups, status changes, screenshots, and navigation.

## Log Files

### Master Log File
- **Location**: `~/.config/hiredfinally/logs/detection-log-YYYY-MM-DDTHH-MM-SS.txt`
- **Purpose**: Contains ALL events from the entire app session
- **Format**: Human-readable text with timestamps and event types

### Session Log Files
- **Location**: `~/.config/hiredfinally/logs/session_[domain]_[timestamp].txt`
- **Purpose**: Individual log file for each job application session
- **Created**: Automatically when you start browsing a new job
- **Contains**: Complete tracking from first page view to completion

## What's Logged

### 1. Detection Events
Every page load includes:
- Timestamp
- Detected status (NOT_STARTED, IN_PROGRESS, COMPLETED) with confidence
- Current status
- Full URL
- DOM Signals (forms, inputs, buttons, overlays, etc.)
- Button texts found on page
- Body text sample (first 200 characters)
- Whether detection was applied
- Reason for applying or ignoring

### 2. Status Changes ⚡
Logged with special formatting:
- Old status → New status
- URL where change occurred
- Reason (automatic detection or manual override)

### 3. Notifications 🔔
Every notification sent:
- Notification type
- Title
- Body text
- Timestamp

### 4. Popups 🪟
When popups are intercepted:
- Popup URL
- Action (intercepted, opened, closed)
- Timestamp

### 5. Screenshots 📸
When screenshots are captured:
- URL of captured page
- Action (captured, cleared, frozen)
- Timestamp

### 6. Navigation 🧭
Every URL change:
- From URL
- To URL
- Timestamp

### 7. Manual Overrides
User-initiated status changes:
- Old status → New status
- URL
- Reason
- Special formatting with asterisks

## Example Log Output

```
================================================================================
JOB APPLICATION TRACKER - DEBUG LOG
Session started: 4/4/2026, 6:32:17 PM
================================================================================

────────────────────────────────────────────────────────────────────────────────
NEW SESSION STARTED: 4/4/2026, 6:32:45 PM
URL: https://motorolasolutions.wd5.myworkdayjobs.com/Careers/job/...
Session log: session_motorolasolutions_wd5_myworkdayjobs_com_2026-04-04T18-32-45.txt
────────────────────────────────────────────────────────────────────────────────

[4/4/2026, 6:32:45 PM] 🧭 NAVIGATION
  From: https://app.joinhandshake.com/explore
  To: https://motorolasolutions.wd5.myworkdayjobs.com/Careers/job/...

[4/4/2026, 6:32:46 PM] 📸 SCREENSHOT CAPTURED
  URL: https://motorolasolutions.wd5.myworkdayjobs.com/Careers/job/...

[4/4/2026, 6:32:46 PM] NOT_STARTED (medium)
  Current Status: NOT_STARTED
  URL: https://motorolasolutions.wd5.myworkdayjobs.com/Careers/job/...

  DOM Signals:
    Forms: 0, Inputs: 0, Required: 0
    File Inputs: 0, Selects: 0, Textareas: 0
    Apply Button: NO, Overlay: NO
    Resume Upload: NO, Completion Toast: NO
    Progress Indicator: NO, Embedded ATS: NO
    Buttons: Apply, Save Job, Share

  Applied: NO

--------------------------------------------------------------------------------

[4/4/2026, 6:33:12 PM] 🧭 NAVIGATION
  From: https://motorolasolutions.wd5.myworkdayjobs.com/Careers/job/...
  To: https://motorolasolutions.wd5.myworkdayjobs.com/.../apply/autofillWithResume

[4/4/2026, 6:33:13 PM] IN_PROGRESS (high)
  Current Status: NOT_STARTED
  URL: https://motorolasolutions.wd5.myworkdayjobs.com/.../apply/autofillWithResume

  DOM Signals:
    Forms: 0, Inputs: 0, Required: 0
    File Inputs: 0, Selects: 0, Textareas: 0
    Apply Button: NO, Overlay: NO
    Resume Upload: NO, Completion Toast: NO
    Progress Indicator: NO, Embedded ATS: YES

  Applied: YES
  Reason: High confidence detection

--------------------------------------------------------------------------------

▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
[4/4/2026, 6:33:13 PM] ⚡ STATUS CHANGE: NOT_STARTED → IN_PROGRESS
  URL: https://motorolasolutions.wd5.myworkdayjobs.com/.../apply/autofillWithResume
  Reason: Automatic detection
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

[4/4/2026, 6:33:13 PM] 🔔 NOTIFICATION SENT
  Type: general
  Title: HiredFinally
  Body: Application started: Software Engineering Intern

[4/4/2026, 6:35:42 PM] 🪟 POPUP INTERCEPTED
  URL: about:blank

[4/4/2026, 6:38:15 PM] 🧭 NAVIGATION
  From: https://motorolasolutions.wd5.myworkdayjobs.com/.../apply/step2
  To: https://motorolasolutions.wd5.myworkdayjobs.com/.../jobTasks/completed/application

[4/4/2026, 6:38:16 PM] COMPLETED (high)
  Current Status: IN_PROGRESS
  URL: https://motorolasolutions.wd5.myworkdayjobs.com/.../jobTasks/completed/application

  DOM Signals:
    Forms: 0, Inputs: 0, Required: 0
    File Inputs: 0, Selects: 0, Textareas: 0
    Apply Button: NO, Overlay: NO
    Resume Upload: NO, Completion Toast: NO
    Progress Indicator: NO, Embedded ATS: NO
    Buttons: Return to Home

  Body Text Sample:
    Application Submitted Your application has been submitted, thank you for your interest in Motorola Solutions! You have no more tasks.

  Applied: YES
  Reason: High confidence detection

--------------------------------------------------------------------------------

▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
[4/4/2026, 6:38:16 PM] ⚡ STATUS CHANGE: IN_PROGRESS → COMPLETED
  URL: https://motorolasolutions.wd5.myworkdayjobs.com/.../jobTasks/completed/application
  Reason: Automatic detection
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

[4/4/2026, 6:38:16 PM] 🔔 NOTIFICATION SENT
  Type: general
  Title: HiredFinally
  Body: Application submitted: Software Engineering Intern
```

## Manual Override Example

```
********************************************************************************
[4/4/2026, 6:40:22 PM] MANUAL OVERRIDE
  Changed: IN_PROGRESS → COMPLETED
  URL: https://example.com/job/apply
  Reason: User manual override
********************************************************************************
```

## How to Access Logs

### From the App
1. Click the status pill in the browser toolbar
2. Click "📁 Open Log Folder"
3. Your file explorer opens to the logs directory

### Direct Path
- **Windows**: `C:\Users\[YourName]\AppData\Roaming\Electron\logs\`
- **Mac**: `~/Library/Application Support/Electron/logs/`
- **Linux**: `~/.config/Electron/logs/`

## Log File Types

### Master Log
- Everything in chronological order
- Great for seeing the big picture
- Finding patterns across multiple applications
- Debugging issues that span multiple sessions

### Session Logs
- One file per job application
- Complete journey from start to finish
- Perfect for troubleshooting specific applications
- Easy to share when reporting issues

## Benefits

1. **Complete Visibility**: See every event, every decision, every action
2. **Easy to Read**: Plain text, no special tools needed
3. **Troubleshooting**: Understand exactly what happened and when
4. **Pattern Recognition**: Identify common issues across applications
5. **Shareable**: Easy to copy/paste or share specific sections
6. **Persistent**: Logs stay on disk, review anytime

## Use Cases

### Debugging "Why didn't it detect completion?"
1. Open the session log
2. Find the completion page URL
3. Check the DOM signals - were there forms/buttons?
4. Look at body text sample - did it contain completion phrases?
5. Check if it was applied and why/why not

### Understanding Notification Behavior
1. Search for "🔔 NOTIFICATION" in logs
2. See exactly when notifications were sent
3. Check what triggered them
4. Verify notification content

### Tracking Navigation Issues
1. Search for "🧭 NAVIGATION" in logs
2. See the complete navigation path
3. Identify where redirects happened
4. Understand popup behavior

### Reviewing Status Changes
1. Search for "⚡ STATUS CHANGE" in logs
2. See all status transitions
3. Understand why each change occurred
4. Verify timing of changes

## Tips

- Keep logs open in a text editor while testing
- Use Ctrl+F to search for specific events (🔔, ⚡, 🧭, etc.)
- Session logs are perfect for understanding one application
- Master log is great for finding patterns
- Emojis make it easy to scan for specific event types
- Logs are timestamped to the second for precise tracking

## Event Type Quick Reference

- 🔔 = Notification
- ⚡ = Status Change
- 🧭 = Navigation
- 📸 = Screenshot
- 🪟 = Popup
- ▓ = Major status change (with borders)
- * = Manual override (with asterisks)
- - = Detection event (with dashes)
