const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// Keep a global reference of the window object
let mainWindow = null;

// Determine if we're in development or production
const isDev = !app.isPackaged;

// Set up Content Security Policy
function setupCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          "script-src 'self' 'unsafe-inline';" +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com data:;" +
          "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com data:;" +
          "img-src 'self' data: blob:;" +
          "font-src 'self' data: https://fonts.gstatic.com;" +
          "connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com;" +
          "worker-src 'self' blob:;"
        ]
      }
    });
  });
}

// ============================================
// Auto-Updater Configuration
// ============================================

// Configure logging for auto-updater
autoUpdater.logger = require('electron').app.isPackaged ? null : console;

// Don't auto-download, let user decide
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  // Only check for updates in production
  if (isDev) {
    console.log('Skipping auto-update check in development mode');
    return;
  }

  // Check for updates after app is ready
  autoUpdater.checkForUpdates().catch(err => {
    console.log('Auto-update check failed:', err.message);
  });

  // Update available
  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available. Would you like to download it now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
        // Notify renderer about download start
        mainWindow?.webContents.send('update-downloading');
      }
    });
  });

  // Update not available
  autoUpdater.on('update-not-available', () => {
    console.log('App is up to date');
  });

  // Download progress
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', progress.percent);
  });

  // Update downloaded
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded. Restart the app to apply the update.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  // Error handling
  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err.message);
  });
}

// Check if Vite dev server is running
async function isDevServerRunning() {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get('http://localhost:5173', (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

async function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Resume Designer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    // Nice macOS-style window
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#f8f6f3'
  });

  // Load the app
  const devServerRunning = isDev && await isDevServerRunning();
  
  if (devServerRunning) {
    // In development with Vite running, load from dev server
    mainWindow.loadURL('http://localhost:5173');
    // Open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    // In production or dev without server, load the built files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    if (isDev) {
      // Still open DevTools in dev mode even with built files
      mainWindow.webContents.openDevTools();
    }
  }

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Create window when app is ready
app.whenReady().then(() => {
  // Set up Content Security Policy
  setupCSP();
  
  createWindow();

  // Set up auto-updater (only in production)
  setupAutoUpdater();

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================
// IPC Handlers for Native Features
// ============================================

// Show save dialog and save file
ipcMain.handle('save-file', async (event, { data, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  try {
    // Handle both Buffer and base64 data
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    fs.writeFileSync(result.filePath, buffer);
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Show open dialog and read file
ipcMain.handle('open-file', async (event, { filters, multiple = false }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  try {
    const files = result.filePaths.map(filePath => ({
      path: filePath,
      name: path.basename(filePath),
      content: fs.readFileSync(filePath, 'utf-8')
    }));
    return { success: true, files: multiple ? files : files[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Show message box
ipcMain.handle('show-message', async (event, { type, title, message, buttons }) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: type || 'info',
    title: title || 'Resume Designer',
    message: message,
    buttons: buttons || ['OK']
  });
  return result.response;
});

// Get app info
ipcMain.handle('get-app-info', () => {
  return {
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    isPackaged: app.isPackaged
  };
});

// Check for updates manually
ipcMain.handle('check-for-updates', async () => {
  if (isDev) {
    return { checking: false, message: 'Updates disabled in development' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { checking: true, currentVersion: app.getVersion() };
  } catch (error) {
    return { checking: false, error: error.message };
  }
});
