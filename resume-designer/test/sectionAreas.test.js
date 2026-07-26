import { describe, it, expect } from 'vitest';
import { migrateSectionAreas } from '../src/store.js';
import {
  normalizeSectionType, partitionSectionsByArea, renderResumeForLayout, SINGLE_COLUMN_LAYOUTS,
} from '../src/renderer.js';

describe('migrateSectionAreas', () => {
  it('defaults existing sections to the sidebar so output is unchanged', () => {
    const out = migrateSectionAreas({
      sections: [{ id: 's1', title: 'Skills', type: 'list', content: ['a'] }],
    });
    expect(out.sections[0].area).toBe('sidebar');
  });

  it('preserves an explicit area', () => {
    const out = migrateSectionAreas({
      sections: [{ id: 's1', title: 'Awards', type: 'list', content: [], area: 'main' }],
    });
    expect(out.sections[0].area).toBe('main');
  });

  it('rejects an unknown area rather than passing it to the renderer', () => {
    const out = migrateSectionAreas({ sections: [{ id: 's1', area: 'footer' }] });
    expect(out.sections[0].area).toBe('sidebar');
  });

  it('tolerates data with no sections', () => {
    expect(() => migrateSectionAreas({})).not.toThrow();
    expect(migrateSectionAreas({}).sections).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = { sections: [{ id: 's1' }] };
    migrateSectionAreas(input);
    expect(input.sections[0].area).toBeUndefined();
  });
});

describe('normalizeSectionType', () => {
  it('recognises the three display types', () => {
    expect(normalizeSectionType('list')).toBe('list');
    expect(normalizeSectionType('skills')).toBe('skills');
    expect(normalizeSectionType('paragraph')).toBe('paragraph');
  });

  it('falls back to list for anything unknown', () => {
    expect(normalizeSectionType('bogus')).toBe('list');
    expect(normalizeSectionType(undefined)).toBe('list');
  });
});

const DATA = {
  name: 'Ada', tagline: 'Engineer', contact: {}, summary: 'S',
  experience: [], education: [], tools: '',
  sections: [
    { id: 'a', title: 'Skills', type: 'list', area: 'sidebar', content: ['Rust'] },
    { id: 'b', title: 'Publications', type: 'paragraph', area: 'main', content: ['A paper.'] },
  ],
};

describe('partitionSectionsByArea', () => {
  it('splits by area while preserving original indices', () => {
    const { main, sidebar } = partitionSectionsByArea(DATA.sections);
    expect(main.map((e) => e.sIdx)).toEqual([1]);
    expect(sidebar.map((e) => e.sIdx)).toEqual([0]);
  });

  it('defaults a section with no area to the sidebar, not to nowhere', () => {
    // Undo/redo/restore snapshots and AI-created sections bypass the migration,
    // so sections legitimately reach the renderer with no `area` at all. They
    // must land in the sidebar (the pre-area behaviour), never be dropped.
    const { main, sidebar } = partitionSectionsByArea([
      { id: 'x', title: 'Languages', type: 'list', content: ['Go'] },
    ]);
    expect(main).toEqual([]);
    expect(sidebar.map((e) => e.sIdx)).toEqual([0]);
  });
});

describe('layout rendering', () => {
  it('sidebar layouts place a main section in the main column', () => {
    for (const layout of ['sidebar', 'right-sidebar', 'compact', 'executive', 'modern', 'timeline']) {
      const html = renderResumeForLayout(DATA, layout);
      expect(html, layout).toContain('Publications');
      expect(html, layout).toContain('data-editable="sections[1].content[0]"');
      // In the main column (h2 main-section markup), and NOT also in the sidebar
      // (whose block branch would wrap the title in an h3.sidebar-title).
      expect(html, layout).toContain('<h2 class="section-title" data-editable="sections[1].title">Publications</h2>');
      expect(html, layout).not.toContain('<h3 class="sidebar-title" data-editable="sections[1].title">');
    }
  });

  it('marks main custom sections with the section class that spaces them', () => {
    // The margin-spaced main columns drive inter-section spacing off `.section`
    // (`.compact-main .section`, `.executive-main .section + .section` in
    // styles/resume.css) — without the class, consecutive main sections render
    // flush there. The gap-spaced columns (flex gap) are indifferent to it.
    for (const layout of ['sidebar', 'right-sidebar', 'compact', 'executive', 'modern', 'timeline']) {
      const html = renderResumeForLayout(DATA, layout);
      expect(html, layout).toContain('<section class="section resume-section main-custom-section">');
    }
  });

  it('sidebar-less layouts render every section, ignoring area', () => {
    for (const layout of ['stacked', 'stacked-vertical', 'classic', 'classic-featured', 'creative']) {
      const html = renderResumeForLayout(DATA, layout);
      expect(html, layout).toContain('Publications');
      expect(html, layout).toContain('Skills');
    }
  });

  it('sidebar layouts keep a sidebar section out of the main column', () => {
    // Converse of the main-column test above: removing the area partition
    // inside renderMainSections would render sidebar sections in BOTH columns
    // and every other test here would still pass.
    for (const layout of ['sidebar', 'right-sidebar', 'compact', 'executive', 'modern', 'timeline']) {
      const html = renderResumeForLayout(DATA, layout);
      // Skills (sections[0], area: sidebar) renders via the shared renderSidebar…
      expect(html, layout).toContain('<h3 class="sidebar-title" data-editable="sections[0].title">Skills</h3>');
      // …and never as a main-column custom section.
      expect(html, layout).not.toContain('<h2 class="section-title" data-editable="sections[0].title">');
    }
  });

  it('renders a section with no area at all in the sidebar column', () => {
    const data = {
      ...DATA,
      sections: [{ id: 'x', title: 'Languages', type: 'list', content: ['Go'] }],
    };
    const html = renderResumeForLayout(data, 'sidebar');
    expect(html).toContain('<h3 class="sidebar-title" data-editable="sections[0].title">Languages</h3>');
    expect(html).toContain('data-editable="sections[0].content[0]"');
  });

  it('SINGLE_COLUMN_LAYOUTS matches actual renderer behaviour', () => {
    // The structure panel imports this set to explain that Area has no visible
    // effect on single-column templates. Pin it against what the renderers
    // actually do, so adding a layout (or giving one a sidebar) can't silently
    // desynchronise the UI note: a layout is in the set iff it does NOT render
    // a main column for main-area sections.
    const ALL_LAYOUTS = [
      'sidebar', 'stacked', 'stacked-vertical', 'right-sidebar', 'compact',
      'executive', 'classic', 'classic-featured', 'modern', 'timeline', 'creative',
    ];
    for (const layout of ALL_LAYOUTS) {
      const html = renderResumeForLayout(DATA, layout);
      if (SINGLE_COLUMN_LAYOUTS.has(layout)) {
        expect(html, layout).not.toContain('main-custom-section');
        expect(html, layout).toContain('Publications'); // still rendered, one column
      } else {
        expect(html, layout).toContain('main-custom-section');
      }
    }
    expect(SINGLE_COLUMN_LAYOUTS.size).toBe(5);
  });

  it('renders a sidebar paragraph section as prose, not skill tags', () => {
    // Pins the renderSidebar routing: paragraph sections must take the
    // block-content branch (`mode !== 'skills'`), not the skills branch.
    const data = {
      ...DATA,
      sections: [{ id: 'p', title: 'Profile', type: 'paragraph', area: 'sidebar', content: ['Line one.'] }],
    };
    const html = renderResumeForLayout(data, 'sidebar');
    expect(html).toContain('<p class="section-paragraph" data-editable="sections[0].content[0]">Line one.</p>');
    expect(html).not.toContain('skill-tag-row');
  });
});
