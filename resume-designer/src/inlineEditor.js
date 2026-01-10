/**
 * Inline Editor
 * Makes resume text editable with contenteditable
 */

import { store } from './store.js';
import { openChatWithContext } from './chatPanel.js';

let isInitialized = false;
let activeElement = null;
let hintDismissed = false;
let hasEditedOnce = false;
let hoveredElement = null;
let aiButton = null;

// Check if hint was previously dismissed
const HINT_DISMISSED_KEY = 'resume-edit-hint-dismissed';

// Initialize inline editing
export function initInlineEditor() {
  if (isInitialized) return;
  isInitialized = true;
  
  // Check localStorage for hint dismissal
  hintDismissed = localStorage.getItem(HINT_DISMISSED_KEY) === 'true';
  
  const resumeContainer = document.getElementById('resume');
  if (!resumeContainer) return;
  
  // Create AI button element
  createAIButton();
  
  // Click handler for editable elements
  resumeContainer.addEventListener('click', handleClick);
  
  // Handle blur to save changes
  resumeContainer.addEventListener('blur', handleBlur, true);
  
  // Handle keydown for special keys
  resumeContainer.addEventListener('keydown', handleKeyDown, true);
  
  // Handle input for real-time feedback
  resumeContainer.addEventListener('input', handleInput, true);
  
  // Handle hover for AI button
  resumeContainer.addEventListener('mouseenter', handleMouseEnter, true);
  resumeContainer.addEventListener('mouseleave', handleMouseLeave, true);
  
  // Setup hint close button
  setupHintDismissal();
  
  // Subscribe to store changes to update edit hints
  store.subscribe((event) => {
    if (event === 'dataLoaded') {
      // Re-initialize hints when data loads
      setTimeout(updateEditableHints, 100);
    }
  });
  
  // Show or hide hint based on previous dismissal
  updateHintVisibility();
}

// Create the AI chat button element
function createAIButton() {
  aiButton = document.createElement('button');
  aiButton.className = 'editable-ai-btn';
  aiButton.title = 'Ask AI about this';
  aiButton.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  `;
  
  // Handle AI button click
  aiButton.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (hoveredElement) {
      const text = hoveredElement.textContent?.trim() || '';
      const path = hoveredElement.dataset.editable || '';
      openChatWithContext(text, path);
    }
  });
  
  // Prevent button from triggering blur
  aiButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

// Handle mouse enter on editable elements
function handleMouseEnter(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable || editable.isContentEditable) return;
  
  // Don't show button if already editing
  if (activeElement) return;
  
  hoveredElement = editable;
  showAIButton(editable);
}

// Handle mouse leave
function handleMouseLeave(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Check if we're leaving to the AI button
  const relatedTarget = e.relatedTarget;
  if (relatedTarget === aiButton || aiButton?.contains(relatedTarget)) {
    return;
  }
  
  hideAIButton();
  hoveredElement = null;
}

// Show the AI button on an element
function showAIButton(element) {
  if (!aiButton || !element) return;
  
  // Append to the element
  element.style.position = 'relative';
  element.appendChild(aiButton);
}

// Hide the AI button
function hideAIButton() {
  if (!aiButton) return;
  aiButton.remove();
}

// Setup hint dismissal functionality
function setupHintDismissal() {
  const hint = document.getElementById('edit-hint');
  if (!hint) return;
  
  // Add close button if not already present
  if (!hint.querySelector('.hint-close-btn')) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'hint-close-btn';
    closeBtn.title = 'Dismiss';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissHintPermanently();
    });
    hint.appendChild(closeBtn);
  }
}

// Dismiss the hint permanently
function dismissHintPermanently() {
  hintDismissed = true;
  localStorage.setItem(HINT_DISMISSED_KEY, 'true');
  updateHintVisibility();
}

// Update hint visibility based on state
function updateHintVisibility() {
  const hint = document.getElementById('edit-hint');
  if (!hint) return;
  
  if (hintDismissed) {
    hint.classList.add('hidden');
  } else {
    hint.classList.remove('hidden');
  }
}

// Handle click on editable elements
function handleClick(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Don't start editing if already editing
  if (editable.isContentEditable) return;
  
  startEditing(editable);
}

// Start editing an element
function startEditing(element) {
  // Deactivate any currently active element
  if (activeElement && activeElement !== element) {
    finishEditing(activeElement);
  }
  
  activeElement = element;
  
  // Make editable
  element.contentEditable = 'true';
  element.classList.add('editing');
  
  // Focus and select all text
  element.focus();
  
  // Select all text for easy replacement
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  
  // Hide edit hint while editing
  document.getElementById('edit-hint')?.classList.add('hidden');
  
  // Mark that user has edited
  if (!hasEditedOnce) {
    hasEditedOnce = true;
  }
}

// Finish editing and save
function finishEditing(element) {
  if (!element || !element.isContentEditable) return;
  
  const path = element.dataset.editable;
  const newValue = element.textContent.trim();
  
  // Handle different types of editable content
  if (path.includes('[') && path.includes('].')) {
    // Array item property (e.g., "experience[0].title")
    store.update(path, newValue);
  } else if (path.startsWith('sections[')) {
    // Section content item
    store.update(path, newValue);
  } else {
    // Simple property
    store.update(path, newValue);
  }
  
  // Remove editing state
  element.contentEditable = 'false';
  element.classList.remove('editing');
  
  if (activeElement === element) {
    activeElement = null;
  }
  
  // Auto-dismiss hint after first successful edit
  if (hasEditedOnce && !hintDismissed) {
    dismissHintPermanently();
  }
}

// Handle blur event
function handleBlur(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Small delay to allow click on another editable
  setTimeout(() => {
    if (activeElement === editable) {
      finishEditing(editable);
    }
  }, 100);
}

// Handle keydown
function handleKeyDown(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable || !editable.isContentEditable) return;
  
  // Enter key finishes editing (except for multiline fields)
  if (e.key === 'Enter' && !e.shiftKey) {
    const isMultiline = editable.dataset.multiline === 'true';
    if (!isMultiline) {
      e.preventDefault();
      finishEditing(editable);
    }
  }
  
  // Escape cancels editing
  if (e.key === 'Escape') {
    e.preventDefault();
    // Restore original value
    const path = editable.dataset.editable;
    const originalValue = store.get(path);
    editable.textContent = originalValue || '';
    finishEditing(editable);
  }
  
  // Tab moves to next editable
  if (e.key === 'Tab') {
    e.preventDefault();
    finishEditing(editable);
    
    const editables = Array.from(
      document.querySelectorAll('[data-editable]')
    );
    const currentIndex = editables.indexOf(editable);
    const nextIndex = e.shiftKey 
      ? (currentIndex - 1 + editables.length) % editables.length
      : (currentIndex + 1) % editables.length;
    
    if (editables[nextIndex]) {
      startEditing(editables[nextIndex]);
    }
  }
}

// Handle input for validation/feedback
function handleInput(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Could add validation here
  // For now, just mark as modified
  editable.classList.add('modified');
}

// Update editable hints (hover effect)
function updateEditableHints() {
  // Nothing needed - CSS handles hover states
}

// Refresh inline editor after DOM update
export function refreshInlineEditor() {
  // Re-select active element if it still exists
  if (activeElement) {
    const path = activeElement.dataset?.editable;
    if (path) {
      const newElement = document.querySelector(`[data-editable="${path}"]`);
      if (newElement && newElement !== activeElement) {
        activeElement = null;
      }
    }
  }
}
