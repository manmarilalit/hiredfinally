const { app, BrowserWindow, webContents } = require('electron');


app.on('ready', () => { 

    const window = new BrowserWindow({ width: 800, height: 600 }); //Figure out width and height if window size changes

    window.setMenuBarVisibility(null); // hide the default menu bar that comes with the browser window

    window.loadURL('https://www.indeed.com/');

    // This does not initally load the page. It is used to handle links that would open in a new window.
    window.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
        window.loadURL(url);
        return {action: 'deny'}
    });
    // Notes: 
    // - There need to be some kind of visual loading indicator'
    // - There is no back button yet
    // -the close button does not work
});