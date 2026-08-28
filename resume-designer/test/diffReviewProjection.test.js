import { describe, it, expect } from 'vitest';
import { buildDiffReview, buildSnapshot } from '../src/iosShell.js';

/**
 * The change-review projection. One shape for every entry point — chat's
 * "Review changes", jobs tailoring, history compare, the inline banner — since
 * they all open the same always-mounted dialog.
 *
 * It carries NO apply logic on purpose. Tailoring goes through diffEngine and
 * `applyChangesToStore`, not the inline-changes session, and its Apply All has
 * to batch through the ordered helper rather than loop: leaf paths are indexed
 * against the proposed array. The native buttons call the dialog's own
 * handlers, so that sequencing exists once.
 */

const CHANGES = [
  { path: 'name', type: 'modify', displayOld: 'Ash', displayNew: 'Ash Shah' },
  { path: 'experience[0].bullets[1]', type: 'add', displayOld: '', displayNew: 'Shipped it' },
  { path: 'education[2]', type: 'remove', displayOld: 'A degree', displayNew: '' },
];

describe('buildDiffReview', () => {
  it('carries the strings the engine already rendered, not raw values', () => {
    // Swift never formats a résumé value; `displayOld`/`displayNew` are what
    // the web cards show too.
    const [first] = buildDiffReview({ open: true, changes: CHANGES }).changes;
    expect(first).toEqual({
      path: 'name',
      label: 'name',
      kind: 'modify',
      before: 'Ash',
      after: 'Ash Shah',
      applied: false,
      rejected: false,
    });
  });

  it('marks which changes are already decided', () => {
    const view = buildDiffReview({
      open: true,
      changes: CHANGES,
      applied: ['name'],
      rejected: ['education[2]'],
    });
    expect(view.changes.map((c) => [c.applied, c.rejected])).toEqual([
      [true, false], [false, false], [false, true],
    ]);
  });

  it('counts only what Apply All would actually write', () => {
    // "Apply all (3)" beside eleven cards is the only way to tell that eight
    // were already decided.
    expect(buildDiffReview({ open: true, changes: CHANGES }).pending).toBe(3);
    expect(buildDiffReview({
      open: true, changes: CHANGES, applied: ['name'], rejected: ['education[2]'],
    }).pending).toBe(1);
  });

  it('falls back to the path when a change has no label', () => {
    const view = buildDiffReview({ open: true, changes: [{ path: 'tagline', type: 'modify' }] });
    expect(view.changes[0].label).toBe('tagline');
    expect(view.changes[0].before).toBe('');
  });

  it('defaults an unknown change kind to modify rather than dropping it', () => {
    const view = buildDiffReview({ open: true, changes: [{ path: 'a' }] });
    expect(view.changes[0].kind).toBe('modify');
  });

  it('drops entries with no path, which nothing could apply', () => {
    const view = buildDiffReview({ open: true, changes: [{ type: 'add' }, null, ...CHANGES] });
    expect(view.changes).toHaveLength(3);
  });

  it('survives an empty call', () => {
    const view = buildDiffReview();
    expect(view.open).toBe(false);
    expect(view.changes).toEqual([]);
    expect(view.pending).toBe(0);
    expect(view.title).toBe('Suggested changes');
  });
});

describe('buildSnapshot', () => {
  it('carries the review on the wire', () => {
    const view = buildDiffReview({ open: true, changes: CHANGES });
    expect(buildSnapshot({ diff: view }).diff).toBe(view);
    expect(buildSnapshot({}).diff).toBe(null);
  });
});
