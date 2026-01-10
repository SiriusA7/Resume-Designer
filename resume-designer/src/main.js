/**
 * Resume Designer - Main Application
 * Integrates all components: store, variant manager, inline editor, structure panel
 */

import { store } from './store.js';
import { renderResume, renderResumeStacked } from './renderer.js';
import { initPdfExport } from './pdf.js';
import { initInlineEditor, refreshInlineEditor } from './inlineEditor.js';
import { initStructurePanel } from './structurePanel.js';
import { 
  initVariantManager, 
  getCurrentId,
  loadVariant 
} from './variantManager.js';
import { 
  migrateBuiltInVariants, 
  loadFromStorage, 
  saveSettings, 
  getSettings 
} from './persistence.js';

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
  
  // Initialize variant manager
  initVariantManager(handleVariantChange);
  
  // Initialize inline editor
  initInlineEditor();
  
  // Initialize structure panel
  initStructurePanel(handleStructureChange);
  
  // Initialize PDF export
  initPdfExport();
  
  // Subscribe to store changes for re-rendering
  store.subscribe((event, payload) => {
    if (event === 'change' || event === 'fieldUpdated') {
      renderCurrentResume();
    }
  });
  
  // Set up UI event listeners
  setupUIListeners();
  
  // Apply saved settings to UI
  applySettingsToUI();
  
  // Render initial resume
  renderCurrentResume();
}

// Set up UI event listeners
function setupUIListeners() {
  // Color palette selection
  document.getElementById('color-palettes')?.addEventListener('click', handlePaletteClick);
  
  // Custom palette button
  document.getElementById('custom-palette-btn')?.addEventListener('click', handleCustomPaletteClick);
  
  // Custom color picker
  const customColorInput = document.getElementById('custom-color-input');
  if (customColorInput) {
    customColorInput.value = customColor;
    customColorInput.addEventListener('input', handleCustomColorChange);
    updateCustomPalettePreview(customColor);
  }
  
  // Layout selection
  document.getElementById('layout-options')?.addEventListener('click', handleLayoutClick);
}

// Apply saved settings to UI elements
function applySettingsToUI() {
  // Set active palette button
  document.querySelectorAll('.palette-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.palette === currentPalette);
  });
  
  // Set active layout button
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === currentLayout);
  });
  
  // Update custom color picker
  const customColorInput = document.getElementById('custom-color-input');
  if (customColorInput) {
    customColorInput.value = customColor;
    updateCustomPalettePreview(customColor);
  }
  
  // Apply palette to resume
  applyColorPalette(currentPalette);
}

// Handle variant change from variant manager
function handleVariantChange(variant) {
  renderCurrentResume();
}

// Handle structure panel changes
function handleStructureChange() {
  renderCurrentResume();
}

// Handle color palette selection
function handlePaletteClick(e) {
  const btn = e.target.closest('.palette-btn');
  if (!btn || btn.dataset.palette === 'custom') return;
  
  const palette = btn.dataset.palette;
  if (palette && palette !== currentPalette) {
    currentPalette = palette;
    
    // Update active state
    document.querySelectorAll('.palette-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Apply palette
    applyColorPalette(palette);
    
    // Save setting
    saveSettings({ colorPalette: palette });
  }
}

// Handle custom palette button click
function handleCustomPaletteClick(e) {
  const btn = e.currentTarget;
  if (currentPalette !== 'custom') {
    currentPalette = 'custom';
    
    // Update active state
    document.querySelectorAll('.palette-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Apply custom palette
    applyCustomPalette(customColor);
    
    // Save setting
    saveSettings({ colorPalette: 'custom', customColor });
  }
}

// Handle custom color change
function handleCustomColorChange(e) {
  customColor = e.target.value;
  updateCustomPalettePreview(customColor);
  
  // If custom palette is active, apply it immediately
  if (currentPalette === 'custom') {
    applyCustomPalette(customColor);
    saveSettings({ customColor });
  }
}

// Update custom palette preview
function updateCustomPalettePreview(color) {
  const preview = document.getElementById('custom-palette-preview');
  const swatch = document.getElementById('custom-color-swatch');
  
  if (preview) {
    const palette = generatePaletteFromColor(color);
    preview.style.setProperty('--p1', palette.accent);
    preview.style.setProperty('--p2', palette.headerBg);
    preview.style.setProperty('--p3', palette.sidebarBg);
  }
  
  if (swatch) {
    swatch.style.backgroundColor = color;
  }
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

// Handle layout selection
function handleLayoutClick(e) {
  const btn = e.target.closest('.layout-btn');
  if (!btn) return;
  
  const layout = btn.dataset.layout;
  if (layout && layout !== currentLayout) {
    currentLayout = layout;
    
    // Update active state
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Save setting
    saveSettings({ layout });
    
    // Re-render with new layout
    renderCurrentResume();
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
