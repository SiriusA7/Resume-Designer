/**
 * Resume Store - Reactive state management for resume data
 * Handles state updates, change events, and coordinates with persistence
 */

// Generate unique IDs for new items
export function generateId(prefix = 'item') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Deep clone utility
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Get nested value by path (e.g., "contact.email")
function getByPath(obj, path) {
  return path.split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    // Handle array index notation like "experience[0]"
    const match = key.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      return current[match[1]]?.[parseInt(match[2])];
    }
    return current[key];
  }, obj);
}

// Set nested value by path
function setByPath(obj, path, value) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  
  let current = obj;
  for (const key of keys) {
    // Handle array index notation
    const match = key.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      current = current[match[1]][parseInt(match[2])];
    } else {
      if (current[key] === undefined) {
        current[key] = {};
      }
      current = current[key];
    }
  }
  
  // Handle array index in last key
  const lastMatch = lastKey.match(/^(\w+)\[(\d+)\]$/);
  if (lastMatch) {
    current[lastMatch[1]][parseInt(lastMatch[2])] = value;
  } else {
    current[lastKey] = value;
  }
}

// Create the store
function createStore() {
  let data = null;
  let isDirty = false;
  const listeners = new Set();
  let saveCallback = null;
  let saveTimeout = null;
  const SAVE_DEBOUNCE_MS = 500;

  return {
    // Get current data (returns a clone to prevent direct mutation)
    getData() {
      return data ? deepClone(data) : null;
    },

    // Get raw reference (use carefully)
    getDataRef() {
      return data;
    },

    // Set entire data object
    setData(newData, skipSave = false) {
      data = deepClone(newData);
      isDirty = false;
      this.emit('dataLoaded', data);
      if (!skipSave) {
        this.scheduleSave();
      }
    },

    // Update a specific field by path
    update(path, value) {
      if (!data) return;
      
      setByPath(data, path, value);
      isDirty = true;
      this.emit('fieldUpdated', { path, value });
      this.emit('change', data);
      this.scheduleSave();
    },

    // Get a specific field by path
    get(path) {
      if (!data) return undefined;
      return getByPath(data, path);
    },

    // Add item to an array field
    addToArray(path, item) {
      if (!data) return;
      
      const arr = getByPath(data, path);
      if (Array.isArray(arr)) {
        arr.push(item);
        isDirty = true;
        this.emit('arrayItemAdded', { path, item });
        this.emit('change', data);
        this.scheduleSave();
      }
    },

    // Remove item from array by index
    removeFromArray(path, index) {
      if (!data) return;
      
      const arr = getByPath(data, path);
      if (Array.isArray(arr) && index >= 0 && index < arr.length) {
        const removed = arr.splice(index, 1)[0];
        isDirty = true;
        this.emit('arrayItemRemoved', { path, index, item: removed });
        this.emit('change', data);
        this.scheduleSave();
      }
    },

    // Move item within array
    moveInArray(path, fromIndex, toIndex) {
      if (!data) return;
      
      const arr = getByPath(data, path);
      if (Array.isArray(arr) && fromIndex >= 0 && fromIndex < arr.length) {
        const [item] = arr.splice(fromIndex, 1);
        arr.splice(toIndex, 0, item);
        isDirty = true;
        this.emit('arrayItemMoved', { path, fromIndex, toIndex });
        this.emit('change', data);
        this.scheduleSave();
      }
    },

    // Check if there are unsaved changes
    isDirty() {
      return isDirty;
    },

    // Mark as saved
    markSaved() {
      isDirty = false;
      this.emit('saved');
    },

    // Subscribe to events
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    // Emit event to all listeners
    emit(event, payload) {
      listeners.forEach(callback => {
        try {
          callback(event, payload);
        } catch (e) {
          console.error('Store listener error:', e);
        }
      });
    },

    // Set save callback (called by persistence layer)
    onSave(callback) {
      saveCallback = callback;
    },

    // Schedule a debounced save
    scheduleSave() {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      saveTimeout = setTimeout(() => {
        if (saveCallback && isDirty) {
          saveCallback(data);
          this.markSaved();
        }
      }, SAVE_DEBOUNCE_MS);
    },

    // Force immediate save
    saveNow() {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      if (saveCallback && data) {
        saveCallback(data);
        this.markSaved();
      }
    }
  };
}

// Export singleton instance
export const store = createStore();

// Default empty resume template
export const EMPTY_RESUME = {
  name: 'Your Name',
  tagline: 'Your Professional Title',
  contact: {
    location: 'City, State',
    email: 'email@example.com',
    phone: '000-000-0000',
    portfolio: '',
    instagram: ''
  },
  summary: 'A brief professional summary describing your experience and goals.',
  sections: [
    {
      id: generateId('section'),
      title: 'Skills',
      type: 'skills',
      content: ['Skill 1', 'Skill 2', 'Skill 3']
    }
  ],
  experience: [
    {
      id: generateId('exp'),
      title: 'Job Title',
      company: 'Company Name',
      dates: 'Start Date – End Date',
      bullets: [
        'Accomplishment or responsibility',
        'Another key achievement'
      ]
    }
  ],
  education: ['Degree — School Name — Dates'],
  tools: 'Tool 1 • Tool 2 • Tool 3'
};
