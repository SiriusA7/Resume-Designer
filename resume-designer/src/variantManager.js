/**
 * Variant Manager
 * CRUD operations for resume variants with UI rendering
 */

import { store, generateId, EMPTY_RESUME } from './store.js';
import {
  loadFromStorage,
  saveToStorage,
  getVariants,
  getCurrentVariantId,
  setCurrentVariantId,
  saveVariant,
  deleteVariant,
  renameVariant,
  initPersistence,
  importFile,
  exportAsJSON,
  exportAsMarkdown
} from './persistence.js';

let currentVariantId = null;
let onVariantChangeCallback = null;

// Initialize variant manager
export function initVariantManager(onVariantChange) {
  onVariantChangeCallback = onVariantChange;
  
  // Get current variant from storage
  currentVariantId = getCurrentVariantId();
  
  // Render variant UI
  renderVariantUI();
  
  // Set up event listeners
  setupEventListeners();
  
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
    store.setData(variant.data, true); // Skip save since we're loading
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
  renderVariantUI();
  
  return id;
}

// Duplicate current variant
export function duplicateVariant() {
  const variants = getVariants();
  const current = variants[currentVariantId];
  
  if (current) {
    const newName = `${current.name} (Copy)`;
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
    renderVariantUI();
    return true;
  }
  return false;
}

// Rename current variant
export function renameCurrentVariant() {
  const variants = getVariants();
  const current = variants[currentVariantId];
  
  if (current) {
    const newName = prompt('Enter new name:', current.name);
    if (newName && newName.trim() !== '') {
      renameVariant(currentVariantId, newName.trim());
      renderVariantUI();
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

// Render the variant management UI
function renderVariantUI() {
  const container = document.getElementById('variant-manager');
  if (!container) return;
  
  const variants = getVariants();
  const variantList = Object.values(variants).sort((a, b) => 
    a.name.localeCompare(b.name)
  );
  
  container.innerHTML = `
    <div class="variant-selector-wrapper">
      <select id="variant-select" class="variant-select">
        ${variantList.map(v => `
          <option value="${v.id}" ${v.id === currentVariantId ? 'selected' : ''}>
            ${escapeHtml(v.name)}
          </option>
        `).join('')}
      </select>
    </div>
    
    <div class="variant-actions">
      <button class="variant-action-btn" id="btn-new-variant" title="New variant">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      <button class="variant-action-btn" id="btn-duplicate-variant" title="Duplicate">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
      <button class="variant-action-btn" id="btn-rename-variant" title="Rename">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
      </button>
      <button class="variant-action-btn danger" id="btn-delete-variant" title="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
    
    <div class="variant-io">
      <label class="import-btn" title="Import resume">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Import
        <input type="file" id="import-file" accept=".json,.md,.markdown" hidden>
      </label>
      
      <div class="export-dropdown">
        <button class="export-btn" id="btn-export">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="export-menu" id="export-menu">
          <button class="export-option" data-format="json">Export as JSON</button>
          <button class="export-option" data-format="md">Export as Markdown</button>
        </div>
      </div>
    </div>
  `;
}

// Update just the variant selector (when switching variants)
function updateVariantSelector() {
  const select = document.getElementById('variant-select');
  if (select) {
    select.value = currentVariantId;
  }
}

// Set up event listeners
function setupEventListeners() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, select, .import-btn, .export-option');
    if (!target) return;
    
    // Variant selector
    if (target.id === 'variant-select' || target.matches('#variant-select')) {
      return; // Handle in change event
    }
    
    // New variant
    if (target.id === 'btn-new-variant') {
      const name = prompt('Enter variant name:', 'New Resume');
      if (name && name.trim()) {
        createVariant(name.trim());
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
    
    // Export button
    if (target.id === 'btn-export') {
      const menu = document.getElementById('export-menu');
      if (menu) {
        menu.classList.toggle('show');
      }
    }
    
    // Export options
    if (target.classList.contains('export-option')) {
      const format = target.dataset.format;
      exportCurrentVariant(format);
      document.getElementById('export-menu')?.classList.remove('show');
    }
  });
  
  // Variant selector change
  document.addEventListener('change', (e) => {
    if (e.target.id === 'variant-select') {
      loadVariant(e.target.value);
    }
    
    // File import
    if (e.target.id === 'import-file') {
      const file = e.target.files[0];
      if (file) {
        importVariant(file);
        e.target.value = ''; // Reset for re-import
      }
    }
  });
  
  // Close export menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-dropdown')) {
      document.getElementById('export-menu')?.classList.remove('show');
    }
  });
}

// HTML escape utility
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
