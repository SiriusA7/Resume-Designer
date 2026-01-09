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
  ocean: {
    accent: '#2563eb',
    accentLight: '#3b82f6',
    headerBg: '#1e3a5f',
    headerBgEnd: '#2d4a6f',
    sidebarBg: '#e8f0fe'
  },
  forest: {
    accent: '#059669',
    accentLight: '#10b981',
    headerBg: '#1a3c34',
    headerBgEnd: '#2a4c44',
    sidebarBg: '#e6f4f0'
  },
  plum: {
    accent: '#7c3aed',
    accentLight: '#8b5cf6',
    headerBg: '#2d1f47',
    headerBgEnd: '#3d2f57',
    sidebarBg: '#f3e8ff'
  },
  slate: {
    accent: '#64748b',
    accentLight: '#94a3b8',
    headerBg: '#1e293b',
    headerBgEnd: '#334155',
    sidebarBg: '#f1f5f9'
  },
  rose: {
    accent: '#e11d48',
    accentLight: '#f43f5e',
    headerBg: '#4a1025',
    headerBgEnd: '#5a2035',
    sidebarBg: '#fce7f3'
  }
};

let currentPalette = 'terracotta';
let currentLayout = 'sidebar';

// Initialize the application
async function init() {
  // Load saved settings
  const settings = getSettings();
  currentPalette = settings.colorPalette || 'terracotta';
  currentLayout = settings.layout || 'sidebar';
  
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
  if (!btn) return;
  
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
  const palette = COLOR_PALETTES[paletteName];
  if (!palette) return;
  
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
