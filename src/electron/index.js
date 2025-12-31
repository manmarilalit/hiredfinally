"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { app, BrowserWindow } = require('electron');
app.on('ready', () => {
    // once electron has started up, create a window.
    const window = new BrowserWindow({ width: 800, height: 600 });
    // hide the default menu bar that comes with the browser window
    window.setMenuBarVisibility(null);
    // load a website to display
    window.loadUrl('https://www.indeed.com/');
});
//# sourceMappingURL=index.js.map