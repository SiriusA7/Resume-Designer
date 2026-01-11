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
 * Save a file using native dialog (Electron) or browser download (web)
 * @param {Uint8Array|Blob|string} data - File data
 * @param {string} defaultName - Default filename
 * @param {Array} filters - File type filters [{name: 'PDF', extensions: ['pdf']}]
 * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
 */
export async function saveFile(data, defaultName, filters = []) {
  if (isElectron) {
    // Convert data to base64 for IPC
    let base64Data;
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      base64Data = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    } else if (data instanceof Uint8Array) {
      base64Data = btoa(String.fromCharCode(...data));
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
