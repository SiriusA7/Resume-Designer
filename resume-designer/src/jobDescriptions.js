/**
 * Job Descriptions Module
 * CRUD operations for job descriptions with appStorage persistence
 */

import { randomSuffix } from './store.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';

const STORAGE_KEY = 'resume-designer-job-descriptions';

// In-memory cache of job descriptions
let jobDescriptions = [];

// Re-read callbacks for whoever renders this list. Nothing subscribed here
// until sync could replace the whole key from under an open dialog: JobsDialog
// re-reads the cache after each of its OWN mutations (a `bump` reducer) and the
// native sheet re-reads on every publish, so both cover every writer they drive
// themselves — and neither covers the one they do not.
const subscribers = new Set();

/** Subscribe to replacements of the whole list. Returns an unsubscribe. */
export function subscribeJobDescriptions(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

/**
 * Parse a stored value into the array shape this module requires, or `null`
 * when it is not one.
 *
 * Self-heals an id-keyed OBJECT map (a legacy Electron shape that earlier
 * migrations wrote through verbatim — stores migrated before the import
 * normalizer still hold it): spreading an object in getAllJobDescriptions()
 * threw and killed the Jobs dialog.
 *
 * `null` for anything else, because the two callers need opposite answers to
 * it — see adoptStoredJobDescriptions.
 */
function parseList(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return parsed && typeof parsed === 'object' ? Object.values(parsed) : null;
  } catch (e) {
    console.error('Failed to load job descriptions:', e);
    return null;
  }
}

/**
 * Initialize job descriptions from storage
 */
export function initJobDescriptions() {
  const stored = appStorage.getItem(STORAGE_KEY);
  if (stored) jobDescriptions = parseList(stored) ?? [];
  return jobDescriptions;
}

/**
 * Take the list `applyUnits` has just written to storage.
 *
 * The cache above is this module's whole truth: every mutation edits it and
 * `save()` serializes it back over the key. So a job list that arrived from
 * another device lasted exactly until the next local change, which wrote the
 * stale cache over it, stamped the unit, and — the transport legitimately
 * holding the record's change tag, because the page had confirmed the apply —
 * pushed the revert up as a clean, uncontested update. No conflict was raised
 * and the other device's postings were gone. Same trap as store.adoptDocument's,
 * and the same answer: the owner adopts, rather than being written behind.
 *
 * Subscribers are told because a corrected cache the screen has not re-read is
 * only half of it: the Jobs dialog renders straight out of this array.
 *
 * A value it cannot read leaves the cache alone — absence is never deletion,
 * and one malformed remote unit must not empty someone's job list. The list
 * this device holds is then still the one the next local write puts back on
 * disk, so the bad bytes are corrected rather than inherited.
 */
export function adoptStoredJobDescriptions() {
  const stored = appStorage.getItem(STORAGE_KEY);
  const list = stored ? parseList(stored) : null;
  if (!list) return;
  jobDescriptions = list;
  subscribers.forEach((cb) => cb());
}

/**
 * Save job descriptions to storage
 */
// Whether the last write reached storage. Read through `jobStorageFailed()`.
let saveFailed = false;

function save() {
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(jobDescriptions));
    saveFailed = false;
  } catch (e) {
    console.error('Failed to save job descriptions:', e);
    saveFailed = true;
    // Browser passthrough at storage quota: the in-memory list still holds
    // the JD, but it won't survive a reload — say so instead of vanishing it.
    storageErrorToast(
      'Could not save your job descriptions — storage is full. Free up space '
      + '(delete resumes you no longer need) and try again.',
      { once: true },
    );
  }
}

/**
 * True when the last write did not reach storage.
 *
 * The toast above is the whole story on the desktop and none of it under the
 * native iOS shell, where nothing renders the web's toasts: a job added at
 * quota looked saved, sat in the list for the rest of the session, and was
 * gone on the next launch. The native sheet renders this instead, the same way
 * the profile sheet renders `saveFailed`.
 *
 * Same caveat as there: `appStorage.setItem` only throws in the browser's
 * passthrough mode. In the app the write is coalesced and queued, so a disk
 * failure surfaces through `appStorage.flush()` rather than here.
 */
export function jobStorageFailed() {
  return saveFailed;
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
    id: `jd-${Date.now()}-${randomSuffix()}`,
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
