import { describe, it, expect } from 'vitest';
import { buildLibrary } from '../src/iosShell.js';

/**
 * The library projection now carries three tabs' worth of data, and the stats
 * and timeline are derived from the SAME applications the entries are — so
 * they cannot be allowed to disagree about a résumé that changed underneath.
 */

const VARIANTS = [
  { id: 'v1', name: 'Design Engineer', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'v2', name: 'Product Lead', updatedAt: '2026-07-01T00:00:00.000Z' },
];
const RESULTS = [{ variantId: 'v1' }, { variantId: 'v2' }];

const app = (over) => ({
  id: 'a', variantId: 'v1', variantName: 'Design Engineer', status: 'applied',
  jobSnapshot: { title: 'Role', company: 'Company' },
  statusHistory: [{ status: 'applied', at: '2026-06-01T00:00:00.000Z' }],
  createdAt: '2026-06-01T00:00:00.000Z',
  appliedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('buildLibrary', () => {
  it('keeps the entries it always had, alongside the new tabs', () => {
    const library = buildLibrary(RESULTS, VARIANTS, []);
    expect(library.entries.map((e) => e.id)).toEqual(['v1', 'v2']);
    expect(library.entries[0].name).toBe('Design Engineer');
    expect(library).toHaveProperty('stats');
    expect(library).toHaveProperty('timeline');
  });

  it('orders the timeline newest first, the reverse of the web axis', () => {
    // The web draws left-to-right oldest-to-newest; a list you read top-down
    // should open on what just happened.
    const library = buildLibrary(RESULTS, VARIANTS, [
      app({ id: 'old', appliedAt: '2026-01-05T00:00:00.000Z' }),
      app({ id: 'new', appliedAt: '2026-08-05T00:00:00.000Z' }),
      app({ id: 'mid', appliedAt: '2026-04-05T00:00:00.000Z' }),
    ]);
    expect(library.timeline.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('places a prepared draft on its creation day, having no applied day', () => {
    const library = buildLibrary(RESULTS, VARIANTS, [
      app({
        id: 'draft', status: 'prepared', appliedAt: null,
        createdAt: '2026-08-09T00:00:00.000Z',
      }),
    ]);
    expect(library.timeline).toHaveLength(1);
    expect(library.timeline[0].at).toBe('2026-08-09T00:00:00.000Z');
    expect(library.timeline[0].status).toBe('prepared');
  });

  it('excludes a prepared draft from what was sent', () => {
    const library = buildLibrary(RESULTS, VARIANTS, [
      app({ id: 'sent' }),
      app({ id: 'draft', status: 'prepared', appliedAt: null }),
    ]);
    expect(library.stats.sent).toBe(1);
  });

  it('sends null rather than zero when there is nothing to divide by', () => {
    // No replies yet is not a 0% response rate, and the native side renders
    // the difference as "—".
    const empty = buildLibrary(RESULTS, VARIANTS, []);
    expect(empty.stats.sent).toBe(0);
    expect(empty.stats.responseRate).toBe(null);
    expect(empty.stats.interviewRate).toBe(null);
    expect(empty.stats.medianDaysToResponse).toBe(null);
  });

  it('sends raw numbers, not formatted strings', () => {
    // "43%" and "2 days" are locale decisions and Swift is the side that knows
    // the locale.
    const library = buildLibrary(RESULTS, VARIANTS, [
      app({
        id: 'answered', status: 'heard_back',
        statusHistory: [
          { status: 'applied', at: '2026-06-01T00:00:00.000Z' },
          { status: 'heard_back', at: '2026-06-08T00:00:00.000Z' },
        ],
      }),
    ]);
    expect(library.stats.responseRate).toBe(1);
    expect(library.stats.medianDaysToResponse).toBe(7);
  });

  it('names an unnamed résumé in the per-résumé rows', () => {
    const library = buildLibrary(RESULTS, VARIANTS, [app({ variantName: '' })]);
    expect(library.stats.perVariant[0].variantName).toBe('Untitled resume');
  });

  it('survives applications that are not an array', () => {
    const library = buildLibrary(RESULTS, VARIANTS, null);
    expect(library.timeline).toEqual([]);
    expect(library.stats.sent).toBe(0);
    expect(library.entries).toHaveLength(2);
  });
});
