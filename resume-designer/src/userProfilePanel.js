/**
 * User Profile Panel
 * UI for managing user background information that the AI uses for context
 */

import { getUserProfile, saveUserProfile } from './persistence.js';

let panelContainer = null;
let currentTab = 'summary';
let profileData = null;
let saveTimeout = null;

// Default empty profile structure
const DEFAULT_PROFILE = {
  personalSummary: '',
  careerGoals: '',
  workExperience: [],
  skills: [],
  education: [],
  projects: [],
  certifications: [],
  achievements: [],
  industryKnowledge: '',
  preferences: '',
  customSections: []
};

/**
 * Initialize user profile panel
 */
export function initUserProfilePanel() {
  profileData = getUserProfile() || { ...DEFAULT_PROFILE };
  createPanel();
}

/**
 * Create the panel container (hidden by default)
 */
function createPanel() {
  if (document.getElementById('profile-panel-overlay')) return;
  
  const html = `
    <div class="profile-panel-overlay" id="profile-panel-overlay">
      <div class="profile-panel">
        <div class="profile-panel-header">
          <div class="profile-panel-title-row">
            <div>
              <h2>User Profile</h2>
              <span class="profile-panel-subtitle">Background info for AI assistance</span>
            </div>
            <div class="profile-header-actions">
              <button class="profile-import-btn" id="profile-import-btn" title="Import profile from markdown file">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Import
              </button>
              <button class="profile-export-btn" id="profile-export-btn" title="Export profile to markdown file">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export
              </button>
              <button class="profile-ai-interview-btn" id="profile-ai-interview-btn" title="Fill profile via AI interview">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                AI Interview
              </button>
              <button class="profile-panel-close" id="profile-panel-close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        
        <div class="profile-panel-tabs" id="profile-panel-tabs">
          <!-- Tabs rendered here -->
        </div>
        
        <div class="profile-panel-content" id="profile-panel-content">
          <!-- Content rendered here -->
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', html);
  panelContainer = document.getElementById('profile-panel-overlay');
  
  // Close button
  document.getElementById('profile-panel-close')?.addEventListener('click', closePanel);
  
  // Import/Export buttons
  document.getElementById('profile-import-btn')?.addEventListener('click', handleImportProfile);
  document.getElementById('profile-export-btn')?.addEventListener('click', handleExportProfile);
  
  // AI Interview button
  document.getElementById('profile-ai-interview-btn')?.addEventListener('click', startAIInterview);
  
  // Click outside to close
  panelContainer?.addEventListener('click', (e) => {
    if (e.target === panelContainer) {
      closePanel();
    }
  });
  
  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelContainer?.classList.contains('show')) {
      closePanel();
    }
  });
}

/**
 * Open the user profile panel
 */
export function openUserProfilePanel() {
  createPanel();
  profileData = getUserProfile() || { ...DEFAULT_PROFILE };
  renderTabs();
  renderContent();
  panelContainer?.classList.add('show');
  document.body.style.overflow = 'hidden';
}

/**
 * Start AI interview from profile panel
 */
function startAIInterview() {
  closePanel();
  // Small delay to let panel close animation finish
  setTimeout(() => {
    if (window.startProfileInterviewFromChat) {
      window.startProfileInterviewFromChat();
    }
  }, 200);
}

/**
 * Export profile to markdown file
 */
function handleExportProfile() {
  const markdown = profileToMarkdown(profileData);
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'user-profile.md';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import profile from markdown file
 */
function handleImportProfile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.txt';
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const imported = markdownToProfile(text);
      
      // Merge imported data with existing profile
      profileData = {
        ...DEFAULT_PROFILE,
        ...imported
      };
      
      // Save and refresh
      saveUserProfile(profileData);
      renderContent();
      showImportSuccessMessage();
    } catch (err) {
      console.error('Failed to import profile:', err);
      alert('Failed to import profile: ' + err.message);
    }
  };
  
  input.click();
}

/**
 * Show success message after import
 */
function showImportSuccessMessage() {
  const header = document.querySelector('.profile-panel-header');
  if (!header) return;
  
  let indicator = header.querySelector('.import-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'import-indicator';
    indicator.textContent = 'Profile imported successfully!';
    header.appendChild(indicator);
  }
  
  indicator.classList.add('show');
  setTimeout(() => {
    indicator.classList.remove('show');
    setTimeout(() => indicator.remove(), 300);
  }, 3000);
}

/**
 * Convert profile data to markdown format
 */
function profileToMarkdown(profile) {
  let md = `# User Profile\n\n`;
  md += `> This file contains your professional background information.\n`;
  md += `> Edit the sections below and import back into the Resume Designer.\n\n`;
  
  // Personal Summary
  md += `## Personal Summary\n\n`;
  md += `${profile.personalSummary || '_Write a 2-3 sentence professional summary about yourself..._'}\n\n`;
  
  // Career Goals
  md += `## Career Goals\n\n`;
  md += `${profile.careerGoals || '_What roles are you targeting? What are your career aspirations?_'}\n\n`;
  
  // Preferences
  md += `## Preferences\n\n`;
  md += `${profile.preferences || '_Work style preferences, industries of interest, location preferences, etc._'}\n\n`;
  
  // Work Experience
  md += `## Work Experience\n\n`;
  if (profile.workExperience && profile.workExperience.length > 0) {
    for (const exp of profile.workExperience) {
      md += `### ${exp.title || 'Job Title'} at ${exp.company || 'Company'}\n`;
      md += `**Dates:** ${exp.dates || 'Start - End'}\n\n`;
      md += `${exp.details || '_Describe your responsibilities, achievements, technologies used, team size, and impact..._'}\n\n`;
    }
  } else {
    md += `### Job Title at Company\n`;
    md += `**Dates:** Start - End\n\n`;
    md += `_Describe your responsibilities, achievements, technologies used, team size, and impact..._\n\n`;
  }
  
  // Skills
  md += `## Skills\n\n`;
  md += `| Skill | Proficiency | Years |\n`;
  md += `|-------|-------------|-------|\n`;
  if (profile.skills && profile.skills.length > 0) {
    for (const skill of profile.skills) {
      md += `| ${skill.name || 'Skill Name'} | ${skill.proficiency || 'intermediate'} | ${skill.years || ''} |\n`;
    }
  } else {
    md += `| _Skill Name_ | beginner/intermediate/advanced/expert | _Years_ |\n`;
  }
  md += `\n`;
  
  // Industry Knowledge
  md += `## Industry Knowledge\n\n`;
  md += `${profile.industryKnowledge || '_Domains, methodologies, tools, and frameworks you are familiar with..._'}\n\n`;
  
  // Education
  md += `## Education\n\n`;
  if (profile.education && profile.education.length > 0) {
    for (const edu of profile.education) {
      md += `### ${edu.degree || 'Degree/Program'} - ${edu.institution || 'Institution'}\n`;
      md += `**Dates:** ${edu.dates || 'Year'}\n\n`;
      md += `${edu.details || '_Notable courses, projects, thesis, honors, activities..._'}\n\n`;
    }
  } else {
    md += `### Degree/Program - Institution\n`;
    md += `**Dates:** Year\n\n`;
    md += `_Notable courses, projects, thesis, honors, activities..._\n\n`;
  }
  
  // Projects
  md += `## Projects\n\n`;
  if (profile.projects && profile.projects.length > 0) {
    for (const proj of profile.projects) {
      md += `### ${proj.name || 'Project Name'}\n`;
      if (proj.url) md += `**URL:** ${proj.url}\n\n`;
      md += `${proj.description || '_Describe the project, technologies used, your role, and outcomes..._'}\n\n`;
    }
  } else {
    md += `### Project Name\n`;
    md += `**URL:** https://example.com (optional)\n\n`;
    md += `_Describe the project, technologies used, your role, and outcomes..._\n\n`;
  }
  
  // Certifications
  md += `## Certifications\n\n`;
  if (profile.certifications && profile.certifications.length > 0) {
    for (const cert of profile.certifications) {
      md += `- ${cert.name || 'Certification Name'}${cert.year ? ` (${cert.year})` : ''}\n`;
    }
  } else {
    md += `- _Certification Name (Year)_\n`;
  }
  md += `\n`;
  
  // Achievements
  md += `## Achievements\n\n`;
  if (profile.achievements && profile.achievements.length > 0) {
    for (const ach of profile.achievements) {
      md += `- ${ach.description || 'Achievement description'}\n`;
    }
  } else {
    md += `- _Notable accomplishment, recognition, or award..._\n`;
  }
  md += `\n`;
  
  // Custom Sections
  md += `## Custom Sections\n\n`;
  md += `> Add any additional sections below using the format:\n`;
  md += `> ### Section Title\n`;
  md += `> Content here...\n\n`;
  if (profile.customSections && profile.customSections.length > 0) {
    for (const section of profile.customSections) {
      md += `### ${section.title || 'Section Title'}\n\n`;
      md += `${section.content || '_Content..._'}\n\n`;
    }
  }
  
  return md;
}

/**
 * Parse markdown and convert to profile data
 */
function markdownToProfile(markdown) {
  const profile = { ...DEFAULT_PROFILE };
  
  // Split into sections by h2 headers
  const sections = markdown.split(/^## /gm).slice(1);
  
  for (const section of sections) {
    const lines = section.split('\n');
    const sectionTitle = lines[0].trim().toLowerCase();
    const sectionContent = lines.slice(1).join('\n').trim();
    
    if (sectionTitle.includes('personal summary')) {
      profile.personalSummary = cleanContent(sectionContent);
    } else if (sectionTitle.includes('career goals')) {
      profile.careerGoals = cleanContent(sectionContent);
    } else if (sectionTitle.includes('preferences')) {
      profile.preferences = cleanContent(sectionContent);
    } else if (sectionTitle.includes('industry knowledge')) {
      profile.industryKnowledge = cleanContent(sectionContent);
    } else if (sectionTitle.includes('work experience')) {
      profile.workExperience = parseWorkExperience(sectionContent);
    } else if (sectionTitle.includes('skills')) {
      profile.skills = parseSkillsTable(sectionContent);
    } else if (sectionTitle.includes('education')) {
      profile.education = parseEducation(sectionContent);
    } else if (sectionTitle.includes('projects')) {
      profile.projects = parseProjects(sectionContent);
    } else if (sectionTitle.includes('certifications')) {
      profile.certifications = parseCertifications(sectionContent);
    } else if (sectionTitle.includes('achievements')) {
      profile.achievements = parseAchievements(sectionContent);
    } else if (sectionTitle.includes('custom sections')) {
      profile.customSections = parseCustomSections(sectionContent);
    }
  }
  
  return profile;
}

/**
 * Clean content by removing placeholder text and trimming
 */
function cleanContent(content) {
  // Remove placeholder text (italic text starting with underscore)
  let cleaned = content.replace(/^_[^_]+_$/gm, '').trim();
  // Remove blockquotes used for instructions
  cleaned = cleaned.replace(/^>.*$/gm, '').trim();
  return cleaned;
}

/**
 * Parse work experience from markdown
 */
function parseWorkExperience(content) {
  const experiences = [];
  const entries = content.split(/^### /gm).slice(1);
  
  for (const entry of entries) {
    const lines = entry.split('\n');
    const titleLine = lines[0].trim();
    
    // Parse "Title at Company" format
    const titleMatch = titleLine.match(/^(.+?)\s+at\s+(.+)$/i);
    const title = titleMatch ? titleMatch[1].trim() : titleLine;
    const company = titleMatch ? titleMatch[2].trim() : '';
    
    // Find dates line
    let dates = '';
    let detailsStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('**Dates:**')) {
        dates = line.replace('**Dates:**', '').trim();
        detailsStart = i + 1;
        break;
      }
    }
    
    // Rest is details
    const details = cleanContent(lines.slice(detailsStart).join('\n'));
    
    // Skip template entries
    if (title === 'Job Title' && company === 'Company' && !details) continue;
    
    if (title || company || details) {
      experiences.push({ title, company, dates, details });
    }
  }
  
  return experiences;
}

/**
 * Parse skills table from markdown
 */
function parseSkillsTable(content) {
  const skills = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    // Skip header and separator rows
    if (line.includes('---') || line.toLowerCase().includes('skill') && line.toLowerCase().includes('proficiency')) {
      continue;
    }
    
    // Parse table row: | Skill | Proficiency | Years |
    const match = line.match(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*)\s*\|/);
    if (match) {
      const name = match[1].trim().replace(/^_|_$/g, '');
      const proficiency = match[2].trim().replace(/^_|_$/g, '');
      const years = match[3].trim().replace(/^_|_$/g, '');
      
      // Skip template rows
      if (name === 'Skill Name' || name.startsWith('_')) continue;
      
      // Validate proficiency
      const validProficiencies = ['beginner', 'intermediate', 'advanced', 'expert'];
      const normalizedProficiency = validProficiencies.includes(proficiency.toLowerCase()) 
        ? proficiency.toLowerCase() 
        : '';
      
      if (name) {
        skills.push({ name, proficiency: normalizedProficiency, years });
      }
    }
  }
  
  return skills;
}

/**
 * Parse education from markdown
 */
function parseEducation(content) {
  const education = [];
  const entries = content.split(/^### /gm).slice(1);
  
  for (const entry of entries) {
    const lines = entry.split('\n');
    const titleLine = lines[0].trim();
    
    // Parse "Degree - Institution" format
    const titleMatch = titleLine.match(/^(.+?)\s*-\s*(.+)$/);
    const degree = titleMatch ? titleMatch[1].trim() : titleLine;
    const institution = titleMatch ? titleMatch[2].trim() : '';
    
    // Find dates line
    let dates = '';
    let detailsStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('**Dates:**')) {
        dates = line.replace('**Dates:**', '').trim();
        detailsStart = i + 1;
        break;
      }
    }
    
    // Rest is details
    const details = cleanContent(lines.slice(detailsStart).join('\n'));
    
    // Skip template entries
    if (degree === 'Degree/Program' && institution === 'Institution' && !details) continue;
    
    if (degree || institution || details) {
      education.push({ degree, institution, dates, details });
    }
  }
  
  return education;
}

/**
 * Parse projects from markdown
 */
function parseProjects(content) {
  const projects = [];
  const entries = content.split(/^### /gm).slice(1);
  
  for (const entry of entries) {
    const lines = entry.split('\n');
    const name = lines[0].trim();
    
    // Find URL line
    let url = '';
    let descStart = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('**URL:**')) {
        url = line.replace('**URL:**', '').trim();
        // Remove example URLs
        if (url.includes('example.com')) url = '';
        descStart = i + 1;
        break;
      }
    }
    
    // Rest is description
    const description = cleanContent(lines.slice(descStart).join('\n'));
    
    // Skip template entries
    if (name === 'Project Name' && !description) continue;
    
    if (name || description) {
      projects.push({ name, url, description });
    }
  }
  
  return projects;
}

/**
 * Parse certifications from markdown list
 */
function parseCertifications(content) {
  const certifications = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    if (!line.trim().startsWith('-')) continue;
    
    let text = line.replace(/^-\s*/, '').trim();
    
    // Skip template/placeholder lines
    if (text.startsWith('_') || text === 'Certification Name (Year)') continue;
    
    // Parse "Name (Year)" format
    const match = text.match(/^(.+?)\s*\((\d{4})\)$/);
    if (match) {
      certifications.push({ name: match[1].trim(), year: match[2] });
    } else if (text) {
      certifications.push({ name: text, year: '' });
    }
  }
  
  return certifications;
}

/**
 * Parse achievements from markdown list
 */
function parseAchievements(content) {
  const achievements = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    if (!line.trim().startsWith('-')) continue;
    
    let text = line.replace(/^-\s*/, '').trim();
    
    // Skip template/placeholder lines
    if (text.startsWith('_') || text === 'Achievement description') continue;
    
    if (text) {
      achievements.push({ description: text });
    }
  }
  
  return achievements;
}

/**
 * Parse custom sections from markdown
 */
function parseCustomSections(content) {
  const sections = [];
  
  // Remove instruction blockquotes
  const cleanedContent = content.replace(/^>.*$/gm, '').trim();
  
  const entries = cleanedContent.split(/^### /gm).slice(1);
  
  for (const entry of entries) {
    const lines = entry.split('\n');
    const title = lines[0].trim();
    const sectionContent = cleanContent(lines.slice(1).join('\n'));
    
    // Skip template entries
    if (title === 'Section Title' && !sectionContent) continue;
    
    if (title || sectionContent) {
      sections.push({ title, content: sectionContent });
    }
  }
  
  return sections;
}

/**
 * Close the user profile panel
 */
export function closePanel() {
  // Save any pending changes before closing
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveUserProfile(profileData);
  }
  panelContainer?.classList.remove('show');
  document.body.style.overflow = '';
}

/**
 * Schedule auto-save (debounced)
 */
function scheduleSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    console.log('[ProfilePanel] Auto-saving profile data:', profileData);
    saveUserProfile(profileData);
    showSaveIndicator();
    saveTimeout = null;
  }, 500);
}

/**
 * Show save indicator briefly
 */
function showSaveIndicator() {
  const header = document.querySelector('.profile-panel-header');
  if (!header) return;
  
  let indicator = header.querySelector('.save-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'save-indicator';
    indicator.textContent = 'Saved';
    header.appendChild(indicator);
  }
  
  indicator.classList.add('show');
  setTimeout(() => indicator.classList.remove('show'), 1500);
}

/**
 * Render tabs
 */
function renderTabs() {
  const container = document.getElementById('profile-panel-tabs');
  if (!container) return;
  
  const tabs = [
    { id: 'summary', label: 'Summary', icon: 'user' },
    { id: 'experience', label: 'Experience', icon: 'briefcase' },
    { id: 'skills', label: 'Skills', icon: 'star' },
    { id: 'education', label: 'Education', icon: 'book' },
    { id: 'projects', label: 'Projects', icon: 'folder' },
    { id: 'more', label: 'More', icon: 'plus' }
  ];
  
  container.innerHTML = tabs.map(tab => `
    <button class="profile-tab ${tab.id === currentTab ? 'active' : ''}" data-tab="${tab.id}">
      ${getTabIcon(tab.icon)}
      <span>${tab.label}</span>
    </button>
  `).join('');
  
  // Tab click handlers
  container.querySelectorAll('.profile-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      renderTabs();
      renderContent();
    });
  });
}

/**
 * Get tab icon SVG
 */
function getTabIcon(icon) {
  const icons = {
    user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    briefcase: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    book: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
  };
  return icons[icon] || '';
}

/**
 * Render content based on current tab
 */
function renderContent() {
  const container = document.getElementById('profile-panel-content');
  if (!container) return;
  
  switch (currentTab) {
    case 'summary':
      renderSummaryTab(container);
      break;
    case 'experience':
      renderExperienceTab(container);
      break;
    case 'skills':
      renderSkillsTab(container);
      break;
    case 'education':
      renderEducationTab(container);
      break;
    case 'projects':
      renderProjectsTab(container);
      break;
    case 'more':
      renderMoreTab(container);
      break;
  }
}

/**
 * Render Summary tab
 */
function renderSummaryTab(container) {
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Personal Summary</h3>
        <p class="profile-section-hint">Tell the AI who you are professionally. What makes you unique?</p>
      </div>
      <textarea 
        class="profile-textarea" 
        id="profile-personal-summary"
        placeholder="Example: I'm a passionate UX designer with 8 years of experience in fintech and healthcare. I specialize in complex data visualization and have led design systems initiatives at two Fortune 500 companies..."
        rows="6"
      >${escapeHtml(profileData.personalSummary || '')}</textarea>
    </div>
    
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Career Goals</h3>
        <p class="profile-section-hint">What are you looking for? What roles interest you?</p>
      </div>
      <textarea 
        class="profile-textarea" 
        id="profile-career-goals"
        placeholder="Example: I'm seeking a senior or lead UX position at a company focused on AI/ML products. I want to transition into more strategic work while still being hands-on with design..."
        rows="4"
      >${escapeHtml(profileData.careerGoals || '')}</textarea>
    </div>
    
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Preferences</h3>
        <p class="profile-section-hint">Work style, industries, salary expectations, location preferences, etc.</p>
      </div>
      <textarea 
        class="profile-textarea" 
        id="profile-preferences"
        placeholder="Example: Remote-first, interested in Series B+ startups or established tech companies. Open to contract work. Prefer collaborative environments with strong design culture..."
        rows="4"
      >${escapeHtml(profileData.preferences || '')}</textarea>
    </div>
  `;
  
  setupTextareaListeners(container, {
    'profile-personal-summary': 'personalSummary',
    'profile-career-goals': 'careerGoals',
    'profile-preferences': 'preferences'
  });
}

/**
 * Render Experience tab
 */
function renderExperienceTab(container) {
  const experiences = profileData.workExperience || [];
  
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Detailed Work Experience</h3>
        <p class="profile-section-hint">Add details beyond what's on your resume - challenges faced, technologies used, team size, impact metrics, lessons learned.</p>
      </div>
      
      <div class="profile-items" id="experience-items">
        ${experiences.length === 0 ? `
          <div class="profile-empty">
            <p>No experience entries yet</p>
            <span>Add detailed information about your work history</span>
          </div>
        ` : experiences.map((exp, i) => renderExperienceItem(exp, i)).join('')}
      </div>
      
      <button class="profile-add-btn" id="add-experience-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Experience Entry
      </button>
    </div>
  `;
  
  setupExperienceListeners(container);
}

/**
 * Render a single experience item
 */
function renderExperienceItem(exp, index) {
  return `
    <div class="profile-item" data-index="${index}">
      <div class="profile-item-header">
        <input 
          type="text" 
          class="profile-input profile-item-title" 
          placeholder="Job Title"
          value="${escapeAttr(exp.title || '')}"
          data-field="title"
        >
        <button class="profile-item-delete" data-index="${index}" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <input 
        type="text" 
        class="profile-input" 
        placeholder="Company"
        value="${escapeAttr(exp.company || '')}"
        data-field="company"
      >
      <input 
        type="text" 
        class="profile-input" 
        placeholder="Dates (e.g., Jan 2020 - Present)"
        value="${escapeAttr(exp.dates || '')}"
        data-field="dates"
      >
      <textarea 
        class="profile-textarea" 
        placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
        rows="4"
        data-field="details"
      >${escapeHtml(exp.details || '')}</textarea>
    </div>
  `;
}

/**
 * Setup experience item listeners
 */
function setupExperienceListeners(container) {
  // Add button
  container.querySelector('#add-experience-btn')?.addEventListener('click', () => {
    if (!profileData.workExperience) profileData.workExperience = [];
    profileData.workExperience.push({
      title: '',
      company: '',
      dates: '',
      details: ''
    });
    scheduleSave();
    renderContent();
  });
  
  // Delete buttons
  container.querySelectorAll('.profile-item-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      profileData.workExperience.splice(index, 1);
      scheduleSave();
      renderContent();
    });
  });
  
  // Input changes
  container.querySelectorAll('.profile-item input, .profile-item textarea').forEach(input => {
    input.addEventListener('input', () => {
      const item = input.closest('.profile-item');
      const index = parseInt(item.dataset.index);
      const field = input.dataset.field;
      if (profileData.workExperience[index]) {
        profileData.workExperience[index][field] = input.value;
        scheduleSave();
      }
    });
  });
}

/**
 * Render Skills tab
 */
function renderSkillsTab(container) {
  const skills = profileData.skills || [];
  
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Skills Inventory</h3>
        <p class="profile-section-hint">List all your skills with proficiency levels and years of experience.</p>
      </div>
      
      <div class="profile-skills-grid" id="skills-grid">
        ${skills.length === 0 ? `
          <div class="profile-empty">
            <p>No skills added yet</p>
            <span>Add your skills with proficiency levels</span>
          </div>
        ` : skills.map((skill, i) => renderSkillItem(skill, i)).join('')}
      </div>
      
      <button class="profile-add-btn" id="add-skill-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Skill
      </button>
    </div>
    
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Industry Knowledge</h3>
        <p class="profile-section-hint">Domains you've worked in, tools mastered, methodologies you follow.</p>
      </div>
      <textarea 
        class="profile-textarea" 
        id="profile-industry-knowledge"
        placeholder="Example: Deep expertise in e-commerce, SaaS, and mobile app design. Familiar with Agile/Scrum, Design Thinking, and Jobs-to-be-Done frameworks. Strong knowledge of accessibility standards (WCAG 2.1)..."
        rows="4"
      >${escapeHtml(profileData.industryKnowledge || '')}</textarea>
    </div>
  `;
  
  setupSkillsListeners(container);
}

/**
 * Render a single skill item
 */
function renderSkillItem(skill, index) {
  return `
    <div class="profile-skill-item" data-index="${index}">
      <input 
        type="text" 
        class="profile-input skill-name" 
        placeholder="Skill name"
        value="${escapeAttr(skill.name || '')}"
        data-field="name"
      >
      <select class="profile-select skill-level" data-field="proficiency">
        <option value="">Proficiency</option>
        <option value="beginner" ${skill.proficiency === 'beginner' ? 'selected' : ''}>Beginner</option>
        <option value="intermediate" ${skill.proficiency === 'intermediate' ? 'selected' : ''}>Intermediate</option>
        <option value="advanced" ${skill.proficiency === 'advanced' ? 'selected' : ''}>Advanced</option>
        <option value="expert" ${skill.proficiency === 'expert' ? 'selected' : ''}>Expert</option>
      </select>
      <input 
        type="text" 
        class="profile-input skill-years" 
        placeholder="Years"
        value="${escapeAttr(skill.years || '')}"
        data-field="years"
      >
      <button class="profile-skill-delete" data-index="${index}" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;
}

/**
 * Setup skills listeners
 */
function setupSkillsListeners(container) {
  // Add button
  container.querySelector('#add-skill-btn')?.addEventListener('click', () => {
    if (!profileData.skills) profileData.skills = [];
    profileData.skills.push({
      name: '',
      proficiency: '',
      years: ''
    });
    scheduleSave();
    renderContent();
  });
  
  // Delete buttons
  container.querySelectorAll('.profile-skill-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      profileData.skills.splice(index, 1);
      scheduleSave();
      renderContent();
    });
  });
  
  // Input changes
  container.querySelectorAll('.profile-skill-item input, .profile-skill-item select').forEach(input => {
    input.addEventListener('input', () => {
      const item = input.closest('.profile-skill-item');
      const index = parseInt(item.dataset.index);
      const field = input.dataset.field;
      if (profileData.skills[index]) {
        profileData.skills[index][field] = input.value;
        scheduleSave();
      }
    });
    input.addEventListener('change', () => {
      const item = input.closest('.profile-skill-item');
      const index = parseInt(item.dataset.index);
      const field = input.dataset.field;
      if (profileData.skills[index]) {
        profileData.skills[index][field] = input.value;
        scheduleSave();
      }
    });
  });
  
  // Industry knowledge textarea
  const industryTextarea = container.querySelector('#profile-industry-knowledge');
  industryTextarea?.addEventListener('input', () => {
    profileData.industryKnowledge = industryTextarea.value;
    scheduleSave();
  });
}

/**
 * Render Education tab
 */
function renderEducationTab(container) {
  const education = profileData.education || [];
  
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Education Details</h3>
        <p class="profile-section-hint">Include courses, projects, thesis topics, honors, extracurriculars - details beyond a typical resume.</p>
      </div>
      
      <div class="profile-items" id="education-items">
        ${education.length === 0 ? `
          <div class="profile-empty">
            <p>No education entries yet</p>
            <span>Add detailed information about your education</span>
          </div>
        ` : education.map((edu, i) => renderEducationItem(edu, i)).join('')}
      </div>
      
      <button class="profile-add-btn" id="add-education-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Education Entry
      </button>
    </div>
  `;
  
  setupEducationListeners(container);
}

/**
 * Render a single education item
 */
function renderEducationItem(edu, index) {
  return `
    <div class="profile-item" data-index="${index}">
      <div class="profile-item-header">
        <input 
          type="text" 
          class="profile-input profile-item-title" 
          placeholder="Degree / Program"
          value="${escapeAttr(edu.degree || '')}"
          data-field="degree"
        >
        <button class="profile-item-delete" data-index="${index}" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <input 
        type="text" 
        class="profile-input" 
        placeholder="Institution"
        value="${escapeAttr(edu.institution || '')}"
        data-field="institution"
      >
      <input 
        type="text" 
        class="profile-input" 
        placeholder="Dates / Year"
        value="${escapeAttr(edu.dates || '')}"
        data-field="dates"
      >
      <textarea 
        class="profile-textarea" 
        placeholder="Notable courses, projects, thesis, honors, activities, GPA if relevant..."
        rows="3"
        data-field="details"
      >${escapeHtml(edu.details || '')}</textarea>
    </div>
  `;
}

/**
 * Setup education listeners
 */
function setupEducationListeners(container) {
  // Add button
  container.querySelector('#add-education-btn')?.addEventListener('click', () => {
    if (!profileData.education) profileData.education = [];
    profileData.education.push({
      degree: '',
      institution: '',
      dates: '',
      details: ''
    });
    scheduleSave();
    renderContent();
  });
  
  // Delete buttons
  container.querySelectorAll('.profile-item-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      profileData.education.splice(index, 1);
      scheduleSave();
      renderContent();
    });
  });
  
  // Input changes
  container.querySelectorAll('.profile-item input, .profile-item textarea').forEach(input => {
    input.addEventListener('input', () => {
      const item = input.closest('.profile-item');
      const index = parseInt(item.dataset.index);
      const field = input.dataset.field;
      if (profileData.education[index]) {
        profileData.education[index][field] = input.value;
        scheduleSave();
      }
    });
  });
}

/**
 * Render Projects tab
 */
function renderProjectsTab(container) {
  const projects = profileData.projects || [];
  
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Portfolio & Projects</h3>
        <p class="profile-section-hint">Personal projects, open source contributions, side work, freelance projects - anything that showcases your abilities.</p>
      </div>
      
      <div class="profile-items" id="project-items">
        ${projects.length === 0 ? `
          <div class="profile-empty">
            <p>No projects added yet</p>
            <span>Add projects that showcase your work</span>
          </div>
        ` : projects.map((proj, i) => renderProjectItem(proj, i)).join('')}
      </div>
      
      <button class="profile-add-btn" id="add-project-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Project
      </button>
    </div>
  `;
  
  setupProjectListeners(container);
}

/**
 * Render a single project item
 */
function renderProjectItem(proj, index) {
  return `
    <div class="profile-item" data-index="${index}">
      <div class="profile-item-header">
        <input 
          type="text" 
          class="profile-input profile-item-title" 
          placeholder="Project Name"
          value="${escapeAttr(proj.name || '')}"
          data-field="name"
        >
        <button class="profile-item-delete" data-index="${index}" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <input 
        type="text" 
        class="profile-input" 
        placeholder="URL (optional)"
        value="${escapeAttr(proj.url || '')}"
        data-field="url"
      >
      <textarea 
        class="profile-textarea" 
        placeholder="Describe the project: what problem does it solve? What technologies did you use? What was your role? What was the outcome?"
        rows="4"
        data-field="description"
      >${escapeHtml(proj.description || '')}</textarea>
    </div>
  `;
}

/**
 * Setup project listeners
 */
function setupProjectListeners(container) {
  // Add button
  container.querySelector('#add-project-btn')?.addEventListener('click', () => {
    if (!profileData.projects) profileData.projects = [];
    profileData.projects.push({
      name: '',
      url: '',
      description: ''
    });
    scheduleSave();
    renderContent();
  });
  
  // Delete buttons
  container.querySelectorAll('.profile-item-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      profileData.projects.splice(index, 1);
      scheduleSave();
      renderContent();
    });
  });
  
  // Input changes
  container.querySelectorAll('.profile-item input, .profile-item textarea').forEach(input => {
    input.addEventListener('input', () => {
      const item = input.closest('.profile-item');
      const index = parseInt(item.dataset.index);
      const field = input.dataset.field;
      if (profileData.projects[index]) {
        profileData.projects[index][field] = input.value;
        scheduleSave();
      }
    });
  });
}

/**
 * Render More tab (certifications, achievements, custom sections)
 */
function renderMoreTab(container) {
  const certifications = profileData.certifications || [];
  const achievements = profileData.achievements || [];
  const customSections = profileData.customSections || [];
  
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Certifications & Training</h3>
        <p class="profile-section-hint">Professional certifications, courses, training programs.</p>
      </div>
      
      <div class="profile-items" id="cert-items">
        ${certifications.length === 0 ? `
          <div class="profile-empty small">
            <p>No certifications added</p>
          </div>
        ` : certifications.map((cert, i) => renderCertItem(cert, i)).join('')}
      </div>
      
      <button class="profile-add-btn small" id="add-cert-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Certification
      </button>
    </div>
    
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Achievements & Awards</h3>
        <p class="profile-section-hint">Notable accomplishments, recognition, awards.</p>
      </div>
      
      <div class="profile-items" id="achievement-items">
        ${achievements.length === 0 ? `
          <div class="profile-empty small">
            <p>No achievements added</p>
          </div>
        ` : achievements.map((ach, i) => renderAchievementItem(ach, i)).join('')}
      </div>
      
      <button class="profile-add-btn small" id="add-achievement-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Achievement
      </button>
    </div>
    
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Custom Sections</h3>
        <p class="profile-section-hint">Add any other information you want the AI to know about.</p>
      </div>
      
      <div class="profile-items" id="custom-items">
        ${customSections.length === 0 ? `
          <div class="profile-empty small">
            <p>No custom sections added</p>
          </div>
        ` : customSections.map((sec, i) => renderCustomSectionItem(sec, i)).join('')}
      </div>
      
      <button class="profile-add-btn small" id="add-custom-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Custom Section
      </button>
    </div>
  `;
  
  setupMoreTabListeners(container);
}

/**
 * Render certification item
 */
function renderCertItem(cert, index) {
  return `
    <div class="profile-item compact" data-index="${index}" data-type="certifications">
      <div class="profile-item-row">
        <input 
          type="text" 
          class="profile-input" 
          placeholder="Certification name"
          value="${escapeAttr(cert.name || '')}"
          data-field="name"
        >
        <input 
          type="text" 
          class="profile-input small" 
          placeholder="Year"
          value="${escapeAttr(cert.year || '')}"
          data-field="year"
        >
        <button class="profile-item-delete-small" data-index="${index}" data-type="certifications" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * Render achievement item
 */
function renderAchievementItem(ach, index) {
  return `
    <div class="profile-item compact" data-index="${index}" data-type="achievements">
      <div class="profile-item-row">
        <input 
          type="text" 
          class="profile-input" 
          placeholder="Achievement description"
          value="${escapeAttr(ach.description || '')}"
          data-field="description"
        >
        <button class="profile-item-delete-small" data-index="${index}" data-type="achievements" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * Render custom section item
 */
function renderCustomSectionItem(sec, index) {
  return `
    <div class="profile-item" data-index="${index}" data-type="customSections">
      <div class="profile-item-header">
        <input 
          type="text" 
          class="profile-input profile-item-title" 
          placeholder="Section Title"
          value="${escapeAttr(sec.title || '')}"
          data-field="title"
        >
        <button class="profile-item-delete" data-index="${index}" data-type="customSections" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
      <textarea 
        class="profile-textarea" 
        placeholder="Content..."
        rows="3"
        data-field="content"
      >${escapeHtml(sec.content || '')}</textarea>
    </div>
  `;
}

/**
 * Setup More tab listeners
 */
function setupMoreTabListeners(container) {
  // Add certification
  container.querySelector('#add-cert-btn')?.addEventListener('click', () => {
    if (!profileData.certifications) profileData.certifications = [];
    profileData.certifications.push({ name: '', year: '' });
    scheduleSave();
    renderContent();
  });
  
  // Add achievement
  container.querySelector('#add-achievement-btn')?.addEventListener('click', () => {
    if (!profileData.achievements) profileData.achievements = [];
    profileData.achievements.push({ description: '' });
    scheduleSave();
    renderContent();
  });
  
  // Add custom section
  container.querySelector('#add-custom-btn')?.addEventListener('click', () => {
    if (!profileData.customSections) profileData.customSections = [];
    profileData.customSections.push({ title: '', content: '' });
    scheduleSave();
    renderContent();
  });
  
  // Delete buttons
  container.querySelectorAll('.profile-item-delete, .profile-item-delete-small').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      const type = btn.dataset.type;
      if (profileData[type]) {
        profileData[type].splice(index, 1);
        scheduleSave();
        renderContent();
      }
    });
  });
  
  // Input changes
  container.querySelectorAll('.profile-item input, .profile-item textarea').forEach(input => {
    input.addEventListener('input', () => {
      const item = input.closest('.profile-item');
      const index = parseInt(item.dataset.index);
      const type = item.dataset.type;
      const field = input.dataset.field;
      if (profileData[type] && profileData[type][index]) {
        profileData[type][index][field] = input.value;
        scheduleSave();
      }
    });
  });
}

/**
 * Setup textarea listeners for simple text fields
 */
function setupTextareaListeners(container, fieldMap) {
  for (const [elementId, fieldName] of Object.entries(fieldMap)) {
    const textarea = container.querySelector(`#${elementId}`);
    textarea?.addEventListener('input', () => {
      profileData[fieldName] = textarea.value;
      scheduleSave();
    });
  }
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

/**
 * Escape for attributes
 */
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
