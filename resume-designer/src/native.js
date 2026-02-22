/**
 * Native Platform Utilities
 * Provides a unified API for native features across web and Electron
 */

// Detect if running in Electron
export const isElectron = typeof window !== 'undefined' && window.electron?.isElectron === true;

// Get platform info
export function getPlatform() {
  if (isElectron) {
    return window.electron.platform; // 'darwin', 'win32', 'linux'
  }
  return 'web';
}

/**
 * Convert a Uint8Array to base64 string (handles large files without stack overflow)
 * @param {Uint8Array} uint8Array 
 * @returns {string}
 */
function uint8ArrayToBase64(uint8Array) {
  // Process in chunks to avoid stack overflow
  const CHUNK_SIZE = 8192;
  let binaryString = '';
  
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(i, i + CHUNK_SIZE);
    binaryString += String.fromCharCode.apply(null, chunk);
  }
  
  return btoa(binaryString);
}

/**
 * Save a file using native dialog (Electron) or browser download (web)
 * @param {Uint8Array|Blob|string} data - File data
 * @param {string} defaultName - Default filename
 * @param {Array} filters - File type filters [{name: 'PDF', extensions: ['pdf']}]
 * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
 */
export async function saveFile(data, defaultName, filters = []) {
  if (isElectron) {
    // Convert data to base64 for IPC (using chunked approach to avoid stack overflow)
    let base64Data;
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      base64Data = uint8ArrayToBase64(new Uint8Array(buffer));
    } else if (data instanceof Uint8Array) {
      base64Data = uint8ArrayToBase64(data);
    } else if (typeof data === 'string') {
      base64Data = btoa(data);
    } else {
      base64Data = data;
    }
    
    return await window.electron.saveFile({
      data: base64Data,
      defaultName,
      filters
    });
  }
  
  // Web fallback - use browser download
  try {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Open a file using native dialog (Electron) or file input (web)
 * @param {Array} filters - File type filters
 * @param {boolean} multiple - Allow multiple file selection
 * @returns {Promise<{success: boolean, files?: Array, error?: string}>}
 */
export async function openFile(filters = [], multiple = false) {
  if (isElectron) {
    return await window.electron.openFile({ filters, multiple });
  }
  
  // Web fallback - use file input
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    
    if (filters.length > 0) {
      const extensions = filters.flatMap(f => f.extensions);
      input.accept = extensions.map(ext => `.${ext}`).join(',');
    }
    
    input.onchange = async (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) {
        resolve({ success: false, canceled: true });
        return;
      }
      
      try {
        const fileData = await Promise.all(files.map(async (file) => ({
          path: file.name,
          name: file.name,
          content: await file.text()
        })));
        resolve({ success: true, files: multiple ? fileData : fileData[0] });
      } catch (error) {
        resolve({ success: false, error: error.message });
      }
    };
    
    input.oncancel = () => {
      resolve({ success: false, canceled: true });
    };
    
    input.click();
  });
}

/**
 * Show a message dialog
 * @param {Object} options - {type, title, message, buttons}
 * @returns {Promise<number>} - Index of clicked button
 */
export async function showMessage(options) {
  if (isElectron) {
    return await window.electron.showMessage(options);
  }
  
  // Web fallback - use confirm/alert
  if (options.buttons && options.buttons.length > 1) {
    return confirm(options.message) ? 0 : 1;
  }
  alert(options.message);
  return 0;
}

/**
 * Get app information
 * @returns {Promise<Object>}
 */
export async function getAppInfo() {
  if (isElectron) {
    return await window.electron.getAppInfo();
  }
  
  return {
    version: '1.0.0',
    name: 'Resume Designer',
    platform: 'web',
    isPackaged: false
  };
}

/**
 * Check for app updates (Electron only)
 * @returns {Promise<{checking: boolean, currentVersion?: string, message?: string, reason?: string, error?: string}>}
 */
export async function checkForUpdates() {
  if (isElectron && window.electron?.checkForUpdates) {
    return await window.electron.checkForUpdates();
  }

  return {
    checking: false,
    message: 'Update checks are only available in the desktop app.'
  };
}

/**
 * Listen for update progress events (Electron only)
 * @param {(percent: number) => void} callback
 */
export function onUpdateProgress(callback) {
  if (isElectron && window.electron?.onUpdateProgress) {
    window.electron.onUpdateProgress(callback);
  }
}

/**
 * Listen for update status events (Electron only)
 * @param {(payload: {status: string, message?: string, percent?: number, source?: string, version?: string}) => void} callback
 */
export function onUpdateStatus(callback) {
  if (isElectron && window.electron?.onUpdateStatus) {
    window.electron.onUpdateStatus(callback);
  }
}

/**
 * Generate PDF using native Electron printToPDF (Electron only)
 * @param {string} defaultName - Default filename for the PDF
 * @param {Object} pageSize - Optional page size {width, height} in INCHES
 * @returns {Promise<{success: boolean, filePath?: string, canceled?: boolean, error?: string}>}
 */
export async function printToPdf(defaultName, pageSize = null) {
  if (isElectron) {
    return await window.electron.printToPdf({ defaultName, pageSize });
  }
  
  // Not available in web
  return { success: false, error: 'Native PDF generation not available in browser' };
}
