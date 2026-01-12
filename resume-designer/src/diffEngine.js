/**
 * Diff Engine
 * Provides word-level and structured diffing for resume content
 */

import * as Diff from 'diff';

/**
 * Diff types for different kinds of changes
 */
export const DIFF_TYPES = {
  ADD: 'add',
  REMOVE: 'remove',
  MODIFY: 'modify',
  UNCHANGED: 'unchanged'
};

/**
 * Compute word-level diff between two strings
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 * @returns {Array} Array of diff parts with type and value
 */
export function diffWords(oldText, newText) {
  if (oldText === newText) {
    return [{ type: DIFF_TYPES.UNCHANGED, value: oldText }];
  }
  
  const changes = Diff.diffWords(oldText || '', newText || '');
  
  return changes.map(part => ({
    type: part.added ? DIFF_TYPES.ADD : part.removed ? DIFF_TYPES.REMOVE : DIFF_TYPES.UNCHANGED,
    value: part.value
  }));
}

/**
 * Compute line-level diff between two strings
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 * @returns {Array} Array of diff parts with type and value
 */
export function diffLines(oldText, newText) {
  if (oldText === newText) {
    return [{ type: DIFF_TYPES.UNCHANGED, value: oldText }];
  }
  
  const changes = Diff.diffLines(oldText || '', newText || '');
  
  return changes.map(part => ({
    type: part.added ? DIFF_TYPES.ADD : part.removed ? DIFF_TYPES.REMOVE : DIFF_TYPES.UNCHANGED,
    value: part.value,
    lines: part.value.split('\n').filter(l => l.length > 0)
  }));
}

/**
 * Compute structured diff for resume data
 * Handles nested objects and arrays properly
 * @param {Object} oldData - Original resume data
 * @param {Object} newData - New resume data
 * @param {string} basePath - Base path for nested changes
 * @returns {Array} Array of structured changes
 */
export function diffResumeData(oldData, newData, basePath = '') {
  const changes = [];
  
  if (!oldData && !newData) return changes;
  
  // Handle case where one is null/undefined
  if (!oldData) {
    changes.push({
      path: basePath,
      type: DIFF_TYPES.ADD,
      oldValue: null,
      newValue: newData,
      displayOld: '',
      displayNew: JSON.stringify(newData, null, 2)
    });
    return changes;
  }
  
  if (!newData) {
    changes.push({
      path: basePath,
      type: DIFF_TYPES.REMOVE,
      oldValue: oldData,
      newValue: null,
      displayOld: JSON.stringify(oldData, null, 2),
      displayNew: ''
    });
    return changes;
  }
  
  // Get all keys from both objects
  const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
  
  for (const key of allKeys) {
    const currentPath = basePath ? `${basePath}.${key}` : key;
    const oldValue = oldData[key];
    const newValue = newData[key];
    
    // Skip internal fields
    if (key.startsWith('_') || key === 'id') continue;
    
    // Both values are the same
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    
    // Handle arrays (experience, skills, sections, etc.)
    if (Array.isArray(oldValue) || Array.isArray(newValue)) {
      const arrayChanges = diffArray(oldValue || [], newValue || [], currentPath);
      changes.push(...arrayChanges);
      continue;
    }
    
    // Handle nested objects
    if (typeof oldValue === 'object' && typeof newValue === 'object' && oldValue !== null && newValue !== null) {
      const nestedChanges = diffResumeData(oldValue, newValue, currentPath);
      changes.push(...nestedChanges);
      continue;
    }
    
    // Handle primitive values (strings, numbers, booleans)
    if (oldValue !== newValue) {
      const type = oldValue === undefined ? DIFF_TYPES.ADD : 
                   newValue === undefined ? DIFF_TYPES.REMOVE : 
                   DIFF_TYPES.MODIFY;
      
      changes.push({
        path: currentPath,
        type,
        oldValue,
        newValue,
        displayOld: formatDisplayValue(oldValue),
        displayNew: formatDisplayValue(newValue),
        wordDiff: typeof oldValue === 'string' && typeof newValue === 'string' 
          ? diffWords(oldValue, newValue) 
          : null
      });
    }
  }
  
  return changes;
}

/**
 * Diff two arrays with smart matching
 * @param {Array} oldArray - Original array
 * @param {Array} newArray - New array
 * @param {string} basePath - Base path for the array
 * @returns {Array} Array of changes
 */
function diffArray(oldArray, newArray, basePath) {
  const changes = [];
  
  // Try to match items by id or by similarity
  const oldItems = oldArray.map((item, index) => ({ item, index, matched: false }));
  const newItems = newArray.map((item, index) => ({ item, index, matched: false }));
  
  // First pass: match by id
  for (const oldEntry of oldItems) {
    if (oldEntry.item?.id) {
      const matchingNew = newItems.find(n => !n.matched && n.item?.id === oldEntry.item.id);
      if (matchingNew) {
        oldEntry.matched = true;
        matchingNew.matched = true;
        
        // Check if content changed
        if (JSON.stringify(oldEntry.item) !== JSON.stringify(matchingNew.item)) {
          const itemChanges = diffResumeData(oldEntry.item, matchingNew.item, `${basePath}[${matchingNew.index}]`);
          changes.push(...itemChanges);
        }
      }
    }
  }
  
  // Second pass: match by position for unmatched items
  const unmatchedOld = oldItems.filter(o => !o.matched);
  const unmatchedNew = newItems.filter(n => !n.matched);
  
  // Try to match unmatched items by position - treat as modifications
  const matchCount = Math.min(unmatchedOld.length, unmatchedNew.length);
  for (let i = 0; i < matchCount; i++) {
    const oldEntry = unmatchedOld[i];
    const newEntry = unmatchedNew[i];
    
    // If both are strings, create a single MODIFY with wordDiff
    if (typeof oldEntry.item === 'string' && typeof newEntry.item === 'string') {
      changes.push({
        path: `${basePath}[${oldEntry.index}]`,
        type: DIFF_TYPES.MODIFY,
        oldValue: oldEntry.item,
        newValue: newEntry.item,
        displayOld: oldEntry.item,
        displayNew: newEntry.item,
        wordDiff: diffWords(oldEntry.item, newEntry.item)
      });
    } else if (typeof oldEntry.item === 'object' && typeof newEntry.item === 'object') {
      // For objects, recursively diff them as modifications
      const itemChanges = diffResumeData(oldEntry.item, newEntry.item, `${basePath}[${oldEntry.index}]`);
      if (itemChanges.length === 0) {
        // Objects are same structure but may have small differences
        changes.push({
          path: `${basePath}[${oldEntry.index}]`,
          type: DIFF_TYPES.MODIFY,
          oldValue: oldEntry.item,
          newValue: newEntry.item,
          displayOld: formatArrayItemDisplay(oldEntry.item),
          displayNew: formatArrayItemDisplay(newEntry.item)
        });
      } else {
        changes.push(...itemChanges);
      }
    } else {
      // Mixed types - treat as remove + add
      changes.push({
        path: `${basePath}[${oldEntry.index}]`,
        type: DIFF_TYPES.MODIFY,
        oldValue: oldEntry.item,
        newValue: newEntry.item,
        displayOld: formatArrayItemDisplay(oldEntry.item),
        displayNew: formatArrayItemDisplay(newEntry.item)
      });
    }
    
    oldEntry.matched = true;
    newEntry.matched = true;
  }
  
  // Remaining items removed (more old than new)
  for (const oldEntry of unmatchedOld.filter(o => !o.matched)) {
    changes.push({
      path: `${basePath}[${oldEntry.index}]`,
      type: DIFF_TYPES.REMOVE,
      oldValue: oldEntry.item,
      newValue: null,
      displayOld: formatArrayItemDisplay(oldEntry.item),
      displayNew: ''
    });
  }
  
  // Remaining items added (more new than old)
  for (const newEntry of unmatchedNew.filter(n => !n.matched)) {
    changes.push({
      path: `${basePath}[${newEntry.index}]`,
      type: DIFF_TYPES.ADD,
      oldValue: null,
      newValue: newEntry.item,
      displayOld: '',
      displayNew: formatArrayItemDisplay(newEntry.item)
    });
  }
  
  return changes;
}

/**
 * Format a value for display
 * @param {*} value - Value to format
 * @returns {string} Formatted string
 */
function formatDisplayValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Format an array item for display (e.g., experience entry, skill)
 * @param {*} item - Array item
 * @returns {string} Formatted display string
 */
function formatArrayItemDisplay(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item);
  
  // Experience entry
  if (item.title && item.company) {
    return `${item.title} at ${item.company}`;
  }
  
  // Education entry
  if (item.degree && item.school) {
    return `${item.degree} from ${item.school}`;
  }
  
  // Section
  if (item.title && item.content) {
    return `${item.title}: ${Array.isArray(item.content) ? item.content.join(', ') : item.content}`;
  }
  
  // Generic object
  return JSON.stringify(item, null, 2);
}

/**
 * Create a change set from proposed modifications
 * @param {Object} currentData - Current resume data
 * @param {Object} proposedChanges - Object with path -> newValue mappings
 * @returns {Object} Change set with preview and apply functions
 */
export function createChangeSet(currentData, proposedChanges) {
  // Create a deep copy with proposed changes applied
  const newData = JSON.parse(JSON.stringify(currentData));
  
  for (const [path, value] of Object.entries(proposedChanges)) {
    setByPath(newData, path, value);
  }
  
  // Compute the diff
  const changes = diffResumeData(currentData, newData);
  
  return {
    currentData,
    proposedData: newData,
    changes,
    proposedChanges,
    
    // Get human-readable summary
    getSummary() {
      const added = changes.filter(c => c.type === DIFF_TYPES.ADD).length;
      const removed = changes.filter(c => c.type === DIFF_TYPES.REMOVE).length;
      const modified = changes.filter(c => c.type === DIFF_TYPES.MODIFY).length;
      return { added, removed, modified, total: changes.length };
    },
    
    // Apply a single change
    applyChange(changePath) {
      const change = changes.find(c => c.path === changePath);
      if (change && proposedChanges[changePath] !== undefined) {
        return { path: changePath, value: proposedChanges[changePath] };
      }
      return null;
    },
    
    // Get all changes to apply
    getAllChanges() {
      return Object.entries(proposedChanges).map(([path, value]) => ({ path, value }));
    }
  };
}

/**
 * Set a value at a nested path
 * @param {Object} obj - Object to modify
 * @param {string} path - Dot-notation path (e.g., "experience[0].title")
 * @param {*} value - Value to set
 */
function setByPath(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const isNextArray = /^\d+$/.test(nextPart);
    
    if (current[part] === undefined) {
      current[part] = isNextArray ? [] : {};
    }
    current = current[part];
  }
  
  const lastPart = parts[parts.length - 1];
  current[lastPart] = value;
}

/**
 * Get a value at a nested path
 * @param {Object} obj - Object to read from
 * @param {string} path - Dot-notation path
 * @returns {*} Value at path
 */
export function getByPath(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  
  return current;
}

/**
 * Get a human-readable label for a path
 * @param {string} path - Data path
 * @returns {string} Human-readable label
 */
export function getPathLabel(path) {
  const labels = {
    'name': 'Name',
    'title': 'Title',
    'email': 'Email',
    'phone': 'Phone',
    'location': 'Location',
    'website': 'Website',
    'linkedin': 'LinkedIn',
    'summary': 'Summary',
    'experience': 'Experience',
    'education': 'Education',
    'skills': 'Skills',
    'sections': 'Sections',
    'highlights': 'Highlights'
  };
  
  // Handle array indices
  const match = path.match(/^(\w+)\[(\d+)\]\.?(.*)$/);
  if (match) {
    const [, arrayName, index, rest] = match;
    const base = labels[arrayName] || arrayName;
    const itemNum = parseInt(index) + 1;
    
    if (rest) {
      const restLabel = labels[rest] || rest;
      return `${base} #${itemNum} - ${restLabel}`;
    }
    return `${base} #${itemNum}`;
  }
  
  return labels[path] || path;
}
