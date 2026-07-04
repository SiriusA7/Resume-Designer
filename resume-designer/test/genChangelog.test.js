import { describe, it, expect } from 'vitest';

import { groupChangelog } from '../scripts/ci/gen-changelog.mjs';

describe('groupChangelog', () => {
  it('groups by type (features → fixes → improvements) then by app area', () => {
    const md = groupChangelog([
      'feat(chat): add per-résumé threads',
      'fix(pdf): keep fonts when merging sheets',
      'feat(update): show release notes',
      'fix(chat): abort on thread delete',
      'perf(render): repaginate less often',
    ], '1.2.0');

    // Heading.
    expect(md).toContain('## Resume Designer 1.2.0');
    // Section order.
    const featIdx = md.indexOf('### ✨ New features');
    const fixIdx = md.indexOf('### 🐛 Fixes');
    const perfIdx = md.indexOf('### ⚡ Improvements');
    expect(featIdx).toBeGreaterThan(-1);
    expect(featIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(perfIdx);
    // Area sub-headers use friendly names.
    expect(md).toContain('**AI Chat**');
    expect(md).toContain('**PDF Export**');
    expect(md).toContain('**Updates & Changelog**');
    expect(md).toContain('**Résumé Rendering**');
    // Prefix stripped + capitalized.
    expect(md).toContain('- Add per-résumé threads');
    expect(md).toContain('- Keep fonts when merging sheets');
  });

  it('drops internal-only commit types', () => {
    const md = groupChangelog([
      'chore: bump deps',
      'docs: update readme',
      'ci: fix workflow',
      'refactor(chat): tidy internals',
      'test: add coverage',
    ], '1.0.0');
    expect(md).not.toContain('bump deps');
    expect(md).not.toContain('update readme');
    expect(md).not.toContain('tidy internals');
    expect(md).toContain('- Maintenance and internal improvements.');
  });

  it('dedupes an identical subject that landed on two branches', () => {
    const md = groupChangelog([
      'fix(chat): keep a reply running when switching threads',
      'fix(chat): keep a reply running when switching threads',
    ], '1.0.0');
    const occurrences = md.split('- Keep a reply running when switching threads').length - 1;
    expect(occurrences).toBe(1);
  });

  it('marks breaking changes and treats no-scope commits as General', () => {
    const md = groupChangelog(['feat!: overhaul the storage format', 'fix: correct a typo'], '2.0.0');
    expect(md).toContain('**General**');
    expect(md).toContain('- **Breaking:** Overhaul the storage format');
  });

  it('handles empty input', () => {
    const md = groupChangelog([], '1.0.0');
    expect(md).toContain('## Resume Designer 1.0.0');
    expect(md).toContain('- Maintenance and internal improvements.');
  });
});
