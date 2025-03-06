// main.js
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const Pushover = require('node-pushover');
const Beeminder = require('beeminder');
const DatabaseManager = require('./pomodoro-db');
const fs = require ('fs');

// Singleton instances
let mainWindow = null;
let tray = null;
let timer = null;
let dbManager = null;

// Configuration
const config = {
    pushover: {
        token: "tokenHere",
        user: "userHere"
    },
    beeminder: {
        auth_token: "authToken",
        goalName: "goalNameHere"
    },
    sendNotifs: true,
    updateGoals: true
}

async function initializeApp() {
    // Initialize database
    dbManager = new DatabaseManager();
    await dbManager.initialize();

    if (!dbManager || !dbManager.db) {
        console.error('Database failed to initialize');
        app.quit();
    }

    // Create window and setup handlers
    createWindow();
    setupTray();

    // Initialize IPC handlers afterwards
    require('./ipc-handlers')({
        startTimer,
        stopTimer,
        startBreak: () => transitionToBreak(false),
        updateDisplay,
        mainWindow
    }, dbManager)
}

let state = {
    mins: 0,
    secs: 0,
    mode: 'FOCUS',
    running: false,
    manualBreak: false
}

// Initialize APIs
const pushover = new Pushover(config.pushover);
const beeminder = new Beeminder(config.beeminder.auth_token);

function createWindow() {
    if (mainWindow) return;
  
    mainWindow = new BrowserWindow({
        width: 380,
        height: 380,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            backgroundThrottling: false
        },
        frame: false,
        resizable: true,
        hasShadow: true,
        resizable:false,
        maximizable:false,
        transparent: true,
        backgroundColor: '#00000000',
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#2d3748',
            symbolColor: '#e2e8f0',
            height: 32
        }
    })
  
    mainWindow.on('closed', () => mainWindow = null);
    mainWindow.loadFile('index.html');
}

function setupTray() {
    const iconPath = path.join(__dirname, 'icons', 'yellow.png');
    
    // Verify icon exists
    if (!fs.existsSync(iconPath)) {
        console.error('Tray icon missing at:', iconPath);
        return;
    }
  
    tray = new Tray(nativeImage.createFromPath(iconPath));
    
    // Update context menu
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Show/Hide', 
            click: () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
        },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' }
    ])
    
    tray.setContextMenu(contextMenu)
    
    // Toggle visibility
    tray.on('click', () => {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
        if (mainWindow.isMinimized()) mainWindow.restore()
    })
}

function updateDisplay() {
    mainWindow.webContents.send('update-display', {
        mode: state.mode,
        time: `${String(state.mins).padStart(2, '0')}:${String(state.secs).padStart(2, '0')}`
    })
}

function updateTrayIcon(color) {
    const iconPath = path.join(__dirname, 'icons', `${color}.png`);
    
    // Verify icon exists
    if (!fs.existsSync(iconPath)) {
        console.error('Tray icon missing at:', iconPath);
        return;
    }
    
    try {
        tray.setImage(nativeImage.createFromPath(iconPath));
        tray.setToolTip(`Pomodoro Timer - ${state.mode} mode`);
    } catch (error) {
        console.error('Error updating tray icon:', error);
    }
}

function sendNotification(message) {
    pushover.send("", message, (err, res) => {
        if (err) console.error('Pushover error:', err)
    })
}

function logBeeminder() {
    beeminder.createDatapoint(config.beeminder.goalName, {
        value: 1,
        timestamp: Math.floor(Date.now() / 1000),
        comment: '+1 from timer',
        requestid: Date.now()
    }).catch(err => console.error('Beeminder error:', err))
}

function startTimer() {
    updateTrayIcon('green');

    if (timer) clearInterval(timer);
    state.running = true;
    timer = setInterval(() => {
        state.secs++;
        if (state.secs === 60) {
            state.mins++;
            state.secs = 0;
    }

    // Check for state transitions
    if (state.mode === 'FOCUS' && state.secs >= 25) {
        transitionToBreak(true);
    } else if (state.mode === 'BREAK' && state.secs >= 5) {
        transitionToFocus();
    }

    updateDisplay();
  }, 1000)
}

async function transitionToBreak(automatic) {
    state.mode = 'BREAK';
    state.mins = 0;
    state.secs = 0;
    state.manualBreak = !automatic;
    updateTrayIcon('red');
    
    if(config.updateGoals) logBeeminder();

    
    // Reset timer if manual break
    if (!automatic) {
        if (timer) clearInterval(timer);
        startTimer();  // Restart timer for break countdown
    }

    try {        
        // Log session history
        if (automatic) {
            await dbManager.incrementDailySession();
            const todayCount = await dbManager.getTodayCount();
            mainWindow.webContents.send('update-counter', todayCount);
            console.log("Time for a break!");
            mainWindow.webContents.send('play-sound', { type: 'focusEnd' });
            if(config.sendNotifs) sendNotification('Time for a break');
        }
    } catch (err) {
        console.error('Database error:', err)
    }
}

async function transitionToFocus() {
    state.mode = 'FOCUS';
    state.mins = 0;
    state.secs = 0;
    updateTrayIcon('yellow');
    mainWindow.webContents.send('play-sound', { type: 'breakEnd' });
    
    if(config.sendNotifs) sendNotification('Back to work');
    console.log("Back to work!");
    stopTimer();
    updateDisplay();
}

function stopTimer() {
    clearInterval(timer);
    state.running = false;
    state.mins = 0;
    state.secs = 0;
    updateTrayIcon("yellow");
    updateDisplay();
}

app.on('before-quit', () => {
    app.isQuitting = true
})

process.on('uncaughtException', (error) => {
    console.error('🚨 Critical Error:', error)
    if (mainWindow) {
        mainWindow.webContents.send('fatal-error', error.toString())
    }
    // Optional: Write to error log file
    fs.writeFileSync('error.log', `${new Date().toISOString()} - ${error.stack}\n`, { flag: 'a' })
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

app.whenReady().then(initializeApp)

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (mainWindow === null) createWindow()
})