/**
 * Structure Panel
 * Side panel for editing resume structure with tabbed interface
 */

import { store, generateId } from './store.js';

let isPanelOpen = false;
let onChangeCallback = null;
let onDesignChangeCallback = null;
let currentTab = 'header'; // 'header', 'sidebar', 'main', 'design'
let draggedItem = null;

// Current design settings (will be synced from main.js)
let currentPalette = 'terracotta';
let currentLayout = 'sidebar';
let customColor = '#c45c3e';

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

// Render the panel content
function renderPanel() {
  const content = document.getElementById('structure-panel-content');
  if (!content) return;
  
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
  return `
    <!-- Name & Tagline -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Name & Title</h3>
      </div>
      <div class="panel-section-content">
        <div class="form-group">
          <label>Name</label>
          <input type="text" class="form-input" data-field="name" value="${escapeAttr(data.name || '')}">
        </div>
        <div class="form-group">
          <label>Professional Title</label>
          <input type="text" class="form-input" data-field="tagline" value="${escapeAttr(data.tagline || '')}">
        </div>
      </div>
    </section>
    
    <!-- Contact Info -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Contact Information</h3>
      </div>
      <div class="panel-section-content">
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
      </div>
    </section>
  `;
}

// Render Sidebar tab content
function renderSidebarTab(data) {
  return `
    <!-- Sections -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Sidebar Sections</h3>
        <button class="panel-add-btn" id="add-section-btn" title="Add section">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
      <div class="panel-section-content">
        <div class="sortable-list" id="sections-list" data-sortable="sections">
          ${(data.sections || []).map((section, i) => renderSectionItem(section, i)).join('')}
        </div>
        <div class="add-section-menu" id="add-section-menu">
          ${Object.entries(SECTION_TEMPLATES).map(([key, template]) => `
            <button class="add-section-option" data-template="${key}">${template.title}</button>
          `).join('')}
          <button class="add-section-option" data-template="custom">Custom Section...</button>
        </div>
      </div>
    </section>
    
    <!-- Tools -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Tools</h3>
      </div>
      <div class="panel-section-content">
        <div class="form-group">
          <textarea class="form-textarea" data-field="tools" rows="3" placeholder="Tool 1 • Tool 2 • Tool 3">${escapeAttr(data.tools || '')}</textarea>
          <small class="form-hint">Separate tools with • (bullet)</small>
        </div>
      </div>
    </section>
  `;
}

// Render Main tab content
function renderMainTab(data) {
  return `
    <!-- Summary -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Summary</h3>
      </div>
      <div class="panel-section-content">
        <div class="form-group">
          <textarea class="form-textarea" data-field="summary" rows="4" placeholder="A brief professional summary...">${escapeAttr(data.summary || '')}</textarea>
        </div>
      </div>
    </section>
    
    <!-- Experience -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Experience</h3>
        <button class="panel-add-btn" id="add-experience-btn" title="Add experience">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
      <div class="panel-section-content">
        <div class="accordion-list" id="experience-list" data-sortable="experience">
          ${(data.experience || []).map((exp, i) => renderExperienceItem(exp, i)).join('')}
        </div>
      </div>
    </section>
    
    <!-- Education -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Education</h3>
        <button class="panel-add-btn" id="add-education-btn" title="Add education">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
      <div class="panel-section-content">
        <div class="sortable-list" id="education-list" data-sortable="education">
          ${(data.education || []).map((edu, i) => `
            <div class="sortable-item" data-index="${i}" draggable="true">
              <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
              <input type="text" class="form-input flex-grow" data-field="education[${i}]" value="${escapeAttr(edu)}">
              <button class="item-delete-btn" data-action="delete-education" data-index="${i}" title="Delete">×</button>
            </div>
          `).join('')}
        </div>
      </div>
    </section>
  `;
}

// Render Design tab content
function renderDesignTab() {
  return `
    <!-- Color Theme -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Color Theme</h3>
      </div>
      <div class="panel-section-content">
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
      </div>
    </section>
    
    <!-- Layout -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Layout</h3>
      </div>
      <div class="panel-section-content">
        <div class="design-layout-options">
          <button class="design-layout-btn ${currentLayout === 'sidebar' ? 'active' : ''}" 
                  data-action="set-layout" 
                  data-layout="sidebar">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="7" height="18" rx="1"/>
              <rect x="12" y="3" width="9" height="18" rx="1"/>
            </svg>
            <span>Sidebar</span>
          </button>
          <button class="design-layout-btn ${currentLayout === 'stacked' ? 'active' : ''}" 
                  data-action="set-layout" 
                  data-layout="stacked">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="5" rx="1"/>
              <rect x="3" y="10" width="18" height="5" rx="1"/>
              <rect x="3" y="17" width="18" height="4" rx="1"/>
            </svg>
            <span>Stacked</span>
          </button>
        </div>
      </div>
    </section>
    
    <!-- Export Options -->
    <section class="panel-section">
      <div class="panel-section-header">
        <h3 class="panel-section-title">Export</h3>
      </div>
      <div class="panel-section-content">
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
      </div>
    </section>
  `;
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
    }
  });
  
  // Custom color input change
  panel.addEventListener('input', (e) => {
    if (e.target.dataset.action === 'custom-color-input') {
      handleCustomColorChange(e.target.value);
    }
  });
  
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
    panel.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const sortableList = e.target.closest('[data-sortable]');
    if (!sortableList || !draggedItem) return;
    
    const afterElement = getDragAfterElement(sortableList, e.clientY);
    const items = [...sortableList.querySelectorAll('[draggable="true"]:not(.dragging)')];
    
    // Remove previous drag-over states
    items.forEach(item => item.classList.remove('drag-over'));
    
    if (afterElement) {
      afterElement.classList.add('drag-over');
    }
  });
  
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    
    const sortableList = e.target.closest('[data-sortable]');
    if (!sortableList || !draggedItem) return;
    
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
