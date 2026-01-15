/**
 * Structure Panel
 * Side panel for editing resume structure with tabbed interface
 */

import { store, generateId } from './store.js';
import { 
  FONT_PAIRINGS, 
  POPULAR_GOOGLE_FONTS, 
  SYSTEM_FONT_STACKS,
  loadFontPairing,
  loadGoogleFont,
  applyFontSettings,
  getCurrentFontSettings,
  saveFontSettings,
  searchGoogleFonts,
  getSystemFonts
} from './fontService.js';
import {
  GRADIENT_STYLES,
  PATTERN_STYLES,
  TEXTURE_STYLES,
  getHeaderStyleSettings,
  saveHeaderStyleSettings,
  applyHeaderStyle,
  getStylePreview
} from './headerStyleService.js';
import {
  getSpacingSettings,
  saveSpacingSettings,
  applySpacingSettings,
  resetSpacingSettings,
  DEFAULT_SPACING
} from './spacingService.js';
import {
  UNDERLINE_STYLES,
  BULLET_STYLES,
  BORDER_RADIUS_PRESETS,
  getAccentSettings,
  saveAccentSettings,
  applyAccentSettings,
  resetAccentSettings,
  DEFAULT_ACCENT
} from './accentService.js';
import {
  PHOTO_PLACEMENTS,
  PHOTO_SHAPES,
  PHOTO_SIZES,
  getPhotoSettings,
  savePhotoSettings,
  applyPhotoSettings,
  removePhoto
} from './photoService.js';

let isPanelOpen = false;
let onChangeCallback = null;
let onDesignChangeCallback = null;
let currentTab = 'header'; // 'header', 'sidebar', 'main', 'design'
let draggedItem = null;

// Current design settings (will be synced from main.js)
let currentPalette = 'terracotta';
let currentLayout = 'sidebar';
let customColor = '#c45c3e';

// Font settings
let currentFontSettings = getCurrentFontSettings();
let fontSubTab = 'presets'; // 'presets', 'google', 'system'
let googleFontSearch = '';
let googleFontCategory = null;
let systemFontsList = null;

// Header style settings
let currentHeaderStyle = getHeaderStyleSettings();
let headerStyleTab = 'gradients'; // 'gradients', 'patterns', 'textures', 'image'

// Spacing settings
let currentSpacing = getSpacingSettings();

// Accent settings
let currentAccent = getAccentSettings();

// Photo settings
let currentPhoto = getPhotoSettings();

// Section collapse state - tracks which sections are collapsed
// Key format: "tabName-sectionId" e.g., "design-color-theme", "header-name-title"
let collapsedSections = {};

// Color palette definitions
const COLOR_PALETTES = {
  terracotta: { p1: '#c45c3e', p2: '#2d2a26', p3: '#f4e8e4' },
  rose: { p1: '#e11d48', p2: '#4a1025', p3: '#fce7f3' },
  amber: { p1: '#d97706', p2: '#451a03', p3: '#fef3c7' },
  coral: { p1: '#f97316', p2: '#431407', p3: '#ffedd5' },
  ocean: { p1: '#2563eb', p2: '#1e3a5f', p3: '#e8f0fe' },
  teal: { p1: '#0d9488', p2: '#134e4a', p3: '#ccfbf1' },
  forest: { p1: '#059669', p2: '#1a3c34', p3: '#e6f4f0' },
  cyan: { p1: '#0891b2', p2: '#164e63', p3: '#cffafe' },
  plum: { p1: '#7c3aed', p2: '#2d1f47', p3: '#f3e8ff' },
  indigo: { p1: '#4f46e5', p2: '#1e1b4b', p3: '#e0e7ff' },
  slate: { p1: '#64748b', p2: '#1e293b', p3: '#f1f5f9' },
  zinc: { p1: '#52525b', p2: '#18181b', p3: '#f4f4f5' }
};

// Section type templates
const SECTION_TEMPLATES = {
  skills: { title: 'Skills', type: 'skills', content: ['Skill 1', 'Skill 2', 'Skill 3'] },
  highlights: { title: 'Highlights', type: 'list', content: ['- Key achievement 1', '- Key achievement 2'] },
  languages: { title: 'Languages', type: 'skills', content: ['English (Native)', 'Spanish (Conversational)'] },
  certifications: { title: 'Certifications', type: 'list', content: ['Certification Name — Year'] },
  interests: { title: 'Interests', type: 'skills', content: ['Interest 1', 'Interest 2'] }
};

// Initialize structure panel
export function initStructurePanel(onChange, onDesignChange) {
  onChangeCallback = onChange;
  onDesignChangeCallback = onDesignChange;
  
  // Set up toggle button
  const toggleBtn = document.getElementById('toggle-structure-panel');
  const closeBtn = document.getElementById('close-structure-panel');
  
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => togglePanel(true));
  }
  
  if (closeBtn) {
    closeBtn.addEventListener('click', () => togglePanel(false));
  }
  
  // Subscribe to store changes
  store.subscribe((event) => {
    if (event === 'dataLoaded' || event === 'change') {
      if (isPanelOpen) {
        renderPanel();
      }
    }
  });
  
  // Set up delegated event handlers
  setupEventHandlers();
}

// Update design settings from main.js
export function setDesignSettings(palette, layout, custom) {
  currentPalette = palette;
  currentLayout = layout;
  customColor = custom;
  if (isPanelOpen && currentTab === 'design') {
    renderPanel();
  }
}

// Toggle panel visibility
function togglePanel(open) {
  const panel = document.getElementById('structure-panel');
  const toggleBtn = document.getElementById('toggle-structure-panel');
  const app = document.querySelector('.app');
  
  isPanelOpen = open !== undefined ? open : !isPanelOpen;
  
  if (panel) {
    panel.classList.toggle('open', isPanelOpen);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', isPanelOpen);
  }
  if (app) {
    app.classList.toggle('panel-open', isPanelOpen);
  }
  
  if (isPanelOpen) {
    renderPanel();
  }
}

// Tab labels with icons for dropdown
const TAB_OPTIONS = {
  header: { label: 'Header', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="6" rx="1"/><rect x="3" y="12" width="18" height="9" rx="1" opacity="0.3"/></svg>' },
  sidebar: { label: 'Sidebar', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="6" height="18" rx="1"/><rect x="12" y="3" width="9" height="18" rx="1" opacity="0.3"/></svg>' },
  main: { label: 'Main Content', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="6" height="18" rx="1" opacity="0.3"/><rect x="12" y="3" width="9" height="18" rx="1"/></svg>' },
  design: { label: 'Design', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a4.5 4.5 0 0 0 0 9 4.5 4.5 0 0 1 0 9 10 10 0 0 0 0-18z"/></svg>' }
};

// Helper function to render a collapsible section
function renderCollapsibleSection(sectionId, title, content, extraHeaderContent = '') {
  const isCollapsed = collapsedSections[`${currentTab}-${sectionId}`] || false;
  return `
    <section class="panel-section ${isCollapsed ? 'collapsed' : ''}" data-section-id="${sectionId}">
      <div class="panel-section-header" data-action="toggle-section" data-section="${sectionId}">
        <h3 class="panel-section-title">${title}</h3>
        <div class="panel-section-actions">
          ${extraHeaderContent}
          <button class="panel-collapse-btn" data-action="toggle-section" data-section="${sectionId}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="${isCollapsed ? '6 9 12 15 18 9' : '18 15 12 9 6 15'}"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="panel-section-content">
        ${content}
      </div>
    </section>
  `;
}

// Toggle section collapse state
function toggleSection(sectionId) {
  const key = `${currentTab}-${sectionId}`;
  collapsedSections[key] = !collapsedSections[key];
  renderPanel();
}

// Render the panel content
function renderPanel(preserveScroll = true) {
  const content = document.getElementById('structure-panel-content');
  if (!content) return;
  
  // Preserve scroll position
  const tabContent = content.querySelector('.panel-tab-content');
  const scrollTop = preserveScroll && tabContent ? tabContent.scrollTop : 0;
  
  const data = store.getData();
  if (!data && currentTab !== 'design') {
    content.innerHTML = '<p class="panel-empty">No resume loaded</p>';
    return;
  }
  
  content.innerHTML = `
    <!-- Section Selector Dropdown -->
    <div class="panel-section-selector">
      <button class="panel-section-dropdown" id="section-dropdown-btn">
        <span class="dropdown-icon">${TAB_OPTIONS[currentTab].icon}</span>
        <span class="dropdown-label">${TAB_OPTIONS[currentTab].label}</span>
        <svg class="dropdown-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="panel-section-menu" id="section-dropdown-menu">
        ${Object.entries(TAB_OPTIONS).map(([key, opt]) => `
          <button class="panel-section-option ${currentTab === key ? 'active' : ''}" data-tab="${key}">
            <span class="option-icon">${opt.icon}</span>
            <span class="option-label">${opt.label}</span>
            ${currentTab === key ? '<svg class="option-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Tab Content -->
    <div class="panel-tab-content">
      ${currentTab === 'header' ? renderHeaderTab(data) : ''}
      ${currentTab === 'sidebar' ? renderSidebarTab(data) : ''}
      ${currentTab === 'main' ? renderMainTab(data) : ''}
      ${currentTab === 'design' ? renderDesignTab() : ''}
    </div>
  `;
  
  // Setup dropdown toggle
  setupSectionDropdown();
  
  // Restore scroll position after render
  if (preserveScroll && scrollTop > 0) {
    requestAnimationFrame(() => {
      const newTabContent = content.querySelector('.panel-tab-content');
      if (newTabContent) {
        newTabContent.scrollTop = scrollTop;
      }
    });
  }
}

// Setup section dropdown
function setupSectionDropdown() {
  const btn = document.getElementById('section-dropdown-btn');
  const menu = document.getElementById('section-dropdown-menu');
  
  if (!btn || !menu) return;
  
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('show');
    btn.classList.toggle('open');
  });
  
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.panel-section-selector')) {
      menu.classList.remove('show');
      btn.classList.remove('open');
    }
  }, { once: true });
}

// Render Header tab content
function renderHeaderTab(data) {
  const nameContent = `
    <div class="form-group">
      <label>Name</label>
      <input type="text" class="form-input" data-field="name" value="${escapeAttr(data.name || '')}">
    </div>
    <div class="form-group">
      <label>Professional Title</label>
      <input type="text" class="form-input" data-field="tagline" value="${escapeAttr(data.tagline || '')}">
    </div>
  `;

  const contactContent = `
    <div class="form-group">
      <label>Location</label>
      <input type="text" class="form-input" data-field="contact.location" value="${escapeAttr(data.contact?.location || '')}">
    </div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" class="form-input" data-field="contact.email" value="${escapeAttr(data.contact?.email || '')}">
    </div>
    <div class="form-group">
      <label>Phone</label>
      <input type="tel" class="form-input" data-field="contact.phone" value="${escapeAttr(data.contact?.phone || '')}">
    </div>
    <div class="form-group">
      <label>Portfolio URL</label>
      <input type="text" class="form-input" data-field="contact.portfolio" value="${escapeAttr(data.contact?.portfolio || '')}">
    </div>
    <div class="form-group">
      <label>Instagram</label>
      <input type="text" class="form-input" data-field="contact.instagram" value="${escapeAttr(data.contact?.instagram || '')}">
    </div>
  `;

  return `
    ${renderCollapsibleSection('name-title', 'Name & Title', nameContent)}
    ${renderCollapsibleSection('contact-info', 'Contact Information', contactContent)}
  `;
}

// Render Sidebar tab content
function renderSidebarTab(data) {
  const addButton = `
    <button class="panel-add-btn" id="add-section-btn" title="Add section">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  `;

  const sectionsContent = `
    <div class="sortable-list" id="sections-list" data-sortable="sections">
      ${(data.sections || []).map((section, i) => renderSectionItem(section, i)).join('')}
    </div>
    <div class="add-section-menu" id="add-section-menu">
      ${Object.entries(SECTION_TEMPLATES).map(([key, template]) => `
        <button class="add-section-option" data-template="${key}">${template.title}</button>
      `).join('')}
      <button class="add-section-option" data-template="custom">Custom Section...</button>
    </div>
  `;

  const toolsContent = `
    <div class="form-group">
      <textarea class="form-textarea" data-field="tools" rows="3" placeholder="Tool 1 • Tool 2 • Tool 3">${escapeAttr(data.tools || '')}</textarea>
      <small class="form-hint">Separate tools with • (bullet)</small>
    </div>
  `;

  return `
    ${renderCollapsibleSection('sidebar-sections', 'Sidebar Sections', sectionsContent, addButton)}
    ${renderCollapsibleSection('tools', 'Tools', toolsContent)}
  `;
}

// Render Main tab content
function renderMainTab(data) {
  const summaryContent = `
    <div class="form-group">
      <textarea class="form-textarea" data-field="summary" rows="4" placeholder="A brief professional summary...">${escapeAttr(data.summary || '')}</textarea>
    </div>
  `;

  const experienceAddButton = `
    <button class="panel-add-btn" id="add-experience-btn" title="Add experience">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  `;

  const experienceContent = `
    <div class="accordion-list" id="experience-list" data-sortable="experience">
      ${(data.experience || []).map((exp, i) => renderExperienceItem(exp, i)).join('')}
    </div>
  `;

  const educationAddButton = `
    <button class="panel-add-btn" id="add-education-btn" title="Add education">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  `;

  const educationContent = `
    <div class="sortable-list" id="education-list" data-sortable="education">
      ${(data.education || []).map((edu, i) => `
        <div class="sortable-item" data-index="${i}" draggable="true">
          <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
          <input type="text" class="form-input flex-grow" data-field="education[${i}]" value="${escapeAttr(edu)}">
          <button class="item-delete-btn" data-action="delete-education" data-index="${i}" title="Delete">×</button>
        </div>
      `).join('')}
    </div>
  `;

  return `
    ${renderCollapsibleSection('summary', 'Summary', summaryContent)}
    ${renderCollapsibleSection('experience', 'Experience', experienceContent, experienceAddButton)}
    ${renderCollapsibleSection('education', 'Education', educationContent, educationAddButton)}
  `;
}

// Render Design tab content
function renderDesignTab() {
  // Color Theme content
  const colorThemeContent = `
    <div class="design-palette-grid">
      ${Object.entries(COLOR_PALETTES).map(([key, colors]) => `
        <button class="design-palette-btn ${currentPalette === key ? 'active' : ''}" 
                data-action="set-palette" 
                data-palette="${key}" 
                title="${key.charAt(0).toUpperCase() + key.slice(1)}">
          <span class="design-palette-preview" style="--p1: ${colors.p1}; --p2: ${colors.p2}; --p3: ${colors.p3};"></span>
        </button>
      `).join('')}
    </div>
    
    <!-- Custom Color -->
    <div class="design-custom-color">
      <div class="design-custom-header">
        <span class="design-custom-label">Custom Color</span>
        <label class="design-color-picker">
          <input type="color" id="design-custom-color" value="${customColor}" data-action="custom-color-input">
          <span class="design-color-swatch" style="background-color: ${customColor};"></span>
        </label>
      </div>
      <button class="design-palette-btn custom ${currentPalette === 'custom' ? 'active' : ''}" 
              data-action="set-palette" 
              data-palette="custom" 
              title="Custom color">
        <span class="design-palette-preview" id="design-custom-preview" style="--p1: ${customColor}; --p2: ${generateDarkColor(customColor)}; --p3: ${generateLightColor(customColor)};"></span>
      </button>
    </div>
  `;

  // Layout content
  const layoutContent = `
    <div class="design-layout-grid">
      <button class="design-layout-btn ${currentLayout === 'sidebar' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="sidebar">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="7" height="18" rx="1"/>
          <rect x="12" y="3" width="9" height="18" rx="1"/>
        </svg>
        <span>Sidebar</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'right-sidebar' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="right-sidebar">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="9" height="18" rx="1"/>
          <rect x="14" y="3" width="7" height="18" rx="1"/>
        </svg>
        <span>Right Side</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'stacked' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="stacked">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="5" rx="1"/>
          <rect x="3" y="10" width="18" height="5" rx="1"/>
          <rect x="3" y="17" width="18" height="4" rx="1"/>
        </svg>
        <span>Stacked</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'compact' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="compact">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="4" rx="1"/>
          <rect x="3" y="9" width="12" height="12" rx="1"/>
          <rect x="17" y="9" width="4" height="12" rx="1"/>
        </svg>
        <span>Compact</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'executive' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="executive">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="6" rx="1"/>
          <rect x="3" y="11" width="12" height="10" rx="1"/>
          <rect x="17" y="11" width="4" height="10" rx="1"/>
        </svg>
        <span>Executive</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'classic' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="classic">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="4" rx="1"/>
          <rect x="3" y="9" width="18" height="12" rx="1"/>
        </svg>
        <span>Classic</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'modern' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="modern">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="3" rx="1"/>
          <rect x="3" y="8" width="5" height="13" rx="1"/>
          <rect x="10" y="8" width="11" height="13" rx="1"/>
        </svg>
        <span>Modern</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'timeline' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="timeline">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="4" rx="1"/>
          <line x1="7" y1="10" x2="7" y2="21" stroke-dasharray="2 2"/>
          <rect x="10" y="9" width="11" height="3" rx="0.5"/>
          <rect x="10" y="14" width="11" height="3" rx="0.5"/>
          <rect x="10" y="19" width="11" height="2" rx="0.5"/>
        </svg>
        <span>Timeline</span>
      </button>
      <button class="design-layout-btn ${currentLayout === 'creative' ? 'active' : ''}" 
              data-action="set-layout" 
              data-layout="creative">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 3h18v6H3z" rx="1"/>
          <rect x="3" y="11" width="8" height="4" rx="1"/>
          <rect x="13" y="11" width="8" height="4" rx="1"/>
          <rect x="3" y="17" width="18" height="4" rx="1"/>
        </svg>
        <span>Creative</span>
      </button>
    </div>
  `;

  return `
    ${renderCollapsibleSection('color-theme', 'Color Theme', colorThemeContent)}
    ${renderHeaderStyleSection()}
    ${renderTypographySection()}
    ${renderCollapsibleSection('layout', 'Layout', layoutContent)}
    ${renderSpacingSection()}
    ${renderAccentSection()}
    ${renderPhotoSection()}
    ${renderExportSection()}
  `;
}

// Render Export section
function renderExportSection() {
  const exportContent = `
    <div class="design-export-buttons">
      <button class="btn btn-primary design-export-btn" data-action="download-pdf">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download PDF
      </button>
      <button class="btn btn-secondary design-export-btn" data-action="print-resume">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 6 2 18 2 18 9"/>
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
          <rect x="6" y="14" width="12" height="8"/>
        </svg>
        Print
      </button>
    </div>
  `;
  return renderCollapsibleSection('export', 'Export', exportContent);
}

// Render Typography section
function renderTypographySection() {
  // Get current font family names for preview
  const previewFonts = getCurrentPreviewFonts();
  
  const typographyContent = `
    <!-- Live Font Preview -->
    <div class="font-preview-card">
      <div class="font-preview-header" style="font-family: ${previewFonts.display};">
        Jane Smith
      </div>
      <div class="font-preview-body" style="font-family: ${previewFonts.body};">
        Senior Software Engineer with 8+ years of experience building scalable web applications.
      </div>
    </div>
    
    <!-- Font Source Tabs -->
    <div class="font-source-tabs">
      <button class="font-source-tab ${fontSubTab === 'presets' ? 'active' : ''}" 
              data-action="set-font-tab" data-tab="presets">
        Presets
      </button>
      <button class="font-source-tab ${fontSubTab === 'google' ? 'active' : ''}" 
              data-action="set-font-tab" data-tab="google">
        Google Fonts
      </button>
      <button class="font-source-tab ${fontSubTab === 'system' ? 'active' : ''}" 
              data-action="set-font-tab" data-tab="system">
        System
      </button>
    </div>
    
    <!-- Font Content -->
    <div class="font-content">
      ${fontSubTab === 'presets' ? renderFontPresets() : ''}
      ${fontSubTab === 'google' ? renderGoogleFonts() : ''}
      ${fontSubTab === 'system' ? renderSystemFonts() : ''}
    </div>
  `;
  return renderCollapsibleSection('typography', 'Typography', typographyContent);
}

// Get current font families for preview
function getCurrentPreviewFonts() {
  if (currentFontSettings.mode === 'preset' && currentFontSettings.pairingId) {
    const pairing = FONT_PAIRINGS[currentFontSettings.pairingId];
    if (pairing) {
      return {
        display: `'${pairing.display.family}', ${pairing.display.category}`,
        body: `'${pairing.body.family}', ${pairing.body.category}`
      };
    }
  } else if (currentFontSettings.mode === 'google') {
    return {
      display: currentFontSettings.displayFont ? `'${currentFontSettings.displayFont.family}', ${currentFontSettings.displayFont.category}` : 'serif',
      body: currentFontSettings.bodyFont ? `'${currentFontSettings.bodyFont.family}', ${currentFontSettings.bodyFont.category}` : 'sans-serif'
    };
  } else if (currentFontSettings.mode === 'system') {
    const displayFont = SYSTEM_FONT_STACKS[currentFontSettings.displayFont];
    const bodyFont = SYSTEM_FONT_STACKS[currentFontSettings.bodyFont];
    return {
      display: displayFont ? displayFont.family : 'serif',
      body: bodyFont ? bodyFont.family : 'sans-serif'
    };
  }
  return { display: 'serif', body: 'sans-serif' };
}

// Render font preset pairings
function renderFontPresets() {
  const currentPairing = currentFontSettings.mode === 'preset' ? currentFontSettings.pairingId : null;
  
  return `
    <div class="font-presets-grid">
      ${Object.entries(FONT_PAIRINGS).map(([id, pairing]) => `
        <button class="font-preset-btn ${currentPairing === id ? 'active' : ''}" 
                data-action="select-font-preset" 
                data-preset="${id}">
          <span class="font-preset-name">${pairing.name}</span>
          <span class="font-preset-sample" style="font-family: '${pairing.display.family}', serif;">Aa</span>
          <span class="font-preset-families">${pairing.display.family} + ${pairing.body.family}</span>
        </button>
      `).join('')}
    </div>
  `;
}

// Render Google Fonts picker
function renderGoogleFonts() {
  const fonts = searchGoogleFonts(googleFontSearch, googleFontCategory);
  const currentDisplay = currentFontSettings.mode === 'google' ? currentFontSettings.displayFont?.family : null;
  const currentBody = currentFontSettings.mode === 'google' ? currentFontSettings.bodyFont?.family : null;
  
  return `
    <div class="google-fonts-picker">
      <!-- Search -->
      <div class="font-search">
        <input type="text" 
               class="form-input" 
               placeholder="Search fonts..." 
               value="${googleFontSearch}"
               data-action="font-search-input">
      </div>
      
      <!-- Category Filter -->
      <div class="font-category-filter">
        <button class="font-category-btn ${!googleFontCategory ? 'active' : ''}" 
                data-action="set-font-category" data-category="">All</button>
        <button class="font-category-btn ${googleFontCategory === 'serif' ? 'active' : ''}" 
                data-action="set-font-category" data-category="serif">Serif</button>
        <button class="font-category-btn ${googleFontCategory === 'sans-serif' ? 'active' : ''}" 
                data-action="set-font-category" data-category="sans-serif">Sans</button>
        <button class="font-category-btn ${googleFontCategory === 'display' ? 'active' : ''}" 
                data-action="set-font-category" data-category="display">Display</button>
      </div>
      
      <!-- Current Selection -->
      <div class="font-current-selection">
        <div class="font-selection-row">
          <label>Display Font:</label>
          <span class="font-selection-value">${currentDisplay || 'Not set'}</span>
        </div>
        <div class="font-selection-row">
          <label>Body Font:</label>
          <span class="font-selection-value">${currentBody || 'Not set'}</span>
        </div>
      </div>
      
      <!-- Font List -->
      <div class="font-list">
        ${fonts.map(font => `
          <div class="font-list-item">
            <span class="font-list-name" style="font-family: '${font.family}', ${font.category};">${font.family}</span>
            <span class="font-list-category">${font.category}</span>
            <div class="font-list-actions">
              <button class="font-select-btn ${currentDisplay === font.family ? 'active' : ''}" 
                      data-action="select-google-font" 
                      data-font-family="${font.family}"
                      data-font-category="${font.category}"
                      data-font-type="display"
                      title="Use as display font">H</button>
              <button class="font-select-btn ${currentBody === font.family ? 'active' : ''}" 
                      data-action="select-google-font" 
                      data-font-family="${font.family}"
                      data-font-category="${font.category}"
                      data-font-type="body"
                      title="Use as body font">B</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Render system fonts picker
function renderSystemFonts() {
  const systemFonts = Object.entries(SYSTEM_FONT_STACKS);
  const currentDisplay = currentFontSettings.mode === 'system' ? currentFontSettings.displayFont : null;
  const currentBody = currentFontSettings.mode === 'system' ? currentFontSettings.bodyFont : null;
  
  return `
    <div class="system-fonts-picker">
      <!-- Current Selection -->
      <div class="font-current-selection">
        <div class="font-selection-row">
          <label>Display Font:</label>
          <span class="font-selection-value">${currentDisplay ? SYSTEM_FONT_STACKS[currentDisplay]?.name || currentDisplay : 'Not set'}</span>
        </div>
        <div class="font-selection-row">
          <label>Body Font:</label>
          <span class="font-selection-value">${currentBody ? SYSTEM_FONT_STACKS[currentBody]?.name || currentBody : 'Not set'}</span>
        </div>
      </div>
      
      <!-- System Font List -->
      <div class="font-list">
        ${systemFonts.map(([id, font]) => `
          <div class="font-list-item">
            <span class="font-list-name" style="font-family: ${font.family};">${font.name}</span>
            <span class="font-list-category">${font.category}</span>
            <div class="font-list-actions">
              <button class="font-select-btn ${currentDisplay === id ? 'active' : ''}" 
                      data-action="select-system-font" 
                      data-font-id="${id}"
                      data-font-type="display"
                      title="Use as display font">H</button>
              <button class="font-select-btn ${currentBody === id ? 'active' : ''}" 
                      data-action="select-system-font" 
                      data-font-id="${id}"
                      data-font-type="body"
                      title="Use as body font">B</button>
            </div>
          </div>
        `).join('')}
      </div>
      
      <p class="font-hint">System fonts work offline and render consistently across devices.</p>
    </div>
  `;
}

// Render Header Style section
function renderHeaderStyleSection() {
  // Get current colors for previews
  const colors = getCurrentColors();
  const isSolid = currentHeaderStyle.type === 'solid';
  
  const headerStyleContent = `
    <!-- Enable/Disable Toggle -->
    <div class="header-style-toggle">
      <div class="header-style-toggle-row">
        <button class="header-style-toggle-btn ${isSolid ? 'active' : ''}" 
                data-action="select-header-style" 
                data-style-type="solid"
                data-style-id="solid">
          <span class="toggle-preview" style="background: ${colors.headerBg};"></span>
          <span class="toggle-label">Solid Color</span>
          <span class="toggle-desc">Use color theme only</span>
        </button>
        <button class="header-style-toggle-btn ${!isSolid ? 'active' : ''}" 
                data-action="enable-header-style">
          <span class="toggle-preview styled" style="background: linear-gradient(135deg, ${colors.headerBg}, ${colors.headerBgEnd});"></span>
          <span class="toggle-label">Styled</span>
          <span class="toggle-desc">Add visual effects</span>
        </button>
      </div>
    </div>
    
    ${!isSolid ? `
    <!-- Style Type Tabs -->
    <div class="header-style-tabs">
      <button class="header-style-tab ${headerStyleTab === 'gradients' ? 'active' : ''}" 
              data-action="set-header-tab" data-tab="gradients">
        Gradients
      </button>
      <button class="header-style-tab ${headerStyleTab === 'patterns' ? 'active' : ''}" 
              data-action="set-header-tab" data-tab="patterns">
        Patterns
      </button>
      <button class="header-style-tab ${headerStyleTab === 'textures' ? 'active' : ''}" 
              data-action="set-header-tab" data-tab="textures">
        Textures
      </button>
      <button class="header-style-tab ${headerStyleTab === 'image' ? 'active' : ''}" 
              data-action="set-header-tab" data-tab="image">
        Image
      </button>
    </div>
    
    <!-- Style Content -->
    <div class="header-style-content">
      ${headerStyleTab === 'gradients' ? renderGradientStyles(colors) : ''}
      ${headerStyleTab === 'patterns' ? renderPatternStyles(colors) : ''}
      ${headerStyleTab === 'textures' ? renderTextureStyles(colors) : ''}
      ${headerStyleTab === 'image' ? renderImageUpload() : ''}
    </div>
    ` : ''}
  `;
  return renderCollapsibleSection('header-style', 'Header Style', headerStyleContent);
}

// Get current color values
function getCurrentColors() {
  const palette = COLOR_PALETTES[currentPalette];
  if (currentPalette === 'custom') {
    return {
      headerBg: generateDarkColor(customColor),
      headerBgEnd: adjustColorBrightness(generateDarkColor(customColor), 0.1),
      accent: customColor
    };
  }
  return {
    headerBg: palette.p2,
    headerBgEnd: adjustColorBrightness(palette.p2, 0.15),
    accent: palette.p1
  };
}

// Helper to adjust color brightness
function adjustColorBrightness(hex, factor) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  
  const newR = Math.min(255, Math.max(0, Math.round(r + (255 - r) * factor)));
  const newG = Math.min(255, Math.max(0, Math.round(g + (255 - g) * factor)));
  const newB = Math.min(255, Math.max(0, Math.round(b + (255 - b) * factor)));
  
  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

// Render gradient styles
function renderGradientStyles(colors) {
  const isGradientActive = currentHeaderStyle.type === 'gradient';
  
  return `
    <div class="header-style-grid">
      ${Object.entries(GRADIENT_STYLES).map(([id, style]) => `
        <button class="header-style-btn ${isGradientActive && currentHeaderStyle.styleId === id ? 'active' : ''}" 
                data-action="select-header-style" 
                data-style-type="gradient"
                data-style-id="${id}"
                title="${style.name}">
          <span class="header-style-preview" style="background: ${style.css(colors.headerBg, colors.headerBgEnd)};"></span>
          <span class="header-style-label">${style.name}</span>
        </button>
      `).join('')}
    </div>
  `;
}

// Render pattern styles
function renderPatternStyles(colors) {
  const isPatternActive = currentHeaderStyle.type === 'pattern';
  
  return `
    <div class="header-style-grid">
      ${Object.entries(PATTERN_STYLES).map(([id, style]) => `
        <button class="header-style-btn ${isPatternActive && currentHeaderStyle.styleId === id ? 'active' : ''}" 
                data-action="select-header-style" 
                data-style-type="pattern"
                data-style-id="${id}"
                title="${style.name}">
          <span class="header-style-preview" style="background: ${style.css(colors.headerBg, colors.headerBgEnd, colors.accent)}; background-size: ${style.size || 'auto'};"></span>
          <span class="header-style-label">${style.name}</span>
        </button>
      `).join('')}
    </div>
  `;
}

// Render texture styles
function renderTextureStyles(colors) {
  const isTextureActive = currentHeaderStyle.type === 'texture';
  
  return `
    <div class="header-style-grid">
      ${Object.entries(TEXTURE_STYLES).map(([id, style]) => `
        <button class="header-style-btn ${isTextureActive && currentHeaderStyle.styleId === id ? 'active' : ''}" 
                data-action="select-header-style" 
                data-style-type="texture"
                data-style-id="${id}"
                title="${style.name}">
          <span class="header-style-preview" style="background: ${style.css(colors.headerBg, colors.headerBgEnd, colors.accent)};"></span>
          <span class="header-style-label">${style.name}</span>
        </button>
      `).join('')}
    </div>
  `;
}

// Render image upload section
function renderImageUpload() {
  const hasImage = currentHeaderStyle.customImage;
  
  return `
    <div class="header-image-upload">
      ${hasImage ? `
        <div class="header-image-preview">
          <img src="${currentHeaderStyle.customImage}" alt="Header background">
          <button class="header-image-remove" data-action="remove-header-image" title="Remove image">×</button>
        </div>
        
        <div class="header-image-controls">
          <div class="control-row">
            <label>Opacity:</label>
            <input type="range" min="0" max="100" value="${Math.round((currentHeaderStyle.imageOpacity || 0.3) * 100)}" 
                   data-action="header-image-opacity" class="slider-input">
            <span class="slider-value">${Math.round((currentHeaderStyle.imageOpacity || 0.3) * 100)}%</span>
          </div>
          
          <div class="control-row">
            <label>Fit:</label>
            <select data-action="header-image-fit" class="form-select-small">
              <option value="cover" ${currentHeaderStyle.imageFit === 'cover' ? 'selected' : ''}>Cover</option>
              <option value="contain" ${currentHeaderStyle.imageFit === 'contain' ? 'selected' : ''}>Contain</option>
              <option value="tile" ${currentHeaderStyle.imageFit === 'tile' ? 'selected' : ''}>Tile</option>
            </select>
          </div>
        </div>
      ` : `
        <div class="header-image-dropzone" id="header-image-dropzone">
          <input type="file" id="header-image-input" accept="image/*" style="display: none;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <path d="M21 15l-5-5L5 21"/>
          </svg>
          <p>Drop image here or click to upload</p>
          <span>Recommended: 800x200px or larger</span>
        </div>
      `}
      
      <button class="btn btn-secondary btn-sm" 
              data-action="select-header-style" 
              data-style-type="gradient"
              data-style-id="linear-135"
              style="margin-top: var(--space-sm); width: 100%;">
        Reset to Gradient
      </button>
    </div>
  `;
}

// Spacing presets
const SPACING_PRESETS = {
  'compact': {
    name: 'Compact',
    description: 'Tighter spacing for more content',
    fontScale: 0.9,
    lineHeight: 1.3,
    sectionSpacing: 0.6,
    sidebarWidth: 2.0,
    pageMargins: { top: 0.35, right: 0.35, bottom: 0.35, left: 0.35 }
  },
  'normal': {
    name: 'Normal',
    description: 'Balanced and readable',
    fontScale: 1.0,
    lineHeight: 1.45,
    sectionSpacing: 0.8,
    sidebarWidth: 2.2,
    pageMargins: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 }
  },
  'relaxed': {
    name: 'Relaxed',
    description: 'More breathing room',
    fontScale: 1.05,
    lineHeight: 1.6,
    sectionSpacing: 1.0,
    sidebarWidth: 2.4,
    pageMargins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 }
  },
  'airy': {
    name: 'Airy',
    description: 'Maximum whitespace',
    fontScale: 1.1,
    lineHeight: 1.75,
    sectionSpacing: 1.2,
    sidebarWidth: 2.5,
    pageMargins: { top: 0.6, right: 0.6, bottom: 0.6, left: 0.6 }
  }
};

// Render spacing controls section
function renderSpacingSection() {
  const s = currentSpacing;
  
  // Detect current preset
  const currentPreset = detectSpacingPreset(s);
  
  const resetButton = `
    <button class="panel-reset-btn" data-action="reset-spacing" title="Reset to defaults">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
      </svg>
    </button>
  `;
  
  const spacingContent = `
    <!-- Spacing Presets -->
    <div class="spacing-presets">
      ${Object.entries(SPACING_PRESETS).map(([id, preset]) => `
        <button class="spacing-preset-btn ${currentPreset === id ? 'active' : ''}" 
                data-action="apply-spacing-preset" 
                data-preset="${id}"
                title="${preset.description}">
          <span class="preset-name">${preset.name}</span>
        </button>
      `).join('')}
    </div>
    
    <div class="spacing-divider">
      <span>Fine Tune</span>
    </div>
    
    <!-- Font Scale -->
    <div class="spacing-control">
      <div class="spacing-control-header">
        <label>Font Size</label>
        <span class="spacing-value">${Math.round(s.fontScale * 100)}%</span>
      </div>
      <input type="range" 
             min="70" max="130" 
             value="${Math.round(s.fontScale * 100)}" 
             data-action="spacing-font-scale"
             class="spacing-slider">
    </div>
    
    <!-- Line Height -->
    <div class="spacing-control">
      <div class="spacing-control-header">
        <label>Line Height</label>
        <span class="spacing-value">${s.lineHeight.toFixed(2)}</span>
      </div>
      <input type="range" 
             min="120" max="180" 
             value="${Math.round(s.lineHeight * 100)}" 
             data-action="spacing-line-height"
             class="spacing-slider">
    </div>
    
    <!-- Section Spacing -->
    <div class="spacing-control">
      <div class="spacing-control-header">
        <label>Section Gap</label>
        <span class="spacing-value">${s.sectionSpacing.toFixed(1)} rem</span>
      </div>
      <input type="range" 
             min="4" max="16" 
             value="${Math.round(s.sectionSpacing * 10)}" 
             data-action="spacing-section"
             class="spacing-slider">
    </div>
    
    <!-- Sidebar Width (for two-column layouts) -->
    <div class="spacing-control">
      <div class="spacing-control-header">
        <label>Sidebar Width</label>
        <span class="spacing-value">${s.sidebarWidth.toFixed(1)} in</span>
      </div>
      <input type="range" 
             min="18" max="32" 
             value="${Math.round(s.sidebarWidth * 10)}" 
             data-action="spacing-sidebar"
             class="spacing-slider">
    </div>
    
    <!-- Page Margins -->
    <div class="spacing-margins">
      <label class="spacing-margins-label">Page Margins (inches)</label>
      <div class="spacing-margins-grid">
        <div class="margin-control">
          <label>Top</label>
          <input type="number" 
                 step="0.1" min="0.2" max="1.0"
                 value="${s.pageMargins.top}"
                 data-action="spacing-margin"
                 data-margin="top"
                 class="margin-input">
        </div>
        <div class="margin-control">
          <label>Right</label>
          <input type="number" 
                 step="0.1" min="0.2" max="1.0"
                 value="${s.pageMargins.right}"
                 data-action="spacing-margin"
                 data-margin="right"
                 class="margin-input">
        </div>
        <div class="margin-control">
          <label>Bottom</label>
          <input type="number" 
                 step="0.1" min="0.2" max="1.0"
                 value="${s.pageMargins.bottom}"
                 data-action="spacing-margin"
                 data-margin="bottom"
                 class="margin-input">
        </div>
        <div class="margin-control">
          <label>Left</label>
          <input type="number" 
                 step="0.1" min="0.2" max="1.0"
                 value="${s.pageMargins.left}"
                 data-action="spacing-margin"
                 data-margin="left"
                 class="margin-input">
        </div>
      </div>
    </div>
  `;
  return renderCollapsibleSection('spacing', 'Spacing & Sizing', spacingContent, resetButton);
}

// Render accent styles section
function renderAccentSection() {
  const a = currentAccent;
  
  // Get current bullet character
  const bulletChar = BULLET_STYLES[a.bulletStyle]?.char || '•';
  
  const resetButton = `
    <button class="panel-reset-btn" data-action="reset-accent" title="Reset to defaults">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
      </svg>
    </button>
  `;
  
  const accentContent = `
    <!-- Live Accent Preview -->
    <div class="accent-preview-card">
      <div class="accent-preview-title" data-underline="${a.underlineStyle}" style="--underline-width: ${a.underlineWidth}px;">
        Experience
      </div>
      <div class="accent-preview-bullets">
        <div class="accent-preview-bullet">${bulletChar || ''} Led team of 5 engineers</div>
        <div class="accent-preview-bullet">${bulletChar || ''} Increased efficiency by 40%</div>
      </div>
      <div class="accent-preview-skills" data-tag-style="${a.skillTagStyle}">
        <span class="accent-skill-tag">JavaScript</span>
        <span class="accent-skill-tag">React</span>
        <span class="accent-skill-tag">Node.js</span>
      </div>
    </div>
    
    <!-- Section Title Underline -->
    <div class="accent-control">
      <label>Title Underline</label>
      <div class="accent-options-row">
        ${Object.entries(UNDERLINE_STYLES).map(([id, style]) => `
          <button class="accent-option-btn ${a.underlineStyle === id ? 'active' : ''}" 
                  data-action="set-underline"
                  data-value="${id}"
                  title="${style.name}">
            <span class="underline-preview ${id}"></span>
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Underline Width -->
    <div class="accent-control compact">
      <div class="spacing-control-header">
        <label>Underline Width</label>
        <span class="spacing-value">${a.underlineWidth}px</span>
      </div>
      <input type="range" 
             min="1" max="4" 
             value="${a.underlineWidth}" 
             data-action="accent-underline-width"
             class="spacing-slider">
    </div>
    
    <!-- Bullet Style -->
    <div class="accent-control">
      <label>Bullet Points</label>
      <div class="accent-options-row bullets">
        ${Object.entries(BULLET_STYLES).map(([id, style]) => `
          <button class="accent-option-btn bullet ${a.bulletStyle === id ? 'active' : ''}" 
                  data-action="set-bullet"
                  data-value="${id}"
                  title="${style.name}">
            ${id === 'none' ? '<span class="bullet-none">∅</span>' : (style.char || '—')}
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Border Radius -->
    <div class="accent-control">
      <label>Corner Rounding</label>
      <div class="accent-options-row radius">
        ${Object.entries(BORDER_RADIUS_PRESETS).map(([id, preset]) => `
          <button class="accent-option-btn radius ${a.borderRadius === id ? 'active' : ''}" 
                  data-action="set-radius"
                  data-value="${id}"
                  title="${preset.name}">
            <span class="radius-preview" style="border-radius: ${preset.value};"></span>
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Skill Tag Style -->
    <div class="accent-control">
      <label>Skill Tags</label>
      <div class="accent-options-row tags">
        <button class="accent-option-btn tag ${a.skillTagStyle === 'plain' ? 'active' : ''}" 
                data-action="set-skill-tag"
                data-value="plain"
                title="Plain (bullet-separated)">
          <span class="tag-preview plain">A • B</span>
        </button>
        <button class="accent-option-btn tag ${a.skillTagStyle === 'filled' ? 'active' : ''}" 
                data-action="set-skill-tag"
                data-value="filled"
                title="Filled">
          <span class="tag-preview filled">Skill</span>
        </button>
        <button class="accent-option-btn tag ${a.skillTagStyle === 'outlined' ? 'active' : ''}" 
                data-action="set-skill-tag"
                data-value="outlined"
                title="Outlined">
          <span class="tag-preview outlined">Skill</span>
        </button>
        <button class="accent-option-btn tag ${a.skillTagStyle === 'minimal' ? 'active' : ''}" 
                data-action="set-skill-tag"
                data-value="minimal"
                title="Minimal">
          <span class="tag-preview minimal">Skill</span>
        </button>
      </div>
    </div>
    
    <!-- Decorative Elements -->
    <div class="accent-control">
      <label>Decorative Elements</label>
      <div class="decorative-toggles">
        <label class="toggle-row">
          <input type="checkbox" 
                 data-action="toggle-corner-triangle" 
                 ${a.showCornerTriangle !== false ? 'checked' : ''}>
          <span class="toggle-label">Header corner accent</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" 
                 data-action="toggle-sidebar-gradient" 
                 ${a.showSidebarGradient !== false ? 'checked' : ''}>
          <span class="toggle-label">Sidebar gradient overlay</span>
        </label>
      </div>
    </div>
  `;
  return renderCollapsibleSection('accents', 'Accents', accentContent, resetButton);
}

// Render photo section
function renderPhotoSection() {
  const p = currentPhoto;
  
  const photoContent = p.enabled && p.imageData ? `
    <!-- Photo Preview & Controls -->
    <div class="photo-preview-container">
      <div class="photo-preview">
        <img src="${p.imageData}" alt="Profile photo">
        <button class="photo-remove-btn" data-action="remove-photo" title="Remove photo">×</button>
      </div>
    </div>
    
    <!-- Placement -->
    <div class="photo-control">
      <label>Placement</label>
      <div class="photo-options-row">
        ${Object.entries(PHOTO_PLACEMENTS).map(([id, opt]) => `
          <button class="photo-option-btn ${p.placement === id ? 'active' : ''}" 
                  data-action="set-photo-placement"
                  data-value="${id}"
                  title="${opt.description}">
            ${opt.name}
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Shape -->
    <div class="photo-control">
      <label>Shape</label>
      <div class="photo-options-row">
        ${Object.entries(PHOTO_SHAPES).map(([id, shape]) => `
          <button class="photo-option-btn shape ${p.shape === id ? 'active' : ''}" 
                  data-action="set-photo-shape"
                  data-value="${id}"
                  title="${shape.name}">
            <span class="shape-preview" style="border-radius: ${shape.css};"></span>
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Size -->
    <div class="photo-control">
      <label>Size</label>
      <div class="photo-options-row">
        ${Object.entries(PHOTO_SIZES).map(([id, size]) => `
          <button class="photo-option-btn ${p.size === id ? 'active' : ''}" 
                  data-action="set-photo-size"
                  data-value="${id}">
            ${size.name}
          </button>
        `).join('')}
      </div>
    </div>
    
    <!-- Border -->
    <div class="photo-control">
      <label>Border</label>
      <div class="photo-options-row">
        <button class="photo-option-btn ${p.borderColor === 'accent' ? 'active' : ''}" 
                data-action="set-photo-border"
                data-value="accent">
          Accent
        </button>
        <button class="photo-option-btn ${p.borderColor === 'white' ? 'active' : ''}" 
                data-action="set-photo-border"
                data-value="white">
          White
        </button>
        <button class="photo-option-btn ${p.borderColor === 'none' ? 'active' : ''}" 
                data-action="set-photo-border"
                data-value="none">
          None
        </button>
      </div>
    </div>
    
    <!-- Image Position (Crop Focus) -->
    <div class="photo-control">
      <label>Image Focus</label>
      <div class="photo-position-grid">
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'left top' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="left top" title="Top Left">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'center top' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="center top" title="Top Center">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'right top' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="right top" title="Top Right">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'left center' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="left center" title="Middle Left">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'center center' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="center center" title="Center">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'right center' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="right center" title="Middle Right">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'left bottom' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="left bottom" title="Bottom Left">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'center bottom' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="center bottom" title="Bottom Center">
          <span class="pos-dot"></span>
        </button>
        <button class="photo-position-btn ${(p.objectPosition || 'center center') === 'right bottom' ? 'active' : ''}" 
                data-action="set-photo-position" data-value="right bottom" title="Bottom Right">
          <span class="pos-dot"></span>
        </button>
      </div>
      <p class="photo-hint">Choose which part of the image to focus on</p>
    </div>
    
    <!-- Zoom -->
    <div class="photo-control">
      <div class="spacing-control-header">
        <label>Zoom</label>
        <span class="spacing-value">${Math.round((p.scale || 1) * 100)}%</span>
      </div>
      <input type="range" 
             min="100" max="200" 
             value="${Math.round((p.scale || 1) * 100)}" 
             data-action="set-photo-scale"
             class="spacing-slider">
    </div>
  ` : `
    <!-- Upload Dropzone -->
    <div class="photo-upload-dropzone" id="photo-dropzone">
      <input type="file" id="photo-input" accept="image/*" style="display: none;">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="8" r="4"/>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      </svg>
      <p>Add Profile Photo</p>
      <span>Click or drag image here</span>
    </div>
  `;
  return renderCollapsibleSection('photo', 'Profile Photo', photoContent);
}

// Helper to generate dark color from hex
function generateDarkColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Darken by 70%
  const dr = Math.round(r * 0.2).toString(16).padStart(2, '0');
  const dg = Math.round(g * 0.2).toString(16).padStart(2, '0');
  const db = Math.round(b * 0.2).toString(16).padStart(2, '0');
  return `#${dr}${dg}${db}`;
}

// Helper to generate light color from hex
function generateLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Lighten by mixing with white
  const lr = Math.round(r + (255 - r) * 0.9).toString(16).padStart(2, '0');
  const lg = Math.round(g + (255 - g) * 0.9).toString(16).padStart(2, '0');
  const lb = Math.round(b + (255 - b) * 0.9).toString(16).padStart(2, '0');
  return `#${lr}${lg}${lb}`;
}

// Render a sidebar section item
function renderSectionItem(section, index) {
  return `
    <div class="sortable-item section-item" data-index="${index}" data-section-id="${section.id || index}" draggable="true">
      <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
      <div class="section-item-content">
        <input type="text" class="form-input section-title-input" 
               data-field="sections[${index}].title" 
               value="${escapeAttr(section.title)}">
        <div class="section-content-list" data-sortable="sections[${index}].content">
          ${(section.content || []).map((item, i) => `
            <div class="section-content-item" data-index="${i}" draggable="true">
              <span class="drag-handle small" title="Drag to reorder">⋮</span>
              <input type="text" class="form-input" 
                     data-field="sections[${index}].content[${i}]" 
                     value="${escapeAttr(item)}">
              <button class="item-delete-btn small" 
                      data-action="delete-section-content" 
                      data-section="${index}" 
                      data-index="${i}">×</button>
            </div>
          `).join('')}
          <button class="add-item-btn" data-action="add-section-content" data-section="${index}">
            + Add item
          </button>
        </div>
      </div>
      <button class="item-delete-btn" data-action="delete-section" data-index="${index}" title="Delete section">×</button>
    </div>
  `;
}

// Render an experience item
function renderExperienceItem(exp, index) {
  const isExpanded = exp._expanded !== false;
  
  return `
    <div class="accordion-item" data-index="${index}" data-experience-id="${exp.id || index}" draggable="true">
      <div class="accordion-header" data-action="toggle-experience" data-index="${index}">
        <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
        <span class="accordion-title">${escapeHtml(exp.title || 'Untitled Position')}</span>
        <span class="accordion-subtitle">${escapeHtml(exp.company || '')}</span>
        <svg class="accordion-chevron ${isExpanded ? 'expanded' : ''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      <div class="accordion-content ${isExpanded ? 'expanded' : ''}">
        <div class="form-group">
          <label>Job Title</label>
          <input type="text" class="form-input" data-field="experience[${index}].title" value="${escapeAttr(exp.title || '')}">
        </div>
        <div class="form-group">
          <label>Company</label>
          <input type="text" class="form-input" data-field="experience[${index}].company" value="${escapeAttr(exp.company || '')}">
        </div>
        <div class="form-group">
          <label>Dates</label>
          <input type="text" class="form-input" data-field="experience[${index}].dates" value="${escapeAttr(exp.dates || '')}">
        </div>
        <div class="form-group">
          <label>Bullets</label>
          <div class="bullet-list" data-sortable="experience[${index}].bullets">
            ${(exp.bullets || []).map((bullet, i) => `
              <div class="bullet-item" data-index="${i}" draggable="true">
                <span class="drag-handle small" title="Drag to reorder">⋮</span>
                <span class="bullet-marker">•</span>
                <input type="text" class="form-input" data-field="experience[${index}].bullets[${i}]" value="${escapeAttr(bullet)}">
                <button class="item-delete-btn small" data-action="delete-bullet" data-exp="${index}" data-index="${i}">×</button>
              </div>
            `).join('')}
            <button class="add-item-btn" data-action="add-bullet" data-exp="${index}">+ Add bullet</button>
          </div>
        </div>
        <div class="accordion-actions">
          <button class="btn-danger-small" data-action="delete-experience" data-index="${index}">Delete Experience</button>
        </div>
      </div>
    </div>
  `;
}

// Set up event handlers
function setupEventHandlers() {
  const panel = document.getElementById('structure-panel');
  if (!panel) return;
  
  // Section dropdown switching
  panel.addEventListener('click', (e) => {
    const option = e.target.closest('.panel-section-option');
    if (option) {
      currentTab = option.dataset.tab;
      renderPanel();
      return;
    }
  });
  
  // Input changes
  panel.addEventListener('input', (e) => {
    if (e.target.matches('.form-input, .form-textarea')) {
      const field = e.target.dataset.field;
      if (field) {
        store.update(field, e.target.value);
        if (onChangeCallback) onChangeCallback();
      }
    }
  });
  
  // Click actions
  panel.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) {
      // Check for add buttons
      if (e.target.closest('#add-section-btn')) {
        toggleAddSectionMenu();
        return;
      }
      if (e.target.closest('#add-experience-btn')) {
        addExperience();
        return;
      }
      if (e.target.closest('#add-education-btn')) {
        addEducation();
        return;
      }
      return;
    }
    
    const action = target.dataset.action;
    
    switch (action) {
      case 'toggle-experience':
        toggleExperience(parseInt(target.dataset.index));
        break;
        
      case 'delete-section':
        deleteSection(parseInt(target.dataset.index));
        break;
        
      case 'delete-section-content':
        deleteSectionContent(parseInt(target.dataset.section), parseInt(target.dataset.index));
        break;
        
      case 'add-section-content':
        addSectionContent(parseInt(target.dataset.section));
        break;
        
      case 'delete-experience':
        deleteExperience(parseInt(target.dataset.index));
        break;
        
      case 'add-bullet':
        addBullet(parseInt(target.dataset.exp));
        break;
        
      case 'delete-bullet':
        deleteBullet(parseInt(target.dataset.exp), parseInt(target.dataset.index));
        break;
        
      case 'delete-education':
        deleteEducation(parseInt(target.dataset.index));
        break;
      
      // Section collapse/expand
      case 'toggle-section':
        toggleSection(target.dataset.section);
        break;
        
      // Design tab actions
      case 'set-palette':
        handleSetPalette(target.dataset.palette);
        break;
        
      case 'set-layout':
        handleSetLayout(target.dataset.layout);
        break;
        
      case 'download-pdf':
        document.getElementById('download-pdf')?.click();
        break;
        
      case 'print-resume':
        window.print();
        break;
        
      // Font actions
      case 'set-font-tab':
        handleSetFontTab(target.dataset.tab);
        break;
        
      case 'select-font-preset':
        handleSelectFontPreset(target.dataset.preset);
        break;
        
      case 'set-font-category':
        handleSetFontCategory(target.dataset.category || null);
        break;
        
      case 'select-google-font':
        handleSelectGoogleFont(
          target.dataset.fontFamily, 
          target.dataset.fontCategory, 
          target.dataset.fontType
        );
        break;
        
      case 'select-system-font':
        handleSelectSystemFont(target.dataset.fontId, target.dataset.fontType);
        break;
        
      // Header style actions
      case 'set-header-tab':
        handleSetHeaderTab(target.dataset.tab);
        break;
        
      case 'select-header-style':
        handleSelectHeaderStyle(target.dataset.styleType, target.dataset.styleId);
        break;
        
      case 'enable-header-style':
        // Enable styled header - default to gradient
        handleSelectHeaderStyle('gradient', 'linear-135');
        break;
        
      case 'remove-header-image':
        handleRemoveHeaderImage();
        break;
        
      // Spacing actions
      case 'reset-spacing':
        handleResetSpacing();
        break;
        
      case 'apply-spacing-preset':
        handleApplySpacingPreset(target.dataset.preset);
        break;
        
      // Accent actions
      case 'reset-accent':
        handleResetAccent();
        break;
        
      case 'set-underline':
        handleAccentChange('underlineStyle', target.dataset.value);
        break;
        
      case 'set-bullet':
        handleAccentChange('bulletStyle', target.dataset.value);
        break;
        
      case 'set-radius':
        handleAccentChange('borderRadius', target.dataset.value);
        break;
        
      case 'set-skill-tag':
        handleAccentChange('skillTagStyle', target.dataset.value);
        break;
        
      case 'toggle-corner-triangle':
        handleAccentChange('showCornerTriangle', target.checked);
        break;
        
      case 'toggle-sidebar-gradient':
        handleAccentChange('showSidebarGradient', target.checked);
        break;
        
      // Photo actions
      case 'remove-photo':
        handleRemovePhoto();
        break;
        
      case 'set-photo-placement':
        handlePhotoChange('placement', target.dataset.value);
        break;
        
      case 'set-photo-shape':
        handlePhotoChange('shape', target.dataset.value);
        break;
        
      case 'set-photo-size':
        handlePhotoChange('size', target.dataset.value);
        break;
        
      case 'set-photo-border':
        handlePhotoChange('borderColor', target.dataset.value);
        break;
        
      case 'set-photo-position':
        handlePhotoChange('objectPosition', target.dataset.value);
        break;
        
      case 'set-photo-scale':
        handlePhotoChange('scale', parseFloat(target.value) / 100);
        break;
    }
  });
  
  // Custom color input change
  panel.addEventListener('input', (e) => {
    if (e.target.dataset.action === 'custom-color-input') {
      handleCustomColorChange(e.target.value);
    }
    
    // Font search input
    if (e.target.dataset.action === 'font-search-input') {
      googleFontSearch = e.target.value;
      renderPanel();
    }
    
    // Header image opacity
    if (e.target.dataset.action === 'header-image-opacity') {
      handleHeaderImageOpacity(e.target.value);
    }
    
    // Spacing controls
    if (e.target.dataset.action === 'spacing-font-scale') {
      handleSpacingChange('fontScale', parseInt(e.target.value) / 100);
    }
    if (e.target.dataset.action === 'spacing-line-height') {
      handleSpacingChange('lineHeight', parseInt(e.target.value) / 100);
    }
    if (e.target.dataset.action === 'spacing-section') {
      handleSpacingChange('sectionSpacing', parseInt(e.target.value) / 10);
    }
    if (e.target.dataset.action === 'spacing-sidebar') {
      handleSpacingChange('sidebarWidth', parseInt(e.target.value) / 10);
    }
    if (e.target.dataset.action === 'spacing-margin') {
      handleMarginChange(e.target.dataset.margin, parseFloat(e.target.value));
    }
    
    // Photo scale
    if (e.target.dataset.action === 'set-photo-scale') {
      handlePhotoChange('scale', parseFloat(e.target.value) / 100);
    }
    
    // Accent underline width
    if (e.target.dataset.action === 'accent-underline-width') {
      handleAccentChange('underlineWidth', parseInt(e.target.value));
    }
  });
  
  // Change event for select elements
  panel.addEventListener('change', (e) => {
    if (e.target.dataset.action === 'header-image-fit') {
      handleHeaderImageFit(e.target.value);
    }
  });
  
  // Setup header image dropzone
  setupHeaderImageDropzone(panel);
  
  // Setup photo dropzone
  setupPhotoDropzone(panel);
  
  // Add section menu
  document.addEventListener('click', (e) => {
    const option = e.target.closest('.add-section-option');
    if (option) {
      const template = option.dataset.template;
      addSection(template);
      toggleAddSectionMenu(false);
    } else if (!e.target.closest('#add-section-btn') && !e.target.closest('#add-section-menu')) {
      toggleAddSectionMenu(false);
    }
  });
  
  // Drag and drop for reordering
  setupDragAndDrop(panel);
}

// Setup drag and drop
function setupDragAndDrop(panel) {
  panel.addEventListener('dragstart', (e) => {
    const item = e.target.closest('[draggable="true"]');
    if (!item) return;
    
    draggedItem = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });
  
  panel.addEventListener('dragend', (e) => {
    if (draggedItem) {
      draggedItem.classList.remove('dragging');
      draggedItem = null;
    }
    
    // Remove all drag-over states
    panel.querySelectorAll('.drag-over, .drag-over-bottom').forEach(el => {
      el.classList.remove('drag-over', 'drag-over-bottom');
    });
    panel.querySelectorAll('.drag-over-end').forEach(el => {
      el.classList.remove('drag-over-end');
    });
  });
  
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const sortableList = e.target.closest('[data-sortable]');
    if (!sortableList || !draggedItem) return;
    
    const afterElement = getDragAfterElement(sortableList, e.clientY);
    const items = [...sortableList.querySelectorAll('[draggable="true"]:not(.dragging)')];
    
    // Remove previous drag-over states
    items.forEach(item => item.classList.remove('drag-over', 'drag-over-bottom'));
    sortableList.classList.remove('drag-over-end');
    
    if (afterElement) {
      // Dropping before this element - show indicator on top
      afterElement.classList.add('drag-over');
    } else if (items.length > 0) {
      // Dropping at the end - show indicator on the last item's bottom
      items[items.length - 1].classList.add('drag-over-bottom');
      sortableList.classList.add('drag-over-end');
    }
  });
  
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    
    const sortableList = e.target.closest('[data-sortable]');
    if (!sortableList || !draggedItem) return;
    
    // Save scroll position before re-render
    const panelContent = document.getElementById('structure-panel-content');
    const tabContent = panelContent?.querySelector('.panel-tab-content');
    const scrollTop = tabContent?.scrollTop || 0;
    
    const sortablePath = sortableList.dataset.sortable;
    const items = [...sortableList.querySelectorAll('[draggable="true"]')];
    const fromIndex = parseInt(draggedItem.dataset.index);
    
    const afterElement = getDragAfterElement(sortableList, e.clientY);
    let toIndex;
    
    if (afterElement) {
      toIndex = parseInt(afterElement.dataset.index);
      if (fromIndex < toIndex) toIndex--;
    } else {
      toIndex = items.length - 1;
    }
    
    if (fromIndex !== toIndex && !isNaN(fromIndex) && !isNaN(toIndex)) {
      store.moveInArray(sortablePath, fromIndex, toIndex);
      renderPanel();
      
      // Restore scroll position after re-render
      requestAnimationFrame(() => {
        const newTabContent = document.querySelector('#structure-panel-content .panel-tab-content');
        if (newTabContent) {
          newTabContent.scrollTop = scrollTop;
        }
      });
      
      if (onChangeCallback) onChangeCallback();
    }
  });
}

// Get the element to insert after during drag
function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('[draggable="true"]:not(.dragging)')];
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Toggle add section menu
function toggleAddSectionMenu(show) {
  const menu = document.getElementById('add-section-menu');
  if (menu) {
    menu.classList.toggle('show', show !== undefined ? show : !menu.classList.contains('show'));
  }
}

// Add a new section
function addSection(templateKey) {
  if (templateKey === 'custom') {
    const title = prompt('Enter section title:');
    if (!title) return;
    
    const newSection = {
      id: generateId('section'),
      title: title,
      type: 'skills',
      content: ['Item 1']
    };
    store.addToArray('sections', newSection);
  } else {
    const template = SECTION_TEMPLATES[templateKey];
    if (template) {
      const newSection = {
        id: generateId('section'),
        ...JSON.parse(JSON.stringify(template))
      };
      store.addToArray('sections', newSection);
    }
  }
  
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Delete a section
function deleteSection(index) {
  if (confirm('Delete this section?')) {
    store.removeFromArray('sections', index);
    renderPanel();
    if (onChangeCallback) onChangeCallback();
  }
}

// Add content to a section
function addSectionContent(sectionIndex) {
  const sections = store.get('sections');
  if (sections && sections[sectionIndex]) {
    store.addToArray(`sections[${sectionIndex}].content`, 'New item');
    renderPanel();
    if (onChangeCallback) onChangeCallback();
  }
}

// Delete content from a section
function deleteSectionContent(sectionIndex, contentIndex) {
  store.removeFromArray(`sections[${sectionIndex}].content`, contentIndex);
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Add experience
function addExperience() {
  const newExp = {
    id: generateId('exp'),
    title: 'New Position',
    company: 'Company Name',
    dates: 'Start – End',
    bullets: ['Describe your accomplishments'],
    _expanded: true
  };
  store.addToArray('experience', newExp);
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Delete experience
function deleteExperience(index) {
  if (confirm('Delete this experience entry?')) {
    store.removeFromArray('experience', index);
    renderPanel();
    if (onChangeCallback) onChangeCallback();
  }
}

// Toggle experience accordion
function toggleExperience(index) {
  const accordion = document.querySelector(`.accordion-item[data-index="${index}"]`);
  if (accordion) {
    const content = accordion.querySelector('.accordion-content');
    const chevron = accordion.querySelector('.accordion-chevron');
    content?.classList.toggle('expanded');
    chevron?.classList.toggle('expanded');
  }
}

// Add bullet to experience
function addBullet(expIndex) {
  store.addToArray(`experience[${expIndex}].bullets`, 'New bullet point');
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Delete bullet from experience
function deleteBullet(expIndex, bulletIndex) {
  store.removeFromArray(`experience[${expIndex}].bullets`, bulletIndex);
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Add education
function addEducation() {
  store.addToArray('education', 'Degree — Institution — Dates');
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Delete education
function deleteEducation(index) {
  store.removeFromArray('education', index);
  renderPanel();
  if (onChangeCallback) onChangeCallback();
}

// Handle palette selection
function handleSetPalette(palette) {
  currentPalette = palette;
  
  // Update UI
  document.querySelectorAll('.design-palette-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.palette === palette);
  });
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'palette', value: palette, customColor });
  }
}

// Handle layout selection
function handleSetLayout(layout) {
  currentLayout = layout;
  
  // Update UI
  document.querySelectorAll('.design-layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === layout);
  });
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'layout', value: layout });
  }
}

// Handle custom color change
function handleCustomColorChange(color) {
  customColor = color;
  
  // Update the preview
  const preview = document.getElementById('design-custom-preview');
  const swatch = document.querySelector('.design-color-swatch');
  
  if (preview) {
    preview.style.setProperty('--p1', color);
    preview.style.setProperty('--p2', generateDarkColor(color));
    preview.style.setProperty('--p3', generateLightColor(color));
  }
  
  if (swatch) {
    swatch.style.backgroundColor = color;
  }
  
  // If custom palette is active, apply immediately
  if (currentPalette === 'custom' && onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'customColor', value: color });
  }
}

// Handle font tab change
function handleSetFontTab(tab) {
  fontSubTab = tab;
  renderPanel();
}

// Handle font preset selection
async function handleSelectFontPreset(presetId) {
  currentFontSettings = {
    mode: 'preset',
    pairingId: presetId
  };
  
  // Load and apply the fonts
  await loadFontPairing(presetId);
  applyFontSettings(currentFontSettings);
  saveFontSettings(currentFontSettings);
  
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'font', value: currentFontSettings });
  }
}

// Handle font category filter change
function handleSetFontCategory(category) {
  googleFontCategory = category;
  renderPanel();
}

// Handle Google font selection
async function handleSelectGoogleFont(family, category, fontType) {
  // Load the font
  await loadGoogleFont(family, [400, 500, 600, 700]);
  
  // Update settings
  if (currentFontSettings.mode !== 'google') {
    currentFontSettings = {
      mode: 'google',
      displayFont: null,
      bodyFont: null
    };
  }
  
  if (fontType === 'display') {
    currentFontSettings.displayFont = { family, category };
  } else if (fontType === 'body') {
    currentFontSettings.bodyFont = { family, category };
  }
  
  applyFontSettings(currentFontSettings);
  saveFontSettings(currentFontSettings);
  
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'font', value: currentFontSettings });
  }
}

// Handle system font selection
function handleSelectSystemFont(fontId, fontType) {
  // Update settings
  if (currentFontSettings.mode !== 'system') {
    currentFontSettings = {
      mode: 'system',
      displayFont: null,
      bodyFont: null
    };
  }
  
  if (fontType === 'display') {
    currentFontSettings.displayFont = fontId;
  } else if (fontType === 'body') {
    currentFontSettings.bodyFont = fontId;
  }
  
  applyFontSettings(currentFontSettings);
  saveFontSettings(currentFontSettings);
  
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'font', value: currentFontSettings });
  }
}

// Handle header style tab change
function handleSetHeaderTab(tab) {
  headerStyleTab = tab;
  renderPanel();
}

// Handle header style selection
function handleSelectHeaderStyle(styleType, styleId) {
  currentHeaderStyle = {
    ...currentHeaderStyle,
    type: styleType,
    styleId: styleId
  };
  
  const colors = getCurrentColors();
  applyHeaderStyle(currentHeaderStyle, colors);
  saveHeaderStyleSettings(currentHeaderStyle);
  
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'headerStyle', value: currentHeaderStyle });
  }
}

// Handle header image opacity change
function handleHeaderImageOpacity(value) {
  const opacity = parseInt(value) / 100;
  currentHeaderStyle.imageOpacity = opacity;
  
  const colors = getCurrentColors();
  applyHeaderStyle(currentHeaderStyle, colors);
  saveHeaderStyleSettings(currentHeaderStyle);
  
  // Update slider value display
  const sliderValue = document.querySelector('.header-image-controls .slider-value');
  if (sliderValue) {
    sliderValue.textContent = `${value}%`;
  }
}

// Handle header image fit change
function handleHeaderImageFit(value) {
  currentHeaderStyle.imageFit = value;
  
  const colors = getCurrentColors();
  applyHeaderStyle(currentHeaderStyle, colors);
  saveHeaderStyleSettings(currentHeaderStyle);
}

// Handle remove header image
function handleRemoveHeaderImage() {
  currentHeaderStyle = {
    type: 'gradient',
    styleId: 'linear-135',
    customImage: null,
    imageOpacity: 0.3,
    imageFit: 'cover'
  };
  
  const colors = getCurrentColors();
  applyHeaderStyle(currentHeaderStyle, colors);
  saveHeaderStyleSettings(currentHeaderStyle);
  
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'headerStyle', value: currentHeaderStyle });
  }
}

// Setup header image dropzone
function setupHeaderImageDropzone(panel) {
  // Use event delegation for dynamically created elements
  panel.addEventListener('click', (e) => {
    const dropzone = e.target.closest('#header-image-dropzone');
    if (dropzone) {
      const input = document.getElementById('header-image-input');
      if (input) input.click();
    }
  });
  
  // File input change
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'header-image-input') {
      handleHeaderImageFile(e.target.files[0]);
    }
  });
  
  // Drag and drop
  panel.addEventListener('dragover', (e) => {
    const dropzone = e.target.closest('#header-image-dropzone');
    if (dropzone) {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }
  });
  
  panel.addEventListener('dragleave', (e) => {
    const dropzone = e.target.closest('#header-image-dropzone');
    if (dropzone) {
      dropzone.classList.remove('dragover');
    }
  });
  
  panel.addEventListener('drop', (e) => {
    const dropzone = e.target.closest('#header-image-dropzone');
    if (dropzone) {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        handleHeaderImageFile(file);
      }
    }
  });
}

// Handle header image file
function handleHeaderImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    currentHeaderStyle = {
      ...currentHeaderStyle,
      type: 'image',
      styleId: 'custom',
      customImage: e.target.result,
      imageOpacity: currentHeaderStyle.imageOpacity || 0.3,
      imageFit: currentHeaderStyle.imageFit || 'cover'
    };
    
    const colors = getCurrentColors();
    applyHeaderStyle(currentHeaderStyle, colors);
    saveHeaderStyleSettings(currentHeaderStyle);
    
    renderPanel();
    
    // Notify main.js
    if (onDesignChangeCallback) {
      onDesignChangeCallback({ type: 'headerStyle', value: currentHeaderStyle });
    }
  };
  reader.readAsDataURL(file);
}

// Handle spacing change
function handleSpacingChange(property, value) {
  currentSpacing[property] = value;
  applySpacingSettings(currentSpacing);
  saveSpacingSettings(currentSpacing);
  
  // Update display values without full re-render to preserve scroll
  updateSpacingDisplayValues();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'spacing', value: currentSpacing });
  }
}

// Handle margin change
function handleMarginChange(side, value) {
  currentSpacing.pageMargins[side] = value;
  applySpacingSettings(currentSpacing);
  saveSpacingSettings(currentSpacing);
}

// Handle reset spacing
function handleResetSpacing() {
  currentSpacing = resetSpacingSettings();
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'spacing', value: currentSpacing });
  }
}

// Handle apply spacing preset
function handleApplySpacingPreset(presetId) {
  const preset = SPACING_PRESETS[presetId];
  if (!preset) return;
  
  currentSpacing = {
    fontScale: preset.fontScale,
    lineHeight: preset.lineHeight,
    sectionSpacing: preset.sectionSpacing,
    sidebarWidth: preset.sidebarWidth,
    pageMargins: { ...preset.pageMargins }
  };
  
  applySpacingSettings(currentSpacing);
  saveSpacingSettings(currentSpacing);
  renderPanel();
  
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'spacing', value: currentSpacing });
  }
}

// Detect if current spacing matches a preset
function detectSpacingPreset(spacing) {
  for (const [id, preset] of Object.entries(SPACING_PRESETS)) {
    if (
      Math.abs(spacing.fontScale - preset.fontScale) < 0.05 &&
      Math.abs(spacing.lineHeight - preset.lineHeight) < 0.1 &&
      Math.abs(spacing.sectionSpacing - preset.sectionSpacing) < 0.1
    ) {
      return id;
    }
  }
  return null;
}

// Handle accent change
function handleAccentChange(property, value) {
  currentAccent[property] = value;
  applyAccentSettings(currentAccent);
  saveAccentSettings(currentAccent);
  
  // Only re-render for property changes that require UI update (like button selection)
  // Don't re-render for checkbox toggles
  if (property !== 'showCornerTriangle' && property !== 'showSidebarGradient') {
    renderPanel();
  }
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'accent', value: currentAccent });
  }
}

// Handle reset accent
function handleResetAccent() {
  currentAccent = resetAccentSettings();
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'accent', value: currentAccent });
  }
}

// Handle photo change
function handlePhotoChange(property, value) {
  currentPhoto[property] = value;
  applyPhotoSettings(currentPhoto);
  savePhotoSettings(currentPhoto);
  
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'photo', value: currentPhoto });
  }
}

// Handle remove photo
function handleRemovePhoto() {
  currentPhoto = removePhoto();
  renderPanel();
  
  // Notify main.js
  if (onDesignChangeCallback) {
    onDesignChangeCallback({ type: 'photo', value: currentPhoto });
  }
}

// Setup photo dropzone
function setupPhotoDropzone(panel) {
  // Click to upload
  panel.addEventListener('click', (e) => {
    const dropzone = e.target.closest('#photo-dropzone');
    if (dropzone) {
      const input = document.getElementById('photo-input');
      if (input) input.click();
    }
  });
  
  // File input change
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'photo-input') {
      handlePhotoFile(e.target.files[0]);
    }
  });
  
  // Drag and drop
  panel.addEventListener('dragover', (e) => {
    const dropzone = e.target.closest('#photo-dropzone');
    if (dropzone) {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }
  });
  
  panel.addEventListener('dragleave', (e) => {
    const dropzone = e.target.closest('#photo-dropzone');
    if (dropzone) {
      dropzone.classList.remove('dragover');
    }
  });
  
  panel.addEventListener('drop', (e) => {
    const dropzone = e.target.closest('#photo-dropzone');
    if (dropzone) {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        handlePhotoFile(file);
      }
    }
  });
}

// Handle photo file upload
function handlePhotoFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    currentPhoto = {
      ...currentPhoto,
      enabled: true,
      imageData: e.target.result
    };
    
    applyPhotoSettings(currentPhoto);
    savePhotoSettings(currentPhoto);
    
    renderPanel();
    
    // Notify main.js
    if (onDesignChangeCallback) {
      onDesignChangeCallback({ type: 'photo', value: currentPhoto });
    }
  };
  reader.readAsDataURL(file);
}

// Update spacing display values without re-rendering
function updateSpacingDisplayValues() {
  const fontScaleValue = document.querySelector('[data-action="spacing-font-scale"]')?.parentElement.querySelector('.spacing-value');
  const lineHeightValue = document.querySelector('[data-action="spacing-line-height"]')?.parentElement.querySelector('.spacing-value');
  const sectionValue = document.querySelector('[data-action="spacing-section"]')?.parentElement.querySelector('.spacing-value');
  const sidebarValue = document.querySelector('[data-action="spacing-sidebar"]')?.parentElement.querySelector('.spacing-value');
  
  if (fontScaleValue) fontScaleValue.textContent = `${Math.round(currentSpacing.fontScale * 100)}%`;
  if (lineHeightValue) lineHeightValue.textContent = currentSpacing.lineHeight.toFixed(2);
  if (sectionValue) sectionValue.textContent = `${currentSpacing.sectionSpacing.toFixed(1)} rem`;
  if (sidebarValue) sidebarValue.textContent = `${currentSpacing.sidebarWidth.toFixed(1)} in`;
}

// Escape HTML for display
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Escape for attribute values
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Export for external use
export function openPanel() {
  togglePanel(true);
}

export function closePanel() {
  togglePanel(false);
}
