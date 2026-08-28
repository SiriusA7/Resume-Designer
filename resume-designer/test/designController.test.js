import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  COLOR_PALETTES,
  LAYOUTS,
  SPACING_PRESETS,
  applyDesign,
  detectSpacingPreset,
  getDesignState,
  setDesignImage,
} from '../src/designController.js';

// The controller is the ONE implementation of what a design control means, for
// the web panel and for the native sheet alike. Covered here: the coercions
// (Swift sends every value as a string, the web sends the control's own type,
// and both have to land on the same stored value), the spacing-preset match
// (inferred, not stored), and the projection's shape (Swift decodes it into one
// Codable struct, so a missing field blanks the whole sheet).

// jsdom gives appStorage its passthrough localStorage mode, so every service
// reads and writes for real; nothing finds a `.resume` element, so the apply
// half is a no-op and only the save half is observable.
beforeEach(() => {
  localStorage.clear();
});

// The projection is the only read path, so it is also how a write is checked.
const state = () => getDesignState();

describe('value coercion', () => {
  it('takes a number from the web control and a string from the bridge', async () => {
    await applyDesign({ group: 'spacing', property: 'fontScale', value: 1.15 });
    expect(state().spacing.fontScale).toBe(1.15);

    await applyDesign({ group: 'spacing', property: 'fontScale', value: '0.85' });
    expect(state().spacing.fontScale).toBe(0.85);
  });

  it('coerces booleans from both shells, and only "true" is true', async () => {
    for (const [sent, stored] of [[true, true], [false, false], ['true', true], ['false', false]]) {
      await applyDesign({ group: 'accent', property: 'showCornerTriangle', value: sent });
      expect(state().accent.showCornerTriangle).toBe(stored);
    }
  });

  it('flattens a margin back onto pageMargins', async () => {
    await applyDesign({ group: 'spacing', property: 'marginLeft', value: '0.75' });
    expect(state().spacing.marginLeft).toBe(0.75);
    // Untouched sides keep their own values rather than the one just written.
    expect(state().spacing.marginRight).toBe(0.5);
  });

  it('applies all five fields of a spacing preset at once', async () => {
    await applyDesign({ group: 'spacing', property: 'preset', value: 'compact' });
    const { spacing } = state();
    expect(spacing.fontScale).toBe(SPACING_PRESETS.compact.fontScale);
    expect(spacing.sidebarWidth).toBe(SPACING_PRESETS.compact.sidebarWidth);
    expect(spacing.marginTop).toBe(SPACING_PRESETS.compact.pageMargins.top);
  });

  it('splits a header style into its family and id', async () => {
    await applyDesign({ group: 'header', property: 'style', value: 'pattern:chevron' });
    expect(state().header).toMatchObject({ type: 'pattern', styleId: 'chevron' });
  });

  it('splits a font choice into its source, family and category', async () => {
    await applyDesign({ group: 'fonts', property: 'body', value: 'system:georgia' });
    expect(state().fonts).toMatchObject({ mode: 'system', bodyName: 'Georgia' });

    // Switching source starts both halves over: a system stack id is not a
    // Google family, so keeping the other half would leave one that cannot
    // resolve.
    await applyDesign({ group: 'fonts', property: 'display', value: 'google:Lora:serif' });
    expect(state().fonts).toMatchObject({ mode: 'google', displayName: 'Lora', bodyName: '' });
  });

  it('rejects a group or property it was not given, rather than writing nothing quietly', async () => {
    await expect(applyDesign({ group: 'colour', property: 'palette', value: 'teal' }))
      .rejects.toThrow(/unknown design group/);
    await expect(applyDesign({ group: 'accent', property: 'underlineColor', value: 'red' }))
      .rejects.toThrow(/unknown design property/);
    await expect(applyDesign({ group: 'header', property: 'style', value: 'gradient' }))
      .rejects.toThrow(/<type>:<id>/);
  });
});

describe('detectSpacingPreset', () => {
  it('names the preset whose values were applied', () => {
    for (const [id, preset] of Object.entries(SPACING_PRESETS)) {
      expect(detectSpacingPreset(preset)).toBe(id);
    }
  });

  it('still reads as the preset after a nudge inside the tolerances', () => {
    // ±0.05 font scale, ±0.1 line height and section spacing — what makes
    // "Normal, then a touch tighter" go on showing Normal.
    expect(detectSpacingPreset({ ...SPACING_PRESETS.normal, fontScale: 1.04 })).toBe('normal');
    expect(detectSpacingPreset({ ...SPACING_PRESETS.normal, lineHeight: 1.54 })).toBe('normal');
    expect(detectSpacingPreset({ ...SPACING_PRESETS.normal, sectionSpacing: 0.89 })).toBe('normal');
  });

  it('gives up once a value is outside them', () => {
    expect(detectSpacingPreset({ ...SPACING_PRESETS.normal, fontScale: 1.2 })).toBe('');
  });

  it('ignores sidebar width and margins, which no tolerance covers', () => {
    // A preset writes five fields but is recognised by three. Widening the
    // sidebar must not deselect the preset the type still matches.
    expect(detectSpacingPreset({ ...SPACING_PRESETS.airy, sidebarWidth: 3.1 })).toBe('airy');
  });

  it('returns "" and never null, which Swift binds as a String selection', () => {
    expect(detectSpacingPreset({ fontScale: 5, lineHeight: 5, sectionSpacing: 5 })).toBe('');
  });
});

describe('getDesignState', () => {
  it('carries every group and its catalog', () => {
    expect(Object.keys(state()).sort()).toEqual([
      'accent', 'bullets', 'color', 'fontPairings', 'fonts', 'googleFonts', 'header',
      'headerStyles', 'layout', 'layouts', 'page', 'pageSizes', 'palettes', 'photo',
      'placements', 'radii', 'saveFailed', 'shapes', 'sizes', 'skillTags', 'spacing',
      'spacingPresets', 'systemFonts', 'underlines',
    ]);
    // Storage's answer, not a design value: each service writes its own key, so
    // a refusal there is invisible to the résumé's warning and the settings one.
    expect(state().saveFailed).toBe(false);
  });

  it('projects nothing but strings, numbers, booleans and arrays of those', () => {
    const walk = (value, path) => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
        return;
      }
      // A function cannot serialise and a null fails Swift's decode of a
      // non-optional field — either one takes the whole sheet down, not just
      // its own row.
      expect(['string', 'number', 'boolean'], `${path} is ${value}`).toContain(typeof value);
    };
    walk(state(), 'design');
  });

  it('evaluates the header-style previews, which are CSS generator functions', () => {
    const { headerStyles } = state();
    const diagonal = headerStyles.find((h) => h.id === 'linear-135');
    // Against the default palette's own header colours, not a placeholder.
    expect(diagonal).toMatchObject({ group: 'gradient', name: 'Diagonal' });
    expect(diagonal.css).toContain(COLOR_PALETTES.terracotta.p2);
    expect(headerStyles.map((h) => h.group)).toContain('pattern');
    expect(headerStyles.map((h) => h.group)).toContain('texture');
  });

  it('reports whether an image is set, never the image', async () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(64)}`;
    await applyDesign({ group: 'photo', property: 'placement', value: 'floating' });
    expect(state().photo.hasImage).toBe(false);

    setDesignImage('photo', dataUrl);
    setDesignImage('header', dataUrl);

    const projected = JSON.stringify(state());
    expect(state().photo.hasImage).toBe(true);
    expect(state().header.hasImage).toBe(true);
    expect(projected).not.toContain(dataUrl);
    expect(projected).not.toContain('imageData');
    expect(projected).not.toContain('customImage');
  });

  it('empties pairingId outside preset mode rather than naming an unselected preset', async () => {
    expect(state().fonts.pairingId).toBe('classic-elegant');
    await applyDesign({ group: 'fonts', property: 'display', value: 'system:georgia' });
    expect(state().fonts.pairingId).toBe('');
  });

  it('lists a layout once, with the name the web tiles show', () => {
    expect(state().layouts).toEqual(LAYOUTS);
    // The web tiles read the same table, so the sheet cannot call it anything
    // else — 'stacked-vertical' has been shown as "Flow" since the reskin.
    expect(LAYOUTS.find((l) => l.id === 'stacked-vertical').name).toBe('Flow');
  });

  it('reads back what a write to another group stored', async () => {
    await applyDesign({ group: 'photo', property: 'shape', value: 'rounded-lg' });
    await applyDesign({ group: 'accent', property: 'bulletStyle', value: 'arrow' });
    expect(state().photo.shape).toBe('rounded-lg');
    expect(state().accent.bulletStyle).toBe('arrow');
    // The bullet catalog carries the glyph, so a native list can render the
    // choice instead of the word for it.
    expect(state().bullets.find((b) => b.id === 'arrow').char).toBe('→');
  });
});

// The "never customised" values, which are now a seam rather than a literal
// buried in each getter: a replacement restore CLEARS an omitted design key by
// writing what the owner calls default, so the value has to be the same one the
// getter falls back to. Extracting it made getter and export share a source;
// these are what say so, since a divergence would be silent — the restore would
// write one thing and every reader would then show another.
describe('a design service’s default is what its getter falls back to', () => {
  it('agrees for the header style', async () => {
    const { getHeaderStyleSettings, defaultHeaderStyleSettings } =
      await import('../src/headerStyleService.js');
    expect(getHeaderStyleSettings()).toEqual(defaultHeaderStyleSettings());
    // And it is a real default, not an empty object standing in for one: the
    // restore uploads this, so an empty payload would blank the header on every
    // other device rather than resetting it.
    expect(defaultHeaderStyleSettings().type).toBe('gradient');
  });

  it('agrees for the font pairing', async () => {
    const { getCurrentFontSettings, defaultFontSettings } =
      await import('../src/fontService.js');
    expect(getCurrentFontSettings()).toEqual(defaultFontSettings());
  });
});

// A font choice is the one design control that has to fetch something before it
// can be stored, and the list it was chosen from stays live while it does. So
// two ordinary taps overlap, and without a rule about it the write order is the
// NETWORK's rather than the person's.
describe('overlapping font choices', () => {
  // `loadGoogleFont` awaits `document.fonts.load`. jsdom has no FontFaceSet, so
  // the real call throws into that function's own catch and settles at once —
  // the overlap cannot happen here by accident. Holding the promise open is
  // what a slow network looks like from inside the controller. Every test picks
  // families no other test loads: `loadedFonts` is module state and a cached
  // family returns before it ever reaches this stub.
  let pending;
  beforeEach(() => {
    pending = [];
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => new Promise((resolve) => { pending.push(resolve); }) },
    });
  });
  afterEach(() => { delete document.fonts; });

  it('lets a system pick beat a Google family that is still loading', async () => {
    const slow = applyDesign({
      group: 'fonts', property: 'display', value: 'google:Zilla Slab:serif',
    });
    await applyDesign({ group: 'fonts', property: 'body', value: 'system:georgia' });
    expect(state().fonts).toMatchObject({ mode: 'system', bodyName: 'Georgia' });

    pending[0]();
    await slow;

    // Not merely "the old family reappears": the stale write would run
    // `nextFontSettings('google')`, which starts both halves over on a mode
    // change — so the stack the newer tap chose would go with it.
    expect(state().fonts).toMatchObject({ mode: 'system', bodyName: 'Georgia' });
  });

  it('gives a slot to the later of two Google families, not the faster one', async () => {
    const first = applyDesign({
      group: 'fonts', property: 'display', value: 'google:Spectral:serif',
    });
    const second = applyDesign({
      group: 'fonts', property: 'display', value: 'google:Cabin:sans-serif',
    });

    pending[1]();
    await second;
    expect(state().fonts).toMatchObject({ mode: 'google', displayName: 'Cabin' });

    pending[0]();
    await first;
    expect(state().fonts).toMatchObject({ mode: 'google', displayName: 'Cabin' });
  });

  it('still lands both halves when the two picks are different slots', async () => {
    // The half of the rule that is easy to get wrong in the other direction: a
    // single "has anything been written since?" test would drop this one, and
    // choosing a display face and then a body face is not a race at all.
    const display = applyDesign({
      group: 'fonts', property: 'display', value: 'google:Asap:sans-serif',
    });
    const body = applyDesign({
      group: 'fonts', property: 'body', value: 'google:Sora:sans-serif',
    });

    pending[0]();
    await display;
    pending[1]();
    await body;

    expect(state().fonts).toMatchObject({
      mode: 'google', displayName: 'Asap', bodyName: 'Sora',
    });
  });
});
