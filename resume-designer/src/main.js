/**
 * Resume Designer - Main Application
 * Integrates all components: store, header bar, chat panel, inline editor, structure panel
 */

import { store } from './store.js';
import { 
  renderResume, 
  renderResumeStacked,
  renderResumeStackedVertical,
  renderResumeRightSidebar,
  renderResumeCompact,
  renderResumeExecutive,
  renderResumeClassic,
  renderResumeClassicFeatured,
  renderResumeModern,
  renderResumeTimeline,
  renderResumeCreative
} from './renderer.js';
import { initPdfExport } from './pdf.js';
import { initInlineEditor, refreshInlineEditor, getActiveInlineEditable } from './inlineEditor.js';
import { initStructurePanel, setDesignSettings } from './structurePanel.js';
import { initHeaderBar, getCurrentId, loadVariant } from './headerBar.js';
import { initChatPanel, refreshChatPanel, startProfileInterviewFromPanel } from './chatPanel.js';
import { initZoomControls } from './zoomControls.js';
import { migrateBuiltInVariants, saveSettings, getSettings, SETTINGS_UPDATED_EVENT } from './persistence.js';
import { initTheme, setupThemeToggleAfterRender } from './theme.js';
import { initJobDescriptionPanel, openJobDescriptionPanel, onJobPanelVariantChange } from './jobDescriptionPanel.js';
import { initHistoryPanel, openHistoryPanel } from './historyPanel.js';
import { initUserProfilePanel, openUserProfilePanel } from './userProfilePanel.js';
import { shouldShowOnboarding, showOnboardingWizard } from './onboarding.js';
import { initFontService } from './fontService.js';
import { initHeaderStyleService, applyHeaderStyle, getHeaderStyleSettings } from './headerStyleService.js';
import { initSpacingService, applySpacingSettings, getSpacingSettings, saveSpacingSettings } from './spacingService.js';
import { initAccentService, applyAccentSettings } from './accentService.js';
import { initPhotoService, applyPhotoSettings } from './photoService.js';
import { 
  getUsageSummary, 
  getUsageByDate, 
  exportUsageData, 
  clearUsageData, 
  formatTokenCount, 
  formatCost 
} from './tokenTrackingService.js';

// Built-in resume variants (for initial migration)
const BUILT_IN_VARIANTS = [
  { id: 'book-illustrator', name: 'Book Illustrator', file: 'BookIllustrator.md' },
  { id: 'brand-campaign', name: 'Brand / Campaign', file: 'Brand-CampaignIllustrator-CharacterDesigner.md' },
  { id: 'concept-artist', name: 'Concept Artist', file: 'ConceptArtist-ArtDirection.md' },
  { id: 'coordinator', name: 'Project Coordinator', file: 'CreativeProjectCoordinator.md' },
  { id: 'viz-dev', name: 'Visual Development', file: 'VizDev-2DAnim-CharacterAndBackgroundDesign.md' }
];

// Color palette definitions
const COLOR_PALETTES = {
  terracotta: {
    accent: '#c45c3e',
    accentLight: '#d97a5d',
    headerBg: '#2d2a26',
    headerBgEnd: '#3d3832',
    sidebarBg: '#f4e8e4'
  },
  rose: {
    accent: '#e11d48',
    accentLight: '#f43f5e',
    headerBg: '#4a1025',
    headerBgEnd: '#5a2035',
    sidebarBg: '#fce7f3'
  },
  amber: {
    accent: '#d97706',
    accentLight: '#f59e0b',
    headerBg: '#451a03',
    headerBgEnd: '#78350f',
    sidebarBg: '#fef3c7'
  },
  coral: {
    accent: '#f97316',
    accentLight: '#fb923c',
    headerBg: '#431407',
    headerBgEnd: '#7c2d12',
    sidebarBg: '#ffedd5'
  },
  ocean: {
    accent: '#2563eb',
    accentLight: '#3b82f6',
    headerBg: '#1e3a5f',
    headerBgEnd: '#2d4a6f',
    sidebarBg: '#e8f0fe'
  },
  teal: {
    accent: '#0d9488',
    accentLight: '#14b8a6',
    headerBg: '#134e4a',
    headerBgEnd: '#115e59',
    sidebarBg: '#ccfbf1'
  },
  forest: {
    accent: '#059669',
    accentLight: '#10b981',
    headerBg: '#1a3c34',
    headerBgEnd: '#2a4c44',
    sidebarBg: '#e6f4f0'
  },
  cyan: {
    accent: '#0891b2',
    accentLight: '#06b6d4',
    headerBg: '#164e63',
    headerBgEnd: '#155e75',
    sidebarBg: '#cffafe'
  },
  plum: {
    accent: '#7c3aed',
    accentLight: '#8b5cf6',
    headerBg: '#2d1f47',
    headerBgEnd: '#3d2f57',
    sidebarBg: '#f3e8ff'
  },
  indigo: {
    accent: '#4f46e5',
    accentLight: '#6366f1',
    headerBg: '#1e1b4b',
    headerBgEnd: '#312e81',
    sidebarBg: '#e0e7ff'
  },
  slate: {
    accent: '#64748b',
    accentLight: '#94a3b8',
    headerBg: '#1e293b',
    headerBgEnd: '#334155',
    sidebarBg: '#f1f5f9'
  },
  zinc: {
    accent: '#52525b',
    accentLight: '#71717a',
    headerBg: '#18181b',
    headerBgEnd: '#27272a',
    sidebarBg: '#f4f4f5'
  }
};

let currentPalette = 'terracotta';
let currentLayout = 'sidebar';
let customColor = '#c45c3e';

// Initialize the application
async function init() {
  // Detect Electron on macOS and add class for traffic light padding
  if (typeof window !== 'undefined' && window.electron?.isElectron) {
    if (window.electron.platform === 'darwin') {
      document.documentElement.classList.add('electron-mac');
    }
    document.documentElement.classList.add('electron');
  }
  
  // Load saved settings
  const settings = getSettings();
  currentPalette = settings.colorPalette || 'terracotta';
  currentLayout = settings.layout || 'sidebar';
  customColor = settings.customColor || '#c45c3e';
  
  // Migrate built-in variants to storage on first run
  await migrateBuiltInVariants(BUILT_IN_VARIANTS);
  
  // Initialize theme manager (before header for proper icons)
  initTheme();
  
  // Initialize font service (load saved fonts)
  await initFontService();
  
  // Initialize spacing service
  initSpacingService();
  
  // Initialize accent service
  initAccentService();
  
  // Initialize photo service
  initPhotoService();
  
  // Initialize header bar (includes variant management)
  initHeaderBar(handleVariantChange);
  
  // Setup theme toggle after header render
  setupThemeToggleAfterRender();
  
  // Initialize inline editor
  initInlineEditor();
  
  // Initialize structure panel with design change callback
  initStructurePanel(handleStructureChange, handleDesignChange);
  
  // Sync design settings to structure panel
  setDesignSettings(currentPalette, currentLayout, customColor);
  
  // Initialize PDF export
  initPdfExport();
  
  // Initialize chat panel
  initChatPanel(handleChatApply);
  
  // Initialize zoom controls
  initZoomControls();
  
  // Initialize job description panel
  initJobDescriptionPanel();
  
  // Initialize history panel
  initHistoryPanel();
  
  // Initialize user profile panel
  initUserProfilePanel();
  
  // Expose panel openers and wizards globally
  window.openJobDescriptionPanel = openJobDescriptionPanel;
  window.openHistoryPanel = openHistoryPanel;
  window.openUserProfilePanel = openUserProfilePanel;
  window.showOnboardingWizard = showOnboardingWizard;
  window.startProfileInterviewFromChat = startProfileInterviewFromPanel;
  
  // Initialize undo/redo
  initUndoRedo();

  // Initialize shared text formatting tools in bottom toolbar
  initTextTools();
  
  // Check for first-time user onboarding
  console.log('[Main] Setting up onboarding check...');
  
  // In Electron, expose a function to reset onboarding for debugging
  if (typeof window !== 'undefined' && window.electron?.isElectron) {
    window.resetForTesting = () => {
      localStorage.clear();
      location.reload();
    };
    console.log('[Main] Electron detected, resetForTesting() available');
  }
  
  // Check onboarding after a short delay to ensure UI is ready
  console.log('[Main] Scheduling onboarding check in 300ms...');
  setTimeout(() => {
    console.log('[Main] Running onboarding check NOW');
    try {
      const shouldShow = shouldShowOnboarding();
      console.log('[Main] shouldShowOnboarding returned:', shouldShow);
      if (shouldShow) {
        console.log('[Main] Calling showOnboardingWizard()...');
        showOnboardingWizard();
      }
    } catch (e) {
      console.error('[Main] Error checking onboarding:', e);
      // Force show wizard on error in fresh installs
      console.log('[Main] Forcing wizard due to error');
      showOnboardingWizard();
    }
  }, 300);
  
  // Initialize settings modal
  initSettingsModal();

  // Keep settings UI synchronized across onboarding/chat/settings flows.
  window.addEventListener(SETTINGS_UPDATED_EVENT, () => {
    const modal = document.getElementById('settings-modal');
    if (modal?.classList.contains('show')) {
      loadApiKeysToModal();
    }
    refreshChatPanel();
  });
  
  // Subscribe to store changes for re-rendering
  store.subscribe((event, payload) => {
    if (event === 'change' || event === 'fieldUpdated' || event === 'dataLoaded') {
      renderCurrentResume();
    }
  });
  
  // Listen for resume-ready event from onboarding
  window.addEventListener('resume-ready', () => {
    console.log('[Main] Resume ready event received, rendering...');
    renderCurrentResume();
  });
  
  // Apply initial design settings
  applyColorPalette(currentPalette);
  
  // Render initial resume
  renderCurrentResume();
}

// Handle variant change from header bar
function handleVariantChange(variant) {
  renderCurrentResume();
  // Update job description panel analysis for new variant
  onJobPanelVariantChange();
}

// Handle structure panel changes
function handleStructureChange() {
  renderCurrentResume();
}

// Handle chat panel apply actions
function handleChatApply() {
  renderCurrentResume();
}

// Handle design changes from structure panel
function handleDesignChange(change) {
  switch (change.type) {
    case 'palette':
      currentPalette = change.value;
      customColor = change.customColor || customColor;
      applyColorPalette(change.value);
      saveSettings({ colorPalette: change.value, customColor });
      break;
    
    case 'headerStyle':
      // Header style is handled by structurePanel and saved automatically
      // Just need to re-render if necessary
      break;
    
    case 'font':
      // Font settings are handled by structurePanel and saved automatically
      break;
    
    case 'spacing':
      // Spacing settings are handled by structurePanel and saved automatically
      break;
    
    case 'accent':
      // Accent settings are handled by structurePanel and saved automatically
      break;
    
    case 'photo':
      // Photo settings are handled by structurePanel and saved automatically
      break;
      
    case 'layout':
      currentLayout = change.value;
      saveSettings({ layout: change.value });
      renderCurrentResume();
      break;
      
    case 'customColor':
      customColor = change.value;
      applyCustomPalette(change.value);
      saveSettings({ customColor: change.value });
      break;
  }
}

// Apply color palette to resume
function applyColorPalette(paletteName) {
  if (paletteName === 'custom') {
    applyCustomPalette(customColor);
    return;
  }
  
  const palette = COLOR_PALETTES[paletteName];
  if (!palette) return;
  
  applyPaletteColors(palette);
}

// Apply custom palette
function applyCustomPalette(color) {
  const palette = generatePaletteFromColor(color);
  applyPaletteColors(palette);
}

// Apply palette colors to resume element
function applyPaletteColors(palette) {
  const resume = document.getElementById('resume');
  if (!resume) return;
  
  resume.style.setProperty('--resume-accent', palette.accent);
  resume.style.setProperty('--resume-accent-light', palette.accentLight);
  resume.style.setProperty('--header-bg', palette.headerBg);
  resume.style.setProperty('--header-bg-end', palette.headerBgEnd);
  resume.style.setProperty('--sidebar-bg', palette.sidebarBg);
  
  // Also apply header style with new colors
  const headerStyle = getHeaderStyleSettings();
  applyHeaderStyle(headerStyle, {
    headerBg: palette.headerBg,
    headerBgEnd: palette.headerBgEnd,
    accent: palette.accent
  });
}

// Generate a full palette from a single accent color
function generatePaletteFromColor(hexColor) {
  const hsl = hexToHSL(hexColor);
  
  // Generate accent light (slightly lighter and more saturated)
  const accentLightHSL = {
    h: hsl.h,
    s: Math.min(hsl.s + 10, 100),
    l: Math.min(hsl.l + 15, 85)
  };
  
  // Generate header background (dark, desaturated version)
  const headerBgHSL = {
    h: hsl.h,
    s: Math.max(hsl.s - 20, 10),
    l: 15
  };
  
  // Generate header background end (slightly lighter)
  const headerBgEndHSL = {
    h: hsl.h,
    s: Math.max(hsl.s - 15, 15),
    l: 22
  };
  
  // Generate sidebar background (very light tint)
  const sidebarBgHSL = {
    h: hsl.h,
    s: Math.min(hsl.s * 0.4, 30),
    l: 95
  };
  
  return {
    accent: hexColor,
    accentLight: hslToHex(accentLightHSL),
    headerBg: hslToHex(headerBgHSL),
    headerBgEnd: hslToHex(headerBgEndHSL),
    sidebarBg: hslToHex(sidebarBgHSL)
  };
}

// Convert hex to HSL
function hexToHSL(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  return { h: h * 360, s: s * 100, l: l * 100 };
}

// Convert HSL to hex
function hslToHex({ h, s, l }) {
  s /= 100;
  l /= 100;
  
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  
  let r, g, b;
  
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  
  r = Math.round((r + m) * 255).toString(16).padStart(2, '0');
  g = Math.round((g + m) * 255).toString(16).padStart(2, '0');
  b = Math.round((b + m) * 255).toString(16).padStart(2, '0');
  
  return `#${r}${g}${b}`;
}

// Initialize undo/redo functionality
function initUndoRedo() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  
  // Update button states
  function updateButtons() {
    if (undoBtn) {
      undoBtn.disabled = !store.canUndo();
      undoBtn.classList.toggle('disabled', !store.canUndo());
    }
    if (redoBtn) {
      redoBtn.disabled = !store.canRedo();
      redoBtn.classList.toggle('disabled', !store.canRedo());
    }
  }
  
  // Subscribe to history changes
  store.subscribe((event) => {
    if (event === 'historyChanged' || event === 'dataLoaded') {
      updateButtons();
    }
  });
  
  // Button click handlers
  undoBtn?.addEventListener('click', () => {
    store.undo();
  });
  
  redoBtn?.addEventListener('click', () => {
    store.redo();
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }
    
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    
    if (modKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (modKey && e.key === 'z' && e.shiftKey) {
      // Mac style redo: Cmd+Shift+Z
      e.preventDefault();
      store.redo();
    } else if (modKey && e.key === 'y') {
      // Windows style redo: Ctrl+Y
      e.preventDefault();
      store.redo();
    }
  });
  
  // Initial state
  updateButtons();
}

let lastFormattingTarget = null;

function isTextInputElement(element) {
  return !!element && (
    element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && (element.type === 'text' || element.type === 'search' || element.type === 'url' || element.type === 'email'))
  );
}

function isEditableFormattingTarget(element) {
  return isTextInputElement(element) || !!element?.isContentEditable;
}

function getSelectionOffsetsInEditable(editable) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const length = editable.textContent?.length || 0;
    return { start: length, end: length };
  }

  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) {
    const length = editable.textContent?.length || 0;
    return { start: length, end: length };
  }

  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(editable);
  beforeStart.setEnd(range.startContainer, range.startOffset);

  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(editable);
  beforeEnd.setEnd(range.endContainer, range.endOffset);

  return {
    start: beforeStart.toString().length,
    end: beforeEnd.toString().length
  };
}

function setSelectionInEditable(editable, start, end) {
  const selection = window.getSelection();
  if (!selection) return;

  const textNode = editable.firstChild || editable.appendChild(document.createTextNode(''));
  const maxLen = textNode.textContent?.length || 0;
  const safeStart = Math.max(0, Math.min(start, maxLen));
  const safeEnd = Math.max(0, Math.min(end, maxLen));

  const range = document.createRange();
  range.setStart(textNode, safeStart);
  range.setEnd(textNode, safeEnd);
  selection.removeAllRanges();
  selection.addRange(range);
}

function toggleWrappedRange(value, start, end, marker) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const selected = value.slice(selectionStart, selectionEnd);
  const markerLength = marker.length;

  if (selectionStart === selectionEnd) {
    const hasOuterMarker = selectionStart >= markerLength &&
      value.slice(selectionStart - markerLength, selectionStart) === marker &&
      value.slice(selectionStart, selectionStart + markerLength) === marker;

    if (hasOuterMarker) {
      const nextValue = value.slice(0, selectionStart - markerLength) + value.slice(selectionStart + markerLength);
      const cursor = selectionStart - markerLength;
      return { value: nextValue, start: cursor, end: cursor };
    }

    const insertion = `${marker}${marker}`;
    const nextValue = value.slice(0, selectionStart) + insertion + value.slice(selectionStart);
    const cursor = selectionStart + markerLength;
    return { value: nextValue, start: cursor, end: cursor };
  }

  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= markerLength * 2
  ) {
    const unwrapped = selected.slice(markerLength, -markerLength);
    const nextValue = value.slice(0, selectionStart) + unwrapped + value.slice(selectionEnd);
    return { value: nextValue, start: selectionStart, end: selectionStart + unwrapped.length };
  }

  const hasOuterMarker = selectionStart >= markerLength &&
    value.slice(selectionStart - markerLength, selectionStart) === marker &&
    value.slice(selectionEnd, selectionEnd + markerLength) === marker;

  if (hasOuterMarker) {
    const nextValue = value.slice(0, selectionStart - markerLength) + selected + value.slice(selectionEnd + markerLength);
    return {
      value: nextValue,
      start: selectionStart - markerLength,
      end: selectionEnd - markerLength
    };
  }

  const nextValue = value.slice(0, selectionStart) + `${marker}${selected}${marker}` + value.slice(selectionEnd);
  return {
    value: nextValue,
    start: selectionStart + markerLength,
    end: selectionEnd + markerLength
  };
}

function toggleBulletedLines(value, start, end) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);

  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const endMarker = value.indexOf('\n', selectionEnd);
  const lineEnd = endMarker === -1 ? value.length : endMarker;

  const segment = value.slice(lineStart, lineEnd);
  const lines = segment.split('\n');
  const hasContent = lines.some(line => line.trim().length > 0);
  if (!hasContent) {
    return { value, start: selectionStart, end: selectionEnd };
  }

  const allBulleted = lines
    .filter(line => line.trim().length > 0)
    .every(line => /^\s*[-*•]\s+/.test(line));

  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    if (allBulleted) {
      return line.replace(/^(\s*)[-*•]\s+/, '$1');
    }
    return line.replace(/^(\s*)/, '$1- ');
  });

  const nextSegment = nextLines.join('\n');
  const nextValue = value.slice(0, lineStart) + nextSegment + value.slice(lineEnd);
  return { value: nextValue, start: lineStart, end: lineStart + nextSegment.length };
}

function clearInlineFormatting(value, start, end) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const hasSelection = selectionStart !== selectionEnd;

  const source = hasSelection
    ? value.slice(selectionStart, selectionEnd)
    : value;

  const cleared = source
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\+\+([^+\n]+)\+\+/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');

  if (!hasSelection) {
    return { value: cleared, start: selectionStart, end: selectionEnd };
  }

  const nextValue = value.slice(0, selectionStart) + cleared + value.slice(selectionEnd);
  return { value: nextValue, start: selectionStart, end: selectionStart + cleared.length };
}

function applyTextCommand(command) {
  const active = document.activeElement;
  const inlineActive = getActiveInlineEditable();

  let target = isEditableFormattingTarget(active) ? active : null;
  if (!target && inlineActive) {
    target = inlineActive;
    if (!inlineActive.isContentEditable) {
      inlineActive.click();
      target = inlineActive.isContentEditable ? inlineActive : null;
    }
  }
  if (!target && lastFormattingTarget && document.contains(lastFormattingTarget)) {
    target = lastFormattingTarget;
  }
  if (!target) return;

  if (isTextInputElement(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    let result = null;

    if (command === 'bold') result = toggleWrappedRange(target.value || '', start, end, '**');
    if (command === 'italic') result = toggleWrappedRange(target.value || '', start, end, '_');
    if (command === 'underline') result = toggleWrappedRange(target.value || '', start, end, '++');
    if (command === 'bullets') result = toggleBulletedLines(target.value || '', start, end);
    if (command === 'clear') result = clearInlineFormatting(target.value || '', start, end);
    if (!result) return;

    target.value = result.value;
    target.focus();
    target.setSelectionRange(result.start, result.end);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  if (!target.isContentEditable) return;

  const value = target.textContent || '';
  const offsets = getSelectionOffsetsInEditable(target);
  let result = null;

  if (command === 'bold') result = toggleWrappedRange(value, offsets.start, offsets.end, '**');
  if (command === 'italic') result = toggleWrappedRange(value, offsets.start, offsets.end, '_');
  if (command === 'underline') result = toggleWrappedRange(value, offsets.start, offsets.end, '++');
  if (command === 'bullets') result = toggleBulletedLines(value, offsets.start, offsets.end);
  if (command === 'clear') result = clearInlineFormatting(value, offsets.start, offsets.end);
  if (!result) return;

  target.textContent = result.value;
  target.focus();
  setSelectionInEditable(target, result.start, result.end);
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

function adjustGlobalFontScale(delta) {
  const spacing = getSpacingSettings();
  const next = Math.max(0.75, Math.min(1.35, (spacing.fontScale || 1) + delta));
  spacing.fontScale = Math.round(next * 100) / 100;
  saveSpacingSettings(spacing);
  applySpacingSettings(spacing);
  updateTextToolbarState();
}

function updateTextToolbarState() {
  const target = isEditableFormattingTarget(document.activeElement)
    ? document.activeElement
    : getActiveInlineEditable();
  const hasTarget = !!target;

  ['text-bold', 'text-italic', 'text-underline', 'text-bullets', 'text-clear-format'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', hasTarget);
  });

  const textSizeLevel = document.getElementById('text-size-level');
  if (textSizeLevel) {
    const spacing = getSpacingSettings();
    textSizeLevel.textContent = `${Math.round((spacing.fontScale || 1) * 100)}%`;
  }
}

function initTextTools() {
  const toolbar = document.getElementById('zoom-controls');
  if (!toolbar) return;

  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (isEditableFormattingTarget(target)) {
      lastFormattingTarget = target;
      updateTextToolbarState();
    }
  });

  document.addEventListener('selectionchange', () => {
    updateTextToolbarState();
  });

  toolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.text-tool-btn')) {
      // Keep focus in the current editor while applying toolbar commands.
      e.preventDefault();
    }
  });

  const bind = (id, handler) => {
    document.getElementById(id)?.addEventListener('click', handler);
  };

  bind('text-bold', () => applyTextCommand('bold'));
  bind('text-italic', () => applyTextCommand('italic'));
  bind('text-underline', () => applyTextCommand('underline'));
  bind('text-bullets', () => applyTextCommand('bullets'));
  bind('text-clear-format', () => applyTextCommand('clear'));
  bind('text-size-decrease', () => adjustGlobalFontScale(-0.05));
  bind('text-size-increase', () => adjustGlobalFontScale(0.05));

  updateTextToolbarState();
}

// Initialize settings modal
function initSettingsModal() {
  const settingsBtn = document.getElementById('chat-settings-btn');
  const modal = document.getElementById('settings-modal');
  const closeBtn = document.getElementById('close-settings-modal');
  const saveBtn = document.getElementById('save-api-keys');
  const clearBtn = document.getElementById('clear-api-keys');
  
  if (!settingsBtn || !modal) return;
  
  // Open modal
  settingsBtn.addEventListener('click', () => {
    loadApiKeysToModal();
    modal.classList.add('show');
  });
  
  // Close modal
  closeBtn?.addEventListener('click', () => {
    modal.classList.remove('show');
  });
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
    }
  });
  
  // Save API keys
  saveBtn?.addEventListener('click', () => {
    saveApiKeysFromModal();
    modal.classList.remove('show');
  });
  
  // Clear all keys
  clearBtn?.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all API keys?')) {
      clearAllApiKeys();
      loadApiKeysToModal();
    }
  });
  
  // Toggle password visibility
  document.querySelectorAll('.api-key-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });
  });
  
  // Initialize settings tabs
  initSettingsTabs();
  
  // Initialize developer panel
  initDeveloperPanel();
}

// Initialize settings tabs
function initSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  const tabContents = document.querySelectorAll('.settings-tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update active tab
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update active content
      tabContents.forEach(content => {
        content.classList.remove('active');
        if (content.id === `tab-${targetTab}`) {
          content.classList.add('active');
          
          // Refresh developer panel data when switching to it
          if (targetTab === 'developer') {
            renderUsageData();
          }
        }
      });
    });
  });
}

// Initialize developer panel
function initDeveloperPanel() {
  const refreshBtn = document.getElementById('refresh-usage-data');
  const exportBtn = document.getElementById('export-usage-data');
  const clearBtn = document.getElementById('clear-usage-data');
  
  // Refresh usage data
  refreshBtn?.addEventListener('click', () => {
    renderUsageData();
  });
  
  // Export usage data
  exportBtn?.addEventListener('click', () => {
    const data = exportUsageData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `token-usage-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
  
  // Clear usage data
  clearBtn?.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all usage data? This cannot be undone.')) {
      clearUsageData();
      renderUsageData();
    }
  });
}

// Render usage data to the developer panel
function renderUsageData() {
  const summary = getUsageSummary();
  const byDate = getUsageByDate();
  
  // Update summary stats
  document.getElementById('total-input-tokens').textContent = formatTokenCount(summary.totalInputTokens);
  document.getElementById('total-output-tokens').textContent = formatTokenCount(summary.totalOutputTokens);
  document.getElementById('total-cost').textContent = formatCost(summary.totalCost);
  
  // Calculate total calls
  let totalCalls = 0;
  Object.values(summary.byModel).forEach(m => totalCalls += m.calls);
  document.getElementById('total-calls').textContent = totalCalls.toString();
  
  // Render usage by model
  const modelTbody = document.getElementById('usage-by-model');
  if (modelTbody) {
    const modelEntries = Object.entries(summary.byModel);
    if (modelEntries.length === 0) {
      modelTbody.innerHTML = '<tr class="usage-empty-row"><td colspan="5">No usage data yet</td></tr>';
    } else {
      modelTbody.innerHTML = modelEntries
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([key, data]) => `
          <tr>
            <td class="usage-model-name">${data.model}</td>
            <td>${data.calls}</td>
            <td>${formatTokenCount(data.inputTokens)}</td>
            <td>${formatTokenCount(data.outputTokens)}</td>
            <td>${formatCost(data.cost)}</td>
          </tr>
        `).join('');
    }
  }
  
  // Render usage by feature
  const featureTbody = document.getElementById('usage-by-feature');
  if (featureTbody) {
    const featureEntries = Object.entries(summary.byFeature);
    if (featureEntries.length === 0) {
      featureTbody.innerHTML = '<tr class="usage-empty-row"><td colspan="5">No usage data yet</td></tr>';
    } else {
      featureTbody.innerHTML = featureEntries
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([feature, data]) => `
          <tr>
            <td class="usage-feature-name">${feature}</td>
            <td>${data.calls}</td>
            <td>${formatTokenCount(data.inputTokens)}</td>
            <td>${formatTokenCount(data.outputTokens)}</td>
            <td>${formatCost(data.cost)}</td>
          </tr>
        `).join('');
    }
  }
  
  // Render usage by date
  const dateTbody = document.getElementById('usage-by-date');
  if (dateTbody) {
    if (byDate.length === 0) {
      dateTbody.innerHTML = '<tr class="usage-empty-row"><td colspan="5">No usage data yet</td></tr>';
    } else {
      dateTbody.innerHTML = byDate
        .slice(0, 30) // Show last 30 days
        .map(data => `
          <tr>
            <td>${data.date}</td>
            <td>${data.calls}</td>
            <td>${formatTokenCount(data.inputTokens)}</td>
            <td>${formatTokenCount(data.outputTokens)}</td>
            <td>${formatCost(data.cost)}</td>
          </tr>
        `).join('');
    }
  }
}

// Load API keys to modal inputs
function loadApiKeysToModal() {
  const settings = getSettings();
  const anthropicInput = document.getElementById('anthropic-key');
  const openaiInput = document.getElementById('openai-key');
  const geminiInput = document.getElementById('gemini-key');
  
  if (anthropicInput) anthropicInput.value = settings.anthropicKey || '';
  if (openaiInput) openaiInput.value = settings.openaiKey || '';
  if (geminiInput) geminiInput.value = settings.geminiKey || '';
}

// Save API keys from modal inputs
function saveApiKeysFromModal() {
  const anthropicInput = document.getElementById('anthropic-key');
  const openaiInput = document.getElementById('openai-key');
  const geminiInput = document.getElementById('gemini-key');
  
  saveSettings({
    anthropicKey: anthropicInput?.value || '',
    openaiKey: openaiInput?.value || '',
    geminiKey: geminiInput?.value || ''
  });
  
  // Refresh chat panel UI to reflect new API key configuration
  refreshChatPanel();
}

// Clear all API keys
function clearAllApiKeys() {
  saveSettings({
    anthropicKey: '',
    openaiKey: '',
    geminiKey: ''
  });
  
  // Refresh chat panel UI to reflect cleared API keys
  refreshChatPanel();
}

// Render the current resume
function renderCurrentResume() {
  const container = document.getElementById('resume');
  if (!container) return;
  
  const data = store.getData();
  if (!data) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No resume loaded</p>
        <p>Select or create a variant to get started</p>
      </div>
    `;
    return;
  }
  
  // Render based on current layout
  switch (currentLayout) {
    case 'stacked':
      container.innerHTML = renderResumeStacked(data);
      break;
    case 'stacked-vertical':
      // Stacked Vertical - skills below highlights (not side-by-side)
      container.innerHTML = renderResumeStackedVertical(data);
      break;
    case 'right-sidebar':
      container.innerHTML = renderResumeRightSidebar(data);
      break;
    case 'compact':
      container.innerHTML = renderResumeCompact(data);
      break;
    case 'executive':
      container.innerHTML = renderResumeExecutive(data);
      break;
    case 'classic':
      container.innerHTML = renderResumeClassic(data);
      break;
    case 'classic-featured':
      // Classic Featured - highlights after summary, skills at bottom
      container.innerHTML = renderResumeClassicFeatured(data);
      break;
    case 'modern':
      // Modern layout - small left sidebar with header on top
      container.innerHTML = renderResumeModern(data);
      break;
    case 'timeline':
      // Timeline layout - experience with visual timeline
      container.innerHTML = renderResumeTimeline(data);
      break;
    case 'creative':
      // Creative layout - multi-section grid
      container.innerHTML = renderResumeCreative(data);
      break;
    default:
      container.innerHTML = renderResume(data);
  }
  
  // Add layout class to resume for CSS targeting
  const resume = container.querySelector('.resume');
  if (resume) {
    resume.dataset.layout = currentLayout;
  }
  
  // Apply current palette
  applyColorPalette(currentPalette);
  
  // Re-apply spacing settings after render
  initSpacingService();
  
  // Re-apply accent settings after render
  initAccentService();
  
  // Re-apply photo settings after render
  initPhotoService();
  
  // Refresh inline editor
  refreshInlineEditor();
  updateTextToolbarState();
}

// Start the app
init();
