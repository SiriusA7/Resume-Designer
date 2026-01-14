/**
 * Chat Panel
 * AI chat interface with message history and actions
 */

import { chat, rewriteText, generateBullets, getFeedback, improveSummary, isProviderConfigured, getConfiguredProviders, generateResumeChanges, getDefaultModelId } from './aiService.js';
import { getSettings, saveSettings } from './persistence.js';
import { store } from './store.js';
import { marked } from 'marked';
import { createChangeSet, diffResumeData } from './diffEngine.js';
import { showDiffView, initDiffView } from './diffView.js';
import { showInlineChanges, hideInlineChanges, initInlineChanges } from './inlineChanges.js';

let messagesContainer;
let inputEl;
let sendBtn;
let modelSelect;
let contextChipsContainer;
let messages = [];
let isLoading = false;
let onApplyCallback = null;
let isPanelOpen = false;

// Context chips storage
let contextChips = [];

// Thread management
let threads = [];
let currentThreadId = null;

// Chat options state
let currentReasoningEffort = 'medium'; // 'none', 'low', 'medium', 'high'
let webSearchEnabled = false;

const STORAGE_KEY = 'resume-designer-chat-history';
const THREADS_KEY = 'resume-designer-chat-threads';

// AI Model options - Model IDs verified from provider documentation
const AI_MODELS = [
  { group: 'Anthropic', options: [
    { value: 'anthropic:claude-opus-4-5', label: 'Claude Opus 4.5' },
    { value: 'anthropic:claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' }
  ]},
  { group: 'OpenAI', options: [
    { value: 'openai:gpt-5.2', label: 'GPT-5.2' },
    { value: 'openai:gpt-5.2-pro', label: 'GPT-5.2 Pro' },
    { value: 'openai:gpt-4o', label: 'GPT-4o' },
    { value: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' }
  ]},
  { group: 'Google', options: [
    { value: 'gemini:gemini-3-pro', label: 'Gemini 3 Pro' },
    { value: 'gemini:gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'gemini:gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini:gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
  ]}
];

let currentModel = null;

// Get the initial default model based on configured providers
function getInitialModel() {
  // First check if there's a saved preference
  const settings = getSettings();
  if (settings.defaultModel) {
    // Verify the saved model's provider is still configured
    const provider = settings.defaultModel.split(':')[0];
    const configuredProviders = getConfiguredProviders();
    if (configuredProviders.includes(provider)) {
      return settings.defaultModel;
    }
  }
  
  // Otherwise, get default based on configured providers
  const defaultModel = getDefaultModelId();
  if (defaultModel) {
    return defaultModel;
  }
  
  // Fallback to first available in list (won't work without API key anyway)
  return 'openai:gpt-4o';
}

// Initialize chat panel
export function initChatPanel(onApply) {
  messagesContainer = document.getElementById('chat-messages');
  inputEl = document.getElementById('chat-input');
  sendBtn = document.getElementById('chat-send-btn');
  modelSelect = document.getElementById('ai-model-select');
  contextChipsContainer = document.getElementById('context-chips');
  onApplyCallback = onApply;
  
  if (!messagesContainer || !inputEl || !sendBtn) return;
  
  // Set current model based on configured providers
  currentModel = getInitialModel();
  
  // Initialize diff view
  initDiffView(onApply);
  
  // Initialize inline changes
  initInlineChanges();
  
  // Initialize custom model dropdown
  initModelDropdown();
  
  // Load chat history (includes thread loading)
  loadChatHistory();
  
  // Render thread selector
  renderThreadSelector();
  
  // Set up event listeners
  setupEventListeners();
  
  // Set up panel toggle
  setupPanelToggle();
  
  // Check if API keys are configured and render appropriate view
  renderChatView();
}

// Map provider keys to display names
const PROVIDER_NAMES = {
  'anthropic': 'Anthropic (Claude)',
  'openai': 'OpenAI',
  'gemini': 'Google (Gemini)'
};

// Initialize custom model dropdown
function initModelDropdown() {
  const selectorContainer = document.querySelector('.chat-model-selector');
  if (!selectorContainer) return;
  
  // Get configured providers
  const configuredProviders = getConfiguredProviders();
  
  // Get current model label
  const currentModelLabel = getModelLabel(currentModel);
  
  // Build dropdown content based on provider configuration
  const dropdownContent = AI_MODELS.map(group => {
    const providerKey = group.options[0]?.value.split(':')[0]; // Get provider from first option
    const isConfigured = configuredProviders.includes(providerKey);
    
    if (isConfigured) {
      // Show available models for configured providers
      return `
        <div class="custom-dropdown-group-label">${group.group}</div>
        ${group.options.map(opt => `
          <button class="custom-dropdown-option ${opt.value === currentModel ? 'selected' : ''}" 
                  data-value="${opt.value}" type="button">
            <svg class="check-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            ${opt.label}
          </button>
        `).join('')}
      `;
    } else {
      // Show notice for unconfigured providers
      return `
        <div class="custom-dropdown-group-label">${group.group}</div>
        <div class="custom-dropdown-notice">
          <span class="notice-text">API key not configured</span>
          <button class="notice-configure-btn" data-provider="${providerKey}" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            Configure
          </button>
        </div>
      `;
    }
  }).join('');
  
  // Create custom dropdown HTML
  const dropdownHTML = `
    <div class="custom-dropdown" id="model-dropdown">
      <button class="custom-dropdown-trigger" type="button">
        <span class="dropdown-label">${currentModelLabel}</span>
        <svg class="dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="custom-dropdown-menu">
        ${dropdownContent}
      </div>
    </div>
  `;
  
  selectorContainer.innerHTML = dropdownHTML;
  
  // Setup dropdown events
  const dropdown = document.getElementById('model-dropdown');
  const trigger = dropdown?.querySelector('.custom-dropdown-trigger');
  
  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  
  // Handle option selection
  dropdown?.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-dropdown-option');
    if (option) {
      const value = option.dataset.value;
      selectModel(value);
      dropdown.classList.remove('open');
    }
    
    // Handle configure button click
    const configureBtn = e.target.closest('.notice-configure-btn');
    if (configureBtn) {
      e.stopPropagation();
      openSettingsModal();
      dropdown.classList.remove('open');
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown?.contains(e.target)) {
      dropdown?.classList.remove('open');
    }
  });
}

// Open the settings modal
function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.classList.add('show');
  }
}

// Get model label from value
function getModelLabel(value) {
  if (!value) return 'Select Model';
  
  for (const group of AI_MODELS) {
    for (const opt of group.options) {
      if (opt.value === value) return opt.label;
    }
  }
  
  // If not found, extract a friendly name from the model ID
  // e.g., "anthropic:claude-sonnet-4-5-20251022" -> "Claude Sonnet 4.5"
  const parts = value.split(':');
  if (parts.length === 2) {
    const modelName = parts[1]
      .replace(/-/g, ' ')
      .replace(/\d{8,}/, '') // Remove date suffixes
      .trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return modelName || 'Unknown Model';
  }
  
  return 'Unknown Model';
}

// Select a model
function selectModel(value) {
  currentModel = value;
  saveSettings({ defaultModel: value });
  
  // Update dropdown UI
  const dropdown = document.getElementById('model-dropdown');
  const label = dropdown?.querySelector('.dropdown-label');
  if (label) {
    label.textContent = getModelLabel(value);
  }
  
  // Update selected state
  dropdown?.querySelectorAll('.custom-dropdown-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === value);
  });
}

// Setup panel toggle
function setupPanelToggle() {
  const panel = document.getElementById('chat-panel');
  const toggleBtn = document.getElementById('toggle-chat-panel');
  const closeBtn = document.getElementById('chat-close-btn');
  
  if (!panel || !toggleBtn) return;
  
  // Toggle panel on button click
  toggleBtn.addEventListener('click', () => {
    togglePanel(true);
  });
  
  // Close panel
  closeBtn?.addEventListener('click', () => {
    togglePanel(false);
  });
}

// Toggle panel open/closed
function togglePanel(open) {
  const panel = document.getElementById('chat-panel');
  const toggleBtn = document.getElementById('toggle-chat-panel');
  
  if (!panel) return;
  
  isPanelOpen = open ?? !isPanelOpen;
  panel.classList.toggle('closed', !isPanelOpen);
  
  // Focus input when opening
  if (isPanelOpen && inputEl) {
    setTimeout(() => inputEl.focus(), 300);
  }
}

// Update loading indicator on toggle button
function updateToggleIndicator(loading) {
  const indicator = document.getElementById('chat-toggle-indicator');
  if (indicator) {
    indicator.classList.toggle('active', loading && !isPanelOpen);
  }
}

// Open chat panel with context added as a chip
export function openChatWithContext(context, elementPath, contextType = 'text') {
  togglePanel(true);
  
  if (context) {
    // Add context as a chip instead of pasting text
    addContextChip({
      type: contextType,
      path: elementPath || '',
      content: context,
      label: getContextLabel(context, contextType, elementPath)
    });
    
    // Focus input
    if (inputEl) {
      inputEl.focus();
    }
  }
}

// Get a label for the context chip
function getContextLabel(content, type, path) {
  switch (type) {
    case 'section':
      // Extract section name from path like "sections[0]" or section title
      if (path) {
        const match = path.match(/sections\[(\d+)\]/);
        if (match) {
          const data = store.getData();
          const section = data?.sections?.[parseInt(match[1])];
          return section?.title || 'Section';
        }
      }
      return 'Section';
      
    case 'experience':
      // Extract experience entry info
      if (path) {
        const match = path.match(/experience\[(\d+)\]/);
        if (match) {
          const data = store.getData();
          const exp = data?.experience?.[parseInt(match[1])];
          if (exp) {
            return `${exp.title} @ ${exp.company}`;
          }
        }
      }
      return 'Experience Entry';
      
    case 'bullet':
      return 'Bullet Point';
      
    case 'text':
    default:
      // Truncate long text for label
      const text = content.trim();
      if (text.length > 40) {
        return text.substring(0, 40) + '...';
      }
      return text;
  }
}

// Add a context chip (exported for use by other modules)
export function addContextChip(chipData) {
  // Check if this context is already added (by path or content)
  const exists = contextChips.some(c => 
    (c.path && c.path === chipData.path) || 
    (c.content === chipData.content)
  );
  
  if (!exists) {
    contextChips.push(chipData);
    renderContextChips();
  }
}

// Refresh the chat panel UI (called when API keys change)
export function refreshChatPanel() {
  // Re-evaluate the current model based on new API key configuration
  currentModel = getInitialModel();
  initModelDropdown();
  renderThreadSelector();
  renderChatView();
}

// Remove a context chip
function removeContextChip(index) {
  contextChips.splice(index, 1);
  renderContextChips();
}

// Clear all context chips
function clearContextChips() {
  contextChips = [];
  renderContextChips();
}

// Render context chips
function renderContextChips() {
  if (!contextChipsContainer) {
    // Create container if it doesn't exist
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) {
      contextChipsContainer = document.createElement('div');
      contextChipsContainer.id = 'context-chips';
      contextChipsContainer.className = 'context-chips';
      inputArea.insertBefore(contextChipsContainer, inputArea.firstChild);
    }
  }
  
  if (!contextChipsContainer) return;
  
  if (contextChips.length === 0) {
    contextChipsContainer.innerHTML = '';
    contextChipsContainer.classList.remove('has-chips');
    return;
  }
  
  contextChipsContainer.classList.add('has-chips');
  contextChipsContainer.innerHTML = `
    <div class="context-chips-header">
      <span class="context-chips-label">Context:</span>
      <button class="context-chips-clear" title="Clear all">Clear all</button>
    </div>
    <div class="context-chips-list">
      ${contextChips.map((chip, i) => `
        <div class="context-chip" data-index="${i}">
          <span class="context-chip-icon">${getChipIcon(chip.type)}</span>
          <span class="context-chip-label">${escapeHtml(chip.label)}</span>
          <button class="context-chip-remove" data-index="${i}" title="Remove">×</button>
        </div>
      `).join('')}
    </div>
  `;
  
  // Add event listeners
  contextChipsContainer.querySelector('.context-chips-clear')?.addEventListener('click', clearContextChips);
  contextChipsContainer.querySelectorAll('.context-chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      removeContextChip(index);
    });
  });
}

// Get icon for chip type
function getChipIcon(type) {
  switch (type) {
    case 'section':
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
      </svg>`;
    case 'experience':
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
      </svg>`;
    case 'bullet':
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="8" y1="6" x2="21" y2="6"/>
        <line x1="8" y1="12" x2="21" y2="12"/>
        <line x1="8" y1="18" x2="21" y2="18"/>
        <circle cx="4" cy="6" r="1" fill="currentColor"/>
        <circle cx="4" cy="12" r="1" fill="currentColor"/>
        <circle cx="4" cy="18" r="1" fill="currentColor"/>
      </svg>`;
    default:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>`;
  }
}

// Set up event listeners
function setupEventListeners() {
  // Send on button click
  sendBtn?.addEventListener('click', handleSend);
  
  // Send on Enter (Shift+Enter for new line)
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  
  // Auto-resize textarea
  inputEl?.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  });
  
  // Shortcut buttons
  document.querySelectorAll('.chat-shortcut').forEach(btn => {
    btn.addEventListener('click', () => {
      const command = btn.dataset.command;
      if (command) {
        inputEl.value = command;
        handleSend();
      }
    });
  });
  
  // Handle clicks on apply buttons (delegated)
  messagesContainer?.addEventListener('click', (e) => {
    const applyBtn = e.target.closest('.chat-apply-btn');
    if (applyBtn) {
      const action = applyBtn.dataset.action;
      const value = applyBtn.dataset.value;
      handleApply(action, value);
    }
  });
  
  // Chat option buttons
  setupChatOptions();
}

// Set up chat option buttons (search, reasoning)
function setupChatOptions() {
  const searchBtn = document.getElementById('chat-search-btn');
  const reasoningDropdown = document.getElementById('chat-reasoning-dropdown');
  const reasoningBtn = document.getElementById('chat-reasoning-btn');
  const reasoningMenu = document.getElementById('chat-reasoning-menu');
  
  // Web search toggle
  searchBtn?.addEventListener('click', () => {
    webSearchEnabled = !webSearchEnabled;
    searchBtn.classList.toggle('active', webSearchEnabled);
    searchBtn.title = webSearchEnabled ? 'Web search enabled' : 'Enable web search';
    
    // Show confirmation tooltip when enabled
    if (webSearchEnabled) {
      showTemporaryTooltip(searchBtn, 'Web search enabled - model will search the internet');
    }
  });
  
  // Reasoning effort dropdown
  reasoningBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    reasoningDropdown?.classList.toggle('open');
  });
  
  // Reasoning options
  reasoningMenu?.querySelectorAll('.chat-reasoning-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = option.dataset.level; // Use data-level from HTML
      currentReasoningEffort = value;
      
      // Update UI
      reasoningMenu.querySelectorAll('.chat-reasoning-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      
      // Update button label
      const label = reasoningBtn?.querySelector('.reasoning-label');
      if (label) {
        label.textContent = getReasoningLabel(value);
      }
      
      reasoningDropdown?.classList.remove('open');
    });
  });
  
  // Close reasoning dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!reasoningDropdown?.contains(e.target)) {
      reasoningDropdown?.classList.remove('open');
    }
  });
}

// Get display label for reasoning effort
function getReasoningLabel(value) {
  const labels = {
    'none': 'Off',
    'low': 'Low',
    'medium': 'Medium',
    'high': 'High'
  };
  return labels[value] || 'Medium';
}

// Show temporary tooltip
function showTemporaryTooltip(element, message) {
  const tooltip = document.createElement('div');
  tooltip.className = 'chat-temp-tooltip';
  tooltip.textContent = message;
  
  const rect = element.getBoundingClientRect();
  tooltip.style.cssText = `
    position: fixed;
    top: ${rect.top - 30}px;
    left: ${rect.left + rect.width / 2}px;
    transform: translateX(-50%);
    background: var(--color-warning-bg, #fef3cd);
    color: var(--color-warning-text, #856404);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    white-space: nowrap;
    z-index: 10000;
    pointer-events: none;
  `;
  
  document.body.appendChild(tooltip);
  
  setTimeout(() => {
    tooltip.remove();
  }, 2000);
}


// Render the chat view based on API key configuration
function renderChatView() {
  const configuredProviders = getConfiguredProviders();
  const modelSelector = document.querySelector('.chat-model-selector');
  const inputArea = document.querySelector('.chat-input-area');
  
  if (configuredProviders.length === 0) {
    // Hide model selector and input area when no API keys
    if (modelSelector) modelSelector.style.display = 'none';
    if (inputArea) inputArea.style.display = 'none';
    
    // Show API key setup prompt
    renderApiKeyPrompt();
  } else {
    // Show model selector and input area
    if (modelSelector) modelSelector.style.display = '';
    if (inputArea) inputArea.style.display = '';
    
    // Show normal chat view
    renderMessages();
  }
}

// Render API key setup prompt
function renderApiKeyPrompt() {
  if (!messagesContainer) return;
  
  messagesContainer.innerHTML = `
    <div class="chat-api-prompt">
      <div class="chat-api-prompt-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h3>Setup Required</h3>
      <p>To use the AI Assistant, you need to configure at least one API key.</p>
      <div class="chat-api-prompt-providers">
        <div class="provider-option">
          <strong>Anthropic (Claude)</strong>
          <span>Best for nuanced writing</span>
        </div>
        <div class="provider-option">
          <strong>OpenAI (GPT)</strong>
          <span>Fast and versatile</span>
        </div>
        <div class="provider-option">
          <strong>Google (Gemini)</strong>
          <span>Great for analysis</span>
        </div>
      </div>
      <button class="btn btn-primary chat-api-prompt-btn" id="open-settings-from-prompt">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        Configure API Keys
      </button>
    </div>
  `;
  
  // Add click handler for settings button
  const settingsBtn = document.getElementById('open-settings-from-prompt');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSettingsModal();
    });
  }
}

// Handle send message
async function handleSend() {
  const text = inputEl?.value.trim();
  if (!text || isLoading) return;
  
  // Check if any API keys are configured
  const configuredProviders = getConfiguredProviders();
  if (configuredProviders.length === 0) {
    addMessage('error', 'Please configure an API key in settings before using the AI assistant.');
    return;
  }
  
  // Check for commands
  if (text.startsWith('/')) {
    await handleCommand(text);
    return;
  }
  
  // Build message with context chips
  let messageWithContext = text;
  const savedContextChips = [...contextChips];
  
  if (contextChips.length > 0) {
    const contextText = contextChips.map(chip => {
      return `[${chip.label}]:\n${chip.content}`;
    }).join('\n\n');
    messageWithContext = `Context from resume:\n${contextText}\n\n---\n\nUser request: ${text}`;
  }
  
  // Add user message (show only the user's text in UI)
  addMessage('user', text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  
  // Get target path from context if available
  const targetPath = savedContextChips.length > 0 ? savedContextChips[0].path : null;
  
  // Clear context chips after sending
  clearContextChips();
  
  // Determine if this is a change request or a general question
  if (isChangeRequest(text)) {
    // User wants changes - use the change generation flow
    await requestAIChanges(messageWithContext, targetPath);
  } else {
    // General question - use normal chat flow
    await getAIResponse(messageWithContext, savedContextChips.length > 0);
  }
}

// Handle slash commands
async function handleCommand(command) {
  const parts = command.split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  
  inputEl.value = '';
  
  switch (cmd) {
    case '/feedback':
      addMessage('user', 'Please review my resume and provide feedback.');
      await getAIFeedback();
      break;
      
    case '/improve':
      if (args.toLowerCase().includes('summary')) {
        addMessage('user', 'Please improve my resume summary.');
        await getAIImproveSummary();
      } else {
        addMessage('user', `Please improve: ${args}`);
        await getAIResponse(`Please improve this section of my resume: ${args}`);
      }
      break;
      
    case '/generate':
      addMessage('user', `Generate content: ${args}`);
      await getAIGenerateBullets(args);
      break;
      
    case '/clear':
      clearHistory();
      break;
      
    case '/help':
      showHelp();
      break;
      
    default:
      addMessage('assistant', `Unknown command: ${cmd}\n\nAvailable commands:\n• /feedback - Get resume feedback\n• /improve [section] - Improve a section\n• /generate [context] - Generate bullet points\n• /clear - Clear chat history\n• /help - Show this help`);
  }
}

// Get AI response for general chat
async function getAIResponse(userMessage, hasExplicitContext = false) {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    // Show thinking step
    const modelName = getModelDisplayName(modelId);
    addThinkingStep(`Sending to ${modelName}...`);
    
    // Build conversation history (last 10 messages for context)
    // Filter out error messages as they're not valid API roles
    const conversationHistory = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));
    
    // Replace last message with the one that includes context
    if (conversationHistory.length > 0) {
      conversationHistory[conversationHistory.length - 1].content = userMessage;
    }
    
    // If explicit context was provided, don't add resume context again
    const includeResumeContext = !hasExplicitContext;
    
    // Build options for the AI call
    const options = {
      reasoningEffort: currentReasoningEffort,
      webSearch: webSearchEnabled
    };
    
    // Show web search step if enabled
    if (webSearchEnabled) {
      completeThinkingStep('Searching the web...');
    }
    
    const response = await chat(modelId, conversationHistory, includeResumeContext, options);
    
    // Handle structured response (with thinking/reasoning)
    if (response && typeof response === 'object' && response.text) {
      // Show additional thinking steps based on response
      if (response.usedWebSearch) {
        completeThinkingStep('Processed web search results');
      }
      if (response.thinking) {
        completeThinkingStep('Applied reasoning');
      }
      completeThinkingStep('Response ready');
      setLoading(false);
      
      // Add message with reasoning summary
      addMessageWithReasoning('assistant', response.text, response.thinking);
    } else {
      // Simple text response
      completeThinkingStep('Response received');
      setLoading(false);
      addMessage('assistant', response);
    }
  } catch (error) {
    setLoading(false);
    addMessage('error', error.message);
  }
}

// Add message with optional reasoning summary
function addMessageWithReasoning(role, content, reasoning = null) {
  const message = {
    id: Date.now(),
    role,
    content,
    reasoning,
    timestamp: new Date().toISOString()
  };
  
  messages.push(message);
  saveChatHistory();
  renderMessages();
  scrollToBottom();
}

// Get display name for a model ID
function getModelDisplayName(modelId) {
  for (const group of AI_MODELS) {
    for (const opt of group.options) {
      if (opt.value === modelId) {
        return opt.label;
      }
    }
  }
  return modelId.split(':').pop();
}

// Get AI feedback
async function getAIFeedback() {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    addThinkingStep('Analyzing your resume...');
    const response = await getFeedback(modelId);
    completeThinkingStep('Feedback ready');
    setLoading(false);
    addMessage('assistant', response);
  } catch (error) {
    setLoading(false);
    addMessage('error', error.message);
  }
}

// Get AI summary improvement
async function getAIImproveSummary() {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    addThinkingStep('Reading current summary...');
    await new Promise(resolve => setTimeout(resolve, 200));
    completeThinkingStep('Writing improved summary...');
    
    const response = await improveSummary(modelId);
    completeThinkingStep('Summary improved');
    setLoading(false);
    
    // Add with apply button for summary
    addMessage('assistant', response, { action: 'apply-summary', value: response });
  } catch (error) {
    setLoading(false);
    addMessage('error', error.message);
  }
}

// Get AI generated bullets
async function getAIGenerateBullets(context) {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    addThinkingStep('Generating bullet points...');
    const response = await generateBullets(modelId, context, 3);
    completeThinkingStep('Bullets generated');
    setLoading(false);
    addMessage('assistant', response);
  } catch (error) {
    setLoading(false);
    addMessage('error', error.message);
  }
}

// Check if the user's message is requesting changes to the resume
function isChangeRequest(message) {
  const changeKeywords = [
    'change', 'update', 'modify', 'edit', 'rewrite', 'improve', 'replace',
    'make it', 'make my', 'fix', 'adjust', 'enhance', 'revise', 'rework',
    'redo', 'transform', 'convert', 'add to', 'remove from', 'delete',
    'can you change', 'can you update', 'can you modify', 'can you edit',
    'please change', 'please update', 'please modify', 'please edit',
    'tailor', 'customize', 'personalize', 'optimize'
  ];
  
  const lowerMessage = message.toLowerCase();
  return changeKeywords.some(keyword => lowerMessage.includes(keyword));
}

// Get the target path from context chips if available
function getTargetPathFromContext() {
  if (contextChips.length === 0) return null;
  
  // If there's a specific context selected, return its path
  const firstChip = contextChips[0];
  return firstChip.path || null;
}

// Request AI to generate changes and show diff view
async function requestAIChanges(instruction, targetPath = null) {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    // Show thinking steps
    addThinkingStep('Analyzing your request...');
    
    // Small delay to show the step
    await new Promise(resolve => setTimeout(resolve, 300));
    completeThinkingStep('Generating resume changes...');
    
    const result = await generateResumeChanges(modelId, instruction, targetPath);
    
    if (!result.changes || Object.keys(result.changes).length === 0) {
      // No changes generated - provide explanation
      completeThinkingStep('No changes needed');
      setLoading(false);
      addMessage('assistant', result.explanation || 'No changes were generated. The AI may need more specific instructions.');
      return;
    }
    
    completeThinkingStep('Preparing diff view...');
    
    // Create change set for diff view
    const currentData = store.getData();
    const changeSet = createChangeSet(currentData, result.changes);
    
    // Show inline changes on the resume
    showInlineChanges(changeSet);
    
    const changeCount = Object.keys(result.changes).length;
    completeThinkingStep(`Generated ${changeCount} change${changeCount > 1 ? 's' : ''}`);
    
    // Finalize thinking and add response message
    setLoading(false);
    
    // Add the actual response message with pending changes
    const responseMsg = {
      id: Date.now(),
      role: 'assistant',
      content: `${result.explanation || `Generated ${changeCount} change${changeCount > 1 ? 's' : ''} to your resume.`}\n\nChanges are highlighted on your resume. Use the buttons to apply or reject individual changes, or click "Review Changes" below for a detailed diff view.`,
      timestamp: new Date().toISOString(),
      pendingChanges: changeSet
    };
    messages.push(responseMsg);
    saveChatHistory();
    renderMessages();
    scrollToBottom();
    
  } catch (error) {
    setLoading(false);
    addMessage('error', error.message);
  }
}

// Open diff view with pending changes from a message
function openDiffViewForMessage(messageId) {
  const message = messages.find(m => m.id === messageId);
  if (message?.pendingChanges) {
    showDiffView(message.pendingChanges);
  }
}

// Add a message to the chat
function addMessage(role, content, applyData = null) {
  const message = {
    id: Date.now(),
    role,
    content,
    timestamp: new Date().toISOString(),
    applyData
  };
  
  messages.push(message);
  saveChatHistory();
  renderMessages();
  scrollToBottom();
}

// Thinking process state
let thinkingSteps = [];
let thinkingContainerId = null;

// Set loading state
function setLoading(loading) {
  isLoading = loading;
  sendBtn.disabled = loading;
  
  // Update toggle button indicator
  updateToggleIndicator(loading);
  
  if (loading) {
    // Create thinking process container
    startThinkingProcess();
  } else {
    // Finalize thinking process
    finalizeThinkingProcess();
  }
}

// Start a new thinking process display
function startThinkingProcess() {
  thinkingSteps = [];
  thinkingContainerId = `thinking-${Date.now()}`;
  
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'chat-thinking-process';
  thinkingEl.id = thinkingContainerId;
  thinkingEl.innerHTML = `
    <div class="thinking-header">
      <div class="thinking-indicator">
        <div class="thinking-spinner"></div>
        <span>Processing...</span>
      </div>
    </div>
    <div class="thinking-steps"></div>
  `;
  messagesContainer.appendChild(thinkingEl);
  scrollToBottom();
}

// Add a step to the thinking process
function addThinkingStep(step, isComplete = false) {
  thinkingSteps.push({ text: step, complete: isComplete });
  
  const container = document.getElementById(thinkingContainerId);
  if (!container) return;
  
  const stepsEl = container.querySelector('.thinking-steps');
  if (!stepsEl) return;
  
  // Re-render all steps
  stepsEl.innerHTML = thinkingSteps.map((s, i) => `
    <div class="thinking-step ${s.complete ? 'complete' : (i === thinkingSteps.length - 1 ? 'active' : '')}">
      <div class="thinking-step-bullet">
        ${s.complete 
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
          : '<div class="thinking-step-dot"></div>'
        }
      </div>
      <span>${escapeHtml(s.text)}</span>
    </div>
  `).join('');
  
  scrollToBottom();
}

// Update the last thinking step
function updateThinkingStep(text, isComplete = false) {
  if (thinkingSteps.length === 0) {
    addThinkingStep(text, isComplete);
    return;
  }
  
  thinkingSteps[thinkingSteps.length - 1] = { text, complete: isComplete };
  
  const container = document.getElementById(thinkingContainerId);
  if (!container) return;
  
  const stepsEl = container.querySelector('.thinking-steps');
  if (!stepsEl) return;
  
  const lastStep = stepsEl.querySelector('.thinking-step:last-child');
  if (lastStep) {
    lastStep.querySelector('span').textContent = text;
    if (isComplete) {
      lastStep.classList.add('complete');
      lastStep.classList.remove('active');
      lastStep.querySelector('.thinking-step-bullet').innerHTML = 
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    }
  }
  
  scrollToBottom();
}

// Complete the current thinking step and start a new one
function completeThinkingStep(newStep = null) {
  if (thinkingSteps.length > 0) {
    thinkingSteps[thinkingSteps.length - 1].complete = true;
    
    const container = document.getElementById(thinkingContainerId);
    if (container) {
      const stepsEl = container.querySelector('.thinking-steps');
      const lastStep = stepsEl?.querySelector('.thinking-step:last-child');
      if (lastStep) {
        lastStep.classList.add('complete');
        lastStep.classList.remove('active');
        lastStep.querySelector('.thinking-step-bullet').innerHTML = 
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    }
  }
  
  if (newStep) {
    addThinkingStep(newStep);
  }
}

// Finalize the thinking process (mark as done)
function finalizeThinkingProcess() {
  const container = document.getElementById(thinkingContainerId);
  if (!container) return;
  
  // Mark all steps as complete
  thinkingSteps.forEach(s => s.complete = true);
  
  // Update header to show completion
  const header = container.querySelector('.thinking-header');
  if (header) {
    header.innerHTML = `
      <div class="thinking-indicator complete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>Complete</span>
      </div>
    `;
  }
  
  // Update all steps to show complete
  const stepsEl = container.querySelector('.thinking-steps');
  if (stepsEl) {
    stepsEl.querySelectorAll('.thinking-step').forEach(step => {
      step.classList.add('complete');
      step.classList.remove('active');
      const bullet = step.querySelector('.thinking-step-bullet');
      if (bullet && !bullet.querySelector('svg')) {
        bullet.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    });
  }
  
  // Reset state
  thinkingContainerId = null;
  thinkingSteps = [];
}

// Render all messages
function renderMessages() {
  if (!messagesContainer) return;
  
  // If no messages, show welcome
  if (messages.length === 0) {
    messagesContainer.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <h3>Welcome to AI Assistant</h3>
        <p>I can help you improve your resume. Try asking me to:</p>
        <ul>
          <li>Rewrite a bullet point to be more impactful</li>
          <li>Suggest improvements for your summary</li>
          <li>Generate new experience bullets</li>
          <li>Review your resume for feedback</li>
        </ul>
        <p class="chat-welcome-hint">Configure your API keys in settings to get started.</p>
      </div>
    `;
    return;
  }
  
  // Render messages
  messagesContainer.innerHTML = messages.map(msg => {
    if (msg.role === 'error') {
      return `
        <div class="chat-error">
          <strong>Error:</strong> ${escapeHtml(msg.content)}
        </div>
      `;
    }
    
    const isUser = msg.role === 'user';
    const bubbleClass = isUser ? 'chat-message-user' : 'chat-message-assistant';
    
    let actionButtons = '';
    
    // Apply button for direct apply actions
    if (msg.applyData) {
      actionButtons += `
        <button class="chat-apply-btn" data-action="${msg.applyData.action}" data-value="${escapeAttr(msg.applyData.value)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Apply to Resume
        </button>
      `;
    }
    
    // Review Changes button for pending changes
    if (msg.pendingChanges) {
      actionButtons += `
        <button class="chat-review-changes-btn" data-message-id="${msg.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Review Changes
        </button>
      `;
    }
    
    // Render reasoning summary if present
    let reasoningSummary = '';
    if (msg.reasoning && !isUser) {
      // Truncate long reasoning summaries
      const maxLength = 300;
      let reasoningText = msg.reasoning;
      if (reasoningText.length > maxLength) {
        reasoningText = reasoningText.substring(0, maxLength) + '...';
      }
      reasoningSummary = `
        <div class="chat-reasoning-summary">
          <div class="chat-reasoning-summary-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Reasoning
          </div>
          <div class="chat-reasoning-summary-content">${escapeHtml(reasoningText)}</div>
        </div>
      `;
    }
    
    return `
      <div class="chat-message ${bubbleClass}">
        <div class="chat-bubble">
          ${reasoningSummary}
          ${formatMessage(msg.content)}
          ${actionButtons ? `<div class="chat-action-buttons">${actionButtons}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  // Add click handlers for review changes buttons
  messagesContainer.querySelectorAll('.chat-review-changes-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const messageId = parseInt(btn.dataset.messageId);
      openDiffViewForMessage(messageId);
    });
  });
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,      // Convert line breaks to <br>
  gfm: true,         // Enable GitHub Flavored Markdown
  headerIds: false,  // Don't add IDs to headers
  mangle: false      // Don't mangle email addresses
});

// Format message content using marked for markdown rendering
function formatMessage(content) {
  if (!content) return '';
  
  try {
    // Use marked to parse markdown
    const html = marked.parse(content);
    return html;
  } catch (e) {
    console.error('Markdown parsing error:', e);
    // Fallback to basic escaping
    return escapeHtml(content).replace(/\n/g, '<br>');
  }
}

// Handle apply action
function handleApply(action, value) {
  switch (action) {
    case 'apply-summary':
      store.update('summary', value);
      addMessage('assistant', '✓ Summary updated successfully!');
      if (onApplyCallback) onApplyCallback();
      break;
      
    default:
      console.log('Unknown apply action:', action);
  }
}

// Scroll to bottom of messages
function scrollToBottom() {
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Clear chat history
function clearHistory() {
  messages = [];
  localStorage.removeItem(STORAGE_KEY);
  renderMessages();
}

// Show help
function showHelp() {
  addMessage('assistant', `**Available Commands:**

• **/feedback** - Get detailed feedback on your resume
• **/improve summary** - Get an improved version of your summary
• **/improve [section]** - Get suggestions for a specific section
• **/generate [context]** - Generate bullet points based on context
• **/clear** - Clear chat history
• **/help** - Show this help message

**Tips:**
- You can also just type naturally and ask questions about your resume
- Click "Apply to Resume" buttons to directly update your resume
- Use the shortcut buttons below the input for quick actions`);
}

// Save chat history to localStorage
function saveChatHistory() {
  try {
    // Save current thread
    if (currentThreadId) {
      const thread = threads.find(t => t.id === currentThreadId);
      if (thread) {
        thread.messages = messages.slice(-50);
        thread.updatedAt = new Date().toISOString();
      }
    }
    saveThreads();
  } catch (e) {
    console.error('Failed to save chat history:', e);
  }
}

// Load chat history from localStorage
function loadChatHistory() {
  try {
    // Load threads
    const savedThreads = localStorage.getItem(THREADS_KEY);
    if (savedThreads) {
      threads = JSON.parse(savedThreads);
    }
    
    // If no threads exist, create a default one
    if (threads.length === 0) {
      // Migrate old single-thread history if exists
      const oldHistory = localStorage.getItem(STORAGE_KEY);
      const oldMessages = oldHistory ? JSON.parse(oldHistory) : [];
      
      createNewThread('New Chat', oldMessages);
    } else {
      // Load the most recent thread
      const mostRecent = threads.sort((a, b) => 
        new Date(b.updatedAt) - new Date(a.updatedAt)
      )[0];
      switchToThread(mostRecent.id, false);
    }
  } catch (e) {
    console.error('Failed to load chat history:', e);
    threads = [];
    createNewThread('New Chat');
  }
}

// Save threads to localStorage
function saveThreads() {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
  } catch (e) {
    console.error('Failed to save threads:', e);
  }
}

// Create a new thread
function createNewThread(name = 'New Chat', initialMessages = []) {
  const newThread = {
    id: `thread-${Date.now()}`,
    name: name,
    messages: initialMessages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  threads.unshift(newThread);
  switchToThread(newThread.id, true);
  saveThreads();
  
  return newThread;
}

// Switch to a different thread
function switchToThread(threadId, save = true) {
  // Save current thread first
  if (save && currentThreadId) {
    const current = threads.find(t => t.id === currentThreadId);
    if (current) {
      current.messages = messages.slice(-50);
      current.updatedAt = new Date().toISOString();
    }
  }
  
  // Switch to new thread
  const thread = threads.find(t => t.id === threadId);
  if (thread) {
    currentThreadId = threadId;
    messages = thread.messages || [];
    renderChatView();
    renderThreadSelector();
  }
  
  if (save) saveThreads();
}

// Delete a thread
function deleteThread(threadId) {
  const index = threads.findIndex(t => t.id === threadId);
  if (index === -1) return;
  
  threads.splice(index, 1);
  
  // If we deleted the current thread, switch to another
  if (threadId === currentThreadId) {
    if (threads.length === 0) {
      createNewThread('New Chat');
    } else {
      switchToThread(threads[0].id, false);
    }
  }
  
  saveThreads();
  renderThreadSelector();
}

// Rename a thread
function renameThread(threadId, newName) {
  const thread = threads.find(t => t.id === threadId);
  if (thread) {
    thread.name = newName;
    saveThreads();
    renderThreadSelector();
  }
}

// Get thread name from first message or default
function getThreadDisplayName(thread) {
  if (thread.name !== 'New Chat') return thread.name;
  
  // Try to get a name from the first user message
  const firstUserMsg = thread.messages?.find(m => m.role === 'user');
  if (firstUserMsg) {
    const text = firstUserMsg.content;
    return text.length > 30 ? text.substring(0, 30) + '...' : text;
  }
  
  return thread.name;
}

// Render thread selector
function renderThreadSelector() {
  const container = document.getElementById('thread-selector');
  if (!container) return;
  
  // Hide thread selector if no API keys are configured
  const configuredProviders = getConfiguredProviders();
  if (configuredProviders.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  
  // Show thread selector
  container.style.display = '';
  
  const currentThread = threads.find(t => t.id === currentThreadId);
  const currentName = currentThread ? getThreadDisplayName(currentThread) : 'New Chat';
  
  container.innerHTML = `
    <button class="thread-selector-trigger" id="thread-selector-trigger">
      <span class="thread-name">${escapeHtml(currentName)}</span>
      <svg class="thread-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="thread-selector-menu" id="thread-selector-menu">
      <div class="thread-menu-header">
        <span>Chat Threads</span>
        <button class="thread-new-btn" id="new-thread-btn" title="Start new chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
      <div class="thread-list">
        ${threads.map(thread => `
          <div class="thread-item ${thread.id === currentThreadId ? 'active' : ''}" data-thread-id="${thread.id}">
            <span class="thread-item-name">${escapeHtml(getThreadDisplayName(thread))}</span>
            <button class="thread-delete-btn" data-thread-id="${thread.id}" title="Delete thread">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  
  // Event listeners
  const trigger = document.getElementById('thread-selector-trigger');
  const menu = document.getElementById('thread-selector-menu');
  const newBtn = document.getElementById('new-thread-btn');
  
  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    
    // Position the fixed menu relative to the trigger
    if (menu && trigger) {
      const rect = trigger.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${rect.left}px`;
    }
    
    menu?.classList.toggle('open');
  });
  
  newBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    createNewThread('New Chat');
    menu?.classList.remove('open');
  });
  
  // Thread selection
  container.querySelectorAll('.thread-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.thread-delete-btn')) {
        const threadId = item.dataset.threadId;
        switchToThread(threadId);
        menu?.classList.remove('open');
      }
    });
  });
  
  // Thread deletion
  container.querySelectorAll('.thread-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const threadId = btn.dataset.threadId;
      if (threads.length > 1 || confirm('Delete this chat thread?')) {
        deleteThread(threadId);
      }
    });
  });
  
  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      menu?.classList.remove('open');
    }
  });
}

// Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Escape for attributes
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
