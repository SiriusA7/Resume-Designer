/**
 * Persistence Layer
 * Handles localStorage auto-save and JSON/Markdown export/import
 */

import { store, generateId } from './store.js';
import { parseResume } from './parser.js';

const STORAGE_KEY = 'resume-designer-data';
export const SETTINGS_UPDATED_EVENT = 'resume-designer-settings-updated';

// Storage structure
const DEFAULT_STORAGE = {
  variants: {},
  currentVariantId: null,
  settings: {
    colorPalette: 'terracotta',
    layout: 'sidebar',
    customColor: '#c45c3e',
    anthropicKey: '',
    openaiKey: '',
    geminiKey: '',
    defaultModel: 'anthropic:claude-sonnet-4-5',
    chatPanelWidth: 320
  },
  userProfile: {
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
  }
};

// Load all data from localStorage
export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load from localStorage:', e);
  }
  return { ...DEFAULT_STORAGE };
}

// Save all data to localStorage
export function saveToStorage(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
    return false;
  }
}

// Get all variants
export function getVariants() {
  const storage = loadFromStorage();
  return storage.variants || {};
}

// Get current variant ID
export function getCurrentVariantId() {
  const storage = loadFromStorage();
  return storage.currentVariantId;
}

// Set current variant ID
export function setCurrentVariantId(id) {
  const storage = loadFromStorage();
  storage.currentVariantId = id;
  saveToStorage(storage);
}

// Save a variant
export function saveVariant(id, name, data) {
  const storage = loadFromStorage();
  const existingVariant = storage.variants[id];
  const now = new Date().toISOString();
  
  storage.variants[id] = {
    id,
    name,
    data,
    createdAt: existingVariant?.createdAt || now, // Preserve original creation time
    updatedAt: now,
    // Preserve job analysis data if it exists
    jobAnalysis: existingVariant?.jobAnalysis || null,
    analysisUpdatedAt: existingVariant?.analysisUpdatedAt || null
  };
  saveToStorage(storage);
}

// Generate a unique variant name based on the person's name
export function generateUniqueVariantName(baseName, variants = null) {
  if (!variants) {
    variants = getVariants();
  }
  
  const variantList = Object.values(variants);
  const baseNameLower = baseName.toLowerCase().trim();
  
  // Find all variants with names starting with the base name
  const matchingNames = variantList
    .map(v => v.name.toLowerCase())
    .filter(name => name === baseNameLower || name.startsWith(baseNameLower + ' ('));
  
  if (matchingNames.length === 0) {
    return baseName;
  }
  
  // Find the next available number
  let maxNum = 1;
  const numPattern = /\((\d+)\)$/;
  
  for (const name of matchingNames) {
    const match = name.match(numPattern);
    if (match) {
      maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
  }
  
  // If base name exists without a number, start at 2
  if (matchingNames.includes(baseNameLower)) {
    return `${baseName} (${maxNum + 1})`;
  }
  
  return `${baseName} (${maxNum + 1})`;
}

// Delete a variant
export function deleteVariant(id) {
  const storage = loadFromStorage();
  delete storage.variants[id];
  
  // If deleted variant was current, switch to another
  if (storage.currentVariantId === id) {
    const variantIds = Object.keys(storage.variants);
    storage.currentVariantId = variantIds.length > 0 ? variantIds[0] : null;
  }
  
  saveToStorage(storage);
  return storage.currentVariantId;
}

// Rename a variant
export function renameVariant(id, newName) {
  const storage = loadFromStorage();
  if (storage.variants[id]) {
    storage.variants[id].name = newName;
    storage.variants[id].updatedAt = new Date().toISOString();
    saveToStorage(storage);
  }
}

// Save job analysis results for a specific variant
export function saveVariantAnalysis(variantId, analysis) {
  const storage = loadFromStorage();
  if (storage.variants[variantId]) {
    storage.variants[variantId].jobAnalysis = analysis;
    storage.variants[variantId].analysisUpdatedAt = new Date().toISOString();
    saveToStorage(storage);
  }
}

// Get job analysis results for a specific variant
export function getVariantAnalysis(variantId) {
  const storage = loadFromStorage();
  const variant = storage.variants[variantId];
  return variant?.jobAnalysis || null;
}

// Clear job analysis results for a specific variant
export function clearVariantAnalysis(variantId) {
  const storage = loadFromStorage();
  if (storage.variants[variantId]) {
    storage.variants[variantId].jobAnalysis = null;
    storage.variants[variantId].analysisUpdatedAt = null;
    saveToStorage(storage);
  }
}

// Save settings
export function saveSettings(settings) {
  const storage = loadFromStorage();
  storage.settings = { ...storage.settings, ...settings };
  saveToStorage(storage);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, {
      detail: { settings: storage.settings }
    }));
  }
}

// Get settings
export function getSettings() {
  const storage = loadFromStorage();
  return storage.settings || DEFAULT_STORAGE.settings;
}

// Get user profile
export function getUserProfile() {
  const storage = loadFromStorage();
  const profile = storage.userProfile || DEFAULT_STORAGE.userProfile;
  console.log('[Persistence] getUserProfile returning:', profile);
  return profile;
}

// Save user profile
export function saveUserProfile(profile) {
  console.log('[Persistence] saveUserProfile called with:', profile);
  const storage = loadFromStorage();
  storage.userProfile = { ...DEFAULT_STORAGE.userProfile, ...profile };
  console.log('[Persistence] Saving userProfile:', storage.userProfile);
  const success = saveToStorage(storage);
  console.log('[Persistence] Save success:', success);
}

// Initialize persistence - connect store to auto-save
export function initPersistence(variantId) {
  store.onSave((data) => {
    if (variantId) {
      const storage = loadFromStorage();
      const variant = storage.variants[variantId];
      if (variant) {
        saveVariant(variantId, variant.name, data);
      }
    }
  });
}

// Export resume as JSON
export function exportAsJSON(data, filename) {
  const json = JSON.stringify(data, null, 2);
  downloadFile(json, filename || 'resume.json', 'application/json');
}

// Export resume as Markdown
export function exportAsMarkdown(data, filename) {
  const markdown = generateMarkdown(data);
  downloadFile(markdown, filename || 'resume.md', 'text/markdown');
}

// Generate markdown from resume data
function generateMarkdown(data) {
  let md = '';
  
  // Header
  md += `# ${data.name}\n\n`;
  md += `**${data.tagline}**\n\n`;
  
  // Contact
  const contactParts = [];
  if (data.contact?.location) contactParts.push(data.contact.location);
  if (data.contact?.email) contactParts.push(data.contact.email);
  if (data.contact?.phone) contactParts.push(data.contact.phone);
  if (data.contact?.portfolio) contactParts.push(`Portfolio: ${data.contact.portfolio}`);
  if (data.contact?.instagram) contactParts.push(`Instagram: ${data.contact.instagram}`);
  if (contactParts.length > 0) {
    md += contactParts.join(' • ') + '\n\n';
  }
  
  // Summary
  if (data.summary) {
    md += `## Summary\n\n${data.summary}\n\n`;
  }
  
  // Sections (skills, highlights, etc.)
  if (data.sections && data.sections.length > 0) {
    for (const section of data.sections) {
      md += `## ${section.title}\n\n`;
      if (Array.isArray(section.content)) {
        if (section.type === 'list' || section.type === 'highlights') {
          for (const item of section.content) {
            md += `- ${item}\n`;
          }
        } else {
          md += section.content.join(' • ') + '\n';
        }
      }
      md += '\n';
    }
  }
  
  // Tools
  if (data.tools) {
    md += `## Tools\n\n${data.tools}\n\n`;
  }
  
  // Experience
  if (data.experience && data.experience.length > 0) {
    md += `## Experience\n\n`;
    for (const exp of data.experience) {
      md += `### ${exp.title} — ${exp.company} **${exp.dates}**\n\n`;
      if (exp.bullets && exp.bullets.length > 0) {
        for (const bullet of exp.bullets) {
          md += `- ${bullet}\n`;
        }
      }
      md += '\n';
    }
  }
  
  // Education
  if (data.education && data.education.length > 0) {
    md += `## Education\n\n`;
    for (const edu of data.education) {
      md += `${edu}\n`;
    }
    md += '\n';
  }
  
  return md;
}

// Download file utility
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Import from JSON file
export async function importFromJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Basic validation
        if (!data.name || !data.contact) {
          throw new Error('Invalid resume JSON format');
        }
        resolve(data);
      } catch (err) {
        reject(new Error('Failed to parse JSON: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// Import from Markdown file
export async function importFromMarkdown(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const markdown = e.target.result;
        const data = parseResume(markdown);
        resolve(data);
      } catch (err) {
        reject(new Error('Failed to parse Markdown: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// Import file (auto-detect format)
export async function importFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  
  if (extension === 'json') {
    return importFromJSON(file);
  } else if (extension === 'md' || extension === 'markdown') {
    return importFromMarkdown(file);
  } else {
    throw new Error('Unsupported file format. Please use .json or .md files.');
  }
}

// Migrate built-in variants to storage (first-time setup)
export async function migrateBuiltInVariants(variants) {
  const storage = loadFromStorage();
  
  // Only migrate if no variants exist
  if (Object.keys(storage.variants).length > 0) {
    return false;
  }
  
  // In Electron, we don't pre-load built-in variants since they require file:// protocol handling
  // Users will create or import their own resumes via the onboarding wizard
  const isElectron = typeof window !== 'undefined' && window.electron?.isElectron === true;
  if (isElectron) {
    // Skip migration in Electron - let user start fresh with wizard
    return false;
  }
  
  for (const variant of variants) {
    try {
      const response = await fetch(`/resumes/${variant.file}`);
      if (response.ok) {
        const markdown = await response.text();
        const data = parseResume(markdown);
        const id = generateId('variant');
        const now = new Date().toISOString();
        storage.variants[id] = {
          id,
          name: variant.name,
          data,
          builtIn: true,
          createdAt: now,
          updatedAt: now
        };
        
        // Set first as current
        if (!storage.currentVariantId) {
          storage.currentVariantId = id;
        }
      }
    } catch (e) {
      console.error(`Failed to migrate variant ${variant.name}:`, e);
    }
  }
  
  saveToStorage(storage);
  return true;
}
