// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  computeStats, timelinePoints, timelineRange, monthTicks, positionPct, timelineLanes,
} from '../src/applicationStats.js';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 5, 1); // 2026-06-01

function app(over = {}) {
  return {
    id: over.id || 'app-1',
    variantId: 'v1',
    variantName: 'Resume A',
    jobSnapshot: { title: 'PM', company: 'Acme' },
    status: 'applied',
    statusHistory: [{ status: 'applied', at: iso(T0) }],
    createdAt: iso(T0),
    appliedAt: iso(T0),
    ...over,
  };
}

describe('computeStats', () => {
  it('returns zeros/nulls for empty input', () => {
    expect(computeStats([])).toEqual({
      sent: 0, responded: 0, responseRate: null, interviewRate: null,
      medianDaysToResponse: null, perVariant: [],
    });
  });

  it('excludes prepared-only drafts from sent', () => {
    const s = computeStats([
      app(),
      app({ id: 'app-2', status: 'prepared', appliedAt: null, statusHistory: [{ status: 'prepared', at: iso(T0) }] }),
    ]);
    expect(s.sent).toBe(1);
  });

  it('counts rejected as a response but not an interview', () => {
    const s = computeStats([
      app({ statusHistory: [{ status: 'applied', at: iso(T0) }, { status: 'rejected', at: iso(T0 + 2 * DAY) }] }),
    ]);
    expect(s.responded).toBe(1);
    expect(s.responseRate).toBe(1);
    expect(s.interviewRate).toBe(0);
  });

  it('counts offer as interviewed and takes median over first responses', () => {
    const s = computeStats([
      app({ statusHistory: [{ status: 'applied', at: iso(T0) }, { status: 'heard_back', at: iso(T0 + 1 * DAY) }] }),
      app({ id: 'app-2', statusHistory: [{ status: 'applied', at: iso(T0) }, { status: 'offer', at: iso(T0 + 5 * DAY) }] }),
    ]);
    expect(s.interviewRate).toBe(0.5);
    expect(s.medianDaysToResponse).toBe(3); // median of [1, 5]
  });

  it('groups per variant with snapshot names', () => {
    const s = computeStats([
      app(),
      app({ id: 'app-2', variantId: 'v2', variantName: 'Resume B',
        statusHistory: [{ status: 'applied', at: iso(T0) }, { status: 'interview', at: iso(T0 + DAY) }] }),
    ]);
    expect(s.perVariant).toHaveLength(2);
    const b = s.perVariant.find((r) => r.variantId === 'v2');
    expect(b).toEqual({ variantId: 'v2', variantName: 'Resume B', sent: 1, responded: 1, interviewed: 1 });
  });
});

describe('timeline helpers', () => {
  it('timelinePoints falls back to createdAt and sorts ascending', () => {
    const pts = timelinePoints([
      app({ id: 'late', appliedAt: iso(T0 + 9 * DAY) }),
      app({ id: 'draft', status: 'prepared', appliedAt: null, createdAt: iso(T0 + DAY) }),
    ]);
    expect(pts.map((p) => p.id)).toEqual(['draft', 'late']);
    expect(pts[0].at).toBe(iso(T0 + DAY));
  });

  it('timelineRange pads both sides and reaches now', () => {
    const pts = timelinePoints([app()]);
    const r = timelineRange(pts, iso(T0 + 10 * DAY));
    expect(r.start).toBe(T0 - 3 * DAY);
    expect(r.end).toBe(T0 + 13 * DAY);
    expect(timelineRange([], iso(T0))).toBeNull();
  });

  it('monthTicks yields the month boundaries inside the range', () => {
    const ticks = monthTicks({ start: Date.UTC(2026, 4, 20), end: Date.UTC(2026, 7, 10) });
    expect(ticks.length).toBe(3); // Jun 1, Jul 1, Aug 1 (local-time boundaries)
  });

  it('positionPct clamps to [0, 100]', () => {
    const r = { start: T0, end: T0 + 10 * DAY };
    expect(positionPct(r, iso(T0 + 5 * DAY))).toBe(50);
    expect(positionPct(r, iso(T0 - DAY))).toBe(0);
    expect(positionPct(r, iso(T0 + 11 * DAY))).toBe(100);
  });

  it('timelineLanes groups by variant, most recent activity first', () => {
    const pts = timelinePoints([
      app({ id: 'a', variantId: 'v1', appliedAt: iso(T0) }),
      app({ id: 'b', variantId: 'v2', variantName: 'Resume B', appliedAt: iso(T0 + 2 * DAY) }),
      app({ id: 'c', variantId: 'v1', appliedAt: iso(T0 + DAY) }),
    ]);
    const lanes = timelineLanes(pts);
    expect(lanes.map((l) => l.variantId)).toEqual(['v2', 'v1']);
    expect(lanes[1].points.map((p) => p.id)).toEqual(['a', 'c']);
  });
});
