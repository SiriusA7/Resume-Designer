/**
 * Job Description Panel
 * UI for managing job descriptions and analyzing resume fit
 */

import {
  initJobDescriptions,
  getAllJobDescriptions,
  getJobDescription,
  addJobDescription,
  updateJobDescription,
  deleteJobDescription,
  toggleJobDescriptionActive,
  getActiveJobDescriptions,
  parseJobDescriptionText,
  exportJobDescriptions,
  importJobDescriptions
} from './jobDescriptions.js';

import { analyzeAgainstJobs, tailorForJob, generateResumeChanges } from './aiService.js';
import { getConfiguredProviders } from './aiService.js';
import { getSettings } from './persistence.js';
import { createChangeSet } from './diffEngine.js';
import { showDiffView } from './diffView.js';
import { store } from './store.js';

let panelContainer = null;
let isAnalyzing = false;
let analysisResults = null;

/**
 * Initialize job description panel
 */
export function initJobDescriptionPanel() {
  initJobDescriptions();
  createPanel();
}

/**
 * Create the panel container (hidden by default)
 */
function createPanel() {
  if (document.getElementById('jd-panel-overlay')) return;
  
  const html = `
    <div class="jd-panel-overlay" id="jd-panel-overlay">
      <div class="jd-panel">
        <div class="jd-panel-header">
          <h2>Target Job Descriptions</h2>
          <button class="jd-panel-close" id="jd-panel-close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        
        <div class="jd-panel-content" id="jd-panel-content">
          <!-- Content rendered here -->
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', html);
  panelContainer = document.getElementById('jd-panel-overlay');
  
  // Close button
  document.getElementById('jd-panel-close')?.addEventListener('click', closePanel);
  
  // Click outside to close
  panelContainer?.addEventListener('click', (e) => {
    if (e.target === panelContainer) {
      closePanel();
    }
  });
  
  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelContainer?.classList.contains('show')) {
      closePanel();
    }
  });
}

/**
 * Open the job description panel
 */
export function openJobDescriptionPanel() {
  createPanel();
  renderContent();
  panelContainer?.classList.add('show');
  document.body.style.overflow = 'hidden';
}

/**
 * Close the job description panel
 */
export function closePanel() {
  panelContainer?.classList.remove('show');
  document.body.style.overflow = '';
}

/**
 * Render panel content
 */
function renderContent() {
  const content = document.getElementById('jd-panel-content');
  if (!content) return;
  
  const jobDescriptions = getAllJobDescriptions();
  const activeJDs = getActiveJobDescriptions();
  
  content.innerHTML = `
    <div class="jd-panel-section">
      <div class="jd-section-header">
        <h3>Add New Job Description</h3>
      </div>
      <div class="jd-add-form">
        <input type="text" id="jd-title" class="jd-input" placeholder="Job Title (e.g., Senior Designer)">
        <input type="text" id="jd-company" class="jd-input" placeholder="Company Name">
        <textarea id="jd-description" class="jd-textarea" placeholder="Paste the full job description here..." rows="6"></textarea>
        <div class="jd-form-actions">
          <button class="btn btn-secondary jd-paste-btn" id="jd-paste-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Paste from Clipboard
          </button>
          <button class="btn btn-primary" id="jd-add-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Job Description
          </button>
        </div>
      </div>
    </div>
    
    <div class="jd-panel-section">
      <div class="jd-section-header">
        <h3>Your Job Descriptions (${jobDescriptions.length})</h3>
        <div class="jd-section-actions">
          <button class="jd-icon-btn" id="jd-import-btn" title="Import from JSON">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </button>
          <button class="jd-icon-btn" id="jd-export-btn" title="Export to JSON">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </div>
      </div>
      
      <div class="jd-list" id="jd-list">
        ${jobDescriptions.length === 0 ? `
          <div class="jd-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="9" y1="9" x2="15" y2="9"/>
              <line x1="9" y1="13" x2="15" y2="13"/>
              <line x1="9" y1="17" x2="12" y2="17"/>
            </svg>
            <p>No job descriptions added yet</p>
            <span>Add target jobs to analyze your resume fit</span>
          </div>
        ` : jobDescriptions.map(jd => renderJobDescriptionCard(jd)).join('')}
      </div>
    </div>
    
    ${activeJDs.length > 0 ? `
      <div class="jd-panel-section jd-analysis-section">
        <div class="jd-section-header">
          <h3>Resume Analysis</h3>
        </div>
        <div class="jd-analysis-actions">
          <button class="btn btn-primary jd-analyze-btn" id="jd-analyze-btn" ${!getConfiguredProviders().length ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            ${isAnalyzing ? 'Analyzing...' : 'Analyze Resume Fit'}
          </button>
          <button class="btn btn-secondary jd-tailor-btn" id="jd-tailor-btn" ${!getConfiguredProviders().length ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            Tailor Resume
          </button>
        </div>
        ${!getConfiguredProviders().length ? `
          <p class="jd-warning">Configure an API key in settings to use AI analysis.</p>
        ` : ''}
        <div class="jd-analysis-results" id="jd-analysis-results">
          ${renderAnalysisResults()}
        </div>
      </div>
    ` : ''}
  `;
  
  setupEventListeners();
}

/**
 * Render a single job description card
 */
function renderJobDescriptionCard(jd) {
  const preview = jd.description.length > 150 
    ? jd.description.substring(0, 150) + '...' 
    : jd.description;
    
  return `
    <div class="jd-card ${jd.isActive ? 'active' : ''}" data-id="${jd.id}">
      <div class="jd-card-header">
        <div class="jd-card-info">
          <h4 class="jd-card-title">${escapeHtml(jd.title)}</h4>
          <span class="jd-card-company">${escapeHtml(jd.company)}</span>
        </div>
        <div class="jd-card-actions">
          <button class="jd-card-toggle ${jd.isActive ? 'active' : ''}" data-id="${jd.id}" title="${jd.isActive ? 'Deactivate' : 'Activate'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${jd.isActive 
                ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
                : '<circle cx="12" cy="12" r="10"/>'}
            </svg>
          </button>
          <button class="jd-card-edit" data-id="${jd.id}" title="Edit">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="jd-card-delete" data-id="${jd.id}" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
      <p class="jd-card-preview">${escapeHtml(preview)}</p>
      <div class="jd-card-footer">
        <span class="jd-card-date">Added ${formatDate(jd.dateAdded)}</span>
      </div>
    </div>
  `;
}

/**
 * Render analysis results
 */
function renderAnalysisResults() {
  if (!analysisResults) return '';
  
  return `
    <div class="jd-results">
      <div class="jd-score">
        <div class="jd-score-circle">
          <span class="jd-score-value">${analysisResults.matchScore}</span>
          <span class="jd-score-label">Match</span>
        </div>
      </div>
      
      <div class="jd-results-section">
        <h4>Matching Keywords</h4>
        <div class="jd-keywords">
          ${(analysisResults.keywordMatches || []).map(k => 
            `<span class="jd-keyword match">${escapeHtml(k)}</span>`
          ).join('')}
        </div>
      </div>
      
      <div class="jd-results-section">
        <h4>Missing Keywords</h4>
        <div class="jd-keywords">
          ${(analysisResults.missingKeywords || []).map(k => 
            `<span class="jd-keyword missing">${escapeHtml(k)}</span>`
          ).join('')}
        </div>
      </div>
      
      <div class="jd-results-section">
        <h4>Strengths</h4>
        <ul class="jd-list-simple">
          ${(analysisResults.strengths || []).map(s => 
            `<li class="jd-strength">${escapeHtml(s)}</li>`
          ).join('')}
        </ul>
      </div>
      
      <div class="jd-results-section">
        <h4>Gaps to Address</h4>
        <ul class="jd-list-simple">
          ${(analysisResults.gaps || []).map(g => 
            `<li class="jd-gap">
              <strong>${escapeHtml(g.area)}:</strong> ${escapeHtml(g.issue)}
              <span class="jd-suggestion">${escapeHtml(g.suggestion)}</span>
            </li>`
          ).join('')}
        </ul>
      </div>
      
      ${(analysisResults.recommendations || []).length > 0 ? `
        <div class="jd-results-section">
          <h4>Recommended Changes</h4>
          ${analysisResults.recommendations.map((rec, i) => `
            <div class="jd-recommendation">
              <div class="jd-rec-header">
                <span class="jd-rec-section">${escapeHtml(rec.section)}</span>
                <button class="btn btn-sm jd-apply-rec" data-index="${i}">Apply</button>
              </div>
              <div class="jd-rec-content">
                <div class="jd-rec-current">${escapeHtml(rec.current)}</div>
                <div class="jd-rec-arrow">→</div>
                <div class="jd-rec-suggested">${escapeHtml(rec.suggested)}</div>
              </div>
              <p class="jd-rec-reason">${escapeHtml(rec.reason)}</p>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  const content = document.getElementById('jd-panel-content');
  if (!content) return;
  
  // Add button
  document.getElementById('jd-add-btn')?.addEventListener('click', handleAdd);
  
  // Paste button
  document.getElementById('jd-paste-btn')?.addEventListener('click', handlePaste);
  
  // Import/Export
  document.getElementById('jd-import-btn')?.addEventListener('click', handleImport);
  document.getElementById('jd-export-btn')?.addEventListener('click', handleExport);
  
  // Analyze and Tailor buttons
  document.getElementById('jd-analyze-btn')?.addEventListener('click', handleAnalyze);
  document.getElementById('jd-tailor-btn')?.addEventListener('click', handleTailor);
  
  // Card actions (delegated)
  content.addEventListener('click', (e) => {
    const card = e.target.closest('.jd-card');
    const toggleBtn = e.target.closest('.jd-card-toggle');
    const editBtn = e.target.closest('.jd-card-edit');
    const deleteBtn = e.target.closest('.jd-card-delete');
    const applyRecBtn = e.target.closest('.jd-apply-rec');
    
    if (toggleBtn) {
      const id = toggleBtn.dataset.id;
      toggleJobDescriptionActive(id);
      renderContent();
    } else if (editBtn) {
      const id = editBtn.dataset.id;
      openEditModal(id);
    } else if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      if (confirm('Delete this job description?')) {
        deleteJobDescription(id);
        renderContent();
      }
    } else if (applyRecBtn) {
      const index = parseInt(applyRecBtn.dataset.index);
      applyRecommendation(index);
    }
  });
}

/**
 * Handle adding a new job description
 */
function handleAdd() {
  const title = document.getElementById('jd-title')?.value.trim();
  const company = document.getElementById('jd-company')?.value.trim();
  const description = document.getElementById('jd-description')?.value.trim();
  
  if (!description) {
    alert('Please enter a job description');
    return;
  }
  
  addJobDescription({
    title: title || 'Untitled Position',
    company: company || 'Unknown Company',
    description
  });
  
  // Clear form
  document.getElementById('jd-title').value = '';
  document.getElementById('jd-company').value = '';
  document.getElementById('jd-description').value = '';
  
  renderContent();
}

/**
 * Handle paste from clipboard
 */
async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const parsed = parseJobDescriptionText(text);
      document.getElementById('jd-title').value = parsed.title;
      document.getElementById('jd-company').value = parsed.company;
      document.getElementById('jd-description').value = parsed.description;
    }
  } catch (e) {
    console.error('Failed to read clipboard:', e);
    alert('Could not read from clipboard. Please paste manually.');
  }
}

/**
 * Handle import
 */
function handleImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const count = importJobDescriptions(text);
      alert(`Imported ${count} job description(s)`);
      renderContent();
    } catch (err) {
      alert('Failed to import: ' + err.message);
    }
  };
  
  input.click();
}

/**
 * Handle export
 */
function handleExport() {
  const json = exportJobDescriptions();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'job-descriptions.json';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Handle analyze
 */
async function handleAnalyze() {
  const activeJDs = getActiveJobDescriptions();
  if (activeJDs.length === 0) {
    alert('Please activate at least one job description');
    return;
  }
  
  const settings = getSettings();
  const modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5-20251022';
  
  isAnalyzing = true;
  renderContent();
  
  try {
    analysisResults = await analyzeAgainstJobs(modelId, activeJDs);
    renderContent();
  } catch (error) {
    alert('Analysis failed: ' + error.message);
    analysisResults = null;
  } finally {
    isAnalyzing = false;
    renderContent();
  }
}

/**
 * Handle tailor button
 */
async function handleTailor() {
  const activeJDs = getActiveJobDescriptions();
  if (activeJDs.length === 0) {
    alert('Please activate at least one job description');
    return;
  }
  
  const settings = getSettings();
  const modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5-20251022';
  
  try {
    const result = await generateResumeChanges(
      modelId,
      'Tailor my entire resume for these target jobs. Optimize keywords, adjust the summary, and highlight relevant experience.',
      null,
      { jobDescriptions: activeJDs }
    );
    
    if (result.changes && Object.keys(result.changes).length > 0) {
      const currentData = store.getData();
      const changeSet = createChangeSet(currentData, result.changes);
      closePanel();
      showDiffView(changeSet);
    } else {
      alert('No changes suggested. Your resume may already be well-tailored!');
    }
  } catch (error) {
    alert('Failed to generate changes: ' + error.message);
  }
}

/**
 * Apply a recommendation from analysis
 */
async function applyRecommendation(index) {
  if (!analysisResults?.recommendations?.[index]) return;
  
  const rec = analysisResults.recommendations[index];
  const path = rec.section;
  const value = rec.suggested;
  
  const currentData = store.getData();
  const changeSet = createChangeSet(currentData, { [path]: value });
  
  closePanel();
  showDiffView(changeSet);
}

/**
 * Open edit modal for a job description
 */
function openEditModal(id) {
  const jd = getJobDescription(id);
  if (!jd) return;
  
  const modal = document.createElement('div');
  modal.className = 'jd-edit-modal-overlay';
  modal.innerHTML = `
    <div class="jd-edit-modal">
      <div class="jd-edit-header">
        <h3>Edit Job Description</h3>
        <button class="jd-edit-close">&times;</button>
      </div>
      <div class="jd-edit-form">
        <input type="text" id="edit-jd-title" class="jd-input" value="${escapeAttr(jd.title)}" placeholder="Job Title">
        <input type="text" id="edit-jd-company" class="jd-input" value="${escapeAttr(jd.company)}" placeholder="Company">
        <textarea id="edit-jd-description" class="jd-textarea" rows="10" placeholder="Job Description">${escapeHtml(jd.description)}</textarea>
        <div class="jd-edit-actions">
          <button class="btn btn-secondary jd-edit-cancel">Cancel</button>
          <button class="btn btn-primary jd-edit-save">Save</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close handlers
  modal.querySelector('.jd-edit-close')?.addEventListener('click', () => modal.remove());
  modal.querySelector('.jd-edit-cancel')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  
  // Save handler
  modal.querySelector('.jd-edit-save')?.addEventListener('click', () => {
    const title = document.getElementById('edit-jd-title')?.value.trim();
    const company = document.getElementById('edit-jd-company')?.value.trim();
    const description = document.getElementById('edit-jd-description')?.value.trim();
    
    if (description) {
      updateJobDescription(id, { title, company, description });
      modal.remove();
      renderContent();
    }
  });
}

/**
 * Format date for display
 */
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 86400000) { // Less than 1 day
    return 'today';
  } else if (diff < 172800000) { // Less than 2 days
    return 'yesterday';
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape for attributes
 */
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
