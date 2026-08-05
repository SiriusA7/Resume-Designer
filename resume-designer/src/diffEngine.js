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
 * Fields a model may never author, and the two helpers that enforce it on
 * WHOLE-OBJECT changes.
 *
 * The key-level skip further down only runs while diffing MATCHED object keys,
 * so it never sees inside an addition or a wholesale rewrite: diffArray emits
 * one `ADD experience[n]` carrying the entire item, and applyChangeToStore
 * splices that object in verbatim. The change-generation prompt asks for none
 * of these fields, but it does serialise the current resume WITH them
 * (`JSON.stringify(resumeData)`), so a model templating a new role off an
 * existing entry carries that entry's internals along for the ride.
 *
 * Two failures, both silent:
 *  - the date pair stamps a brand-new job with someone else's start month, for
 *    `datesAreContinuous` to trust;
 *  - `_groupId` folds the new role into an existing employer run the moment it
 *    lands adjacent to the same company, asserting a continuous tenure that no
 *    grouping action and no date gate approved.
 *
 * So an ADDED entry arrives clean, exactly as a hand-added one does, and a
 * REWRITTEN one keeps whatever the store already holds.
 */
function isUnproposable(key) {
  // `_`-prefixed keys are internal, and `_groupId` is the one that bites: the
  // change prompt serialises the current resume WITH it, so a model templating a
  // new role off an existing entry brings that run's id. The moment the new role
  // lands adjacent to the same company, groupExperience folds it into the
  // employer's tenure — asserting continuous employment that no grouping action
  // and no date gate ever approved.
  //
  // `id` is deliberately NOT here: applyChangeToStore's idempotency check reads
  // it to make re-applying an ADD a no-op instead of a duplicate.
  return key === 'startDate' || key === 'endDate' || key.startsWith('_');
}

function withoutInternalFields(value) {
  if (Array.isArray(value)) return value.map(withoutInternalFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isUnproposable(key)) continue;
    out[key] = withoutInternalFields(nested);
  }
  return out;
}

/**
 * The same, for a WHOLE-OBJECT REWRITE of an item that already exists.
 *
 * Here the pair must be carried over rather than dropped: applying a MODIFY
 * writes `newValue` over the entry, so a scrubbed object would DELETE a pair
 * the picker owns. An addition has no prior entry, so `withoutInternalFields` is
 * right there and this is right here.
 */
function withStoredInternals(oldItem, newItem) {
  const rewritable = newItem && typeof newItem === 'object' && !Array.isArray(newItem)
    && oldItem && typeof oldItem === 'object' && !Array.isArray(oldItem);
  if (!rewritable) return withoutInternalFields(newItem);

  // Substitute the stored values IN PLACE rather than stripping and re-appending.
  // The caller decides "did anything actually change?" with JSON.stringify, which
  // is key-order sensitive: rebuilding with these keys moved to the end made an
  // otherwise identical entry compare as different and emitted a phantom change.
  const out = {};
  for (const [key, nested] of Object.entries(newItem)) {
    if (isUnproposable(key)) {
      if (key in oldItem) out[key] = oldItem[key];
      continue;
    }
    out[key] = withoutInternalFields(nested);
  }
  // Internals the stored entry carries but the proposal omitted must survive too.
  for (const key of Object.keys(oldItem)) {
    if (isUnproposable(key) && !(key in out)) out[key] = oldItem[key];
  }
  return out;
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
    const added = withoutInternalFields(newData);
    changes.push({
      path: basePath,
      type: DIFF_TYPES.ADD,
      oldValue: null,
      newValue: added,
      displayOld: '',
      displayNew: JSON.stringify(added, null, 2)
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
    
    // Skip fields a model may never address. `_`-prefixed keys and `id` are
    // internal; startDate/endDate are the machine-readable date pair, which only
    // ever moves as a UNIT — written by a picker commit, or cleared beside a
    // freeform edit to `dates` (R1/R2). A half-written pair is the contradiction
    // those rules exist to prevent.
    //
    // Skipping here, and not only at the proposal boundary, is what closes the
    // container route: a proposal keyed `experience[0]` — or the whole
    // `experience` array — carries the pair inside its VALUE, where a path
    // filter cannot see it, and createChangeSet re-diffs that container into
    // leaves, re-creating the very `experience[n].startDate` change the filter
    // rejects. diffArray delegates object items back here, so this one skip
    // covers the leaf, container and whole-array routes alike.
    //
    // Skipping is also the only safe shape. Scrubbing the keys out of the
    // proposal instead would leave them present in oldData and absent from
    // newData — and `allKeys` above is the UNION — so the diff would emit a
    // change that BLANKS the pair rather than preserving it.
    if (key.startsWith('_') || key === 'id' || key === 'startDate' || key === 'endDate') continue;
    
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
          // Stamp the item's IDENTITY onto every change inside it. The path
          // carries `matchingNew.index` — a position in the PROPOSED array —
          // but changes are applied to the LIVE one, where an insertion or
          // removal elsewhere in the same set may have moved this item. The
          // anchor lets the apply path re-resolve the index by id, so applying
          // in any order (or one change at a time from the hover menu) targets
          // the right item. Purely additive: a change without anchors, from an
          // older persisted change set, behaves exactly as before.
          //
          // PREPENDED, not assigned. A nested id-bearing array inside this item
          // has already stamped its own anchor during the recursion above, and
          // overwriting it would correct the outer index while writing through
          // a stale inner one. Outermost-first, because resolving an outer
          // index also rewrites the array paths of the anchors beneath it.
          const anchor = { arrayPath: basePath, id: oldEntry.item.id, index: matchingNew.index };
          changes.push(...itemChanges.map((c) => ({
            ...c,
            anchors: [anchor, ...(c.anchors || [])],
          })));
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
        // Objects are same structure but may have small differences.
        //
        // diffResumeData now SKIPS the machine date pair, so an item whose only
        // difference is that pair reaches here with nothing to report — and a
        // whole-object MODIFY carrying newEntry.item verbatim would smuggle the
        // pair straight back in, reopening the very route the skip closes. Carry
        // the STORED pair over instead (the picker owns it), and when nothing
        // else differs, emit no change at all rather than a phantom one.
        const nextItem = withStoredInternals(oldEntry.item, newEntry.item);
        if (JSON.stringify(nextItem) !== JSON.stringify(oldEntry.item)) {
          changes.push({
            path: `${basePath}[${oldEntry.index}]`,
            type: DIFF_TYPES.MODIFY,
            oldValue: oldEntry.item,
            newValue: nextItem,
            displayOld: formatArrayItemDisplay(oldEntry.item),
            displayNew: formatArrayItemDisplay(nextItem)
          });
        }
      } else {
        changes.push(...itemChanges);
      }
    } else {
      // Mixed types - treat as remove + add
      const nextItem = withStoredInternals(oldEntry.item, newEntry.item);
      changes.push({
        path: `${basePath}[${oldEntry.index}]`,
        type: DIFF_TYPES.MODIFY,
        oldValue: oldEntry.item,
        newValue: nextItem,
        displayOld: formatArrayItemDisplay(oldEntry.item),
        displayNew: formatArrayItemDisplay(nextItem)
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
    // Scrubbed at EMISSION, not at apply: the change object is what the review
    // preview projects and what the diff dialog shows, so scrubbing later would
    // put the two out of step again.
    const added = withoutInternalFields(newEntry.item);
    changes.push({
      path: `${basePath}[${newEntry.index}]`,
      type: DIFF_TYPES.ADD,
      oldValue: null,
      newValue: added,
      displayOld: '',
      displayNew: formatArrayItemDisplay(added)
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
export function setByPath(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');

  // Paths come from AI model output. A __proto__/constructor/prototype segment
  // would walk into the prototype chain and pollute Object.prototype for the
  // whole process, so ignore the assignment entirely. Skip, don't throw — both
  // callers loop over many proposed paths, and a throw would let one bad path
  // break the whole change set (createChangeSet) or preview
  // (applyPendingToData). But not silently: the model believes the change
  // landed, so leave a trace instead of zero evidence.
  if (parts.some(part => part === '__proto__' || part === 'constructor' || part === 'prototype')) {
    console.warn(`[diffEngine] ignoring change to unsafe path: ${path}`);
    return;
  }

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
    'company': 'Company',
    'dates': 'Dates',
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
