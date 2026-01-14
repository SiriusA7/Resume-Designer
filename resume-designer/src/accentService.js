/**
 * Accent Style Service
 * Handles customization of decorative elements like underlines, bullets, and borders
 */

// Underline style options
export const UNDERLINE_STYLES = {
  'solid': { name: 'Solid', css: 'solid' },
  'double': { name: 'Double', css: 'double' },
  'dotted': { name: 'Dotted', css: 'dotted' },
  'dashed': { name: 'Dashed', css: 'dashed' },
  'gradient': { name: 'Gradient', css: 'gradient' },
  'none': { name: 'None', css: 'none' }
};

// Bullet style options
export const BULLET_STYLES = {
  'disc': { name: 'Circle', css: 'disc', char: '•' },
  'square': { name: 'Square', css: 'square', char: '▪' },
  'dash': { name: 'Dash', css: 'none', char: '–' },
  'arrow': { name: 'Arrow', css: 'none', char: '→' },
  'check': { name: 'Checkmark', css: 'none', char: '✓' },
  'star': { name: 'Star', css: 'none', char: '★' },
  'diamond': { name: 'Diamond', css: 'none', char: '◆' },
  'none': { name: 'None', css: 'none', char: '' }
};

// Border radius presets
export const BORDER_RADIUS_PRESETS = {
  'sharp': { name: 'Sharp', value: '0' },
  'subtle': { name: 'Subtle', value: '4px' },
  'rounded': { name: 'Rounded', value: '8px' },
  'pill': { name: 'Pill', value: '16px' }
};

// Default accent settings
const DEFAULT_ACCENT = {
  underlineStyle: 'solid',
  underlineWidth: 2,      // px
  bulletStyle: 'disc',
  borderRadius: 'subtle',
  skillTagStyle: 'filled' // 'filled', 'outlined', 'minimal'
};

// Get current accent settings
export function getAccentSettings() {
  const stored = localStorage.getItem('resume-accent-settings');
  if (stored) {
    try {
      return { ...DEFAULT_ACCENT, ...JSON.parse(stored) };
    } catch (e) {
      console.warn('Failed to parse accent settings:', e);
    }
  }
  return { ...DEFAULT_ACCENT };
}

// Save accent settings
export function saveAccentSettings(settings) {
  localStorage.setItem('resume-accent-settings', JSON.stringify(settings));
}

/**
 * Apply accent settings to the resume
 * @param {Object} settings - Accent settings object
 */
export function applyAccentSettings(settings) {
  const resume = document.querySelector('.resume');
  if (!resume) return;
  
  const s = { ...DEFAULT_ACCENT, ...settings };
  
  // Underline style
  if (s.underlineStyle === 'gradient') {
    resume.style.setProperty('--title-underline-style', 'solid');
    resume.classList.add('gradient-underlines');
  } else if (s.underlineStyle === 'none') {
    resume.style.setProperty('--title-underline-style', 'none');
    resume.classList.remove('gradient-underlines');
  } else {
    resume.style.setProperty('--title-underline-style', s.underlineStyle);
    resume.classList.remove('gradient-underlines');
  }
  
  resume.style.setProperty('--title-underline-width', `${s.underlineWidth}px`);
  
  // Bullet style
  const bulletChar = BULLET_STYLES[s.bulletStyle]?.char || '•';
  resume.style.setProperty('--bullet-char', `"${bulletChar}"`);
  resume.style.setProperty('--bullet-style', BULLET_STYLES[s.bulletStyle]?.css || 'none');
  resume.dataset.bulletStyle = s.bulletStyle;
  
  // Border radius
  const radiusValue = BORDER_RADIUS_PRESETS[s.borderRadius]?.value || '4px';
  resume.style.setProperty('--accent-radius', radiusValue);
  
  // Skill tag style
  resume.dataset.skillTagStyle = s.skillTagStyle;
}

/**
 * Reset accent settings to defaults
 */
export function resetAccentSettings() {
  localStorage.removeItem('resume-accent-settings');
  applyAccentSettings(DEFAULT_ACCENT);
  return DEFAULT_ACCENT;
}

/**
 * Initialize accent service
 */
export function initAccentService() {
  const settings = getAccentSettings();
  applyAccentSettings(settings);
  return settings;
}

// Export defaults
export { DEFAULT_ACCENT };
