const { app, BrowserWindow } = require('electron');

const { detectApplicationStatus, gatherPageSignals } = require('./status');
const { addInProgress, updateCompleted, getStatus } = require('./storage')

app.on('ready', () => { 

    const window = new BrowserWindow({ width: 800, height: 600 }); //Figure out width and height if window size changes
    
    
    window.setMenuBarVisibility(null); // hide the default menu bar that comes with the browser window

    let lastLoggedURL = '';
    let prevURL = "";
    let prevStatus = "";  
    let currentStatus = ""
    let startingURL = ""
    let underlyingStatus = "";
    let displayStatus = "";
    let lastNotStartedURL = ""; // Track the last NOT_STARTED page
    let hasStartedApplication = false; // Track if we've already recorded the start

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
                
                const signals = await gatherPageSignals(window.webContents, currentURL, bodyText);
                
                const result = detectApplicationStatus(signals);
                underlyingStatus = result.status;
                
                // Display status logic: once we hit IN_PROGRESS, keep it until COMPLETED
                if (underlyingStatus === "COMPLETED") {
                    displayStatus = "COMPLETED";
                } else if (underlyingStatus === "IN_PROGRESS") {
                    displayStatus = "IN_PROGRESS";
                } else if (underlyingStatus === "UNKNOWN" && displayStatus === "IN_PROGRESS") {
                    displayStatus = "IN_PROGRESS";
                } else {
                    displayStatus = underlyingStatus;
                }
                
                currentStatus = displayStatus;
                
                // Track the last NOT_STARTED page
                if (underlyingStatus === "NOT_STARTED") {
                    lastNotStartedURL = currentURL;
                    hasStartedApplication = false; // Reset when we see a new job listing
                }

                // When we first hit IN_PROGRESS (underlying or display), record the application start
                if ((underlyingStatus === "IN_PROGRESS" || displayStatus === "IN_PROGRESS") && !hasStartedApplication) {
                    if (lastNotStartedURL) {
                        console.log(`[DB] Adding IN_PROGRESS: ${lastNotStartedURL}`);
                        addInProgress(lastNotStartedURL);
                        startingURL = lastNotStartedURL;
                        hasStartedApplication = true;
                    }
                }

                // Check if this URL is already marked IN_PROGRESS in the database
                if (getStatus(currentURL) == "IN_PROGRESS") {
                    startingURL = currentURL;
                }

                if (currentStatus == "COMPLETED") {
                    console.log(`[DB] Updating to COMPLETED: ${startingURL}`);
                    updateCompleted(startingURL);
                    hasStartedApplication = false; // Reset for next application
                    lastNotStartedURL = ""; // Clear the stored URL
                }

                
                prevURL = currentURL;
                prevStatus = currentStatus;

                console.log('==== PAGE LOADED ====');
                console.log('URL:', currentURL);
                console.log('Underlying Status:', underlyingStatus);
                console.log('Display Status:', displayStatus);
                console.log('Last NOT_STARTED URL:', lastNotStartedURL);
                console.log('Has Started Application:', hasStartedApplication);
                console.log('Starting URL:', startingURL);
                console.log('\n--- PAGE SIGNALS ---');
                console.log('Forms:', signals.formCount);
                console.log('Inputs:', signals.inputCount);
                console.log('File Inputs:', signals.fileInputCount);
                console.log('Selects:', signals.selectCount);
                console.log('Textareas:', signals.textareaCount);
                console.log('Required Fields:', signals.requiredFieldCount);
                console.log('Progress Indicator:', signals.hasProgressIndicator);
                console.log('Button Texts:', signals.buttonTexts);
                console.log('\n--- REASONING ---');
                console.log(result.reasoning.join('\n'));
                console.log('==================\n');

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