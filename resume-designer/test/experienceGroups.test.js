import { describe, it, expect } from 'vitest';
import { groupExperience, assignGroupIds, sortRunAware, datesAreContinuous } from '../src/experienceGroups.js';
import { experienceSortValue } from '../src/store.js';

const e = (title, company, dates, extra = {}) => ({ title, company, dates, bullets: [], ...extra });

// Entry carrying the machine-readable fields the run gate reads.
const g = (title, company, startDate, endDate, extra = {}) => ({
  title,
  company,
  startDate,
  endDate,
  dates: `${startDate} – ${endDate}`,
  bullets: [],
  ...extra,
});

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

  it('ignores a whitespace-only company even when ids match', () => {
    // "   " is truthy, but it prints a blank company header with roles beneath it
    // and no employer named anywhere. It is not an employer.
    const groups = groupExperience([
      e('Senior Dev', '   ', '2022 – 2024', { _groupId: 'g1' }),
      e('Dev', '   ', '2019 – 2022', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.roles.length === 1)).toBe(true);
  });

  it('joins a run across a stray trailing space and prints the trimmed name', () => {
    const groups = groupExperience([
      e('Senior Dev', 'Acme', '2022 – 2024', { _groupId: 'g1' }),
      e('Dev', 'Acme ', '2019 – 2022', { _groupId: 'g1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].roles).toHaveLength(2);
    expect(groups[0].company).toBe('Acme');
  });

  it('returns an empty array for empty or missing input', () => {
    expect(groupExperience([])).toEqual([]);
    expect(groupExperience(undefined)).toEqual([]);
  });

  it('separating the middle role of a 3-role run yields [A] + [B,C], not three singletons (FIX 2)', () => {
    // Mirrors "Separate from company above" on index 1 of [A,B,C] all sharing id
    // 'x': re-id the clicked entry AND every FOLLOWING member of the same run,
    // stopping at the run boundary. Re-idding only the clicked entry (the old,
    // buggy behaviour) breaks A-B (intended) but ALSO B-C (not intended), silently
    // orphaning C into a standalone job.
    const entries = [
      e('A', 'Acme', '2018 – 2020', { _groupId: 'x' }),
      e('B', 'Acme', '2020 – 2022', { _groupId: 'x' }),
      e('C', 'Acme', '2022 – 2024', { _groupId: 'x' }),
    ];
    const index = 1;
    const cur = entries[index];
    const oldId = cur._groupId;
    const freshId = 'fresh-id';
    const next = [...entries];
    next[index] = { ...next[index], _groupId: freshId };
    for (let i = index + 1; i < next.length; i += 1) {
      const entry = next[i];
      if (!oldId || entry._groupId !== oldId || entry.company !== cur.company) break;
      next[i] = { ...entry, _groupId: freshId };
    }

    const groups = groupExperience(next);
    expect(groups).toHaveLength(2);
    expect(groups[0].roles.map((r) => r.entry.title)).toEqual(['A']);
    expect(groups[1].roles.map((r) => r.entry.title)).toEqual(['B', 'C']);
  });
});

describe('datesAreContinuous', () => {
  it('groups an immediate promotion (R4 succession), in either argument order', () => {
    const older = g('Dev', 'Acme', '2019-01', '2022-03');
    const newer = g('Senior Dev', 'Acme', '2022-04', '2024-06');
    expect(datesAreContinuous(newer, older)).toBe(true);
    expect(datesAreContinuous(older, newer)).toBe(true);
  });

  it('groups a same-month handover (R4 overlap by one month)', () => {
    expect(datesAreContinuous(
      g('Senior Dev', 'Acme', '2022-03', '2024-06'),
      g('Dev', 'Acme', '2019-01', '2022-03'),
    )).toBe(true);
  });

  it('groups overlapping concurrent roles at one employer', () => {
    expect(datesAreContinuous(
      g('Engineer', 'Acme', '2020-01', '2023-05'),
      g('Interim Lead', 'Acme', '2021-06', '2022-12'),
    )).toBe(true);
  });

  it('REFUSES the boomerang gap, in either argument order', () => {
    // 33 months elsewhere between two stints: fusing these prints one company
    // header asserting employment that never happened.
    const first = g('Sr Eng', 'Acme', '2015-01', '2018-06');
    const second = g('Staff Eng', 'Acme', '2021-03', 'Present');
    expect(datesAreContinuous(second, first)).toBe(false);
    expect(datesAreContinuous(first, second)).toBe(false);
  });

  it('REFUSES a 2-month gap — the tolerance is exactly 1', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', '2019-01', '2021-06'),
      g('Senior Dev', 'Acme', '2021-09', '2024-01'),
    )).toBe(false);
  });

  it('REFUSES year-only dates (R1)', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', '2019', '2021'),
      g('Senior Dev', 'Acme', '2021', '2024'),
    )).toBe(false);
  });

  it('REFUSES a missing startDate (R1)', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', undefined, '2022-03'),
      g('Senior Dev', 'Acme', '2022-04', '2024-06'),
    )).toBe(false);
    expect(datesAreContinuous(
      g('Dev', 'Acme', '', '2022-03'),
      g('Senior Dev', 'Acme', '2022-04', '2024-06'),
    )).toBe(false);
  });

  it('REFUSES free-text dates (R1)', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', 'January 2019', 'March 2022'),
      g('Senior Dev', 'Acme', 'April 2022', 'Present'),
    )).toBe(false);
  });

  it('REFUSES an open end on the older role (R3)', () => {
    // "Present" copied onto the older stint would otherwise stretch it over the gap.
    expect(datesAreContinuous(
      g('Sr Eng', 'Acme', '2015-01', 'Present'),
      g('Staff Eng', 'Acme', '2021-03', 'Present'),
    )).toBe(false);
  });

  it('REFUSES two open ends with equal starts (R2 — ambiguity fails closed)', () => {
    expect(datesAreContinuous(
      g('Staff Eng', 'Acme', '2021-03', 'Present'),
      g('Architect', 'Acme', '2021-03', 'Present'),
    )).toBe(false);
  });

  it('groups when only the later-start role is open-ended', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', '2019-01', '2022-03'),
      g('Senior Dev', 'Acme', '2022-04', 'Present'),
    )).toBe(true);
  });

  it('REFUSES a reversed range (R1 — nonsense fails closed)', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', '2022-06', '2019-01'),
      g('Senior Dev', 'Acme', '2022-07', '2024-06'),
    )).toBe(false);
  });

  it('accepts a single-digit month and a trailing day', () => {
    expect(datesAreContinuous(
      g('Dev', 'Acme', '2019-1', '2022-3'),
      g('Senior Dev', 'Acme', '2022-04-01', '2024-06'),
    )).toBe(true);
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

  it('mints no id for two adjacent whitespace-only companies', () => {
    const out = assignGroupIds([e('A', '   ', '2022'), e('B', '   ', '2021')], () => 'g1');
    expect(out.every((x) => x._groupId === undefined)).toBe(true);
  });

  it('mints one id across a trailing-space company and leaves the stored strings alone', () => {
    const out = assignGroupIds([e('Senior Dev', 'Acme', '2022 – 2024'), e('Dev', 'Acme ', '2019 – 2022')], () => 'g1');
    expect(out.map((x) => x._groupId)).toEqual(['g1', 'g1']);
    expect(out.map((x) => x.company)).toEqual(['Acme', 'Acme ']);
  });

  it('stays permissive by DEFAULT for dateless entries (complete-document callers)', () => {
    // parser.js, profileMarkdown.js and aiService.js normalize a COMPLETE source
    // document, where a boomerang is genuinely non-adjacent and adjacency alone is
    // correct — and their entries carry no startDate/endDate at all. If the date
    // gate ever became the default, all three would silently stop grouping.
    const out = assignGroupIds(
      [e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024'), e('Dev', 'Acme', 'Jan 2019 – Mar 2022')],
      () => 'g1',
    );
    expect(out.map((x) => x._groupId)).toEqual(['g1', 'g1']);
  });

  it('with the gate, the BOOMERANG is not fused', () => {
    const out = assignGroupIds(
      [g('Staff Eng', 'Acme', '2021-03', 'Present'), g('Sr Eng', 'Acme', '2015-01', '2018-06')],
      () => 'g1',
      datesAreContinuous,
    );
    expect(out[0]._groupId).toBeUndefined();
    expect(out[1]._groupId).toBeUndefined();
  });

  it('with the gate, a promotion IS still grouped', () => {
    const out = assignGroupIds(
      [g('Senior Dev', 'Acme', '2022-04', 'Present'), g('Dev', 'Acme', '2019-01', '2022-03')],
      () => 'g1',
      datesAreContinuous,
    );
    expect(out.map((x) => x._groupId)).toEqual(['g1', 'g1']);
  });

  it('with the gate, three continuous roles share ONE id (order-agnostic)', () => {
    // Emitted oldest-first to prove the verdict does not depend on array order.
    let n = 0;
    const out = assignGroupIds(
      [
        g('Eng', 'Acme', '2015-01', '2018-06'),
        g('Sr Eng', 'Acme', '2018-07', '2021-02'),
        g('Staff Eng', 'Acme', '2021-03', 'Present'),
      ],
      () => `g${++n}`,
      datesAreContinuous,
    );
    expect(out.map((x) => x._groupId)).toEqual(['g1', 'g1', 'g1']);
  });

  it('with the gate, a tenure boundary mid-run ends the run there', () => {
    let n = 0;
    const out = assignGroupIds(
      [
        g('Staff Eng', 'Acme', '2021-03', 'Present'),
        g('Sr Eng', 'Acme', '2019-01', '2021-02'),
        g('Eng', 'Acme', '2014-01', '2016-06'),
      ],
      () => `g${++n}`,
      datesAreContinuous,
    );
    expect(out[0]._groupId).toBe('g1');
    expect(out[1]._groupId).toBe('g1');
    expect(out[2]._groupId).toBeUndefined();
  });

  it('with the gate, two stints of two roles each get two DISTINCT ids', () => {
    // The capability-preserving case: both tenures are correctly grouped, and the
    // ids are fresh per tenure so the renderer can never fuse them.
    let n = 0;
    const out = assignGroupIds(
      [
        g('Staff Eng', 'Acme', '2021-03', 'Present'),
        g('Sr Eng', 'Acme', '2019-06', '2021-02'),
        g('Eng', 'Acme', '2014-01', '2016-06'),
        g('Jr Eng', 'Acme', '2012-01', '2013-12'),
      ],
      () => `g${++n}`,
      datesAreContinuous,
    );
    expect(out[0]._groupId).toBe('g1');
    expect(out[1]._groupId).toBe('g1');
    expect(out[2]._groupId).toBe('g2');
    expect(out[3]._groupId).toBe('g2');
    expect(out[0]._groupId).not.toBe(out[2]._groupId);
  });

  it('with the gate, a single role at an employer gets no id', () => {
    const out = assignGroupIds(
      [g('Staff Eng', 'Acme', '2021-03', 'Present'), g('Consultant', 'Initech', '2019-01', '2021-02')],
      () => 'g1',
      datesAreContinuous,
    );
    expect(out.every((x) => x._groupId === undefined)).toBe(true);
  });

  it('with the gate, an intervening employer still breaks the run', () => {
    const out = assignGroupIds(
      [
        g('Senior Dev', 'Acme', '2022-04', 'Present'),
        g('Consultant', 'Initech', '2022-04', '2022-04'),
        g('Dev', 'Acme', '2019-01', '2022-03'),
      ],
      () => 'g1',
      datesAreContinuous,
    );
    expect(out.every((x) => x._groupId === undefined)).toBe(true);
  });
});

describe('sortRunAware', () => {
  const byDateDesc = (entries) =>
    sortRunAware(entries, (run) => Math.max(...run.map(experienceSortValue)), (a, b) => b - a);

  it('keeps a run intact instead of interleaving a foreign employer', () => {
    // The two Acme roles must be ADJACENT so they form a real run — otherwise the
    // run rule makes them three separate runs of one and this asserts nothing but
    // an ordinary date sort. Initech's 2023 falls strictly between the run's two
    // end dates, so a naive sort would produce Acme, Initech, Acme.
    const input = [
      e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
      e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
      e('Consultant', 'Initech', 'Jan 2023 – Dec 2023'),
    ];
    // Guard the guard: prove the naive sort really does interleave, so this test
    // cannot silently degrade into a tautology again.
    const naive = [...input].sort((a, b) => experienceSortValue(b) - experienceSortValue(a));
    expect(naive.map((x) => x.company)).toEqual(['Acme', 'Initech', 'Acme']);

    expect(byDateDesc(input).map((x) => x.company)).toEqual(['Acme', 'Acme', 'Initech']);
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

describe('generation ordering + grouping (buildResumeData contract)', () => {
  it('mints ids from adjacency GATED on date continuity, then sorts run-aware', () => {
    // sortRunAware only respects an EXISTING _groupId. Fresh AI output has none, so
    // assignGroupIds must run first, against the AI's own raw order, to detect the
    // Acme run from adjacency — only then can sortRunAware reorder chronologically
    // without splitting it apart. The shipped call passes datesAreContinuous, so
    // this must too or it stops describing the shipped path.
    const raw = [
      { title: 'Consultant', company: 'Initech', startDate: '2021-01', endDate: '2022-02', dates: '2021 – 2022', bullets: [], _relevanceRank: 0 },
      { title: 'Senior Dev', company: 'Acme', startDate: '2022-03', endDate: '2024-06', dates: 'Mar 2022 – Jun 2024', bullets: [], _relevanceRank: 1 },
      { title: 'Dev', company: 'Acme', startDate: '2019-01', endDate: '2022-03', dates: 'Jan 2019 – Mar 2022', bullets: [], _relevanceRank: 2 },
    ];
    let n = 0;
    const grouped = assignGroupIds(raw, () => `g${++n}`, datesAreContinuous);
    const sorted = sortRunAware(grouped, (run) => Math.max(...run.map(experienceSortValue)), (a, b) => b - a);

    expect(sorted.map((x) => x.title)).toEqual(['Senior Dev', 'Dev', 'Consultant']);
    expect(sorted[0]._groupId).toBe('g1');
    expect(sorted[1]._groupId).toBe('g1');
    expect(sorted[2]._groupId).toBeUndefined();
  });

  it('mints no id from adjacency alone when the two Acme stints are gapped', () => {
    // Same shape, but the AI omitted the job held between the two Acme stints
    // because it was irrelevant to the target role. Adjacency now says "one
    // employer, two roles"; the dates say two tenures. No id may be minted.
    const raw = [
      { title: 'Consultant', company: 'Initech', startDate: '2019-01', endDate: '2020-02', dates: '2019 – 2020', bullets: [], _relevanceRank: 0 },
      { title: 'Staff Eng', company: 'Acme', startDate: '2021-03', endDate: 'Present', dates: 'Mar 2021 – Present', bullets: [], _relevanceRank: 1 },
      { title: 'Sr Eng', company: 'Acme', startDate: '2015-01', endDate: '2018-06', dates: 'Jan 2015 – Jun 2018', bullets: [], _relevanceRank: 2 },
    ];
    let n = 0;
    const grouped = assignGroupIds(raw, () => `g${++n}`, datesAreContinuous);
    const sorted = sortRunAware(grouped, (run) => Math.max(...run.map(experienceSortValue)), (a, b) => b - a);

    expect(sorted.every((x) => x._groupId === undefined)).toBe(true);
    expect(groupExperience(sorted).map((grp) => grp.roles.length)).toEqual([1, 1, 1]);
  });
});
