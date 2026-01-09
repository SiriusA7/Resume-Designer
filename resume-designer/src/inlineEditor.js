/**
 * Inline Editor
 * Makes resume text editable with contenteditable
 */

import { store } from './store.js';

let isInitialized = false;
let activeElement = null;

// Initialize inline editing
export function initInlineEditor() {
  if (isInitialized) return;
  isInitialized = true;
  
  const resumeContainer = document.getElementById('resume');
  if (!resumeContainer) return;
  
  // Click handler for editable elements
  resumeContainer.addEventListener('click', handleClick);
  
  // Handle blur to save changes
  resumeContainer.addEventListener('blur', handleBlur, true);
  
  // Handle keydown for special keys
  resumeContainer.addEventListener('keydown', handleKeyDown, true);
  
  // Handle input for real-time feedback
  resumeContainer.addEventListener('input', handleInput, true);
  
  // Subscribe to store changes to update edit hints
  store.subscribe((event) => {
    if (event === 'dataLoaded') {
      // Re-initialize hints when data loads
      setTimeout(updateEditableHints, 100);
    }
  });
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
  
  // Hide edit hint
  document.getElementById('edit-hint')?.classList.add('hidden');
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
  
  // Show edit hint again
  document.getElementById('edit-hint')?.classList.remove('hidden');
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
