const { app, BrowserWindow } = require('electron');

const { detectApplicationStage } = require('./stages');
const { addInProgress } = require('./storage')

app.on('ready', () => { 

    const window = new BrowserWindow({ width: 800, height: 600 }); //Figure out width and height if window size changes
    
    
    window.setMenuBarVisibility(null); // hide the default menu bar that comes with the browser window

    let lastLoggedURL = '';
    let prevURL = "";
    let prevStage = "";  

    window.loadURL('https://www.indeed.com/');


    window.webContents.on('did-start-navigation', async () => {
        setTimeout(async () => {
            try {
                const currentURL = window.webContents.getURL();

                if (currentURL === lastLoggedURL) {
                    return; // Skip logging if the URL hasn't changed
                }   

                lastLoggedURL = currentURL;

                const bodyText = await window.webContents.executeJavaScript(`
                    document.body.innerText
                `); 
                // Array.from(...) converts and array like object [query selcetor return a NodeList(an array like object)] into a real array. We need this because NodeList's don't have map().
                // map() transforms each element
                
                const stage = detectApplicationStage(currentURL, bodyText);
                

                // 2 var, currentURL, stage
                if (prevStage == "NOT_STARTED" && stage == "IN_PROGRESS")
                {
                    addInProgress(prevURL);
                }
                
                prevURL = currentURL;
                prevStage = stage;

                console.log('==== PAGE LOADED ====');
                console.log('URL:', currentURL);
                console.log('Detected Stage', stage);
                console.log('==================');

            } catch (error) {
                console.error('Error retrieving page content:', error);
            }
        }, 2000); // wait 3 seconds after navigation starts to give the ;page time to load ; might replace with mutation observer later
    });

    

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

