const Database = require("better-sqlite3");

const db = new Database('./src/electron/job_apps.db');

// const query = `
//     CREATE TABLE job_apps (
//         url STRING PRIMARY KEY,
//         status STRING NOT NULL
//     )
// `;

// db.exec(query);

function addInProgress(url: Text) {
    const insertData = db.prepare("INSERT or IGNORE INTO job_apps (url, status) VALUES (?, ?)");

    insertData.run(url, "IN_PROGRESS");
}

function updateCompleted(url: Text) {
    db.prepare("UPDATE job_apps SET status = 'COMPLETED' WHERE url = ?").get(url);
}

function getStatus(url: Text) {
    const result = db.prepare("SELECT status FROM job_apps WHERE url = ?").get(url);
    return result ? result.status : null;
}

module.exports = { addInProgress, getStatus, updateCompleted };
