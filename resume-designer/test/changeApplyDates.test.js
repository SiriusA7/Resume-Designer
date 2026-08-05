import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyChangeToStore } from '../src/changeApply.js';
import { stripUnaddressableDatePaths } from '../src/aiService.js';
import { diffResumeData, createChangeSet } from '../src/diffEngine.js';
import { datesAreContinuous, groupExperience } from '../src/experienceGroups.js';
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

// An ADDITION carries a whole object, so the key-level skip never sees inside
// it. The change prompt serialises the current resume WITH the pair, so a model
// templating a new role off an existing entry brings that entry's start month.
describe('added and wholesale-rewritten entries cannot carry the pair', () => {
  const paths = (changeSet) => changeSet.changes.map((c) => c.path);
  const added = (changeSet) => changeSet.changes.find((c) => c.type === 'add');

  it('strips the pair from an inserted experience item', () => {
    const changeSet = createChangeSet(
      { name: 'Ada', experience: [{ ...ROLE }] },
      {
        experience: [
          { ...ROLE },
          { id: 'new', company: 'Globex', title: 'Staff Engineer', dates: 'Apr 2024 – Present', startDate: '2020-01', endDate: 'Present', bullets: [] },
        ],
      },
    );

    const add = added(changeSet);
    expect(add, 'the diff should emit an ADD for the new item').toBeDefined();
    expect(add.newValue.dates).toBe('Apr 2024 – Present');
    expect(add.newValue).not.toHaveProperty('startDate');
    expect(add.newValue).not.toHaveProperty('endDate');
  });

  it('leaves an inserted entry unstructured once applied', () => {
    store.setData({ name: 'Ada', experience: [{ ...ROLE }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      experience: [
        { ...ROLE },
        { id: 'new', company: 'Globex', title: 'Staff Engineer', dates: 'Apr 2024 – Present', startDate: '2020-01', endDate: 'Present', bullets: [] },
      ],
    });
    changeSet.changes.forEach(applyChangeToStore);

    const inserted = store.get('experience').find((e) => e.id === 'new');
    expect(inserted.dates).toBe('Apr 2024 – Present');
    expect(inserted.startDate).toBeUndefined();
    expect(inserted.endDate).toBeUndefined();
  });

  it('emits nothing at all when only the pair differs', () => {
    // Entries carrying an `id` match in diffArray's first pass, which pushes
    // diffResumeData's leaf changes directly — so the key-level skip alone
    // already makes this empty.
    const changeSet = createChangeSet(
      { name: 'Ada', experience: [{ ...ROLE }] },
      { experience: [{ ...ROLE, startDate: '1999-01', endDate: '1999-12' }] },
    );

    expect(paths(changeSet)).toEqual([]);
  });

  it('emits nothing for a pair-only difference on an id-less entry either', () => {
    // Without an `id` the item falls to diffArray's POSITIONAL pass, where a
    // recursion that reports no leaf changes falls back to a whole-object
    // MODIFY. That fallback carried newEntry.item verbatim, smuggling the pair
    // straight back past the key-level skip.
    const noId = { company: 'Acme', title: 'Engineer', dates: 'Jan 2020 – Mar 2022', startDate: '2020-01', endDate: '2022-03', bullets: ['x'] };
    const changeSet = createChangeSet(
      { experience: [{ ...noId }] },
      { experience: [{ ...noId, startDate: '1999-01', endDate: '1999-12' }] },
    );

    expect(paths(changeSet)).toEqual([]);
  });

  // Guard, not coverage of the fallback: adding a field produces a leaf change,
  // so diffResumeData reports work and the whole-object branch never runs. It
  // pins that the ordinary leaf route leaves the pair alone.
  it('leaves the stored pair alone when a field is added to an id-less entry', () => {
    const noId = { company: 'Acme', title: 'Engineer', dates: 'Jan 2020 – Mar 2022', startDate: '2020-01', endDate: '2022-03', bullets: ['x'] };
    store.setData({ experience: [{ ...noId }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      experience: [{ ...noId, bullets: ['x'], location: 'Remote', startDate: '1999-01', endDate: '1999-12' }],
    });
    changeSet.changes.forEach(applyChangeToStore);

    expect(entry().startDate).toBe('2020-01');
    expect(entry().endDate).toBe('2022-03');
  });

  it('carries the stored pair over a wholesale entry rewrite rather than deleting it', () => {
    store.setData({ name: 'Ada', experience: [{ ...ROLE }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      experience: [{ ...ROLE, title: 'Staff Engineer', startDate: '1999-01', endDate: '1999-12' }],
    });
    changeSet.changes.forEach(applyChangeToStore);

    expect(entry().title).toBe('Staff Engineer');
    expect(entry().startDate).toBe('2020-01');
    expect(entry().endDate).toBe('2022-03');
  });
});

// `_groupId` is the other internal the change prompt leaks: it serialises the
// resume with `JSON.stringify(resumeData)`, so a model templating a new role off
// an existing entry brings that run's id — and groupExperience folds the new
// role into the employer's tenure the moment it lands adjacent to it.
describe('added entries cannot inherit a group id', () => {
  const LEAD = { id: 'a', company: 'Acme', title: 'Senior Engineer', dates: 'Mar 2022 – Present', _groupId: 'g1', bullets: [] };
  const proposedRole = { id: 'new', company: 'Acme', title: 'Engineer', dates: 'Jan 2020 – Mar 2022', _groupId: 'g1', bullets: [] };

  it('strips _groupId from an inserted item', () => {
    const changeSet = createChangeSet(
      { experience: [{ ...LEAD }] },
      { experience: [{ ...LEAD }, { ...proposedRole }] },
    );

    const add = changeSet.changes.find((c) => c.type === 'add');
    expect(add.newValue).not.toHaveProperty('_groupId');
    // `id` must survive — applyChangeToStore reads it to make re-applying an ADD
    // a no-op rather than a duplicate.
    expect(add.newValue.id).toBe('new');
  });

  it('does not silently fold the new role into the employer run', () => {
    store.setData({ experience: [{ ...LEAD }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      experience: [{ ...LEAD }, { ...proposedRole }],
    });
    changeSet.changes.forEach(applyChangeToStore);

    const groups = groupExperience(store.get('experience'));
    expect(groups).toHaveLength(2);
    expect(store.get('experience')[1]._groupId).toBeUndefined();
  });

  it('keeps the stored _groupId across a wholesale entry rewrite', () => {
    // Dropping it here would be the mirror-image bug: a rewrite must not
    // dissolve a run the user built.
    store.setData({ experience: [{ ...LEAD }, { ...proposedRole, id: 'b' }] }, true, null);
    const changeSet = createChangeSet(store.getData(), {
      'experience[0]': { ...LEAD, title: 'Staff Engineer', _groupId: 'someone-elses-id' },
    });
    changeSet.changes.forEach(applyChangeToStore);

    expect(store.get('experience')[0].title).toBe('Staff Engineer');
    expect(store.get('experience')[0]._groupId).toBe('g1');
  });
});
