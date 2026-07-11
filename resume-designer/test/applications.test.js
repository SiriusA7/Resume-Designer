// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import {
  initApplications, getAllApplications, getApplicationsForVariant,
  addApplication, setApplicationStatus, updateApplication, deleteApplication,
  recordTailorDrafts,
} from '../src/applications.js';

const KEY = 'resume-designer-applications';

function reload() {
  // Re-read what save() wrote, as a fresh boot would.
  return initApplications();
}

beforeEach(() => {
  localStorage.clear();
  initApplications();
});

describe('initApplications — stored shapes', () => {
  it('loads a normal array store', () => {
    localStorage.setItem(KEY, '[{"id":"app-1","variantId":"v1","status":"applied"}]');
    initApplications();
    expect(getAllApplications().map((a) => a.id)).toEqual(['app-1']);
  });

  it('self-heals an id-keyed object map into an array', () => {
    localStorage.setItem(KEY, '{"app-1":{"id":"app-1","variantId":"v1"}}');
    initApplications();
    expect(getAllApplications().map((a) => a.id)).toEqual(['app-1']);
  });

  it('degrades non-object JSON to an empty list', () => {
    localStorage.setItem(KEY, '"oops"');
    initApplications();
    expect(getAllApplications()).toEqual([]);
  });
});

describe('addApplication', () => {
  it('creates a prepared draft by default with a seeded history', () => {
    const app = addApplication({ variantId: 'v1', variantName: 'PM Resume' });
    expect(app.status).toBe('prepared');
    expect(app.statusHistory).toEqual([{ status: 'prepared', at: app.createdAt }]);
    expect(app.appliedAt).toBeNull();
    expect(app.jobSnapshot).toEqual({ title: '', company: '' });
    expect(reload().map((a) => a.id)).toEqual([app.id]);
  });

  it('sets appliedAt immediately when created past prepared', () => {
    const app = addApplication({ variantId: 'v1', status: 'applied' });
    expect(app.appliedAt).toBe(app.createdAt);
  });

  it('rejects unknown statuses back to prepared', () => {
    const app = addApplication({ variantId: 'v1', status: 'ghosted-lol' });
    expect(app.status).toBe('prepared');
  });

  it('backdates appliedAt and the initial statusHistory entry, but not createdAt', () => {
    const backdated = new Date('2026-01-01T12:00:00.000Z').toISOString();
    const app = addApplication({ variantId: 'v1', status: 'applied', appliedAt: backdated });
    expect(app.appliedAt).toBe(backdated);
    expect(app.statusHistory).toEqual([{ status: 'applied', at: backdated }]);
    expect(app.createdAt).not.toBe(backdated);
  });

  it('ignores a passed appliedAt when the resolved status is prepared', () => {
    const backdated = new Date('2026-01-01T12:00:00.000Z').toISOString();
    const app = addApplication({ variantId: 'v1', appliedAt: backdated });
    expect(app.appliedAt).toBeNull();
    expect(app.statusHistory[0].at).not.toBe(backdated);
  });
});

describe('setApplicationStatus', () => {
  it('appends to statusHistory and stamps appliedAt on first non-prepared status', () => {
    const app = addApplication({ variantId: 'v1' });
    const updated = setApplicationStatus(app.id, 'interview'); // skip straight past applied
    expect(updated.status).toBe('interview');
    expect(updated.statusHistory.map((h) => h.status)).toEqual(['prepared', 'interview']);
    expect(updated.appliedAt).not.toBeNull();
  });

  it('stamps appliedAt even for terminal statuses (rejected implies it was sent)', () => {
    const app = addApplication({ variantId: 'v1' });
    expect(setApplicationStatus(app.id, 'rejected').appliedAt).not.toBeNull();
  });

  it('does not re-stamp appliedAt on later transitions', () => {
    const app = addApplication({ variantId: 'v1' });
    const first = setApplicationStatus(app.id, 'applied').appliedAt;
    expect(setApplicationStatus(app.id, 'offer').appliedAt).toBe(first);
  });

  it('ignores unknown statuses and no-op repeats', () => {
    const app = addApplication({ variantId: 'v1' });
    setApplicationStatus(app.id, 'bogus');
    setApplicationStatus(app.id, 'prepared');
    expect(getAllApplications()[0].statusHistory).toHaveLength(1);
  });
});

describe('updateApplication', () => {
  it('patches notes and bumps updatedAt, protecting managed fields', () => {
    const app = addApplication({ variantId: 'v1' });
    const updated = updateApplication(app.id, {
      notes: 'recruiter said reapply in 6mo',
      status: 'offer', statusHistory: [], id: 'app-hax', createdAt: 'nope',
    });
    expect(updated.notes).toBe('recruiter said reapply in 6mo');
    expect(updated.status).toBe('prepared');
    expect(updated.statusHistory).toHaveLength(1);
    expect(updated.id).toBe(app.id);
    expect(updated.createdAt).toBe(app.createdAt);
  });
});

describe('deleteApplication', () => {
  it('removes the record and persists', () => {
    const app = addApplication({ variantId: 'v1' });
    expect(deleteApplication(app.id)).toBe(true);
    expect(deleteApplication(app.id)).toBe(false);
    expect(reload()).toEqual([]);
  });
});

describe('recordTailorDrafts — the dedupe-on-retailor rule', () => {
  const jds = [
    { id: 'jd-1', title: 'PM', company: 'Stripe' },
    { id: 'jd-2', title: 'EM', company: 'Linear' },
  ];

  it('creates one prepared draft per job description with snapshots', () => {
    const drafts = recordTailorDrafts('v1', 'PM Resume', jds);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].jobSnapshot).toEqual({ title: 'PM', company: 'Stripe' });
    expect(drafts.every((d) => d.status === 'prepared' && d.variantName === 'PM Resume')).toBe(true);
  });

  it('re-tailoring while still prepared updates the existing draft (no duplicate)', () => {
    recordTailorDrafts('v1', 'PM Resume', jds);
    recordTailorDrafts('v1', 'PM Resume v2', [jds[0]]);
    const all = getApplicationsForVariant('v1');
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.jobId === 'jd-1').variantName).toBe('PM Resume v2');
  });

  it('re-tailoring after the application advanced creates a new record', () => {
    const [draft] = recordTailorDrafts('v1', 'PM Resume', [jds[0]]);
    setApplicationStatus(draft.id, 'applied');
    recordTailorDrafts('v1', 'PM Resume', [jds[0]]);
    expect(getApplicationsForVariant('v1')).toHaveLength(2);
  });
});
