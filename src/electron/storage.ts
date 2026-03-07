//storage.ts
const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let dbPath: string;
if (app.isPackaged) {
    dbPath = path.join(app.getPath('userData'), 'job_apps.db');
} else {
    dbPath = './src/electron/job_apps.db';
}

const db = new Database(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS job_apps (
        url                 TEXT PRIMARY KEY,
        status              TEXT NOT NULL,
        applied_at          TEXT NOT NULL DEFAULT (datetime('now')),
        job_title           TEXT,
        company             TEXT,
        screenshot          BLOB,
        extraction_attempts INTEGER NOT NULL DEFAULT 0
    )
`);

for (const migration of [
    `ALTER TABLE job_apps ADD COLUMN applied_at TEXT NOT NULL DEFAULT (datetime('now'))`,
    `ALTER TABLE job_apps ADD COLUMN job_title  TEXT`,
    `ALTER TABLE job_apps ADD COLUMN company    TEXT`,
    `ALTER TABLE job_apps ADD COLUMN screenshot BLOB`,
    `ALTER TABLE job_apps ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0`,
]) {
    try { db.exec(migration); } catch (_) { /* already exists */ }
}

// ── Clear all ─────────────────────────────────────────────────────────────────
function clearAll(): void {
    db.prepare('DELETE FROM job_apps').run();
}

// ── Auto-detection writes ─────────────────────────────────────────────────────
function addInProgress(url: string, screenshot: Buffer | null = null): void {
    db.prepare(`
        INSERT OR IGNORE INTO job_apps (url, status, applied_at, screenshot, extraction_attempts)
        VALUES (?, 'IN_PROGRESS', datetime('now'), ?, 0)
    `).run(url, screenshot || null);
}

function updateCompleted(url: string): void {
    db.prepare(`
        INSERT OR IGNORE INTO job_apps (url, status, applied_at, extraction_attempts)
        VALUES (?, 'COMPLETED', datetime('now'), 0)
    `).run(url);
    db.prepare(`
        UPDATE job_apps SET status = 'COMPLETED', applied_at = datetime('now') WHERE url = ?
    `).run(url);
}

function updateMeta(url: string, jobTitle: string, company: string): void {
    db.prepare(`UPDATE job_apps SET job_title = ?, company = ? WHERE url = ?`)
      .run(jobTitle || null, company || null, url);
}

function clearScreenshot(url: string): void {
    db.prepare(`UPDATE job_apps SET screenshot = NULL WHERE url = ?`).run(url);
    console.log(`[STORAGE] Screenshot cleared for: ${url}`);
}

function incrementExtractionAttempts(url: string): void {
    db.prepare(`UPDATE job_apps SET extraction_attempts = extraction_attempts + 1 WHERE url = ?`).run(url);
}

function resetExtractionAttempts(): void {
    const r = db.prepare(`
        UPDATE job_apps SET extraction_attempts = 0
        WHERE screenshot IS NOT NULL AND job_title IS NULL
    `).run();
    if (r.changes > 0) console.log(`[STORAGE] Reset extraction_attempts for ${r.changes} row(s)`);
}

// ── Extraction queue ──────────────────────────────────────────────────────────
interface PendingRow { url: string; screenshot: Buffer; }

function getPendingExtraction(): PendingRow[] {
    return db.prepare(`
        SELECT url, screenshot FROM job_apps
        WHERE job_title IS NULL AND screenshot IS NOT NULL
        ORDER BY applied_at DESC
    `).all() as PendingRow[];
}

// ── Reads ─────────────────────────────────────────────────────────────────────
function getStatus(url: string): string | null {
    const r = db.prepare('SELECT status FROM job_apps WHERE url = ?').get(url);
    return r ? (r as any).status : null;
}

interface JobApp { url: string; status: string; applied_at: string; job_title?: string; company?: string; }

function getAll(): JobApp[] {
    return db.prepare(
        'SELECT url, status, applied_at, job_title, company FROM job_apps ORDER BY applied_at DESC'
    ).all() as JobApp[];
}

function getByStatus(status: string): JobApp[] {
    return db.prepare(
        'SELECT url, status, applied_at, job_title, company FROM job_apps WHERE status = ? ORDER BY applied_at DESC'
    ).all(status) as JobApp[];
}

// ── Manual override helpers ───────────────────────────────────────────────────

/**
 * Hard-delete a row by URL.
 * Used when the user manually reverts status to NOT_STARTED — the record
 * should never have been created so we remove it entirely.
 */
function deleteApp(url: string): { changes: number } {
    const r = db.prepare('DELETE FROM job_apps WHERE url = ?').run(url);
    console.log(`[STORAGE] deleteApp: ${r.changes} row(s) removed for ${url}`);
    return r;
}

/**
 * Insert or update a row as IN_PROGRESS with an optional screenshot.
 * Safe to call even if the URL was previously tracked in a different state —
 * it updates the existing row rather than failing on the UNIQUE constraint.
 */
function upsertInProgress(url: string, screenshot: Buffer | null = null): void {
    const inserted = db.prepare(`
        INSERT OR IGNORE INTO job_apps (url, status, applied_at, screenshot, extraction_attempts)
        VALUES (?, 'IN_PROGRESS', datetime('now'), ?, 0)
    `).run(url, screenshot || null);

    if (inserted.changes === 0) {
        // Row already exists — update it, preserving existing screenshot if
        // no new one is provided
        db.prepare(`
            UPDATE job_apps
            SET status     = 'IN_PROGRESS',
                applied_at = datetime('now'),
                screenshot = COALESCE(?, screenshot)
            WHERE url = ?
        `).run(screenshot || null, url);
    }

    const sizeStr = screenshot ? Math.round(screenshot.length / 1024) + 'KB' : 'none';
    console.log(`[STORAGE] upsertInProgress: url=${url} screenshot=${sizeStr}`);
}

/**
 * Insert or update a row as COMPLETED.
 * Used for manual "mark as completed" overrides.
 */
function upsertCompleted(url: string): void {
    const inserted = db.prepare(`
        INSERT OR IGNORE INTO job_apps (url, status, applied_at, extraction_attempts)
        VALUES (?, 'COMPLETED', datetime('now'), 0)
    `).run(url);

    if (inserted.changes === 0) {
        db.prepare(`
            UPDATE job_apps SET status = 'COMPLETED', applied_at = datetime('now') WHERE url = ?
        `).run(url);
    }

    console.log(`[STORAGE] upsertCompleted: url=${url}`);
}

module.exports = {
    // Auto-detection
    addInProgress, updateCompleted, updateMeta,
    clearScreenshot, incrementExtractionAttempts,
    getPendingExtraction, resetExtractionAttempts,
    // Reads
    getStatus, getAll, getByStatus, clearAll, db,
    // Manual override
    deleteApp, upsertInProgress, upsertCompleted,
};