/**
 * DesignTab — the structure panel's "Design" tab, restyled onto genuine shadcn
 * primitives + Tailwind utilities for the full-shadcn chrome redesign.
 *
 * Faithful, behavior-preserving reskin of the seven design sections (Color
 * Theme, Header Style, Typography, Layout, Spacing & Sizing, Accents, Profile
 * Photo). Every handler still calls the same service apply/save APIs with the
 * same values in the same order as the vanilla port did. Data-driven visuals
 * (palette swatches, gradient/pattern/texture previews, font families, the
 * photo preview) keep inline styles — that's content, not theme; all chrome
 * colors are semantic token classes.
 *
 * Only palette / layout / customColor dispatch `rd:design-change` for main.js
 * to consume — every other control just applies + saves through its service.
 */

import { useState } from 'react';
import { Image as ImageIcon, RotateCcw, Trash2, User, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented as SegmentedTrack, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { PanelSection } from './PanelSection.jsx';
import { getSettings } from '../../persistence.js';
import {
  FONT_PAIRINGS,
  SYSTEM_FONT_STACKS,
  loadFontPairing,
  loadGoogleFont,
  applyFontSettings,
  getCurrentFontSettings,
  saveFontSettings,
  searchGoogleFonts,
} from '../../fontService.js';
import {
  GRADIENT_STYLES,
  PATTERN_STYLES,
  TEXTURE_STYLES,
  getHeaderStyleSettings,
  saveHeaderStyleSettings,
  applyHeaderStyle,
} from '../../headerStyleService.js';
import {
  getSpacingSettings,
  saveSpacingSettings,
  applySpacingSettings,
  resetSpacingSettings,
} from '../../spacingService.js';
import {
  UNDERLINE_STYLES,
  BULLET_STYLES,
  BORDER_RADIUS_PRESETS,
  getAccentSettings,
  saveAccentSettings,
  applyAccentSettings,
  resetAccentSettings,
} from '../../accentService.js';
import {
  PHOTO_PLACEMENTS,
  PHOTO_SHAPES,
  PHOTO_SIZES,
  getPhotoSettings,
  savePhotoSettings,
  applyPhotoSettings,
  removePhoto,
} from '../../photoService.js';

// ---------------------------------------------------------------------------
// Static data (ported verbatim from structurePanel.js)
// ---------------------------------------------------------------------------

// Color palette definitions
const COLOR_PALETTES = {
  terracotta: { p1: '#c45c3e', p2: '#2d2a26', p3: '#f4e8e4' },
  rose: { p1: '#e11d48', p2: '#4a1025', p3: '#fce7f3' },
  amber: { p1: '#d97706', p2: '#451a03', p3: '#fef3c7' },
  coral: { p1: '#f97316', p2: '#431407', p3: '#ffedd5' },
  ocean: { p1: '#2563eb', p2: '#1e3a5f', p3: '#e8f0fe' },
  teal: { p1: '#0d9488', p2: '#134e4a', p3: '#ccfbf1' },
  forest: { p1: '#059669', p2: '#1a3c34', p3: '#e6f4f0' },
  cyan: { p1: '#0891b2', p2: '#164e63', p3: '#cffafe' },
  plum: { p1: '#7c3aed', p2: '#2d1f47', p3: '#f3e8ff' },
  indigo: { p1: '#4f46e5', p2: '#1e1b4b', p3: '#e0e7ff' },
  slate: { p1: '#64748b', p2: '#1e293b', p3: '#f1f5f9' },
  zinc: { p1: '#52525b', p2: '#18181b', p3: '#f4f4f5' },
};

// Spacing presets
const SPACING_PRESETS = {
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

// Layout picker definitions — values/labels ported verbatim from the inline
// grid; the old inline-SVG icons are recreated as Tailwind block thumbnails
// (bg-muted-foreground tints on token colors only).
const LAYOUT_OPTIONS = [
  {
    value: 'sidebar',
    label: 'Sidebar',
    preview: (
      <span className="flex h-12 w-full gap-1">
        <span className="w-1/3 rounded-sm bg-muted-foreground/40" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
      </span>
    ),
  },
  {
    value: 'right-sidebar',
    label: 'Right Side',
    preview: (
      <span className="flex h-12 w-full gap-1">
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
        <span className="w-1/3 rounded-sm bg-muted-foreground/40" />
      </span>
    ),
  },
  {
    value: 'stacked',
    label: 'Stacked',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="flex-1 rounded-sm bg-muted-foreground/40" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
      </span>
    ),
  },
  {
    value: 'stacked-vertical',
    label: 'Flow',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-3 rounded-sm bg-muted-foreground/40" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
        <span className="h-1.5 rounded-sm bg-muted-foreground/15" />
      </span>
    ),
  },
  {
    value: 'compact',
    label: 'Compact',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-3 rounded-sm bg-muted-foreground/40" />
        <span className="flex flex-1 gap-1">
          <span className="flex-1 rounded-sm bg-muted-foreground/15" />
          <span className="w-2.5 rounded-sm bg-muted-foreground/25" />
        </span>
      </span>
    ),
  },
  {
    value: 'executive',
    label: 'Executive',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-4 rounded-sm bg-muted-foreground/40" />
        <span className="flex flex-1 gap-1">
          <span className="flex-1 rounded-sm bg-muted-foreground/15" />
          <span className="w-2.5 rounded-sm bg-muted-foreground/25" />
        </span>
      </span>
    ),
  },
  {
    value: 'classic',
    label: 'Classic',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-3 rounded-sm bg-muted-foreground/40" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
      </span>
    ),
  },
  {
    value: 'classic-featured',
    label: 'Featured',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-2 rounded-sm bg-muted-foreground/40" />
        <span className="h-2.5 rounded-sm bg-muted-foreground/25" />
        <span className="flex-1 rounded-sm bg-muted-foreground/15" />
      </span>
    ),
  },
  {
    value: 'modern',
    label: 'Modern',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-2.5 rounded-sm bg-muted-foreground/40" />
        <span className="flex flex-1 gap-1">
          <span className="w-1/4 rounded-sm bg-muted-foreground/25" />
          <span className="flex-1 rounded-sm bg-muted-foreground/15" />
        </span>
      </span>
    ),
  },
  {
    value: 'timeline',
    label: 'Timeline',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-3 rounded-sm bg-muted-foreground/40" />
        <span className="flex flex-1 gap-1.5">
          <span className="ml-1 border-l border-dashed border-muted-foreground/40" />
          <span className="flex flex-1 flex-col gap-1">
            <span className="flex-1 rounded-sm bg-muted-foreground/15" />
            <span className="flex-1 rounded-sm bg-muted-foreground/15" />
            <span className="flex-1 rounded-sm bg-muted-foreground/15" />
          </span>
        </span>
      </span>
    ),
  },
  {
    value: 'creative',
    label: 'Creative',
    preview: (
      <span className="flex h-12 w-full flex-col gap-1">
        <span className="h-3.5 rounded-sm bg-muted-foreground/40" />
        <span className="flex flex-1 gap-1">
          <span className="flex-1 rounded-sm bg-muted-foreground/15" />
          <span className="flex-1 rounded-sm bg-muted-foreground/15" />
        </span>
        <span className="h-2.5 rounded-sm bg-muted-foreground/25" />
      </span>
    ),
  },
];

// Page-size options for the Page Setup section (value → human label with dims).
const PAGE_SIZE_OPTIONS = [
  { value: 'continuous', label: 'Continuous' },
  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)' },
];

// Image-focus position titles (ported verbatim from the position grid).
const PHOTO_FOCUS_POSITIONS = [
  'left top',
  'center top',
  'right top',
  'left center',
  'center center',
  'right center',
  'left bottom',
  'center bottom',
  'right bottom',
];
const PHOTO_FOCUS_TITLES = {
  'left top': 'Top Left',
  'center top': 'Top Center',
  'right top': 'Top Right',
  'left center': 'Middle Left',
  'center center': 'Center',
  'right center': 'Middle Right',
  'left bottom': 'Bottom Left',
  'center bottom': 'Bottom Center',
  'right bottom': 'Bottom Right',
};

// ---------------------------------------------------------------------------
// Local helpers (ported verbatim)
// ---------------------------------------------------------------------------

// Helper to generate dark color from hex
function generateDarkColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Darken by 70%
  const dr = Math.round(r * 0.2).toString(16).padStart(2, '0');
  const dg = Math.round(g * 0.2).toString(16).padStart(2, '0');
  const db = Math.round(b * 0.2).toString(16).padStart(2, '0');
  return `#${dr}${dg}${db}`;
}

// Helper to generate light color from hex
function generateLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Lighten by mixing with white
  const lr = Math.round(r + (255 - r) * 0.9).toString(16).padStart(2, '0');
  const lg = Math.round(g + (255 - g) * 0.9).toString(16).padStart(2, '0');
  const lb = Math.round(b + (255 - b) * 0.9).toString(16).padStart(2, '0');
  return `#${lr}${lg}${lb}`;
}

// Helper to adjust color brightness (used by getCurrentColors)
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

// Dispatch the design-change event consumed by main.js. Only palette / layout /
// customColor go through here; main.js is a no-op for the other detail types.
function dispatchDesignChange(detail) {
  window.dispatchEvent(new CustomEvent('rd:design-change', { detail }));
}

// Spacing and font changes alter the rendered height but only apply CSS / load a
// font — they don't re-split paginated sheets. Debounce a re-paginate (main.js
// no-ops it in continuous mode) so a slider drag stays smooth and the breaks
// settle once the change lands.
let repaginateTimer = null;
function scheduleRepaginate() {
  clearTimeout(repaginateTimer);
  repaginateTimer = setTimeout(() => dispatchDesignChange({ type: 'spacing' }), 200);
}

// Detect if current spacing matches a preset (ported verbatim)
function detectSpacingPreset(spacing) {
  for (const [id, preset] of Object.entries(SPACING_PRESETS)) {
    if (
      Math.abs(spacing.fontScale - preset.fontScale) < 0.05 &&
      Math.abs(spacing.lineHeight - preset.lineHeight) < 0.1 &&
      Math.abs(spacing.sectionSpacing - preset.sectionSpacing) < 0.1
    ) {
      return id;
    }
  }
  return null;
}

// The old .design-palette-preview three-stripe swatch, as a data-driven inline
// background (p2 dark band, p1 accent band, p3 light band).
function paletteSwatchBackground(p1, p2, p3) {
  return `linear-gradient(135deg, ${p2} 0%, ${p2} 40%, ${p1} 40%, ${p1} 60%, ${p3} 60%, ${p3} 100%)`;
}

// Selectable-tile chrome — the approved mockup `.rcard`: bordered tile, selected
// = terracotta border + 1px primary ring + faint terracotta wash + terracotta
// text/icon (rgba(196,92,62,.04) in the mockup). The terracotta-tinted selected
// state is the spec, not a primary-on-secondary swap.
function tileClass(selected, extra) {
  return cn(
    'rounded-md border text-left transition-colors hover:bg-accent/50',
    selected && 'border-primary bg-primary/[0.04] text-primary ring-1 ring-primary',
    extra,
  );
}

// ---------------------------------------------------------------------------
// Small building blocks (shadcn primitives only)
// ---------------------------------------------------------------------------

// Segmented exclusive-choice row — the approved mockup `.seg` (muted track +
// white sliding pill), built on the real `ui/segmented` primitives. Keeps this
// module's existing options/value/onChange API so every call site is unchanged;
// `stretch` (or an `itemClassName` carrying `w-full`) makes items share the
// width equally for the full-bleed segmented rows.
function Segmented({ options, value, onChange, className, itemClassName, stretch }) {
  const fill = stretch || (itemClassName || '').includes('w-full');
  return (
    <SegmentedTrack className={cn('flex flex-wrap', fill && 'w-full', className)}>
      {options.map((opt) => (
        <SegmentedItem
          key={String(opt.value)}
          size="xs"
          active={value === opt.value}
          className={cn(fill && 'flex-1', itemClassName)}
          title={opt.title}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </SegmentedItem>
      ))}
    </SegmentedTrack>
  );
}

// Horizontal slider row — mockup `.sliderrow`: 90px label, the slider (flex),
// and a 44px right-aligned tabular readout.
function ControlSlider({ label, readout, ...sliderProps }) {
  return (
    <div className="flex items-center gap-2.5">
      <Label className="w-[90px] shrink-0 text-[12.5px] font-medium text-foreground">{label}</Label>
      <Slider className="flex-1" {...sliderProps} />
      <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{readout}</span>
    </div>
  );
}

// Labeled control group (text-xs muted heading over the control).
function ControlGroup({ label, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// Click-or-drop upload target. Same contract as the old dropzones: a label
// wrapping a hidden file input (accept="image/*"), plus dragover/drop handling
// that forwards the first image file.
function UploadDropzone({ onFile, children }) {
  const [dragover, setDragover] = useState(false);
  return (
    <label
      className={cn(
        'flex w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground transition-colors hover:bg-accent/50',
        dragover && 'border-primary bg-accent/50',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragover(true);
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragover(false);
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) onFile(file);
      }}
    >
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onFile(e.target.files[0])}
      />
      {children}
    </label>
  );
}

// Mini preview of a section-title underline style. Chrome colors are tokens;
// the px width is data from accent settings.
function UnderlinePreview({ styleId, width, className }) {
  const base = cn('block', className);
  switch (styleId) {
    case 'double':
      return <span className={cn(base, 'border-y border-primary')} style={{ height: width + 2 }} />;
    case 'dotted':
      return <span className={cn(base, 'border-dotted border-primary')} style={{ borderBottomWidth: width, borderBottomStyle: 'dotted' }} />;
    case 'dashed':
      return <span className={cn(base, 'border-dashed border-primary')} style={{ borderBottomWidth: width, borderBottomStyle: 'dashed' }} />;
    case 'gradient':
      return <span className={cn(base, 'bg-gradient-to-r from-primary to-transparent')} style={{ height: width }} />;
    case 'none':
      return <span className={cn(base, 'bg-muted-foreground/30')} style={{ height: width }} />;
    default:
      return <span className={cn(base, 'bg-primary')} style={{ height: width }} />;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// `sectionProps(id)` is supplied by StructurePanel and returns the controlled
// `{ collapsed, onToggleCollapse }` for a section, backed by a `collapsed` map
// that lives in the (never-unmounting) panel parent. DesignTab itself unmounts
// when you switch away from the Design tab, so routing collapse through the
// parent is what makes each section's collapsed state survive tab switches.
export default function DesignTab({ sectionProps = () => ({}) }) {
  // Seed all design state from the services / persistence on mount.
  const initialSettings = getSettings();
  const [palette, setPalette] = useState(initialSettings.colorPalette || 'terracotta');
  const [layout, setLayout] = useState(initialSettings.layout || 'sidebar');
  const [pageSize, setPageSize] = useState(initialSettings.pageSize || 'continuous');
  const [orientation, setOrientation] = useState(initialSettings.orientation || 'portrait');
  const [pageWidthIn, setPageWidthIn] = useState(initialSettings.pageWidthIn ?? 8.5);
  const [customColor, setCustomColor] = useState(initialSettings.customColor || '#c45c3e');

  const [fontSettings, setFontSettings] = useState(() => getCurrentFontSettings());
  const [fontSubTab, setFontSubTab] = useState('presets'); // 'presets' | 'google' | 'system'
  const [googleFontSearch, setGoogleFontSearch] = useState('');
  const [googleFontCategory, setGoogleFontCategory] = useState(null);

  const [headerStyle, setHeaderStyle] = useState(() => getHeaderStyleSettings());
  const [headerStyleTab, setHeaderStyleTab] = useState('gradients'); // 'gradients' | 'patterns' | 'textures' | 'image'

  const [spacing, setSpacing] = useState(() => getSpacingSettings());
  const [accent, setAccent] = useState(() => getAccentSettings());
  const [photo, setPhoto] = useState(() => getPhotoSettings());

  // ----- Derived color values (mirrors vanilla getCurrentColors) -----------
  function getCurrentColors() {
    const p = COLOR_PALETTES[palette];
    if (palette === 'custom') {
      return {
        headerBg: generateDarkColor(customColor),
        headerBgEnd: adjustColorBrightness(generateDarkColor(customColor), 0.1),
        accent: customColor,
      };
    }
    return {
      headerBg: p.p2,
      headerBgEnd: adjustColorBrightness(p.p2, 0.15),
      accent: p.p1,
    };
  }

  // ===== Color Theme handlers ==============================================

  function handleSetPalette(key) {
    setPalette(key);
    dispatchDesignChange({ type: 'palette', value: key, customColor });
  }

  function handleCustomColorChange(color) {
    setCustomColor(color);
    // If custom palette is active, apply immediately (matches vanilla).
    if (palette === 'custom') {
      dispatchDesignChange({ type: 'customColor', value: color });
    }
  }

  // ===== Layout handler ====================================================

  function handleSetLayout(value) {
    setLayout(value);
    dispatchDesignChange({ type: 'layout', value });
  }

  // ===== Page Setup handlers ===============================================

  function handleSetPageSize(value) {
    setPageSize(value);
    dispatchDesignChange({ type: 'pageSize', value });
  }

  function handleSetOrientation(value) {
    setOrientation(value);
    dispatchDesignChange({ type: 'orientation', value });
  }

  function handleSetPageWidth(raw) {
    setPageWidthIn(raw);
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) dispatchDesignChange({ type: 'pageWidthIn', value: n });
  }

  // ===== Typography handlers ===============================================

  function getCurrentPreviewFonts() {
    if (fontSettings.mode === 'preset' && fontSettings.pairingId) {
      const pairing = FONT_PAIRINGS[fontSettings.pairingId];
      if (pairing) {
        return {
          display: `'${pairing.display.family}', ${pairing.display.category}`,
          body: `'${pairing.body.family}', ${pairing.body.category}`,
        };
      }
    } else if (fontSettings.mode === 'google') {
      return {
        display: fontSettings.displayFont
          ? `'${fontSettings.displayFont.family}', ${fontSettings.displayFont.category}`
          : 'serif',
        body: fontSettings.bodyFont
          ? `'${fontSettings.bodyFont.family}', ${fontSettings.bodyFont.category}`
          : 'sans-serif',
      };
    } else if (fontSettings.mode === 'system') {
      const displayFont = SYSTEM_FONT_STACKS[fontSettings.displayFont];
      const bodyFont = SYSTEM_FONT_STACKS[fontSettings.bodyFont];
      return {
        display: displayFont ? displayFont.family : 'serif',
        body: bodyFont ? bodyFont.family : 'sans-serif',
      };
    }
    return { display: 'serif', body: 'sans-serif' };
  }

  async function handleSelectFontPreset(presetId) {
    const next = { mode: 'preset', pairingId: presetId };
    await loadFontPairing(presetId);
    applyFontSettings(next);
    saveFontSettings(next);
    setFontSettings(next);
    scheduleRepaginate();
  }

  async function handleSelectGoogleFont(family, category, fontType) {
    await loadGoogleFont(family, [400, 500, 600, 700]);

    let next = fontSettings;
    if (next.mode !== 'google') {
      next = { mode: 'google', displayFont: null, bodyFont: null };
    } else {
      next = { ...next };
    }

    if (fontType === 'display') {
      next.displayFont = { family, category };
    } else if (fontType === 'body') {
      next.bodyFont = { family, category };
    }

    applyFontSettings(next);
    saveFontSettings(next);
    setFontSettings(next);
    scheduleRepaginate();
  }

  function handleSelectSystemFont(fontId, fontType) {
    let next = fontSettings;
    if (next.mode !== 'system') {
      next = { mode: 'system', displayFont: null, bodyFont: null };
    } else {
      next = { ...next };
    }

    if (fontType === 'display') {
      next.displayFont = fontId;
    } else if (fontType === 'body') {
      next.bodyFont = fontId;
    }

    applyFontSettings(next);
    saveFontSettings(next);
    setFontSettings(next);
    scheduleRepaginate();
  }

  // ===== Header Style handlers =============================================

  function handleSelectHeaderStyle(styleType, styleId) {
    const next = { ...headerStyle, type: styleType, styleId };
    applyHeaderStyle(next, getCurrentColors());
    saveHeaderStyleSettings(next);
    setHeaderStyle(next);
  }

  function handleHeaderImageOpacity(value) {
    const next = { ...headerStyle, imageOpacity: parseInt(value, 10) / 100 };
    applyHeaderStyle(next, getCurrentColors());
    saveHeaderStyleSettings(next);
    setHeaderStyle(next);
  }

  function handleHeaderImageFit(value) {
    const next = { ...headerStyle, imageFit: value };
    applyHeaderStyle(next, getCurrentColors());
    saveHeaderStyleSettings(next);
    setHeaderStyle(next);
  }

  function handleRemoveHeaderImage() {
    const next = {
      type: 'gradient',
      styleId: 'linear-135',
      customImage: null,
      imageOpacity: 0.3,
      imageFit: 'cover',
    };
    applyHeaderStyle(next, getCurrentColors());
    saveHeaderStyleSettings(next);
    setHeaderStyle(next);
  }

  function handleHeaderImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const next = {
        ...headerStyle,
        type: 'image',
        styleId: 'custom',
        customImage: e.target.result,
        imageOpacity: headerStyle.imageOpacity || 0.3,
        imageFit: headerStyle.imageFit || 'cover',
      };
      applyHeaderStyle(next, getCurrentColors());
      saveHeaderStyleSettings(next);
      setHeaderStyle(next);
    };
    reader.readAsDataURL(file);
  }

  // ===== Spacing handlers ==================================================

  function handleSpacingChange(property, value) {
    const next = { ...spacing, [property]: value };
    applySpacingSettings(next);
    saveSpacingSettings(next);
    setSpacing(next);
    scheduleRepaginate();
  }

  function handleMarginChange(side, value) {
    const next = { ...spacing, pageMargins: { ...spacing.pageMargins, [side]: value } };
    applySpacingSettings(next);
    saveSpacingSettings(next);
    setSpacing(next);
    scheduleRepaginate();
  }

  function handleResetSpacing() {
    setSpacing(resetSpacingSettings());
    scheduleRepaginate();
  }

  function handleApplySpacingPreset(presetId) {
    const preset = SPACING_PRESETS[presetId];
    if (!preset) return;
    const next = {
      fontScale: preset.fontScale,
      lineHeight: preset.lineHeight,
      sectionSpacing: preset.sectionSpacing,
      sidebarWidth: preset.sidebarWidth,
      pageMargins: { ...preset.pageMargins },
    };
    applySpacingSettings(next);
    saveSpacingSettings(next);
    setSpacing(next);
    scheduleRepaginate();
  }

  // ===== Accent handlers ===================================================

  function handleAccentChange(property, value) {
    const next = { ...accent, [property]: value };
    applyAccentSettings(next);
    saveAccentSettings(next);
    setAccent(next);
    // Some accent options change layout height (e.g. filled/outlined skill-tag
    // styles add padding), so a fixed page size needs fresh page breaks.
    scheduleRepaginate();
  }

  function handleResetAccent() {
    setAccent(resetAccentSettings());
    scheduleRepaginate();
  }

  // ===== Photo handlers ====================================================

  function handlePhotoChange(property, value) {
    const next = { ...photo, [property]: value };
    applyPhotoSettings(next);
    savePhotoSettings(next);
    setPhoto(next);
    scheduleRepaginate();
  }

  function handleRemovePhoto() {
    setPhoto(removePhoto());
    scheduleRepaginate();
  }

  function handlePhotoFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const next = { ...photo, enabled: true, imageData: e.target.result };
      applyPhotoSettings(next);
      savePhotoSettings(next);
      setPhoto(next);
      scheduleRepaginate();
    };
    reader.readAsDataURL(file);
  }

  // ===== Derived view values ===============================================
  const previewFonts = getCurrentPreviewFonts();
  const colors = getCurrentColors();
  const isSolidHeader = headerStyle.type === 'solid';
  const currentSpacingPreset = detectSpacingPreset(spacing);
  const bulletChar = BULLET_STYLES[accent.bulletStyle]?.char || '•';

  // One tile grid per header-style family (gradients get 2 color args,
  // patterns/textures get the accent too — matching the vanilla calls).
  function renderHeaderStyleTiles(styles, styleType) {
    return (
      <div className="grid grid-cols-3 gap-2">
        {Object.entries(styles).map(([id, style]) => {
          const selected = headerStyle.type === styleType && headerStyle.styleId === id;
          const background = styleType === 'gradient'
            ? style.css(colors.headerBg, colors.headerBgEnd)
            : style.css(colors.headerBg, colors.headerBgEnd, colors.accent);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              title={style.name}
              onClick={() => handleSelectHeaderStyle(styleType, id)}
              className={tileClass(selected, 'p-1.5')}
            >
              <span
                className="block h-9 w-full rounded-sm"
                style={
                  styleType === 'pattern'
                    ? { background, backgroundSize: style.size || 'auto' }
                    : { background }
                }
              />
              <span className="mt-1 block truncate text-xs text-muted-foreground">{style.name}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Reset buttons used as section header extras.
  const spacingResetButton = (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      className="size-7 text-muted-foreground"
      onClick={handleResetSpacing}
      title="Reset"
    >
      <RotateCcw className="size-3.5" />
    </Button>
  );

  const accentResetButton = (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      className="size-7 text-muted-foreground"
      onClick={handleResetAccent}
      title="Reset"
    >
      <RotateCcw className="size-3.5" />
    </Button>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <>
      {/* ===== Page Setup ===== */}
      <PanelSection title="Page Setup" {...sectionProps('page-setup')}>
        <ControlGroup label="Page Size">
          <Select value={pageSize} onValueChange={handleSetPageSize}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlGroup>

        {pageSize === 'continuous' ? (
          <ControlGroup label="Page Width (inches)">
            <Input
              type="number"
              step="0.1"
              min="3"
              max="20"
              className="h-8 px-2"
              value={pageWidthIn}
              onChange={(e) => handleSetPageWidth(e.target.value)}
            />
          </ControlGroup>
        ) : (
          <ControlGroup label="Orientation">
            <Segmented
              stretch
              options={[
                { value: 'portrait', label: 'Portrait' },
                { value: 'landscape', label: 'Landscape' },
              ]}
              value={orientation}
              onChange={handleSetOrientation}
            />
          </ControlGroup>
        )}
      </PanelSection>

      {/* ===== Color Theme ===== */}
      <PanelSection title="Color Theme" {...sectionProps('color-theme')}>
        {/* Palette swatches — mockup `.sw`: 34px, rounded-8, three-tone fill,
            selected = double-ring (inner bg ring + outer primary ring). */}
        <div className="grid grid-cols-6 gap-2">
          {Object.entries(COLOR_PALETTES).map(([key, c]) => (
            <button
              key={key}
              type="button"
              aria-pressed={palette === key}
              title={key.charAt(0).toUpperCase() + key.slice(1)}
              onClick={() => handleSetPalette(key)}
              className={cn(
                'h-[34px] w-full rounded-lg border',
                palette === key
                  ? 'border-transparent ring-2 ring-primary ring-offset-2 ring-offset-background'
                  : 'border-input',
              )}
              style={{ background: paletteSwatchBackground(c.p1, c.p2, c.p3) }}
            />
          ))}
        </div>

        {/* Custom Color */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium">Custom Color</span>
          <button
            type="button"
            aria-pressed={palette === 'custom'}
            title="Custom color"
            onClick={() => handleSetPalette('custom')}
            className={cn(
              'size-[34px] shrink-0 overflow-hidden rounded-lg border',
              palette === 'custom'
                ? 'border-transparent ring-2 ring-primary ring-offset-2 ring-offset-background'
                : 'border-input',
            )}
          >
            <span
              id="design-custom-preview"
              className="block size-full"
              style={{
                background: paletteSwatchBackground(
                  customColor,
                  generateDarkColor(customColor),
                  generateLightColor(customColor),
                ),
              }}
            />
          </button>
          <input
            type="color"
            id="design-custom-color"
            value={customColor}
            onChange={(e) => handleCustomColorChange(e.target.value)}
            className="h-[34px] w-10 cursor-pointer rounded-lg border bg-transparent p-0.5"
            title="Pick a custom color"
          />
        </div>
      </PanelSection>

      {/* ===== Header Style ===== */}
      <PanelSection title="Header Style" {...sectionProps('header-style')}>
        {/* Solid vs styled mode */}
        <Segmented
          stretch
          options={[
            { value: 'solid', label: 'Solid Color', title: 'Use color theme only' },
            { value: 'styled', label: 'Styled', title: 'Add visual effects' },
          ]}
          value={isSolidHeader ? 'solid' : 'styled'}
          onChange={(v) => (
            v === 'solid'
              ? handleSelectHeaderStyle('solid', 'solid')
              : handleSelectHeaderStyle('gradient', 'linear-135')
          )}
        />

        {!isSolidHeader && (
          <>
            {/* Style type */}
            <Segmented
              stretch
              itemClassName="px-1"
              options={[
                { value: 'gradients', label: 'Gradients' },
                { value: 'patterns', label: 'Patterns' },
                { value: 'textures', label: 'Textures' },
                { value: 'image', label: 'Image' },
              ]}
              value={headerStyleTab}
              onChange={setHeaderStyleTab}
            />

            {headerStyleTab === 'gradients' && renderHeaderStyleTiles(GRADIENT_STYLES, 'gradient')}
            {headerStyleTab === 'patterns' && renderHeaderStyleTiles(PATTERN_STYLES, 'pattern')}
            {headerStyleTab === 'textures' && renderHeaderStyleTiles(TEXTURE_STYLES, 'texture')}

            {headerStyleTab === 'image' && (
              <div className="space-y-3">
                {headerStyle.customImage ? (
                  <>
                    <div className="relative overflow-hidden rounded-md border">
                      <img
                        src={headerStyle.customImage}
                        alt="Header background"
                        className="h-20 w-full object-cover"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="absolute right-1 top-1 size-6"
                        title="Remove image"
                        onClick={handleRemoveHeaderImage}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>

                    <ControlSlider
                      label="Opacity"
                      readout={`${Math.round((headerStyle.imageOpacity || 0.3) * 100)}%`}
                      min={0}
                      max={100}
                      step={1}
                      value={[Math.round((headerStyle.imageOpacity || 0.3) * 100)]}
                      onValueChange={([v]) => handleHeaderImageOpacity(v)}
                    />

                    <ControlGroup label="Fit">
                      <Segmented
                        options={[
                          { value: 'cover', label: 'Cover' },
                          { value: 'contain', label: 'Contain' },
                          { value: 'tile', label: 'Tile' },
                        ]}
                        value={headerStyle.imageFit}
                        onChange={handleHeaderImageFit}
                      />
                    </ControlGroup>
                  </>
                ) : (
                  <UploadDropzone onFile={handleHeaderImageFile}>
                    <ImageIcon className="size-6" />
                    <span className="text-sm font-medium text-foreground">
                      Drop image here or click to upload
                    </span>
                    <span className="text-xs">Recommended: 800x200px or larger</span>
                  </UploadDropzone>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => handleSelectHeaderStyle('gradient', 'linear-135')}
                >
                  Reset to Gradient
                </Button>
              </div>
            )}
          </>
        )}
      </PanelSection>

      {/* ===== Typography ===== */}
      <PanelSection title="Typography" {...sectionProps('typography')}>
        {/* Live font preview */}
        <div className="space-y-1 rounded-lg border bg-card p-3">
          <div className="text-sm font-medium" style={{ fontFamily: previewFonts.display }}>
            Jane Smith
          </div>
          <div className="text-xs text-muted-foreground" style={{ fontFamily: previewFonts.body }}>
            Senior Software Engineer with 8+ years of experience building scalable web applications.
          </div>
        </div>

        {/* Font source */}
        <Segmented
          stretch
          itemClassName="px-1"
          options={[
            { value: 'presets', label: 'Presets' },
            { value: 'google', label: 'Google Fonts' },
            { value: 'system', label: 'System' },
          ]}
          value={fontSubTab}
          onChange={setFontSubTab}
        />

        {fontSubTab === 'presets' && (
          <div className="space-y-1.5">
            {Object.entries(FONT_PAIRINGS).map(([id, pairing]) => {
              const currentPairing = fontSettings.mode === 'preset' ? fontSettings.pairingId : null;
              const selected = currentPairing === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected}
                  title={pairing.name}
                  onClick={() => handleSelectFontPreset(id)}
                  className={tileClass(selected, 'flex w-full items-center justify-between gap-2 p-2.5')}
                >
                  <span className="min-w-0">
                    <span
                      className="block truncate text-sm font-medium"
                      style={{ fontFamily: `'${pairing.display.family}', serif` }}
                    >
                      {pairing.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {pairing.display.family} + {pairing.body.family}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-sm text-muted-foreground"
                    style={{ fontFamily: `'${pairing.display.family}', serif` }}
                  >
                    Aa
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {fontSubTab === 'google' && (
          <div className="space-y-2">
            <Input
              type="text"
              className="h-8"
              placeholder="Search fonts..."
              value={googleFontSearch}
              onChange={(e) => setGoogleFontSearch(e.target.value)}
            />

            <Segmented
              options={[
                { value: null, label: 'All' },
                { value: 'serif', label: 'Serif' },
                { value: 'sans-serif', label: 'Sans' },
                { value: 'display', label: 'Display' },
              ]}
              value={googleFontCategory}
              onChange={setGoogleFontCategory}
            />

            {/* Current selection */}
            <div className="space-y-1 rounded-md border p-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Display Font</span>
                <span className="truncate">
                  {(fontSettings.mode === 'google' ? fontSettings.displayFont?.family : null) || 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Body Font</span>
                <span className="truncate">
                  {(fontSettings.mode === 'google' ? fontSettings.bodyFont?.family : null) || 'Not set'}
                </span>
              </div>
            </div>

            {/* Font list */}
            <div className="max-h-[200px] overflow-y-auto rounded-md border p-1">
              {searchGoogleFonts(googleFontSearch, googleFontCategory).map((font) => {
                const currentDisplay = fontSettings.mode === 'google' ? fontSettings.displayFont?.family : null;
                const currentBody = fontSettings.mode === 'google' ? fontSettings.bodyFont?.family : null;
                return (
                  <div
                    key={font.family}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
                  >
                    <span
                      className="min-w-0 flex-1 truncate text-sm"
                      style={{ fontFamily: `'${font.family}', ${font.category}` }}
                    >
                      {font.family}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{font.category}</span>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={currentDisplay === font.family ? 'default' : 'outline'}
                        className="h-7 w-7 p-0 text-xs"
                        title="Use as display font"
                        onClick={() => handleSelectGoogleFont(font.family, font.category, 'display')}
                      >
                        H
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={currentBody === font.family ? 'default' : 'outline'}
                        className="h-7 w-7 p-0 text-xs"
                        title="Use as body font"
                        onClick={() => handleSelectGoogleFont(font.family, font.category, 'body')}
                      >
                        B
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {fontSubTab === 'system' && (
          <div className="space-y-2">
            {/* Current selection */}
            <div className="space-y-1 rounded-md border p-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Display Font</span>
                <span className="truncate">
                  {fontSettings.mode === 'system' && fontSettings.displayFont
                    ? SYSTEM_FONT_STACKS[fontSettings.displayFont]?.name || fontSettings.displayFont
                    : 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Body Font</span>
                <span className="truncate">
                  {fontSettings.mode === 'system' && fontSettings.bodyFont
                    ? SYSTEM_FONT_STACKS[fontSettings.bodyFont]?.name || fontSettings.bodyFont
                    : 'Not set'}
                </span>
              </div>
            </div>

            {/* System font list */}
            <div className="max-h-[200px] overflow-y-auto rounded-md border p-1">
              {Object.entries(SYSTEM_FONT_STACKS).map(([id, font]) => {
                const currentDisplay = fontSettings.mode === 'system' ? fontSettings.displayFont : null;
                const currentBody = fontSettings.mode === 'system' ? fontSettings.bodyFont : null;
                return (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
                  >
                    <span
                      className="min-w-0 flex-1 truncate text-sm"
                      style={{ fontFamily: font.family }}
                    >
                      {font.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{font.category}</span>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={currentDisplay === id ? 'default' : 'outline'}
                        className="h-7 w-7 p-0 text-xs"
                        title="Use as display font"
                        onClick={() => handleSelectSystemFont(id, 'display')}
                      >
                        H
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={currentBody === id ? 'default' : 'outline'}
                        className="h-7 w-7 p-0 text-xs"
                        title="Use as body font"
                        onClick={() => handleSelectSystemFont(id, 'body')}
                      >
                        B
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-muted-foreground">
              System fonts work offline and render consistently across devices.
            </p>
          </div>
        )}
      </PanelSection>

      {/* ===== Layout ===== */}
      <PanelSection title="Layout" {...sectionProps('layout')}>
        <div className="grid grid-cols-2 gap-2">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={layout === opt.value}
              title={opt.label}
              onClick={() => handleSetLayout(opt.value)}
              className={tileClass(layout === opt.value, 'flex flex-col items-center gap-2 rounded-lg p-2.5')}
            >
              {opt.preview}
              <span className="block w-full truncate text-center text-xs font-medium">{opt.label}</span>
            </button>
          ))}
        </div>
      </PanelSection>

      {/* ===== Spacing & Sizing ===== */}
      <PanelSection title="Spacing & Sizing" headerExtra={spacingResetButton} {...sectionProps('spacing')}>
        {/* Spacing presets */}
        <Segmented
          stretch
          itemClassName="px-1"
          options={Object.entries(SPACING_PRESETS).map(([id, preset]) => ({
            value: id,
            label: preset.name,
            title: preset.description,
          }))}
          value={currentSpacingPreset}
          onChange={handleApplySpacingPreset}
        />

        <div className="flex items-center gap-2">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">Fine Tune</span>
          <Separator className="flex-1" />
        </div>

        <ControlSlider
          label="Font Size"
          readout={`${Math.round(spacing.fontScale * 100)}%`}
          min={70}
          max={130}
          step={1}
          value={[Math.round(spacing.fontScale * 100)]}
          onValueChange={([v]) => handleSpacingChange('fontScale', v / 100)}
        />

        <ControlSlider
          label="Line Height"
          readout={spacing.lineHeight.toFixed(2)}
          min={120}
          max={180}
          step={1}
          value={[Math.round(spacing.lineHeight * 100)]}
          onValueChange={([v]) => handleSpacingChange('lineHeight', v / 100)}
        />

        <ControlSlider
          label="Section Gap"
          readout={`${spacing.sectionSpacing.toFixed(1)} rem`}
          min={4}
          max={16}
          step={1}
          value={[Math.round(spacing.sectionSpacing * 10)]}
          onValueChange={([v]) => handleSpacingChange('sectionSpacing', v / 10)}
        />

        <ControlSlider
          label="Sidebar Width"
          readout={`${spacing.sidebarWidth.toFixed(1)} in`}
          min={18}
          max={32}
          step={1}
          value={[Math.round(spacing.sidebarWidth * 10)]}
          onValueChange={([v]) => handleSpacingChange('sidebarWidth', v / 10)}
        />

        {/* Page margins */}
        <ControlGroup label="Page Margins (inches)">
          <div className="grid grid-cols-4 gap-1.5">
            {['top', 'right', 'bottom', 'left'].map((side) => (
              <div key={side} className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  {side.charAt(0).toUpperCase() + side.slice(1)}
                </Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0.2"
                  max="1.0"
                  className="h-8 px-2"
                  value={spacing.pageMargins[side]}
                  onChange={(e) => handleMarginChange(side, parseFloat(e.target.value))}
                />
              </div>
            ))}
          </div>
        </ControlGroup>
      </PanelSection>

      {/* ===== Accents ===== */}
      <PanelSection title="Accents" headerExtra={accentResetButton} {...sectionProps('accents')}>
        {/* Live accent preview */}
        <div className="space-y-2 rounded-lg border bg-card p-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">Experience</div>
            {accent.underlineStyle !== 'none' && (
              <UnderlinePreview
                styleId={accent.underlineStyle}
                width={accent.underlineWidth}
                className="w-10"
              />
            )}
          </div>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <div>{bulletChar || ''} Led team of 5 engineers</div>
            <div>{bulletChar || ''} Increased efficiency by 40%</div>
          </div>
          {accent.skillTagStyle === 'plain' ? (
            <div className="text-xs text-muted-foreground">JavaScript • React • Node.js</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {['JavaScript', 'React', 'Node.js'].map((skill) => (
                <span
                  key={skill}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs',
                    accent.skillTagStyle === 'filled' && 'bg-primary text-primary-foreground',
                    accent.skillTagStyle === 'outlined' && 'border border-primary text-primary',
                    accent.skillTagStyle === 'minimal' && 'text-muted-foreground underline',
                  )}
                >
                  {skill}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Section title underline */}
        <ControlGroup label="Title Underline">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(UNDERLINE_STYLES).map(([id, style]) => (
              <button
                key={id}
                type="button"
                aria-pressed={accent.underlineStyle === id}
                title={style.name}
                onClick={() => handleAccentChange('underlineStyle', id)}
                className={tileClass(
                  accent.underlineStyle === id,
                  'flex h-8 w-10 items-center justify-center',
                )}
              >
                <UnderlinePreview styleId={id} width={2} className="w-6" />
              </button>
            ))}
          </div>
        </ControlGroup>

        <ControlSlider
          label="Underline Width"
          readout={`${accent.underlineWidth}px`}
          min={1}
          max={4}
          step={1}
          value={[accent.underlineWidth]}
          onValueChange={([v]) => handleAccentChange('underlineWidth', v)}
        />

        {/* Bullet style */}
        <ControlGroup label="Bullet Points">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(BULLET_STYLES).map(([id, style]) => (
              <button
                key={id}
                type="button"
                aria-pressed={accent.bulletStyle === id}
                title={style.name}
                onClick={() => handleAccentChange('bulletStyle', id)}
                className={tileClass(
                  accent.bulletStyle === id,
                  'flex size-8 items-center justify-center text-sm',
                )}
              >
                {id === 'none' ? (
                  <span className="text-xs text-muted-foreground">∅</span>
                ) : (
                  style.char || '—'
                )}
              </button>
            ))}
          </div>
        </ControlGroup>

        {/* Border radius */}
        <ControlGroup label="Corner Rounding">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(BORDER_RADIUS_PRESETS).map(([id, preset]) => (
              <button
                key={id}
                type="button"
                aria-pressed={accent.borderRadius === id}
                title={preset.name}
                onClick={() => handleAccentChange('borderRadius', id)}
                className={tileClass(
                  accent.borderRadius === id,
                  'flex size-8 items-center justify-center',
                )}
              >
                <span className="block size-4 bg-primary" style={{ borderRadius: preset.value }} />
              </button>
            ))}
          </div>
        </ControlGroup>

        {/* Skill tag style */}
        <ControlGroup label="Skill Tags">
          <div className="grid grid-cols-4 gap-1.5">
            <button
              type="button"
              aria-pressed={accent.skillTagStyle === 'plain'}
              title="Plain (bullet-separated)"
              onClick={() => handleAccentChange('skillTagStyle', 'plain')}
              className={tileClass(
                accent.skillTagStyle === 'plain',
                'flex h-9 items-center justify-center',
              )}
            >
              <span className="text-xs text-muted-foreground">A • B</span>
            </button>
            <button
              type="button"
              aria-pressed={accent.skillTagStyle === 'filled'}
              title="Filled"
              onClick={() => handleAccentChange('skillTagStyle', 'filled')}
              className={tileClass(
                accent.skillTagStyle === 'filled',
                'flex h-9 items-center justify-center',
              )}
            >
              <span className="rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                Skill
              </span>
            </button>
            <button
              type="button"
              aria-pressed={accent.skillTagStyle === 'outlined'}
              title="Outlined"
              onClick={() => handleAccentChange('skillTagStyle', 'outlined')}
              className={tileClass(
                accent.skillTagStyle === 'outlined',
                'flex h-9 items-center justify-center',
              )}
            >
              <span className="rounded border border-primary px-1.5 py-0.5 text-xs text-primary">
                Skill
              </span>
            </button>
            <button
              type="button"
              aria-pressed={accent.skillTagStyle === 'minimal'}
              title="Minimal"
              onClick={() => handleAccentChange('skillTagStyle', 'minimal')}
              className={tileClass(
                accent.skillTagStyle === 'minimal',
                'flex h-9 items-center justify-center',
              )}
            >
              <span className="text-xs text-muted-foreground underline">Skill</span>
            </button>
          </div>
        </ControlGroup>

        {/* Decorative elements */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Decorative Elements</Label>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm font-normal">Header corner accent</Label>
            <Switch
              checked={accent.showCornerTriangle !== false}
              onCheckedChange={(checked) => handleAccentChange('showCornerTriangle', checked)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm font-normal">Sidebar gradient overlay</Label>
            <Switch
              checked={accent.showSidebarGradient !== false}
              onCheckedChange={(checked) => handleAccentChange('showSidebarGradient', checked)}
            />
          </div>
        </div>
      </PanelSection>

      {/* ===== Profile Photo ===== */}
      <PanelSection title="Profile Photo" {...sectionProps('photo')}>
        {photo.enabled && photo.imageData ? (
          <>
            {/* Photo preview + remove */}
            <div className="flex items-center gap-3">
              <img
                src={photo.imageData}
                alt="Profile photo"
                className="size-16 rounded-full border object-cover"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                title="Remove photo"
                onClick={handleRemovePhoto}
              >
                <Trash2 className="size-3.5" /> Remove Photo
              </Button>
            </div>

            {/* Placement */}
            <ControlGroup label="Placement">
              <Segmented
                stretch
                options={Object.entries(PHOTO_PLACEMENTS).map(([id, opt]) => ({
                  value: id,
                  label: opt.name,
                  title: opt.description,
                }))}
                value={photo.placement}
                onChange={(v) => handlePhotoChange('placement', v)}
              />
            </ControlGroup>

            {/* Shape */}
            <ControlGroup label="Shape">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(PHOTO_SHAPES).map(([id, shape]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={photo.shape === id}
                    title={shape.name}
                    onClick={() => handlePhotoChange('shape', id)}
                    className={tileClass(photo.shape === id, 'flex size-8 items-center justify-center')}
                  >
                    <span
                      className="block size-4 border-2 border-muted-foreground"
                      style={{ borderRadius: shape.css }}
                    />
                  </button>
                ))}
              </div>
            </ControlGroup>

            {/* Size */}
            <ControlGroup label="Size">
              <Segmented
                options={Object.entries(PHOTO_SIZES).map(([id, size]) => ({
                  value: id,
                  label: size.name,
                }))}
                value={photo.size}
                onChange={(v) => handlePhotoChange('size', v)}
              />
            </ControlGroup>

            {/* Border */}
            <ControlGroup label="Border">
              <Segmented
                options={[
                  { value: 'accent', label: 'Accent' },
                  { value: 'white', label: 'White' },
                  { value: 'none', label: 'None' },
                ]}
                value={photo.borderColor}
                onChange={(v) => handlePhotoChange('borderColor', v)}
              />
            </ControlGroup>

            {/* Image position (crop focus) */}
            <ControlGroup label="Image Focus">
              <div className="grid w-fit grid-cols-3 gap-1">
                {PHOTO_FOCUS_POSITIONS.map((pos) => {
                  const selected = (photo.objectPosition || 'center center') === pos;
                  return (
                    <button
                      key={pos}
                      type="button"
                      aria-pressed={selected}
                      title={PHOTO_FOCUS_TITLES[pos]}
                      onClick={() => handlePhotoChange('objectPosition', pos)}
                      className={tileClass(selected, 'flex size-7 items-center justify-center')}
                    >
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          selected ? 'bg-primary' : 'bg-muted-foreground/50',
                        )}
                      />
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Choose which part of the image to focus on
              </p>
            </ControlGroup>

            {/* Zoom */}
            <ControlSlider
              label="Zoom"
              readout={`${Math.round((photo.scale || 1) * 100)}%`}
              min={100}
              max={200}
              step={1}
              value={[Math.round((photo.scale || 1) * 100)]}
              onValueChange={([v]) => handlePhotoChange('scale', v / 100)}
            />
          </>
        ) : (
          /* Upload dropzone */
          <UploadDropzone onFile={handlePhotoFile}>
            <User className="size-6" />
            <span className="text-sm font-medium text-foreground">Add Profile Photo</span>
            <span className="text-xs">Click or drag image here</span>
          </UploadDropzone>
        )}
      </PanelSection>
    </>
  );
}
