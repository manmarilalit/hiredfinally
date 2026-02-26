const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

// Determine the correct database path
let dbPath: string;
if (app.isPackaged) {
    dbPath = path.join(app.getPath('userData'), 'job_apps.db');
} else {
    dbPath = './src/electron/job_apps.db';
}

const db = new Database(dbPath);

// Create table — drop legacy table without applied_at so we get a clean schema
db.exec(`
    CREATE TABLE IF NOT EXISTS job_apps (
        url       TEXT PRIMARY KEY,
        status    TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
`);

// Migrate existing tables that are missing applied_at
try {
    db.exec(`ALTER TABLE job_apps ADD COLUMN applied_at TEXT NOT NULL DEFAULT (datetime('now'))`);
} catch (_) {
    // Column already exists — fine
}

// ── Clear all data (called from settings) ────────────────────────────────────
function clearAll(): void {
    db.prepare("DELETE FROM job_apps").run();
}

// ── Write helpers ─────────────────────────────────────────────────────────────
function addInProgress(url: string): void {
    db.prepare(`
        INSERT OR IGNORE INTO job_apps (url, status, applied_at)
        VALUES (?, 'IN_PROGRESS', datetime('now'))
    `).run(url);
}

function updateCompleted(url: string): void {
    db.prepare(`
        UPDATE job_apps SET status = 'COMPLETED', applied_at = datetime('now') WHERE url = ?
    `).run(url);
}

// ── Read helpers ──────────────────────────────────────────────────────────────
function getStatus(url: string): string | null {
    const result = db.prepare("SELECT status FROM job_apps WHERE url = ?").get(url);
    return result ? (result as any).status : null;
}

interface JobApp {
    url: string;
    status: string;
    applied_at: string;
}

function getAll(): JobApp[] {
    return db.prepare(
        "SELECT url, status, applied_at FROM job_apps ORDER BY applied_at DESC"
    ).all() as JobApp[];
}

function getByStatus(status: string): JobApp[] {
    return db.prepare(
        "SELECT url, status, applied_at FROM job_apps WHERE status = ? ORDER BY applied_at DESC"
    ).all(status) as JobApp[];
}

module.exports = { addInProgress, updateCompleted, getStatus, getAll, getByStatus, clearAll, db };