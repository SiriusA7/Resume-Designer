import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyChangeToStore } from '../src/changeApply.js';
import { stripUnaddressableDatePaths } from '../src/aiService.js';
import { diffResumeData, createChangeSet } from '../src/diffEngine.js';
import { datesAreContinuous } from '../src/experienceGroups.js';
import { store } from '../src/store.js';

// `experience[i].dates` is an AI-addressable path, so a model proposal rewrites
// the human display string — and a plain scalar write left the machine-readable
// startDate/endDate beside it still describing the OLD range. That is exactly
// the contradiction R2 exists to prevent, and datesAreContinuous would then gate
// grouping on the stale half. changeApply is the choke point both AI surfaces
// (the chat flow and job recommendations) route through, so the rule is pinned
// here.

const ROLE = {
  id: 'a',
  company: 'Acme',
  title: 'Engineer',
  dates: 'Jan 2020 – Mar 2022',
  startDate: '2020-01',
  endDate: '2022-03',
  bullets: ['Shipped a thing'],
};

const entry = () => store.get('experience')[0];

describe('applyChangeToStore — experience dates', () => {
  beforeEach(() => {
    store.setData({ name: 'Ada', experience: [{ ...ROLE }] }, true, null);
  });

  it('clears the structured pair when the dates text changes', () => {
    const change = diffResumeData(
      { experience: [ROLE] },
      { experience: [{ ...ROLE, dates: 'Jan 2020 – Mar 2024' }] },
    ).find((c) => c.path === 'experience[0].dates');
    expect(change, 'the diff should address the dates field').toBeDefined();

    applyChangeToStore(change);

    expect(entry().dates).toBe('Jan 2020 – Mar 2024');
    expect(entry().startDate).toBe('');
    expect(entry().endDate).toBe('');
  });

  it('leaves the rest of the entry intact', () => {
    applyChangeToStore({
      path: 'experience[0].dates', type: 'modify',
      oldValue: ROLE.dates, newValue: '2019 – 2024',
    });

    expect(entry().title).toBe('Engineer');
    expect(entry().company).toBe('Acme');
    expect(entry().bullets).toEqual(['Shipped a thing']);
    expect(entry().id).toBe('a');
  });

  it('writes all three fields in ONE store write (R1: one undo step)', () => {
    let writes = 0;
    const unsubscribe = store.subscribe((event) => { if (event === 'change') writes += 1; });

    applyChangeToStore({
      path: 'experience[0].dates', type: 'modify',
      oldValue: ROLE.dates, newValue: 'Jan 2020 – Mar 2024',
    });
    unsubscribe();

    expect(writes).toBe(1);
  });

  it('does NOT clear the pair when the proposed value is the one already stored', () => {
    // Reachable in practice: apply-all after a one-off apply, and a reopened
    // standalone dialog starting with empty applied-state, both re-apply changes.
    // A model echoing the current string does it too. Clearing on a change that
    // says nothing would silently drop the entry out of the grouping gate.
    applyChangeToStore({
      path: 'experience[0].dates', type: 'modify',
      oldValue: 'Jan 2019 – Dec 2019', newValue: ROLE.dates,
    });

    expect(entry().dates).toBe(ROLE.dates);
    expect(entry().startDate).toBe('2020-01');
    expect(entry().endDate).toBe('2022-03');
  });

  it('leaves every other scalar path writing normally', () => {
    applyChangeToStore({
      path: 'experience[0].title', type: 'modify',
      oldValue: 'Engineer', newValue: 'Senior Engineer',
    });

    expect(entry().title).toBe('Senior Engineer');
    expect(entry().startDate).toBe('2020-01');
    expect(entry().endDate).toBe('2022-03');
  });

  it('falls back to the generic write when there is no entry to carry the pair', () => {
    store.setData({ name: 'Ada' }, true, null);

    applyChangeToStore({
      path: 'experience[0].dates', type: 'add',
      oldValue: undefined, newValue: 'Jan 2020 – Present',
    });

    expect(store.get('experience')[0].dates).toBe('Jan 2020 – Present');
  });

  it('makes the grouping gate fail closed instead of acting on a stale month', () => {
    const later = { startDate: '2022-04', endDate: '2024-06' };
    // Before the edit the two tenures are adjacent, so the gate joins them.
    expect(datesAreContinuous(entry(), later)).toBe(true);

    applyChangeToStore({
      path: 'experience[0].dates', type: 'modify',
      oldValue: ROLE.dates, newValue: '2019 – 2022',
    });

    expect(datesAreContinuous(entry(), later)).toBe(false);
  });
});

describe('stripUnaddressableDatePaths', () => {
  it('drops model-proposed startDate/endDate paths and keeps dates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(stripUnaddressableDatePaths({
      'experience[0].dates': 'Jan 2020 – Mar 2024',
      'experience[0].startDate': '2020-01',
      'experience[1].endDate': '2024-03',
      summary: 'A new summary',
    })).toEqual({
      'experience[0].dates': 'Jan 2020 – Mar 2024',
      summary: 'A new summary',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('passes an addressable change set through untouched and silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changes = { 'experience[0].dates': 'Jan 2020 – Present', summary: 'Hi' };

    expect(stripUnaddressableDatePaths(changes)).toEqual(changes);
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalises anything that is not a change map to an empty one', () => {
    expect(stripUnaddressableDatePaths(undefined)).toEqual({});
    expect(stripUnaddressableDatePaths(null)).toEqual({});
    expect(stripUnaddressableDatePaths('experience[0].dates')).toEqual({});
    expect(stripUnaddressableDatePaths([{ path: 'summary' }])).toEqual({});
  });
});

// A path filter only sees KEYS. A model that proposes a whole container —
// `experience[0]`, or the entire `experience` array — carries startDate/endDate
// inside the VALUE, where the filter cannot reach; createChangeSet then re-diffs
// that container into leaves and re-creates exactly the writes the filter
// rejects. The diff engine skips the pair for that reason, the same way it
// already skips `_groupId`.
describe('container proposals cannot smuggle the date pair through', () => {
  const CURRENT = {
    name: 'Ada',
    experience: [{ ...ROLE }],
  };

  const paths = (changeSet) => changeSet.changes.map((c) => c.path);

  it('emits no leaf change for a whole-entry proposal carrying the pair', () => {
    const changeSet = createChangeSet(CURRENT, {
      'experience[0]': {
        ...ROLE, dates: 'Jan 2020 – Mar 2024', startDate: '1999-01', endDate: '1999-12',
      },
    });

    expect(paths(changeSet)).toContain('experience[0].dates');
    expect(paths(changeSet).filter((p) => /startDate|endDate/.test(p))).toEqual([]);
  });

  it('emits no leaf change for a whole-array proposal carrying the pair', () => {
    const changeSet = createChangeSet(CURRENT, {
      experience: [{ ...ROLE, dates: 'Jan 2020 – Mar 2024', startDate: '1999-01', endDate: '1999-12' }],
    });

    expect(paths(changeSet).filter((p) => /startDate|endDate/.test(p))).toEqual([]);
  });

  it('leaves the stored pair intact rather than blanking it', () => {
    // Skipping — not scrubbing — is what makes this true. Removing the keys from
    // the proposal would leave them in oldData and absent from newData, and the
    // key walk unions both sides, so the diff would emit a change blanking them.
    store.setData({ ...CURRENT, experience: [{ ...ROLE }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      'experience[0]': { ...ROLE, title: 'Staff Engineer', startDate: '1999-01', endDate: '1999-12' },
    });
    changeSet.changes.forEach(applyChangeToStore);

    expect(entry().title).toBe('Staff Engineer');
    expect(entry().startDate).toBe('2020-01');
    expect(entry().endDate).toBe('2022-03');
  });

  it('still lets a dates edit inside a container clear the pair (R2)', () => {
    store.setData({ ...CURRENT, experience: [{ ...ROLE }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      'experience[0]': { ...ROLE, dates: '2019 – 2024' },
    });
    changeSet.changes.forEach(applyChangeToStore);

    expect(entry().dates).toBe('2019 – 2024');
    expect(entry().startDate).toBe('');
    expect(entry().endDate).toBe('');
  });
});
