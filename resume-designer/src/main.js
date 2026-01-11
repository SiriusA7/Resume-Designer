/**
 * Resume Designer - Main Application
 * Integrates all components: store, header bar, chat panel, inline editor, structure panel
 */

import { store } from './store.js';
import { renderResume, renderResumeStacked } from './renderer.js';
import { initPdfExport } from './pdf.js';
import { initInlineEditor, refreshInlineEditor } from './inlineEditor.js';
import { initStructurePanel, setDesignSettings } from './structurePanel.js';
import { initHeaderBar, getCurrentId, loadVariant } from './headerBar.js';
import { initChatPanel } from './chatPanel.js';
import { initZoomControls } from './zoomControls.js';
import { migrateBuiltInVariants, saveSettings, getSettings } from './persistence.js';

// Built-in resume variants (for initial migration)
const BUILT_IN_VARIANTS = [
  { id: 'book-illustrator', name: 'Book Illustrator', file: 'BookIllustrator.md' },
  { id: 'brand-campaign', name: 'Brand / Campaign', file: 'Brand-CampaignIllustrator-CharacterDesigner.md' },
  { id: 'concept-artist', name: 'Concept Artist', file: 'ConceptArtist-ArtDirection.md' },
  { id: 'coordinator', name: 'Project Coordinator', file: 'CreativeProjectCoordinator.md' },
  { id: 'viz-dev', name: 'Visual Development', file: 'VizDev-2DAnim-CharacterAndBackgroundDesign.md' }
];

// Color palette definitions
const COLOR_PALETTES = {
  terracotta: {
    accent: '#c45c3e',
    accentLight: '#d97a5d',
    headerBg: '#2d2a26',
    headerBgEnd: '#3d3832',
    sidebarBg: '#f4e8e4'
  },
  rose: {
    accent: '#e11d48',
    accentLight: '#f43f5e',
    headerBg: '#4a1025',
    headerBgEnd: '#5a2035',
    sidebarBg: '#fce7f3'
  },
  amber: {
    accent: '#d97706',
    accentLight: '#f59e0b',
    headerBg: '#451a03',
    headerBgEnd: '#78350f',
    sidebarBg: '#fef3c7'
  },
  coral: {
    accent: '#f97316',
    accentLight: '#fb923c',
    headerBg: '#431407',
    headerBgEnd: '#7c2d12',
    sidebarBg: '#ffedd5'
  },
  ocean: {
    accent: '#2563eb',
    accentLight: '#3b82f6',
    headerBg: '#1e3a5f',
    headerBgEnd: '#2d4a6f',
    sidebarBg: '#e8f0fe'
  },
  teal: {
    accent: '#0d9488',
    accentLight: '#14b8a6',
    headerBg: '#134e4a',
    headerBgEnd: '#115e59',
    sidebarBg: '#ccfbf1'
  },
  forest: {
    accent: '#059669',
    accentLight: '#10b981',
    headerBg: '#1a3c34',
    headerBgEnd: '#2a4c44',
    sidebarBg: '#e6f4f0'
  },
  cyan: {
    accent: '#0891b2',
    accentLight: '#06b6d4',
    headerBg: '#164e63',
    headerBgEnd: '#155e75',
    sidebarBg: '#cffafe'
  },
  plum: {
    accent: '#7c3aed',
    accentLight: '#8b5cf6',
    headerBg: '#2d1f47',
    headerBgEnd: '#3d2f57',
    sidebarBg: '#f3e8ff'
  },
  indigo: {
    accent: '#4f46e5',
    accentLight: '#6366f1',
    headerBg: '#1e1b4b',
    headerBgEnd: '#312e81',
    sidebarBg: '#e0e7ff'
  },
  slate: {
    accent: '#64748b',
    accentLight: '#94a3b8',
    headerBg: '#1e293b',
    headerBgEnd: '#334155',
    sidebarBg: '#f1f5f9'
  },
  zinc: {
    accent: '#52525b',
    accentLight: '#71717a',
    headerBg: '#18181b',
    headerBgEnd: '#27272a',
    sidebarBg: '#f4f4f5'
  }
};

let currentPalette = 'terracotta';
let currentLayout = 'sidebar';
let customColor = '#c45c3e';

// Initialize the application
async function init() {
  // Load saved settings
  const settings = getSettings();
  currentPalette = settings.colorPalette || 'terracotta';
  currentLayout = settings.layout || 'sidebar';
  customColor = settings.customColor || '#c45c3e';
  
  // Migrate built-in variants to storage on first run
  await migrateBuiltInVariants(BUILT_IN_VARIANTS);
  
  // Initialize header bar (includes variant management)
  initHeaderBar(handleVariantChange);
  
  // Initialize inline editor
  initInlineEditor();
  
  // Initialize structure panel with design change callback
  initStructurePanel(handleStructureChange, handleDesignChange);
  
  // Sync design settings to structure panel
  setDesignSettings(currentPalette, currentLayout, customColor);
  
  // Initialize PDF export
  initPdfExport();
  
  // Initialize chat panel
  initChatPanel(handleChatApply);
  
  // Initialize zoom controls
  initZoomControls();
  
  // Initialize undo/redo
  initUndoRedo();
  
  // Initialize settings modal
  initSettingsModal();
  
  // Subscribe to store changes for re-rendering
  store.subscribe((event, payload) => {
    if (event === 'change' || event === 'fieldUpdated') {
      renderCurrentResume();
    }
  });
  
  // Apply initial design settings
  applyColorPalette(currentPalette);
  
  // Render initial resume
  renderCurrentResume();
}

// Handle variant change from header bar
function handleVariantChange(variant) {
  renderCurrentResume();
}

// Handle structure panel changes
function handleStructureChange() {
  renderCurrentResume();
}

// Handle chat panel apply actions
function handleChatApply() {
  renderCurrentResume();
}

// Handle design changes from structure panel
function handleDesignChange(change) {
  switch (change.type) {
    case 'palette':
      currentPalette = change.value;
      customColor = change.customColor || customColor;
      applyColorPalette(change.value);
      saveSettings({ colorPalette: change.value, customColor });
      break;
      
    case 'layout':
      currentLayout = change.value;
      saveSettings({ layout: change.value });
      renderCurrentResume();
      break;
      
    case 'customColor':
      customColor = change.value;
      applyCustomPalette(change.value);
      saveSettings({ customColor: change.value });
      break;
  }
}

// Apply color palette to resume
function applyColorPalette(paletteName) {
  if (paletteName === 'custom') {
    applyCustomPalette(customColor);
    return;
  }
  
  const palette = COLOR_PALETTES[paletteName];
  if (!palette) return;
  
  applyPaletteColors(palette);
}

// Apply custom palette
function applyCustomPalette(color) {
  const palette = generatePaletteFromColor(color);
  applyPaletteColors(palette);
}

// Apply palette colors to resume element
function applyPaletteColors(palette) {
  const resume = document.getElementById('resume');
  if (!resume) return;
  
  resume.style.setProperty('--resume-accent', palette.accent);
  resume.style.setProperty('--resume-accent-light', palette.accentLight);
  resume.style.setProperty('--header-bg', palette.headerBg);
  resume.style.setProperty('--header-bg-end', palette.headerBgEnd);
  resume.style.setProperty('--sidebar-bg', palette.sidebarBg);
}

// Generate a full palette from a single accent color
function generatePaletteFromColor(hexColor) {
  const hsl = hexToHSL(hexColor);
  
  // Generate accent light (slightly lighter and more saturated)
  const accentLightHSL = {
    h: hsl.h,
    s: Math.min(hsl.s + 10, 100),
    l: Math.min(hsl.l + 15, 85)
  };
  
  // Generate header background (dark, desaturated version)
  const headerBgHSL = {
    h: hsl.h,
    s: Math.max(hsl.s - 20, 10),
    l: 15
  };
  
  // Generate header background end (slightly lighter)
  const headerBgEndHSL = {
    h: hsl.h,
    s: Math.max(hsl.s - 15, 15),
    l: 22
  };
  
  // Generate sidebar background (very light tint)
  const sidebarBgHSL = {
    h: hsl.h,
    s: Math.min(hsl.s * 0.4, 30),
    l: 95
  };
  
  return {
    accent: hexColor,
    accentLight: hslToHex(accentLightHSL),
    headerBg: hslToHex(headerBgHSL),
    headerBgEnd: hslToHex(headerBgEndHSL),
    sidebarBg: hslToHex(sidebarBgHSL)
  };
}

// Convert hex to HSL
function hexToHSL(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  return { h: h * 360, s: s * 100, l: l * 100 };
}

// Convert HSL to hex
function hslToHex({ h, s, l }) {
  s /= 100;
  l /= 100;
  
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  
  let r, g, b;
  
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  
  r = Math.round((r + m) * 255).toString(16).padStart(2, '0');
  g = Math.round((g + m) * 255).toString(16).padStart(2, '0');
  b = Math.round((b + m) * 255).toString(16).padStart(2, '0');
  
  return `#${r}${g}${b}`;
}

// Initialize undo/redo functionality
function initUndoRedo() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  
  // Update button states
  function updateButtons() {
    if (undoBtn) {
      undoBtn.disabled = !store.canUndo();
      undoBtn.classList.toggle('disabled', !store.canUndo());
    }
    if (redoBtn) {
      redoBtn.disabled = !store.canRedo();
      redoBtn.classList.toggle('disabled', !store.canRedo());
    }
  }
  
  // Subscribe to history changes
  store.subscribe((event) => {
    if (event === 'historyChanged' || event === 'dataLoaded') {
      updateButtons();
    }
  });
  
  // Button click handlers
  undoBtn?.addEventListener('click', () => {
    store.undo();
  });
  
  redoBtn?.addEventListener('click', () => {
    store.redo();
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }
    
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    
    if (modKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (modKey && e.key === 'z' && e.shiftKey) {
      // Mac style redo: Cmd+Shift+Z
      e.preventDefault();
      store.redo();
    } else if (modKey && e.key === 'y') {
      // Windows style redo: Ctrl+Y
      e.preventDefault();
      store.redo();
    }
  });
  
  // Initial state
  updateButtons();
}

// Initialize settings modal
function initSettingsModal() {
  const settingsBtn = document.getElementById('chat-settings-btn');
  const modal = document.getElementById('settings-modal');
  const closeBtn = document.getElementById('close-settings-modal');
  const saveBtn = document.getElementById('save-api-keys');
  const clearBtn = document.getElementById('clear-api-keys');
  
  if (!settingsBtn || !modal) return;
  
  // Open modal
  settingsBtn.addEventListener('click', () => {
    loadApiKeysToModal();
    modal.classList.add('show');
  });
  
  // Close modal
  closeBtn?.addEventListener('click', () => {
    modal.classList.remove('show');
  });
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
    }
  });
  
  // Save API keys
  saveBtn?.addEventListener('click', () => {
    saveApiKeysFromModal();
    modal.classList.remove('show');
  });
  
  // Clear all keys
  clearBtn?.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all API keys?')) {
      clearAllApiKeys();
      loadApiKeysToModal();
    }
  });
  
  // Toggle password visibility
  document.querySelectorAll('.api-key-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });
  });
}

// Load API keys to modal inputs
function loadApiKeysToModal() {
  const settings = getSettings();
  const anthropicInput = document.getElementById('anthropic-key');
  const openaiInput = document.getElementById('openai-key');
  const geminiInput = document.getElementById('gemini-key');
  
  if (anthropicInput) anthropicInput.value = settings.anthropicKey || '';
  if (openaiInput) openaiInput.value = settings.openaiKey || '';
  if (geminiInput) geminiInput.value = settings.geminiKey || '';
}

// Save API keys from modal inputs
function saveApiKeysFromModal() {
  const anthropicInput = document.getElementById('anthropic-key');
  const openaiInput = document.getElementById('openai-key');
  const geminiInput = document.getElementById('gemini-key');
  
  saveSettings({
    anthropicKey: anthropicInput?.value || '',
    openaiKey: openaiInput?.value || '',
    geminiKey: geminiInput?.value || ''
  });
}

// Clear all API keys
function clearAllApiKeys() {
  saveSettings({
    anthropicKey: '',
    openaiKey: '',
    geminiKey: ''
  });
}

// Render the current resume
function renderCurrentResume() {
  const container = document.getElementById('resume');
  if (!container) return;
  
  const data = store.getData();
  if (!data) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No resume loaded</p>
        <p>Select or create a variant to get started</p>
      </div>
    `;
    return;
  }
  
  // Render based on current layout
  if (currentLayout === 'stacked') {
    container.innerHTML = renderResumeStacked(data);
  } else {
    container.innerHTML = renderResume(data);
  }
  
  // Apply current palette
  applyColorPalette(currentPalette);
  
  // Refresh inline editor
  refreshInlineEditor();
}

// Start the app
init();
