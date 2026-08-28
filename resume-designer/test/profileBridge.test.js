import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildProfile, getProfileState, applyProfile } from '../src/profileBridge.js';
import { getUserProfile, saveUserProfile } from '../src/persistence.js';
import { flushPendingProfileSave } from '../src/userProfilePanel.js';

// The native Profile sheet's two halves: what crosses to Swift (`buildProfile`)
// and what comes back (`applyProfile`). Every payload value arrives from Swift
// as a String, so the actions are exercised the way the bridge really calls
// them — with strings, not numbers.

const view = () => buildProfile(getProfileState());

const section = (id) => view().sections.find((s) => s.id === id);

const fieldAt = (sectionId, path) => section(sectionId).groups
  .flatMap((g) => [...g.fields, ...g.items.flatMap((i) => i.fields)])
  .find((f) => f.path === path);

function seed(profile) {
  saveUserProfile(profile);
}

beforeEach(() => {
  localStorage.clear();
  // The module remembers a failed write across calls (that is the point of
  // `saveFailed`), so every test starts from one that landed.
  applyProfile({ action: 'setField', path: 'personalSummary', value: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildProfile — the projection', () => {
  it('survives being handed nothing', () => {
    const empty = buildProfile();
    expect(empty.sections.map((s) => s.id)).toEqual([
      'contact', 'summary', 'experience', 'skills', 'education', 'projects', 'more',
    ]);
    expect(empty.completeness).toBe(0);
    expect(empty.saveFailed).toBe(false);
    expect(empty.pendingImport).toBeNull();
  });

  it('mints the paths Swift echoes back, and never asks it to build one', () => {
    seed({
      contactInfo: { email: 'a@b.c' },
      skills: [{ name: 'React', proficiency: 'expert', years: '6' }],
    });
    expect(fieldAt('contact', 'contactInfo.email').value).toBe('a@b.c');
    expect(fieldAt('skills', 'skills[0].years').value).toBe('6');
    expect(fieldAt('skills', 'skills[0].proficiency').options.map((o) => o.value))
      .toEqual(['beginner', 'intermediate', 'advanced', 'expert']);
  });

  it('marks résumé prose but leaves identifiers their normal behaviour', () => {
    seed({ projects: [{ name: 'Atlas', url: 'https://x.dev', description: 'A thing' }] });
    expect(fieldAt('contact', 'contactInfo.fullName').prose).toBe(true);
    expect(fieldAt('contact', 'contactInfo.email').prose).toBe(false);
    expect(fieldAt('contact', 'contactInfo.email').keyboard).toBe('email');
    expect(fieldAt('projects', 'projects[0].url').prose).toBe(false);
    expect(fieldAt('projects', 'projects[0].url').keyboard).toBe('url');
    expect(fieldAt('projects', 'projects[0].description').prose).toBe(true);
  });

  it('strips emphasis on display the way the web textareas do', () => {
    seed({ personalSummary: 'I ship **fast** and _well_, my_var stays' });
    expect(fieldAt('summary', 'personalSummary').value)
      .toBe('I ship fast and well, my_var stays');
  });

  it('counts each section on its root row', () => {
    seed({
      contactInfo: { fullName: 'Ash', email: 'a@b.c' },
      workExperience: [{ id: 'e1', title: 'Dev', company: 'Acme' }],
      skills: [],
    });
    expect(section('contact').badge).toBe('2 of 9');
    expect(section('experience').badge).toBe('1 role');
    expect(section('skills').badge).toBe('None');
  });

  it('reports completeness with the same function the desktop Account row uses', () => {
    seed({
      personalSummary: 'x',
      workExperience: [{ id: 'e1', title: 'Dev' }],
      skills: [{ name: 'React' }],
      education: [],
    });
    expect(view().completeness).toBe(75);
  });
});

describe('buildProfile — employers', () => {
  const RUN = [
    { id: 'e1', title: 'Senior', company: 'Acme', _groupId: 'g1' },
    { id: 'e2', title: 'Junior', company: 'Acme', _groupId: 'g1' },
    { id: 'e3', title: 'Founder', company: 'Solo' },
  ];

  it('projects runs through groupExperience, never its own grouping', () => {
    seed({ workExperience: RUN });
    const employers = section('experience').employers;
    expect(employers.map((e) => e.company)).toEqual(['Acme', 'Solo']);
    expect(employers[0].roles.map((r) => r.title)).toEqual(['Senior', 'Junior']);
    expect(employers[0].leadIndex).toBe(0);
    expect(employers[0].leadKey).toBe('e1');
  });

  it('only offers detach below the lead, and add-role on a named employer', () => {
    seed({ workExperience: [...RUN, { id: 'e4', title: 'Unnamed', company: '' }] });
    const [acme, solo, unnamed] = section('experience').employers;
    expect(acme.roles.map((r) => r.canDetach)).toEqual([false, true]);
    expect(solo.canAddRole).toBe(true);
    expect(unnamed.canAddRole).toBe(false);
  });

  it('offers link-above only when the entry above is the same employer', () => {
    seed({
      workExperience: [
        { id: 'e1', title: 'A', company: 'Acme' },
        { id: 'e2', title: 'B', company: 'Acme' },
        { id: 'e3', title: 'C', company: 'Other' },
      ],
    });
    const [first, second, third] = section('experience').employers;
    expect(first.showLinkAbove).toBe(false);
    expect(second.showLinkAbove).toBe(true);
    expect(second.canLinkAbove).toBe(true);
    expect(third.canLinkAbove).toBe(false);
  });

  it('reads dates only through readEntryDates', () => {
    seed({
      workExperience: [
        { id: 'e1', dates: 'Jan 2020 – Mar 2021', startDate: '2020-01', endDate: '2021-03' },
        { id: 'e2', dates: 'Summer 2019' },
        { id: 'e3', dates: 'Feb 2022 – Present', startDate: '2022-02', endDate: 'Present' },
      ],
    });
    const roles = section('experience').employers.flatMap((e) => e.roles);
    expect(roles[0].dates).toMatchObject({
      startYear: 2020, startMonth: 1, endYear: 2021, endMonth: 3, ongoing: false, freeform: false,
    });
    // A display string with no machine pair behind it stays unstructured — the
    // picker must not guess months out of prose.
    expect(roles[1].dates).toMatchObject({
      display: 'Summer 2019', startYear: 0, endYear: 0, freeform: true,
    });
    expect(roles[2].dates).toMatchObject({ ongoing: true, endYear: 0, freeform: false });
  });
});

describe('applyProfile — fields', () => {
  it('writes one scalar from the string the bridge sends', () => {
    seed({ skills: [{ name: 'React', proficiency: '', years: '' }] });
    applyProfile({ action: 'setField', path: 'skills[0].proficiency', value: 'expert' });
    applyProfile({ action: 'setField', path: 'contactInfo.email', value: 'a@b.c' });
    expect(getUserProfile().skills[0].proficiency).toBe('expert');
    expect(getUserProfile().contactInfo.email).toBe('a@b.c');
  });

  it('refuses a path whose row is gone rather than growing the array', () => {
    seed({ skills: [{ name: 'React' }] });
    expect(() => applyProfile({ action: 'setField', path: 'skills[3].name', value: 'x' }))
      .toThrow(/no field/);
    expect(getUserProfile().skills).toHaveLength(1);
  });

  it('adds and deletes rows without Swift knowing their shape', () => {
    applyProfile({ action: 'addItem', listPath: 'skills' });
    expect(getUserProfile().skills).toEqual([{ name: '', proficiency: '', years: '' }]);
    applyProfile({ action: 'setField', path: 'skills[0].name', value: 'Rust' });
    applyProfile({ action: 'deleteItem', listPath: 'skills', index: '0', key: 'Rust' });
    expect(getUserProfile().skills).toEqual([]);
  });

  it('refuses a delete whose row is no longer the one the sheet showed', () => {
    seed({ skills: [{ name: 'React' }, { name: 'Rust' }] });
    expect(() => applyProfile({
      action: 'deleteItem', listPath: 'skills', index: '1', key: 'React',
    })).toThrow(/moved/);
    expect(getUserProfile().skills).toHaveLength(2);
  });

  it('rejects an unknown action and an unknown list', () => {
    expect(() => applyProfile({ action: 'nope' })).toThrow(/unknown profile action/);
    expect(() => applyProfile({ action: 'addItem', listPath: 'salaries' }))
      .toThrow(/unknown profile list/);
  });
});

describe('applyProfile — dates are atomic or nothing', () => {
  beforeEach(() => {
    seed({ workExperience: [{ id: 'e1', title: 'Dev', dates: 'old', startDate: '2019-01', endDate: '2019-06' }] });
  });

  it('writes all three fields for a complete range', () => {
    applyProfile({
      action: 'setDates', index: '0', key: 'e1', mode: 'range',
      startYear: '2020', startMonth: '1', endYear: '2021', endMonth: '3', ongoing: 'false',
    });
    expect(getUserProfile().workExperience[0]).toMatchObject({
      dates: 'Jan 2020 – Mar 2021', startDate: '2020-01', endDate: '2021-03',
    });
  });

  it('writes Present for an ongoing role and ignores the end', () => {
    applyProfile({
      action: 'setDates', index: '0', key: 'e1', mode: 'range',
      startYear: '2022', startMonth: '2', endYear: '0', endMonth: '0', ongoing: 'true',
    });
    expect(getUserProfile().workExperience[0]).toMatchObject({
      dates: 'Feb 2022 – Present', startDate: '2022-02', endDate: 'Present',
    });
  });

  it('writes NOTHING for a half pair or a reversed range', () => {
    for (const draft of [
      { startYear: '2020', startMonth: '1', endYear: '0', endMonth: '0' },
      { startYear: '2020', startMonth: '6', endYear: '2019', endMonth: '1' },
    ]) {
      expect(() => applyProfile({
        action: 'setDates', index: '0', key: 'e1', mode: 'range', ongoing: 'false', ...draft,
      })).toThrow(/incomplete/);
    }
    expect(getUserProfile().workExperience[0].dates).toBe('old');
    expect(getUserProfile().workExperience[0].startDate).toBe('2019-01');
  });

  it('clears the machine pair when the dates are typed as text', () => {
    applyProfile({ action: 'setDates', index: '0', key: 'e1', mode: 'text', text: 'Summer 2019' });
    expect(getUserProfile().workExperience[0]).toMatchObject({
      dates: 'Summer 2019', startDate: '', endDate: '',
    });
  });

  it('refuses when the entry at that index is a different role', () => {
    expect(() => applyProfile({
      action: 'setDates', index: '0', key: 'e9', mode: 'text', text: 'x',
    })).toThrow(/moved/);
  });
});

describe('applyProfile — employer runs', () => {
  it('adds a role after the run and carries its id and company', () => {
    seed({ workExperience: [{ id: 'e1', title: 'Dev', company: 'Acme' }] });
    applyProfile({ action: 'addRole', index: '0', key: 'e1' });
    const items = getUserProfile().workExperience;
    expect(items).toHaveLength(2);
    expect(items[1].company).toBe('Acme');
    expect(items[0]._groupId).toBeTruthy();
    expect(items[1]._groupId).toBe(items[0]._groupId);
  });

  it('detaches a role and carries the trailing run members with it', () => {
    seed({
      workExperience: [
        { id: 'e1', company: 'Acme', _groupId: 'g1' },
        { id: 'e2', company: 'Acme', _groupId: 'g1' },
        { id: 'e3', company: 'Acme', _groupId: 'g1' },
      ],
    });
    applyProfile({ action: 'detachRole', index: '1', key: 'e2' });
    const items = getUserProfile().workExperience;
    expect(items[0]._groupId).toBe('g1');
    expect(items[1]._groupId).not.toBe('g1');
    expect(items[2]._groupId).toBe(items[1]._groupId);
  });

  it('links to the employer above without ever writing a company', () => {
    seed({
      workExperience: [
        { id: 'e1', company: 'Acme Corp' },
        { id: 'e2', company: 'Acme Corp' },
      ],
    });
    applyProfile({ action: 'linkAbove', index: '1', key: 'e2' });
    const items = getUserProfile().workExperience;
    expect(items[0]._groupId).toBe(items[1]._groupId);
    expect(items[1].company).toBe('Acme Corp');
  });

  it('refuses to link an entry under a different employer', () => {
    seed({
      workExperience: [{ id: 'e1', company: 'Acme' }, { id: 'e2', company: 'Other' }],
    });
    expect(() => applyProfile({ action: 'linkAbove', index: '1', key: 'e2' })).toThrow();
    expect(getUserProfile().workExperience[1].company).toBe('Other');
  });

  it('renames every role in the run from the lead', () => {
    seed({
      workExperience: [
        { id: 'e1', company: 'Acme', _groupId: 'g1' },
        { id: 'e2', company: 'Acme', _groupId: 'g1' },
        { id: 'e3', company: 'Other' },
      ],
    });
    applyProfile({ action: 'setCompany', index: '0', key: 'e1', value: 'Acme Labs' });
    expect(getUserProfile().workExperience.map((e) => e.company))
      .toEqual(['Acme Labs', 'Acme Labs', 'Other']);
  });

  it('deletes every position at one employer and nothing else', () => {
    seed({
      workExperience: [
        { id: 'e1', company: 'Acme', _groupId: 'g1' },
        { id: 'e2', company: 'Acme', _groupId: 'g1' },
        { id: 'e3', company: 'Other' },
      ],
    });
    applyProfile({ action: 'deleteEmployer', index: '0', key: 'e1' });
    expect(getUserProfile().workExperience.map((e) => e.id)).toEqual(['e3']);
  });
});

describe('applyProfile — markdown import', () => {
  const ONE_EMPLOYER = `# User Profile

## Personal Summary

I ship things.

## Work Experience

### Senior Dev at Acme
**Dates:** 2020 - 2022

Led the thing.

### Junior Dev at Acme
**Dates:** 2018 - 2020

Learned the thing.
`;

  it('asks about grouping instead of writing, when there is something to ask', () => {
    applyProfile({ action: 'importMarkdown', text: ONE_EMPLOYER });
    expect(view().pendingImport).toEqual({ runCount: 1 });
    // Nothing has landed yet — the question is the gate.
    expect(getUserProfile().personalSummary).toBe('');

    applyProfile({ action: 'resolveImport', group: 'true' });
    const items = getUserProfile().workExperience;
    expect(getUserProfile().personalSummary).toBe('I ship things.');
    expect(items[0]._groupId).toBeTruthy();
    expect(items[1]._groupId).toBe(items[0]._groupId);
    expect(view().pendingImport).toBeNull();
  });

  it('keeps the roles separate when that is the answer', () => {
    applyProfile({ action: 'importMarkdown', text: ONE_EMPLOYER });
    applyProfile({ action: 'resolveImport', group: 'false' });
    expect(getUserProfile().workExperience.every((e) => !e._groupId)).toBe(true);
  });

  it('drops the parse on cancel', () => {
    applyProfile({ action: 'importMarkdown', text: ONE_EMPLOYER });
    applyProfile({ action: 'cancelImport' });
    expect(view().pendingImport).toBeNull();
    expect(getUserProfile().workExperience).toEqual([]);
  });

  it('imports straight away when no employer repeats', () => {
    applyProfile({
      action: 'importMarkdown',
      text: '# User Profile\n\n## Personal Summary\n\nJust me.\n',
    });
    expect(view().pendingImport).toBeNull();
    expect(getUserProfile().personalSummary).toBe('Just me.');
  });
});

describe('the flush contract', () => {
  it('projects a failed write and reports it to flushPendingProfileSave', () => {
    seed({ personalSummary: 'safe' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    applyProfile({ action: 'setField', path: 'personalSummary', value: 'lost' });

    // The write did not land, so the sheet has to say so — the web's only
    // signal is a toast rendered behind the sheet.
    expect(view().saveFailed).toBe(true);
    expect(getUserProfile().personalSummary).toBe('safe');
    // …and a backup or a profile switch must abort rather than reload the
    // edits away.
    expect(flushPendingProfileSave()).toBe(false);

    vi.restoreAllMocks();
    // The retry is the whole reason the failure is remembered.
    expect(flushPendingProfileSave()).toBe(true);
    expect(getUserProfile().personalSummary).toBe('lost');
    expect(view().saveFailed).toBe(false);
  });

  it('keeps building on the edit that could not be written', () => {
    seed({ personalSummary: 'safe' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    applyProfile({ action: 'setField', path: 'personalSummary', value: 'first' });
    applyProfile({ action: 'setField', path: 'careerGoals', value: 'second' });
    // Both are still on screen, because the sheet renders the copy that failed
    // rather than the pre-edit profile still sitting in storage.
    expect(fieldAt('summary', 'personalSummary').value).toBe('first');
    expect(fieldAt('summary', 'careerGoals').value).toBe('second');

    vi.restoreAllMocks();
    expect(flushPendingProfileSave()).toBe(true);
    // …and one retry lands the whole session, not just the last keystroke.
    expect(getUserProfile()).toMatchObject({ personalSummary: 'first', careerGoals: 'second' });
  });
});

describe('a write aimed at a profile that has moved on', () => {
  it('refuses a picker\u2019s choice made across an adoption', async () => {
    // A text row holds the sync guard while it has focus, so no adoption can
    // land under it. A PICKER has no focus and its menu can sit open across
    // one — and `skills[1].proficiency` is a position, so the tap would set the
    // proficiency of whichever skill moved into that row.
    const { registerUserProfileHolder, adoptStoredUserProfile, userProfileAdoptions } =
      await import('../src/userProfileHolder.js');
    seed({ skills: [{ name: 'Swift', proficiency: 'expert' }, { name: 'Rust', proficiency: 'novice' }] });

    const drawnFrom = String(userProfileAdoptions());
    // The profile is replaced while the menu is open.
    const stop = registerUserProfileHolder({ isBusy: () => false, adopt: () => {} });
    adoptStoredUserProfile();

    expect(() => applyProfile({
      action: 'setField', path: 'skills[1].proficiency', value: 'expert', revision: drawnFrom,
    })).toThrow(/older profile/);
    expect(getUserProfile().skills[1].proficiency).toBe('novice');

    // Re-opened against what is on screen now, it goes through.
    applyProfile({
      action: 'setField',
      path: 'skills[1].proficiency',
      value: 'expert',
      revision: String(userProfileAdoptions()),
    });
    expect(getUserProfile().skills[1].proficiency).toBe('expert');
    stop();
  });

  it('still takes a write from a control that is guarded by focus', () => {
    // Every keystroke from a focused row arrives with no revision at all, and
    // must not start failing: that row reports its focus to the sync guard, so
    // an adoption cannot land underneath it in the first place.
    seed({ personalSummary: 'before' });
    applyProfile({ action: 'setField', path: 'personalSummary', value: 'after' });
    expect(getUserProfile().personalSummary).toBe('after');
  });
});

