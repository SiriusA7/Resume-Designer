/**
 * Inline Editor
 * Makes resume text editable with contenteditable
 */

import { store } from './store.js';
import { openChatWithContext, addContextChip } from './chatPanel.js';
import { getPendingChange, applyInlineChange, rejectInlineChange, isInlineChangesActive, getCurrentChangeSet, getOriginalContent } from './inlineChanges.js';
import { getPathLabel, DIFF_TYPES } from './diffEngine.js';
import { showDiffView } from './diffView.js';

let isInitialized = false;
let activeElement = null;
let hintDismissed = false;
let hasEditedOnce = false;
let hoveredElement = null;
let aiButton = null;
let aiMenu = null;
let hideButtonTimeout = null;
let isMenuVisible = false;

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
  
  // Handle hover for AI button using mouseover/mouseout for better stability
  resumeContainer.addEventListener('mouseover', handleMouseOver, true);
  resumeContainer.addEventListener('mouseout', handleMouseOut, true);
  
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

// Create the AI chat button element with dropdown menu
function createAIButton() {
  // Create container for the button - append to body with fixed positioning
  // This prevents DOM changes to editable elements which cause layout shifts
  const container = document.createElement('div');
  container.className = 'editable-ai-container';
  container.id = 'editable-ai-container';
  
  aiButton = document.createElement('button');
  aiButton.className = 'editable-ai-btn';
  aiButton.title = 'Add to AI context';
  aiButton.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  `;
  
  // Create dropdown menu - append to body to escape stacking context
  aiMenu = document.createElement('div');
  aiMenu.className = 'editable-ai-menu';
  aiMenu.id = 'editable-ai-menu';
  document.body.appendChild(aiMenu);
  
  container.appendChild(aiButton);
  // Append container to body (not to editable elements) to prevent layout shifts
  document.body.appendChild(container);
  
  // Handle AI button click - show menu
  aiButton.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (hoveredElement) {
      showAIMenu(hoveredElement);
    }
  });
  
  // Prevent button from triggering blur or text selection
  aiButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  
  // Prevent container clicks from reaching elements behind
  container.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  
  container.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  // Prevent menu clicks from reaching elements behind
  aiMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  
  aiMenu.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault(); // Prevent text selection
  });
  
  // Store container reference
  aiButton.container = container;
}

// Track the element the menu was opened for
let menuTargetElement = null;

// Show AI context menu with relevant options
function showAIMenu(element) {
  if (!aiMenu) return;
  
  isMenuVisible = true;
  menuTargetElement = element; // Track which element opened the menu
  
  const path = element.dataset.editable || element.dataset.changePath || '';
  const text = element.textContent?.trim() || '';
  
  // Check if this element has pending AI changes
  const pendingChange = getPendingChange(path);
  
  let menuContent = '';
  
  if (pendingChange) {
    // Show apply/reject/review options for pending changes
    // Get original content to show what's being replaced
    const originalContent = getOriginalContent(path);
    
    menuContent = `
      ${originalContent ? `
        <div class="editable-ai-menu-preview compact original">
          <div class="preview-label">Was:</div>
          <div class="preview-content">${escapeHtml(truncateText(originalContent, 100))}</div>
        </div>
      ` : ''}
      <div class="editable-ai-menu-actions">
        <button class="editable-ai-menu-item apply-btn" data-action="apply-change" data-path="${path}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Apply</span>
        </button>
        <button class="editable-ai-menu-item reject-btn" data-action="reject-change" data-path="${path}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          <span>Reject</span>
        </button>
        <button class="editable-ai-menu-item review-btn" data-action="review-all">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7"/>
            <rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/>
            <rect x="3" y="14" width="7" height="7"/>
          </svg>
          <span>Review All</span>
        </button>
      </div>
    `;
  } else {
    // Show normal AI context options
    const contextOptions = getContextOptions(element, path, text);
    menuContent = contextOptions.map(opt => {
      if (opt.action === 'separator') {
        return `<div class="editable-ai-menu-separator">${opt.label}</div>`;
      }
      return `
        <button class="editable-ai-menu-item" data-action="${opt.action}" data-type="${opt.type}" data-path="${opt.path || ''}">
          ${opt.icon}
          <span>${opt.label}</span>
        </button>
      `;
    }).join('');
  }
  
  aiMenu.innerHTML = menuContent;
  
  // Add click handlers
  aiMenu.querySelectorAll('.editable-ai-menu-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      
      const action = btn.dataset.action;
      const actionPath = btn.dataset.path;
      
      if (action === 'apply-change') {
        applyInlineChange(actionPath);
      } else if (action === 'reject-change') {
        rejectInlineChange(actionPath);
      } else if (action === 'review-all') {
        // Open the full diff review view
        const changeSet = getCurrentChangeSet();
        if (changeSet) {
          showDiffView(changeSet);
        }
      } else {
        handleContextAction(action, btn.dataset.type, actionPath, element);
      }
      
      hideAIMenu();
      hideAIButton();
      hoveredElement = null;
      menuTargetElement = null;
    });
    
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });
  
  // Position the menu using fixed coordinates (escape stacking context)
  const btnRect = aiButton.getBoundingClientRect();
  aiMenu.style.top = `${btnRect.bottom + 4}px`;
  aiMenu.style.left = `${Math.max(10, btnRect.right - 200)}px`; // Align right edge with button, min 10px from left
  
  aiMenu.classList.add('visible');
  
  // Close menu when clicking outside
  setTimeout(() => {
    document.addEventListener('click', closeMenuOnClickOutside);
  }, 10);
}

// Helper to truncate text
function truncateText(text, maxLength) {
  if (!text) return '';
  text = String(text);
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

// Helper to escape HTML
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function closeMenuOnClickOutside(e) {
  const container = aiButton?.container;
  const menuEl = document.getElementById('editable-ai-menu');
  
  // Don't close if clicking within the menu or container
  if (menuEl?.contains(e.target) || container?.contains(e.target)) {
    return;
  }
  
  hideAIMenu();
  document.removeEventListener('click', closeMenuOnClickOutside);
  menuTargetElement = null;
  
  // Also hide the button after menu closes if not hovering
  setTimeout(() => {
    if (!hoveredElement || !hoveredElement.matches(':hover')) {
      hideAIButton();
      hoveredElement = null;
    }
  }, 100);
}

// Hide AI menu
function hideAIMenu() {
  isMenuVisible = false;
  if (aiMenu) {
    aiMenu.classList.remove('visible');
    aiMenu.style.top = '';
    aiMenu.style.left = '';
  }
}

// Get context options based on the element
function getContextOptions(element, path, text) {
  const options = [];
  const data = store.getData();
  
  // Add "Ask AI to improve" option first - most common action
  options.push({
    action: 'chat',
    type: 'text',
    path: path,
    label: 'Ask AI to improve this',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
    </svg>`
  });
  
  // Add section header for context options
  options.push({
    action: 'separator',
    label: 'Add context for AI:',
    icon: ''
  });
  
  // Always show "Add this text" option
  options.push({
    action: 'add',
    type: 'text',
    path: path,
    label: 'Add this text',
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>`
  });
  
  // Check if this is a bullet point
  const bulletMatch = path.match(/experience\[(\d+)\]\.bullets\[(\d+)\]/);
  if (bulletMatch) {
    const expIndex = parseInt(bulletMatch[1]);
    const exp = data?.experience?.[expIndex];
    
    // Add "All bullets" option
    if (exp?.bullets && exp.bullets.length > 1) {
      options.push({
        action: 'add',
        type: 'bullets',
        path: `experience[${expIndex}].bullets`,
        label: 'Add all bullets',
        icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6"/>
          <line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/>
          <circle cx="4" cy="6" r="1" fill="currentColor"/>
          <circle cx="4" cy="12" r="1" fill="currentColor"/>
          <circle cx="4" cy="18" r="1" fill="currentColor"/>
        </svg>`
      });
    }
    
    // Add "Entire experience entry" option
    options.push({
      action: 'add',
      type: 'experience',
      path: `experience[${expIndex}]`,
      label: 'Add entire job',
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
      </svg>`
    });
  }
  
  // Check if this is an experience field (title, company, dates)
  const expFieldMatch = path.match(/experience\[(\d+)\]\.(title|company|dates)/);
  if (expFieldMatch) {
    const expIndex = parseInt(expFieldMatch[1]);
    
    options.push({
      action: 'add',
      type: 'experience',
      path: `experience[${expIndex}]`,
      label: 'Add entire job',
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
      </svg>`
    });
  }
  
  // Check if this is a section item
  const sectionMatch = path.match(/sections\[(\d+)\]\.content\[(\d+)\]/);
  if (sectionMatch) {
    const sectionIndex = parseInt(sectionMatch[1]);
    const section = data?.sections?.[sectionIndex];
    
    if (section?.content && section.content.length > 1) {
      options.push({
        action: 'add',
        type: 'section',
        path: `sections[${sectionIndex}]`,
        label: `Add entire ${section.title || 'section'}`,
        icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
        </svg>`
      });
    }
  }
  
  // Add "All Experience" option if in experience section
  if (path.includes('experience[') && data?.experience?.length > 1) {
    options.push({
      action: 'add',
      type: 'all-experience',
      path: 'experience',
      label: 'Add all experience',
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>`
    });
  }
  
  return options;
}

// Handle context action
function handleContextAction(action, type, path, element) {
  const data = store.getData();
  let content = '';
  let label = '';
  
  switch (type) {
    case 'text':
      content = element.textContent?.trim() || '';
      label = content.length > 40 ? content.substring(0, 40) + '...' : content;
      break;
      
    case 'bullets': {
      const match = path.match(/experience\[(\d+)\]/);
      if (match) {
        const exp = data?.experience?.[parseInt(match[1])];
        if (exp?.bullets) {
          content = exp.bullets.map((b, i) => `• ${b}`).join('\n');
          label = `Bullets: ${exp.title}`;
        }
      }
      break;
    }
    
    case 'experience': {
      const match = path.match(/experience\[(\d+)\]/);
      if (match) {
        const exp = data?.experience?.[parseInt(match[1])];
        if (exp) {
          content = formatExperienceEntry(exp);
          label = `${exp.title} @ ${exp.company}`;
        }
      }
      break;
    }
    
    case 'section': {
      const match = path.match(/sections\[(\d+)\]/);
      if (match) {
        const section = data?.sections?.[parseInt(match[1])];
        if (section) {
          content = formatSection(section);
          label = section.title;
        }
      }
      break;
    }
    
    case 'all-experience':
      if (data?.experience) {
        content = data.experience.map(exp => formatExperienceEntry(exp)).join('\n\n---\n\n');
        label = 'All Experience';
      }
      break;
  }
  
  if (action === 'chat') {
    openChatWithContext(content, path, type);
  } else if (action === 'add' && content) {
    // Just add the context chip, don't open chat
    addContextChip({
      type: type,
      path: path,
      content: content,
      label: label
    });
    
    // Open the chat panel to show the chip was added
    const panel = document.getElementById('chat-panel');
    if (panel?.classList.contains('closed')) {
      document.getElementById('toggle-chat-panel')?.click();
    }
  }
}

// Format an experience entry as text
function formatExperienceEntry(exp) {
  let text = `${exp.title} at ${exp.company}\n${exp.dates}\n`;
  if (exp.bullets && exp.bullets.length > 0) {
    text += '\n' + exp.bullets.map(b => `• ${b}`).join('\n');
  }
  return text;
}

// Format a section as text
function formatSection(section) {
  let text = `${section.title}:\n`;
  if (Array.isArray(section.content)) {
    if (section.type === 'list' || section.type === 'highlights') {
      text += section.content.map(item => `• ${item}`).join('\n');
    } else {
      text += section.content.join(' • ');
    }
  }
  return text;
}

// Handle mouse over on editable elements
function handleMouseOver(e) {
  // Clear any pending hide timeout
  if (hideButtonTimeout) {
    clearTimeout(hideButtonTimeout);
    hideButtonTimeout = null;
  }
  
  const editable = e.target.closest('[data-editable]');
  if (!editable || editable.isContentEditable) return;
  
  // Don't show button if already editing
  if (activeElement) return;
  
  // Don't change anything if menu is visible - keep showing for original element
  if (isMenuVisible && menuTargetElement) return;
  
  // Don't re-show if we're already showing for this element
  if (hoveredElement === editable) return;
  
  hoveredElement = editable;
  showAIButton(editable);
}

// Handle mouse out
function handleMouseOut(e) {
  const editable = e.target.closest('[data-editable]');
  if (!editable) return;
  
  // Check if we're moving to the AI button/menu container or staying within the same editable
  const relatedTarget = e.relatedTarget;
  const container = aiButton?.container;
  
  // If moving to the AI button container, menu, or staying within the editable, don't hide
  if (relatedTarget && (
    relatedTarget === container ||
    container?.contains(relatedTarget) ||
    relatedTarget === aiMenu ||
    aiMenu?.contains(relatedTarget) ||
    editable.contains(relatedTarget)
  )) {
    return;
  }
  
  // If menu is visible, don't hide
  if (isMenuVisible) {
    return;
  }
  
  // Use a small delay to prevent flickering
  hideButtonTimeout = setTimeout(() => {
    if (!isMenuVisible) {
      hideAIButton();
      hoveredElement = null;
    }
  }, 100);
}

// Show the AI button on an element
function showAIButton(element) {
  if (!aiButton || !element) return;
  
  const container = aiButton.container || aiButton;
  
  // Check if element has pending change and update button appearance
  const hasChange = element.dataset.hasChange;
  if (hasChange) {
    aiButton.classList.add('has-change', `change-${hasChange}`);
    aiButton.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    `;
  } else {
    aiButton.classList.remove('has-change', 'change-add', 'change-remove', 'change-modify');
    aiButton.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    `;
  }
  
  // Position the container using fixed positioning (no DOM changes to element)
  const rect = element.getBoundingClientRect();
  container.style.top = `${rect.top - 8}px`;
  container.style.left = `${rect.right - 8}px`;
  container.classList.add('visible');
}

// Hide the AI button
function hideAIButton() {
  if (!aiButton) return;
  
  const container = aiButton.container || aiButton;
  container.classList.remove('visible');
  hideAIMenu();
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
  // Don't start editing if clicking on the AI container/menu
  if (e.target.closest('.editable-ai-container') || e.target.closest('.editable-ai-menu')) {
    return;
  }
  
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
  
  // Hide AI button when editing
  hideAIButton();
  hideAIMenu();
  hoveredElement = null;
  
  activeElement = element;
  
  const path = element.dataset.editable;
  if (path) {
    const sourceValue = store.get(path);
    if (typeof sourceValue === 'string') {
      element.textContent = sourceValue;
    } else if (sourceValue === null || sourceValue === undefined) {
      element.textContent = '';
    } else {
      element.textContent = String(sourceValue);
    }
  }

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
  
  // Extract value, handling special cases for skill tags and highlight bullets
  let newValue = extractEditedValue(element, path);
  
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

// Extract the edited value, preserving format for special content types
function extractEditedValue(element, path) {
  // Check for skill tags (rendered as separate spans that need to be joined with •)
  const skillTags = element.querySelectorAll('.skill-tag, .skill-tag-inline');
  if (skillTags.length > 0) {
    // Multiple skill tags - join with bullet separator
    return Array.from(skillTags).map(tag => tag.textContent.trim()).filter(t => t).join(' • ');
  }
  
  // Check for highlight bullets (need to restore the "- " prefix)
  const highlightBullets = element.querySelectorAll('.highlight-bullet');
  if (highlightBullets.length > 0) {
    const serialized = Array.from(highlightBullets).map((bulletEl) => {
      const content = bulletEl.textContent.trim();
      const strongTags = bulletEl.querySelectorAll('strong');
      const italicTags = bulletEl.querySelectorAll('em');
      const underlineTags = bulletEl.querySelectorAll('u');
      let result = content;
      strongTags.forEach((strong) => {
        const boldText = strong.textContent;
        result = result.replace(boldText, `**${boldText}**`);
      });
      italicTags.forEach((italic) => {
        const italicText = italic.textContent;
        result = result.replace(italicText, `_${italicText}_`);
      });
      underlineTags.forEach((underline) => {
        const underlineText = underline.textContent;
        result = result.replace(underlineText, `++${underlineText}++`);
      });
      return result ? `- ${result}` : '';
    }).filter(Boolean);

    return serialized.join(' • ');
  }
  
  // For tools field, also check for skill tags
  if (path === 'tools') {
    const toolTags = element.querySelectorAll('.skill-tag');
    if (toolTags.length > 0) {
      return Array.from(toolTags).map(tag => tag.textContent.trim()).filter(t => t).join(' • ');
    }
  }
  
  // Default: just use textContent
  return element.textContent.trim();
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

  const modKey = e.metaKey || e.ctrlKey;
  if (modKey && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleBoldInEditable(editable);
    return;
  }
  
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

function toggleBoldInEditable(editable) {
  // Skip structural rich text nodes that are reconstructed by specialized extractors.
  if (editable.querySelector('.skill-tag, .skill-tag-inline, .highlight-bullet')) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return;

  const start = getTextOffset(editable, range.startContainer, range.startOffset);
  const end = getTextOffset(editable, range.endContainer, range.endOffset);
  const result = toggleBoldMarkdown(editable.textContent || '', start, end);

  editable.textContent = result.value;
  setSelectionInEditable(editable, result.start, result.end);
}

function getTextOffset(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function setSelectionInEditable(editable, start, end) {
  const selection = window.getSelection();
  if (!selection) return;

  const textNode = editable.firstChild || editable.appendChild(document.createTextNode(''));
  const maxLen = textNode.textContent?.length || 0;
  const safeStart = Math.max(0, Math.min(start, maxLen));
  const safeEnd = Math.max(0, Math.min(end, maxLen));

  const range = document.createRange();
  range.setStart(textNode, safeStart);
  range.setEnd(textNode, safeEnd);
  selection.removeAllRanges();
  selection.addRange(range);
}

function toggleBoldMarkdown(value, start, end) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const selected = value.slice(selectionStart, selectionEnd);

  if (selectionStart === selectionEnd) {
    const hasOuterBold = selectionStart >= 2 &&
      value.slice(selectionStart - 2, selectionStart) === '**' &&
      value.slice(selectionStart, selectionStart + 2) === '**';

    if (hasOuterBold) {
      const nextValue = value.slice(0, selectionStart - 2) + value.slice(selectionStart + 2);
      return { value: nextValue, start: selectionStart - 2, end: selectionStart - 2 };
    }

    const nextValue = value.slice(0, selectionStart) + '****' + value.slice(selectionStart);
    return { value: nextValue, start: selectionStart + 2, end: selectionStart + 2 };
  }

  if (selected.startsWith('**') && selected.endsWith('**') && selected.length >= 4) {
    const unwrapped = selected.slice(2, -2);
    const nextValue = value.slice(0, selectionStart) + unwrapped + value.slice(selectionEnd);
    return { value: nextValue, start: selectionStart, end: selectionStart + unwrapped.length };
  }

  const hasOuterBold = selectionStart >= 2 &&
    value.slice(selectionStart - 2, selectionStart) === '**' &&
    value.slice(selectionEnd, selectionEnd + 2) === '**';

  if (hasOuterBold) {
    const nextValue = value.slice(0, selectionStart - 2) + selected + value.slice(selectionEnd + 2);
    return { value: nextValue, start: selectionStart - 2, end: selectionEnd - 2 };
  }

  const nextValue = value.slice(0, selectionStart) + `**${selected}**` + value.slice(selectionEnd);
  return { value: nextValue, start: selectionStart + 2, end: selectionEnd + 2 };
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

export function getActiveInlineEditable() {
  return activeElement && document.contains(activeElement) ? activeElement : null;
}
