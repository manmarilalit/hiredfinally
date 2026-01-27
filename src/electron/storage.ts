const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

// Determine the correct database path
let dbPath;
if (app.isPackaged) {
    // Production: store in user data directory
    dbPath = path.join(app.getPath('userData'), 'job_apps.db');
} else {
    // Development: store in project directory
    dbPath = './src/electron/job_apps.db';
}

const db = new Database(dbPath);

// Create table if it doesn't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS job_apps (
        url STRING PRIMARY KEY,
        status STRING NOT NULL
    )
`);

function addInProgress(url: Text) {
    const insertData = db.prepare("INSERT or IGNORE INTO job_apps (url, status) VALUES (?, ?)");
    insertData.run(url, "IN_PROGRESS");
}

function updateCompleted(url: Text) {
    db.prepare("UPDATE job_apps SET status = 'COMPLETED' WHERE url = ?").run(url);
}

function getStatus(url: Text) {
    const result = db.prepare("SELECT status FROM job_apps WHERE url = ?").get(url);
    return result ? result.status : null;
}

module.exports = { addInProgress, getStatus, updateCompleted };