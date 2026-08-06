/**
 * Apply an analysis recommendation to the resume store.
 *
 * Framework-agnostic logic extracted verbatim from the former
 * jobDescriptionPanel.js so the React jobs panel (and tests) can call it without
 * the panel's DOM/import graph. Maps a recommendation's section name + current
 * text to a store path and writes the suggested value; returns true on success.
 * Pure except for store reads/writes.
 */
import { store } from './store.js';
// Resume scalars go through the shared writer, not a bare store.update: an
// experience match can resolve to `experience[i].company`, where a direct write
// renames a grouped employer's LEAD ALONE and splits the run, because a run
// needs an identical company as well as a shared _groupId.
//
// The writer also handles `experience[i].dates` (clearing the machine-readable
// pair beside it). That branch is unreachable from here today — findInExperience
// matches title, company and bullets only — but routing through one writer means
// a future matcher that does reach it inherits the rule instead of re-opening
// the hole.
import { writeScalarToStore } from './changeApply.js';

// Map section name to store path and apply the change. Returns true if applied.
export function applyRecommendationToStore(sectionName, currentValue, suggestedValue) {
  // Recommendations come from model JSON, not a validated schema — an item may
  // omit `section` entirely. Normalize so the matching below returns false
  // (letting the UI show its "could not apply" toast) instead of throwing.
  sectionName = typeof sectionName === 'string' ? sectionName : '';
  const data = store.getData();
  if (!data) return false;

  const isAddNew = isAddNewRecommendation(currentValue);

  const directMappings = {
    summary: 'summary',
    'professional summary': 'summary',
    objective: 'summary',
    name: 'name',
    tagline: 'tagline',
    title: 'tagline',
    'professional title': 'tagline',
    tools: 'tools',
    software: 'tools',
    'tools & software': 'tools',
  };

  if (directMappings[sectionName]) {
    store.update(directMappings[sectionName], suggestedValue);
    return true;
  }

  if (sectionName.includes('contact') || sectionName.includes('email')
    || sectionName.includes('phone') || sectionName.includes('location')) {
    const contactField = findContactField(sectionName, currentValue, data.contact);
    if (contactField) {
      store.update(`contact.${contactField}`, suggestedValue);
      return true;
    }
  }

  if (sectionName.includes('experience') || sectionName.includes('work')
    || sectionName.includes('employment') || sectionName.includes('job')
    || sectionName.includes('bullet') || sectionName.includes('achievement')) {
    if (!isAddNew) {
      const result = findInExperience(currentValue, data.experience);
      if (result) {
        writeScalarToStore(result.path, suggestedValue);
        return true;
      }
    }
    if (isAddNew || sectionName.includes('bullet') || sectionName.includes('achievement')) {
      const expIndex = findExperienceIndexFromContext(sectionName, data.experience);
      if (expIndex >= 0 && data.experience[expIndex]) {
        const bullets = data.experience[expIndex].bullets || [];
        store.update(`experience[${expIndex}].bullets`, [...bullets, suggestedValue]);
        return true;
      }
    }
  }

  if (sectionName.includes('education') || sectionName.includes('degree') || sectionName.includes('school')) {
    if (!isAddNew) {
      const eduIndex = findInArray(currentValue, data.education);
      if (eduIndex !== -1) {
        store.update(`education[${eduIndex}]`, suggestedValue);
        return true;
      }
    }
    if (isAddNew) {
      store.update('education', [...(data.education || []), suggestedValue]);
      return true;
    }
  }

  if (sectionName.includes('skill')) {
    const skillsSectionIndex = findSkillsSectionIndex(data.sections, sectionName);
    if (!isAddNew && skillsSectionIndex >= 0) {
      const section = data.sections[skillsSectionIndex];
      if (section.content && Array.isArray(section.content)) {
        const normalizedCurrent = normalizeText(currentValue);
        for (let j = 0; j < section.content.length; j++) {
          if (normalizeText(section.content[j]) === normalizedCurrent) {
            store.update(`sections[${skillsSectionIndex}].content[${j}]`, suggestedValue);
            return true;
          }
        }
      }
    }
    if (skillsSectionIndex >= 0) {
      const content = data.sections[skillsSectionIndex].content || [];
      store.update(`sections[${skillsSectionIndex}].content`, [...content, suggestedValue]);
      return true;
    }
  }

  if (data.sections && Array.isArray(data.sections)) {
    const sectionIndex = findGenericSectionIndex(data.sections, sectionName);
    if (sectionIndex >= 0) {
      const section = data.sections[sectionIndex];
      if (!isAddNew && section.content && Array.isArray(section.content)) {
        const normalizedCurrent = normalizeText(currentValue);
        for (let j = 0; j < section.content.length; j++) {
          if (normalizeText(section.content[j]) === normalizedCurrent) {
            store.update(`sections[${sectionIndex}].content[${j}]`, suggestedValue);
            return true;
          }
        }
      }
      const content = section.content || [];
      store.update(`sections[${sectionIndex}].content`, [...content, suggestedValue]);
      return true;
    }
  }

  if (!isAddNew) {
    const genericResult = findTextAnywhere(currentValue, data);
    if (genericResult) {
      // The generic search walks the whole document, so it can land on an
      // experience scalar too.
      writeScalarToStore(genericResult, suggestedValue);
      return true;
    }
  }

  return false;
}

// Does the "current" value signal a new addition rather than a replacement?
function isAddNewRecommendation(currentValue) {
  if (!currentValue) return true;
  const normalized = currentValue.toLowerCase().trim();
  const addNewIndicators = [
    'n/a', 'none', 'add new', 'add', 'new', 'missing',
    '(none)', '(add)', '(new)', '(missing)',
    'not present', 'not included', 'no current', 'currently missing',
    '-', '--', '...',
  ];
  return addNewIndicators.some((ind) => normalized === ind || normalized.startsWith(`${ind} `));
}

function findExperienceIndexFromContext(sectionName, experience) {
  if (!experience || experience.length === 0) return -1;
  const sectionLower = sectionName.toLowerCase();
  for (let i = 0; i < experience.length; i++) {
    const companyLower = (experience[i].company || '').toLowerCase();
    const titleLower = (experience[i].title || '').toLowerCase();
    if (companyLower && sectionLower.includes(companyLower)) return i;
    if (titleLower && sectionLower.includes(titleLower)) return i;
  }
  return 0;
}

function findSkillsSectionIndex(sections, sectionName) {
  if (!sections || !Array.isArray(sections)) return -1;
  const sectionLower = sectionName.toLowerCase();
  for (let i = 0; i < sections.length; i++) {
    if ((sections[i].title || '').toLowerCase() === sectionLower) return i;
  }
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower && sectionLower.includes(titleLower)) return i;
  }
  for (let i = 0; i < sections.length; i++) {
    if ((sections[i].title || '').toLowerCase().includes('skill')) return i;
  }
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].type === 'skills') return i;
  }
  return -1;
}

function findGenericSectionIndex(sections, sectionName) {
  if (!sections || !Array.isArray(sections)) return -1;
  const sectionLower = sectionName.toLowerCase();
  for (let i = 0; i < sections.length; i++) {
    if ((sections[i].title || '').toLowerCase() === sectionLower) return i;
  }
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower && sectionLower.includes(titleLower)) return i;
  }
  for (let i = 0; i < sections.length; i++) {
    const titleLower = (sections[i].title || '').toLowerCase();
    if (titleLower && titleLower.includes(sectionLower)) return i;
  }
  return -1;
}

function findContactField(sectionName, currentValue, contact) {
  if (!contact) return null;
  const fieldMap = {
    email: 'email', phone: 'phone', location: 'location',
    portfolio: 'portfolio', website: 'portfolio', instagram: 'instagram',
  };
  for (const [keyword, field] of Object.entries(fieldMap)) {
    if (sectionName.includes(keyword) && contact[field]) return field;
  }
  for (const [field, value] of Object.entries(contact)) {
    if (value && normalizeText(value) === normalizeText(currentValue)) return field;
  }
  return null;
}

function findInExperience(currentValue, experience) {
  if (!experience || !Array.isArray(experience)) return null;
  const normalizedCurrent = normalizeText(currentValue);
  for (let i = 0; i < experience.length; i++) {
    const exp = experience[i];
    if (normalizeText(exp.title) === normalizedCurrent) return { path: `experience[${i}].title` };
    if (normalizeText(exp.company) === normalizedCurrent) return { path: `experience[${i}].company` };
    if (exp.bullets && Array.isArray(exp.bullets)) {
      for (let j = 0; j < exp.bullets.length; j++) {
        if (normalizeText(exp.bullets[j]) === normalizedCurrent) return { path: `experience[${i}].bullets[${j}]` };
      }
    }
  }
  return null;
}

function findInSections(currentValue, sections, type = null) {
  if (!sections || !Array.isArray(sections)) return null;
  const normalizedCurrent = normalizeText(currentValue);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (type && section.type !== type) continue;
    if (normalizeText(section.title) === normalizedCurrent) return { path: `sections[${i}].title` };
    if (section.content && Array.isArray(section.content)) {
      for (let j = 0; j < section.content.length; j++) {
        if (normalizeText(section.content[j]) === normalizedCurrent) return { path: `sections[${i}].content[${j}]` };
      }
    }
  }
  return null;
}

function findInArray(currentValue, arr) {
  if (!arr || !Array.isArray(arr)) return -1;
  const normalizedCurrent = normalizeText(currentValue);
  for (let i = 0; i < arr.length; i++) {
    if (normalizeText(arr[i]) === normalizedCurrent) return i;
  }
  return -1;
}

function findTextAnywhere(currentValue, data) {
  const normalizedCurrent = normalizeText(currentValue);
  const simpleFields = ['name', 'tagline', 'summary', 'tools'];
  for (const field of simpleFields) {
    if (normalizeText(data[field]) === normalizedCurrent) return field;
  }
  if (data.contact) {
    for (const [field, value] of Object.entries(data.contact)) {
      if (normalizeText(value) === normalizedCurrent) return `contact.${field}`;
    }
  }
  const expResult = findInExperience(currentValue, data.experience);
  if (expResult) return expResult.path;
  const secResult = findInSections(currentValue, data.sections);
  if (secResult) return secResult.path;
  const eduIndex = findInArray(currentValue, data.education);
  if (eduIndex !== -1) return `education[${eduIndex}]`;
  return null;
}

function normalizeText(text) {
  if (!text) return '';
  return String(text).toLowerCase().trim().replace(/\s+/g, ' ');
}
