/**
 * Onboarding Wizard
 * Guides new users through creating their first resume
 */

import { store } from './store.js';
import { getSettings, saveSettings, getVariants, saveVariant, setCurrentVariantId, initPersistence } from './persistence.js';
import { getConfiguredProviders, generateResumeChanges, chat } from './aiService.js';
import { loadVariant } from './variantManager.js';
import { parseResumeText } from './resumeParser.js';
import { addJobDescription } from './jobDescriptions.js';

const ONBOARDING_KEY = 'resume-designer-onboarding-complete';

let wizardContainer = null;
let currentStep = 0;
let wizardData = {
  mode: null, // 'new' | 'import'
  importText: '',
  parsedResume: null,
  jobDescriptions: [],
  aiResponses: []
};

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
  const completed = localStorage.getItem(ONBOARDING_KEY);
  if (completed === 'true') return false;
  
  const variants = getVariants();
  // Show onboarding if no custom variants exist (only built-in or empty)
  return variants.length === 0 || variants.every(v => v.isBuiltIn);
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
 */
export function showOnboardingWizard() {
  currentStep = 0;
  wizardData = {
    mode: null,
    importText: '',
    parsedResume: null,
    jobDescriptions: [],
    aiResponses: []
  };
  currentQuestion = 0;
  interviewAnswers = {};
  
  createWizard();
  renderStep();
  wizardContainer?.classList.add('show');
  document.body.style.overflow = 'hidden';
}

/**
 * Close the onboarding wizard
 */
export function closeOnboardingWizard() {
  wizardContainer?.classList.remove('show');
  document.body.style.overflow = '';
}

/**
 * Create the wizard container
 */
function createWizard() {
  if (document.getElementById('onboarding-overlay')) {
    wizardContainer = document.getElementById('onboarding-overlay');
    return;
  }
  
  const html = `
    <div class="onboarding-overlay" id="onboarding-overlay">
      <div class="onboarding-wizard">
        <div class="onboarding-header">
          <div class="onboarding-progress" id="onboarding-progress"></div>
          <button class="onboarding-skip" id="onboarding-skip">Skip for now</button>
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
  
  // Skip button
  document.getElementById('onboarding-skip')?.addEventListener('click', () => {
    if (confirm('Skip the setup wizard? You can always create or import a resume later.')) {
      completeOnboarding();
      closeOnboardingWizard();
    }
  });
}

/**
 * Render the current step
 */
function renderStep() {
  const content = document.getElementById('onboarding-content');
  const footer = document.getElementById('onboarding-footer');
  const progress = document.getElementById('onboarding-progress');
  
  if (!content || !footer || !progress) return;
  
  // Update progress indicator
  const totalSteps = wizardData.mode === 'new' ? 5 : 4;
  progress.innerHTML = `
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${((currentStep + 1) / totalSteps) * 100}%"></div>
    </div>
    <span class="progress-text">Step ${currentStep + 1} of ${totalSteps}</span>
  `;
  
  switch (currentStep) {
    case 0:
      renderWelcomeStep(content, footer);
      break;
    case 1:
      if (wizardData.mode === 'import') {
        renderImportStep(content, footer);
      } else {
        renderInterviewStep(content, footer);
      }
      break;
    case 2:
      renderJobDescriptionStep(content, footer);
      break;
    case 3:
      renderReviewStep(content, footer);
      break;
    case 4:
      renderFinalStep(content, footer);
      break;
  }
}

/**
 * Render welcome step
 */
function renderWelcomeStep(content, footer) {
  content.innerHTML = `
    <div class="onboarding-step welcome-step">
      <div class="welcome-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="9" y1="9" x2="15" y2="9"/>
          <line x1="9" y1="13" x2="15" y2="13"/>
          <line x1="9" y1="17" x2="12" y2="17"/>
        </svg>
      </div>
      <h1>Welcome to Resume Designer</h1>
      <p>Let's create your perfect resume. How would you like to get started?</p>
      
      <div class="welcome-options">
        <button class="welcome-option" id="option-new">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <div class="option-text">
            <h3>Start Fresh</h3>
            <p>I'll guide you through creating a resume from scratch</p>
          </div>
        </button>
        
        <button class="welcome-option" id="option-import">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <div class="option-text">
            <h3>Import Existing</h3>
            <p>I have an existing resume to import and improve</p>
          </div>
        </button>
      </div>
      
      ${!getConfiguredProviders().length ? `
        <div class="welcome-api-notice">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>Configure an AI API key in settings to enable AI-powered suggestions</span>
        </div>
      ` : ''}
    </div>
  `;
  
  footer.innerHTML = '';
  
  // Option handlers
  document.getElementById('option-new')?.addEventListener('click', () => {
    wizardData.mode = 'new';
    currentStep = 1;
    renderStep();
  });
  
  document.getElementById('option-import')?.addEventListener('click', () => {
    wizardData.mode = 'import';
    currentStep = 1;
    renderStep();
  });
}

/**
 * Render import step
 */
function renderImportStep(content, footer) {
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
    if (file) await handleFile(file);
  });
  
  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await handleFile(file);
  });
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    currentStep = 0;
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
    
    // Parse the resume
    try {
      wizardData.parsedResume = await parseResumeText(text);
      currentStep = 2;
      renderStep();
    } catch (error) {
      alert('Failed to parse resume: ' + error.message);
    }
  });
}

/**
 * Handle uploaded file
 */
async function handleFile(file) {
  const { parseResumeFile } = await import('./resumeParser.js');
  
  try {
    const result = await parseResumeFile(file);
    wizardData.importText = result.text;
    wizardData.parsedResume = result.parsed;
    
    // Update textarea
    const textarea = document.getElementById('import-textarea');
    if (textarea) textarea.value = result.text;
    
    // Show paste area with content
    document.querySelectorAll('.import-method').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-method="paste"]')?.classList.add('active');
    document.getElementById('import-paste-area')?.classList.remove('hidden');
    document.getElementById('import-file-area')?.classList.add('hidden');
  } catch (error) {
    alert('Failed to read file: ' + error.message);
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
    const modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5-20251022';
    
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
      currentStep = 0;
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
      currentStep = 2;
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
 * Render job description step
 */
function renderJobDescriptionStep(content, footer) {
  content.innerHTML = `
    <div class="onboarding-step jd-step">
      <h2>Add Target Jobs (Optional)</h2>
      <p>Add job descriptions you're targeting to get AI-powered suggestions for tailoring your resume.</p>
      
      <div class="jd-input-area">
        <input type="text" id="jd-title-input" class="jd-input-small" placeholder="Job Title">
        <input type="text" id="jd-company-input" class="jd-input-small" placeholder="Company">
        <textarea id="jd-desc-input" class="jd-textarea-small" placeholder="Paste job description..." rows="4"></textarea>
        <button class="btn btn-secondary" id="add-jd-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Job
        </button>
      </div>
      
      <div class="jd-list-preview" id="jd-list-preview">
        ${wizardData.jobDescriptions.length === 0 ? `
          <p class="jd-empty-hint">No jobs added yet. This step is optional.</p>
        ` : wizardData.jobDescriptions.map((jd, i) => `
          <div class="jd-preview-item">
            <div class="jd-preview-info">
              <strong>${escapeHtml(jd.title)}</strong>
              <span>${escapeHtml(jd.company)}</span>
            </div>
            <button class="jd-remove-btn" data-index="${i}">&times;</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Back</button>
    <button class="btn btn-primary" id="next-btn">${wizardData.jobDescriptions.length > 0 ? 'Analyze & Continue' : 'Skip & Continue'}</button>
  `;
  
  // Add JD
  document.getElementById('add-jd-btn')?.addEventListener('click', () => {
    const title = document.getElementById('jd-title-input')?.value.trim();
    const company = document.getElementById('jd-company-input')?.value.trim();
    const desc = document.getElementById('jd-desc-input')?.value.trim();
    
    if (!desc) {
      alert('Please enter a job description');
      return;
    }
    
    wizardData.jobDescriptions.push({
      title: title || 'Untitled',
      company: company || 'Unknown',
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
    currentStep = 1;
    renderStep();
  });
  
  document.getElementById('next-btn')?.addEventListener('click', () => {
    // Save job descriptions
    for (const jd of wizardData.jobDescriptions) {
      addJobDescription(jd);
    }
    
    currentStep = 3;
    renderStep();
  });
}

/**
 * Render review step
 */
function renderReviewStep(content, footer) {
  const resume = wizardData.parsedResume;
  
  content.innerHTML = `
    <div class="onboarding-step review-step">
      <h2>Review Your Resume</h2>
      <p>Here's what we've captured. You can edit everything after setup.</p>
      
      <div class="resume-preview-card">
        <div class="preview-section">
          <label>Name</label>
          <p>${escapeHtml(resume?.name || 'Not set')}</p>
        </div>
        
        <div class="preview-section">
          <label>Title</label>
          <p>${escapeHtml(resume?.tagline || 'Not set')}</p>
        </div>
        
        ${resume?.summary ? `
          <div class="preview-section">
            <label>Summary</label>
            <p>${escapeHtml(resume.summary)}</p>
          </div>
        ` : ''}
        
        ${resume?.experience?.length > 0 ? `
          <div class="preview-section">
            <label>Experience</label>
            ${resume.experience.map(exp => `
              <div class="preview-exp">
                <strong>${escapeHtml(exp.title || 'Position')}</strong>
                <span>${escapeHtml(exp.company || 'Company')}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        ${resume?.sections?.length > 0 ? `
          <div class="preview-section">
            <label>Additional Sections</label>
            ${resume.sections.map(s => `
              <div class="preview-section-item">
                <strong>${escapeHtml(s.title)}</strong>
                <span>${Array.isArray(s.content) ? s.content.length + ' items' : 'Content'}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
      
      ${wizardData.jobDescriptions.length > 0 && getConfiguredProviders().length > 0 ? `
        <div class="ai-tailor-prompt">
          <p>Would you like AI to help tailor this resume for your target jobs?</p>
          <button class="btn btn-primary" id="ai-tailor-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
            Tailor with AI
          </button>
        </div>
      ` : ''}
    </div>
  `;
  
  footer.innerHTML = `
    <button class="btn btn-secondary" id="back-btn">Back</button>
    <button class="btn btn-primary" id="next-btn">Create Resume</button>
  `;
  
  // AI tailor
  document.getElementById('ai-tailor-btn')?.addEventListener('click', async () => {
    const settings = getSettings();
    const modelId = settings.defaultModel || 'anthropic:claude-sonnet-4-5-20251022';
    
    const btn = document.getElementById('ai-tailor-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = 'Analyzing...';
    }
    
    try {
      const result = await generateResumeChanges(
        modelId,
        'Improve this resume to better match the target job descriptions. Enhance the summary, add relevant keywords, and strengthen experience descriptions.',
        null,
        { jobDescriptions: wizardData.jobDescriptions }
      );
      
      if (result.changes && Object.keys(result.changes).length > 0) {
        // Apply changes to parsed resume
        for (const [path, value] of Object.entries(result.changes)) {
          setByPath(wizardData.parsedResume, path, value);
        }
        
        alert('AI suggestions applied! Review the updated resume.');
        renderStep();
      } else {
        alert('No changes suggested. Your resume looks good!');
      }
    } catch (error) {
      alert('AI tailoring failed: ' + error.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
          Tailor with AI
        `;
      }
    }
  });
  
  // Navigation
  document.getElementById('back-btn')?.addEventListener('click', () => {
    currentStep = 2;
    renderStep();
  });
  
  document.getElementById('next-btn')?.addEventListener('click', async () => {
    // Save the resume as a new variant
    const resume = wizardData.parsedResume;
    const variantId = `custom-${Date.now()}`;
    const variantName = resume?.name || 'My Resume';
    
    // Save variant using persistence function (id, name, data)
    saveVariant(variantId, variantName, resume);
    
    // Set as current and load it
    setCurrentVariantId(variantId);
    initPersistence(variantId);
    loadVariant(variantId);
    
    currentStep = 4;
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
