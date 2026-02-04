/**
 * Header Bar Component
 * Contains variant selector, export menu, and branding
 */

import {
  loadFromStorage,
  getVariants,
  getCurrentVariantId,
  setCurrentVariantId,
  saveVariant,
  deleteVariant,
  renameVariant,
  initPersistence,
  importFile,
  exportAsJSON,
  exportAsMarkdown,
  generateUniqueVariantName
} from './persistence.js';
import { store, generateId, EMPTY_RESUME } from './store.js';

let currentVariantId = null;
let onVariantChangeCallback = null;

/**
 * Show a custom prompt modal (native prompt doesn't work in Electron)
 * @param {string} message - The prompt message
 * @param {string} defaultValue - Default input value
 * @returns {Promise<string|null>} - The input value or null if cancelled
 */
function showPromptModal(message, defaultValue = '') {
  return new Promise((resolve) => {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'prompt-modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width: 400px;">
        <div class="modal-header">
          <h3 class="modal-title">${message}</h3>
          <button class="modal-close" id="prompt-modal-close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-content">
          <div class="form-group">
            <input type="text" class="input" id="prompt-modal-input" value="${defaultValue.replace(/"/g, '&quot;')}" autofocus>
          </div>
          <div class="form-actions" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
            <button class="btn btn-secondary" id="prompt-modal-cancel">Cancel</button>
            <button class="btn btn-primary" id="prompt-modal-confirm">OK</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    // Show with animation
    requestAnimationFrame(() => {
      overlay.classList.add('show');
    });
    
    const input = overlay.querySelector('#prompt-modal-input');
    const closeBtn = overlay.querySelector('#prompt-modal-close');
    const cancelBtn = overlay.querySelector('#prompt-modal-cancel');
    const confirmBtn = overlay.querySelector('#prompt-modal-confirm');
    
    // Focus and select input
    setTimeout(() => {
      input.focus();
      input.select();
    }, 100);
    
    const cleanup = (result) => {
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
      }, 200);
      resolve(result);
    };
    
    // Event handlers
    closeBtn.addEventListener('click', () => cleanup(null));
    cancelBtn.addEventListener('click', () => cleanup(null));
    confirmBtn.addEventListener('click', () => {
      const value = input.value.trim();
      cleanup(value || null);
    });
    
    // Handle Enter key
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value.trim();
        cleanup(value || null);
      } else if (e.key === 'Escape') {
        cleanup(null);
      }
    });
    
    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup(null);
      }
    });
  });
}

// Initialize header bar
export function initHeaderBar(onVariantChange) {
  onVariantChangeCallback = onVariantChange;
  
  // Get current variant from storage
  currentVariantId = getCurrentVariantId();
  
  // Expose variant action handlers globally for onclick fallbacks
  window.handleNewVariant = () => {
    if (window.showOnboardingWizard) {
      window.showOnboardingWizard({ skipApiKeyStep: true });
    }
  };
  window.handleDuplicateVariant = () => duplicateVariant();
  window.handleRenameVariant = () => renameCurrentVariant();
  window.handleDeleteVariant = () => deleteCurrentVariant();
  
  // Render header UI
  renderHeaderBar();
  
  // Set up event listeners
  setupHeaderEventListeners();
  
  // Load current variant into store
  if (currentVariantId) {
    loadVariant(currentVariantId);
  }
  
  return currentVariantId;
}

// Get current variant ID
export function getCurrentId() {
  return currentVariantId;
}

// Load a variant into the store
export function loadVariant(id) {
  const variants = getVariants();
  const variant = variants[id];
  
  if (variant) {
    currentVariantId = id;
    setCurrentVariantId(id);
    store.setData(variant.data, true, id); // Skip save since we're loading, pass variantId for history
    initPersistence(id);
    
    if (onVariantChangeCallback) {
      onVariantChangeCallback(variant);
    }
    
    updateVariantSelector();
    return true;
  }
  return false;
}

// Create a new variant
export function createVariant(name, data = null) {
  const id = generateId('variant');
  const variantData = data || JSON.parse(JSON.stringify(EMPTY_RESUME));
  
  saveVariant(id, name, variantData);
  loadVariant(id);
  renderHeaderBar();
  
  return id;
}

// Duplicate current variant
export function duplicateVariant() {
  const variants = getVariants();
  const current = variants[currentVariantId];
  
  if (current) {
    const baseName = `${current.name} (Copy)`;
    const newName = generateUniqueVariantName(baseName, variants);
    const newData = JSON.parse(JSON.stringify(current.data));
    return createVariant(newName, newData);
  }
  return null;
}

// Delete current variant
export function deleteCurrentVariant() {
  const variants = getVariants();
  const variantCount = Object.keys(variants).length;
  
  if (variantCount <= 1) {
    alert('Cannot delete the last variant. Create a new one first.');
    return false;
  }
  
  const current = variants[currentVariantId];
  if (confirm(`Are you sure you want to delete "${current.name}"?`)) {
    const newCurrentId = deleteVariant(currentVariantId);
    if (newCurrentId) {
      loadVariant(newCurrentId);
    }
    renderHeaderBar();
    return true;
  }
  return false;
}

// Rename current variant
export async function renameCurrentVariant() {
  const variants = getVariants();
  const current = variants[currentVariantId];
  
  if (current) {
    const newName = await showPromptModal('Enter new name:', current.name);
    if (newName && newName.trim() !== '') {
      renameVariant(currentVariantId, newName.trim());
      renderHeaderBar();
      return true;
    }
  }
  return false;
}

// Import a variant from file
export async function importVariant(file) {
  try {
    const data = await importFile(file);
    const name = file.name.replace(/\.(json|md|markdown)$/i, '');
    createVariant(name, data);
    return true;
  } catch (err) {
    alert('Import failed: ' + err.message);
    return false;
  }
}

// Export current variant
export function exportCurrentVariant(format = 'json') {
  const variants = getVariants();
  const current = variants[currentVariantId];
  
  if (current) {
    const filename = `${current.name.replace(/[^a-z0-9]/gi, '-')}`;
    if (format === 'json') {
      exportAsJSON(current.data, `${filename}.json`);
    } else {
      exportAsMarkdown(current.data, `${filename}.md`);
    }
  }
}

// Render the header bar
export function renderHeaderBar() {
  const container = document.getElementById('header-bar');
  if (!container) return;
  
  const variants = getVariants();
  const variantList = Object.values(variants).sort((a, b) => {
    // Sort by most recently modified first
    const dateA = a.updatedAt || a.createdAt || '';
    const dateB = b.updatedAt || b.createdAt || '';
    return dateB.localeCompare(dateA);
  });
  
  const currentVariant = variants[currentVariantId];
  const currentName = currentVariant?.name || 'Select Resume';
  
  container.innerHTML = `
    <div class="header-brand">
      <h1 class="header-title">Resume Designer</h1>
    </div>
    
    <div class="header-variant">
      <div class="custom-dropdown" id="variant-dropdown">
        <button class="custom-dropdown-trigger" type="button">
          <span class="dropdown-label">${escapeHtml(currentName)}</span>
          <svg class="dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="custom-dropdown-menu">
          ${variantList.map(v => `
            <button class="custom-dropdown-option ${v.id === currentVariantId ? 'selected' : ''}" 
                    data-value="${v.id}" type="button">
              <svg class="check-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span class="variant-info">
                <span class="variant-name">${escapeHtml(v.name)}</span>
                ${v.updatedAt ? `<span class="variant-date">${formatDate(v.updatedAt)}</span>` : ''}
              </span>
            </button>
          `).join('')}
        </div>
      </div>
      
      <!-- Individual variant action buttons (visible on wide screens) -->
      <div class="header-variant-actions-expanded">
        <button class="header-action-btn" id="btn-new-variant" title="Create new resume" onclick="window.handleNewVariant && window.handleNewVariant()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <button class="header-action-btn" id="btn-duplicate-variant" title="Duplicate" onclick="window.handleDuplicateVariant && window.handleDuplicateVariant()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button class="header-action-btn" id="btn-rename-variant" title="Rename" onclick="window.handleRenameVariant && window.handleRenameVariant()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
          </svg>
        </button>
        <button class="header-action-btn danger" id="btn-delete-variant" title="Delete" onclick="window.handleDeleteVariant && window.handleDeleteVariant()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      
      <!-- Collapsed variant actions dropdown (visible on medium screens) -->
      <div class="header-variant-actions-dropdown">
        <button class="header-variant-actions-btn" id="btn-variant-actions" title="Resume Actions">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="1"/>
            <circle cx="19" cy="12" r="1"/>
            <circle cx="5" cy="12" r="1"/>
          </svg>
        </button>
        <div class="header-variant-actions-menu" id="variant-actions-menu">
          <button class="header-variant-action-option" id="btn-new-variant-menu" onclick="window.handleNewVariant && window.handleNewVariant()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Resume
          </button>
          <button class="header-variant-action-option" id="btn-duplicate-variant-menu" onclick="window.handleDuplicateVariant && window.handleDuplicateVariant()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Duplicate
          </button>
          <button class="header-variant-action-option" id="btn-rename-variant-menu" onclick="window.handleRenameVariant && window.handleRenameVariant()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
            Rename
          </button>
          <button class="header-variant-action-option danger" id="btn-delete-variant-menu" onclick="window.handleDeleteVariant && window.handleDeleteVariant()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Delete
          </button>
        </div>
      </div>
    </div>
    
    <div class="header-actions">
      <!-- Mobile Menu Button (hidden on desktop) -->
      <button class="header-mobile-menu-btn" id="btn-mobile-menu" title="Menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      
      <!-- Desktop Actions (hidden on mobile) -->
      <div class="header-desktop-actions">
        <!-- Tools Dropdown -->
        <div class="header-tools-dropdown">
          <button class="header-tools-btn" id="btn-header-tools" title="Tools">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span class="btn-text">Tools</span>
            <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div class="header-tools-menu" id="header-tools-menu">
            <button class="header-tools-option" id="btn-user-profile">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              User Profile
            </button>
            <button class="header-tools-option" id="btn-job-descriptions">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              Job Descriptions
            </button>
            <button class="header-tools-option" id="btn-history">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              Version History
            </button>
          </div>
        </div>
        
        <label class="header-import-btn" title="Import resume">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span class="btn-text">Import</span>
          <input type="file" id="header-import-file" accept=".json,.md,.markdown" hidden>
        </label>
        
        <div class="header-export-dropdown">
          <button class="header-export-btn" id="btn-header-export">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span class="btn-text">Export</span>
            <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div class="header-export-menu" id="header-export-menu">
            <button class="header-export-option" data-format="json">Export as JSON</button>
            <button class="header-export-option" data-format="md">Export as Markdown</button>
          </div>
        </div>
      </div>
      
      <div class="theme-toggle-dropdown" id="theme-toggle-dropdown">
        <button class="header-action-btn theme-toggle-btn" id="theme-toggle-btn" title="Toggle theme">
          <svg class="theme-icon theme-icon-light" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
          <svg class="theme-icon theme-icon-dark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
          <svg class="theme-icon theme-icon-system" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </button>
        <div class="theme-toggle-menu" id="theme-toggle-menu">
          <button class="theme-option" data-theme="light">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/>
              <line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
            Light
          </button>
          <button class="theme-option" data-theme="dark">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
            Dark
          </button>
          <button class="theme-option" data-theme="system">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            System
          </button>
        </div>
      </div>
      
      <button class="btn btn-primary header-pdf-btn" id="header-download-pdf">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        <span class="btn-text">PDF</span>
      </button>
    </div>
    
    <!-- Mobile Menu Drawer -->
    <div class="header-mobile-menu" id="header-mobile-menu">
      <div class="mobile-menu-section">
        <div class="mobile-menu-section-title">Resume</div>
        <button class="mobile-menu-option" id="mobile-new-variant">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Resume
        </button>
        <button class="mobile-menu-option" id="mobile-duplicate-variant">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Duplicate
        </button>
        <button class="mobile-menu-option" id="mobile-rename-variant">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
          </svg>
          Rename
        </button>
        <button class="mobile-menu-option danger" id="mobile-delete-variant">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          Delete
        </button>
      </div>
      <div class="mobile-menu-section">
        <div class="mobile-menu-section-title">Tools</div>
        <button class="mobile-menu-option" id="mobile-user-profile">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          User Profile
        </button>
        <button class="mobile-menu-option" id="mobile-job-descriptions">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          Job Descriptions
        </button>
        <button class="mobile-menu-option" id="mobile-history">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          Version History
        </button>
      </div>
      <div class="mobile-menu-section">
        <div class="mobile-menu-section-title">File</div>
        <label class="mobile-menu-option" id="mobile-import">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import
          <input type="file" id="mobile-import-file" accept=".json,.md,.markdown" hidden>
        </label>
        <button class="mobile-menu-option" id="mobile-export-json">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export as JSON
        </button>
        <button class="mobile-menu-option" id="mobile-export-md">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export as Markdown
        </button>
      </div>
    </div>
  `;
  
  // Setup variant dropdown events
  setupVariantDropdown();
}

// Setup variant dropdown events
function setupVariantDropdown() {
  const dropdown = document.getElementById('variant-dropdown');
  const trigger = dropdown?.querySelector('.custom-dropdown-trigger');
  
  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  
  // Handle option selection
  dropdown?.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-dropdown-option');
    if (option) {
      const value = option.dataset.value;
      loadVariant(value);
      dropdown.classList.remove('open');
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown?.contains(e.target)) {
      dropdown?.classList.remove('open');
    }
  });
}

// Update just the variant selector
function updateVariantSelector() {
  const dropdown = document.getElementById('variant-dropdown');
  if (!dropdown) return;
  
  const variants = getVariants();
  const currentVariant = variants[currentVariantId];
  
  // Update label
  const label = dropdown.querySelector('.dropdown-label');
  if (label && currentVariant) {
    label.textContent = currentVariant.name;
  }
  
  // Update selected state
  dropdown.querySelectorAll('.custom-dropdown-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === currentVariantId);
  });
}

// Set up event listeners
function setupHeaderEventListeners() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, select, .header-import-btn, .header-export-option');
    if (!target) return;
    
    // New variant - launch the new resume wizard (skip API key step since we're already in the app)
    if (target.id === 'btn-new-variant') {
      if (window.showOnboardingWizard) {
        window.showOnboardingWizard({ skipApiKeyStep: true });
      }
    }
    
    // Duplicate
    if (target.id === 'btn-duplicate-variant') {
      duplicateVariant();
    }
    
    // Rename
    if (target.id === 'btn-rename-variant') {
      renameCurrentVariant();
    }
    
    // Delete
    if (target.id === 'btn-delete-variant') {
      deleteCurrentVariant();
    }
    
    // Tools button
    if (target.id === 'btn-header-tools') {
      const menu = document.getElementById('header-tools-menu');
      if (menu) {
        menu.classList.toggle('show');
      }
      // Close variant actions menu
      document.getElementById('variant-actions-menu')?.classList.remove('show');
    }
    
    // Variant actions dropdown button
    if (target.id === 'btn-variant-actions') {
      const menu = document.getElementById('variant-actions-menu');
      if (menu) {
        menu.classList.toggle('show');
      }
      // Close tools menu
      document.getElementById('header-tools-menu')?.classList.remove('show');
    }
    
    // User Profile
    if (target.id === 'btn-user-profile') {
      document.getElementById('header-tools-menu')?.classList.remove('show');
      if (window.openUserProfilePanel) {
        window.openUserProfilePanel();
      }
    }
    
    // Job Descriptions
    if (target.id === 'btn-job-descriptions') {
      document.getElementById('header-tools-menu')?.classList.remove('show');
      if (window.openJobDescriptionPanel) {
        window.openJobDescriptionPanel();
      }
    }
    
    // History
    if (target.id === 'btn-history') {
      document.getElementById('header-tools-menu')?.classList.remove('show');
      if (window.openHistoryPanel) {
        window.openHistoryPanel();
      }
    }
    
    // Export button
    if (target.id === 'btn-header-export') {
      const menu = document.getElementById('header-export-menu');
      if (menu) {
        menu.classList.toggle('show');
      }
    }
    
    // Export options
    if (target.classList.contains('header-export-option')) {
      const format = target.dataset.format;
      exportCurrentVariant(format);
      document.getElementById('header-export-menu')?.classList.remove('show');
    }
    
    // Download PDF button in header
    if (target.id === 'header-download-pdf') {
      document.getElementById('download-pdf')?.click();
    }
  });
  
  // File import change
  document.addEventListener('change', (e) => {
    if (e.target.id === 'header-import-file') {
      const file = e.target.files[0];
      if (file) {
        importVariant(file);
        e.target.value = ''; // Reset for re-import
      }
    }
  });
  
  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.header-export-dropdown')) {
      document.getElementById('header-export-menu')?.classList.remove('show');
    }
    if (!e.target.closest('.header-tools-dropdown')) {
      document.getElementById('header-tools-menu')?.classList.remove('show');
    }
    if (!e.target.closest('.header-variant-actions-dropdown')) {
      document.getElementById('variant-actions-menu')?.classList.remove('show');
    }
    // Close mobile menu when clicking outside (but not on the menu button)
    if (!e.target.closest('.header-mobile-menu') && !e.target.closest('.header-mobile-menu-btn')) {
      document.getElementById('header-mobile-menu')?.classList.remove('show');
    }
    
    // Mobile menu button toggle
    if (e.target.closest('#btn-mobile-menu')) {
      e.stopPropagation();
      document.getElementById('header-mobile-menu')?.classList.toggle('show');
      return;
    }
    
    // Mobile menu options (using event delegation)
    const mobileOption = e.target.closest('.mobile-menu-option');
    if (mobileOption) {
      const closeMobileMenu = () => {
        document.getElementById('header-mobile-menu')?.classList.remove('show');
      };
      
      if (mobileOption.id === 'mobile-new-variant') {
        closeMobileMenu();
        if (window.showOnboardingWizard) {
          window.showOnboardingWizard({ skipApiKeyStep: true });
        }
      } else if (mobileOption.id === 'mobile-duplicate-variant') {
        closeMobileMenu();
        duplicateVariant();
      } else if (mobileOption.id === 'mobile-rename-variant') {
        closeMobileMenu();
        renameCurrentVariant();
      } else if (mobileOption.id === 'mobile-delete-variant') {
        closeMobileMenu();
        deleteCurrentVariant();
      } else if (mobileOption.id === 'mobile-user-profile') {
        closeMobileMenu();
        if (window.openUserProfilePanel) {
          window.openUserProfilePanel();
        }
      } else if (mobileOption.id === 'mobile-job-descriptions') {
        closeMobileMenu();
        if (window.openJobDescriptionPanel) {
          window.openJobDescriptionPanel();
        }
      } else if (mobileOption.id === 'mobile-history') {
        closeMobileMenu();
        if (window.openHistoryPanel) {
          window.openHistoryPanel();
        }
      } else if (mobileOption.id === 'mobile-export-json') {
        closeMobileMenu();
        exportCurrentVariant('json');
      } else if (mobileOption.id === 'mobile-export-md') {
        closeMobileMenu();
        exportCurrentVariant('md');
      }
    }
  });
  
  // Mobile import file change (using event delegation)
  document.addEventListener('change', (e) => {
    if (e.target.id === 'mobile-import-file') {
      const file = e.target.files[0];
      if (file) {
        document.getElementById('header-mobile-menu')?.classList.remove('show');
        importVariant(file);
        e.target.value = '';
      }
    }
  });
}

// Format a date for display (relative or absolute)
function formatDate(isoString) {
  if (!isoString) return '';
  
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    // Today - show time
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    // Show date
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}

// HTML escape utility
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
