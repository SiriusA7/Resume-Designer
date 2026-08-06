import { describe, it, expect, beforeEach } from 'vitest';
import { applyChangeToStore } from '../src/changeApply.js';
import { groupExperience } from '../src/experienceGroups.js';
import { store } from '../src/store.js';

// A grouped employer prints ONE company header, and only the run lead's company
// is editable on it (renderGroupHeader); the trailing roles carry no
// data-editable. The inline editor fans a rename across the run via
// data-editable-group, but that attribute is DOM metadata changeApply cannot
// see — so an AI-applied rename used to write the lead alone, and the run split
// because groupExperience needs an identical company as well as a shared
// _groupId. One header silently became two over entries still sharing an id.

const run = (company) => ([
  { id: 'a', company, title: 'Senior Engineer', dates: 'Mar 2022 – Present', _groupId: 'g1', bullets: [] },
  { id: 'b', company, title: 'Engineer', dates: 'Jan 2020 – Mar 2022', _groupId: 'g1', bullets: [] },
]);

const experience = () => store.get('experience');
const rename = (index, newValue, oldValue) => applyChangeToStore({
  path: `experience[${index}].company`, type: 'modify', oldValue, newValue,
});

describe('applyChangeToStore — grouped employer rename', () => {
  beforeEach(() => {
    store.setData({ name: 'Ada', experience: run('Acme') }, true, null);
  });

  it('fans a rename out across every role in the run', () => {
    rename(0, 'Acme Corp', 'Acme');

    expect(experience().map((e) => e.company)).toEqual(['Acme Corp', 'Acme Corp']);
  });

  it('keeps the run intact, which a lead-only write would not', () => {
    rename(0, 'Acme Corp', 'Acme');

    const groups = groupExperience(experience());
    expect(groups).toHaveLength(1);
    expect(groups[0].roles).toHaveLength(2);
    expect(groups[0].company).toBe('Acme Corp');
  });

  it('fans out from a trailing role too, not just the lead', () => {
    rename(1, 'Acme Corp', 'Acme');

    expect(experience().map((e) => e.company)).toEqual(['Acme Corp', 'Acme Corp']);
  });

  it('leaves every other field on every member untouched', () => {
    rename(0, 'Acme Corp', 'Acme');

    expect(experience().map((e) => e.title)).toEqual(['Senior Engineer', 'Engineer']);
    expect(experience().map((e) => e._groupId)).toEqual(['g1', 'g1']);
    expect(experience()[1].dates).toBe('Jan 2020 – Mar 2022');
  });

  it('does not touch a neighbouring employer outside the run', () => {
    store.setData({
      name: 'Ada',
      experience: [...run('Acme'), { id: 'c', company: 'Globex', title: 'Analyst', dates: '2018 – 2020', bullets: [] }],
    }, true, null);

    rename(0, 'Acme Corp', 'Acme');

    expect(experience().map((e) => e.company)).toEqual(['Acme Corp', 'Acme Corp', 'Globex']);
  });

  it('writes a solo entry alone — nothing to fan out to', () => {
    store.setData({
      name: 'Ada',
      experience: [{ id: 'c', company: 'Globex', title: 'Analyst', dates: '2018 – 2020', bullets: [] }],
    }, true, null);

    rename(0, 'Globex Inc', 'Globex');

    expect(experience()[0].company).toBe('Globex Inc');
  });

  it('heals an already-split run rather than fanning the wrong name outwards', () => {
    // The lead was renamed by some earlier path and the run is broken. Renaming
    // the trailing role to match must not be treated as a run-wide edit — there
    // is no run yet — it must write that one entry and restore the pairing.
    store.setData({
      name: 'Ada',
      experience: [
        { id: 'a', company: 'Acme Corp', title: 'Senior Engineer', dates: 'Mar 2022 – Present', _groupId: 'g1', bullets: [] },
        { id: 'b', company: 'Acme', title: 'Engineer', dates: 'Jan 2020 – Mar 2022', _groupId: 'g1', bullets: [] },
      ],
    }, true, null);
    expect(groupExperience(experience())).toHaveLength(2);

    rename(1, 'Acme Corp', 'Acme');

    expect(groupExperience(experience())).toHaveLength(1);
  });

  it('does not burn an undo step on an unchanged value', () => {
    const before = store.canUndo();
    rename(0, 'Acme', 'Acme');

    expect(store.canUndo()).toBe(before);
    expect(experience().map((e) => e.company)).toEqual(['Acme', 'Acme']);
  });
});
