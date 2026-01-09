import { parseResume } from './parser.js';
import { renderResume, renderResumeStacked } from './renderer.js';
import { initPdfExport } from './pdf.js';

// Resume file mappings
const RESUME_VARIANTS = [
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

let currentVariant = RESUME_VARIANTS[0];
let currentPalette = 'terracotta';
let currentLayout = 'sidebar';
let resumeCache = new Map();

// Initialize the application
async function init() {
  renderVariantList();
  await loadAndRenderResume(currentVariant);
  initPdfExport();
  
  // Set up event listeners
  document.getElementById('variant-list').addEventListener('click', handleVariantClick);
  document.getElementById('color-palettes').addEventListener('click', handlePaletteClick);
  document.getElementById('layout-options').addEventListener('click', handleLayoutClick);
}

// Render the variant selection list
function renderVariantList() {
  const list = document.getElementById('variant-list');
  list.innerHTML = RESUME_VARIANTS.map(variant => `
    <li>
      <button 
        class="variant-btn ${variant.id === currentVariant.id ? 'active' : ''}" 
        data-variant-id="${variant.id}"
      >
        ${variant.name}
      </button>
    </li>
  `).join('');
}

// Handle variant selection
async function handleVariantClick(e) {
  const btn = e.target.closest('.variant-btn');
  if (!btn) return;
  
  const variantId = btn.dataset.variantId;
  const variant = RESUME_VARIANTS.find(v => v.id === variantId);
  
  if (variant && variant.id !== currentVariant.id) {
    currentVariant = variant;
    
    // Update active state
    document.querySelectorAll('.variant-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    await loadAndRenderResume(variant);
  }
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
  }
}

// Handle layout selection
async function handleLayoutClick(e) {
  const btn = e.target.closest('.layout-btn');
  if (!btn) return;
  
  const layout = btn.dataset.layout;
  if (layout && layout !== currentLayout) {
    currentLayout = layout;
    
    // Update active state
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Update resume class
    const resume = document.getElementById('resume');
    resume.classList.remove('layout-sidebar', 'layout-stacked');
    resume.classList.add(`layout-${layout}`);
    
    // Re-render with new layout
    await loadAndRenderResume(currentVariant);
  }
}

// Apply color palette to resume
function applyColorPalette(paletteName) {
  const palette = COLOR_PALETTES[paletteName];
  if (!palette) return;
  
  const resume = document.getElementById('resume');
  resume.style.setProperty('--resume-accent', palette.accent);
  resume.style.setProperty('--resume-accent-light', palette.accentLight);
  resume.style.setProperty('--header-bg', palette.headerBg);
  resume.style.setProperty('--header-bg-end', palette.headerBgEnd);
  resume.style.setProperty('--sidebar-bg', palette.sidebarBg);
}

// Load and render a resume variant
async function loadAndRenderResume(variant) {
  const container = document.getElementById('resume');
  
  // Show loading state
  container.classList.add('loading');
  
  try {
    let resumeData;
    
    // Check cache first
    if (resumeCache.has(variant.id)) {
      resumeData = resumeCache.get(variant.id);
    } else {
      // Fetch and parse the markdown file
      const response = await fetch(`/resumes/${variant.file}`);
      if (!response.ok) throw new Error(`Failed to load ${variant.file}`);
      
      const markdown = await response.text();
      resumeData = parseResume(markdown);
      resumeCache.set(variant.id, resumeData);
    }
    
    // Render the resume with current layout
    if (currentLayout === 'stacked') {
      container.innerHTML = renderResumeStacked(resumeData);
    } else {
      container.innerHTML = renderResume(resumeData);
    }
    
    // Re-apply current palette
    applyColorPalette(currentPalette);
    
  } catch (error) {
    console.error('Error loading resume:', error);
    container.innerHTML = `
      <div class="error-state">
        <p>Failed to load resume variant.</p>
        <p class="error-detail">${error.message}</p>
      </div>
    `;
  } finally {
    container.classList.remove('loading');
  }
}

// Start the app
init();
