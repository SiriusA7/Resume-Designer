/**
 * Inline Changes Module
 * Highlights proposed AI changes directly on the resume preview
 */

import { store } from './store.js';
import { DIFF_TYPES, getPathLabel } from './diffEngine.js';

let currentChangeSet = null;
let appliedChanges = new Set();
let highlightElements = new Map();
let isActive = false;

/**
 * Initialize inline changes functionality
 */
export function initInlineChanges() {
  // Add styles for inline changes
  addInlineStyles();
}

/**
 * Show inline changes on the resume
 * @param {Object} changeSet - Change set from diffEngine
 */
export function showInlineChanges(changeSet) {
  currentChangeSet = changeSet;
  appliedChanges.clear();
  highlightElements.clear();
  isActive = true;
  
  // Show inline changes banner
  showChangesBanner();
  
  // Highlight each change on the resume
  for (const change of changeSet.changes) {
    highlightChange(change);
  }
  
  // Add global event listener for apply/reject
  document.addEventListener('click', handleInlineAction);
}

/**
 * Hide all inline changes
 */
export function hideInlineChanges() {
  isActive = false;
  currentChangeSet = null;
  appliedChanges.clear();
  
  // Remove all data attributes from elements and restore original content
  highlightElements.forEach(({ element, originalContent }) => {
    if (element) {
      // Restore original content if it was changed
      if (originalContent !== undefined) {
        element.textContent = originalContent;
      }
      delete element.dataset.hasChange;
      delete element.dataset.changePath;
    }
  });
  highlightElements.clear();
  
  // Remove banner
  document.getElementById('inline-changes-banner')?.remove();
  
  // Remove event listener
  document.removeEventListener('click', handleInlineAction);
}

/**
 * Check if inline changes are active
 */
export function isInlineChangesActive() {
  return isActive;
}

/**
 * Get the pending change for a given path
 */
export function getPendingChange(path) {
  if (!currentChangeSet) return null;
  return currentChangeSet.changes.find(c => c.path === path) || null;
}

/**
 * Get all pending changes
 */
export function getAllPendingChanges() {
  return currentChangeSet?.changes || [];
}

/**
 * Get the current change set (for opening full diff view)
 */
export function getCurrentChangeSet() {
  return currentChangeSet;
}

/**
 * Get the original content for a given path (before AI proposed changes)
 */
export function getOriginalContent(path) {
  const highlightData = highlightElements.get(path);
  return highlightData?.originalContent;
}

/**
 * Show the changes banner at top of resume area
 */
function showChangesBanner() {
  // Remove existing banner
  document.getElementById('inline-changes-banner')?.remove();
  
  const stats = currentChangeSet.getSummary();
  const banner = document.createElement('div');
  banner.id = 'inline-changes-banner';
  banner.className = 'inline-changes-banner';
  banner.innerHTML = `
    <div class="inline-changes-banner-content">
      <div class="inline-changes-banner-info">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 3v18M3 12h18"/>
        </svg>
        <span class="inline-changes-banner-title">AI Proposed Changes</span>
        <span class="inline-changes-stat inline-changes-stat-add">+${stats.added}</span>
        <span class="inline-changes-stat inline-changes-stat-remove">-${stats.removed}</span>
        <span class="inline-changes-stat inline-changes-stat-modify">~${stats.modified}</span>
      </div>
      <div class="inline-changes-banner-actions">
        <button class="inline-changes-apply-all" id="inline-apply-all">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Apply All
        </button>
        <button class="inline-changes-reject-all" id="inline-reject-all">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          Dismiss
        </button>
        <button class="inline-changes-review" id="inline-open-review">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          Full Review
        </button>
      </div>
    </div>
  `;
  
  // Insert at top of preview area
  const previewArea = document.querySelector('.preview-area');
  if (previewArea) {
    previewArea.insertBefore(banner, previewArea.firstChild);
  }
}

/**
 * Highlight a change on the resume (show proposed text with visual indicator)
 */
function highlightChange(change) {
  // Find the element that corresponds to this change path
  const element = findElementByPath(change.path);
  if (!element) {
    // Log available editable elements for debugging
    const editables = document.querySelectorAll('[data-editable]');
    console.warn('Could not find element for path:', change.path);
    console.log('Available editable paths:', Array.from(editables).map(e => e.dataset.editable));
    return;
  }
  
  // Add data attribute to element for CSS styling
  const changeType = change.type === DIFF_TYPES.ADD ? 'add' :
                     change.type === DIFF_TYPES.REMOVE ? 'remove' : 'modify';
  element.dataset.hasChange = changeType;
  element.dataset.changePath = change.path;
  
  // Store original content and show proposed content
  const originalContent = element.textContent;
  let proposedContent = originalContent;
  
  if (change.type === DIFF_TYPES.MODIFY && change.newValue !== undefined) {
    proposedContent = String(change.newValue);
    element.textContent = proposedContent;
  } else if (change.type === DIFF_TYPES.ADD && change.newValue !== undefined) {
    proposedContent = String(change.newValue);
    element.textContent = proposedContent;
  }
  // For REMOVE type, keep showing original (it will be removed if applied)
  
  // Store reference for cleanup, including original content for restoration
  highlightElements.set(change.path, { 
    element, 
    originalContent,
    proposedContent
  });
}

/**
 * Find DOM element by data path
 */
function findElementByPath(path) {
  // Try to find by data-editable attribute (used by inline editor)
  let element = document.querySelector(`[data-editable="${path}"]`);
  if (element) return element;
  
  // Try to find by data-field attribute
  element = document.querySelector(`[data-field="${path}"]`);
  if (element) return element;
  
  // Handle array paths like experience[0].title or sections[0].content[1]
  const arrayMatch = path.match(/^(\w+)\[(\d+)\]\.?(.*)$/);
  if (arrayMatch) {
    const [, arrayName, index, rest] = arrayMatch;
    
    // Try data-editable first
    element = document.querySelector(`[data-editable="${path}"]`);
    if (element) return element;
    
    // For nested paths like sections[0].content[1], try to build the selector
    if (rest) {
      // Try partial path matching
      element = document.querySelector(`[data-editable^="${arrayName}[${index}]"]`);
      if (element) return element;
    }
  }
  
  // Try common class-based selectors as fallback
  const pathMappings = {
    'name': '.resume-name, .header-name, h1.name',
    'tagline': '.resume-tagline, .header-tagline, .tagline',
    'title': '.resume-title, .header-title',
    'summary': '.summary-text, .resume-summary, .summary p',
    'email': '.contact-email, .email',
    'phone': '.contact-phone, .phone',
    'location': '.contact-location, .location'
  };
  
  if (pathMappings[path]) {
    element = document.querySelector(pathMappings[path]);
    if (element) return element;
  }
  
  return element;
}

// No need for badges - we'll use the hover UI from inlineEditor instead

/**
 * Handle inline action button clicks
 */
function handleInlineAction(e) {
  // Apply single change
  const applyBtn = e.target.closest('.inline-change-apply');
  if (applyBtn) {
    const path = applyBtn.dataset.path;
    applyInlineChange(path);
    return;
  }
  
  // Reject single change
  const rejectBtn = e.target.closest('.inline-change-reject');
  if (rejectBtn) {
    const path = rejectBtn.dataset.path;
    rejectInlineChange(path);
    return;
  }
  
  // Apply all
  if (e.target.closest('#inline-apply-all')) {
    applyAllInlineChanges();
    return;
  }
  
  // Reject all
  if (e.target.closest('#inline-reject-all')) {
    hideInlineChanges();
    return;
  }
  
  // Open full review
  if (e.target.closest('#inline-open-review')) {
    // Import dynamically to avoid circular deps
    import('./diffView.js').then(({ showDiffView }) => {
      showDiffView(currentChangeSet);
    });
    return;
  }
}

/**
 * Apply a single inline change
 */
export function applyInlineChange(path) {
  if (!currentChangeSet || appliedChanges.has(path)) return;
  
  const change = currentChangeSet.changes.find(c => c.path === path);
  if (!change) return;
  
  // Apply to store
  if (change.type === DIFF_TYPES.REMOVE) {
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
  
  // Update UI - remove data attributes
  const highlightData = highlightElements.get(path);
  if (highlightData?.element) {
    delete highlightData.element.dataset.hasChange;
    delete highlightData.element.dataset.changePath;
  }
  highlightElements.delete(path);
  
  // Check if all changes applied
  if (appliedChanges.size === currentChangeSet.changes.length) {
    setTimeout(() => hideInlineChanges(), 500);
  }
  
  updateBannerStats();
}

/**
 * Reject a single inline change
 */
export function rejectInlineChange(path) {
  const highlightData = highlightElements.get(path);
  if (highlightData?.element) {
    // Restore original content
    if (highlightData.originalContent !== undefined) {
      highlightData.element.textContent = highlightData.originalContent;
    }
    delete highlightData.element.dataset.hasChange;
    delete highlightData.element.dataset.changePath;
  }
  highlightElements.delete(path);
  
  // Remove from changeset
  if (currentChangeSet) {
    currentChangeSet.changes = currentChangeSet.changes.filter(c => c.path !== path);
  }
  
  // Check if no more changes
  if (highlightElements.size === 0) {
    hideInlineChanges();
  }
  
  updateBannerStats();
}

/**
 * Apply all remaining inline changes
 */
function applyAllInlineChanges() {
  if (!currentChangeSet) return;
  
  for (const change of currentChangeSet.changes) {
    if (!appliedChanges.has(change.path)) {
      applyInlineChange(change.path);
    }
  }
}

/**
 * Update banner statistics
 */
function updateBannerStats() {
  const banner = document.getElementById('inline-changes-banner');
  if (!banner || !currentChangeSet) return;
  
  const remaining = currentChangeSet.changes.length - appliedChanges.size;
  if (remaining === 0) {
    hideInlineChanges();
  }
}

/**
 * Add CSS styles for inline changes
 */
function addInlineStyles() {
  if (document.getElementById('inline-changes-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'inline-changes-styles';
  style.textContent = `
    /* Inline Changes Banner */
    .inline-changes-banner {
      position: sticky;
      top: 0;
      z-index: 100;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-light));
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      margin-bottom: 16px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    
    .inline-changes-banner-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    
    .inline-changes-banner-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .inline-changes-banner-title {
      font-weight: 600;
      font-size: 14px;
    }
    
    .inline-changes-stat {
      font-size: 12px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.2);
    }
    
    .inline-changes-stat-add { color: #bbf7d0; }
    .inline-changes-stat-remove { color: #fecaca; }
    .inline-changes-stat-modify { color: #bfdbfe; }
    
    .inline-changes-banner-actions {
      display: flex;
      gap: 8px;
    }
    
    .inline-changes-banner-actions button {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .inline-changes-apply-all {
      background: white;
      color: var(--color-accent);
      border: none;
    }
    
    .inline-changes-apply-all:hover {
      background: #f0fdf4;
    }
    
    .inline-changes-reject-all {
      background: rgba(255, 255, 255, 0.2);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    
    .inline-changes-reject-all:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    
    .inline-changes-review {
      background: rgba(255, 255, 255, 0.2);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    
    .inline-changes-review:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    
    /* Element with pending change - visual highlight only */
    [data-has-change] {
      position: relative;
      transition: all 0.2s;
      border-radius: 4px;
      z-index: 1; /* Lower z-index so popup appears above */
    }
    
    [data-has-change="add"] {
      box-shadow: inset 0 0 0 2px #22c55e;
      background: rgba(34, 197, 94, 0.1) !important;
    }
    
    [data-has-change="remove"] {
      box-shadow: inset 0 0 0 2px #ef4444;
      background: rgba(239, 68, 68, 0.1) !important;
    }
    
    [data-has-change="modify"] {
      box-shadow: inset 0 0 0 2px #3b82f6;
      background: rgba(59, 130, 246, 0.1) !important;
    }
    
    /* Pulsing animation to draw attention */
    @keyframes pulse-highlight {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    
    [data-has-change] {
      animation: pulse-highlight 2s ease-in-out infinite;
    }
    
    [data-has-change]:hover {
      animation: none;
      opacity: 1;
    }
  `;
  
  document.head.appendChild(style);
}

/**
 * Truncate text
 */
function truncate(str, maxLength) {
  if (!str || str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
