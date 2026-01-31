/**
 * User Profile Panel
 * UI for managing user background information that the AI uses for context
 */

import { getUserProfile, saveUserProfile } from './persistence.js';

let panelContainer = null;
let currentTab = 'contact';
let profileData = null;
let saveTimeout = null;

// Default empty profile structure
const DEFAULT_PROFILE = {
  // Contact information
  contactInfo: {
    fullName: '',
    email: '',
    phone: '',
    location: '',
    linkedin: '',
    portfolio: '',
    github: '',
    twitter: '',
    instagram: ''
  },
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
    { id: 'contact', label: 'Contact', icon: 'contact' },
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
    contact: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
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
    case 'contact':
      renderContactTab(container);
      break;
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
 * Render Contact tab
 */
function renderContactTab(container) {
  // Ensure contactInfo exists with all fields
  if (!profileData.contactInfo) {
    profileData.contactInfo = {
      fullName: '',
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      portfolio: '',
      github: '',
      twitter: '',
      instagram: ''
    };
  }
  
  const contact = profileData.contactInfo;
  
  container.innerHTML = `
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Basic Information</h3>
        <p class="profile-section-hint">Your name and contact details for resumes</p>
      </div>
      
      <div class="profile-contact-grid">
        <div class="profile-input-group">
          <label for="profile-fullname">Full Name</label>
          <input 
            type="text" 
            class="profile-input" 
            id="profile-fullname"
            placeholder="e.g. John Smith"
            value="${escapeHtml(contact.fullName || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-email">Email</label>
          <input 
            type="email" 
            class="profile-input" 
            id="profile-email"
            placeholder="e.g. john@example.com"
            value="${escapeHtml(contact.email || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-phone">Phone</label>
          <input 
            type="tel" 
            class="profile-input" 
            id="profile-phone"
            placeholder="e.g. (555) 123-4567"
            value="${escapeHtml(contact.phone || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-location">Location</label>
          <input 
            type="text" 
            class="profile-input" 
            id="profile-location"
            placeholder="e.g. San Francisco, CA"
            value="${escapeHtml(contact.location || '')}"
          >
        </div>
      </div>
    </div>
    
    <div class="profile-section">
      <div class="profile-section-header">
        <h3>Online Presence</h3>
        <p class="profile-section-hint">Links to your professional profiles and portfolio</p>
      </div>
      
      <div class="profile-contact-grid">
        <div class="profile-input-group">
          <label for="profile-linkedin">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            LinkedIn
          </label>
          <input 
            type="url" 
            class="profile-input" 
            id="profile-linkedin"
            placeholder="e.g. linkedin.com/in/johnsmith"
            value="${escapeHtml(contact.linkedin || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-portfolio">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Portfolio / Website
          </label>
          <input 
            type="url" 
            class="profile-input" 
            id="profile-portfolio"
            placeholder="e.g. johnsmith.com"
            value="${escapeHtml(contact.portfolio || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-github">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            GitHub
          </label>
          <input 
            type="url" 
            class="profile-input" 
            id="profile-github"
            placeholder="e.g. github.com/johnsmith"
            value="${escapeHtml(contact.github || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-twitter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            Twitter / X
          </label>
          <input 
            type="url" 
            class="profile-input" 
            id="profile-twitter"
            placeholder="e.g. twitter.com/johnsmith"
            value="${escapeHtml(contact.twitter || '')}"
          >
        </div>
        
        <div class="profile-input-group">
          <label for="profile-instagram">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
            Instagram
          </label>
          <input 
            type="url" 
            class="profile-input" 
            id="profile-instagram"
            placeholder="e.g. instagram.com/johnsmith"
            value="${escapeHtml(contact.instagram || '')}"
          >
        </div>
      </div>
    </div>
  `;
  
  // Setup input listeners for contact fields
  setupContactInputListeners(container);
}

/**
 * Setup listeners for contact info inputs
 */
function setupContactInputListeners(container) {
  const fieldMappings = {
    'profile-fullname': 'fullName',
    'profile-email': 'email',
    'profile-phone': 'phone',
    'profile-location': 'location',
    'profile-linkedin': 'linkedin',
    'profile-portfolio': 'portfolio',
    'profile-github': 'github',
    'profile-twitter': 'twitter',
    'profile-instagram': 'instagram'
  };
  
  for (const [inputId, fieldName] of Object.entries(fieldMappings)) {
    const input = container.querySelector(`#${inputId}`);
    if (input) {
      input.addEventListener('input', () => {
        if (!profileData.contactInfo) {
          profileData.contactInfo = {};
        }
        profileData.contactInfo[fieldName] = input.value;
        scheduleSave();
      });
    }
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
