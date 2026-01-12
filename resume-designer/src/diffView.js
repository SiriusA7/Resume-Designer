/**
 * Diff View Component
 * Displays proposed changes with side-by-side or inline view modes
 */

import { DIFF_TYPES, getPathLabel } from './diffEngine.js';
import { store } from './store.js';

let diffViewContainer = null;
let currentChangeSet = null;
let viewMode = 'side-by-side'; // 'inline' or 'side-by-side' - default to side-by-side
let onApplyCallback = null;
let appliedChanges = new Set();

/**
 * Initialize the diff view
 * @param {Function} onApply - Callback when changes are applied
 */
export function initDiffView(onApply) {
  onApplyCallback = onApply;
  createDiffViewContainer();
  setupKeyboardShortcuts();
}

/**
 * Create the diff view container element
 */
function createDiffViewContainer() {
  if (document.getElementById('diff-view-overlay')) return;
  
  const html = `
    <div class="diff-view-overlay" id="diff-view-overlay">
      <div class="diff-view-panel">
        <div class="diff-view-header">
          <div class="diff-view-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v18M3 12h18"/>
            </svg>
            <h2>Review Changes</h2>
            <span class="diff-view-summary" id="diff-summary"></span>
          </div>
          <div class="diff-view-controls">
            <div class="diff-view-mode-toggle">
              <button class="diff-mode-btn" data-mode="inline" title="Inline view">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="3" y1="6" x2="21" y2="6"/>
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              </button>
              <button class="diff-mode-btn active" data-mode="side-by-side" title="Side by side view">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="7" height="18" rx="1"/>
                  <rect x="14" y="3" width="7" height="18" rx="1"/>
                </svg>
              </button>
            </div>
            <button class="diff-view-close" id="diff-view-close" title="Close (Esc)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        
        <div class="diff-view-content" id="diff-view-content">
          <!-- Changes rendered here -->
        </div>
        
        <div class="diff-view-footer">
          <div class="diff-view-hints">
            <span class="diff-hint"><kbd>A</kbd> Apply</span>
            <span class="diff-hint"><kbd>R</kbd> Reject</span>
            <span class="diff-hint"><kbd>Enter</kbd> Apply All</span>
            <span class="diff-hint"><kbd>Esc</kbd> Close</span>
          </div>
          <div class="diff-view-actions">
            <button class="btn btn-secondary" id="diff-reject-all">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              Reject All
            </button>
            <button class="btn btn-primary" id="diff-apply-all">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Apply All Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', html);
  diffViewContainer = document.getElementById('diff-view-overlay');
  
  setupEventListeners();
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  // Close button
  document.getElementById('diff-view-close')?.addEventListener('click', closeDiffView);
  
  // Click outside to close
  diffViewContainer?.addEventListener('click', (e) => {
    if (e.target === diffViewContainer) {
      closeDiffView();
    }
  });
  
  // View mode toggle
  document.querySelectorAll('.diff-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      setViewMode(mode);
    });
  });
  
  // Apply/Reject all buttons
  document.getElementById('diff-apply-all')?.addEventListener('click', applyAllChanges);
  document.getElementById('diff-reject-all')?.addEventListener('click', closeDiffView);
  
  // Delegated event listeners for individual change buttons
  document.getElementById('diff-view-content')?.addEventListener('click', (e) => {
    const applyBtn = e.target.closest('.diff-apply-btn');
    const rejectBtn = e.target.closest('.diff-reject-btn');
    
    if (applyBtn) {
      const path = applyBtn.dataset.path;
      applyChange(path);
    }
    
    if (rejectBtn) {
      const path = rejectBtn.dataset.path;
      rejectChange(path);
    }
  });
}

/**
 * Set up keyboard shortcuts
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!diffViewContainer?.classList.contains('show')) return;
    
    // Don't intercept if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    switch (e.key) {
      case 'Escape':
        closeDiffView();
        break;
      case 'Enter':
        if (!e.shiftKey) {
          e.preventDefault();
          applyAllChanges();
        }
        break;
      case 'a':
      case 'A':
        if (!e.ctrlKey && !e.metaKey) {
          applyNextChange();
        }
        break;
      case 'r':
      case 'R':
        if (!e.ctrlKey && !e.metaKey) {
          rejectNextChange();
        }
        break;
    }
  });
}

/**
 * Show the diff view with a change set
 * @param {Object} changeSet - Change set from diffEngine
 */
export function showDiffView(changeSet) {
  currentChangeSet = changeSet;
  appliedChanges.clear();
  
  createDiffViewContainer();
  renderChanges();
  updateSummary();
  
  diffViewContainer.classList.add('show');
  document.body.style.overflow = 'hidden';
}

/**
 * Close the diff view
 */
export function closeDiffView() {
  if (diffViewContainer) {
    diffViewContainer.classList.remove('show');
    document.body.style.overflow = '';
    currentChangeSet = null;
    appliedChanges.clear();
  }
}

/**
 * Set the view mode
 * @param {string} mode - 'inline' or 'side-by-side'
 */
function setViewMode(mode) {
  viewMode = mode;
  
  // Update button states
  document.querySelectorAll('.diff-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  
  renderChanges();
}

/**
 * Render all changes
 */
function renderChanges() {
  const content = document.getElementById('diff-view-content');
  if (!content || !currentChangeSet) return;
  
  const { changes } = currentChangeSet;
  
  if (changes.length === 0) {
    content.innerHTML = `
      <div class="diff-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 12l2 2 4-4"/>
        </svg>
        <p>No changes to review</p>
      </div>
    `;
    return;
  }
  
  const html = changes.map((change, index) => 
    renderChange(change, index)
  ).join('');
  
  content.innerHTML = html;
  content.className = `diff-view-content ${viewMode === 'side-by-side' ? 'side-by-side-mode' : 'inline-mode'}`;
}

/**
 * Render a single change
 * @param {Object} change - Change object
 * @param {number} index - Change index
 * @returns {string} HTML string
 */
function renderChange(change, index) {
  const isApplied = appliedChanges.has(change.path);
  const label = getPathLabel(change.path);
  
  const typeClass = change.type === DIFF_TYPES.ADD ? 'diff-type-add' :
                    change.type === DIFF_TYPES.REMOVE ? 'diff-type-remove' :
                    'diff-type-modify';
  
  const typeLabel = change.type === DIFF_TYPES.ADD ? 'Added' :
                    change.type === DIFF_TYPES.REMOVE ? 'Removed' :
                    'Modified';
  
  if (viewMode === 'side-by-side') {
    return renderSideBySideChange(change, index, label, typeClass, typeLabel, isApplied);
  }
  
  return renderInlineChange(change, index, label, typeClass, typeLabel, isApplied);
}

/**
 * Render change in inline mode
 */
function renderInlineChange(change, index, label, typeClass, typeLabel, isApplied) {
  let contentHtml;
  
  if (change.wordDiff) {
    // Use word-level diff for text changes
    contentHtml = renderWordDiff(change.wordDiff);
  } else if (change.type === DIFF_TYPES.ADD) {
    contentHtml = `<span class="diff-addition">${escapeHtml(change.displayNew)}</span>`;
  } else if (change.type === DIFF_TYPES.REMOVE) {
    contentHtml = `<span class="diff-deletion">${escapeHtml(change.displayOld)}</span>`;
  } else {
    // Modified without word diff
    contentHtml = `
      <span class="diff-deletion">${escapeHtml(change.displayOld)}</span>
      <span class="diff-arrow">→</span>
      <span class="diff-addition">${escapeHtml(change.displayNew)}</span>
    `;
  }
  
  return `
    <div class="diff-change ${typeClass} ${isApplied ? 'applied' : ''}" data-path="${change.path}" data-index="${index}">
      <div class="diff-change-header">
        <div class="diff-change-info">
          <span class="diff-change-label">${escapeHtml(label)}</span>
          <span class="diff-change-type">${typeLabel}</span>
        </div>
        <div class="diff-change-actions">
          ${!isApplied ? `
            <button class="diff-apply-btn" data-path="${change.path}" title="Apply (A)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Apply
            </button>
            <button class="diff-reject-btn" data-path="${change.path}" title="Reject (R)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          ` : `
            <span class="diff-applied-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Applied
            </span>
          `}
        </div>
      </div>
      <div class="diff-change-content">
        ${contentHtml}
      </div>
    </div>
  `;
}

/**
 * Render change in side-by-side mode
 */
function renderSideBySideChange(change, index, label, typeClass, typeLabel, isApplied) {
  // For modifications with word diff, render highlighted versions on each side
  let oldContent, newContent;
  
  if (change.wordDiff && change.type === DIFF_TYPES.MODIFY) {
    // Render old side: show unchanged and removed parts
    oldContent = change.wordDiff.map(part => {
      if (part.type === DIFF_TYPES.ADD) {
        return ''; // Don't show additions on old side
      } else if (part.type === DIFF_TYPES.REMOVE) {
        return `<span class="diff-deletion">${escapeHtml(part.value)}</span>`;
      }
      return escapeHtml(part.value);
    }).join('');
    
    // Render new side: show unchanged and added parts
    newContent = change.wordDiff.map(part => {
      if (part.type === DIFF_TYPES.REMOVE) {
        return ''; // Don't show removals on new side
      } else if (part.type === DIFF_TYPES.ADD) {
        return `<span class="diff-addition">${escapeHtml(part.value)}</span>`;
      }
      return escapeHtml(part.value);
    }).join('');
  } else {
    // No word diff - just show the values
    oldContent = change.displayOld ? escapeHtml(change.displayOld) : '<span class="diff-empty-value">(empty)</span>';
    newContent = change.displayNew ? escapeHtml(change.displayNew) : '<span class="diff-empty-value">(empty)</span>';
    
    // Apply background colors for add/remove
    if (change.type === DIFF_TYPES.REMOVE) {
      oldContent = `<span class="diff-deletion-text">${oldContent}</span>`;
    } else if (change.type === DIFF_TYPES.ADD) {
      newContent = `<span class="diff-addition-text">${newContent}</span>`;
    }
  }
  
  return `
    <div class="diff-change ${typeClass} ${isApplied ? 'applied' : ''}" data-path="${change.path}" data-index="${index}">
      <div class="diff-change-header">
        <div class="diff-change-info">
          <span class="diff-change-label">${escapeHtml(label)}</span>
          <span class="diff-change-type">${typeLabel}</span>
        </div>
        <div class="diff-change-actions">
          ${!isApplied ? `
            <button class="diff-apply-btn" data-path="${change.path}" title="Apply (A)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Apply
            </button>
            <button class="diff-reject-btn" data-path="${change.path}" title="Reject (R)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          ` : `
            <span class="diff-applied-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Applied
            </span>
          `}
        </div>
      </div>
      <div class="diff-change-content side-by-side">
        <div class="diff-side diff-old">
          <div class="diff-side-label">Current</div>
          <div class="diff-side-content ${change.type === DIFF_TYPES.REMOVE ? 'diff-deletion-bg' : ''}">
            ${oldContent}
          </div>
        </div>
        <div class="diff-side diff-new">
          <div class="diff-side-label">Proposed</div>
          <div class="diff-side-content ${change.type === DIFF_TYPES.ADD ? 'diff-addition-bg' : ''}">
            ${newContent}
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render word-level diff
 * @param {Array} wordDiff - Word diff array
 * @returns {string} HTML string
 */
function renderWordDiff(wordDiff) {
  return wordDiff.map(part => {
    if (part.type === DIFF_TYPES.ADD) {
      return `<span class="diff-addition">${escapeHtml(part.value)}</span>`;
    } else if (part.type === DIFF_TYPES.REMOVE) {
      return `<span class="diff-deletion">${escapeHtml(part.value)}</span>`;
    }
    return escapeHtml(part.value);
  }).join('');
}

/**
 * Update the summary display
 */
function updateSummary() {
  const summary = document.getElementById('diff-summary');
  if (!summary || !currentChangeSet) return;
  
  const stats = currentChangeSet.getSummary();
  const remaining = stats.total - appliedChanges.size;
  
  summary.innerHTML = `
    <span class="diff-stat diff-stat-add">+${stats.added}</span>
    <span class="diff-stat diff-stat-remove">-${stats.removed}</span>
    <span class="diff-stat diff-stat-modify">~${stats.modified}</span>
    ${appliedChanges.size > 0 ? `<span class="diff-stat diff-stat-applied">${appliedChanges.size} applied</span>` : ''}
  `;
}

/**
 * Apply a single change
 * @param {string} path - Path of change to apply
 */
function applyChange(path) {
  if (!currentChangeSet || appliedChanges.has(path)) return;
  
  const change = currentChangeSet.changes.find(c => c.path === path);
  if (!change) return;
  
  // Apply to store
  if (change.type === DIFF_TYPES.REMOVE) {
    // Handle removal - need to use removeFromArray for array items
    const arrayMatch = path.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      store.removeFromArray(arrayMatch[1], parseInt(arrayMatch[2]));
    } else {
      store.update(path, undefined);
    }
  } else {
    store.update(path, change.newValue);
  }
  
  appliedChanges.add(path);
  
  // Update UI
  const changeEl = document.querySelector(`.diff-change[data-path="${path}"]`);
  if (changeEl) {
    changeEl.classList.add('applied');
    const actionsEl = changeEl.querySelector('.diff-change-actions');
    if (actionsEl) {
      actionsEl.innerHTML = `
        <span class="diff-applied-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Applied
        </span>
      `;
    }
  }
  
  updateSummary();
  
  // Callback
  if (onApplyCallback) {
    onApplyCallback();
  }
  
  // Check if all changes applied
  if (appliedChanges.size === currentChangeSet.changes.length) {
    setTimeout(() => closeDiffView(), 500);
  }
}

/**
 * Reject a single change (remove from view)
 * @param {string} path - Path of change to reject
 */
function rejectChange(path) {
  const changeEl = document.querySelector(`.diff-change[data-path="${path}"]`);
  if (changeEl) {
    changeEl.classList.add('rejected');
    setTimeout(() => {
      changeEl.remove();
      
      // Check if no more changes
      const remaining = document.querySelectorAll('.diff-change:not(.rejected)');
      if (remaining.length === 0) {
        closeDiffView();
      }
    }, 300);
  }
}

/**
 * Apply the next unapplied change
 */
function applyNextChange() {
  if (!currentChangeSet) return;
  
  const nextChange = currentChangeSet.changes.find(c => !appliedChanges.has(c.path));
  if (nextChange) {
    applyChange(nextChange.path);
  }
}

/**
 * Reject the next change
 */
function rejectNextChange() {
  if (!currentChangeSet) return;
  
  const nextChange = currentChangeSet.changes.find(c => !appliedChanges.has(c.path));
  if (nextChange) {
    rejectChange(nextChange.path);
  }
}

/**
 * Apply all remaining changes
 */
function applyAllChanges() {
  if (!currentChangeSet) return;
  
  for (const change of currentChangeSet.changes) {
    if (!appliedChanges.has(change.path)) {
      applyChange(change.path);
    }
  }
}

/**
 * Escape HTML special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

/**
 * Check if diff view is currently open
 * @returns {boolean}
 */
export function isDiffViewOpen() {
  return diffViewContainer?.classList.contains('show') || false;
}
