/**
 * Theme Manager
 * Handles light/dark mode switching with system preference support
 */

const STORAGE_KEY = 'resume-designer-theme';
const THEMES = ['light', 'dark', 'system'];

let currentTheme = 'system';

/**
 * Initialize theme manager
 */
export function initTheme() {
  // Load saved preference
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && THEMES.includes(saved)) {
    currentTheme = saved;
  }
  
  // Apply theme
  applyTheme(currentTheme);
  
  // Listen for system preference changes
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    if (currentTheme === 'system') {
      applyTheme('system');
    }
  });
  
  // Set up theme toggle dropdown
  setupThemeToggle();
  
  // Update UI
  updateThemeUI();
}

/**
 * Get the current theme setting
 */
export function getTheme() {
  return currentTheme;
}

/**
 * Get the actual resolved theme (light or dark)
 */
export function getResolvedTheme() {
  if (currentTheme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return currentTheme;
}

/**
 * Set and apply a theme
 */
export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  
  currentTheme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  updateThemeUI();
}

/**
 * Toggle between light and dark (skips system)
 */
export function toggleTheme() {
  const resolved = getResolvedTheme();
  setTheme(resolved === 'light' ? 'dark' : 'light');
}

/**
 * Apply theme to document
 */
function applyTheme(theme) {
  const root = document.documentElement;
  
  if (theme === 'system') {
    // Remove explicit theme, let CSS media query handle it
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  
  // Dispatch event for other components
  window.dispatchEvent(new CustomEvent('themechange', { 
    detail: { theme, resolved: getResolvedTheme() } 
  }));
}

/**
 * Update theme UI elements
 */
function updateThemeUI() {
  const resolved = getResolvedTheme();
  
  // Update icon visibility
  document.querySelectorAll('.theme-icon').forEach(icon => {
    icon.style.display = 'none';
  });
  
  const iconClass = currentTheme === 'system' 
    ? '.theme-icon-system' 
    : resolved === 'dark' 
      ? '.theme-icon-dark' 
      : '.theme-icon-light';
  
  document.querySelectorAll(iconClass).forEach(icon => {
    icon.style.display = 'block';
  });
  
  // Update selected state in dropdown
  document.querySelectorAll('.theme-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.theme === currentTheme);
  });
  
  // Update toggle button tooltip
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    const labels = { light: 'Light mode', dark: 'Dark mode', system: 'System theme' };
    btn.title = labels[currentTheme] || 'Toggle theme';
  }
}

/**
 * Set up theme toggle dropdown
 */
function setupThemeToggle() {
  const dropdown = document.getElementById('theme-toggle-dropdown');
  const btn = document.getElementById('theme-toggle-btn');
  const menu = document.getElementById('theme-toggle-menu');
  
  if (!dropdown || !btn || !menu) return;
  
  // Toggle menu on button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  
  // Handle theme selection
  menu.addEventListener('click', (e) => {
    const option = e.target.closest('.theme-option');
    if (option) {
      const theme = option.dataset.theme;
      setTheme(theme);
      dropdown.classList.remove('open');
    }
  });
  
  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });
  
  // Close menu on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  });
}

// Re-setup when header is re-rendered
export function setupThemeToggleAfterRender() {
  setupThemeToggle();
  updateThemeUI();
}
