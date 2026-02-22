/**
 * Onboarding Wizard
 * Guides new users through creating their first resume
 */

import { store } from './store.js';
import { getSettings, saveSettings, getVariants, saveVariant, setCurrentVariantId, initPersistence, generateUniqueVariantName, getUserProfile, SETTINGS_UPDATED_EVENT } from './persistence.js';
import { getConfiguredProviders, getDefaultModelId, generateResumeChanges, chat, generateResumeFromProfileForJob, checkProfileHasData, getAllModels, isProviderConfigured } from './aiService.js';
import { loadVariant } from './headerBar.js';
import { refreshChatPanel } from './chatPanel.js';
import { parseResumeText } from './resumeParser.js';
import { addJobDescription } from './jobDescriptions.js';
import { renderHeaderBar } from './headerBar.js';

const ONBOARDING_KEY = 'resume-designer-onboarding-complete';

/**
 * Validate Anthropic API key
 */
async function validateAnthropicKey(key) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }]
      })
    });
    // 200 = success, 400 = bad request but key is valid
    return response.status === 200 || response.status === 400;
  } catch (e) {
    return false;
  }
}

/**
 * Validate OpenAI API key
 */
async function validateOpenAIKey(key) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    return response.status === 200;
  } catch (e) {
    return false;
  }
}

/**
 * Validate Gemini API key
 */
async function validateGeminiKey(key) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    return response.status === 200;
  } catch (e) {
    return false;
  }
}

/**
 * Show API key validation status
 */
function showApiKeyStatus(message, success) {
  const panel = document.getElementById('api-config-panel');
  if (!panel) return;
  
  // Remove existing status
  const existing = panel.querySelector('.api-key-status');
  if (existing) existing.remove();
  
  const status = document.createElement('div');
  status.className = `api-key-status ${success ? 'success' : 'error'}`;
  status.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      ${success 
        ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
        : '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'}
    </svg>
    <span>${message}</span>
  `;
  panel.appendChild(status);
}

let wizardContainer = null;
let settingsSyncListenerAttached = false;
let currentStep = 0;
let isNewResumeMode = false; // true when launched from plus button (skips API step)
let wizardData = {
  mode: null, // 'new' | 'import' | 'job'
  importText: '',
  parsedResume: null,
  jobDescriptions: [],
  aiResponses: [],
  filePreviewText: '', // Raw text extracted from file
  filePreviewParsed: null, // Parsed data from file
  filePreviewMode: false, // Whether we're showing file preview
  targetJob: null // Job description for 'job' mode
};

// Track selected model for job-based resume generation
let selectedModelForJobGeneration = null;

// Track selected reasoning level for job-based resume generation
let selectedReasoningForJobGeneration = 'medium';

function attachSettingsSyncListener() {
  if (settingsSyncListenerAttached) return;
  settingsSyncListenerAttached = true;

  window.addEventListener(SETTINGS_UPDATED_EVENT, () => {
    // Keep onboarding controls and chat availability in sync while wizard is open.
    if (wizardContainer?.classList.contains('show')) {
      renderStep();
    }
    refreshChatPanel();
  });
}

/**
 * Get available models for the model selector dropdown
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
 * Format model name for display in dropdown
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

// Interview questions for AI-guided resume creation
const INTERVIEW_QUESTIONS = [
  {
    id: 'name',
    question: "What's your full name?",
    field: 'name',
    type: 'text'
  },
  {
    id: 'title',
    question: "What's your professional title or the role you're seeking?",
    field: 'tagline',
    type: 'text'
  },
  {
    id: 'contact',
    question: "What's your email address and location (city, state)?",
    field: 'contact',
    type: 'text'
  },
  {
    id: 'summary',
    question: "Tell me about yourself in 2-3 sentences. What's your professional background and what are you looking for?",
    field: 'summary',
    type: 'textarea',
    aiAssist: true
  },
  {
    id: 'experience',
    question: "Tell me about your most recent work experience. What was your role, company, and key achievements?",
    field: 'experience',
    type: 'textarea',
    aiAssist: true
  },
  {
    id: 'skills',
    question: "What are your key skills? List them separated by commas.",
    field: 'skills',
    type: 'textarea'
  }
];

let currentQuestion = 0;
let interviewAnswers = {};

/**
 * Check if onboarding should be shown
 * @returns {boolean}
 */
export function shouldShowOnboarding() {
  console.log('[Onboarding] Checking if should show...');
  
  const variants = getVariants();
  console.log('[Onboarding] Variants:', variants);
  
  const variantList = Object.values(variants);
  console.log('[Onboarding] Variant count:', variantList.length);
  
  // Always show onboarding if there are no variants at all
  // This ensures fresh installs always get the wizard
  if (variantList.length === 0) {
    console.log('[Onboarding] No variants - SHOWING WIZARD');
    return true;
  }
  
  // Check if onboarding was previously completed
  const completed = localStorage.getItem(ONBOARDING_KEY);
  console.log('[Onboarding] Completed flag:', completed);
  if (completed === 'true') {
    console.log('[Onboarding] Already completed - NOT showing');
    return false;
  }
  
  // Show onboarding if only built-in variants exist (no user-created ones)
  const allBuiltIn = variantList.every(v => v.builtIn);
  console.log('[Onboarding] All built-in:', allBuiltIn);
  return allBuiltIn;
}

/**
 * Mark onboarding as complete
 */
export function completeOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, 'true');
}

/**
 * Reset onboarding (for testing)
 */
export function resetOnboarding() {
  localStorage.removeItem(ONBOARDING_KEY);
}

/**
 * Show the onboarding wizard
 * @param {Object} options - Optional settings
 * @param {boolean} options.skipApiKeyStep - Skip the API key configuration step (for users who already have keys configured)
 */
export function showOnboardingWizard(options = {}) {
  console.log('[Onboarding] showOnboardingWizard() called', options);
  
  const { skipApiKeyStep = false } = options;
  
  // If skipping API key step, start at step 1 (choose path)
  // Only skip if API keys are already configured
  const hasApiKeys = getConfiguredProviders().length > 0;
  const shouldSkipApiStep = skipApiKeyStep && hasApiKeys;
  
  // Track if we're in "new resume" mode (vs full onboarding)
  isNewResumeMode = shouldSkipApiStep;
  
  currentStep = shouldSkipApiStep ? 1 : 0;
  wizardData = {
    mode: null,
    importText: '',
    parsedResume: null,
    jobDescriptions: [],
    aiResponses: [],
    filePreviewText: '',
    filePreviewParsed: null,
    filePreviewMode: false,
    targetJob: null
  };
  currentQuestion = 0;
  interviewAnswers = {};
  
  try {
    attachSettingsSyncListener();
    console.log('[Onboarding] Creating wizard...');
    createWizard();
    console.log('[Onboarding] Rendering step...');
    renderStep();
    console.log('[Onboarding] Adding show class...');
    wizardContainer?.classList.add('show');
    document.body.style.overflow = 'hidden';
    console.log('[Onboarding] Wizard should be visible now');
  } catch (e) {
    console.error('[Onboarding] Error showing onboarding wizard:', e);
  }
}

/**
 * Close the onboarding wizard
 */
export function closeOnboardingWizard() {
  wizardContainer?.classList.remove('show');
  document.body.style.overflow = '';
  refreshChatPanel();
}

/**
 * Create the wizard container
 */
function createWizard() {
  // Remove existing wizard if present (to ensure fresh state)
  const existing = document.getElementById('onboarding-overlay');
  if (existing) {
    existing.remove();
  }
  
  const html = `
    <div class="onboarding-overlay" id="onboarding-overlay">
      <div class="onboarding-wizard">
        <div class="onboarding-header">
          <div class="onboarding-progress" id="onboarding-progress"></div>
        </div>
        <div class="onboarding-content" id="onboarding-content">
          <!-- Step content rendered here -->
        </div>
        <div class="onboarding-footer" id="onboarding-footer">
          <!-- Navigation buttons rendered here -->
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', html);
  wizardContainer = document.getElementById('onboarding-overlay');
}

/**
 * Render the current step
 */
function renderStep() {
  const content = document.getElementById('onboarding-content');
  const footer = document.getElementById('onboarding-footer');
  const progress = document.getElementById('onboarding-progress');
  
  if (!content || !footer || !progress) return;
  
  // Calculate step display numbers
  // Total steps: 0=API keys, 1=Choose path, 2=Import/Basic, 3=Job desc, 4=Review, 5=Final
  // In new resume wizard mode, we skip step 0 (API keys), so total is 5 instead of 6
  const totalSteps = isNewResumeMode ? 5 : 6;
  // In new resume wizard mode, step 1 should display as "Step 1", step 5 as "Step 5"
  // In onboarding mode, step 0 should display as "Step 1", step 5 as "Step 6"
  const displayStep = isNewResumeMode ? currentStep : currentStep + 1;
  
  // Keep close button if present (for new resume mode)
  const closeBtn = progress.querySelector('.wizard-close-btn');
  const closeBtnHtml = isNewResumeMode ? `
    <button class="wizard-close-btn" id="wizard-close-btn" title="Cancel">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  ` : '';
  
  progress.innerHTML = `
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${(displayStep / totalSteps) * 100}%"></div>
    </div>
    <span class="progress-text">Step ${displayStep} of ${totalSteps}</span>
    ${closeBtnHtml}
  `;
  
  // Re-attach close button handler if in new resume mode
  if (isNewResumeMode) {
    const newCloseBtn = progress.querySelector('.wizard-close-btn');
    newCloseBtn?.addEventListener('click', () => {
      closeOnboardingWizard();
    });
  }
  
  switch (currentStep) {
    case 0:
      renderApiKeyStep(content, footer);
      break;
    case 1:
      renderChoosePathStep(content, footer);
      break;
    case 2:
      if (wizardData.mode === 'import') {
        renderImportStep(content, footer);
      } else if (wizardData.mode === 'job') {
        renderJobInputStep(content, footer);
      } else {
        renderInterviewStep(content, footer);
      }
      break;
    case 3:
      renderJobDescriptionStep(content, footer);
      break;
    case 4:
      renderReviewStep(content, footer);
      break;
    case 5:
      renderFinalStep(content, footer);
      break;
  }
}

/**
 * Render API key setup step (Step 0)
 */
function renderApiKeyStep(content, footer) {
  console.log('[Onboarding] renderApiKeyStep called');
  const hasProviders = getConfiguredProviders().length > 0;
  const settings = getSettings();
  
  content.innerHTML = `
    <div class="onboarding-step api-key-step">
      <div class="welcome-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
      </div>
      <h1>Welcome to Resume Designer</h1>
      <p class="step-description">This app uses AI to help you create professional resumes. Enter at least one API key to get started.</p>
      
      <div class="api-config-panel" id="api-config-panel">
        <div class="api-input-group" id="anthropic-group">
          <label for="api-anthropic">
            <span class="provider-name">Anthropic (Claude)</span>
            <span class="provider-hint">Recommended for best results</span>
          </label>
          <div class="api-input-wrapper">
            <input type="password" id="api-anthropic" placeholder="sk-ant-api03-..." value="${settings.anthropicKey || ''}">
            <span class="api-input-status" id="anthropic-status"></span>
          </div>
        </div>
        
        <div class="api-input-group" id="openai-group">
          <label for="api-openai">
            <span class="provider-name">OpenAI (GPT)</span>
          </label>
          <div class="api-input-wrapper">
            <input type="password" id="api-openai" placeholder="sk-..." value="${settings.openaiKey || ''}">
            <span class="api-input-status" id="openai-status"></span>
          </div>
        </div>
        
        <div class="api-input-group" id="gemini-group">
          <label for="api-gemini">
            <span class="provider-name">Google (Gemini)</span>
          </label>
          <div class="api-input-wrapper">
            <input type="password" id="api-gemini" placeholder="AIza..." value="${settings.geminiKey || ''}">
            <span class="api-input-status" id="gemini-status"></span>
          </div>
        </div>
        
        <div class="api-validation-result" id="api-validation-result"></div>
      </div>
      
      <p class="api-privacy-note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        Your API keys are stored locally and never sent to our servers.
      </p>
    </div>
  `;
  
  // Footer with validate button
  footer.innerHTML = `
    <button class="btn btn-primary btn-lg" id="validate-and-continue" ${hasProviders ? '' : ''}>
      ${hasProviders ? 'Continue' : 'Validate & Continue'}
    </button>
  `;
  
  // Validate and continue handler
  const continueBtn = document.getElementById('validate-and-continue');
  if (continueBtn) {
    continueBtn.onclick = async function(e) {
      e.preventDefault();
      
      const anthropicInput = document.getElementById('api-anthropic');
      const openaiInput = document.getElementById('api-openai');
      const geminiInput = document.getElementById('api-gemini');
      const resultDiv = document.getElementById('api-validation-result');
      
      const anthropicKey = anthropicInput?.value.trim() || '';
      const openaiKey = openaiInput?.value.trim() || '';
      const geminiKey = geminiInput?.value.trim() || '';
      const enteredKeys = { anthropicKey, openaiKey, geminiKey };
      
      // Check if any keys entered
      if (!anthropicKey && !openaiKey && !geminiKey) {
        if (resultDiv) {
          resultDiv.innerHTML = `
            <div class="validation-error">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <strong>API key required</strong>
                <p>Please enter at least one API key to use AI features.</p>
              </div>
            </div>
          `;
        }
        return;
      }

      // Persist entered keys immediately so every AI entry point can use them.
      saveSettings(enteredKeys);
      refreshChatPanel();
      
      // Show loading state
      continueBtn.disabled = true;
      continueBtn.innerHTML = '<span class="btn-spinner"></span> Validating...';
      
      // Clear previous validation states
      document.querySelectorAll('.api-input-status').forEach(s => {
        s.innerHTML = '';
        s.className = 'api-input-status';
      });
      document.querySelectorAll('.api-input-group').forEach(g => {
        g.classList.remove('validated', 'invalid');
      });
      if (resultDiv) resultDiv.innerHTML = '';
      
      // Validate keys
      const errors = [];
      let validCount = 0;
      
      if (anthropicKey) {
        document.getElementById('anthropic-status').innerHTML = '<span class="status-spinner"></span>';
        const valid = await validateAnthropicKey(anthropicKey);
        const status = document.getElementById('anthropic-status');
        const group = document.getElementById('anthropic-group');
        if (valid) {
          status.innerHTML = '✓';
          status.className = 'api-input-status valid';
          group?.classList.add('validated');
          validCount++;
        } else {
          errors.push('Anthropic');
          status.innerHTML = '✗';
          status.className = 'api-input-status invalid';
          group?.classList.add('invalid');
        }
      }
      
      if (openaiKey) {
        document.getElementById('openai-status').innerHTML = '<span class="status-spinner"></span>';
        const valid = await validateOpenAIKey(openaiKey);
        const status = document.getElementById('openai-status');
        const group = document.getElementById('openai-group');
        if (valid) {
          status.innerHTML = '✓';
          status.className = 'api-input-status valid';
          group?.classList.add('validated');
          validCount++;
        } else {
          errors.push('OpenAI');
          status.innerHTML = '✗';
          status.className = 'api-input-status invalid';
          group?.classList.add('invalid');
        }
      }
      
      if (geminiKey) {
        document.getElementById('gemini-status').innerHTML = '<span class="status-spinner"></span>';
        const valid = await validateGeminiKey(geminiKey);
        const status = document.getElementById('gemini-status');
        const group = document.getElementById('gemini-group');
        if (valid) {
          status.innerHTML = '✓';
          status.className = 'api-input-status valid';
          group?.classList.add('validated');
          validCount++;
        } else {
          errors.push('Gemini');
          status.innerHTML = '✗';
          status.className = 'api-input-status invalid';
          group?.classList.add('invalid');
        }
      }
      
      // Show result and proceed
      if (validCount > 0) {
        if (resultDiv) {
          resultDiv.innerHTML = `
            <div class="validation-success">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <div>
                <strong>${validCount} API key${validCount > 1 ? 's' : ''} validated!</strong>
                <p>AI features are ready to use.</p>
              </div>
            </div>
          `;
        }
        // Proceed to next step after brief delay
        setTimeout(() => {
          currentStep = 1;
          renderStep();
        }, 1000);
      } else {
        if (resultDiv) {
          resultDiv.innerHTML = `
            <div class="validation-warning">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <strong>Could not validate key${errors.length > 1 ? 's' : ''}: ${errors.join(', ')}</strong>
                <p>We saved your keys and you can continue. You can re-check them later in Settings.</p>
              </div>
            </div>
          `;
        }
        setTimeout(() => {
          currentStep = 1;
          renderStep();
        }, 1200);
      }
    };
  }
}

/**
 * Render choose path step (Step 1)
 */
function renderChoosePathStep(content, footer) {
  console.log('[Onboarding] renderChoosePathStep called');
  
  content.innerHTML = `
    <div class="onboarding-step choose-path-step">
      <div class="welcome-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="9" y1="9" x2="15" y2="9"/>
          <line x1="9" y1="13" x2="15" y2="13"/>
          <line x1="9" y1="17" x2="12" y2="17"/>
        </svg>
      </div>
      <h1>How would you like to start?</h1>
      <p class="step-description">Choose how you'd like to create your AI-powered resume.</p>
      
      <div class="welcome-options">
        <button class="welcome-option" id="option-import">
          <div class="option-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div class="option-text">
            <h3>Import Existing Resume</h3>
            <p>Upload a PDF or paste text — AI will parse and structure your content automatically</p>
          </div>
          <div class="option-badge ai-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            AI-Powered
          </div>
        </button>
        
        <button class="welcome-option" id="option-new">
          <div class="option-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </div>
          <div class="option-text">
            <h3>Start Fresh</h3>
            <p>Answer a few questions and AI will help you craft professional content</p>
          </div>
          <div class="option-badge ai-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            AI-Powered
          </div>
        </button>
        
        <button class="welcome-option welcome-option-featured" id="option-job">
          <div class="option-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
              <line x1="12" y1="2" x2="12" y2="5"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
              <line x1="2" y1="12" x2="5" y2="12"/>
              <line x1="19" y1="12" x2="22" y2="12"/>
            </svg>
          </div>
          <div class="option-text">
            <h3>Create for Job</h3>
            <p>Generate a tailored resume from your profile, optimized for a specific job posting</p>
          </div>
          <div class="option-badge ai-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            AI-Powered
          </div>
        </button>
      </div>
    </div>
  `;
  
  // Only show back button if we're in full onboarding mode (not new resume mode)
  if (isNewResumeMode) {
    footer.innerHTML = ''; // No back button - user can use close button to cancel
  } else {
    footer.innerHTML = `
      <button class="btn btn-secondary" id="back-btn">Back</button>
    `;
    
    // Back button
    document.getElementById('back-btn')?.addEventListener('click', () => {
      currentStep = 0;
      renderStep();
    });
  }
  
  // Option handlers
  document.getElementById('option-new')?.addEventListener('click', () => {
    wizardData.mode = 'new';
    currentStep = 2;
    renderStep();
  });
  
  document.getElementById('option-import')?.addEventListener('click', () => {
    wizardData.mode = 'import';
    currentStep = 2;
    renderStep();
  });
  
  document.getElementById('option-job')?.addEventListener('click', () => {
    wizardData.mode = 'job';
    currentStep = 2;
    renderStep();
  });
}

/**
 * Render import step
 */
function renderImportStep(content, footer) {
  // Check if we're in file preview mode
  if (wizardData.filePreviewMode) {
    renderFilePreviewStep(content, footer);
    return;
  }
  
  content.innerHTML = `
    <div class="onboarding-step import-step">
      <h2>Import Your Resume</h2>
      <p>Paste your existing resume text below, or upload a file.</p>
      
      <div class="import-methods">
        <button class="import-method active" data-method="paste">Paste Text</button>
        <button class="import-method" data-method="file">Upload File</button>
      </div>
      
      <div class="import-area" id="import-paste-area">
        <textarea 
          id="import-textarea" 
          class="import-textarea" 
          placeholder="Paste your resume text here..."
          rows="15"
        >${wizardData.importText}</textarea>
      </div>
      
      <div class="import-area hidden" id="import-file-area">
        <div class="file-drop-zone" id="file-drop-zone">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p>Drop file here or click to browse</p>
          <span>Supports TXT, PDF, DOCX</span>
          <input type="file" id="file-input" accept=".txt,.pdf,.docx" hidden>
        </div>
      </div>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Back</button>
    <button class="btn btn-primary" id="next-btn">Parse Resume</button>
  `;
  
  // Method toggle
  document.querySelectorAll('.import-method').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.import-method').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const method = btn.dataset.method;
      document.getElementById('import-paste-area')?.classList.toggle('hidden', method !== 'paste');
      document.getElementById('import-file-area')?.classList.toggle('hidden', method !== 'file');
    });
  });
  
  // File drop zone
  const dropZone = document.getElementById('file-drop-zone');
  const fileInput = document.getElementById('file-input');
  
  dropZone?.addEventListener('click', () => fileInput?.click());
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone?.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) await handleFileWithPreview(file);
  });
  
  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await handleFileWithPreview(file);
  });
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    currentStep = 1; // Go back to choose path step
    renderStep();
  });
  
  document.getElementById('next-btn')?.addEventListener('click', async () => {
    const textarea = document.getElementById('import-textarea');
    const text = textarea?.value.trim();
    
    if (!text) {
      alert('Please paste or upload your resume content');
      return;
    }
    
    wizardData.importText = text;
    
    // Parse the resume using AI if available
    const btn = document.getElementById('next-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Parsing with AI...';
    }
    
    try {
      console.log('[Onboarding] Starting resume parsing...');
      wizardData.parsedResume = await parseResumeWithAI(text);
      console.log('[Onboarding] Parsed resume result:', wizardData.parsedResume);
      currentStep = 3; // Go to job descriptions step
      renderStep();
    } catch (error) {
      console.error('[Onboarding] Parse error:', error);
      alert('Failed to parse resume: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Parse Resume';
      }
    }
  });
}

/**
 * Render file preview step after uploading a file
 */
function renderFilePreviewStep(content, footer) {
  const previewText = wizardData.filePreviewText;
  
  content.innerHTML = `
    <div class="onboarding-step import-step">
      <h2>Review Extracted Text</h2>
      <p>We've extracted the following text from your file. Please review before continuing.</p>
      
      <div class="file-preview-container">
        <div class="file-preview-text">${escapeHtml(previewText)}</div>
      </div>
      
      <div class="file-preview-hint">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>If the text doesn't look right, try uploading a different file or paste the text manually.</span>
      </div>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Try Again</button>
    <button class="btn btn-primary" id="next-btn">Continue</button>
  `;
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    wizardData.filePreviewMode = false;
    wizardData.filePreviewText = '';
    renderStep();
  });
  
  document.getElementById('next-btn')?.addEventListener('click', async () => {
    console.log('[Onboarding] File preview Continue clicked');
    wizardData.importText = wizardData.filePreviewText;
    wizardData.filePreviewMode = false;
    
    const btn = document.getElementById('next-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Parsing with AI...';
    }
    
    try {
      console.log('[Onboarding] Starting AI resume parsing from file preview...');
      wizardData.parsedResume = await parseResumeWithAI(wizardData.filePreviewText);
      console.log('[Onboarding] AI parsing complete:', wizardData.parsedResume);
      currentStep = 3; // Go to job descriptions step
      renderStep();
    } catch (error) {
      console.error('[Onboarding] AI parsing failed:', error);
      alert('Failed to parse resume: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Continue';
      }
    }
  });
}

/**
 * Handle uploaded file with preview screen
 */
async function handleFileWithPreview(file) {
  const { parseResumeFile } = await import('./resumeParser.js');
  
  const dropZone = document.getElementById('file-drop-zone');
  if (dropZone) {
    dropZone.innerHTML = `
      <div class="file-loading">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="spinner">
          <circle cx="12" cy="12" r="10" opacity="0.3"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
        <p>Extracting text...</p>
      </div>
    `;
  }
  
  try {
    const result = await parseResumeFile(file);
    
    // Store the extracted text and show preview
    wizardData.filePreviewText = result.text;
    wizardData.filePreviewMode = true;
    renderStep();
  } catch (error) {
    alert('Failed to read file: ' + error.message);
    renderStep(); // Re-render to reset the drop zone
  }
}

/**
 * Parse resume text using AI if available
 */
async function parseResumeWithAI(text) {
  console.log('[Onboarding] parseResumeWithAI called');
  const providers = getConfiguredProviders();
  console.log('[Onboarding] Available AI providers:', providers);
  
  // If no AI available, fall back to basic parsing
  if (providers.length === 0) {
    console.log('[Onboarding] No AI providers configured, using basic parsing');
    return parseResumeText(text);
  }
  
  console.log('[Onboarding] Using AI to parse resume...');
  
  const settings = getSettings();
  const modelId = getDefaultModelId();
  
  try {
    const response = await chat(modelId, [{
      role: 'user',
      content: `Parse this resume text and extract structured information. Return ONLY a valid JSON object (no markdown, no explanation) with this structure:
{
  "name": "Full Name",
  "tagline": "Professional Title",
  "email": "email@example.com",
  "phone": "phone number",
  "location": "City, State",
  "linkedin": "linkedin url if present",
  "portfolio": "portfolio url if present",
  "summary": "Professional summary paragraph",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "location": "Location",
      "startDate": "Start Date",
      "endDate": "End Date or Present",
      "bullets": ["Achievement 1", "Achievement 2"]
    }
  ],
  "education": [
    {
      "degree": "Degree Name",
      "school": "School Name",
      "year": "Graduation Year"
    }
  ],
  "skills": ["Skill 1", "Skill 2"],
  "sections": []
}

Resume text:
${text}`
    }], false);
    
    // Handle response - can be string or object with text property
    const responseText = typeof response === 'string' ? response : (response?.text || response?.response || '');
    
    // Parse the JSON response
    try {
      // Clean up the response - remove markdown code blocks if present
      let jsonStr = responseText.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const parsed = JSON.parse(jsonStr);
      return parsed;
    } catch (parseError) {
      console.warn('AI response was not valid JSON, falling back to basic parsing');
      return parseResumeText(text);
    }
  } catch (error) {
    console.warn('AI parsing failed, falling back to basic parsing:', error);
    return parseResumeText(text);
  }
}


/**
 * Render interview step (for new resume)
 */
function renderInterviewStep(content, footer) {
  const question = INTERVIEW_QUESTIONS[currentQuestion];
  const hasProviders = getConfiguredProviders().length > 0;
  
  content.innerHTML = `
    <div class="onboarding-step interview-step">
      <div class="interview-progress">
        <span>Question ${currentQuestion + 1} of ${INTERVIEW_QUESTIONS.length}</span>
        <div class="interview-dots">
          ${INTERVIEW_QUESTIONS.map((_, i) => `
            <span class="dot ${i < currentQuestion ? 'completed' : i === currentQuestion ? 'active' : ''}"></span>
          `).join('')}
        </div>
      </div>
      
      <h2>${question.question}</h2>
      
      ${question.type === 'textarea' ? `
        <textarea 
          id="interview-input" 
          class="interview-textarea" 
          placeholder="Type your answer..."
          rows="6"
        >${interviewAnswers[question.id] || ''}</textarea>
      ` : `
        <input 
          type="text" 
          id="interview-input" 
          class="interview-input" 
          placeholder="Type your answer..."
          value="${interviewAnswers[question.id] || ''}"
        >
      `}
      
      ${question.aiAssist && hasProviders ? `
        <button class="ai-assist-btn" id="ai-assist-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
          Help me improve this with AI
        </button>
      ` : ''}
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">${currentQuestion === 0 ? 'Back' : 'Previous'}</button>
    <button class="btn btn-primary" id="next-btn">${currentQuestion === INTERVIEW_QUESTIONS.length - 1 ? 'Continue' : 'Next'}</button>
  `;
  
  // Focus input
  setTimeout(() => document.getElementById('interview-input')?.focus(), 100);
  
  // AI assist
  document.getElementById('ai-assist-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('interview-input');
    const value = input?.value.trim();
    if (!value) {
      alert('Please enter some text first');
      return;
    }
    
    const settings = getSettings();
    const modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5';
    
    try {
      const response = await chat(modelId, [{
        role: 'user',
        content: `I'm writing my resume. Here's my answer to "${question.question}": "${value}". Please improve this to be more professional and impactful for a resume. Return only the improved text, no explanation.`
      }], false);
      
      if (input) input.value = response.trim();
    } catch (error) {
      alert('AI assistance failed: ' + error.message);
    }
  });
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    if (currentQuestion === 0) {
      currentStep = 1; // Go back to choose path step
      renderStep();
    } else {
      currentQuestion--;
      renderStep();
    }
  });
  
  document.getElementById('next-btn')?.addEventListener('click', () => {
    const input = document.getElementById('interview-input');
    const value = input?.value.trim();
    
    if (!value && question.id !== 'summary') {
      alert('Please provide an answer');
      return;
    }
    
    interviewAnswers[question.id] = value;
    
    if (currentQuestion < INTERVIEW_QUESTIONS.length - 1) {
      currentQuestion++;
      renderStep();
    } else {
      // Build resume from answers
      buildResumeFromInterview();
      currentStep = 3; // Go to job descriptions step
      renderStep();
    }
  });
}

/**
 * Build resume data from interview answers
 */
function buildResumeFromInterview() {
  // Parse contact info
  let email = '', location = '';
  const contactMatch = (interviewAnswers.contact || '').match(/([^\s,]+@[^\s,]+)/);
  if (contactMatch) email = contactMatch[1];
  
  const locMatch = (interviewAnswers.contact || '').replace(email, '').trim();
  location = locMatch || '';
  
  // Parse skills
  const skills = (interviewAnswers.skills || '').split(',').map(s => s.trim()).filter(s => s);
  
  wizardData.parsedResume = {
    name: interviewAnswers.name || 'Your Name',
    tagline: interviewAnswers.title || 'Professional Title',
    email,
    location,
    summary: interviewAnswers.summary || '',
    sections: skills.length > 0 ? [{
      title: 'Skills',
      content: skills
    }] : [],
    experience: interviewAnswers.experience ? [{
      title: 'Position',
      company: 'Company',
      dates: 'Present',
      bullets: [interviewAnswers.experience]
    }] : [],
    education: []
  };
}

/**
 * Render job input step for 'job' mode (Create for Job flow)
 * This is a dedicated step where user enters the target job description
 */
function renderJobInputStep(content, footer) {
  // Check if user has profile data
  const hasProfileData = checkProfileHasData();
  
  if (!hasProfileData) {
    // Show warning that profile is needed
    content.innerHTML = `
      <div class="onboarding-step job-input-step">
        <div class="profile-warning">
          <div class="warning-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <h2>Profile Needed</h2>
          <p class="warning-description">
            To create a tailored resume from a job description, we need your background information. 
            Please fill out your profile first with your work experience, skills, and education.
          </p>
          <div class="warning-actions">
            <button class="btn btn-primary" id="open-profile-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              Open My Profile
            </button>
          </div>
          <p class="warning-hint">
            After filling out your profile, come back here to create a tailored resume.
          </p>
        </div>
      </div>
    `;
    
    footer.innerHTML = `
      <button class="btn btn-secondary" id="back-btn">Back</button>
    `;
    
    document.getElementById('back-btn')?.addEventListener('click', () => {
      currentStep = 1;
      renderStep();
    });
    
    document.getElementById('open-profile-btn')?.addEventListener('click', () => {
      closeOnboardingWizard();
      // Open profile panel
      if (window.openUserProfilePanel) {
        window.openUserProfilePanel();
      }
    });
    
    return;
  }
  
  // User has profile data - show job input form
  const existingJob = wizardData.targetJob || {};
  const availableModels = getAvailableModelsForSelector();
  const settings = getSettings();
  const defaultModel = selectedModelForJobGeneration || settings.defaultModel || getDefaultModelId();
  
  content.innerHTML = `
    <div class="onboarding-step job-input-step">
      <div class="step-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="3"/>
          <line x1="12" y1="2" x2="12" y2="5"/>
          <line x1="12" y1="19" x2="12" y2="22"/>
          <line x1="2" y1="12" x2="5" y2="12"/>
          <line x1="19" y1="12" x2="22" y2="12"/>
        </svg>
      </div>
      <h2>Target Job Details</h2>
      <p class="step-description">
        Paste the job description below. AI will analyze it and create a resume from your profile 
        that's perfectly tailored for this role.
      </p>
      
      <div class="job-input-form">
        <div class="input-row">
          <div class="input-group">
            <label for="job-title-input">Job Title</label>
            <input 
              type="text" 
              id="job-title-input" 
              class="job-input" 
              placeholder="e.g. Senior Software Engineer"
              value="${escapeHtml(existingJob.title || '')}"
            >
          </div>
          <div class="input-group">
            <label for="job-company-input">Company</label>
            <input 
              type="text" 
              id="job-company-input" 
              class="job-input" 
              placeholder="e.g. Google"
              value="${escapeHtml(existingJob.company || '')}"
            >
          </div>
        </div>
        
        <div class="input-group">
          <label for="job-desc-input">Job Description</label>
          <textarea 
            id="job-desc-input" 
            class="job-textarea" 
            placeholder="Paste the full job description here..."
            rows="10"
          >${escapeHtml(existingJob.description || '')}</textarea>
        </div>
        
        <button class="paste-clipboard-btn" id="paste-clipboard-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Paste from Clipboard
        </button>
        
        <div class="job-ai-options">
          <div class="job-model-selector">
            <label for="job-model-select">Model</label>
            <select id="job-model-select" class="job-model-select">
              ${availableModels.map(m => `
                <option value="${m.id}" ${m.id === defaultModel ? 'selected' : ''}>
                  ${escapeHtml(m.label)}
                </option>
              `).join('')}
            </select>
          </div>
          
          <div class="job-reasoning-selector">
            <label for="job-reasoning-select">Reasoning</label>
            <select id="job-reasoning-select" class="job-reasoning-select">
              <option value="none" ${selectedReasoningForJobGeneration === 'none' ? 'selected' : ''}>Off</option>
              <option value="low" ${selectedReasoningForJobGeneration === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${selectedReasoningForJobGeneration === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${selectedReasoningForJobGeneration === 'high' ? 'selected' : ''}>High</option>
            </select>
          </div>
        </div>
      </div>
      
      <div class="job-input-benefits">
        <div class="benefit-item">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>AI extracts key requirements and skills</span>
        </div>
        <div class="benefit-item">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Resume tailored with matching keywords</span>
        </div>
        <div class="benefit-item">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Experience prioritized for this role</span>
        </div>
      </div>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Back</button>
    <button class="btn btn-primary" id="generate-btn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
      Generate Resume
    </button>
  `;
  
  // Paste from clipboard
  document.getElementById('paste-clipboard-btn')?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const textarea = document.getElementById('job-desc-input');
      if (textarea && text) {
        textarea.value = text;
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      alert('Unable to access clipboard. Please paste manually using Ctrl+V / Cmd+V.');
    }
  });
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    // Save current input state
    wizardData.targetJob = {
      title: document.getElementById('job-title-input')?.value.trim() || '',
      company: document.getElementById('job-company-input')?.value.trim() || '',
      description: document.getElementById('job-desc-input')?.value.trim() || ''
    };
    currentStep = 1;
    renderStep();
  });
  
  // Generate resume
  document.getElementById('generate-btn')?.addEventListener('click', async () => {
    const title = document.getElementById('job-title-input')?.value.trim();
    const company = document.getElementById('job-company-input')?.value.trim();
    const description = document.getElementById('job-desc-input')?.value.trim();
    
    if (!description) {
      alert('Please paste a job description');
      return;
    }
    
    // Save the job description
    wizardData.targetJob = {
      title: title || 'Target Role',
      company: company || 'Company',
      description
    };
    
    // Also add to job descriptions list for future reference
    wizardData.jobDescriptions = [wizardData.targetJob];
    
    // Get the selected model from dropdown
    const modelSelect = document.getElementById('job-model-select');
    const selectedModel = modelSelect?.value || getDefaultModelId();
    selectedModelForJobGeneration = selectedModel; // Save for future use
    
    // Get the selected reasoning level from dropdown
    const reasoningSelect = document.getElementById('job-reasoning-select');
    const selectedReasoning = reasoningSelect?.value || 'medium';
    selectedReasoningForJobGeneration = selectedReasoning; // Save for future use
    
    const btn = document.getElementById('generate-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span> AI is creating your resume...';
    }
    
    try {
      // Generate resume from profile using selected model
      if (!selectedModel) {
        throw new Error('No AI model configured');
      }
      
      console.log('[Onboarding] Using model:', selectedModel, 'with reasoning:', selectedReasoning);
      wizardData.parsedResume = await generateResumeFromProfileForJob(selectedModel, wizardData.targetJob, { reasoningEffort: selectedReasoning });
      console.log('[Onboarding] Generated resume from profile:', wizardData.parsedResume);
      
      // Skip the optional JD step (step 3) since we already have the JD
      currentStep = 4; // Go directly to review step
      renderStep();
    } catch (error) {
      console.error('[Onboarding] Failed to generate resume:', error);
      alert('Failed to generate resume: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          Generate Resume
        `;
      }
    }
  });
}

/**
 * Render job description step
 */
function renderJobDescriptionStep(content, footer) {
  content.innerHTML = `
    <div class="onboarding-step jd-step">
      <h2>Target a Specific Job</h2>
      <p class="jd-explanation">
        <strong>Why add a job description?</strong> AI will analyze the job requirements and tailor your resume to highlight your most relevant skills and experience, making you stand out as the ideal candidate.
      </p>
      
      <div class="jd-benefits">
        <div class="jd-benefit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Customized summary targeting the role</span>
        </div>
        <div class="jd-benefit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Highlights that match key requirements</span>
        </div>
        <div class="jd-benefit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Keywords from the job posting</span>
        </div>
      </div>
      
      <div class="jd-input-area">
        <input type="text" id="jd-title-input" class="jd-input-small" placeholder="Job Title (e.g. Senior Designer)">
        <input type="text" id="jd-company-input" class="jd-input-small" placeholder="Company Name">
        <textarea id="jd-desc-input" class="jd-textarea-small" placeholder="Paste the full job description here..." rows="5"></textarea>
        <button class="btn btn-primary" id="add-jd-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add This Job
        </button>
      </div>
      
      ${wizardData.jobDescriptions.length > 0 ? `
        <div class="jd-list-preview" id="jd-list-preview">
          <h4>Target Jobs Added:</h4>
          ${wizardData.jobDescriptions.map((jd, i) => `
            <div class="jd-preview-item">
              <div class="jd-preview-info">
                <strong>${escapeHtml(jd.title)}</strong>
                <span>at ${escapeHtml(jd.company)}</span>
              </div>
              <button class="jd-remove-btn" data-index="${i}">&times;</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
  
  const hasJobs = wizardData.jobDescriptions.length > 0;
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Back</button>
    <button class="btn ${hasJobs ? 'btn-primary' : 'btn-secondary'}" id="next-btn">
      ${hasJobs ? `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        Tailor My Resume
      ` : 'Skip for Now'}
    </button>
  `;
  
  // Add JD
  document.getElementById('add-jd-btn')?.addEventListener('click', () => {
    const title = document.getElementById('jd-title-input')?.value.trim();
    const company = document.getElementById('jd-company-input')?.value.trim();
    const desc = document.getElementById('jd-desc-input')?.value.trim();
    
    if (!desc) {
      alert('Please paste a job description');
      return;
    }
    
    wizardData.jobDescriptions.push({
      title: title || 'Target Role',
      company: company || 'Company',
      description: desc
    });
    
    // Clear inputs
    document.getElementById('jd-title-input').value = '';
    document.getElementById('jd-company-input').value = '';
    document.getElementById('jd-desc-input').value = '';
    
    renderStep();
  });
  
  // Remove JD
  document.querySelectorAll('.jd-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      wizardData.jobDescriptions.splice(index, 1);
      renderStep();
    });
  });
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    if (wizardData.mode === 'new') {
      currentQuestion = INTERVIEW_QUESTIONS.length - 1;
    }
    currentStep = 2; // Go back to import/interview step
    renderStep();
  });
  
  document.getElementById('next-btn')?.addEventListener('click', async () => {
    // Save job descriptions
    for (const jd of wizardData.jobDescriptions) {
      addJobDescription(jd);
    }
    
    // If job descriptions were added, use AI to tailor the resume
    if (wizardData.jobDescriptions.length > 0 && getConfiguredProviders().length > 0) {
      const btn = document.getElementById('next-btn');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-spinner"></span> AI is tailoring your resume...';
      }
      
      try {
        await tailorResumeWithAI();
      } catch (error) {
        console.error('[Onboarding] AI tailoring failed:', error);
        // Continue anyway with the parsed resume
      }
      
      if (btn) {
        btn.disabled = false;
      }
    }
    
    currentStep = 4; // Go to review step
    renderStep();
  });
}

/**
 * Use AI to tailor the resume based on job descriptions
 */
async function tailorResumeWithAI() {
  const modelId = getDefaultModelId();
  if (!modelId) return;
  
  const resume = wizardData.parsedResume || {};
  const jobs = wizardData.jobDescriptions;
  
  if (jobs.length === 0) return;
  
  // Build job context
  const jobContext = jobs.map(j => `
Job Title: ${j.title}
Company: ${j.company}
Description: ${j.description}
`).join('\n---\n');

  // Build resume context
  const resumeContext = `
Name: ${resume.name || 'Not provided'}
Current Title: ${resume.tagline || 'Not provided'}
Summary: ${resume.summary || 'Not provided'}
Skills: ${(resume.skills || []).join(', ') || 'Not provided'}
Experience: ${(resume.experience || []).map(e => `${e.title} at ${e.company}`).join('; ') || 'Not provided'}
`;

  const prompt = `You are helping tailor a resume for specific job applications. Based on the resume and target job(s) below, create:

1. A compelling professional SUMMARY (2-3 sentences) that positions the candidate as ideal for the target role(s)
2. A HIGHLIGHTS section (4-6 bullet points) showcasing the most relevant achievements and skills for these jobs
3. Identify KEY SKILLS that match the job requirements

Resume Information:
${resumeContext}

Target Job(s):
${jobContext}

Return ONLY valid JSON (no markdown, no explanation):
{
  "summary": "Professional summary tailored to the target role...",
  "highlights": [
    "Key achievement or skill relevant to the job",
    "Another relevant highlight",
    "..."
  ],
  "relevantSkills": ["skill1", "skill2", "skill3"]
}`;

  try {
    const response = await chat(modelId, [{ role: 'user', content: prompt }], false);
    const responseText = typeof response === 'string' ? response : (response?.text || response?.response || '');
    
    // Parse JSON response
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    
    const tailored = JSON.parse(jsonStr);
    
    // Update the parsed resume with tailored content
    if (tailored.summary) {
      wizardData.parsedResume.summary = tailored.summary;
    }
    if (tailored.highlights && tailored.highlights.length > 0) {
      wizardData.parsedResume.highlights = tailored.highlights;
    }
    if (tailored.relevantSkills && tailored.relevantSkills.length > 0) {
      // Merge with existing skills
      const existingSkills = wizardData.parsedResume.skills || [];
      const allSkills = [...new Set([...tailored.relevantSkills, ...existingSkills])];
      wizardData.parsedResume.skills = allSkills;
    }
    
    console.log('[Onboarding] Resume tailored with AI:', tailored);
  } catch (error) {
    console.error('[Onboarding] Failed to tailor resume:', error);
    throw error;
  }
}

/**
 * Render review step
 */
function renderReviewStep(content, footer) {
  const resume = wizardData.parsedResume;
  console.log('[Onboarding] Review step - resume data:', resume);
  
  // Check if we have meaningful data
  const hasName = resume?.name && resume.name !== 'Not set';
  const hasTagline = resume?.tagline && resume.tagline !== 'Not set';
  const hasSummary = resume?.summary;
  const hasHighlights = resume?.highlights?.length > 0;
  const hasExperience = resume?.experience?.length > 0;
  const hasSkills = resume?.skills?.length > 0;
  const isTailored = wizardData.jobDescriptions.length > 0;
  
  content.innerHTML = `
    <div class="onboarding-step review-step">
      <h2>${isTailored ? 'Your Tailored Resume' : 'Review Your Resume'}</h2>
      <p>${isTailored ? 'AI has customized your resume for your target role. Here\'s what we created:' : 'Here\'s what we extracted. You can edit everything in the main app.'}</p>
      
      <div class="resume-preview-card ${isTailored ? 'tailored' : ''}">
        <div class="preview-section">
          <label>Name</label>
          <p class="${!hasName ? 'not-set' : ''}">${escapeHtml(resume?.name || 'Not detected')}</p>
        </div>
        
        <div class="preview-section">
          <label>Title</label>
          <p class="${!hasTagline ? 'not-set' : ''}">${escapeHtml(resume?.tagline || 'Not detected')}</p>
        </div>
        
        ${hasSummary ? `
          <div class="preview-section ${isTailored ? 'ai-generated' : ''}">
            <label>
              ${isTailored ? '<span class="ai-badge-inline">✨ AI</span>' : ''}
              Summary
            </label>
            <p>${escapeHtml(resume.summary)}</p>
          </div>
        ` : ''}
        
        ${hasHighlights ? `
          <div class="preview-section ai-generated">
            <label>
              <span class="ai-badge-inline">✨ AI</span>
              Highlights
            </label>
            <ul class="highlights-list">
              ${resume.highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        
        ${hasSkills ? `
          <div class="preview-section ${isTailored ? 'ai-generated' : ''}">
            <label>
              ${isTailored ? '<span class="ai-badge-inline">✨ AI</span>' : ''}
              Key Skills
            </label>
            <p class="skills-list">${resume.skills.slice(0, 10).map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}${resume.skills.length > 10 ? '<span class="more-skills">+' + (resume.skills.length - 10) + ' more</span>' : ''}</p>
          </div>
        ` : ''}
        
        ${hasExperience ? `
          <div class="preview-section">
            <label>Experience (${resume.experience.length} positions)</label>
            ${resume.experience.slice(0, 3).map(exp => `
              <div class="preview-exp">
                <strong>${escapeHtml(exp.title || 'Position')}</strong>
                <span>${escapeHtml(exp.company || 'Company')}</span>
              </div>
            `).join('')}
            ${resume.experience.length > 3 ? `<span class="more-items">+${resume.experience.length - 3} more</span>` : ''}
          </div>
        ` : ''}
        
        ${resume?.education?.length > 0 ? `
          <div class="preview-section">
            <label>Education</label>
            ${resume.education.slice(0, 2).map(edu => `
              <div class="preview-exp">
                <strong>${escapeHtml(typeof edu === 'string' ? edu : (edu.degree || 'Degree'))}</strong>
                ${typeof edu !== 'string' ? `<span>${escapeHtml(edu.school || '')}</span>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
      
      ${!hasSummary && !hasHighlights ? `
        <div class="parse-warning">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>Add a target job in the previous step to get AI-generated summary and highlights.</span>
        </div>
      ` : ''}
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Back</button>
    <button class="btn btn-primary" id="next-btn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Create My Resume
    </button>
  `;
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    // For 'job' mode, go back to job input step; for others, go to job descriptions step
    if (wizardData.mode === 'job') {
      currentStep = 2; // Go back to job input step
    } else {
      currentStep = 3; // Go back to job descriptions step
    }
    renderStep();
  });
  
  document.getElementById('next-btn')?.addEventListener('click', async () => {
    // Save job descriptions for 'job' mode (since we skip step 3)
    if (wizardData.mode === 'job' && wizardData.jobDescriptions.length > 0) {
      for (const jd of wizardData.jobDescriptions) {
        addJobDescription(jd);
      }
    }
    
    // Save the resume as a new variant
    const resume = wizardData.parsedResume || {};
    const variantId = `custom-${Date.now()}`;
    
    // Generate variant name based on mode
    let baseName;
    if (wizardData.mode === 'job' && wizardData.targetJob) {
      // For job-based resumes, use job title and company name
      const jobTitle = wizardData.targetJob.title || 'Role';
      const company = wizardData.targetJob.company || '';
      baseName = company ? `${jobTitle} - ${company}` : jobTitle;
    } else {
      // For other modes, use the person's name
      baseName = resume.name || 'My Resume';
    }
    const variantName = generateUniqueVariantName(baseName);
    
    // Transform education from objects to strings if needed
    let educationLines = [];
    if (resume.education && resume.education.length > 0) {
      educationLines = resume.education.map(edu => {
        if (typeof edu === 'string') return edu;
        // Format: "Degree - School (Year)"
        const parts = [];
        if (edu.degree) parts.push(edu.degree);
        if (edu.school) parts.push(edu.school);
        if (edu.year) parts.push(`(${edu.year})`);
        return parts.join(' - ') || 'Education';
      });
    }
    
    // Build sections array
    const sections = [];
    
    // Add highlights section first if present (most important for tailored resumes)
    if (resume.highlights && resume.highlights.length > 0) {
      sections.push({
        id: 'highlights',
        title: 'Highlights',
        content: resume.highlights.map(h => `- ${h}`)
      });
    }
    
    // Add skills as a section if present
    if (resume.skills && resume.skills.length > 0) {
      sections.push({
        id: 'skills',
        title: 'Skills',
        content: [resume.skills.join(' • ')]
      });
    }
    
    // Add certifications as a section if present
    if (resume.certifications && resume.certifications.length > 0) {
      sections.push({
        id: 'certifications',
        title: 'Certifications',
        content: resume.certifications.map(c => typeof c === 'string' ? c : c.name || c)
      });
    }
    
    // Add any other sections from parsing
    if (resume.sections && resume.sections.length > 0) {
      for (const section of resume.sections) {
        // Avoid duplicates
        if (!sections.some(s => s.title?.toLowerCase() === section.title?.toLowerCase())) {
          sections.push(section);
        }
      }
    }
    
    // Ensure we have a valid resume structure matching renderer expectations
    const resumeData = {
      name: resume.name || 'Your Name',
      tagline: resume.tagline || 'Professional Title',
      summary: resume.summary || '',
      contact: {
        email: resume.email || '',
        phone: resume.phone || '',
        location: resume.location || '',
        linkedin: resume.linkedin || '',
        portfolio: resume.portfolio || ''
      },
      experience: resume.experience || [],
      education: educationLines,
      sections: sections
    };
    
    console.log('[Onboarding] Saving variant:', variantId, resumeData);
    
    // Save variant using persistence function (id, name, data)
    saveVariant(variantId, variantName, resumeData);
    
    // Load the new variant properly (this sets current ID, initializes persistence, and triggers callbacks)
    loadVariant(variantId);
    
    // Refresh the header bar dropdown to show the new variant
    renderHeaderBar();
    
    currentStep = 5; // Go to final step
    renderStep();
  });
}

/**
 * Render final step
 */
function renderFinalStep(content, footer) {
  content.innerHTML = `
    <div class="onboarding-step final-step">
      <div class="success-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
      </div>
      <h1>Your Resume is Ready!</h1>
      <p>You can now edit, style, and export your resume.</p>
      
      <div class="final-tips">
        <div class="tip">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span>Click any text on the resume to edit it directly</span>
        </div>
        <div class="tip">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span>Use the AI Assistant to help improve your content</span>
        </div>
        <div class="tip">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
          <span>Open the Edit panel on the right to reorganize sections</span>
        </div>
      </div>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-primary btn-lg" id="finish-btn">Start Editing</button>
  `;
  
  document.getElementById('finish-btn')?.addEventListener('click', () => {
    completeOnboarding();
    closeOnboardingWizard();
    
    // Refresh the chat panel to recognize the new API keys
    refreshChatPanel();
    
    // Ensure the resume is rendered by triggering a custom event
    window.dispatchEvent(new CustomEvent('resume-ready'));
  });
}

/**
 * Set value at path
 */
function setByPath(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined) {
      current[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    current = current[part];
  }
  
  current[parts[parts.length - 1]] = value;
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
