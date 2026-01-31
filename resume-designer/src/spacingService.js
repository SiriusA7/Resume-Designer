/**
 * Spacing Service
 * Handles granular spacing and sizing controls for the resume
 */

// Default spacing settings
const DEFAULT_SPACING = {
  pageMargins: {
    top: 0.5,      // inches
    bottom: 0.5,
    left: 0.5,
    right: 0.5
  },
  sectionSpacing: 0.8,   // rem
  headerHeight: 'auto',  // 'auto' or a specific value
  sidebarWidth: 2.4,     // inches (for two-column layouts)
  fontScale: 1.0,        // multiplier for all font sizes
  lineHeight: 1.45       // line-height multiplier
};

// Get current spacing settings
export function getSpacingSettings() {
  const stored = localStorage.getItem('resume-spacing-settings');
  if (stored) {
    try {
      return { ...DEFAULT_SPACING, ...JSON.parse(stored) };
    } catch (e) {
      console.warn('Failed to parse spacing settings:', e);
    }
  }
  return { ...DEFAULT_SPACING };
}

// Save spacing settings
export function saveSpacingSettings(settings) {
  localStorage.setItem('resume-spacing-settings', JSON.stringify(settings));
}

/**
 * Apply spacing settings to the resume
 * @param {Object} settings - Spacing settings object
 */
export function applySpacingSettings(settings) {
  const resume = document.querySelector('.resume');
  if (!resume) return;
  
  const s = { ...DEFAULT_SPACING, ...settings };
  
  // Page margins - apply to the body areas
  resume.style.setProperty('--page-margin-top', `${s.pageMargins.top}in`);
  resume.style.setProperty('--page-margin-bottom', `${s.pageMargins.bottom}in`);
  resume.style.setProperty('--page-margin-left', `${s.pageMargins.left}in`);
  resume.style.setProperty('--page-margin-right', `${s.pageMargins.right}in`);
  
  // Section spacing
  resume.style.setProperty('--section-spacing', `${s.sectionSpacing}rem`);
  
  // Sidebar width
  resume.style.setProperty('--sidebar-width', `${s.sidebarWidth}in`);
  
  // Font scale - set CSS variable for elements using it
  resume.style.setProperty('--font-scale', s.fontScale.toString());
  
  // Line height
  resume.style.setProperty('--line-height', s.lineHeight.toString());
  
  // Apply font scale directly to sidebar content elements
  const sidebarElements = resume.querySelectorAll('.sidebar-content, .sidebar-skills, .stacked-skill-content');
  sidebarElements.forEach(el => {
    const isCompact = el.closest('.compact-sidebar');
    const isStacked = el.classList.contains('stacked-skill-content');
    const baseSize = isCompact ? 0.68 : (isStacked ? 0.8 : 0.78);
    el.style.fontSize = `${(baseSize * s.fontScale).toFixed(3)}rem`;
  });
  
  // Also apply to skill tags directly for maximum reliability
  const skillTags = resume.querySelectorAll('.skill-tag, .highlight-bullet');
  skillTags.forEach(el => {
    const isCompact = el.closest('.compact-sidebar');
    const baseSize = isCompact ? 0.68 : 0.78;
    el.style.fontSize = `${(baseSize * s.fontScale).toFixed(3)}rem`;
  });
}

/**
 * Reset spacing to defaults
 */
export function resetSpacingSettings() {
  localStorage.removeItem('resume-spacing-settings');
  applySpacingSettings(DEFAULT_SPACING);
  return DEFAULT_SPACING;
}

/**
 * Initialize spacing service
 */
export function initSpacingService() {
  const settings = getSpacingSettings();
  applySpacingSettings(settings);
  return settings;
}

// Export defaults for reference
export { DEFAULT_SPACING };
