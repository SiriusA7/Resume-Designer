/**
 * The Design tab's control logic, with no framework around it.
 *
 * Every design control is the same composition — apply the setting to the live
 * canvas, save it through its service, and for the ones that change the
 * rendered height, schedule the debounced re-paginate. That composition used to
 * live inside DesignTab's React handlers, which made it unreachable from
 * anywhere else: StructurePanel renders null unless it is open and DesignTab
 * only mounts on its own tab, so on iOS — where the web panel is always closed —
 * five of the eight control groups had no callable entry point at all. The
 * services export the primitives (applyX / saveX) but never the composition.
 *
 * So the composition lives here and both shells call it: DesignTab for the web,
 * `setDesign` / `resetDesign` / `setDesignImage` in iosShell.js for the native
 * sheet. Nothing here imports React and nothing here holds component state; the
 * settings themselves live in storage, which is what lets the same call produce
 * the same result from either side.
 *
 * Three of the eight groups do NOT write through a service: page setup, colour
 * and layout dispatch `rd:design-change`, the seam that already existed
 * (main.js handleDesignChange). It owns saving those into the profile settings
 * blob AND the re-render they need, so duplicating either here would double the
 * write. The other five own their own storage key and are applied directly.
 *
 * `getDesignState()` is the read side: the settings AND the catalogs the native
 * pickers render from. It is deliberately not the raw service objects — see the
 * notes on `hasImage` and on the header-style CSS.
 */

import { getSettings, saveSettings } from './persistence.js';
import {
  FONT_PAIRINGS,
  POPULAR_GOOGLE_FONTS,
  SYSTEM_FONT_STACKS,
  applyFontSettings,
  getCurrentFontSettings,
  loadFontPairing,
  loadGoogleFont,
  saveFontSettings,
} from './fontService.js';
import {
  GRADIENT_STYLES,
  PATTERN_STYLES,
  TEXTURE_STYLES,
  applyHeaderStyle,
  getHeaderStyleSettings,
  getStylePreview,
  saveHeaderStyleSettings,
} from './headerStyleService.js';
import {
  applySpacingSettings,
  getSpacingSettings,
  resetSpacingSettings,
  saveSpacingSettings,
} from './spacingService.js';
import {
  BORDER_RADIUS_PRESETS,
  BULLET_STYLES,
  UNDERLINE_STYLES,
  applyAccentSettings,
  getAccentSettings,
  resetAccentSettings,
  saveAccentSettings,
} from './accentService.js';
import {
  PHOTO_PLACEMENTS,
  PHOTO_SHAPES,
  PHOTO_SIZES,
  applyPhotoSettings,
  getPhotoSettings,
  removePhoto,
  savePhotoSettings,
} from './photoService.js';

// ---------------------------------------------------------------------------
// Catalogs the services don't own
// ---------------------------------------------------------------------------
//
// These four tables used to be private to DesignTab.jsx. They live here because
// the native sheet renders the same lists, and Swift holding its own copy would
// make the swatch or the layout name the copy nobody notices has drifted — the
// palette table is already duplicated in main.js for what actually gets applied.

// The three-tone swatch each palette paints: p1 accent, p2 header, p3 sidebar.
export const COLOR_PALETTES = {
  terracotta: { name: 'Terracotta', p1: '#c45c3e', p2: '#2d2a26', p3: '#f4e8e4' },
  rose: { name: 'Rose', p1: '#e11d48', p2: '#4a1025', p3: '#fce7f3' },
  amber: { name: 'Amber', p1: '#d97706', p2: '#451a03', p3: '#fef3c7' },
  coral: { name: 'Coral', p1: '#f97316', p2: '#431407', p3: '#ffedd5' },
  ocean: { name: 'Ocean', p1: '#2563eb', p2: '#1e3a5f', p3: '#e8f0fe' },
  teal: { name: 'Teal', p1: '#0d9488', p2: '#134e4a', p3: '#ccfbf1' },
  forest: { name: 'Forest', p1: '#059669', p2: '#1a3c34', p3: '#e6f4f0' },
  cyan: { name: 'Cyan', p1: '#0891b2', p2: '#164e63', p3: '#cffafe' },
  plum: { name: 'Plum', p1: '#7c3aed', p2: '#2d1f47', p3: '#f3e8ff' },
  indigo: { name: 'Indigo', p1: '#4f46e5', p2: '#1e1b4b', p3: '#e0e7ff' },
  slate: { name: 'Slate', p1: '#64748b', p2: '#1e293b', p3: '#f1f5f9' },
  zinc: { name: 'Zinc', p1: '#52525b', p2: '#18181b', p3: '#f4f4f5' },
};

export const SPACING_PRESETS = {
  compact: {
    name: 'Compact',
    description: 'Tighter spacing for more content',
    fontScale: 0.9,
    lineHeight: 1.3,
    sectionSpacing: 0.6,
    sidebarWidth: 2.0,
    pageMargins: { top: 0.35, right: 0.35, bottom: 0.35, left: 0.35 },
  },
  normal: {
    name: 'Normal',
    description: 'Balanced and readable',
    fontScale: 1.0,
    lineHeight: 1.45,
    sectionSpacing: 0.8,
    sidebarWidth: 2.2,
    pageMargins: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 },
  },
  relaxed: {
    name: 'Relaxed',
    description: 'More breathing room',
    fontScale: 1.05,
    lineHeight: 1.6,
    sectionSpacing: 1.0,
    sidebarWidth: 2.4,
    pageMargins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
  },
  airy: {
    name: 'Airy',
    description: 'Maximum whitespace',
    fontScale: 1.1,
    lineHeight: 1.75,
    sectionSpacing: 1.2,
    sidebarWidth: 2.5,
    pageMargins: { top: 0.6, right: 0.6, bottom: 0.6, left: 0.6 },
  },
};

export const PAGE_SIZES = [
  { id: 'continuous', name: 'Continuous' },
  { id: 'letter', name: 'Letter (8.5 × 11 in)' },
  { id: 'a4', name: 'A4 (210 × 297 mm)' },
  { id: 'legal', name: 'Legal (8.5 × 14 in)' },
  { id: 'tabloid', name: 'Tabloid (11 × 17 in)' },
];

export const LAYOUTS = [
  { id: 'sidebar', name: 'Sidebar' },
  { id: 'right-sidebar', name: 'Right side' },
  { id: 'stacked', name: 'Stacked' },
  { id: 'stacked-vertical', name: 'Flow' },
  { id: 'compact', name: 'Compact' },
  { id: 'executive', name: 'Executive' },
  { id: 'classic', name: 'Classic' },
  { id: 'classic-featured', name: 'Featured' },
  { id: 'modern', name: 'Modern' },
  { id: 'timeline', name: 'Timeline' },
  { id: 'creative', name: 'Creative' },
];

// The one accent option accentService has no table for — it is a `data-` value
// the renderer reads, so the names only ever existed in the picker's markup.
export const SKILL_TAG_STYLES = {
  plain: { name: 'Plain', description: 'Plain (bullet-separated)' },
  filled: { name: 'Filled', description: 'Filled' },
  outlined: { name: 'Outlined', description: 'Outlined' },
  minimal: { name: 'Minimal', description: 'Minimal' },
};

// The settings blob's own fallbacks, restated because `getSettings()` returns
// the blob as written and a résumé saved before a control existed has no value
// for it.
const DEFAULT_PALETTE = 'terracotta';
const DEFAULT_CUSTOM_COLOR = '#c45c3e';

// ---------------------------------------------------------------------------
// Derivations shared with the web panel
// ---------------------------------------------------------------------------

/** Darken by 70%. Ported verbatim from the vanilla panel. */
export function generateDarkColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * 0.2).toString(16).padStart(2, '0');
  const dg = Math.round(g * 0.2).toString(16).padStart(2, '0');
  const db = Math.round(b * 0.2).toString(16).padStart(2, '0');
  return `#${dr}${dg}${db}`;
}

// Mix toward white by `factor`. Ported verbatim from the vanilla panel.
function adjustColorBrightness(hex, factor) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  const newR = Math.min(255, Math.max(0, Math.round(r + (255 - r) * factor)));
  const newG = Math.min(255, Math.max(0, Math.round(g + (255 - g) * factor)));
  const newB = Math.min(255, Math.max(0, Math.round(b + (255 - b) * factor)));

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

/**
 * The three colours every header style is generated from.
 *
 * Re-derived from the stored settings on every call, never from component
 * state: `applyHeaderStyle` needs them and it is now called from both shells,
 * so a second copy of this arithmetic would drift the header away from the
 * palette its own swatch is showing.
 */
export function getCurrentColors() {
  const settings = getSettings();
  const palette = settings.colorPalette || DEFAULT_PALETTE;
  if (palette === 'custom') {
    const custom = settings.customColor || DEFAULT_CUSTOM_COLOR;
    return {
      headerBg: generateDarkColor(custom),
      headerBgEnd: adjustColorBrightness(generateDarkColor(custom), 0.1),
      accent: custom,
    };
  }
  const p = COLOR_PALETTES[palette];
  return {
    headerBg: p.p2,
    headerBgEnd: adjustColorBrightness(p.p2, 0.15),
    accent: p.p1,
  };
}

/**
 * Which spacing preset the current values look like, `''` once they look like
 * none of them.
 *
 * The active preset is inferred, not stored — the sliders write individual
 * fields and a preset is just five of them at once. The tolerances are what
 * make "Normal, then nudge the line height" still read as Normal. Both shells
 * call this rather than re-deriving it, because a second set of thresholds
 * would disagree the moment either moved.
 */
export function detectSpacingPreset(spacing) {
  for (const [id, preset] of Object.entries(SPACING_PRESETS)) {
    if (
      Math.abs(spacing.fontScale - preset.fontScale) < 0.05 &&
      Math.abs(spacing.lineHeight - preset.lineHeight) < 0.1 &&
      Math.abs(spacing.sectionSpacing - preset.sectionSpacing) < 0.1
    ) {
      return id;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Write plumbing
// ---------------------------------------------------------------------------

function dispatchDesignChange(detail) {
  window.dispatchEvent(new CustomEvent('rd:design-change', { detail }));
}

// Spacing, font, accent and photo changes alter the rendered height but only
// apply CSS / load a font — they don't re-split paginated sheets. Debounce a
// re-paginate (main.js no-ops it in continuous mode) so a slider drag stays
// smooth and the breaks settle once the change lands. Writing per frame without
// this re-splits every page on every frame; skipping it leaves stale breaks
// that clip content out of the exported PDF.
let repaginateTimer = null;
function scheduleRepaginate() {
  clearTimeout(repaginateTimer);
  repaginateTimer = setTimeout(() => dispatchDesignChange({ type: 'spacing' }), 200);
}

// Swift sends every payload value as a string (the bridge's convention), the
// web panel sends the native type its control produced. Both land here.
function toNumber(value) {
  return typeof value === 'number' ? value : parseFloat(value);
}

function toBoolean(value) {
  return typeof value === 'boolean' ? value : value === 'true';
}

function writeHeaderStyle(next) {
  applyHeaderStyle(next, getCurrentColors());
  saveHeaderStyleSettings(next);
}

function writeFontSettings(next) {
  applyFontSettings(next);
  saveFontSettings(next);
  scheduleRepaginate();
}

function writeSpacing(next) {
  applySpacingSettings(next);
  saveSpacingSettings(next);
  scheduleRepaginate();
}

function writePhoto(next) {
  applyPhotoSettings(next);
  savePhotoSettings(next);
  scheduleRepaginate();
}

const MARGIN_SIDES = {
  marginTop: 'top',
  marginRight: 'right',
  marginBottom: 'bottom',
  marginLeft: 'left',
};
const SPACING_SCALARS = ['fontScale', 'lineHeight', 'sectionSpacing', 'sidebarWidth'];
const ACCENT_NAMES = ['underlineStyle', 'bulletStyle', 'borderRadius', 'skillTagStyle'];
const ACCENT_FLAGS = ['showCornerTriangle', 'showSidebarGradient'];
const PHOTO_NAMES = ['placement', 'shape', 'size', 'borderColor', 'objectPosition'];

function applyPage(property, value) {
  switch (property) {
    case 'size':
      dispatchDesignChange({ type: 'pageSize', value: String(value) });
      return;
    case 'orientation':
      dispatchDesignChange({ type: 'orientation', value: String(value) });
      return;
    case 'widthIn': {
      // Typed live into a text field, so most keystrokes are not yet a width:
      // "" and "8." both arrive here, and a NaN would lay the page out at
      // `NaNin` wide. Only a real positive width is dispatched — the field goes
      // on showing whatever was typed.
      const n = toNumber(value);
      if (Number.isFinite(n) && n > 0) dispatchDesignChange({ type: 'pageWidthIn', value: n });
      return;
    }
    case 'groupPositions':
      dispatchDesignChange({ type: 'groupPositions', value: toBoolean(value) });
      return;
    default:
      throw new Error(`unknown design property: page.${property}`);
  }
}

function applyColor(property, value) {
  if (property === 'palette') {
    // The custom colour is echoed because main.js writes BOTH fields on a
    // palette change: without it, the module-level copy there — which can be a
    // whole session behind — is saved back over the stored one.
    dispatchDesignChange({
      type: 'palette',
      value: String(value),
      customColor: getSettings().customColor || DEFAULT_CUSTOM_COLOR,
    });
    return;
  }
  if (property === 'customColor') {
    const color = String(value);
    if ((getSettings().colorPalette || DEFAULT_PALETTE) === 'custom') {
      dispatchDesignChange({ type: 'customColor', value: color });
      return;
    }
    // Picking a colour while another palette is active must NOT restyle the
    // résumé. It is still the colour the custom swatch previews and the one
    // that gets applied the moment that swatch is chosen, so it is stored —
    // main.js only ever learns it from the echo above, and a sheet with no
    // component state has nowhere else to keep it.
    saveSettings({ customColor: color });
    return;
  }
  throw new Error(`unknown design property: color.${property}`);
}

function applyHeader(property, value) {
  const current = getHeaderStyleSettings();
  if (property === 'style') {
    // One value, not two: a styleId belongs to exactly one family's catalog, so
    // sending them apart invites a pair that names nothing.
    const [type, styleId] = String(value).split(':');
    if (!type || !styleId) throw new Error(`design header style needs "<type>:<id>", got: ${value}`);
    writeHeaderStyle({ ...current, type, styleId });
    return;
  }
  if (property === 'imageOpacity') {
    // 0–1, the same scale the projection reports and the service stores. The
    // 0–100 slider is the web panel's own units and it divides before calling.
    writeHeaderStyle({ ...current, imageOpacity: toNumber(value) });
    return;
  }
  if (property === 'imageFit') {
    writeHeaderStyle({ ...current, imageFit: String(value) });
    return;
  }
  throw new Error(`unknown design property: header.${property}`);
}

// One counter per font slot. Every choice below that has to fetch something
// leaves the list live while it does, so two ordinary taps overlap and the
// write order is the NETWORK's order rather than the person's.
const fontRequests = { pairing: 0, display: 0, body: 0 };

async function applyFonts(property, value) {
  const token = (fontRequests[property] = (fontRequests[property] ?? 0) + 1);
  const modeAtStart = getCurrentFontSettings().mode;
  // True when this request has been overtaken and must not write.
  //
  // TWO ways to be overtaken, and each misses the other's case. A newer tap on
  // the SAME slot bumps the counter — without which the slower of two families
  // wins the slot. A newer tap that changes the SOURCE moves the mode — and a
  // stale write would not merely be old, it would flip the mode back and null
  // the other half, because `nextFontSettings` starts both halves over on a
  // mode change. That is why the mode test is not simply "it moved": a sibling
  // request landing first moves it too, legitimately, toward the very mode this
  // one is about to write. Only a move to a THIRD mode means someone else chose.
  const overtaken = (mode) => {
    if (fontRequests[property] !== token) return true;
    const now = getCurrentFontSettings().mode;
    return now !== modeAtStart && now !== mode;
  };

  if (property === 'pairing') {
    const pairingId = String(value);
    // The webfont has to be in the document before the family is applied, or
    // the résumé renders — and repaginates — against the fallback's metrics.
    await loadFontPairing(pairingId);
    if (overtaken('preset')) return;
    writeFontSettings({ mode: 'preset', pairingId });
    return;
  }
  if (property !== 'display' && property !== 'body') {
    throw new Error(`unknown design property: fonts.${property}`);
  }

  // `id` is a Google family or a system stack id; the source says which, and
  // the two are stored in different shapes.
  const [source, id, category] = String(value).split(':');
  if (source === 'google') {
    await loadGoogleFont(id, [400, 500, 600, 700]);
    if (overtaken('google')) return;
    const next = nextFontSettings('google');
    next[`${property}Font`] = { family: id, category };
    writeFontSettings(next);
    return;
  }
  if (source === 'system') {
    const next = nextFontSettings('system');
    next[`${property}Font`] = id;
    writeFontSettings(next);
    return;
  }
  throw new Error(`design font needs "google:<family>:<category>" or "system:<id>", got: ${value}`);
}

// Changing one half of a pair keeps the other only within the same mode:
// a Google family and a system stack id are not interchangeable, so switching
// source starts both halves over rather than leaving one that cannot resolve.
function nextFontSettings(mode) {
  const current = getCurrentFontSettings();
  return current.mode === mode ? { ...current } : { mode, displayFont: null, bodyFont: null };
}

function applySpacing(property, value) {
  if (property === 'preset') {
    const preset = SPACING_PRESETS[String(value)];
    if (!preset) throw new Error(`unknown spacing preset: ${value}`);
    writeSpacing({
      fontScale: preset.fontScale,
      lineHeight: preset.lineHeight,
      sectionSpacing: preset.sectionSpacing,
      sidebarWidth: preset.sidebarWidth,
      pageMargins: { ...preset.pageMargins },
    });
    return;
  }
  const current = getSpacingSettings();
  const side = MARGIN_SIDES[property];
  if (side) {
    writeSpacing({ ...current, pageMargins: { ...current.pageMargins, [side]: toNumber(value) } });
    return;
  }
  if (!SPACING_SCALARS.includes(property)) {
    throw new Error(`unknown design property: spacing.${property}`);
  }
  writeSpacing({ ...current, [property]: toNumber(value) });
}

function applyAccent(property, value) {
  const current = getAccentSettings();
  let next;
  if (property === 'underlineWidth') next = { ...current, underlineWidth: toNumber(value) };
  else if (ACCENT_FLAGS.includes(property)) next = { ...current, [property]: toBoolean(value) };
  else if (ACCENT_NAMES.includes(property)) next = { ...current, [property]: String(value) };
  else throw new Error(`unknown design property: accent.${property}`);

  applyAccentSettings(next);
  saveAccentSettings(next);
  // Some accent options change layout height (e.g. filled/outlined skill-tag
  // styles add padding), so a fixed page size needs fresh page breaks.
  scheduleRepaginate();
}

function applyPhoto(property, value) {
  const current = getPhotoSettings();
  if (property === 'enabled') {
    writePhoto({ ...current, enabled: toBoolean(value) });
    return;
  }
  if (property === 'scale') {
    writePhoto({ ...current, scale: toNumber(value) });
    return;
  }
  if (!PHOTO_NAMES.includes(property)) {
    throw new Error(`unknown design property: photo.${property}`);
  }
  writePhoto({ ...current, [property]: String(value) });
}

// ---------------------------------------------------------------------------
// The API both shells call
// ---------------------------------------------------------------------------

/**
 * Write one design setting.
 *
 * The single write path. `value` may arrive as the string the bridge sends or
 * as the number/boolean a web control produced; each group coerces its own.
 *
 * Async only because the two font paths fetch a webfont first — every other
 * group has already applied, saved and scheduled its re-paginate before the
 * returned promise is awaited.
 *
 * @param {{group: string, property: string, value: unknown}} change
 */
export async function applyDesign({ group, property, value } = {}) {
  switch (group) {
    case 'page': return applyPage(property, value);
    case 'color': return applyColor(property, value);
    case 'layout':
      if (property !== 'value') throw new Error(`unknown design property: layout.${property}`);
      return dispatchDesignChange({ type: 'layout', value: String(value) });
    case 'header': return applyHeader(property, value);
    case 'fonts': return applyFonts(property, value);
    case 'spacing': return applySpacing(property, value);
    case 'accent': return applyAccent(property, value);
    case 'photo': return applyPhoto(property, value);
    default: throw new Error(`unknown design group: ${group}`);
  }
}

/**
 * Drop a whole group back to its service's defaults.
 *
 * Only the two groups whose service exports a reset: both WRITE their defaults
 * to storage and re-apply them themselves, so all that is composed here is the
 * re-paginate they leave behind. They write rather than remove because these
 * keys are synced and a removal announces nothing — see `resetSpacingSettings`.
 *
 * @param {string} group 'spacing' | 'accent'
 */
export function resetDesign(group) {
  if (group === 'spacing') {
    resetSpacingSettings();
    scheduleRepaginate();
    return;
  }
  if (group === 'accent') {
    resetAccentSettings();
    scheduleRepaginate();
    return;
  }
  throw new Error(`unknown design group to reset: ${group}`);
}

/**
 * Set the profile photo or the header background from an image.
 *
 * Takes a data URL, not a File: the web panel reads one through a FileReader
 * and the native sheet reads one out of PhotosPicker, and neither shape crosses
 * to the other.
 *
 * @param {string} target 'photo' | 'header'
 * @param {string} dataUrl
 */
export function setDesignImage(target, dataUrl) {
  const url = String(dataUrl ?? '');
  if (target === 'photo') {
    writePhoto({ ...getPhotoSettings(), enabled: true, imageData: url });
    return;
  }
  if (target === 'header') {
    const current = getHeaderStyleSettings();
    writeHeaderStyle({
      ...current,
      type: 'image',
      styleId: 'custom',
      customImage: url,
      imageOpacity: current.imageOpacity || 0.3,
      imageFit: current.imageFit || 'cover',
    });
    return;
  }
  throw new Error(`unknown design image target: ${target}`);
}

/**
 * Remove the profile photo or the header background image.
 *
 * @param {string} target 'photo' | 'header'
 */
export function clearDesignImage(target) {
  if (target === 'photo') {
    // The service already saves and applies the cleared settings; only the
    // re-paginate is left, since the résumé just lost a photo-sized block.
    removePhoto();
    scheduleRepaginate();
    return;
  }
  if (target === 'header') {
    // A reset, not a field clear: an image header whose image is taken away has
    // no background left to fall back to, so it goes to the default gradient.
    writeHeaderStyle({
      type: 'gradient',
      styleId: 'linear-135',
      customImage: null,
      imageOpacity: 0.3,
      imageFit: 'cover',
    });
    return;
  }
  throw new Error(`unknown design image target: ${target}`);
}

// The header-style catalogs hold `css` as a FUNCTION of the current colours, so
// they cannot cross the bridge as they are. Evaluating them here is what lets a
// native tile preview the style itself instead of listing a name.
function headerStyleRows(styles, group, colors) {
  return Object.entries(styles).map(([id, style]) => ({
    id,
    name: style.name,
    group,
    css: getStylePreview(group, id, colors),
  }));
}

// The pickers show the family the user chose, not the storage shape it took:
// a preset stores an id, Google stores {family, category}, system stores a
// stack id.
function fontNames(fonts) {
  if (fonts.mode === 'preset' && fonts.pairingId) {
    const pairing = FONT_PAIRINGS[fonts.pairingId];
    return {
      displayName: pairing ? pairing.display.family : '',
      bodyName: pairing ? pairing.body.family : '',
    };
  }
  if (fonts.mode === 'google') {
    return {
      displayName: fonts.displayFont?.family || '',
      bodyName: fonts.bodyFont?.family || '',
    };
  }
  if (fonts.mode === 'system') {
    return {
      displayName: SYSTEM_FONT_STACKS[fonts.displayFont]?.name || '',
      bodyName: SYSTEM_FONT_STACKS[fonts.bodyFont]?.name || '',
    };
  }
  return { displayName: '', bodyName: '' };
}

function options(table) {
  return Object.entries(table).map(([id, entry]) => ({ id, name: entry.name }));
}

/**
 * Everything the Design sheet renders from: the current settings, plus every
 * catalog its pickers offer.
 *
 * Read fresh from storage each call — this is the read side of a write path
 * that both shells share, so anything cached here would be a third opinion
 * about what the settings are.
 *
 * The two image data URLs are deliberately absent. `photo.imageData` and
 * `headerStyle.customImage` are frequently multi-megabyte base64, this is
 * projected on every publish, and the canvas is already rendering both a few
 * pixels away — so presence crosses as `hasImage`, following `hasApiKey`.
 */
export function getDesignState() {
  const settings = getSettings();
  const colors = getCurrentColors();
  const header = getHeaderStyleSettings();
  const fonts = getCurrentFontSettings();
  const spacing = getSpacingSettings();
  const accent = getAccentSettings();
  const photo = getPhotoSettings();

  return {
    page: {
      size: settings.pageSize || 'continuous',
      orientation: settings.orientation || 'portrait',
      widthIn: settings.pageWidthIn ?? 8.5,
      // Absence means grouped, matching main.js — only an explicit false is off.
      groupPositions: settings.groupPositions !== false,
    },
    pageSizes: PAGE_SIZES,
    color: {
      palette: settings.colorPalette || DEFAULT_PALETTE,
      customColor: settings.customColor || DEFAULT_CUSTOM_COLOR,
    },
    palettes: Object.entries(COLOR_PALETTES).map(([id, p]) => ({
      id, name: p.name, p1: p.p1, p2: p.p2, p3: p.p3,
    })),
    layout: settings.layout || 'sidebar',
    layouts: LAYOUTS,
    header: {
      type: header.type,
      styleId: header.styleId,
      imageOpacity: header.imageOpacity,
      imageFit: header.imageFit,
      hasImage: !!header.customImage,
    },
    headerStyles: [
      ...headerStyleRows(GRADIENT_STYLES, 'gradient', colors),
      ...headerStyleRows(PATTERN_STYLES, 'pattern', colors),
      ...headerStyleRows(TEXTURE_STYLES, 'texture', colors),
    ],
    fonts: {
      mode: fonts.mode,
      // '' in google/system mode: no preset is selected, and the stored
      // pairingId is only the one a later switch back to presets would restore.
      pairingId: fonts.mode === 'preset' ? (fonts.pairingId || '') : '',
      ...fontNames(fonts),
    },
    fontPairings: Object.entries(FONT_PAIRINGS).map(([id, p]) => ({
      id, name: p.name, display: p.display.family, body: p.body.family,
    })),
    systemFonts: options(SYSTEM_FONT_STACKS),
    googleFonts: POPULAR_GOOGLE_FONTS.map((f) => ({ family: f.family, category: f.category })),
    spacing: {
      fontScale: spacing.fontScale,
      lineHeight: spacing.lineHeight,
      sectionSpacing: spacing.sectionSpacing,
      sidebarWidth: spacing.sidebarWidth,
      marginTop: spacing.pageMargins.top,
      marginRight: spacing.pageMargins.right,
      marginBottom: spacing.pageMargins.bottom,
      marginLeft: spacing.pageMargins.left,
      presetId: detectSpacingPreset(spacing),
    },
    spacingPresets: options(SPACING_PRESETS),
    accent: {
      underlineStyle: accent.underlineStyle,
      underlineWidth: accent.underlineWidth,
      bulletStyle: accent.bulletStyle,
      borderRadius: accent.borderRadius,
      skillTagStyle: accent.skillTagStyle,
      showCornerTriangle: accent.showCornerTriangle !== false,
      showSidebarGradient: accent.showSidebarGradient !== false,
    },
    underlines: options(UNDERLINE_STYLES),
    bullets: Object.entries(BULLET_STYLES).map(([id, b]) => ({ id, name: b.name, char: b.char })),
    radii: options(BORDER_RADIUS_PRESETS),
    skillTags: options(SKILL_TAG_STYLES),
    photo: {
      enabled: !!photo.enabled,
      hasImage: !!photo.imageData,
      placement: photo.placement,
      shape: photo.shape,
      size: photo.size,
      borderColor: photo.borderColor,
      objectPosition: photo.objectPosition,
      scale: photo.scale,
    },
    placements: options(PHOTO_PLACEMENTS),
    shapes: options(PHOTO_SHAPES),
    sizes: options(PHOTO_SIZES),
  };
}
