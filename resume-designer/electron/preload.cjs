const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electron', {
  // Save file with native dialog
  saveFile: (options) => ipcRenderer.invoke('save-file', options),
  
  // Open file with native dialog
  openFile: (options) => ipcRenderer.invoke('open-file', options),
  
  // Show message dialog
  showMessage: (options) => ipcRenderer.invoke('show-message', options),
  
  // Get app info
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  
  // Check for updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  
  // Generate PDF using native Electron printToPDF
  printToPdf: (options) => ipcRenderer.invoke('print-to-pdf', options),
  
  // Listen for update events
  onUpdateDownloading: (callback) => ipcRenderer.on('update-downloading', callback),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_, percent) => callback(percent)),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, payload) => callback(payload)),
  
  // Check if running in Electron
  isElectron: true,
  
  // Platform info
  platform: process.platform
});

// Log that preload script has loaded
console.log('Electron preload script loaded');
