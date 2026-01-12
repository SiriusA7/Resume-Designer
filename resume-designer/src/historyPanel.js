/**
 * History Panel
 * Visual timeline view of resume changes with restore functionality
 */

import { store, CHANGE_TYPES } from './store.js';
import { diffResumeData } from './diffEngine.js';
import { showDiffView } from './diffView.js';
import { createChangeSet } from './diffEngine.js';

let panelContainer = null;
let isOpen = false;

/**
 * Initialize history panel
 */
export function initHistoryPanel() {
  createPanel();
  
  // Subscribe to history changes
  store.subscribe((event) => {
    if (event === 'historyChanged' && isOpen) {
      renderEntries();
    }
  });
}

/**
 * Create panel container
 */
function createPanel() {
  if (document.getElementById('history-panel-overlay')) return;
  
  const html = `
    <div class="history-panel-overlay" id="history-panel-overlay">
      <div class="history-panel">
        <div class="history-panel-header">
          <h2>Version History</h2>
          <button class="history-panel-close" id="history-panel-close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        
        <div class="history-panel-content" id="history-panel-content">
          <!-- Timeline rendered here -->
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', html);
  panelContainer = document.getElementById('history-panel-overlay');
  
  // Close button
  document.getElementById('history-panel-close')?.addEventListener('click', closeHistoryPanel);
  
  // Click outside to close
  panelContainer?.addEventListener('click', (e) => {
    if (e.target === panelContainer) {
      closeHistoryPanel();
    }
  });
  
  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      closeHistoryPanel();
    }
  });
}

/**
 * Open history panel
 */
export function openHistoryPanel() {
  createPanel();
  renderEntries();
  panelContainer?.classList.add('show');
  document.body.style.overflow = 'hidden';
  isOpen = true;
}

/**
 * Close history panel
 */
export function closeHistoryPanel() {
  panelContainer?.classList.remove('show');
  document.body.style.overflow = '';
  isOpen = false;
}

/**
 * Render history entries
 */
function renderEntries() {
  const content = document.getElementById('history-panel-content');
  if (!content) return;
  
  const entries = store.getHistoryEntries();
  const currentIndex = store.getHistoryIndex();
  
  if (entries.length === 0) {
    content.innerHTML = `
      <div class="history-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <p>No history yet</p>
        <span>Changes will appear here as you edit</span>
      </div>
    `;
    return;
  }
  
  // Reverse entries so newest is at top
  const reversedEntries = [...entries].reverse();
  
  content.innerHTML = `
    <div class="history-timeline">
      ${reversedEntries.map((entry, reverseIndex) => {
        const originalIndex = entries.length - 1 - reverseIndex;
        const isCurrent = originalIndex === currentIndex;
        const isLatest = reverseIndex === 0;
        
        return `
          <div class="history-entry ${isCurrent ? 'current' : ''} ${isLatest ? 'latest' : ''}" data-index="${originalIndex}">
            <div class="history-entry-marker">
              <div class="history-marker-dot ${getChangeTypeClass(entry.changeType)}"></div>
              ${!isLatest ? '<div class="history-marker-line"></div>' : ''}
            </div>
            <div class="history-entry-content">
              <div class="history-entry-header">
                <span class="history-entry-type ${getChangeTypeClass(entry.changeType)}">
                  ${getChangeTypeIcon(entry.changeType)}
                  ${getChangeTypeLabel(entry.changeType)}
                </span>
                <span class="history-entry-time">${formatTime(entry.timestamp)}</span>
              </div>
              <p class="history-entry-description">${escapeHtml(entry.description)}</p>
              <div class="history-entry-actions">
                ${!isCurrent ? `
                  <button class="history-action-btn history-restore-btn" data-index="${originalIndex}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                      <path d="M3 3v5h5"/>
                    </svg>
                    Restore
                  </button>
                  <button class="history-action-btn history-compare-btn" data-index="${originalIndex}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="7" height="18" rx="1"/>
                      <rect x="14" y="3" width="7" height="18" rx="1"/>
                    </svg>
                    Compare
                  </button>
                ` : `
                  <span class="history-current-label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Current version
                  </span>
                `}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  
  // Add event listeners
  content.querySelectorAll('.history-restore-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      handleRestore(index);
    });
  });
  
  content.querySelectorAll('.history-compare-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      handleCompare(index);
    });
  });
}

/**
 * Handle restore action
 */
function handleRestore(index) {
  if (confirm('Restore to this version? Your current changes will be saved in history.')) {
    store.restoreToEntry(index);
    renderEntries();
  }
}

/**
 * Handle compare action - show diff between selected version and current
 */
function handleCompare(index) {
  const selectedData = store.getHistoryEntryData(index);
  const currentData = store.getData();
  
  if (!selectedData || !currentData) return;
  
  // Create a change set showing differences
  const changes = diffResumeData(selectedData, currentData);
  
  if (changes.length === 0) {
    alert('No differences found between these versions.');
    return;
  }
  
  // Create a pseudo change set for viewing
  const changeSet = {
    currentData: selectedData,
    proposedData: currentData,
    changes,
    getSummary() {
      const added = changes.filter(c => c.type === 'add').length;
      const removed = changes.filter(c => c.type === 'remove').length;
      const modified = changes.filter(c => c.type === 'modify').length;
      return { added, removed, modified, total: changes.length };
    }
  };
  
  closeHistoryPanel();
  showDiffView(changeSet);
}

/**
 * Get CSS class for change type
 */
function getChangeTypeClass(type) {
  switch (type) {
    case CHANGE_TYPES.AI: return 'type-ai';
    case CHANGE_TYPES.IMPORT: return 'type-import';
    case CHANGE_TYPES.ADD: return 'type-add';
    case CHANGE_TYPES.REMOVE: return 'type-remove';
    case CHANGE_TYPES.REORDER: return 'type-reorder';
    case CHANGE_TYPES.INITIAL: return 'type-initial';
    default: return 'type-edit';
  }
}

/**
 * Get icon for change type
 */
function getChangeTypeIcon(type) {
  switch (type) {
    case CHANGE_TYPES.AI:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>`;
    case CHANGE_TYPES.IMPORT:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>`;
    case CHANGE_TYPES.ADD:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="16"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>`;
    case CHANGE_TYPES.REMOVE:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>`;
    case CHANGE_TYPES.REORDER:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <polyline points="19 12 12 19 5 12"/>
      </svg>`;
    case CHANGE_TYPES.INITIAL:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>`;
    default:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>`;
  }
}

/**
 * Get label for change type
 */
function getChangeTypeLabel(type) {
  switch (type) {
    case CHANGE_TYPES.AI: return 'AI Change';
    case CHANGE_TYPES.IMPORT: return 'Import';
    case CHANGE_TYPES.ADD: return 'Added';
    case CHANGE_TYPES.REMOVE: return 'Removed';
    case CHANGE_TYPES.REORDER: return 'Reordered';
    case CHANGE_TYPES.INITIAL: return 'Created';
    default: return 'Edit';
  }
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }
  
  // Less than 1 hour
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins}m ago`;
  }
  
  // Less than 1 day
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }
  
  // Less than 7 days
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }
  
  // Format as date
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
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
