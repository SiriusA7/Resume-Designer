/**
 * Font Service
 * Handles font loading, caching, and management for the resume designer
 * Supports: Preset font pairings, Google Fonts, and System fonts
 */

// Preset font pairings - curated combinations that work well together
export const FONT_PAIRINGS = {
  'classic-elegant': {
    name: 'Classic Elegant',
    display: { family: 'Cormorant Garamond', weights: [400, 600, 700], category: 'serif' },
    body: { family: 'DM Sans', weights: [400, 500, 600], category: 'sans-serif' },
    googleFonts: true
  },
  'modern-clean': {
    name: 'Modern Clean',
    display: { family: 'Inter', weights: [400, 500, 600, 700], category: 'sans-serif' },
    body: { family: 'Inter', weights: [400, 500], category: 'sans-serif' },
    googleFonts: true
  },
  'creative': {
    name: 'Creative',
    display: { family: 'Playfair Display', weights: [400, 600, 700], category: 'serif' },
    body: { family: 'Source Sans Pro', weights: [400, 600], category: 'sans-serif' },
    googleFonts: true
  },
  'technical': {
    name: 'Technical',
    display: { family: 'IBM Plex Serif', weights: [400, 500, 600], category: 'serif' },
    body: { family: 'IBM Plex Sans', weights: [400, 500], category: 'sans-serif' },
    googleFonts: true
  },
  'minimal': {
    name: 'Minimal',
    display: { family: 'Libre Baskerville', weights: [400, 700], category: 'serif' },
    body: { family: 'Karla', weights: [400, 500, 600], category: 'sans-serif' },
    googleFonts: true
  },
  'bold-statement': {
    name: 'Bold Statement',
    display: { family: 'Oswald', weights: [400, 500, 600, 700], category: 'sans-serif' },
    body: { family: 'Roboto', weights: [400, 500], category: 'sans-serif' },
    googleFonts: true
  },
  'warm-friendly': {
    name: 'Warm Friendly',
    display: { family: 'Merriweather', weights: [400, 700], category: 'serif' },
    body: { family: 'Open Sans', weights: [400, 600], category: 'sans-serif' },
    googleFonts: true
  },
  'sleek-professional': {
    name: 'Sleek Professional',
    display: { family: 'Raleway', weights: [400, 500, 600, 700], category: 'sans-serif' },
    body: { family: 'Lato', weights: [400, 700], category: 'sans-serif' },
    googleFonts: true
  },
  'editorial': {
    name: 'Editorial',
    display: { family: 'Lora', weights: [400, 500, 600, 700], category: 'serif' },
    body: { family: 'Nunito Sans', weights: [400, 600], category: 'sans-serif' },
    googleFonts: true
  },
  'geometric': {
    name: 'Geometric',
    display: { family: 'Poppins', weights: [400, 500, 600, 700], category: 'sans-serif' },
    body: { family: 'Work Sans', weights: [400, 500], category: 'sans-serif' },
    googleFonts: true
  }
};

// Popular Google Fonts for manual selection
export const POPULAR_GOOGLE_FONTS = [
  // Serif
  { family: 'Cormorant Garamond', category: 'serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Playfair Display', category: 'serif', weights: [400, 500, 600, 700, 800, 900] },
  { family: 'Merriweather', category: 'serif', weights: [300, 400, 700, 900] },
  { family: 'Lora', category: 'serif', weights: [400, 500, 600, 700] },
  { family: 'Libre Baskerville', category: 'serif', weights: [400, 700] },
  { family: 'IBM Plex Serif', category: 'serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Crimson Text', category: 'serif', weights: [400, 600, 700] },
  { family: 'Source Serif Pro', category: 'serif', weights: [400, 600, 700] },
  { family: 'PT Serif', category: 'serif', weights: [400, 700] },
  { family: 'Bitter', category: 'serif', weights: [400, 500, 600, 700] },
  
  // Sans-serif
  { family: 'Inter', category: 'sans-serif', weights: [300, 400, 500, 600, 700, 800] },
  { family: 'DM Sans', category: 'sans-serif', weights: [400, 500, 700] },
  { family: 'Roboto', category: 'sans-serif', weights: [300, 400, 500, 700] },
  { family: 'Open Sans', category: 'sans-serif', weights: [300, 400, 600, 700, 800] },
  { family: 'Lato', category: 'sans-serif', weights: [300, 400, 700, 900] },
  { family: 'Poppins', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Raleway', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Source Sans Pro', category: 'sans-serif', weights: [300, 400, 600, 700] },
  { family: 'Nunito Sans', category: 'sans-serif', weights: [300, 400, 600, 700] },
  { family: 'Work Sans', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Karla', category: 'sans-serif', weights: [400, 500, 600, 700] },
  { family: 'IBM Plex Sans', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Oswald', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Montserrat', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Rubik', category: 'sans-serif', weights: [300, 400, 500, 600, 700] },
  
  // Display
  { family: 'Bebas Neue', category: 'display', weights: [400] },
  { family: 'Abril Fatface', category: 'display', weights: [400] },
  { family: 'Righteous', category: 'display', weights: [400] }
];

// Common system font stacks
export const SYSTEM_FONT_STACKS = {
  'system-ui': {
    name: 'System Default',
    family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    category: 'sans-serif'
  },
  'georgia': {
    name: 'Georgia',
    family: 'Georgia, "Times New Roman", Times, serif',
    category: 'serif'
  },
  'helvetica': {
    name: 'Helvetica',
    family: 'Helvetica, Arial, sans-serif',
    category: 'sans-serif'
  },
  'times': {
    name: 'Times New Roman',
    family: '"Times New Roman", Times, Georgia, serif',
    category: 'serif'
  },
  'arial': {
    name: 'Arial',
    family: 'Arial, Helvetica, sans-serif',
    category: 'sans-serif'
  },
  'palatino': {
    name: 'Palatino',
    family: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
    category: 'serif'
  },
  'verdana': {
    name: 'Verdana',
    family: 'Verdana, Geneva, Tahoma, sans-serif',
    category: 'sans-serif'
  },
  'trebuchet': {
    name: 'Trebuchet MS',
    family: '"Trebuchet MS", Helvetica, sans-serif',
    category: 'sans-serif'
  },
  'garamond': {
    name: 'Garamond',
    family: 'Garamond, "Times New Roman", Times, serif',
    category: 'serif'
  },
  'courier': {
    name: 'Courier New',
    family: '"Courier New", Courier, monospace',
    category: 'monospace'
  }
};

// Track loaded fonts to avoid duplicate loading
const loadedFonts = new Set();
let googleFontsStylesheet = null;

/**
 * Load a Google Font
 * @param {string} family - Font family name
 * @param {number[]} weights - Array of weights to load
 * @returns {Promise<void>}
 */
export async function loadGoogleFont(family, weights = [400, 700]) {
  const fontKey = `${family}:${weights.join(',')}`;
  
  if (loadedFonts.has(fontKey)) {
    return; // Already loaded
  }
  
  const weightsString = weights.join(';');
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weightsString}&display=swap`;
  
  // Create or update stylesheet
  if (!googleFontsStylesheet) {
    googleFontsStylesheet = document.createElement('link');
    googleFontsStylesheet.rel = 'stylesheet';
    googleFontsStylesheet.id = 'dynamic-google-fonts';
    document.head.appendChild(googleFontsStylesheet);
  }
  
  // For multiple fonts, we need to append to existing
  const existingHref = googleFontsStylesheet.href || '';
  if (existingHref && !existingHref.includes(encodeURIComponent(family))) {
    // Create additional stylesheet for new font
    const newStylesheet = document.createElement('link');
    newStylesheet.rel = 'stylesheet';
    newStylesheet.href = url;
    document.head.appendChild(newStylesheet);
  } else if (!existingHref) {
    googleFontsStylesheet.href = url;
  }
  
  loadedFonts.add(fontKey);
  
  // Wait for font to load
  try {
    await document.fonts.load(`${weights[0]} 16px "${family}"`);
  } catch (e) {
    console.warn(`Font ${family} may not have loaded:`, e);
  }
}

/**
 * Load a font pairing
 * @param {string} pairingId - ID from FONT_PAIRINGS
 * @returns {Promise<void>}
 */
export async function loadFontPairing(pairingId) {
  const pairing = FONT_PAIRINGS[pairingId];
  if (!pairing) {
    console.warn(`Unknown font pairing: ${pairingId}`);
    return;
  }
  
  if (pairing.googleFonts) {
    await Promise.all([
      loadGoogleFont(pairing.display.family, pairing.display.weights),
      loadGoogleFont(pairing.body.family, pairing.body.weights)
    ]);
  }
}

/**
 * Apply font settings to the resume
 * @param {Object} settings - Font settings object
 * @param {string} settings.mode - 'preset', 'google', or 'system'
 * @param {string} [settings.pairingId] - For preset mode
 * @param {Object} [settings.displayFont] - For google/system mode
 * @param {Object} [settings.bodyFont] - For google/system mode
 */
export function applyFontSettings(settings) {
  const resume = document.querySelector('.resume');
  if (!resume) return;
  
  let displayFamily, bodyFamily;
  
  if (settings.mode === 'preset' && settings.pairingId) {
    const pairing = FONT_PAIRINGS[settings.pairingId];
    if (pairing) {
      displayFamily = `'${pairing.display.family}', ${getFallbackStack(pairing.display.category)}`;
      bodyFamily = `'${pairing.body.family}', ${getFallbackStack(pairing.body.category)}`;
    }
  } else if (settings.mode === 'google') {
    if (settings.displayFont) {
      displayFamily = `'${settings.displayFont.family}', ${getFallbackStack(settings.displayFont.category)}`;
    }
    if (settings.bodyFont) {
      bodyFamily = `'${settings.bodyFont.family}', ${getFallbackStack(settings.bodyFont.category)}`;
    }
  } else if (settings.mode === 'system') {
    if (settings.displayFont) {
      const systemFont = SYSTEM_FONT_STACKS[settings.displayFont];
      displayFamily = systemFont ? systemFont.family : settings.displayFont;
    }
    if (settings.bodyFont) {
      const systemFont = SYSTEM_FONT_STACKS[settings.bodyFont];
      bodyFamily = systemFont ? systemFont.family : settings.bodyFont;
    }
  }
  
  // Apply CSS variables
  if (displayFamily) {
    resume.style.setProperty('--font-display', displayFamily);
  }
  if (bodyFamily) {
    resume.style.setProperty('--font-body', bodyFamily);
  }
}

/**
 * Get fallback font stack for a category
 * @param {string} category - Font category
 * @returns {string}
 */
function getFallbackStack(category) {
  switch (category) {
    case 'serif':
      return 'Georgia, "Times New Roman", Times, serif';
    case 'sans-serif':
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    case 'monospace':
      return '"Courier New", Courier, monospace';
    case 'display':
      return 'Impact, Haettenschweiler, sans-serif';
    default:
      return 'sans-serif';
  }
}

/**
 * Get local/system fonts using the Local Font Access API
 * Falls back to common fonts if API not available
 * @returns {Promise<Array>}
 */
export async function getSystemFonts() {
  // Check if Local Font Access API is available
  if ('queryLocalFonts' in window) {
    try {
      const fonts = await window.queryLocalFonts();
      const uniqueFamilies = new Map();
      
      fonts.forEach(font => {
        if (!uniqueFamilies.has(font.family)) {
          uniqueFamilies.set(font.family, {
            family: font.family,
            fullName: font.fullName,
            style: font.style
          });
        }
      });
      
      return Array.from(uniqueFamilies.values()).sort((a, b) => 
        a.family.localeCompare(b.family)
      );
    } catch (e) {
      console.warn('Local Font Access API not available or permission denied:', e);
    }
  }
  
  // Fallback to common system fonts
  return Object.entries(SYSTEM_FONT_STACKS).map(([id, font]) => ({
    id,
    family: font.name,
    stack: font.family,
    category: font.category
  }));
}

/**
 * Check if a font is available on the system
 * @param {string} fontFamily - Font family to check
 * @returns {boolean}
 */
export function isFontAvailable(fontFamily) {
  const testString = 'mmmmmmmmmmlli';
  const testSize = '72px';
  
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  
  // Measure with fallback font
  context.font = `${testSize} monospace`;
  const fallbackWidth = context.measureText(testString).width;
  
  // Measure with target font
  context.font = `${testSize} "${fontFamily}", monospace`;
  const testWidth = context.measureText(testString).width;
  
  return fallbackWidth !== testWidth;
}

/**
 * Get current font settings
 * @returns {Object}
 */
export function getCurrentFontSettings() {
  const stored = localStorage.getItem('resume-font-settings');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.warn('Failed to parse font settings:', e);
    }
  }
  
  // Default settings
  return {
    mode: 'preset',
    pairingId: 'classic-elegant'
  };
}

/**
 * Save font settings
 * @param {Object} settings
 */
export function saveFontSettings(settings) {
  localStorage.setItem('resume-font-settings', JSON.stringify(settings));
}

/**
 * Initialize font service with saved settings
 */
export async function initFontService() {
  const settings = getCurrentFontSettings();
  
  if (settings.mode === 'preset' && settings.pairingId) {
    await loadFontPairing(settings.pairingId);
  } else if (settings.mode === 'google') {
    if (settings.displayFont) {
      await loadGoogleFont(settings.displayFont.family, settings.displayFont.weights || [400, 700]);
    }
    if (settings.bodyFont) {
      await loadGoogleFont(settings.bodyFont.family, settings.bodyFont.weights || [400, 700]);
    }
  }
  
  applyFontSettings(settings);
}

/**
 * Search Google Fonts (from our curated list)
 * @param {string} query - Search query
 * @param {string} [category] - Filter by category
 * @returns {Array}
 */
export function searchGoogleFonts(query = '', category = null) {
  let results = POPULAR_GOOGLE_FONTS;
  
  if (category) {
    results = results.filter(f => f.category === category);
  }
  
  if (query) {
    const lowerQuery = query.toLowerCase();
    results = results.filter(f => 
      f.family.toLowerCase().includes(lowerQuery)
    );
  }
  
  return results;
}
