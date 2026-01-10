/**
 * Chat Panel
 * AI chat interface with message history and actions
 */

import { chat, rewriteText, generateBullets, getFeedback, improveSummary, isProviderConfigured } from './aiService.js';
import { getSettings, saveSettings } from './persistence.js';
import { store } from './store.js';

let messagesContainer;
let inputEl;
let sendBtn;
let modelSelect;
let messages = [];
let isLoading = false;
let onApplyCallback = null;
let isPanelOpen = false;

const STORAGE_KEY = 'resume-designer-chat-history';

// AI Model options
const AI_MODELS = [
  { group: 'Anthropic', options: [
    { value: 'anthropic:claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'anthropic:claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' }
  ]},
  { group: 'OpenAI', options: [
    { value: 'openai:gpt-4o', label: 'GPT-4o' },
    { value: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' }
  ]},
  { group: 'Google', options: [
    { value: 'gemini:gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini:gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
  ]}
];

let currentModel = 'anthropic:claude-sonnet-4-20250514';

// Initialize chat panel
export function initChatPanel(onApply) {
  messagesContainer = document.getElementById('chat-messages');
  inputEl = document.getElementById('chat-input');
  sendBtn = document.getElementById('chat-send-btn');
  modelSelect = document.getElementById('ai-model-select');
  onApplyCallback = onApply;
  
  if (!messagesContainer || !inputEl || !sendBtn) return;
  
  // Load saved model preference
  const settings = getSettings();
  if (settings.defaultModel) {
    currentModel = settings.defaultModel;
  }
  
  // Initialize custom model dropdown
  initModelDropdown();
  
  // Load chat history
  loadChatHistory();
  
  // Set up event listeners
  setupEventListeners();
  
  // Set up panel toggle
  setupPanelToggle();
  
  // Render initial state
  renderMessages();
}

// Initialize custom model dropdown
function initModelDropdown() {
  const selectorContainer = document.querySelector('.chat-model-selector');
  if (!selectorContainer) return;
  
  // Get current model label
  const currentModelLabel = getModelLabel(currentModel);
  
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
        ${AI_MODELS.map(group => `
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
        `).join('')}
      </div>
    </div>
  `;
  
  selectorContainer.innerHTML = dropdownHTML;
  
  // Setup dropdown events
  const dropdown = document.getElementById('model-dropdown');
  const trigger = dropdown?.querySelector('.custom-dropdown-trigger');
  const menu = dropdown?.querySelector('.custom-dropdown-menu');
  
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
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown?.contains(e.target)) {
      dropdown?.classList.remove('open');
    }
  });
}

// Get model label from value
function getModelLabel(value) {
  for (const group of AI_MODELS) {
    for (const opt of group.options) {
      if (opt.value === value) return opt.label;
    }
  }
  return value;
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

// Open chat panel with a message pre-filled
export function openChatWithContext(context, elementPath) {
  togglePanel(true);
  
  if (inputEl && context) {
    // Pre-fill input with context reference
    const prefix = `Regarding the text "${context.substring(0, 50)}${context.length > 50 ? '...' : ''}": `;
    inputEl.value = prefix;
    inputEl.dataset.contextPath = elementPath || '';
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
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
}

// Handle send message
async function handleSend() {
  const text = inputEl?.value.trim();
  if (!text || isLoading) return;
  
  // Check for commands
  if (text.startsWith('/')) {
    await handleCommand(text);
    return;
  }
  
  // Add user message
  addMessage('user', text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  
  // Get AI response
  await getAIResponse(text);
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
async function getAIResponse(userMessage) {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    // Build conversation history (last 10 messages for context)
    const conversationHistory = messages
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));
    
    const response = await chat(modelId, conversationHistory, true);
    addMessage('assistant', response);
  } catch (error) {
    addMessage('error', error.message);
  } finally {
    setLoading(false);
  }
}

// Get AI feedback
async function getAIFeedback() {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    const response = await getFeedback(modelId);
    addMessage('assistant', response);
  } catch (error) {
    addMessage('error', error.message);
  } finally {
    setLoading(false);
  }
}

// Get AI summary improvement
async function getAIImproveSummary() {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    const response = await improveSummary(modelId);
    // Add with apply button for summary
    addMessage('assistant', response, { action: 'apply-summary', value: response });
  } catch (error) {
    addMessage('error', error.message);
  } finally {
    setLoading(false);
  }
}

// Get AI generated bullets
async function getAIGenerateBullets(context) {
  const modelId = currentModel;
  
  setLoading(true);
  
  try {
    const response = await generateBullets(modelId, context, 3);
    addMessage('assistant', response);
  } catch (error) {
    addMessage('error', error.message);
  } finally {
    setLoading(false);
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

// Set loading state
function setLoading(loading) {
  isLoading = loading;
  sendBtn.disabled = loading;
  
  // Update toggle button indicator
  updateToggleIndicator(loading);
  
  if (loading) {
    // Add loading indicator
    const loadingEl = document.createElement('div');
    loadingEl.className = 'chat-loading';
    loadingEl.id = 'chat-loading';
    loadingEl.innerHTML = `
      <div class="chat-loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Thinking...</span>
    `;
    messagesContainer.appendChild(loadingEl);
    scrollToBottom();
  } else {
    // Remove loading indicator
    document.getElementById('chat-loading')?.remove();
  }
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
    
    let applyButton = '';
    if (msg.applyData) {
      applyButton = `
        <button class="chat-apply-btn" data-action="${msg.applyData.action}" data-value="${escapeAttr(msg.applyData.value)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Apply to Resume
        </button>
      `;
    }
    
    return `
      <div class="chat-message ${bubbleClass}">
        <div class="chat-bubble">
          ${formatMessage(msg.content)}
          ${applyButton}
        </div>
      </div>
    `;
  }).join('');
}

// Format message content (basic markdown support)
function formatMessage(content) {
  // Escape HTML first
  let formatted = escapeHtml(content);
  
  // Convert markdown-style formatting
  // Bold
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Code blocks
  formatted = formatted.replace(/```(\w+)?\n([\s\S]+?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Line breaks
  formatted = formatted.replace(/\n/g, '<br>');
  // Numbered lists
  formatted = formatted.replace(/^(\d+)\.\s+(.+)$/gm, '<li>$2</li>');
  // Bullet lists
  formatted = formatted.replace(/^[•\-]\s+(.+)$/gm, '<li>$1</li>');
  
  return formatted;
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
    // Only save last 50 messages
    const toSave = messages.slice(-50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.error('Failed to save chat history:', e);
  }
}

// Load chat history from localStorage
function loadChatHistory() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      messages = JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load chat history:', e);
    messages = [];
  }
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
