const Database = require("better-sqlite3");

const db = new Database('./src/electron/job_apps.db');

// const query = `
//     CREATE TABLE jobapps (
//         url STRING PRIMARY KEY,
//         status STRING NOT NULL
//     )
// `;

// db.exec(query);

function addInProgress(url: Text) {
    const insertData = db.prepare("INSERT or IGNORE INTO jobapps (url, status) VALUES (?, ?)");

    insertData.run(url, "IN_PROGRESS");
}

module.exports = { addInProgress };

function getStatus(url: Text) {
    const result = db.prepare("SELECT status FROM jobapps WHERE url = ?").get(url);
    return result ? result.status : null;
}

module.exports = { addInProgress, getStatus };
