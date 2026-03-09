# HiredFinally

> A browser built for job hunting. Nothing else.

HiredFinally is a dedicated job application browser - Chromium baked into a desktop app, laser-focused on getting you hired. No Twitter rabbit holes, no YouTube detours. Just you, your applications, and a tracker that does the work automatically.

---

## Download

**[Download for Windows](https://github.com/manmarilalit/hiredfinally/releases/latest/download/HiredFinally.Setup.1.0.0.exe)**

---
<!-- Add screenshots -->

## Why a whole browser?

Because job hunting in a regular browser is a mess. You open 12 tabs, forget what you applied to, get distracted, and lose track of who you need to follow up with.

HiredFinally gives you a focused space - a browser that's only for job applications. It watches what you do and handles the tracking automatically, so your only job is to actually apply.

---

## What it does

**Built-in browser** - Powered by Chromium (the same engine as Google Chrome). Browse any job board, any company careers page, anything - just without the distractions of your regular browser.

**Auto-detects applications** - Knows when you're looking at a job listing, actively filling out an application, or have just submitted one. Logs it automatically with no input from you.

**Extracts job details** - Uses AI to pull the job title and company name from the page so your tracker is actually readable.

**Reminders & accountability** - Get reminded to apply to jobs you've been sitting on, follow up on applications, and reach out to people. HiredFinally keeps you moving.

**Lives in the background** - Sits in your system tray so it's always running, always tracking. Close the window and it keeps going.

**Auto-updates** - Always up to date, silently, in the background.

---

## Built with

- **Electron** - the app shell and system tray
- **Chromium (via Electron)** - the built-in browser
- **TypeScript** - strict mode throughout
- **better-sqlite3** - fast local SQLite database (your data stays on your machine)
- **electron-updater** - automatic background updates via GitHub Releases
- **electron-builder** - Windows packaging and distribution

---

## Running locally

```bash
git clone https://github.com/manmarilalit/hiredfinally.git
cd hiredfinally
npm install
npm run build
npm start
```

---

## How updates work

When a new version is released, the app checks on launch and downloads the update in the background. You get a prompt to restart - no manual downloading, no thinking about it.

---

## Project Structure

```
src/electron/
├── index.ts          # app entry point, window management, tray
├── storage.ts        # sqlite database, all reads and writes
├── preload.ts        # bridge between browser and electron
├── home.html         # main UI
├── pipeline.html     # board view
├── settings.html     # settings page
└── status.ts         # THE MOST IMPORTANT FILE in the whole project
                      # responsible for everything that makes this app actually
                      # work!!

```

---

*Built by [Lalit Manmari](https://github.com/manmarilalit)*
