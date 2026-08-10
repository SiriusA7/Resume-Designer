/**
 * Inline Editor
 * Makes resume text editable with contenteditable
 */

import { store } from './store.js';
import { openChatWithContext, addContextChip } from './chatPanel.js';
import { getPendingChange, applyInlineChange, rejectInlineChange, getCurrentChangeSet, getOriginalContent } from './inlineChanges.js';
import { showDiffView } from './diffView.js';
import { appStorage } from './appStorage.js';

let isInitialized = false;
let activeElement = null;
let hintDismissed = false;
let hasEditedOnce = false;
let hoveredElement = null;
let aiButton = null;
let aiMenu = null;
let hideButtonTimeout = null;
let isMenuVisible = false;
let resumeScroller = null;

// True while the month-range picker is open. The AI button is fixed-position
// like the picker, so without this it paints over the panel when the pointer
// crosses the resume on its way there.
let dateEditorOpen = false;

// Check if hint was previously dismissed
const HINT_DISMISSED_KEY = 'resume-edit-hint-dismissed';

// Initialize inline editing
export function initInlineEditor() {
  if (isInitialized) return;
  isInitialized = true;
  
  // Check storage for hint dismissal
  hintDismissed = appStorage.getItem(HINT_DISMISSED_KEY) === 'true';
  
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
  window.addEventListener('rd:date-editor-closed', () => { dateEditorOpen = false; });

  // Hide the (fixed-position) AI button when the resume scrolls or the window
  // resizes — otherwise it orphans at a stale coordinate, floating over other UI.
  resumeScroller = resumeContainer.closest('.resume-scroller');
  resumeScroller?.addEventListener('scroll', handleResumeScroll, { passive: true });
  window.addEventListener('scroll', handleResumeScroll, { passive: true });
  window.addEventListener('resize', handleResumeScroll, { passive: true });

  // Escape dismisses a stuck button/menu.
  document.addEventListener('keydown', handleEditorKeydown);
  
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

  // Keep the button alive while the pointer is on it (it lives at body level, so
  // the resume's mouseout fires when the cursor crosses onto it); hide once the
  // pointer leaves the button itself and no menu is open.
  container.addEventListener('mouseenter', () => {
    if (hideButtonTimeout) { clearTimeout(hideButtonTimeout); hideButtonTimeout = null; }
  });
  container.addEventListener('mouseleave', () => {
    if (!isMenuVisible) scheduleHideButton();
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

    // The pending change may live at a CONTAINER path above the hovered node
    // (whole-item add/remove, e.g. hovering `experience[1].title` while the
    // change is at `experience[1]`). Apply/Reject must act on the change's own
    // path — that is the key the session tracks and applyChangeToStore splices
    // or writes by.
    const actionPath = pendingChange.path;

    menuContent = `
      ${originalContent ? `
        <div class="editable-ai-menu-preview compact original">
          <div class="preview-label">Was:</div>
          <div class="preview-content">${escapeHtml(truncateText(originalContent, 100))}</div>
        </div>
      ` : ''}
      <div class="editable-ai-menu-actions">
        <button class="editable-ai-menu-item apply-btn" data-action="apply-change" data-path="${actionPath}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Apply</span>
        </button>
        <button class="editable-ai-menu-item reject-btn" data-action="reject-change" data-path="${actionPath}">
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
  
  // Menu dismissed by an outside click — hide the button too. If the pointer is
  // still over the text, the next mouseover re-shows it (no unreliable :hover
  // probe, which was the source of stuck buttons after the menu closed).
  hideAIButton();
  hoveredElement = null;
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
function getContextOptions(element, path, _text) {
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
          content = exp.bullets.map((b, _i) => `• ${b}`).join('\n');
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
  scheduleHideButton();
}

// Hide the button after a short grace period unless a menu is open. Shared by
// mouseout, the button's own mouseleave, and (immediately) scroll/Escape.
function scheduleHideButton() {
  if (hideButtonTimeout) clearTimeout(hideButtonTimeout);
  hideButtonTimeout = setTimeout(() => {
    if (!isMenuVisible) {
      hideAIButton();
      hoveredElement = null;
    }
  }, 150);
}

// The button/menu use fixed positioning, so a scroll or resize leaves them at a
// stale coordinate over unrelated UI — hide immediately; the next hover re-shows.
function handleResumeScroll() {
  // The picker is anchored to a rect captured at click time, so a scroll leaves
  // it floating over unrelated content. Close it, the way the AI button hides.
  if (dateEditorOpen) window.dispatchEvent(new Event('rd:close-date-editor'));
  if (hoveredElement || isMenuVisible) {
    hideAIButton();
    hoveredElement = null;
  }
}

// Escape dismisses a stuck button/menu.
function handleEditorKeydown(e) {
  if (e.key === 'Escape' && (hoveredElement || isMenuVisible)) {
    hideAIButton();
    hoveredElement = null;
  }
}

// Show the AI button on an element
function showAIButton(element) {
  if (!aiButton || !element || dateEditorOpen) return;
  
  const container = aiButton.container || aiButton;
  
  // Check if element has pending change and update button appearance
  // (data-change-status/-type are set by inlineChanges' decorateRenderedResume;
  // decided paths keep the attributes but drop the pending status).
  const hasChange = element.dataset.changeStatus === 'pending' ? element.dataset.changeType : undefined;
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
  
  // Position the container using fixed positioning (no DOM changes to element).
  const rect = element.getBoundingClientRect();

  // Bounds guard: only show when the anchored text is within the resume
  // scroller's visible area. Without this the fixed-position button paints over
  // the header / panels when its element scrolls out of (or under) the viewport.
  const bounds = resumeScroller?.getBoundingClientRect();
  if (bounds && (rect.bottom < bounds.top || rect.top > bounds.bottom)) {
    hideAIButton();
    return;
  }

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
  appStorage.setItem(HINT_DISMISSED_KEY, 'true');
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
  // Deactivate any currently active element.
  // finishEditing() calls store.update(), which SYNCHRONOUSLY triggers a full
  // renderCurrentResume() (via the store subscription in main.js) that replaces
  // the DOM node we're about to edit. So capture the target's editable path
  // first, then re-resolve to the freshly-rendered node — otherwise we'd make a
  // detached node contentEditable and focus() would silently no-op, forcing the
  // user to click a second time to actually edit it. (#11)
  if (activeElement && activeElement !== element) {
    const targetPath = element.dataset.editable;
    // Tool chips all share data-editable="tools", so a bare querySelector would
    // re-resolve to the FIRST chip after the rerender and the user would end up
    // editing the wrong tool. Record the clicked element's position among
    // same-path siblings and restore that same one. (Unique paths — skills,
    // experience fields — have a single match, so the index is just 0.) (#11, PR#13)
    let targetIndex = 0;
    if (targetPath) {
      targetIndex = Math.max(0, [...document.querySelectorAll(`[data-editable="${targetPath}"]`)].indexOf(element));
    }
    finishEditing(activeElement);
    if (targetPath) {
      const refreshed = document.querySelectorAll(`[data-editable="${targetPath}"]`);
      if (refreshed[targetIndex]) element = refreshed[targetIndex];
      else if (refreshed[0]) element = refreshed[0];
    }
  }
  
  // Hide AI button when editing
  hideAIButton();
  hideAIMenu();
  hoveredElement = null;

  const path = element.dataset.editable;

  // Dates open a month-range picker instead of a contenteditable, so the
  // machine-readable startDate/endDate stay in step with the display string.
  //
  // Intercepted HERE, not in handleClick, because startEditing is the one funnel
  // both entry points share: handleKeyDown's Tab branch calls it directly, and a
  // dates node is an ordinary [data-editable] in that cycle (both renderer
  // variants — the <time> in the default layout and the <span> in the timeline
  // one). A click-only guard let Tab make the node contentEditable and write
  // `dates` alone, leaving the machine pair describing the old range.
  //
  // Returns BEFORE activeElement is set: the node never becomes contentEditable,
  // so nothing may point at it as the active edit. The re-resolution above has
  // already run, so `element` is the freshly-rendered node and its rect is real.
  //
  // This module stays free of React: it dispatches, and a host mounted in App
  // renders the panel and performs the store write — the same arrangement
  // confirmDestructive uses.
  if (/^experience\[\d+\]\.dates$/.test(path)) {
    dateEditorOpen = true;
    const rect = element.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('rd:edit-dates', {
      detail: { path, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } },
    }));
    return;
  }

  activeElement = element;

  // Tool chips — inline (.tool-token/.skill-tag) OR bulleted (.highlight-bullet) —
  // all share data-editable="tools" because `tools` is a single `•`-joined string.
  // Treat a click on one chip as editing JUST that chip: skip the whole-field
  // textContent swap below and let extractEditedValue re-join the siblings on save.
  // Without including .highlight-bullet here, clicking a bulleted tool replaced the
  // chip's text with the ENTIRE tools string (it looked like it "captured" every
  // adjacent tool).
  const isInlineToolToken = path === 'tools'
    && element.matches('.tool-token, .skill-tag, .skill-tag-inline, .highlight-bullet');
  if (path && !isInlineToolToken) {
    const sourceValue = store.get(path);
    // A data-editable must always resolve to a scalar. If it points at a container
    // (an object or array), the textContent fallback below would replace this whole
    // subtree with the literal string '[object Object]', make it contentEditable, and
    // let finishEditing persist that string over the record. Refuse instead.
    if (sourceValue !== null && sourceValue !== undefined
        && typeof sourceValue !== 'string' && typeof sourceValue !== 'number') {
      activeElement = null;
      return;
    }
    if (typeof sourceValue === 'string') {
      element.textContent = sourceValue;
    } else if (sourceValue === null || sourceValue === undefined) {
      element.textContent = '';
    } else {
      element.textContent = String(sourceValue);
    }
  }

  // Capture the value now shown in the editor for cancel/Escape. MUST run AFTER the
  // raw-value swap above: for plain string fields the swap puts the RAW stored value
  // (with **/_/++ markers) into textContent, while the summary renders via
  // formatInlineMarkdown — so capturing earlier would record marker-stripped text and
  // Escape would silently delete the formatting.
  element.dataset.originalEditValue = element.textContent || '';

  // Make editable
  element.contentEditable = 'true';
  element.spellcheck = true;
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
  
  // A company header edit renames EVERY role in the run. data-editable-group is
  // DOM metadata (a comma-separated list of array indices), not a store path — the
  // AI-addressable path grammar is unchanged. One array write keeps it to a single
  // undo step and a single re-render, instead of N torn intermediate states.
  const groupIndices = element.dataset.editableGroup;
  if (groupIndices) {
    const indices = groupIndices.split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger);
    const experience = store.get('experience');
    if (Array.isArray(experience) && indices.length > 0) {
      const next = experience.map((entry, i) => (indices.includes(i) ? { ...entry, company: newValue } : entry));
      store.setChangeMetadata('Renamed company');
      store.update('experience', next);
    }
  } else if (path.includes('[') && path.includes('].')) {
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
  element.spellcheck = false;
  element.classList.remove('editing');
  
  if (activeElement === element) {
    activeElement = null;
  }

  delete element.dataset.originalEditValue;
  
  // Auto-dismiss hint after first successful edit
  if (hasEditedOnce && !hintDismissed) {
    dismissHintPermanently();
  }
}

// Re-apply markdown emphasis (**bold**, _italic_, ++underline++) onto an element's
// plain text from its rendered children, so a round-trip through contentEditable
// doesn't silently drop formatting. Shared by bullet lists and tool chips.
//
// `b`/`i` are included alongside `strong`/`em` because WebKit's own execCommand —
// the iPad shortcut bar, and macOS's Edit menu — inserts the presentational tags.
// Querying only the semantic ones dropped that formatting on every round trip.
export function serializeEmphasis(el) {
  let result = (el.textContent || '').trim();
  el.querySelectorAll('strong, b').forEach((n) => { const t = n.textContent; if (t) result = result.replace(t, `**${t}**`); });
  el.querySelectorAll('em, i').forEach((n) => { const t = n.textContent; if (t) result = result.replace(t, `_${t}_`); });
  el.querySelectorAll('u').forEach((n) => { const t = n.textContent; if (t) result = result.replace(t, `++${t}++`); });
  return result;
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
    return Array.from(highlightBullets)
      .map((bulletEl) => { const r = serializeEmphasis(bulletEl); return r ? `- ${r}` : ''; })
      .filter(Boolean)
      .join(' • ');
  }
  
  // Tools are a single `•`-joined string rendered as many chips (inline tags OR a
  // bulleted list), all sharing data-editable="tools". Re-join EVERY sibling chip —
  // not just the edited one — so editing one tool doesn't drop the others, and keep
  // each chip's bold/italic.
  if (path === 'tools') {
    const toolScope = element.closest('.tools-bulleted') || element.closest('.tools-list')
      || element.closest('.skill-tag-row') || element.parentElement;
    const toolTags = toolScope?.querySelectorAll(
      '.tool-token, .skill-tag[data-editable="tools"], .skill-tag-inline[data-editable="tools"], .highlight-bullet[data-editable="tools"]'
    );
    if (toolTags && toolTags.length > 0) {
      return Array.from(toolTags).map((tag) => serializeEmphasis(tag)).filter(Boolean).join(' • ');
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
  if (modKey && !e.altKey) {
    // '**' bold, '_' italic, '++' underline — the same markers serializeEmphasis reads.
    const marker = { b: '**', i: '_', u: '++' }[e.key.toLowerCase()];
    if (marker) {
      e.preventDefault();
      toggleMarkerInEditable(editable, marker);
      return;
    }
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
    const originalInlineValue = editable.dataset.originalEditValue;
    if (originalInlineValue !== undefined) {
      editable.textContent = originalInlineValue;
      finishEditing(editable);
      return;
    }

    const path = editable.dataset.editable;
    const originalValue = store.get(path);
    editable.textContent = originalValue || '';
    finishEditing(editable);
  }
  
  // Tab moves to next editable
  if (e.key === 'Tab') {
    e.preventDefault();

    // finishEditing() calls store.update(), which SYNCHRONOUSLY triggers a full
    // renderCurrentResume() that replaces every node inside #resume — and
    // store.update pushes history and emits even when the value is unchanged, so
    // the re-render is unconditional. `editable` is therefore always detached by
    // the time the fresh list below exists, and indexOf() always returned -1:
    // forward Tab landed on editables[0] and Shift+Tab on editables[length - 2],
    // never the adjacent field.
    //
    // So capture the element's identity BEFORE finishing — its path plus its
    // position among same-path siblings, the same bookkeeping startEditing does,
    // because tool chips all share data-editable="tools" and a bare re-query
    // would resolve to the first chip. Then locate the fresh node and step from
    // ITS index. (#11)
    const path = editable.dataset.editable;
    const samePathIndex = path
      ? Math.max(0, [...document.querySelectorAll(`[data-editable="${path}"]`)].indexOf(editable))
      : 0;

    finishEditing(editable);

    const editables = Array.from(
      document.querySelectorAll('[data-editable]')
    );
    if (editables.length === 0) return;

    const refreshed = path ? document.querySelectorAll(`[data-editable="${path}"]`) : null;
    const current = refreshed ? (refreshed[samePathIndex] || refreshed[0]) : null;
    const currentIndex = current ? editables.indexOf(current) : -1;

    // The field genuinely vanished across the re-render (nothing renders it any
    // more). Start the cycle from the end the user was heading towards rather
    // than silently doing nothing.
    const nextIndex = currentIndex === -1
      ? (e.shiftKey ? editables.length - 1 : 0)
      : (e.shiftKey
        ? (currentIndex - 1 + editables.length) % editables.length
        : (currentIndex + 1) % editables.length);

    if (editables[nextIndex]) {
      startEditing(editables[nextIndex]);
    }
  }
}

function toggleMarkerInEditable(editable, marker) {
  // Skip structural rich text nodes that are reconstructed by specialized extractors:
  // the textContent round-trip below would flatten their markup. `matches` is needed
  // as well as `querySelector` because these chips are sometimes the editable ITSELF,
  // not a descendant — renderer.js emits
  // `<span class="highlight-bullet" data-editable="tools">` per tool — and
  // querySelector only ever looks at descendants, so the guard missed exactly the
  // elements it exists to protect.
  const RICH_TEXT_SELECTOR = '.skill-tag, .skill-tag-inline, .highlight-bullet';
  if (editable.matches(RICH_TEXT_SELECTOR) || editable.querySelector(RICH_TEXT_SELECTOR)) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return;

  const start = getTextOffset(editable, range.startContainer, range.startOffset);
  const end = getTextOffset(editable, range.endContainer, range.endOffset);
  const result = toggleMarkdownMarker(editable.textContent || '', start, end, marker);

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

/**
 * Toggle a markdown emphasis marker around [start, end) of `value`.
 * Marker is the literal wrapper: '**' bold, '_' italic, '++' underline.
 * Exported for unit testing; the DOM wrapper is toggleMarkerInEditable.
 */
export function toggleMarkdownMarker(value, start, end, marker) {
  // A DOM selection can run backwards (anchor after focus), so normalise before
  // slicing — otherwise `selected` is empty and every branch below misbehaves.
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  if (selectionStart === selectionEnd) return { value, start: selectionStart, end: selectionEnd };

  const len = marker.length;
  const before = value.slice(0, selectionStart);
  const selected = value.slice(selectionStart, selectionEnd);
  const after = value.slice(selectionEnd);

  // Markers INSIDE the selection? Unwrap. This is the default path in the app:
  // startEditing ends with range.selectNodeContents(element), so a click selects
  // the whole RAW value including its markers. Must be tested before the
  // markers-outside case. The length guard keeps a selection that is nothing but
  // the marker itself (e.g. '**') from "unwrapping" to an empty string.
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= 2 * len) {
    const unwrapped = selected.slice(len, -len);
    return {
      value: before + unwrapped + after,
      start: selectionStart,
      end: selectionStart + unwrapped.length,
    };
  }

  // Markers OUTSIDE the selection? Unwrap outward.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -len) + selected + after.slice(len),
      start: selectionStart - len,
      end: selectionEnd - len,
    };
  }
  return {
    value: `${before}${marker}${selected}${marker}${after}`,
    start: selectionStart + len,
    end: selectionEnd + len,
  };
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
