import { describe, it, expect } from 'vitest';
import { groupExperience, assignGroupIds, sortRunAware } from '../src/experienceGroups.js';
import { experienceSortValue } from '../src/store.js';

const e = (title, company, dates, extra = {}) => ({ title, company, dates, bullets: [], ...extra });

describe('groupExperience', () => {
  it('treats an entry with no _groupId as a run of one', () => {
    const groups = groupExperience([e('Dev', 'Acme', '2020 – 2022')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].roles).toHaveLength(1);
    expect(groups[0].groupId).toBeNull();
  });

  it('groups consecutive entries sharing an id and a company (P1 promotion)', () => {
    const groups = groupExperience([
      e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
      e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].company).toBe('Acme');
    expect(groups[0].roles.map((r) => r.index)).toEqual([0, 1]);
  });

  it('groups overlapping concurrent roles (P4) — dates are never inspected', () => {
    const groups = groupExperience([
      e('Interim Lead', 'Acme', 'Jan 2023 – Jun 2024', { _groupId: 'g1' }),
      e('Engineer', 'Acme', 'Jan 2019 – Jun 2024', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].roles).toHaveLength(2);
  });

  it('keeps two boomerang tenures apart (P3) — different ids never fuse', () => {
    const groups = groupExperience([
      e('Staff', 'Acme', '2023 – 2024', { _groupId: 'g2' }),
      e('Dev', 'Acme', '2018 – 2020', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('splits a run when a foreign employer is interleaved', () => {
    const groups = groupExperience([
      e('Senior Dev', 'Acme', '2022 – 2024', { _groupId: 'g1' }),
      e('Consultant', 'Initech', '2021 – 2022'),
      e('Dev', 'Acme', '2019 – 2021', { _groupId: 'g1' }),
    ]);
    expect(groups.map((g) => g.roles.length)).toEqual([1, 1, 1]);
  });

  it('drops an entry out of the run when its company no longer matches', () => {
    // Simulates an AI positional rewrite: index 1 kept the id but got new content.
    const groups = groupExperience([
      e('Senior Dev', 'Acme', '2022 – 2024', { _groupId: 'g1' }),
      e('Analyst', 'Initech', '2021 – 2022', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1].company).toBe('Initech');
  });

  it('ignores an empty company even when ids match', () => {
    const groups = groupExperience([
      e('Senior Dev', '', '2022 – 2024', { _groupId: 'g1' }),
      e('Dev', '', '2019 – 2022', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('returns an empty array for empty or missing input', () => {
    expect(groupExperience([])).toEqual([]);
    expect(groupExperience(undefined)).toEqual([]);
  });
});

describe('assignGroupIds', () => {
  it('mints one shared id per run of consecutive identical companies', () => {
    let n = 0;
    const out = assignGroupIds(
      [e('Senior Dev', 'Acme', '2022 – 2024'), e('Dev', 'Acme', '2019 – 2022'), e('Intern', 'Initech', '2018')],
      () => `g${++n}`,
    );
    expect(out[0]._groupId).toBe('g1');
    expect(out[1]._groupId).toBe('g1');
    expect(out[2]._groupId).toBeUndefined();
  });

  it('does not mutate the input array or its entries', () => {
    const input = [e('Senior Dev', 'Acme', '2022 – 2024'), e('Dev', 'Acme', '2019 – 2022')];
    assignGroupIds(input, () => 'g1');
    expect(input[0]._groupId).toBeUndefined();
  });

  it('leaves an existing _groupId untouched', () => {
    const out = assignGroupIds(
      [e('Senior Dev', 'Acme', '2022 – 2024', { _groupId: 'keep' }), e('Dev', 'Acme', '2019 – 2022', { _groupId: 'keep' })],
      () => 'fresh',
    );
    expect(out.map((x) => x._groupId)).toEqual(['keep', 'keep']);
  });

  it('never groups a blank company', () => {
    const out = assignGroupIds([e('A', '', '2022'), e('B', '', '2021')], () => 'g1');
    expect(out.every((x) => x._groupId === undefined)).toBe(true);
  });
});

describe('sortRunAware', () => {
  const byDateDesc = (entries) =>
    sortRunAware(entries, (run) => Math.max(...run.map(experienceSortValue)), (a, b) => b - a);

  it('keeps a run intact instead of interleaving a foreign employer', () => {
    // Without run-awareness the Initech entry (2021) sorts between the two Acme roles.
    const sorted = byDateDesc([
      e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
      e('Consultant', 'Initech', '2021 – 2022'),
      e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
    ]);
    expect(sorted.map((x) => x.company)).toEqual(['Acme', 'Acme', 'Initech']);
  });

  it('preserves member order inside a run', () => {
    const sorted = byDateDesc([
      e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
      e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
    ]);
    expect(sorted.map((x) => x.title)).toEqual(['Senior Dev', 'Dev']);
  });

  it('is stable for equal keys', () => {
    const sorted = byDateDesc([e('A', 'X', '2020'), e('B', 'Y', '2020')]);
    expect(sorted.map((x) => x.title)).toEqual(['A', 'B']);
  });

  it('orders runs by minimum rank ascending for relevance', () => {
    const rank = (x) => (Number.isFinite(x._relevanceRank) ? x._relevanceRank : Number.MAX_SAFE_INTEGER);
    const sorted = sortRunAware(
      [
        e('Solo', 'Initech', '2021', { _relevanceRank: 5 }),
        e('Senior Dev', 'Acme', '2024', { _groupId: 'g1', _relevanceRank: 9 }),
        e('Dev', 'Acme', '2019', { _groupId: 'g1', _relevanceRank: 1 }),
      ],
      (run) => Math.min(...run.map(rank)),
      (a, b) => a - b,
    );
    expect(sorted.map((x) => x.company)).toEqual(['Acme', 'Acme', 'Initech']);
  });
});
