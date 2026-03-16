const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  Tray,
  Menu,
} = require("electron");
const { spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const {
  detectApplicationStatus,
  isDefiniteApplicationPage,
} = require("./status");
const {
  addInProgress,
  updateCompleted,
  updateMeta,
  clearScreenshot,
  incrementExtractionAttempts,
  getPendingExtraction,
  resetExtractionAttempts,
  getAll,
  clearAll,
  deleteApp,
  upsertInProgress,
  upsertCompleted,
} = require("./storage");
const { NotificationManager } = require("./notifications");
const { NotificationStore }   = require("./notification-store"); // ← NEW
const { extractJobMeta, checkOllamaAvailable } = require("./extractor");

if (process.platform === "win32") {
  try {
    require("child_process").execSync("chcp 65001", { stdio: "ignore" });
  } catch {}
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const { recordFeatures, extractFeatures } = require('./bayes');

type Status = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "UNKNOWN";
type Confidence = "high" | "medium" | "low";

interface PendingConfirmation {
  url: string;
  newStatus: Status;
  currentStatus: Status;
  confidence: Confidence;
  urlChanged: boolean;
  wasPopup: boolean;
  signals: PageSignals;
  source: "dom";
}

interface PageSignals {
  url: string;
  bodyText: string;
  pageTitle: string;
  formCount: number;
  inputCount: number;
  fileInputCount: number;
  selectCount: number;
  textareaCount: number;
  buttonTexts: string[];
  hasProgressIndicator: boolean;
  requiredFieldCount: number;
  hasOverlay?: boolean;
  hasResumeUpload?: boolean;
  hasCompletionToast?: boolean;
  hasApplyButton?: boolean;
  hasEmbeddedATS?: boolean;
}

interface DetectionResult {
  status: string;
  confidence: Confidence;
}

interface PendingRow {
  url: string;
  screenshot: Buffer | null;
}

interface BoardRow {
  name: string;
  url: string;
}

const DEFAULT_BOARDS: BoardRow[] = [
  { name: "Indeed",       url: "https://www.indeed.com/" },
  { name: "LinkedIn",     url: "https://www.linkedin.com/jobs/" },
  { name: "Handshake",    url: "https://app.joinhandshake.com/explore" },
  { name: "Glassdoor",    url: "https://www.glassdoor.com/Job/index.htm" },
  { name: "ZipRecruiter", url: "https://www.ziprecruiter.com/" },
  { name: "Wellfound",    url: "https://wellfound.com/jobs" },
  { name: "Dice",         url: "https://www.dice.com/" },
  { name: "Lever",        url: "https://www.lever.co/" },
  { name: "Greenhouse",   url: "https://www.greenhouse.io/" },
  { name: "Built In",     url: "https://builtin.com/jobs" },
  { name: "Remote.co",    url: "https://remote.co/remote-jobs/" },
  { name: "Y Combinator", url: "https://www.ycombinator.com/jobs" },
];

let mainWindow: any           = null;
let tray: any                 = null;
let notificationManager: any  = null;
let notifStore: any           = null; // ← NEW
let db: any                   = null;

let updateDownloaded = false;

function sendNativeNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on("click", () => mainWindow?.show?.());
  n.show();
}

let runExtractionWorkerFn: () => void = () => {};

const log = require("electron-log");
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = "info";
log.info("App starting...");

autoUpdater.autoInstallOnAppQuit = true;

const MODEL = "qwen2.5vl:3b";

function spawnOllamaServe(): void {
  const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
  try {
    const child = spawn(exe, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* not installed yet */
  }
}

function ensureOllamaRunning(): void {
  spawnOllamaServe();
  setTimeout(() => checkAndPullModel(true), 800);
}

async function checkAndPullModel(allowInstall = false): Promise<void> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      mainWindow?.webContents.send("ollama-status", { status: "error" });
      return;
    }
    const data = await res.json();
    const models = (data.models || []).map((m: any) => m.name as string);
    const hasModel = models.some((m: string) => m.startsWith("qwen2.5vl"));
    if (hasModel) {
      mainWindow?.webContents.send("ollama-status", { status: "ready" });
      resetExtractionAttempts();
      runExtractionWorkerFn();
      return;
    }
    mainWindow?.webContents.send("ollama-status", { status: "pulling", model: MODEL });
    const pull = await fetch("http://localhost:11434/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: MODEL, stream: false }),
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
    if (pull.ok) {
      mainWindow?.webContents.send("ollama-status", { status: "ready" });
      resetExtractionAttempts();
      runExtractionWorkerFn();
    } else {
      mainWindow?.webContents.send("ollama-status", { status: "pull-failed" });
    }
  } catch (err: any) {
    const notRunning =
      err?.code === "ECONNREFUSED" ||
      err?.name === "AbortError" ||
      err?.message?.includes("ECONNREFUSED");
    if (notRunning && allowInstall) {
      mainWindow?.webContents.send("ollama-status", { status: "installing" });
      await installOllama();
    } else {
      mainWindow?.webContents.send("ollama-status", { status: "error" });
    }
  }
}

async function installOllama(): Promise<void> {
  try {
    if (process.platform === "win32") await installOllamaWindows();
    else if (process.platform === "darwin") await installOllamaMac();
    else await installOllamaLinux();
    await new Promise((r) => setTimeout(r, 5000));
    spawnOllamaServe();
    await new Promise((r) => setTimeout(r, 3000));
    await checkAndPullModel(false);
  } catch {
    mainWindow?.webContents.send("ollama-status", { status: "install-failed" });
  }
}

function installOllamaWindows(): Promise<void> {
  return new Promise((resolve, reject) => {
    const wg = spawn(
      "winget",
      ["install", "--id", "Ollama.Ollama", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      { stdio: "pipe", windowsHide: true, shell: true },
    );
    wg.on("close", (c: number) => c === 0 ? resolve() : installOllamaWindowsDirect().then(resolve).catch(reject));
    wg.on("error", () => installOllamaWindowsDirect().then(resolve).catch(reject));
  });
}
async function installOllamaWindowsDirect(): Promise<void> {
  const os = require("os"), tmp = path.join(os.tmpdir(), "OllamaSetup.exe");
  mainWindow?.webContents.send("ollama-status", { status: "downloading" });
  await downloadFile("https://ollama.com/download/OllamaSetup.exe", tmp);
  await new Promise<void>((resolve, reject) => {
    const i = spawn(tmp, ["/S"], { detached: true, stdio: "ignore", windowsHide: false });
    i.on("close", (c: number) => c === 0 ? resolve() : reject(new Error("code:" + c)));
    i.on("error", reject);
  });
}
function installOllamaMac(): Promise<void> {
  return new Promise((resolve, reject) => {
    const b = spawn("brew", ["install", "ollama"], { stdio: "pipe", shell: true });
    b.on("close", (c: number) => c === 0 ? resolve() : installOllamaMacDirect().then(resolve).catch(reject));
    b.on("error", () => installOllamaMacDirect().then(resolve).catch(reject));
  });
}
async function installOllamaMacDirect(): Promise<void> {
  const os = require("os"), tmp = path.join(os.tmpdir(), "Ollama.dmg");
  mainWindow?.webContents.send("ollama-status", { status: "downloading" });
  await downloadFile("https://ollama.com/download/Ollama-darwin.zip", tmp);
  spawn("open", [tmp], { detached: true, stdio: "ignore" }).unref();
  mainWindow?.webContents.send("ollama-status", { status: "manual-install-required" });
  throw new Error("Manual install required");
}
function installOllamaLinux(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sh = spawn("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { stdio: "pipe", shell: true });
    sh.on("close", (c: number) => c === 0 ? resolve() : reject(new Error("exit:" + c)));
    sh.on("error", reject);
  });
}
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const https = require("https"), fsSync = require("fs"), file = fsSync.createWriteStream(dest);
    https.get(url, (res: any) => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (e: any) => { fsSync.unlink(dest, () => {}); reject(e); });
  });
}

// -- App ready -----------------------------------------------------------------
app.on("ready", async () => {
  if (process.platform === "win32") app.setAppUserModelId(app.name);

  const iconPath = path.join(__dirname, "icon.png");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: iconPath,
    frame: false,
    show: false,
    roundedCorners: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "home.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // -- System tray -----------------------------------------------------------
  tray = new Tray(iconPath);
  tray.setToolTip("HiredFinally");

  const buildTrayMenu = () =>
    Menu.buildFromTemplate([
      {
        label: "Open HiredFinally",
        click: () => { mainWindow?.show(); mainWindow?.focus(); },
      },
      { type: "separator" },
      {
        label: updateDownloaded ? "Quit & Install Update" : "Quit",
        click: () => {
          app.isQuiting = true;
          if (updateDownloaded) autoUpdater.quitAndInstall();
          else app.quit();
        },
      },
    ]);

  tray.setContextMenu(buildTrayMenu());

  tray.on("click", () => {
    if (mainWindow?.isVisible()) mainWindow.focus();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });

  mainWindow.on("close", (e: any) => {
    if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
  });

  mainWindow.on("maximize",   () => mainWindow.webContents.send("window-maximized"));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-unmaximized"));

  app.on("activate", () => { mainWindow?.show(); mainWindow?.focus(); });

  // -- Auto updater ----------------------------------------------------------
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => { autoUpdater.checkForUpdatesAndNotify(); }, 24 * 60 * 60 * 1000);

  autoUpdater.on("update-available", () => {
    log.info("Update available, downloading...");
    sendNativeNotification("HiredFinally", "Update available! Downloading now...");
  });

  autoUpdater.on("update-downloaded", (info: any) => {
    log.info("Update downloaded:", info.version);
    updateDownloaded = true;
    tray.setContextMenu(buildTrayMenu());
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Ready",
      message: "A new version of HiredFinally has been downloaded.",
      detail: "Restart now to apply the update, or continue and it will be applied next time you quit.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    }).then(({ response }: { response: number }) => {
      if (response === 0) { app.isQuiting = true; autoUpdater.quitAndInstall(); }
    });
  });

  autoUpdater.on("error", (err: any) => { log.error("Auto updater error:", err); });

  const dbPath = app.isPackaged
    ? path.join(app.getPath("userData"), "job_apps.db")
    : "./src/electron/job_apps.db";
  db = new Database(dbPath);

  // -- Boards table ----------------------------------------------------------
  db.prepare(`
    CREATE TABLE IF NOT EXISTS boards (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT    NOT NULL,
      url      TEXT    NOT NULL,
      position INTEGER DEFAULT 0
    )
  `).run();

  const boardCount = db.prepare("SELECT COUNT(*) as c FROM boards").get() as any;
  if (boardCount.c === 0) {
    const insertBoard = db.prepare("INSERT INTO boards (name, url, position) VALUES (?, ?, ?)");
    DEFAULT_BOARDS.forEach((b, i) => insertBoard.run(b.name, b.url, i));
  }

  ipcMain.handle("get-boards", () => {
    try { return db.prepare("SELECT name, url FROM boards ORDER BY position ASC").all() as BoardRow[]; }
    catch { return []; }
  });

  ipcMain.handle("save-boards", (_e: any, boards: BoardRow[]) => {
    try {
      const del = db.prepare("DELETE FROM boards");
      const ins = db.prepare("INSERT INTO boards (name, url, position) VALUES (?, ?, ?)");
      const saveAll = db.transaction((rows: BoardRow[]) => {
        del.run();
        rows.forEach((b, i) => ins.run(b.name, b.url, i));
      });
      saveAll(boards || []);
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err?.message };
    }
  });

  // ── Notification store (in-app feed) — create BEFORE NotificationManager ──
  const notifStorePath = app.isPackaged
    ? path.join(app.getPath("userData"), "notifications-store.json")
    : "./src/electron/notifications-store.json";

  notifStore = new NotificationStore(notifStorePath, mainWindow); // ← NEW

  // ── Notification manager (OS-level alerts) — receives notifStore ──────────
  const settingsPath = app.isPackaged
    ? path.join(app.getPath("userData"), "notification-settings.json")
    : "./src/electron/notification-settings.json";

  notificationManager = new NotificationManager(db, settingsPath, notifStore); // ← pass notifStore

  ensureOllamaRunning();

  // -- Session state ---------------------------------------------------------
  let lastLoggedURL: string           = "";
  let currentStatus: Status           = "NOT_STARTED";
  let startingURL: string             = "";
  let lastNotStartedURL: string       = "";
  let hasStartedApplication: boolean  = false;
  let currentJobBoard: string         = "";
  let previousURL: string             = "";
  let pendingConfirmation: PendingConfirmation | null = null;
  let currentJobTitle: string         = "";
  let lastPageSignals: PageSignals | null = null;
  let lastResetDomain: string         = "";

  let listingScreenshot: Buffer | null  = null;
  let previousScreenshot: Buffer | null = null;
  let screenshotFrozen: boolean         = false;

  // -- Helpers ---------------------------------------------------------------
  async function waitForPageReady(webview: any): Promise<void> {
    if (webview.isLoading()) {
      await new Promise<void>((resolve) => {
        webview.once("did-finish-load", resolve);
        setTimeout(resolve, 10_000);
      });
    }
    try {
      await webview.executeJavaScript(`
        (() => {
          const NETWORK_IDLE_MS = 500;
          const CONTENT_TIMEOUT = 10000;
          return new Promise(resolve => {
            const timer = setTimeout(() => resolve(undefined), CONTENT_TIMEOUT);
            let inFlight = 0, idleTimer = null;
            function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(checkAll, NETWORK_IDLE_MS); }
            function networkIdle() { return inFlight === 0; }
            const origFetch = window.fetch;
            window.fetch = function(...args) {
              inFlight++; resetIdle();
              return origFetch.apply(this, args).finally(() => { inFlight = Math.max(0, inFlight - 1); resetIdle(); });
            };
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(...args) {
              this.addEventListener('loadend', () => { inFlight = Math.max(0, inFlight - 1); resetIdle(); });
              inFlight++; resetIdle();
              return origOpen.apply(this, args);
            };
            try {
              const po = new PerformanceObserver(() => resetIdle());
              po.observe({ type: 'resource', buffered: false });
            } catch (_) {}
            function contentVisible() {
              const selectors = ['main','article','[role="main"]','#main','#content','#job-details','.job-description','.job-details','.job-content','.content','.container','.page-content','[data-testid*="job"]','[class*="jobDetail"]'];
              for (const sel of selectors) {
                try { const el = document.querySelector(sel); if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 50) return true; } } catch (_) {}
              }
              return (document.body?.innerText?.trim().length ?? 0) > 200;
            }
            function checkAll() {
              if (document.readyState === 'complete' && networkIdle() && contentVisible()) {
                clearTimeout(timer); resolve(undefined);
              } else { setTimeout(checkAll, NETWORK_IDLE_MS); }
            }
            if (document.readyState === 'complete') { resetIdle(); }
            else { window.addEventListener('load', () => resetIdle(), { once: true }); }
          });
        })()
      `);
    } catch { /* proceed anyway */ }
  }

  async function captureCurrentPage(url: string): Promise<void> {
    try {
      const allContents = require("electron").webContents.getAllWebContents();
      const webview = allContents.find((wc: any) => wc.getType() === "webview");
      if (!webview) return;
      await waitForPageReady(webview);
      const image   = await webview.capturePage();
      const size    = image.getSize();
      const resized = image.resize({ width: Math.min(size.width, 1280) });
      previousScreenshot = listingScreenshot;
      listingScreenshot  = resized.toJPEG(70);
    } catch { /* ignore */ }
  }

  function resetStatus(clearScreenshots = true): void {
    console.log(`[RESET] status reset NOT_STARTED (clearScreenshots=${clearScreenshots}) | was: ${currentStatus}`);
    currentStatus         = "NOT_STARTED";
    hasStartedApplication = false;
    startingURL           = "";
    pendingConfirmation   = null;
    lastPageSignals       = null;
    if (clearScreenshots) {
      lastNotStartedURL  = "";
      lastLoggedURL      = "";
      previousURL        = "";
      listingScreenshot  = null;
      previousScreenshot = null;
      screenshotFrozen   = false;
    }
    updateStatusBadge("NOT_STARTED");
    mainWindow?.webContents.send("hide-confirmation-dialog");
  }

  function clearScreenshotState(): void {
    listingScreenshot  = null;
    previousScreenshot = null;
    screenshotFrozen   = false;
  }

  app.on("web-contents-created", (_e: any, contents: any) => {
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }: { url: string }) => {
        mainWindow?.webContents.send("load-in-webview", url);
        return { action: "deny" };
      });
    }
  });

  // -- IPC -------------------------------------------------------------------
  ipcMain.on("webview-data", async (_e: any, data: PageSignals) => {
    lastPageSignals = data;
    await processPageStatus(data);
  });

  ipcMain.on("reset-status", () => {
    console.log(`[RESET] manual browser close reset`);
    resetStatus(true);
  });

  ipcMain.on("status-confirmation", (_e: any, payload: any) => {
    const isCorrect      = typeof payload === "boolean" ? payload : payload.correct;
    const d              = typeof payload === "boolean" ? pendingConfirmation : (payload.data ?? pendingConfirmation);
    if (!d) return;
    const detectedStatus = (d.newStatus ?? (d as any).status) as Status;
    console.log(`[CONFIRMATION] user said ${isCorrect ? "CORRECT" : "WRONG"} for detected status: ${detectedStatus}`);
    if (isCorrect) {
      applyStatusChange(detectedStatus, d.url);
      mainWindow?.webContents.send("app-status-updated");
    } else {
      console.log(`[CONFIRMATION] user rejected detection, resetting lastLoggedURL`);
      lastLoggedURL = "";
    }
    pendingConfirmation = null;
    mainWindow?.webContents.send("hide-confirmation-dialog");
  });

  // -- Manual Status Override ------------------------------------------------
  ipcMain.on("manual-status-override", async (_e: any, payload: { newStatus: string }) => {
    const { newStatus } = payload;
    const url = lastLoggedURL || lastNotStartedURL || startingURL;
    console.log(`[MANUAL OVERRIDE] ${currentStatus} → ${newStatus} | url: ${url}`);

    if (!url) {
      mainWindow?.webContents.send("manual-override-result", { success: false, reason: "no-url" });
      return;
    }
    if (newStatus === currentStatus) {
      mainWindow?.webContents.send("manual-override-result", { success: true, newStatus: currentStatus, noChange: true });
      return;
    }

    try {
      if (newStatus === "NOT_STARTED") {
        const urlToRemove = startingURL || lastNotStartedURL || url;
        if (hasStartedApplication && urlToRemove) {
          console.log(`[MANUAL OVERRIDE] deleting app record for: ${urlToRemove}`);
          deleteApp(urlToRemove);
        }
        currentStatus         = "NOT_STARTED";
        hasStartedApplication = false;
        startingURL           = "";
        lastNotStartedURL     = url;
        lastLoggedURL         = url;
        pendingConfirmation   = null;
        listingScreenshot     = null;
        previousScreenshot    = null;
        screenshotFrozen      = false;
        updateStatusBadge("NOT_STARTED");
        mainWindow?.webContents.send("app-status-updated");
        mainWindow?.webContents.send("manual-override-result", { success: true, newStatus: "NOT_STARTED" });

      } else if (newStatus === "IN_PROGRESS") {
        const snapshotPrevious = previousScreenshot as Buffer | null;
        const snapshotListing  = listingScreenshot  as Buffer | null;
        let screenshotToUse: Buffer | null;
        if (snapshotPrevious)      screenshotToUse = snapshotPrevious;
        else if (snapshotListing)  screenshotToUse = snapshotListing;
        else {
          await captureCurrentPage(url);
          screenshotToUse = listingScreenshot as Buffer | null;
        }
        const urlToRecord = lastNotStartedURL || url;
        console.log(`[MANUAL OVERRIDE] upsertInProgress: ${urlToRecord}`);
        upsertInProgress(urlToRecord, screenshotToUse);
        startingURL           = urlToRecord;
        hasStartedApplication = true;
        currentStatus         = "IN_PROGRESS";
        screenshotFrozen      = true;
        runExtractionWorker();
        updateStatusBadge("IN_PROGRESS");
        mainWindow?.webContents.send("app-status-updated");
        mainWindow?.webContents.send("manual-override-result", { success: true, newStatus: "IN_PROGRESS" });

      } else if (newStatus === "COMPLETED") {
        const urlToComplete = startingURL || lastNotStartedURL || url;
        console.log(`[MANUAL OVERRIDE] upsertCompleted: ${urlToComplete}`);
        upsertCompleted(urlToComplete);
        if (currentJobTitle) notificationManager?.onApplicationCompleted(urlToComplete, currentJobTitle);
        hasStartedApplication = false;
        startingURL           = "";
        lastNotStartedURL     = "";
        screenshotFrozen      = false;
        pendingConfirmation   = null;
        currentStatus         = "COMPLETED";
        updateStatusBadge("COMPLETED");
        mainWindow?.webContents.send("app-status-updated");
        mainWindow?.webContents.send("manual-override-result", { success: true, newStatus: "COMPLETED" });

      } else {
        mainWindow?.webContents.send("manual-override-result", { success: false, reason: "unknown-status" });
      }
    } catch (err: any) {
      console.log(`[MANUAL OVERRIDE] error: ${err?.message || String(err)}`);
      mainWindow?.webContents.send("manual-override-result", { success: false, reason: "error", message: err?.message || String(err) });
    }
  });

  ipcMain.on("get-settings", (event: any) => {
    event.sender.send("settings-loaded", notificationManager.getSettings());
  });
  ipcMain.on("save-settings", (_e: any, s: any) => {
    notificationManager.updateSettings(s);
  });
  ipcMain.on("get-version", (event: any) => {
    try { event.returnValue = require("../../package.json").version; }
    catch { event.returnValue = app.getVersion(); }
  });
  ipcMain.on("navigate-home", () => {
    mainWindow?.loadFile(path.join(__dirname, "home.html"));
    mainWindow?.webContents.once("did-finish-load", () =>
      mainWindow?.webContents.send("navigate-home")
    );
  });
  ipcMain.on("set-theme", (_e: any, theme: string) => {
    const { webContents } = require("electron");
    webContents.getAllWebContents().forEach((wc: any) => {
      if (wc.getType() !== "webview") {
        try { wc.send("apply-theme", theme); } catch { /* ignore */ }
      }
    });
  });
  ipcMain.on("show-notification", (_e: any, { title, body }: any) =>
    sendNativeNotification(title, body)
  );
  ipcMain.on("export-application-data", () => exportApplicationData());
  ipcMain.on("clear-application-data", () => {
    clearAll();
    sendNativeNotification("HiredFinally", "All application data cleared.");
  });
  ipcMain.on("get-all-apps", (event: any) => {
    try { event.sender.send("all-apps-data", getAll()); }
    catch { event.sender.send("all-apps-data", []); }
  });
  ipcMain.on("delete-app", (_e: any, url: string) => {
    try { db.prepare("DELETE FROM job_apps WHERE url = ?").run(url); } catch { /* ignore */ }
  });
  ipcMain.on("open-url-in-home", (_e: any, url: string) => {
    mainWindow?.loadFile(path.join(__dirname, "home.html"));
    mainWindow?.webContents.once("did-finish-load", () =>
      mainWindow?.webContents.send("load-in-webview", url)
    );
  });
  ipcMain.on("open-pipeline",      () => mainWindow?.loadFile(path.join(__dirname, "pipeline.html")));
  ipcMain.on("open-settings",      () => mainWindow?.loadFile(path.join(__dirname, "settings.html")));
  ipcMain.on("open-notifications", () => mainWindow?.loadFile(path.join(__dirname, "notifications.html"))); // ← NEW
  ipcMain.on("window-close",    () => mainWindow?.close());
  ipcMain.on("window-minimize", () => mainWindow?.minimize());
  ipcMain.on("window-maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  function exportApplicationData(): void {
    const rows = db.prepare("SELECT * FROM job_apps ORDER BY rowid DESC").all() as any[];
    const csv  = [
      "URL,Status,Applied At,Completed At,Job Title,Company",
      ...rows.map((r: any) =>
        `"${r.url}",${r.status},"${r.applied_at}","${r.completed_at || ""}","${r.job_title || ""}","${r.company || ""}"`
      ),
    ].join("\n");
    if (!mainWindow) return;
    dialog.showSaveDialog(mainWindow, {
      title: "Export Application Data",
      defaultPath: path.join(app.getPath("downloads"), "job-applications.csv"),
      filters: [{ name: "CSV Files", extensions: ["csv"] }],
    }).then((result: any) => {
      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, csv);
        sendNativeNotification("HiredFinally", "Application data exported.");
      }
    }).catch(() => { /* ignore */ });
  }

  // -- URL helpers -----------------------------------------------------------
  function getJobBoardDomain(url: string): string {
    try {
      const p = new URL(url).hostname.split(".");
      return p.length >= 2 ? p.slice(-2).join(".") : (p[0] ?? "");
    } catch { return ""; }
  }

  function isJobListingUrl(url: string): boolean {
    const u = url.toLowerCase();
    return [
      "/jobs", "/job-search", "/search", "/find-jobs", "/job-listings",
      "/openings", "/opportunities", "/explore",
      "indeed.com/jobs", "indeed.com/rc/",
      "linkedin.com/jobs/search", "linkedin.com/jobs/collections",
      "glassdoor.com/job-listing", "glassdoor.com/jobs",
      "ziprecruiter.com/jobs", "monster.com/jobs", "dice.com/jobs",
      "wellfound.com/jobs", "joinhandshake.com/explore", "joinhandshake.com/job-search",
    ].some((p) => u.includes(p));
  }

  function isExcludedFromTracking(url: string): boolean {
    const u = url.toLowerCase();
    return (
      /joinhandshake\.com\/inbox/i.test(u)         ||
      /joinhandshake\.com\/notifications/i.test(u) ||
      /linkedin\.com\/messaging/i.test(u)          ||
      /linkedin\.com\/notifications/i.test(u)      ||
      /indeed\.com\/account/i.test(u)              ||
      /chrome-error:\/\//i.test(u)                 ||
      /\/login(\?|$|\/)/i.test(u)                  ||
      /\/signin(\?|$|\/)/i.test(u)                 ||
      /\/auth(\?|$|\/)/i.test(u)                   ||
      /\/sso(\?|$|\/)/i.test(u)
    );
  }

  function isJobDetailUrl(url: string): boolean {
    const u = url.toLowerCase();
    return (
      /[?&]vjk=[a-z0-9]+/i.test(u)                                    ||
      /indeed\.com\/viewjob/i.test(u)                                  ||
      /linkedin\.com\/jobs\/view\/\d+/i.test(u)                        ||
      /[?&]currentjobid=\d+/i.test(u)                                  ||
      /glassdoor\.com\/job-listing\/.*-\d+\.htm/i.test(u)              ||
      /ziprecruiter\.com\/jobs\/[^/]+\/[a-f0-9-]{8,}/i.test(u)        ||
      /joinhandshake\.com\/job-search\/\d+/i.test(u)                   ||
      /joinhandshake\.com\/jobs\/\d+/i.test(u)
    );
  }

  function canonicaliseUrl(url: string): string {
    const m = url.match(/[?&]vjk=([a-z0-9]+)/i);
    return m?.[1] ? `https://www.indeed.com/viewjob?jk=${m[1]}` : url;
  }

  function hasLeftJobBoard(newUrl: string): boolean {
    if (!currentJobBoard) return false;
    const newDomain = getJobBoardDomain(newUrl);
    const newHost   = new URL(newUrl).hostname.toLowerCase();
    if (newHost.includes(currentJobBoard) || currentJobBoard.includes(newDomain)) return false;
    return !!(newDomain && newDomain !== currentJobBoard);
  }

  function extractJobTitle(bodyText: string, url: string): string {
    for (const p of [
      /job title[:\s]+([^\n]+)/i,
      /position[:\s]+([^\n]+)/i,
      /apply for[:\s]+([^\n]+)/i,
    ]) {
      const m = bodyText.match(p);
      if (m?.[1]) {
        const t = m[1].trim();
        if (t.length > 5 && t.length < 100) return t;
      }
    }
    const handshakeMatch = url.match(/joinhandshake\.com\/(?:job-search|jobs)\/(\d+)/i);
    if (handshakeMatch) return `Handshake Job #${handshakeMatch[1]}`;
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      const last  = parts[parts.length - 1];
      if (last && !/^\d+$/.test(last)) return last.replace(/[-_]/g, " ").substring(0, 50);
    } catch {}
    return "Job Position";
  }

  // -- Apply status change ---------------------------------------------------
  async function applyStatusChange(status: Status, url: string): Promise<void> {
    console.log(`[STATUS CHANGE] ${currentStatus} → ${status} | url: ${url}`);

    if (status === "NOT_STARTED") {
      if (!screenshotFrozen) lastNotStartedURL = url;
      hasStartedApplication = false;
      currentStatus         = "NOT_STARTED";
      if (url !== lastNotStartedURL && currentJobTitle) {
        console.log(`[STATUS CHANGE] scheduling follow-up notification for: ${currentJobTitle}`);
        notificationManager.scheduleFollowUpNotification(url, currentJobTitle);
      }
    } else if (status === "IN_PROGRESS") {
      if (!hasStartedApplication) {
        const urlToRecord    = lastNotStartedURL || url;
        const screenshotUsed = previousScreenshot ?? listingScreenshot;
        console.log(`[STATUS CHANGE] addInProgress: ${urlToRecord} | hasScreenshot: ${!!screenshotUsed}`);
        addInProgress(urlToRecord, screenshotUsed);
        startingURL           = urlToRecord;
        hasStartedApplication = true;
        sendNativeNotification("HiredFinally", `Application started: ${currentJobTitle || url}`);
        runExtractionWorker();
      } else {
        console.log(`[STATUS CHANGE] already started, updating startingURL`);
        if (!startingURL) startingURL = url;
      }
      currentStatus = "IN_PROGRESS";
    } else if (status === "COMPLETED") {
      const urlToComplete = startingURL || lastNotStartedURL || url;
      if (urlToComplete) {
        console.log(`[STATUS CHANGE] updateCompleted: ${urlToComplete}`);
        updateCompleted(urlToComplete);
        if (currentJobTitle) notificationManager.onApplicationCompleted(urlToComplete, currentJobTitle);
        sendNativeNotification("HiredFinally", `Application submitted: ${currentJobTitle || urlToComplete}`);
      }
      hasStartedApplication = false;
      lastNotStartedURL     = "";
      startingURL           = "";
      screenshotFrozen      = false;
      pendingConfirmation   = null;
      currentStatus         = "COMPLETED";
    }

    updateStatusBadge(currentStatus);
  }

  // -- Background extraction worker ------------------------------------------
  let workerRunning = false;

  async function runExtractionWorker(): Promise<void> {
    runExtractionWorkerFn = runExtractionWorker;
    if (workerRunning) return;

    const pending = getPendingExtraction() as PendingRow[];
    if (pending.length === 0) return;

    workerRunning = true;
    for (const row of pending) {
      incrementExtractionAttempts(row.url);
      try {
        const meta = await extractJobMeta(row.screenshot, row.url);
        if (meta) {
          console.log(`[EXTRACTION] got meta for ${row.url} — title: "${meta.jobTitle}" company: "${meta.company}"`);
          updateMeta(row.url, meta.jobTitle, meta.company);
          clearScreenshot(row.url);
          mainWindow?.webContents.send("app-status-updated");
        } else {
          console.log(`[EXTRACTION] no meta returned for ${row.url}`);
          const still = (getPendingExtraction() as PendingRow[]).find((r: PendingRow) => r.url === row.url);
          if (!still) clearScreenshot(row.url);
        }
      } catch { /* ignore */ }
    }
    workerRunning = false;
  }

  setInterval(runExtractionWorker, 60_000);

  function updateStatusBadge(status: Status): void {
    const map: Record<Status, { label: string; cls: string }> = {
      NOT_STARTED: { label: "Not Started", cls: "not-started" },
      IN_PROGRESS: { label: "In Progress", cls: "in-progress" },
      COMPLETED:   { label: "Completed",   cls: "completed"   },
      UNKNOWN:     { label: "Unknown",     cls: "not-started" },
    };
    const { label, cls } = map[status];
    mainWindow?.webContents.send("update-status-badge", label, cls);
  }

  // -- Main processor --------------------------------------------------------
  async function processPageStatus(signals: PageSignals): Promise<void> {
    try {
      const { url, bodyText } = signals;
      if (!url || url.startsWith("file://") || url === "about:blank") return;
      if (isExcludedFromTracking(url)) {
        console.log(`[DETECT] excluded from tracking: ${url}`);
        previousURL = url;
        return;
      }

      currentJobTitle = extractJobTitle(bodyText, url);

      const isIndeedApplyFlow = previousURL.includes("indeed.com") && url.includes("indeed.com");
      const newDomainForReset = getJobBoardDomain(url);

      if (!isIndeedApplyFlow && hasLeftJobBoard(url) && newDomainForReset !== lastResetDomain) {
        console.log(`[DETECT] left job board (${currentJobBoard} → ${newDomainForReset}), resetting`);
        lastResetDomain = newDomainForReset;
        screenshotFrozen = false;
        resetStatus(false);
        previousScreenshot = null;
      }

      const urlChanged            = previousURL !== "" && previousURL !== url;
      const firstSignalAfterReset = previousURL === "" && url !== "";

      if ((urlChanged || firstSignalAfterReset) && !screenshotFrozen) {
        await captureCurrentPage(url);
        if (isJobDetailUrl(url)) {
          screenshotFrozen  = true;
          lastNotStartedURL = canonicaliseUrl(url);
          console.log(`[DETECT] job detail url detected, screenshot frozen | lastNotStartedURL: ${lastNotStartedURL}`);
        }
      } else if (urlChanged && screenshotFrozen && isJobDetailUrl(url) && currentStatus !== "IN_PROGRESS") {
        console.log(`[DETECT] new job detail url (not in progress), refreshing screenshot`);
        clearScreenshotState();
        await captureCurrentPage(url);
        screenshotFrozen  = true;
        lastNotStartedURL = canonicaliseUrl(url);
      } else if (urlChanged && screenshotFrozen && currentStatus === "IN_PROGRESS") {
        console.log(`[DETECT] url changed mid-application (IN_PROGRESS), preserving screenshots`);
      } else if (urlChanged && screenshotFrozen) {
        console.log(`[DETECT] url changed with frozen screenshot (not in progress), clearing`);
        clearScreenshotState();
      }

      if (currentStatus === "IN_PROGRESS" && urlChanged && isJobListingUrl(url)) {
        console.log(`[DETECT] navigated back to job listing while IN_PROGRESS, resetting`);
        resetStatus(true);
        clearScreenshotState();
      }

      const d = getJobBoardDomain(url);
      if (d) {
        currentJobBoard = d;
        if (d !== lastResetDomain) lastResetDomain = "";
      }

      const dom            = detectApplicationStatus(signals) as DetectionResult;
      const detectedStatus = dom.status as Status;
      const confidence     = dom.confidence;
      let effectiveStatus  = detectedStatus;

      console.log(`[DETECT] url: ${url}`);
      console.log(`  signals: forms=${signals.formCount} inputs=${signals.inputCount} required=${signals.requiredFieldCount} fileInputs=${signals.fileInputCount} selects=${signals.selectCount} textareas=${signals.textareaCount}`);
      console.log(`  flags: hasApplyBtn=${signals.hasApplyButton} hasOverlay=${signals.hasOverlay} hasResumeUpload=${signals.hasResumeUpload} hasCompletionToast=${signals.hasCompletionToast} hasProgress=${signals.hasProgressIndicator}`);
      console.log(`  buttons: [${signals.buttonTexts.slice(0, 6).join(" | ")}]`);
      console.log(`  detected: ${detectedStatus} (${confidence}) | currentStatus: ${currentStatus}`);

      if (effectiveStatus === "IN_PROGRESS" && !screenshotFrozen) {
        screenshotFrozen = true;
        console.log(`  → screenshot frozen (entering IN_PROGRESS)`);
      }

      const isCompletionSignal = effectiveStatus === "COMPLETED" && signals.hasCompletionToast === true;
      const isNewPage          = url !== lastLoggedURL;
      lastLoggedURL            = url;

      if (effectiveStatus !== "UNKNOWN" && (isNewPage || isCompletionSignal)) {
        const changed = effectiveStatus !== currentStatus;
        console.log(`  effectiveStatus: ${effectiveStatus} | changed: ${changed} | isNewPage: ${isNewPage} | isCompletionSignal: ${isCompletionSignal}`);

        if (confidence === "high" && changed) {
          console.log(`  → APPLYING change (high confidence)`);
          await applyStatusChange(effectiveStatus, url);
          mainWindow?.webContents.send("app-status-updated");
        } else if (confidence === "medium" && changed && (effectiveStatus === "IN_PROGRESS" || effectiveStatus === "COMPLETED")) {
          console.log(`  → APPLYING change (medium confidence)`);
          await applyStatusChange(effectiveStatus, url);
          mainWindow?.webContents.send("app-status-updated");
        } else {
          if (!changed) console.log(`  → no-op (status unchanged: ${currentStatus})`);
          else          console.log(`  → NOT applying (confidence=${confidence}, effectiveStatus=${effectiveStatus})`);
        }
      } else if (effectiveStatus === "UNKNOWN") {
        console.log(`  → UNKNOWN detection, ignoring`);
      }

      previousURL = url;
    } catch (err: any) {
      console.log(`[DETECT] error in processPageStatus: ${err?.message || String(err)}`);
    }
  }
});

app.on("before-quit", () => {
  app.isQuiting = true;
  notificationManager?.cleanup();
  notifStore?.cleanup(); // ← NEW
});