/**
 * Job Descriptions Module
 * CRUD operations for job descriptions with localStorage persistence
 */

const STORAGE_KEY = 'resume-designer-job-descriptions';

// In-memory cache of job descriptions
let jobDescriptions = [];

/**
 * Initialize job descriptions from localStorage
 */
export function initJobDescriptions() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      jobDescriptions = JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load job descriptions:', e);
    jobDescriptions = [];
  }
  return jobDescriptions;
}

/**
 * Save job descriptions to localStorage
 */
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobDescriptions));
  } catch (e) {
    console.error('Failed to save job descriptions:', e);
  }
}

/**
 * Get all job descriptions
 * @returns {Array} Array of job description objects
 */
export function getAllJobDescriptions() {
  return [...jobDescriptions];
}

/**
 * Get a single job description by ID
 * @param {string} id - Job description ID
 * @returns {Object|null} Job description object or null
 */
export function getJobDescription(id) {
  return jobDescriptions.find(jd => jd.id === id) || null;
}

/**
 * Add a new job description
 * @param {Object} data - Job description data
 * @returns {Object} Created job description
 */
export function addJobDescription(data) {
  const jobDescription = {
    id: `jd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    title: data.title || 'Untitled Position',
    company: data.company || 'Unknown Company',
    description: data.description || '',
    url: data.url || '',
    notes: data.notes || '',
    dateAdded: new Date().toISOString(),
    dateModified: new Date().toISOString(),
    tags: data.tags || [],
    isActive: data.isActive !== false
  };
  
  jobDescriptions.unshift(jobDescription);
  save();
  
  return jobDescription;
}

/**
 * Update an existing job description
 * @param {string} id - Job description ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated job description or null
 */
export function updateJobDescription(id, updates) {
  const index = jobDescriptions.findIndex(jd => jd.id === id);
  if (index === -1) return null;
  
  jobDescriptions[index] = {
    ...jobDescriptions[index],
    ...updates,
    dateModified: new Date().toISOString()
  };
  
  save();
  return jobDescriptions[index];
}

/**
 * Delete a job description
 * @param {string} id - Job description ID
 * @returns {boolean} True if deleted
 */
export function deleteJobDescription(id) {
  const index = jobDescriptions.findIndex(jd => jd.id === id);
  if (index === -1) return false;
  
  jobDescriptions.splice(index, 1);
  save();
  
  return true;
}

/**
 * Toggle active status of a job description
 * @param {string} id - Job description ID
 * @returns {Object|null} Updated job description or null
 */
export function toggleJobDescriptionActive(id) {
  const jd = jobDescriptions.find(j => j.id === id);
  if (!jd) return null;
  
  return updateJobDescription(id, { isActive: !jd.isActive });
}

/**
 * Get active job descriptions (for AI analysis)
 * @returns {Array} Array of active job descriptions
 */
export function getActiveJobDescriptions() {
  return jobDescriptions.filter(jd => jd.isActive);
}

/**
 * Search job descriptions by title or company
 * @param {string} query - Search query
 * @returns {Array} Matching job descriptions
 */
export function searchJobDescriptions(query) {
  if (!query) return getAllJobDescriptions();
  
  const lowerQuery = query.toLowerCase();
  return jobDescriptions.filter(jd => 
    jd.title.toLowerCase().includes(lowerQuery) ||
    jd.company.toLowerCase().includes(lowerQuery) ||
    jd.description.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Import job descriptions from JSON
 * @param {string} jsonString - JSON string of job descriptions
 * @returns {number} Number of imported items
 */
export function importJobDescriptions(jsonString) {
  try {
    const imported = JSON.parse(jsonString);
    if (!Array.isArray(imported)) {
      throw new Error('Invalid format: expected array');
    }
    
    let count = 0;
    for (const item of imported) {
      if (item.title && item.description) {
        addJobDescription(item);
        count++;
      }
    }
    
    return count;
  } catch (e) {
    console.error('Failed to import job descriptions:', e);
    throw new Error('Invalid JSON format');
  }
}

/**
 * Export job descriptions to JSON string
 * @returns {string} JSON string of all job descriptions
 */
export function exportJobDescriptions() {
  return JSON.stringify(jobDescriptions, null, 2);
}

/**
 * Clear all job descriptions
 */
export function clearAllJobDescriptions() {
  jobDescriptions = [];
  save();
}

/**
 * Parse job description from plain text
 * Attempts to extract title and company from common formats
 * @param {string} text - Plain text job posting
 * @returns {Object} Parsed job description data
 */
export function parseJobDescriptionText(text) {
  // Try to extract title from first line
  const lines = text.trim().split('\n');
  let title = 'Untitled Position';
  let company = 'Unknown Company';
  let description = text;
  
  if (lines.length > 0) {
    // First non-empty line is often the title
    const firstLine = lines[0].trim();
    if (firstLine.length > 0 && firstLine.length < 100) {
      title = firstLine;
      description = lines.slice(1).join('\n').trim();
    }
    
    // Try to find company in second line or "at" pattern
    const atMatch = firstLine.match(/^(.+?)\s+(?:at|@|-)\s+(.+)$/i);
    if (atMatch) {
      title = atMatch[1].trim();
      company = atMatch[2].trim();
    } else if (lines.length > 1) {
      const secondLine = lines[1].trim();
      // Check if second line looks like a company name (short, no common sentence patterns)
      if (secondLine.length > 0 && secondLine.length < 50 && !secondLine.includes('.')) {
        company = secondLine;
        description = lines.slice(2).join('\n').trim();
      }
    }
  }
  
  return {
    title,
    company,
    description
  };
}

/**
 * Extract keywords from job description for matching
 * @param {Object} jobDescription - Job description object
 * @returns {Array} Array of keywords
 */
export function extractKeywords(jobDescription) {
  const text = `${jobDescription.title} ${jobDescription.description}`.toLowerCase();
  
  // Common skill keywords to look for
  const skillPatterns = [
    // Technical skills
    /\b(javascript|typescript|python|java|c\+\+|react|angular|vue|node\.?js|sql|aws|azure|gcp|docker|kubernetes)\b/gi,
    // Design skills
    /\b(figma|sketch|adobe|photoshop|illustrator|indesign|ui\/ux|user experience|user interface)\b/gi,
    // Soft skills
    /\b(leadership|communication|teamwork|problem.solving|analytical|creative|detail.oriented)\b/gi,
    // Years of experience
    /\b(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp)?\b/gi
  ];
  
  const keywords = new Set();
  
  for (const pattern of skillPatterns) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => keywords.add(m.toLowerCase()));
  }
  
  return [...keywords];
}
