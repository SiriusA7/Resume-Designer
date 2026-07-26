import { describe, it, expect } from 'vitest';
import { migrateSectionAreas } from '../src/store.js';

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
