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
import { getConfiguredProviders, getAllModels, isProviderConfigured } from './aiService.js';
import { getSettings, saveVariantAnalysis, getVariantAnalysis } from './persistence.js';
import { createChangeSet } from './diffEngine.js';
import { showDiffView } from './diffView.js';
import { store } from './store.js';
import { getCurrentId } from './headerBar.js';

let panelContainer = null;
let isAnalyzing = false;
let analysisResults = null;
let appliedRecommendations = new Set();
let jobSelectionModal = null;
let selectedJobsForAnalysis = new Set();
let selectedModelForAnalysis = null;
let selectedReasoningForAnalysis = 'medium';
let contentClickListenerAdded = false;
let collapsedCards = new Set(); // Track which cards are collapsed (default: all collapsed)
let allCardsInitialized = false; // Track if we've initialized the collapse state
let showRecentOnly = true; // Show only recent JDs by default
const RECENT_JD_LIMIT = 5; // Number of JDs to show when "recent only" is enabled

/**
 * Initialize job description panel
 */
export function initJobDescriptionPanel() {
  initJobDescriptions();
  createPanel();
}

/**
 * Handle variant change - reload or clear analysis for new variant
 * Called from main.js when user switches resumes
 */
export function onJobPanelVariantChange() {
  const currentVariantId = getCurrentId();
  if (currentVariantId) {
    // Load analysis for the new variant (may be null)
    analysisResults = getVariantAnalysis(currentVariantId);
    appliedRecommendations = new Set();
  } else {
    analysisResults = null;
    appliedRecommendations = new Set();
  }
  
  // If panel is open, re-render to show/hide analysis
  if (panelContainer?.classList.contains('show')) {
    renderContent();
  }
}

/**
 * Create the panel container (hidden by default)
 */
function createPanel() {
  if (document.getElementById('jd-panel-overlay')) return;
  
  // Reset the click listener flag since we're creating a new panel
  contentClickListenerAdded = false;
  
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
  
  // Load analysis results for current variant
  const currentVariantId = getCurrentId();
  if (currentVariantId) {
    analysisResults = getVariantAnalysis(currentVariantId);
  }
  
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
  
  // Initialize all cards as collapsed by default on first render
  if (!allCardsInitialized && jobDescriptions.length > 0) {
    jobDescriptions.forEach(jd => collapsedCards.add(jd.id));
    allCardsInitialized = true;
  }
  
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
        <h3>Your Job Descriptions ${jobDescriptions.length > 0 ? `(${getDisplayedJobDescriptions(jobDescriptions).length}${showRecentOnly && jobDescriptions.length > RECENT_JD_LIMIT ? ` of ${jobDescriptions.length}` : ''})` : ''}</h3>
        <div class="jd-section-actions">
          ${jobDescriptions.length > 1 ? `
            <button class="jd-icon-btn" id="jd-collapse-all" title="Collapse All">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="4 14 10 14 10 20"/>
                <polyline points="20 10 14 10 14 4"/>
                <line x1="14" y1="10" x2="21" y2="3"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
            <button class="jd-icon-btn" id="jd-expand-all" title="Expand All">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
          ` : ''}
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
      
      ${jobDescriptions.length > 0 ? `
        <div class="jd-filter-bar">
          <span class="jd-filter-label">Show:</span>
          <div class="jd-filter-toggle">
            <button class="jd-filter-option ${showRecentOnly ? 'active' : ''}" id="jd-filter-recent">
              Recent (${Math.min(jobDescriptions.length, RECENT_JD_LIMIT)})
            </button>
            <button class="jd-filter-option ${!showRecentOnly ? 'active' : ''}" id="jd-filter-all">
              All (${jobDescriptions.length})
            </button>
          </div>
        </div>
      ` : ''}
      
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
        ` : getDisplayedJobDescriptions(jobDescriptions).map(jd => renderJobDescriptionCard(jd)).join('')}
      </div>
    </div>
    
    ${jobDescriptions.length > 0 ? `
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
          <button class="btn btn-secondary jd-tailor-btn" id="jd-tailor-btn" ${!getConfiguredProviders().length || activeJDs.length === 0 ? 'disabled' : ''}>
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
 * Get job descriptions to display based on recent-only filter
 */
function getDisplayedJobDescriptions(jobDescriptions) {
  if (!showRecentOnly || jobDescriptions.length <= RECENT_JD_LIMIT) {
    return jobDescriptions;
  }
  // Sort by date added (most recent first) and take the limit
  return [...jobDescriptions]
    .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded))
    .slice(0, RECENT_JD_LIMIT);
}

/**
 * Render a single job description card
 */
function renderJobDescriptionCard(jd) {
  const preview = jd.description.length > 150 
    ? jd.description.substring(0, 150) + '...' 
    : jd.description;
  
  const isCollapsed = collapsedCards.has(jd.id);
    
  return `
    <div class="jd-card ${jd.isActive ? 'active' : ''} ${isCollapsed ? 'collapsed' : ''}" data-id="${jd.id}">
      <div class="jd-card-header">
        <button class="jd-card-expand ${isCollapsed ? '' : 'expanded'}" data-id="${jd.id}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
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
 * Get impact priority for sorting (lower = higher priority)
 */
function getImpactPriority(impact) {
  const priorities = { high: 0, medium: 1, low: 2 };
  return priorities[impact] ?? 1; // Default to medium if not specified
}

/**
 * Get impact label for display
 */
function getImpactLabel(impact) {
  const labels = {
    high: 'High Impact',
    medium: 'Medium Impact',
    low: 'Low Impact'
  };
  return labels[impact] || 'Medium Impact';
}

/**
 * Get impact icon SVG
 */
function getImpactIcon(impact) {
  switch (impact) {
    case 'high':
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>`;
    case 'medium':
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>`;
    case 'low':
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M8 12h8"/>
      </svg>`;
    default:
      return '';
  }
}

/**
 * Render a single recommendation card
 */
function renderRecommendationCard(rec, originalIndex) {
  const isApplied = appliedRecommendations.has(originalIndex);
  const impact = rec.impact || 'medium';
  const impactReason = rec.impactReason || '';
  
  return `
    <div class="jd-recommendation ${isApplied ? 'applied' : ''}" data-impact="${impact}">
      <div class="jd-rec-header">
        <div class="jd-rec-header-left">
          <span class="jd-impact-badge ${impact}" title="${escapeHtml(impactReason)}">
            ${getImpactIcon(impact)}
            ${getImpactLabel(impact)}
          </span>
          <span class="jd-rec-section">${escapeHtml(rec.section)}</span>
        </div>
        ${isApplied ? `
          <span class="jd-applied-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Applied
          </span>
        ` : `
          <button class="btn btn-sm jd-apply-rec" data-index="${originalIndex}">Apply</button>
        `}
      </div>
      <div class="jd-rec-content">
        <div class="jd-rec-current">${escapeHtml(rec.current)}</div>
        <div class="jd-rec-arrow">→</div>
        <div class="jd-rec-suggested">${escapeHtml(rec.suggested)}</div>
      </div>
      <p class="jd-rec-reason">${escapeHtml(rec.reason)}</p>
      ${impactReason ? `<p class="jd-rec-impact-reason">${escapeHtml(impactReason)}</p>` : ''}
    </div>
  `;
}

/**
 * Render analysis results
 */
function renderAnalysisResults() {
  if (!analysisResults) return '';
  
  // Sort recommendations by impact and preserve original indices for apply functionality
  const recommendations = (analysisResults.recommendations || [])
    .map((rec, i) => ({ ...rec, originalIndex: i }))
    .sort((a, b) => getImpactPriority(a.impact) - getImpactPriority(b.impact));
  
  // Group recommendations by impact level
  const highImpact = recommendations.filter(r => r.impact === 'high');
  const mediumImpact = recommendations.filter(r => r.impact === 'medium' || !r.impact);
  const lowImpact = recommendations.filter(r => r.impact === 'low');
  
  // Count recommendations by impact
  const impactCounts = {
    high: highImpact.length,
    medium: mediumImpact.length,
    low: lowImpact.length
  };
  
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
      
      ${recommendations.length > 0 ? `
        <div class="jd-results-section jd-recommendations-section">
          <div class="jd-rec-section-header">
            <h4>Recommended Changes</h4>
            <div class="jd-impact-summary">
              ${impactCounts.high > 0 ? `<span class="jd-impact-count high">${impactCounts.high} high</span>` : ''}
              ${impactCounts.medium > 0 ? `<span class="jd-impact-count medium">${impactCounts.medium} medium</span>` : ''}
              ${impactCounts.low > 0 ? `<span class="jd-impact-count low">${impactCounts.low} low</span>` : ''}
            </div>
          </div>
          
          ${highImpact.length > 0 ? `
            <div class="jd-impact-group high">
              <div class="jd-impact-group-header">
                <span class="jd-impact-group-icon">${getImpactIcon('high')}</span>
                <span class="jd-impact-group-label">High Impact Changes</span>
                <span class="jd-impact-group-hint">Address these first for maximum improvement</span>
              </div>
              ${highImpact.map(rec => renderRecommendationCard(rec, rec.originalIndex)).join('')}
            </div>
          ` : ''}
          
          ${mediumImpact.length > 0 ? `
            <div class="jd-impact-group medium">
              <div class="jd-impact-group-header">
                <span class="jd-impact-group-icon">${getImpactIcon('medium')}</span>
                <span class="jd-impact-group-label">Medium Impact Changes</span>
                <span class="jd-impact-group-hint">Important improvements to consider</span>
              </div>
              ${mediumImpact.map(rec => renderRecommendationCard(rec, rec.originalIndex)).join('')}
            </div>
          ` : ''}
          
          ${lowImpact.length > 0 ? `
            <div class="jd-impact-group low">
              <div class="jd-impact-group-header">
                <span class="jd-impact-group-icon">${getImpactIcon('low')}</span>
                <span class="jd-impact-group-label">Low Impact Changes</span>
                <span class="jd-impact-group-hint">Nice-to-have optimizations</span>
              </div>
              ${lowImpact.map(rec => renderRecommendationCard(rec, rec.originalIndex)).join('')}
            </div>
          ` : ''}
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
  
  // Collapse/Expand All buttons
  document.getElementById('jd-collapse-all')?.addEventListener('click', () => {
    const jobDescriptions = getAllJobDescriptions();
    jobDescriptions.forEach(jd => collapsedCards.add(jd.id));
    renderContent();
  });
  
  document.getElementById('jd-expand-all')?.addEventListener('click', () => {
    collapsedCards.clear();
    renderContent();
  });
  
  // Filter toggle buttons
  document.getElementById('jd-filter-recent')?.addEventListener('click', () => {
    showRecentOnly = true;
    renderContent();
  });
  
  document.getElementById('jd-filter-all')?.addEventListener('click', () => {
    showRecentOnly = false;
    renderContent();
  });
  
  // Card actions (delegated) - only add once since content element persists
  if (!contentClickListenerAdded) {
    contentClickListenerAdded = true;
    content.addEventListener('click', handleContentClick);
  }
}

/**
 * Handle clicks on content area (delegated event handler)
 */
function handleContentClick(e) {
  const expandBtn = e.target.closest('.jd-card-expand');
  const toggleBtn = e.target.closest('.jd-card-toggle');
  const editBtn = e.target.closest('.jd-card-edit');
  const deleteBtn = e.target.closest('.jd-card-delete');
  const applyRecBtn = e.target.closest('.jd-apply-rec');
  
  if (expandBtn) {
    const id = expandBtn.dataset.id;
    if (collapsedCards.has(id)) {
      collapsedCards.delete(id);
    } else {
      collapsedCards.add(id);
    }
    renderContent();
  } else if (toggleBtn) {
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
 * Handle analyze - show job selection modal first
 */
function handleAnalyze() {
  const allJDs = getAllJobDescriptions();
  if (allJDs.length === 0) {
    alert('Please add at least one job description');
    return;
  }
  
  // Reset selected model and reasoning to use defaults
  selectedModelForAnalysis = null;
  selectedReasoningForAnalysis = 'medium';
  
  showJobSelectionModal(async (selectedJDs, modelId, reasoningEffort) => {
    await performAnalysis(selectedJDs, modelId, reasoningEffort);
  });
}

/**
 * Show loading overlay during analysis
 */
function showAnalysisLoadingOverlay() {
  // Remove any existing overlay
  hideAnalysisLoadingOverlay();
  
  const overlay = document.createElement('div');
  overlay.className = 'jd-analysis-loading-overlay';
  overlay.id = 'jd-analysis-loading';
  overlay.innerHTML = `
    <div class="jd-analysis-loading-content">
      <div class="jd-analysis-spinner">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
          <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
          </path>
        </svg>
      </div>
      <div class="jd-analysis-loading-text">
        <span class="jd-loading-title">Analyzing Resume Fit</span>
        <span class="jd-loading-subtitle">Comparing your resume against job requirements...</span>
      </div>
      <div class="jd-loading-steps">
        <div class="jd-loading-step active">
          <span class="jd-step-dot"></span>
          <span>Extracting keywords from job description</span>
        </div>
        <div class="jd-loading-step">
          <span class="jd-step-dot"></span>
          <span>Matching skills and experience</span>
        </div>
        <div class="jd-loading-step">
          <span class="jd-step-dot"></span>
          <span>Generating recommendations</span>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Animate through steps
  animateLoadingSteps();
  
  // Show with animation
  requestAnimationFrame(() => {
    overlay.classList.add('show');
  });
}

/**
 * Animate loading steps for visual feedback
 */
function animateLoadingSteps() {
  const steps = document.querySelectorAll('.jd-loading-step');
  if (steps.length === 0) return;
  
  let currentStep = 0;
  const interval = setInterval(() => {
    if (!document.getElementById('jd-analysis-loading')) {
      clearInterval(interval);
      return;
    }
    
    currentStep = (currentStep + 1) % steps.length;
    steps.forEach((step, i) => {
      step.classList.toggle('active', i <= currentStep);
    });
  }, 2000);
}

/**
 * Hide loading overlay
 */
function hideAnalysisLoadingOverlay() {
  const overlay = document.getElementById('jd-analysis-loading');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  }
}

/**
 * Perform the actual analysis with selected job descriptions
 */
async function performAnalysis(selectedJDs, modelId, reasoningEffort) {
  // Use provided model or fall back to default
  if (!modelId) {
    const settings = getSettings();
    modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5';
  }
  
  // Use provided reasoning effort or fall back to medium
  if (!reasoningEffort) {
    reasoningEffort = 'medium';
  }
  
  isAnalyzing = true;
  appliedRecommendations.clear(); // Reset applied state for new analysis
  renderContent();
  
  // Show loading overlay
  showAnalysisLoadingOverlay();
  
  try {
    analysisResults = await analyzeAgainstJobs(modelId, selectedJDs, { reasoningEffort });
    
    // Save analysis results to current variant for persistence
    const currentVariantId = getCurrentId();
    if (currentVariantId && analysisResults) {
      saveVariantAnalysis(currentVariantId, analysisResults);
    }
    
    renderContent();
  } catch (error) {
    alert('Analysis failed: ' + error.message);
    analysisResults = null;
  } finally {
    isAnalyzing = false;
    hideAnalysisLoadingOverlay();
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
  const modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5';
  
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
function applyRecommendation(index) {
  if (!analysisResults?.recommendations?.[index]) return;
  if (appliedRecommendations.has(index)) return; // Already applied
  
  const rec = analysisResults.recommendations[index];
  const suggestedValue = rec.suggested;
  const currentValue = rec.current;
  const sectionName = rec.section?.toLowerCase().trim();
  
  // Try to apply the recommendation
  const success = applyRecommendationToStore(sectionName, currentValue, suggestedValue);
  
  if (success) {
    // Track that this recommendation was applied
    appliedRecommendations.add(index);
    // Re-render to show the applied state
    renderContent();
  } else {
    alert(`Could not automatically apply this recommendation to "${rec.section}". Please make this change manually in the resume editor.`);
  }
}

/**
 * Check if the current value indicates this is a new addition (not a replacement)
 */
function isAddNewRecommendation(currentValue) {
  if (!currentValue) return true;
  const normalized = currentValue.toLowerCase().trim();
  const addNewIndicators = [
    'n/a', 'none', 'add new', 'add', 'new', 'missing', 
    '(none)', '(add)', '(new)', '(missing)',
    'not present', 'not included', 'no current', 'currently missing',
    '-', '--', '...'
  ];
  return addNewIndicators.some(indicator => normalized === indicator || normalized.startsWith(indicator + ' '));
}

/**
 * Try to determine which experience entry to add a bullet to based on section name
 */
function findExperienceIndexFromContext(sectionName, experience) {
  if (!experience || experience.length === 0) return -1;
  
  // Try to find company or role name in the section name
  const sectionLower = sectionName.toLowerCase();
  
  for (let i = 0; i < experience.length; i++) {
    const exp = experience[i];
    const companyLower = (exp.company || '').toLowerCase();
    const titleLower = (exp.title || '').toLowerCase();
    
    // Check if section name contains company or title
    if (companyLower && sectionLower.includes(companyLower)) {
      return i;
    }
    if (titleLower && sectionLower.includes(titleLower)) {
      return i;
    }
  }
  
  // Default to first (most recent) experience if no match
  return 0;
}

/**
 * Find the index of a skills section, matching by section name or type
 */
function findSkillsSectionIndex(sections, sectionName) {
  if (!sections || !Array.isArray(sections)) return -1;
  
  const sectionLower = sectionName.toLowerCase();
  
  // First, try to find exact title match
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower === sectionLower) {
      return i;
    }
  }
  
  // Next, try to find a section whose title is contained in the section name
  // e.g., sectionName "Core Skills" matches section titled "Core Skills"
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower && sectionLower.includes(titleLower)) {
      return i;
    }
  }
  
  // Next, try sections that contain "skill" in the title
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower.includes('skill')) {
      return i;
    }
  }
  
  // Finally, try sections with type 'skills'
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].type === 'skills') {
      return i;
    }
  }
  
  return -1;
}

/**
 * Find the index of any section by matching title
 * Used for generic sections like Highlights, Awards, Certifications, etc.
 */
function findGenericSectionIndex(sections, sectionName) {
  if (!sections || !Array.isArray(sections)) return -1;
  
  const sectionLower = sectionName.toLowerCase();
  
  // First, try exact title match
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower === sectionLower) {
      return i;
    }
  }
  
  // Try to find a section whose title is contained in the section name
  // e.g., sectionName "Highlights" matches section titled "Highlights"
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower && sectionLower.includes(titleLower)) {
      return i;
    }
  }
  
  // Try to find a section whose title contains the section name
  // e.g., sectionName "highlight" matches section titled "Career Highlights"
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower && titleLower.includes(sectionLower)) {
      return i;
    }
  }
  
  return -1;
}

/**
 * Map section name to store path and apply the change
 */
function applyRecommendationToStore(sectionName, currentValue, suggestedValue) {
  const data = store.getData();
  if (!data) return false;
  
  // Check if this is an "add new" recommendation
  const isAddNew = isAddNewRecommendation(currentValue);
  
  // Direct field mappings (simple string fields)
  const directMappings = {
    'summary': 'summary',
    'professional summary': 'summary',
    'objective': 'summary',
    'name': 'name',
    'tagline': 'tagline',
    'title': 'tagline',
    'professional title': 'tagline',
    'tools': 'tools',
    'software': 'tools',
    'tools & software': 'tools'
  };
  
  // Check for direct mapping
  if (directMappings[sectionName]) {
    const path = directMappings[sectionName];
    store.update(path, suggestedValue);
    return true;
  }
  
  // Handle contact fields
  if (sectionName.includes('contact') || sectionName.includes('email') || 
      sectionName.includes('phone') || sectionName.includes('location')) {
    const contactField = findContactField(sectionName, currentValue, data.contact);
    if (contactField) {
      store.update(`contact.${contactField}`, suggestedValue);
      return true;
    }
  }
  
  // Handle experience section
  if (sectionName.includes('experience') || sectionName.includes('work') || 
      sectionName.includes('employment') || sectionName.includes('job') ||
      sectionName.includes('bullet') || sectionName.includes('achievement')) {
    
    // First try to find and replace existing content
    if (!isAddNew) {
      const result = findInExperience(currentValue, data.experience);
      if (result) {
        store.update(result.path, suggestedValue);
        return true;
      }
    }
    
    // If it's an add-new recommendation or we couldn't find the text, add as new bullet
    if (isAddNew || sectionName.includes('bullet') || sectionName.includes('achievement')) {
      const expIndex = findExperienceIndexFromContext(sectionName, data.experience);
      if (expIndex >= 0 && data.experience[expIndex]) {
        const bullets = data.experience[expIndex].bullets || [];
        const newBullets = [...bullets, suggestedValue];
        store.update(`experience[${expIndex}].bullets`, newBullets);
        return true;
      }
    }
  }
  
  // Handle education section
  if (sectionName.includes('education') || sectionName.includes('degree') || 
      sectionName.includes('school')) {
    if (!isAddNew) {
      const eduIndex = findInArray(currentValue, data.education);
      if (eduIndex !== -1) {
        store.update(`education[${eduIndex}]`, suggestedValue);
        return true;
      }
    }
    
    // Add new education entry
    if (isAddNew) {
      const education = data.education || [];
      store.update('education', [...education, suggestedValue]);
      return true;
    }
  }
  
  // Handle skills/sections - match "skill", "skills", "core skills", etc.
  if (sectionName.includes('skill')) {
    // First, find the matching skills section
    const skillsSectionIndex = findSkillsSectionIndex(data.sections, sectionName);
    
    if (!isAddNew && skillsSectionIndex >= 0) {
      // Try to find and replace existing content in the skills section
      const section = data.sections[skillsSectionIndex];
      if (section.content && Array.isArray(section.content)) {
        const normalizedCurrent = normalizeText(currentValue);
        for (let j = 0; j < section.content.length; j++) {
          if (normalizeText(section.content[j]) === normalizedCurrent) {
            store.update(`sections[${skillsSectionIndex}].content[${j}]`, suggestedValue);
            return true;
          }
        }
      }
    }
    
    // If we couldn't find the text to replace, or it's an add-new, add to the skills section
    if (skillsSectionIndex >= 0) {
      const content = data.sections[skillsSectionIndex].content || [];
      store.update(`sections[${skillsSectionIndex}].content`, [...content, suggestedValue]);
      return true;
    }
  }
  
  // Handle any other sidebar section (Highlights, Awards, Certifications, etc.)
  // Try to find a section that matches the recommendation's section name
  if (data.sections && Array.isArray(data.sections)) {
    const sectionIndex = findGenericSectionIndex(data.sections, sectionName);
    
    if (sectionIndex >= 0) {
      const section = data.sections[sectionIndex];
      
      // If not an add-new, try to find and replace existing content
      if (!isAddNew && section.content && Array.isArray(section.content)) {
        const normalizedCurrent = normalizeText(currentValue);
        for (let j = 0; j < section.content.length; j++) {
          if (normalizeText(section.content[j]) === normalizedCurrent) {
            store.update(`sections[${sectionIndex}].content[${j}]`, suggestedValue);
            return true;
          }
        }
      }
      
      // Add new content to the section
      const content = section.content || [];
      store.update(`sections[${sectionIndex}].content`, [...content, suggestedValue]);
      return true;
    }
  }
  
  // Generic search - try to find the current value anywhere
  if (!isAddNew) {
    const genericResult = findTextAnywhere(currentValue, data);
    if (genericResult) {
      store.update(genericResult, suggestedValue);
      return true;
    }
  }
  
  return false;
}

/**
 * Find matching contact field
 */
function findContactField(sectionName, currentValue, contact) {
  if (!contact) return null;
  
  // Try to match by field name in section
  const fieldMap = {
    'email': 'email',
    'phone': 'phone',
    'location': 'location',
    'portfolio': 'portfolio',
    'website': 'portfolio',
    'instagram': 'instagram'
  };
  
  for (const [keyword, field] of Object.entries(fieldMap)) {
    if (sectionName.includes(keyword) && contact[field]) {
      return field;
    }
  }
  
  // Try to match by current value
  for (const [field, value] of Object.entries(contact)) {
    if (value && normalizeText(value) === normalizeText(currentValue)) {
      return field;
    }
  }
  
  return null;
}

/**
 * Find matching text in experience array
 */
function findInExperience(currentValue, experience) {
  if (!experience || !Array.isArray(experience)) return null;
  
  const normalizedCurrent = normalizeText(currentValue);
  
  for (let i = 0; i < experience.length; i++) {
    const exp = experience[i];
    
    // Check title
    if (normalizeText(exp.title) === normalizedCurrent) {
      return { path: `experience[${i}].title` };
    }
    
    // Check company
    if (normalizeText(exp.company) === normalizedCurrent) {
      return { path: `experience[${i}].company` };
    }
    
    // Check bullets
    if (exp.bullets && Array.isArray(exp.bullets)) {
      for (let j = 0; j < exp.bullets.length; j++) {
        if (normalizeText(exp.bullets[j]) === normalizedCurrent) {
          return { path: `experience[${i}].bullets[${j}]` };
        }
      }
    }
  }
  
  return null;
}

/**
 * Find matching text in sections array
 */
function findInSections(currentValue, sections, type = null) {
  if (!sections || !Array.isArray(sections)) return null;
  
  const normalizedCurrent = normalizeText(currentValue);
  
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    
    // Filter by type if specified
    if (type && section.type !== type) continue;
    
    // Check section title
    if (normalizeText(section.title) === normalizedCurrent) {
      return { path: `sections[${i}].title` };
    }
    
    // Check content items
    if (section.content && Array.isArray(section.content)) {
      for (let j = 0; j < section.content.length; j++) {
        if (normalizeText(section.content[j]) === normalizedCurrent) {
          return { path: `sections[${i}].content[${j}]` };
        }
      }
    }
  }
  
  return null;
}

/**
 * Find index in simple array
 */
function findInArray(currentValue, arr) {
  if (!arr || !Array.isArray(arr)) return -1;
  
  const normalizedCurrent = normalizeText(currentValue);
  
  for (let i = 0; i < arr.length; i++) {
    if (normalizeText(arr[i]) === normalizedCurrent) {
      return i;
    }
  }
  
  return -1;
}

/**
 * Generic search for text anywhere in data
 */
function findTextAnywhere(currentValue, data) {
  const normalizedCurrent = normalizeText(currentValue);
  
  // Check simple string fields
  const simpleFields = ['name', 'tagline', 'summary', 'tools'];
  for (const field of simpleFields) {
    if (normalizeText(data[field]) === normalizedCurrent) {
      return field;
    }
  }
  
  // Check contact
  if (data.contact) {
    for (const [field, value] of Object.entries(data.contact)) {
      if (normalizeText(value) === normalizedCurrent) {
        return `contact.${field}`;
      }
    }
  }
  
  // Check experience
  const expResult = findInExperience(currentValue, data.experience);
  if (expResult) return expResult.path;
  
  // Check sections
  const secResult = findInSections(currentValue, data.sections);
  if (secResult) return secResult.path;
  
  // Check education
  const eduIndex = findInArray(currentValue, data.education);
  if (eduIndex !== -1) return `education[${eduIndex}]`;
  
  return null;
}

/**
 * Normalize text for comparison (trim, lowercase, collapse whitespace)
 */
function normalizeText(text) {
  if (!text) return '';
  return String(text).toLowerCase().trim().replace(/\s+/g, ' ');
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
 * Show job selection modal for analysis
 * @param {Function} onConfirm - Callback with selected job descriptions
 */
function showJobSelectionModal(onConfirm) {
  const allJDs = getAllJobDescriptions();
  if (allJDs.length === 0) {
    alert('No job descriptions available. Please add at least one job description.');
    return;
  }

  // Pre-select active job descriptions
  selectedJobsForAnalysis = new Set(
    allJDs.filter(jd => jd.isActive).map(jd => jd.id)
  );

  const modal = document.createElement('div');
  modal.className = 'jd-select-modal-overlay';
  modal.id = 'jd-select-modal';
  modal.innerHTML = renderJobSelectionModalContent(allJDs);
  
  document.body.appendChild(modal);
  jobSelectionModal = modal;

  // Setup event listeners
  setupJobSelectionModalEvents(onConfirm);
  
  // Show with animation
  requestAnimationFrame(() => {
    modal.classList.add('show');
  });
}

/**
 * Get available models for the model selector
 */
function getAvailableModelsForSelector() {
  const allModels = getAllModels();
  const available = [];
  
  // Add models from each configured provider
  for (const [provider, models] of Object.entries(allModels)) {
    if (isProviderConfigured(provider)) {
      for (const model of models) {
        available.push({
          id: model.id,
          label: formatModelName(model.id),
          provider: provider
        });
      }
    }
  }
  
  return available;
}

/**
 * Format model name for display
 */
function formatModelName(modelId) {
  const parts = modelId.split(':');
  if (parts.length !== 2) return modelId;
  
  const provider = parts[0];
  const model = parts[1];
  
  // Format provider name
  const providerNames = {
    'anthropic': 'Anthropic',
    'openai': 'OpenAI',
    'gemini': 'Google'
  };
  
  // Format model name (capitalize, clean up)
  const modelName = model
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  
  return `${providerNames[provider] || provider} ${modelName}`;
}

/**
 * Render job selection modal content
 */
function renderJobSelectionModalContent(jobDescriptions) {
  const selectedCount = selectedJobsForAnalysis.size;
  const availableModels = getAvailableModelsForSelector();
  const settings = getSettings();
  const defaultModel = selectedModelForAnalysis || settings.defaultModel || 'anthropic:claude-sonnet-4-5';
  
  return `
    <div class="jd-select-modal">
      <div class="jd-select-header">
        <h3>Analyze Resume Fit</h3>
        <button class="jd-select-close" id="jd-select-close">&times;</button>
      </div>
      <div class="jd-select-body">
        <div class="jd-ai-options">
          <div class="jd-model-selector">
            <label for="jd-model-select">Model</label>
            <select id="jd-model-select" class="jd-model-select">
              ${availableModels.map(m => `
                <option value="${m.id}" ${m.id === defaultModel ? 'selected' : ''}>
                  ${escapeHtml(m.label)}
                </option>
              `).join('')}
            </select>
          </div>
          
          <div class="jd-reasoning-selector">
            <label for="jd-reasoning-select">Reasoning</label>
            <select id="jd-reasoning-select" class="jd-reasoning-select">
              <option value="none" ${selectedReasoningForAnalysis === 'none' ? 'selected' : ''}>Off</option>
              <option value="low" ${selectedReasoningForAnalysis === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${selectedReasoningForAnalysis === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${selectedReasoningForAnalysis === 'high' ? 'selected' : ''}>High</option>
            </select>
          </div>
        </div>
        
        <div class="jd-select-section-label">Select Job Description(s)</div>
        <div class="jd-select-info">
          <span class="jd-select-count">${selectedCount} selected</span>
          <div class="jd-select-actions-header">
            <button class="jd-select-all-btn" id="jd-select-all">Select All</button>
            <button class="jd-select-none-btn" id="jd-select-none">Clear</button>
          </div>
        </div>
        <div class="jd-select-list">
          ${jobDescriptions.map(jd => renderJobSelectionItem(jd)).join('')}
        </div>
      </div>
      <div class="jd-select-footer">
        <button class="btn btn-secondary" id="jd-select-cancel">Cancel</button>
        <button class="btn btn-primary" id="jd-select-confirm" ${selectedCount === 0 ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Analyze${selectedCount > 0 ? ` (${selectedCount})` : ''}
        </button>
      </div>
    </div>
  `;
}

/**
 * Render a single job selection item
 */
function renderJobSelectionItem(jd) {
  const isSelected = selectedJobsForAnalysis.has(jd.id);
  const preview = jd.description.length > 100 
    ? jd.description.substring(0, 100) + '...' 
    : jd.description;
    
  return `
    <label class="jd-select-item ${isSelected ? 'selected' : ''}" data-id="${jd.id}">
      <input type="checkbox" class="jd-select-checkbox" data-id="${jd.id}" ${isSelected ? 'checked' : ''}>
      <div class="jd-select-item-content">
        <div class="jd-select-item-header">
          <span class="jd-select-item-title">${escapeHtml(jd.title)}</span>
          <span class="jd-select-item-company">${escapeHtml(jd.company)}</span>
        </div>
        <p class="jd-select-item-preview">${escapeHtml(preview)}</p>
      </div>
    </label>
  `;
}

/**
 * Setup event listeners for job selection modal
 */
function setupJobSelectionModalEvents(onConfirm) {
  const modal = document.getElementById('jd-select-modal');
  if (!modal) return;

  // Close button
  modal.querySelector('#jd-select-close')?.addEventListener('click', closeJobSelectionModal);
  
  // Cancel button
  modal.querySelector('#jd-select-cancel')?.addEventListener('click', closeJobSelectionModal);
  
  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeJobSelectionModal();
    }
  });

  // Checkbox changes
  modal.querySelectorAll('.jd-select-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        selectedJobsForAnalysis.add(id);
      } else {
        selectedJobsForAnalysis.delete(id);
      }
      updateJobSelectionModal();
    });
  });

  // Select all
  modal.querySelector('#jd-select-all')?.addEventListener('click', () => {
    const allJDs = getAllJobDescriptions();
    selectedJobsForAnalysis = new Set(allJDs.map(jd => jd.id));
    updateJobSelectionModal();
  });

  // Clear selection
  modal.querySelector('#jd-select-none')?.addEventListener('click', () => {
    selectedJobsForAnalysis.clear();
    updateJobSelectionModal();
  });

  // Model selector change
  modal.querySelector('#jd-model-select')?.addEventListener('change', (e) => {
    selectedModelForAnalysis = e.target.value;
  });
  
  // Initialize selected model from dropdown
  const modelSelect = modal.querySelector('#jd-model-select');
  if (modelSelect) {
    selectedModelForAnalysis = modelSelect.value;
  }
  
  // Reasoning selector change
  modal.querySelector('#jd-reasoning-select')?.addEventListener('change', (e) => {
    selectedReasoningForAnalysis = e.target.value;
  });
  
  // Initialize selected reasoning from dropdown
  const reasoningSelect = modal.querySelector('#jd-reasoning-select');
  if (reasoningSelect) {
    selectedReasoningForAnalysis = reasoningSelect.value;
  }

  // Confirm button
  modal.querySelector('#jd-select-confirm')?.addEventListener('click', () => {
    if (selectedJobsForAnalysis.size === 0) {
      return;
    }
    const selectedJDs = getAllJobDescriptions().filter(jd => selectedJobsForAnalysis.has(jd.id));
    const modelId = selectedModelForAnalysis;
    const reasoningEffort = selectedReasoningForAnalysis;
    closeJobSelectionModal();
    onConfirm(selectedJDs, modelId, reasoningEffort);
  });

  // ESC to close
  const escHandler = (e) => {
    if (e.key === 'Escape' && jobSelectionModal) {
      closeJobSelectionModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

/**
 * Update job selection modal state
 */
function updateJobSelectionModal() {
  const modal = document.getElementById('jd-select-modal');
  if (!modal) return;

  const selectedCount = selectedJobsForAnalysis.size;

  // Update count display
  const countEl = modal.querySelector('.jd-select-count');
  if (countEl) {
    countEl.textContent = `${selectedCount} selected`;
  }

  // Update confirm button
  const confirmBtn = modal.querySelector('#jd-select-confirm');
  if (confirmBtn) {
    confirmBtn.disabled = selectedCount === 0;
    confirmBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Analyze${selectedCount > 0 ? ` (${selectedCount})` : ''}
    `;
  }

  // Update checkbox states and item styling
  modal.querySelectorAll('.jd-select-item').forEach(item => {
    const id = item.dataset.id;
    const checkbox = item.querySelector('.jd-select-checkbox');
    const isSelected = selectedJobsForAnalysis.has(id);
    
    if (checkbox) {
      checkbox.checked = isSelected;
    }
    item.classList.toggle('selected', isSelected);
  });
}

/**
 * Close job selection modal
 */
function closeJobSelectionModal() {
  const modal = document.getElementById('jd-select-modal');
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => {
      modal.remove();
      jobSelectionModal = null;
    }, 200);
  }
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
