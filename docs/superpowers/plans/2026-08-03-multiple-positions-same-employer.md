# Multiple Positions at the Same Employer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one employer hold several positions — promotions, lateral moves, non-contiguous return stints, and concurrent overlapping roles — and render them as a company header with individually-dated roles beneath, while a job with only one role renders exactly as it does today.

**Architecture:** `experience[]` stays a flat array and gains one optional `_groupId` field. A *run* is a maximal set of consecutive entries sharing that id **and** the same `company`. Grouping happens at render time in a single shared helper consumed by all 11 layouts — there is no DOM wrapper element; run members stay sibling `.experience-item` nodes with marker classes, and the nesting you see is CSS indentation. The AI-addressable path grammar (`experience[2].bullets[0]`) is completely unchanged, so no prompt, schema, or path regex moves, and there is no data migration.

**Tech Stack:** React 19, Vite, plain JavaScript (no TypeScript), Tailwind 3 + shadcn/ui, vitest + jsdom, Tauri 2 (WKWebView).

Source spec: [`docs/superpowers/specs/2026-08-03-multiple-positions-same-employer-design.md`](../specs/2026-08-03-multiple-positions-same-employer-design.md)

## Global Constraints

- **Never commit, push, or open a PR without being explicitly asked.** Each task below ends with a commit step; run it only when the human has approved that task.
- **Conventional commits, subject starts lowercase.** commitlint runs in CI on *every* commit in a PR. `fix(chat): …` is valid; `Fix(chat): …` and `fix(chat): Add …` are not.
- **Brand name is "On Paper"** — two words, title case, in all prose and display copy. Never `OnPaper`, `On paper`, `On-Paper`.
- **Never rename** the bundle identifier `com.resumedesigner.app`, any `resume-designer-*` storage key, the `resume-designer/` directory, or `name = "resume-designer"` in `src-tauri/Cargo.toml`.
- **Never sweep on the bare string `resume-`** — it also names the `.resume-page` / `.resume-sidebar` CSS classes that pagination and PDF page-splitting depend on.
- **The path grammar must not change.** `experience[i].title`, `experience[i].company`, `experience[i].dates`, `experience[i].bullets[j]` keep their exact meanings. No task may introduce `experience[i].roles[...]`.
- **`_groupId` is underscore-prefixed and that is load-bearing.** `diffResumeData` skips `key.startsWith('_')` (`src/diffEngine.js:104`), which is what keeps grouping out of the diff UI and out of AI tailoring. Never rename it to `groupId`.
- **Group ids are minted fresh per tenure and never reused.**
- **All work happens under `resume-designer/`.** All commands below are run from that directory.
- **vitest is blind to `src/components/**`** — `vitest.config.js` includes only `test/**/*.test.js` and there is no `@testing-library`. Any task touching a `.jsx` file must run `npx vite build` as its verification, because a green test suite proves nothing there.

**Two existing suites were checked for collisions and are clear:** `test/rendererLayouts.test.js` makes no assertion about experience markup, so Task 2 does not touch it; `test/experienceSort.test.js` covers only the pure `experienceSortValue` function, which Task 5 leaves unchanged (only its *callers* move). If either goes red, the change went further than intended — stop and re-read the diff rather than editing the test.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `src/experienceGroups.js` | The only place the run rule lives: `groupExperience`, `assignGroupIds`, `sortRunAware`. Framework-free, no DOM. |
| `test/experienceGroups.test.js` | Unit tests for the run rule, covering all four scoped cases. |
| `test/renderExperience.test.js` | Asserts the grouped/ungrouped HTML contract the CSS and pagination depend on. |
| `test/parser.test.js` | First ever coverage of `src/parser.js` — round trip plus import-time grouping. |
| `test/profileMarkdown.test.js` | First ever coverage of the profile markdown grammar and prompt serializer. |

**Modified files:**

| File | Change |
|---|---|
| `src/renderer.js` | One shared `renderExperienceEntries()`; 10 identical call sites collapse into it; timeline variant made group-aware. |
| `styles/resume.css` | `.is-grouped` / `.is-group-lead` / `.experience-group-header` rules. |
| `styles/print.css` | `break-after: avoid` on the group header, in both blocks. |
| `src/pagination.js` | One added head selector; the continuation-page reveal pass. |
| `src/store.js` | `experienceSortValue` is reused as-is; no change. Only `applySort`'s *caller* changes. |
| `src/components/structure/StructurePanel.jsx` | Run-aware sort; the link/separate/add-role actions; the grouping rail. |
| `src/onboardingLogic.js` | Run-aware post-generation sort; mint `_groupId` for generated runs. |
| `src/inlineEditor.js` | `startEditing` type guard; `finishEditing` group-rename branch. |
| `src/parser.js` | Entry `id`; date-line fix. |
| `src/persistence.js` | Markdown writer/reader symmetry; import-time grouping. |
| `src/diffEngine.js` | Three added `getPathLabel` entries. |
| `src/aiService.js` | Grouped profile serialization in both prompt builders. |
| `src/profileMarkdown.js` | Import-time grouping for profile entries. |
| `src/components/profile/ProfileTabs.jsx` | Profile link/separate/add-role actions and rail; stable entry keys. |

---

### Task 1: The grouping helper

The single source of truth for the run rule. Everything downstream — renderer, sorting, import, generation — calls into this module, so a change to the rule is a change in one file.

**Files:**
- Create: `resume-designer/src/experienceGroups.js`
- Test: `resume-designer/test/experienceGroups.test.js`

**Interfaces:**
- Consumes: `generateId` from `src/store.js` (exported at `store.js:25`, signature `generateId(prefix = 'item') -> string`).
- Produces:
  - `groupExperience(entries) -> Array<{ groupId: string|null, company: string, roles: Array<{ entry: object, index: number }> }>` — `index` is the entry's index in the original flat array and is what every `data-editable` path is built from.
  - `assignGroupIds(entries, makeId = () => generateId('grp')) -> Array<object>` — returns a new array of shallow-copied entries, minting one fresh id per run of 2+ consecutive entries with an identical non-empty company. Entries already carrying `_groupId` are left alone.
  - `sortRunAware(entries, runKey, compare) -> Array<object>` — partitions into runs, orders the runs, preserves member order inside each, flattens.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/experienceGroups.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/experienceGroups.test.js`
Expected: FAIL — `Failed to resolve import "../src/experienceGroups.js"`.

- [ ] **Step 3: Write the implementation**

Create `resume-designer/src/experienceGroups.js`:

```js
/**
 * Experience grouping — the single source of truth for the "one employer, several
 * positions" run rule. Framework-free, no DOM, no side effects.
 *
 * A RUN is a maximal set of CONSECUTIVE entries sharing the same non-empty
 * `_groupId` AND the same non-empty `company`.
 *
 * Both halves are load-bearing:
 *  - Ids are minted fresh per tenure and never reused, so deleting or reordering
 *    the entry between two boomerang stints can never fuse them into one
 *    fabricated tenure.
 *  - Company equality is the anti-corruption rule. changeApply has no insert
 *    primitive, so an AI asked to insert a role performs a positional
 *    shift-rewrite that leaves the id on the index while replacing the content.
 *    Equality makes that entry drop out of the run visibly, rather than pulling a
 *    foreign employer under the company header.
 */

import { generateId } from './store.js';

/**
 * Partition a flat experience array into company runs.
 * @param {Array<object>} entries
 * @returns {Array<{ groupId: string|null, company: string, roles: Array<{ entry: object, index: number }> }>}
 */
export function groupExperience(entries) {
  const groups = [];
  let current = null;

  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const groupId = entry && entry._groupId ? entry._groupId : null;
    const company = entry && entry.company ? entry.company : '';
    const joins = current && groupId && company
      && current.groupId === groupId
      && current.company === company;

    if (joins) {
      current.roles.push({ entry, index });
    } else {
      current = { groupId, company, roles: [{ entry, index }] };
      groups.push(current);
    }
  });

  return groups;
}

/**
 * Mint one fresh `_groupId` per run of 2+ consecutive entries with an identical
 * non-empty company. Used by markdown import and by AI generation, so those paths
 * and the renderer agree on grouping by construction.
 *
 * Returns a NEW array of shallow-copied entries; the input is never mutated.
 * Entries that already carry a `_groupId` keep it.
 *
 * @param {Array<object>} entries
 * @param {() => string} [makeId]
 * @returns {Array<object>}
 */
export function assignGroupIds(entries, makeId = () => generateId('grp')) {
  const out = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));

  let i = 0;
  while (i < out.length) {
    const company = out[i].company;
    let j = i + 1;
    if (company) {
      while (j < out.length && out[j].company === company) j += 1;
    }
    if (company && j - i > 1) {
      const existing = out.slice(i, j).find((x) => x._groupId);
      const id = existing ? existing._groupId : makeId();
      for (let k = i; k < j; k += 1) {
        if (!out[k]._groupId) out[k]._groupId = id;
      }
    }
    i = j;
  }

  return out;
}

/**
 * Reorder experience entries WITHOUT shredding runs: partition into runs, order
 * the runs, preserve member order inside each, flatten.
 *
 * Every reordering path must go through this. Both shipped sort modes otherwise
 * interleave a foreign employer into a run, which silently drops the company
 * header from the preview and the PDF — and because applySort('custom') is a
 * no-op, the shredded order becomes the saved data with no way back.
 *
 * @param {Array<object>} entries
 * @param {(run: Array<object>) => number} runKey  Sort key for a whole run.
 * @param {(a: number, b: number) => number} compare
 * @returns {Array<object>} a new array
 */
export function sortRunAware(entries, runKey, compare) {
  const runs = groupExperience(entries).map((group) => group.roles.map((role) => role.entry));
  const decorated = runs.map((run, i) => ({ run, i, key: runKey(run) }));
  // Index tiebreak keeps the sort stable for equal keys.
  decorated.sort((a, b) => compare(a.key, b.key) || a.i - b.i);
  return decorated.flatMap((d) => d.run);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/experienceGroups.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `npm run test`
Expected: PASS. Note the new file's import of `generateId` pulls in `src/store.js`; if that surfaces an unrelated failure, stop and report rather than editing `store.js`.

- [ ] **Step 6: Commit**

```bash
git add src/experienceGroups.js test/experienceGroups.test.js
git commit -m "feat(experience): add the company-run grouping helper"
```

---

### Task 2: Render grouped roles

Turn the run rule into markup and CSS. This is where the single-role case must stay byte-identical to today, because that is what makes the feature free for existing résumés.

**Files:**
- Modify: `resume-designer/src/renderer.js` (`renderExperience` at `:598`, `renderTimelineExperience` at `:1080`, and the 11 call sites listed below)
- Modify: `resume-designer/styles/resume.css` (after the `.experience-item:last-child` rule at `:415-419`)
- Test: `resume-designer/test/renderExperience.test.js`

**Interfaces:**
- Consumes: `groupExperience` from `src/experienceGroups.js` (Task 1).
- Produces: `renderExperienceEntries(experience, variant) -> string`, exported from `src/renderer.js`. `variant` is `'default'` or `'timeline'`. Task 3 (pagination) and Task 4 (reveal pass) depend on the exact class names and DOM order this emits.

**The DOM contract this task establishes** — Tasks 3, 4 and 8 all rely on it:

- A run of **one** renders exactly today's markup: `<article class="experience-item">` with no marker classes and no group header.
- A run of **2+**: every member gets `.is-grouped`; the first also gets `.is-group-lead` and carries a **first-child** `<div class="experience-group-header">`.
- The group header carries `data-editable="experience[L].company"` where `L` is the lead's index — a real leaf path that resolves to a string — plus `data-editable-group="L,M,N"` listing every run member index. The group attribute is DOM metadata, never a store path.
- Grouped roles keep their own `.experience-company` element **in the DOM but without `data-editable`**, so Tab cannot focus an invisible target and Task 4 has something to reveal.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/renderExperience.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { renderExperienceEntries } from '../src/renderer.js';

const e = (title, company, dates, extra = {}) => ({ title, company, dates, bullets: ['did a thing'], ...extra });

const parse = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

describe('renderExperienceEntries — ungrouped', () => {
  it('renders a solo entry with no marker classes and no group header', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')]));
    const item = host.querySelector('.experience-item');
    expect(item.classList.contains('is-grouped')).toBe(false);
    expect(item.classList.contains('is-group-lead')).toBe(false);
    expect(host.querySelector('.experience-group-header')).toBeNull();
  });

  it('keeps the company editable on a solo entry', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')]));
    expect(host.querySelector('.experience-company').dataset.editable).toBe('experience[0].company');
  });

  it('addresses bullets by the flat path grammar', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')]));
    expect(host.querySelector('.experience-bullets li').dataset.editable).toBe('experience[0].bullets[0]');
  });
});

describe('renderExperienceEntries — grouped', () => {
  const twoRoles = [
    e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
    e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
  ];

  it('emits sibling .experience-item nodes with no wrapper element', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    expect(host.querySelectorAll(':scope > .experience-item')).toHaveLength(2);
    expect(host.querySelector('.experience-group')).toBeNull();
  });

  it('marks the lead and every member', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const items = host.querySelectorAll('.experience-item');
    expect(items[0].classList.contains('is-group-lead')).toBe(true);
    expect(items[0].classList.contains('is-grouped')).toBe(true);
    expect(items[1].classList.contains('is-group-lead')).toBe(false);
    expect(items[1].classList.contains('is-grouped')).toBe(true);
  });

  it('puts the group header FIRST inside the lead item (pagination head order)', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const lead = host.querySelector('.experience-item');
    expect(lead.firstElementChild.className).toBe('experience-group-header');
    expect(lead.firstElementChild.textContent.trim()).toBe('Acme');
  });

  it('points the header at a real leaf path and lists the run indices', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const header = host.querySelector('.experience-group-header');
    expect(header.dataset.editable).toBe('experience[0].company');
    expect(header.dataset.editableGroup).toBe('0,1');
  });

  it('keeps each role company in the DOM but NOT editable', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const companies = host.querySelectorAll('.experience-item .experience-company');
    expect(companies).toHaveLength(2);
    companies.forEach((node) => expect(node.dataset.editable).toBeUndefined());
  });

  it('leaves per-role titles, dates and bullets on their own flat paths', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const items = host.querySelectorAll('.experience-item');
    expect(items[1].querySelector('.experience-title').dataset.editable).toBe('experience[1].title');
    expect(items[1].querySelector('.experience-dates').dataset.editable).toBe('experience[1].dates');
    expect(items[1].querySelector('li').dataset.editable).toBe('experience[1].bullets[0]');
  });

  it('renders a solo entry that follows a run without marker classes', () => {
    const host = parse(renderExperienceEntries([...twoRoles, e('Intern', 'Initech', '2018')]));
    const items = host.querySelectorAll('.experience-item');
    expect(items[2].classList.contains('is-grouped')).toBe(false);
    expect(items[2].querySelector('.experience-company').dataset.editable).toBe('experience[2].company');
  });
});

describe('renderExperienceEntries — timeline variant', () => {
  it('emits .timeline-item siblings and a group header on the lead', () => {
    const host = parse(renderExperienceEntries([
      e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
      e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
    ], 'timeline'));
    expect(host.querySelectorAll(':scope > .timeline-item')).toHaveLength(2);
    expect(host.querySelector('.timeline-item .experience-group-header')).not.toBeNull();
  });

  it('renders a solo timeline entry unchanged', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')], 'timeline'));
    expect(host.querySelector('.timeline-item').classList.contains('is-grouped')).toBe(false);
    expect(host.querySelector('.experience-group-header')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderExperience.test.js`
Expected: FAIL — `renderExperienceEntries is not a function` (it is not exported yet).

- [ ] **Step 3: Replace `renderExperience` and add the shared entry point**

In `resume-designer/src/renderer.js`, add the import at the top of the file, directly under the existing header comment block:

```js
import { groupExperience } from './experienceGroups.js';
```

Then replace the whole of `renderExperience` (currently `:598-615`) with:

```js
/**
 * Render every experience entry, grouping consecutive roles at one employer.
 *
 * There is deliberately NO wrapper element around a run. Run members stay sibling
 * .experience-item nodes so that pagination's direct-child itemSel keeps matching
 * them, :last-child still finds the real last entry, the timeline marker gutter
 * keeps its geometry, and the Structure panel's drag indices stay 1:1 with the
 * array. The nesting the reader sees is CSS indentation on .is-grouped.
 *
 * @param {Array<object>} experience
 * @param {'default'|'timeline'} variant
 * @returns {string} HTML
 */
export function renderExperienceEntries(experience, variant = 'default') {
  return groupExperience(experience)
    .map((group) => group.roles
      .map((role, position) => (variant === 'timeline'
        ? renderTimelineExperience(role.entry, role.index, group, position === 0)
        : renderExperience(role.entry, role.index, group, position === 0)))
      .join(''))
    .join('');
}

// The company header for a run. Placed as the FIRST child of the lead
// .experience-item so pagination treats it as part of that entry's head, and so
// print CSS can keep it with the role that follows.
//
// data-editable points at a real leaf (the lead's company string) — never a
// container path, which startEditing would stringify into '[object Object]'.
// data-editable-group is DOM metadata listing the run's indices; finishEditing
// uses it to fan a rename out across the run in ONE store write. It is not a
// store path, so the AI-addressable path grammar is unchanged.
function renderGroupHeader(group) {
  const indices = group.roles.map((role) => role.index);
  return `<div class="experience-group-header" data-editable="experience[${indices[0]}].company" data-editable-group="${indices.join(',')}">${escapeHtml(group.company)}</div>`;
}

function renderExperience(exp, index, group = null, isLead = false) {
  const grouped = !!group && group.roles.length > 1;
  const classes = ['experience-item'];
  if (grouped) {
    classes.push('is-grouped');
    if (isLead) classes.push('is-group-lead');
  }
  return `
    <article class="${classes.join(' ')}" data-experience-id="${exp.id || index}">
      ${grouped && isLead ? renderGroupHeader(group) : ''}
      <div class="experience-header">
        <h3 class="experience-title" data-editable="experience[${index}].title">${escapeHtml(exp.title)}</h3>
        ${exp.company ? `<span class="experience-company"${grouped ? '' : ` data-editable="experience[${index}].company"`}>${escapeHtml(exp.company)}</span>` : ''}
      </div>
      <time class="experience-dates" data-editable="experience[${index}].dates">${escapeHtml(exp.dates)}</time>
      ${exp.bullets && exp.bullets.length > 0 ? `
        <ul class="experience-bullets">
          ${exp.bullets.map((bullet, i) => `
            <li data-editable="experience[${index}].bullets[${i}]">${formatBullet(bullet)}</li>
          `).join('')}
        </ul>
      ` : ''}
    </article>
  `;
}
```

- [ ] **Step 4: Make the timeline renderer group-aware**

Replace the whole of `renderTimelineExperience` (currently `:1080-1105`) with:

```js
// Timeline experience renderer with visual timeline
function renderTimelineExperience(exp, index, group = null, isLead = false) {
  const grouped = !!group && group.roles.length > 1;
  const classes = ['timeline-item'];
  if (grouped) {
    classes.push('is-grouped');
    if (isLead) classes.push('is-group-lead');
  }
  return `
    <div class="${classes.join(' ')}" data-experience-id="${exp.id || index}">
      <div class="timeline-marker">
        <span class="timeline-dot"></span>
        <span class="timeline-line"></span>
      </div>
      <div class="timeline-content">
        ${grouped && isLead ? renderGroupHeader(group) : ''}
        <div class="experience-header">
          <div class="experience-title-row">
            <span class="experience-title" data-editable="experience[${index}].title">${escapeHtml(exp.title)}</span>
            ${exp.company ? `<span class="experience-company"${grouped ? '' : ` data-editable="experience[${index}].company"`}>${escapeHtml(exp.company)}</span>` : ''}
          </div>
          <span class="experience-dates" data-editable="experience[${index}].dates">${escapeHtml(exp.dates)}</span>
        </div>
        ${exp.bullets && exp.bullets.length > 0 ? `
          <ul class="experience-bullets">
            ${exp.bullets.map((bullet, bIdx) => `
              <li data-editable="experience[${index}].bullets[${bIdx}]">${formatBullet(bullet)}</li>
            `).join('')}
          </ul>
        ` : ''}
      </div>
    </div>
  `;
}
```

Note the timeline test asserts the group header is inside `.timeline-item`; it is nested one level deeper, inside `.timeline-content`, which the `.timeline-item .experience-group-header` descendant selector matches.

- [ ] **Step 5: Point all 11 call sites at the shared helper**

There are 10 byte-identical default call sites (`renderer.js` lines 278, 323, 367, 674, 723, 786, 834, 910, 1008, 1149). Replace every occurrence of:

```js
${data.experience.map((exp, i) => renderExperience(exp, i)).join('')}
```

with:

```js
${renderExperienceEntries(data.experience)}
```

And the single timeline call site (line 1055). Replace:

```js
${data.experience.map((exp, i) => renderTimelineExperience(exp, i)).join('')}
```

with:

```js
${renderExperienceEntries(data.experience, 'timeline')}
```

- [ ] **Step 6: Verify no call site was missed**

Run: `grep -n "renderExperience(exp, i)\|renderTimelineExperience(exp, i)" src/renderer.js`
Expected: no output. A missed layout silently renders the old flat shape, which no test would catch.

- [ ] **Step 7: Add the CSS**

In `resume-designer/styles/resume.css`, immediately after the `.experience-item:last-child` block (`:415-419`), add:

```css
/* --- Grouped roles (one employer, several positions) ---------------------- */

/* The employer name, shown once above the run. */
.experience-group-header {
  font-weight: 600;
  color: var(--resume-heading, inherit);
  margin-bottom: 0.3rem;
}

/* Run members indent under the header so the progression reads as one job. */
.is-grouped .experience-header,
.is-grouped .experience-dates,
.is-grouped .experience-bullets {
  margin-left: 0.85rem;
}

/* The per-role company stays in the DOM for the continuation-page reveal
   (see src/pagination.js revealGroupContinuations) but is hidden in normal flow. */
.is-grouped .experience-company {
  display: none;
}
.is-grouped .experience-company.is-continuation {
  display: inline;
}

/* A divider between two roles at the SAME employer is exactly the visual this
   feature exists to remove: the run should read as one job. Only the last member
   of a run keeps the entry separator. */
.experience-item.is-grouped:not(:last-child) {
  margin-bottom: 0.3rem;
  padding-bottom: 0;
  border-bottom: none;
}

/* The header must not be separated from the role it introduces. */
.experience-group-header {
  break-after: avoid;
  page-break-after: avoid;
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/renderExperience.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 9: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS. The build is what proves `renderer.js` still parses — vitest only exercises the functions the tests import.

- [ ] **Step 10: Commit**

```bash
git add src/renderer.js styles/resume.css test/renderExperience.test.js
git commit -m "feat(experience): render consecutive roles under one company header"
```

---

### Task 3: Teach pagination about the group header

The single highest-risk change in the plan. `splittableConfig`'s `itemSel` is a **silent whitelist**: `buildColumnRecursive` keeps only heads and `itemSel` matches, and `paginateTwo` finishes with `resumeEl.replaceChildren(pages)`. Anything unmatched is deleted from the output. Because `continuous` is the default page size and does not restructure, a mistake here is invisible in development and only destroys content once a user selects Letter or A4.

**Files:**
- Modify: `resume-designer/src/pagination.js:112-114` (the `.experience-item` branch of `splittableConfig`)
- Test: `resume-designer/test/pagination.test.js` (append a new `describe` block)

**Interfaces:**
- Consumes: the DOM contract from Task 2 — `.experience-group-header` as the first child of a `.experience-item` or `.timeline-content`.
- Produces: no new exports. Guarantees that every `data-experience-id` present before pagination is present after it.

- [ ] **Step 1: Write the failing test**

Append to `resume-designer/test/pagination.test.js`:

```js
describe('buildColumnRecursive — grouped experience survives pagination', () => {
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  };

  // One solo entry plus a two-role run — the mix is the point: a whitelist bug
  // drops only the grouped members, so a run-only fixture can pass while real
  // resumes lose jobs.
  const buildExperienceSection = () => {
    const section = el('div', 'experience-section');
    section.appendChild(el('div', 'section-title', 'Experience'));

    const makeItem = (id, cls, withHeader) => {
      const item = el('article', cls);
      item.dataset.experienceId = id;
      if (withHeader) item.appendChild(el('div', 'experience-group-header', 'Acme Corporation'));
      const header = el('div', 'experience-header');
      header.appendChild(el('h3', 'experience-title', id));
      item.appendChild(header);
      item.appendChild(el('time', 'experience-dates', '2020 – 2024'));
      const ul = el('ul', 'experience-bullets');
      ul.appendChild(el('li', null, 'a bullet'));
      item.appendChild(ul);
      return item;
    };

    section.appendChild(makeItem('exp-lead', 'experience-item is-grouped is-group-lead', true));
    section.appendChild(makeItem('exp-second', 'experience-item is-grouped', false));
    section.appendChild(makeItem('exp-solo', 'experience-item', false));
    return section;
  };

  const rebuild = (section) => {
    const node = makeNode(section);
    const units = [];
    flatten(node, [], units);
    const seen = new Set();
    for (const u of units) {
      u.firstOf = [];
      for (const g of u.chain) if (!seen.has(g)) { seen.add(g); u.firstOf.push(g); }
    }
    const target = document.createElement('div');
    buildColumnRecursive(target, units);
    return target;
  };

  it('keeps every experience entry after a rebuild', () => {
    const target = rebuild(buildExperienceSection());
    const ids = [...target.querySelectorAll('[data-experience-id]')].map((n) => n.dataset.experienceId);
    expect(ids).toEqual(['exp-lead', 'exp-second', 'exp-solo']);
  });

  it('keeps the company header, above the lead role', () => {
    const target = rebuild(buildExperienceSection());
    const header = target.querySelector('.experience-group-header');
    expect(header).not.toBeNull();
    expect(header.textContent).toBe('Acme Corporation');
    const lead = target.querySelector('[data-experience-id="exp-lead"]');
    expect(lead.contains(header)).toBe(true);
    expect(lead.firstElementChild.className).toBe('experience-group-header');
  });

  it('keeps every bullet', () => {
    const target = rebuild(buildExperienceSection());
    expect(target.querySelectorAll('.experience-bullets li')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pagination.test.js -t "grouped experience"`
Expected: FAIL on the header test — the header is not in the `.experience-item` branch's `head` list, so `buildColumnRecursive` drops it.

- [ ] **Step 3: Add the head selector**

In `resume-designer/src/pagination.js`, change the `.experience-item` branch of `splittableConfig` (currently `:112-114`) from:

```js
  if (el.classList.contains('experience-item')) {
    return { head: [':scope > .experience-header', ':scope > .experience-dates'],
             itemWrap: ':scope > .experience-bullets', itemSel: ':scope > li' };
  }
```

to:

```js
  if (el.classList.contains('experience-item')) {
    // The group header rides FIRST in the head list so a rebuilt page reproduces
    // it above the role it introduces. `head` is also a whitelist — a direct child
    // that is neither a head nor an itemSel match is dropped by
    // buildColumnRecursive and lost at resumeEl.replaceChildren.
    return { head: [':scope > .experience-group-header', ':scope > .experience-header', ':scope > .experience-dates'],
             itemWrap: ':scope > .experience-bullets', itemSel: ':scope > li' };
  }
```

Neither `.experience-section` `itemSel` arm changes, and no `.experience-group` branch is added — run members are still direct `.experience-item` children, which is exactly why no other selector needs to move.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pagination.test.js`
Expected: PASS — the three new tests plus every pre-existing pagination test.

- [ ] **Step 5: Run the full suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pagination.js test/pagination.test.js
git commit -m "fix(pagination): keep the company header when rebuilding pages"
```

---

### Task 4: Repeat the employer name on continuation pages

Today every entry carries its own `.experience-company` through a page break. Task 2 hides it on grouped roles, so without this task a run split across pages leaves page 2 showing indented roles with no employer — a strict regression on exactly the multi-page résumés this feature targets.

**Files:**
- Modify: `resume-designer/src/pagination.js` (add `revealGroupContinuations`, call it after pages are built)
- Modify: `resume-designer/styles/print.css` (both blocks)
- Test: `resume-designer/test/pagination.test.js` (append)

**Interfaces:**
- Consumes: the `.is-grouped .experience-company` element and the `.is-continuation` class hook from Task 2's CSS.
- Produces: `revealGroupContinuations(pages) -> void`, exported from `src/pagination.js`. Takes an array of page elements, mutates them in place.

- [ ] **Step 1: Find the call site**

Run: `grep -n "replaceChildren(pages)\|function paginateTwo\|function paginateContinuous" src/pagination.js`
Expected: the line numbers for the paginated path. Note them — Step 4 inserts the call immediately before `replaceChildren`.

- [ ] **Step 2: Write the failing test**

Append to `resume-designer/test/pagination.test.js`:

```js
describe('revealGroupContinuations', () => {
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  };

  // A grouped role as it appears after Task 2's renderer: company present but hidden.
  const groupedRole = (id, withHeader) => {
    const item = el('article', withHeader ? 'experience-item is-grouped is-group-lead' : 'experience-item is-grouped');
    item.dataset.experienceId = id;
    if (withHeader) item.appendChild(el('div', 'experience-group-header', 'Acme Corporation'));
    const header = el('div', 'experience-header');
    header.appendChild(el('h3', 'experience-title', id));
    header.appendChild(el('span', 'experience-company', 'Acme Corporation'));
    item.appendChild(header);
    return item;
  };

  const page = (...children) => {
    const p = el('div', 'resume-page');
    children.forEach((c) => p.appendChild(c));
    return p;
  };

  it('reveals the company on a grouped role that starts a later page', () => {
    const p1 = page(groupedRole('r1', true));
    const p2 = page(groupedRole('r2', false));
    revealGroupContinuations([p1, p2]);
    expect(p2.querySelector('.experience-company').classList.contains('is-continuation')).toBe(true);
  });

  it('does not reveal anything on the page that already has the header', () => {
    const p1 = page(groupedRole('r1', true), groupedRole('r2', false));
    revealGroupContinuations([p1]);
    expect(p1.querySelectorAll('.experience-company.is-continuation')).toHaveLength(0);
  });

  it('reveals only the FIRST grouped role on a continuation page', () => {
    const p1 = page(groupedRole('r1', true));
    const p2 = page(groupedRole('r2', false), groupedRole('r3', false));
    revealGroupContinuations([p1, p2]);
    expect(p2.querySelectorAll('.experience-company.is-continuation')).toHaveLength(1);
    expect(p2.querySelector('.experience-company.is-continuation').closest('[data-experience-id]').dataset.experienceId)
      .toBe('r2');
  });

  it('leaves ungrouped entries alone', () => {
    const solo = el('article', 'experience-item');
    solo.dataset.experienceId = 'solo';
    const header = el('div', 'experience-header');
    header.appendChild(el('span', 'experience-company', 'Initech'));
    solo.appendChild(header);
    const p2 = page(solo);
    revealGroupContinuations([page(), p2]);
    expect(p2.querySelectorAll('.is-continuation')).toHaveLength(0);
  });

  it('is a no-op for a single page', () => {
    const p1 = page(groupedRole('r1', true), groupedRole('r2', false));
    revealGroupContinuations([p1]);
    expect(p1.querySelectorAll('.is-continuation')).toHaveLength(0);
  });
});
```

Add `revealGroupContinuations` to the existing import at the top of `test/pagination.test.js`:

```js
import {
  assignBlocksToPages, overflowingPages, makeNode, flatten, buildColumnRecursive,
  revealGroupContinuations,
} from '../src/pagination.js';
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pagination.test.js -t "revealGroupContinuations"`
Expected: FAIL — `revealGroupContinuations is not a function`.

- [ ] **Step 4: Implement the reveal pass**

Add to `resume-designer/src/pagination.js`, next to the other exported helpers:

```js
/**
 * After pages are built, reveal the employer name on the first grouped role of any
 * page that does not itself carry the run's company header.
 *
 * A run's header is emitted once, with the lead role. When a run straddles a page
 * boundary the continuation page would otherwise show indented roles with no
 * employer — worse than the pre-grouping behaviour, where every entry carried its
 * own company. The per-role .experience-company element is still in the DOM (Task
 * 2 renders it without data-editable and hides it in CSS); this only unhides it.
 *
 * Runs after measurement, and only adds a class to an already-laid-out element, so
 * it cannot invalidate the heights pagination just computed.
 *
 * @param {Array<Element>} pages
 */
export function revealGroupContinuations(pages) {
  if (!Array.isArray(pages)) return;
  pages.forEach((page, i) => {
    if (i === 0 || !page) return;
    // A page that starts its own run already shows the header; nothing to reveal
    // before it. Only roles appearing BEFORE the first header on this page are
    // continuations of a run that began on an earlier page.
    const firstHeader = page.querySelector('.experience-group-header');
    const grouped = page.querySelectorAll('.is-grouped');
    for (const role of grouped) {
      if (firstHeader && (role.contains(firstHeader) || role.compareDocumentPosition(firstHeader) & Node.DOCUMENT_POSITION_PRECEDING)) break;
      const company = role.querySelector('.experience-company');
      if (company) {
        company.classList.add('is-continuation');
        break;
      }
    }
  });
}
```

Then call it in the paginated path, immediately before the `replaceChildren(pages)` line found in Step 1:

```js
  revealGroupContinuations(pages);
  resumeEl.replaceChildren(...pages);
```

Match the existing call's exact spread/array form — if the current line is `resumeEl.replaceChildren(pages)`, keep it as `resumeEl.replaceChildren(pages)` and only insert the `revealGroupContinuations(pages);` line above it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/pagination.test.js`
Expected: PASS, all blocks.

- [ ] **Step 6: Add the print CSS rules**

`continuous` is the default page size (`src/pageSetup.js:22`) and hands breaking to the browser, so without these the *default* configuration can end a printed page on a bare company name. Add to `resume-designer/styles/print.css` inside the `@media print` block, next to the existing `.experience-item` rule at `:131-133`:

```css
  .experience-group-header {
    break-after: avoid;
    page-break-after: avoid;
  }
```

And add the mirror in the `html.pdf-export-mode` section:

```css
html.pdf-export-mode .experience-group-header {
  break-after: avoid;
  page-break-after: avoid;
}
```

- [ ] **Step 7: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add src/pagination.js styles/print.css test/pagination.test.js
git commit -m "fix(pagination): repeat the employer name on continuation pages"
```

---

### Task 5: Make every reorder run-aware

Both shipped sort modes deterministically interleave a foreign employer into a run, which silently drops the company header. `applySort('custom')` is an explicit no-op, so the shredded order becomes the saved data with no UI path back — and `date` is the default mode. This task also mints group ids for AI-generated résumés, without which the app's flagship path can never produce a grouped résumé.

**Files:**
- Modify: `resume-designer/src/components/structure/StructurePanel.jsx:395-411` (`applySort`)
- Modify: `resume-designer/src/onboardingLogic.js:300-306` (`buildResumeData`'s post-generation sort)
- Test: covered by `test/experienceGroups.test.js` (Task 1) for the ordering rule; add an `onboardingLogic` case below.

**Interfaces:**
- Consumes: `sortRunAware` and `assignGroupIds` from `src/experienceGroups.js` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create or append to `resume-designer/test/experienceGroups.test.js` a block proving the generation rule composes correctly:

```js
describe('generation ordering + grouping (buildResumeData contract)', () => {
  it('sorts run-aware and then mints ids for same-company runs', () => {
    const raw = [
      { title: 'Consultant', company: 'Initech', dates: '2021 – 2022', bullets: [], _relevanceRank: 0 },
      { title: 'Senior Dev', company: 'Acme', dates: 'Mar 2022 – Jun 2024', bullets: [], _relevanceRank: 1 },
      { title: 'Dev', company: 'Acme', dates: 'Jan 2019 – Mar 2022', bullets: [], _relevanceRank: 2 },
    ];
    let n = 0;
    const sorted = sortRunAware(raw, (run) => Math.max(...run.map(experienceSortValue)), (a, b) => b - a);
    const grouped = assignGroupIds(sorted, () => `g${++n}`);

    expect(grouped.map((x) => x.title)).toEqual(['Senior Dev', 'Dev', 'Consultant']);
    expect(grouped[0]._groupId).toBe('g1');
    expect(grouped[1]._groupId).toBe('g1');
    expect(grouped[2]._groupId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/experienceGroups.test.js -t "generation ordering"`
Expected: FAIL — the two Acme entries are not adjacent before `assignGroupIds` runs, so no id is minted. (If it passes immediately, the fixture ordering is wrong; the Initech entry must sort between the two Acme roles under a naive sort.)

- [ ] **Step 3: Make `applySort` run-aware**

In `resume-designer/src/components/structure/StructurePanel.jsx`, add to the imports:

```js
import { sortRunAware } from '../../experienceGroups.js';
```

Then replace the body of `applySort` (`:395-411`) with:

```js
  const applySort = (mode) => {
    setSortMode(mode);
    // Persist the choice per-variant without history/remount (updateSilent).
    store.updateSilent('experienceSortMode', mode);
    // 'custom' keeps the user's manual order — nothing to reorder.
    if (mode === 'custom') return;
    const experience = store.get('experience');
    if (!Array.isArray(experience) || experience.length < 2) return;
    // Ordering is RUN-AWARE: a naive sort interleaves a foreign employer between
    // two roles at one company, which silently drops the company header from the
    // preview and the PDF. Because applySort('custom') is a no-op, that shredded
    // order would become the saved data with no way back.
    const sorted = mode === 'relevance'
      ? sortRunAware(
        experience,
        (run) => Math.min(...run.map((e) => (Number.isFinite(e?._relevanceRank) ? e._relevanceRank : Number.MAX_SAFE_INTEGER))),
        (a, b) => a - b,
      )
      : sortRunAware(
        experience,
        (run) => Math.max(...run.map(experienceSortValue)),
        (a, b) => b - a,
      );
    store.update('experience', sorted);
  };
```

- [ ] **Step 4: Make generation run-aware and grouped**

In `resume-designer/src/onboardingLogic.js`, add to the imports:

```js
import { sortRunAware, assignGroupIds } from './experienceGroups.js';
```

Find the sort at `:306`:

```js
  experience.sort((a, b) => experienceSortValue(b) - experienceSortValue(a));
```

Replace it with:

```js
  // Run-aware ordering, then mint one group id per run of consecutive entries at
  // the same employer. Without this nothing the AI produces is ever grouped, and
  // the naive sort would interleave a foreign employer into a run anyway.
  const ordered = sortRunAware(
    experience,
    (run) => Math.max(...run.map(experienceSortValue)),
    (a, b) => b - a,
  );
  experience = assignGroupIds(ordered);
```

If `experience` is declared with `const`, change that declaration to `let`. Verify with:

Run: `grep -n "experience" src/onboardingLogic.js | sed -n '1,40p'`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/experienceGroups.test.js`
Expected: PASS, including the new generation block.

- [ ] **Step 6: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS. The build is required — `StructurePanel.jsx` is invisible to vitest.

- [ ] **Step 7: Commit**

```bash
git add src/components/structure/StructurePanel.jsx src/onboardingLogic.js test/experienceGroups.test.js
git commit -m "fix(experience): keep company runs intact when reordering"
```

---

### Task 6: Harden `startEditing` against non-string paths

A pre-existing defect, fixed here because the design must not depend on a naming convention to prevent data destruction. Today a `data-editable` carrying a container path replaces that whole DOM subtree with the literal text `[object Object]`, makes it contentEditable, and `finishEditing` then writes that string over the entry object — reachable by Tab or a stray click.

**Files:**
- Modify: `resume-designer/src/inlineEditor.js` (`startEditing`, around `:782` where `path` is read)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports. Task 7 relies on `startEditing` still being reachable for genuine leaf paths.

- [ ] **Step 1: Locate the exact guard point**

Run: `grep -n "const sourceValue = store.get(path)" src/inlineEditor.js`
Expected: one line number inside `startEditing`. The guard goes immediately after it.

- [ ] **Step 2: Add the guard**

Immediately after the `const sourceValue = store.get(path);` line, insert:

```js
  // A data-editable must always resolve to a scalar. If it points at a container
  // (an object or array), the textContent fallback below would replace this whole
  // subtree with the literal string '[object Object]', make it contentEditable, and
  // let finishEditing persist that string over the record. Refuse instead.
  if (sourceValue !== null && sourceValue !== undefined
      && typeof sourceValue !== 'string' && typeof sourceValue !== 'number') {
    activeElement = null;
    return;
  }
```

- [ ] **Step 3: Verify the guard sits before the textContent fallback**

Run: `grep -n "sourceValue" src/inlineEditor.js`
Expected: the guard's lines appear *before* the `element.textContent = String(sourceValue)` line. If they do not, move the guard up — a guard after the assignment fixes nothing.

- [ ] **Step 4: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS.

- [ ] **Step 5: Manual verification**

Run: `npm run tauri:dev`

Confirm, in the running app:
1. Clicking a job title still enters edit mode and saves on blur.
2. Tabbing from a job title moves to the next editable field and does not produce `[object Object]` anywhere.
3. Clicking a company header on a grouped job enters edit mode (it points at a real leaf path).

- [ ] **Step 6: Commit**

```bash
git add src/inlineEditor.js
git commit -m "fix(editor): refuse to edit a path that resolves to an object"
```

---

### Task 7: Fan a company rename across the run

`finishEditing` is a three-branch if/else where every branch calls exactly one `store.update(path, value)`. A run rename needs to touch N entries; looping would cost one undo press and one full re-render per role, with torn intermediate states.

**Files:**
- Modify: `resume-designer/src/inlineEditor.js` (`finishEditing` at `:835-870`)

**Interfaces:**
- Consumes: the `data-editable-group="0,1"` attribute emitted by `renderGroupHeader` in Task 2.
- Produces: no new exports.

- [ ] **Step 1: Add the group branch**

In `resume-designer/src/inlineEditor.js`, replace the dispatch inside `finishEditing` (`:844-853`):

```js
  // Handle different types of editable content
  if (path.includes('[') && path.includes('].')) {
    // Array item property (e.g., "experience[0].title")
    store.update(path, newValue);
  } else if (path.startsWith('sections[')) {
    // Section content item
    store.update(path, newValue);
  } else {
    // Simple property
    store.update(path, newValue);
  }
```

with:

```js
  // A company header edit renames EVERY role in the run. data-editable-group is
  // DOM metadata (a comma-separated list of array indices), not a store path — the
  // AI-addressable path grammar is unchanged. One array write keeps it to a single
  // undo step and a single re-render, instead of N torn intermediate states.
  const groupIndices = element.dataset.editableGroup;
  if (groupIndices) {
    const indices = groupIndices.split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger);
    const experience = store.get('experience');
    if (Array.isArray(experience) && indices.length > 0) {
      const next = experience.map((entry, i) => (indices.includes(i) ? { ...entry, company: newValue } : entry));
      store.setChangeMetadata('Renamed company');
      store.update('experience', next);
    }
  } else if (path.includes('[') && path.includes('].')) {
    // Array item property (e.g., "experience[0].title")
    store.update(path, newValue);
  } else if (path.startsWith('sections[')) {
    // Section content item
    store.update(path, newValue);
  } else {
    // Simple property
    store.update(path, newValue);
  }
```

- [ ] **Step 2: Confirm `setChangeMetadata`'s signature**

Run: `sed -n '213,222p' src/store.js`
Expected: `setChangeMetadata(description, changeType = CHANGE_TYPES.EDIT)`. A single string argument is valid; if the signature differs, match it.

- [ ] **Step 3: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS.

- [ ] **Step 4: Manual verification**

Run: `npm run tauri:dev`

With a résumé containing a two-role run:
1. Click the company header, change the name, click away.
2. Both roles show the new company (open the Structure panel to confirm both entries changed).
3. **One** press of undo restores both — not two.
4. The run is still grouped after the rename (company equality still holds, because both changed together).

- [ ] **Step 5: Commit**

```bash
git add src/inlineEditor.js
git commit -m "feat(editor): rename every role at a company in one edit"
```

---

### Task 8: Structure panel authoring

Without this there is no way to create a group, no way to break one that import auto-formed, and nothing anywhere showing membership — while the only add path appends to the end of the array.

The experience list stays **exactly one level deep**. Rendering a run as a single draggable unit is not an option: `SortableList` computes `from`/`to` from `ids.indexOf()` over the *rendered* rows (`Sortable.jsx:37-42`) and hands them straight to `store.moveInArray`, so group rows and array indices would diverge and one drag would corrupt three positions.

**Files:**
- Modify: `resume-designer/src/components/structure/StructurePanel.jsx` (`ExperienceItem` at `:223-292`; the Add button at `:548`; the list render at `:569-571`)

**Interfaces:**
- Consumes: `groupExperience` from `src/experienceGroups.js`; `generateId` from `src/store.js`.
- Produces: no new exports.

- [ ] **Step 1: Add the imports**

In `resume-designer/src/components/structure/StructurePanel.jsx`, extend the existing `experienceGroups` import added in Task 5:

```js
import { sortRunAware, groupExperience } from '../../experienceGroups.js';
```

Confirm `generateId` is already imported (the Add button at `:548` uses it):

Run: `grep -n "generateId" src/components/structure/StructurePanel.jsx`

- [ ] **Step 2: Add the three group actions above `ExperienceItem`**

Insert immediately before `function ExperienceItem(` (`:223`):

```js
// --- grouping actions -------------------------------------------------------
// Each is ONE store.update('experience', next) preceded by setChangeMetadata, so
// each is a single undo step. Never push-then-drag: that is two history entries
// and routes the user through the drag that breaks runs.

function linkToCompanyAbove(index) {
  const experience = store.get('experience');
  if (!Array.isArray(experience) || index < 1) return;
  const prev = experience[index - 1];
  const id = prev._groupId || generateId('grp');
  const next = experience.map((entry, i) => {
    if (i === index - 1) return { ...entry, _groupId: id };
    if (i === index) return { ...entry, _groupId: id, company: prev.company };
    return entry;
  });
  store.setChangeMetadata('Linked roles at one company');
  store.update('experience', next);
}

function separateFromCompanyAbove(index) {
  const experience = store.get('experience');
  if (!Array.isArray(experience) || index < 0) return;
  // A fresh id — never reuse — so this entry can never re-fuse with the run above.
  const next = experience.map((entry, i) => (i === index ? { ...entry, _groupId: generateId('grp') } : entry));
  store.setChangeMetadata('Separated role from company');
  store.update('experience', next);
}

function addRoleAtCompany(leadIndex, lastIndexOfRun) {
  const experience = store.get('experience');
  if (!Array.isArray(experience)) return;
  const lead = experience[leadIndex];
  const id = lead._groupId || generateId('grp');
  const role = {
    id: generateId('exp'),
    title: 'New Position',
    company: lead.company,
    dates: 'Start – End',
    bullets: ['Describe your accomplishments'],
    _groupId: id,
    _expanded: true,
  };
  const next = [...experience];
  if (!next[leadIndex]._groupId) next[leadIndex] = { ...next[leadIndex], _groupId: id };
  next.splice(lastIndexOfRun + 1, 0, role);
  store.setChangeMetadata('Added a role at this company');
  store.update('experience', next);
}
```

- [ ] **Step 3: Give `ExperienceItem` its grouping props and controls**

Change the signature at `:223` from:

```js
function ExperienceItem({ exp, index }) {
```

to:

```js
function ExperienceItem({ exp, index, group, isLead, isRunMember, canLinkAbove, lastIndexOfRun }) {
```

Then, inside the returned `<SortableItem>`, replace the opening header row (`:242-252`) with a version that shows the rail and the company on a lead row:

```js
      <div className="flex cursor-pointer items-center gap-2 px-2.5 py-2" onClick={toggle}>
        <DragHandle />
        {/* The rail is the whole grouping affordance: membership is visible
            without opening an accordion. */}
        <span
          aria-hidden="true"
          className={cn('w-[3px] self-stretch rounded-full', isRunMember ? 'bg-primary/40' : 'bg-transparent')}
        />
        <span className="min-w-0 flex-1">
          {isLead && group && group.roles.length > 1 && (
            <span className="block truncate text-[11.5px] font-semibold text-muted-foreground">
              {exp.company} · {group.roles.length} roles
            </span>
          )}
          <span className="block truncate text-[13px] font-semibold">{exp.title || 'Untitled position'}</span>
          {!isRunMember && <span className="block truncate text-[11.5px] text-muted-foreground">{exp.company || ''}</span>}
        </span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
        />
      </div>
```

- [ ] **Step 4: Add the action buttons to the accordion body**

Inside the expanded body, immediately above the existing "Delete experience" `<Button>` (`:284-291`), insert:

```js
        <div className="flex flex-wrap gap-1.5 border-t pt-2.5">
          {isLead && group && group.roles.length > 1 && (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              onClick={() => addRoleAtCompany(index, lastIndexOfRun)}
            >
              <Plus className="size-3.5" /> Add role at this company
            </Button>
          )}
          {isRunMember ? (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              onClick={() => separateFromCompanyAbove(index)}
            >
              Separate from company above
            </Button>
          ) : (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              disabled={!canLinkAbove}
              title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
              onClick={() => linkToCompanyAbove(index)}
            >
              Link to company above
            </Button>
          )}
        </div>
```

Confirm `Plus` is already imported in this file:

Run: `grep -n "Plus" src/components/structure/StructurePanel.jsx | head -3`

- [ ] **Step 5: Compute the grouping props at the list render**

Replace the experience `SortableList` body (`:569-571`) with:

```js
              <SortableList className="space-y-2" ids={experience.map((e, i) => e.id || `exp-${i}`)}
                onReorder={reorderExperience}>
                {(() => {
                  const groups = groupExperience(experience);
                  // index -> { group, isLead, lastIndexOfRun }
                  const byIndex = new Map();
                  groups.forEach((group) => {
                    const last = group.roles[group.roles.length - 1].index;
                    group.roles.forEach((role, position) => {
                      byIndex.set(role.index, { group, isLead: position === 0, lastIndexOfRun: last });
                    });
                  });
                  return experience.map((exp, i) => {
                    const meta = byIndex.get(i) || {};
                    const isRunMember = !!meta.group && meta.group.roles.length > 1;
                    const prev = i > 0 ? experience[i - 1] : null;
                    return (
                      <ExperienceItem
                        key={exp.id || `exp-${i}`}
                        exp={exp}
                        index={i}
                        group={meta.group}
                        isLead={!!meta.isLead}
                        isRunMember={isRunMember}
                        lastIndexOfRun={meta.lastIndexOfRun}
                        canLinkAbove={!!prev && !!prev.company && prev.company === exp.company}
                      />
                    );
                  });
                })()}
              </SortableList>
```

- [ ] **Step 6: Self-heal a drag that strands an entry**

Replace `reorderExperience` (`:417-421`) with:

```js
  // A manual drag is an explicit custom arrangement: persist the new order AND
  // flip the sort mode to 'custom' so it sticks (and the dropdown reflects it).
  const reorderExperience = (from, to) => {
    setSortMode('custom');
    store.updateSilent('experienceSortMode', 'custom');
    const experience = store.get('experience');
    if (!Array.isArray(experience)) return;
    const next = [...experience];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // A drag can strand an entry away from its run. Rather than leave an id that
    // no longer describes anything, clear it — immediately visible in the rail,
    // and re-linked with one click.
    const before = next[to - 1];
    const after = next[to + 1];
    const stillAdjacent = (before && before._groupId && before._groupId === moved._groupId && before.company === moved.company)
      || (after && after._groupId && after._groupId === moved._groupId && after.company === moved.company);
    if (moved._groupId && !stillAdjacent) {
      next[to] = { ...moved, _groupId: undefined };
    }
    store.setChangeMetadata('Reordered experience');
    store.update('experience', next);
  };
```

Note this replaces the previous `store.moveInArray('experience', from, to)` call with an equivalent single array write, because the self-heal must be part of the same undo step.

- [ ] **Step 7: Build**

Run: `npx vite build`
Expected: PASS. This is the only automated check for this file.

- [ ] **Step 8: Manual verification**

Run: `npm run tauri:dev`

In the Structure panel:
1. Two adjacent entries at the same company → "Link to company above" is enabled on the second; clicking it draws the rail on both and the preview shows one company header.
2. Two adjacent entries at *different* companies → the button is disabled with the explanatory tooltip.
3. "Add role at this company" on a lead inserts the new role directly beneath the run's last member, not at the bottom of the list.
4. "Separate from company above" splits the run; the preview immediately shows two employers again.
5. Drag an unrelated job into the middle of a run → the dragged entry keeps its own company, and the run either heals or visibly splits. One undo restores it.
6. Collapse an entry, edit a field in another, re-expand — the collapsed entry keeps its typed values (the body stays mounted; do not regress this).

- [ ] **Step 9: Commit**

```bash
git add src/components/structure/StructurePanel.jsx
git commit -m "feat(structure): link and separate roles at the same company"
```

---

### Task 9: Markdown round trip and parser tests

`src/parser.js` has never had a test. The writer and reader already disagree about where dates live, so `parse → export → re-import` is lossy today, before this feature. Fix the asymmetry, give entries an id, and group on import using the same predicate the renderer uses — so import, export and render agree by construction.

**Files:**
- Modify: `resume-designer/src/parser.js` (entry construction at `:145-150`)
- Modify: `resume-designer/src/persistence.js` (`generateMarkdown` experience block at `:1114-1124`; `importFromMarkdown` at `:1180`)
- Test: `resume-designer/test/parser.test.js`

**Interfaces:**
- Consumes: `assignGroupIds` from `src/experienceGroups.js`; `generateId` from `src/store.js`.
- Produces: no new exports. `parseResume` keeps its signature `parseResume(markdown) -> object`.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/parser.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseResume } from '../src/parser.js';

const doc = (experience) => `# Jane Doe
**Product Designer**

## Experience

${experience}
`;

describe('parseResume — experience entries', () => {
  it('splits title and company on the em dash', () => {
    const r = parseResume(doc('### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- shipped a thing\n'));
    expect(r.experience[0].title).toBe('Senior Dev');
    expect(r.experience[0].company).toBe('Acme Corporation');
  });

  it('reads the dates from the bold line, not the heading', () => {
    const r = parseResume(doc('### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- shipped a thing\n'));
    expect(r.experience[0].dates).toBe('Mar 2022 – Jun 2024');
  });

  it('also reads dates written inline on the heading (what the exporter emits)', () => {
    const r = parseResume(doc('### Senior Dev — Acme Corporation **Mar 2022 – Jun 2024**\n- shipped a thing\n'));
    expect(r.experience[0].company).toBe('Acme Corporation');
    expect(r.experience[0].dates).toBe('Mar 2022 – Jun 2024');
  });

  it('collects bullets', () => {
    const r = parseResume(doc('### Dev — Acme\n**2019 – 2022**\n- one\n- two\n'));
    expect(r.experience[0].bullets).toHaveLength(2);
  });

  it('gives every entry a stable id', () => {
    const r = parseResume(doc('### Dev — Acme\n**2019 – 2022**\n- one\n'));
    expect(typeof r.experience[0].id).toBe('string');
    expect(r.experience[0].id.length).toBeGreaterThan(0);
  });

  it('does not steal the first experience date line as the tagline', () => {
    const r = parseResume(`# Jane Doe

## Experience

### Dev — Acme
**2020 – Present**
- one
`);
    expect(r.experience[0].dates).toBe('2020 – Present');
    expect(r.tagline).not.toBe('2020 – Present');
  });

  it('groups consecutive entries at an identical company', () => {
    const r = parseResume(doc(
      '### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- a\n\n'
      + '### Dev — Acme Corporation\n**Jan 2019 – Mar 2022**\n- b\n\n'
      + '### Intern — Initech\n**2018**\n- c\n',
    ));
    expect(r.experience[0]._groupId).toBeTruthy();
    expect(r.experience[0]._groupId).toBe(r.experience[1]._groupId);
    expect(r.experience[2]._groupId).toBeUndefined();
  });

  it('does not group two non-adjacent stints at the same company', () => {
    const r = parseResume(doc(
      '### Staff — Acme\n**2023 – 2024**\n- a\n\n'
      + '### Consultant — Initech\n**2021 – 2023**\n- b\n\n'
      + '### Dev — Acme\n**2018 – 2020**\n- c\n',
    ));
    expect(r.experience[0]._groupId).toBeUndefined();
    expect(r.experience[2]._groupId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/parser.test.js`
Expected: FAIL on the inline-dates test, the id test, the tagline test, and both grouping tests.

- [ ] **Step 3: Fix the parser's entry construction and heading grammar**

In `resume-designer/src/parser.js`, add the import at the top:

```js
import { generateId } from './store.js';
```

Replace the entry construction (`:145-150`):

```js
      currentExperience = {
        title,
        company,
        dates: '',
        bullets: []
      };
```

with:

```js
      currentExperience = {
        id: generateId('exp'),
        title,
        company,
        dates: '',
        bullets: []
      };
```

Then make `parseExperienceTitle` (`:203`) tolerate the inline-bold dates the exporter writes. Replace it with:

```js
function parseExperienceTitle(titleLine) {
  // The exporter writes dates INLINE on the heading (`### Title — Company **Dates**`)
  // while the reader historically expected them on a separate bold line — which made
  // parse -> export -> re-import lossy (the dates folded into `company`). Accept both.
  let dates = '';
  let line = titleLine;
  const inline = line.match(/\s*\*\*([^*]+)\*\*\s*$/);
  if (inline) {
    dates = inline[1].trim();
    line = line.slice(0, inline.index).trim();
  }

  // Pattern: "Role — Company" or "Role — Project — Event"
  const parts = line.split('—').map(p => p.trim());

  if (parts.length >= 2) {
    return { title: parts[0], company: parts.slice(1).join(' — '), dates };
  }

  return { title: line, company: '', dates };
}
```

And update its call site (`:143`) from:

```js
      const { title, company } = parseExperienceTitle(titleLine);
```

to:

```js
      const { title, company, dates: inlineDates } = parseExperienceTitle(titleLine);
```

then set `dates: inlineDates` in the entry construction instead of `dates: ''`:

```js
      currentExperience = {
        id: generateId('exp'),
        title,
        company,
        dates: inlineDates,
        bullets: []
      };
```

A separate bold line later still overwrites `dates` via the existing branch at `:157`, so both grammars work and the separate line wins when both are present.

- [ ] **Step 4: Stop the tagline check from eating a date line**

Replace the tagline branch (`:47`):

```js
    if (line.startsWith('**') && line.endsWith('**') && !resume.tagline) {
```

with:

```js
    // Only the header region (before the first `## `) can supply the tagline.
    // Without the currentSection guard, a resume with no tagline has its FIRST
    // experience date line stolen — and grouping multiplies bold lines per employer.
    if (line.startsWith('**') && line.endsWith('**') && !resume.tagline && !currentSection) {
```

- [ ] **Step 5: Group on import**

In `resume-designer/src/persistence.js`, add the import at the top:

```js
import { assignGroupIds } from './experienceGroups.js';
```

Then in `importFromMarkdown` (`:1180`), replace:

```js
        const data = parseResume(markdown);
        resolve(data);
```

with:

```js
        const data = parseResume(markdown);
        // Same predicate the renderer uses, so import and render agree by
        // construction: consecutive entries at an identical company are one tenure.
        data.experience = assignGroupIds(data.experience);
        resolve(data);
```

- [ ] **Step 6: Make the exporter emit the reader's grammar**

In `resume-designer/src/persistence.js`, replace the experience writer (`:1117`):

```js
      md += `### ${exp.title} — ${exp.company} **${exp.dates}**\n\n`;
```

with:

```js
      // Dates go on their own bold line — the grammar the reader and
      // Templates/RESUME-TEMPLATE.md both document — so the round trip is lossless.
      md += `### ${exp.title} — ${exp.company}\n`;
      md += `**${exp.dates}**\n\n`;
```

Run members are already emitted consecutively because array order is preserved, so import regroups them without any new syntax. A new-format `.md` opened by an older build renders ungrouped, which is a clean degradation.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/parser.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 8: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS.

- [ ] **Step 9: Manual round-trip check**

Run: `npm run tauri:dev`

1. Export the current résumé as Markdown.
2. Import that same file as a new variant.
3. Confirm titles, companies, dates and bullets all survive, and that a promotion at one employer comes back grouped.

- [ ] **Step 10: Commit**

```bash
git add src/parser.js src/persistence.js test/parser.test.js
git commit -m "fix(markdown): make the resume round trip lossless and group on import"
```

---

### Task 10: Readable change labels

`getPathLabel` has no entry for `company`, `dates` or `title`, so a fanned-out rename renders as "Experience #2 - company" in the review dialog.

**Files:**
- Modify: `resume-designer/src/diffEngine.js:406-420` (the `labels` map)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports; `getPathLabel(path) -> string` keeps its signature.

- [ ] **Step 1: Add the entries**

In `resume-designer/src/diffEngine.js`, add three keys to the `labels` map inside `getPathLabel`:

```js
  const labels = {
    'name': 'Name',
    'title': 'Title',
    'company': 'Company',
    'dates': 'Dates',
    'email': 'Email',
    'phone': 'Phone',
    'location': 'Location',
    'website': 'Website',
    'linkedin': 'LinkedIn',
    'summary': 'Summary',
    'experience': 'Experience',
    'education': 'Education',
    'skills': 'Skills',
    'sections': 'Sections',
    'highlights': 'Highlights'
  };
```

`title` is already present and already maps to `'Title'`, so only `company` and `dates` are new.

- [ ] **Step 2: Run the full suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/diffEngine.js
git commit -m "fix(diff): label company and date changes in the review dialog"
```

---

### Task 11: Profile grouping

The profile is where the user described the problem first. It takes the same optional `_groupId` under the same run rule — the flat shape is unchanged, so old builds keep working, the bridge wire shape at `bridgeRoutes.js:60` is untouched, and no schema version marker is needed.

The payoff is prompt serialization: today the model gets one `Title at Company (dates)` line per entry and must re-derive whether two entries are one tenure or two — and the boomerang and concurrent-role cases are exactly where it guesses wrong.

**Files:**
- Modify: `resume-designer/src/aiService.js` (`buildProfileContext` at `:645-654`; the second serializer at `:777-789`)
- Modify: `resume-designer/src/profileMarkdown.js` (`markdownToProfile` at `:148`)
- Modify: `resume-designer/src/components/profile/ProfileTabs.jsx` (`ItemList` at `:252`, `ExperienceTab` at `:269`)
- Test: `resume-designer/test/profileMarkdown.test.js`

**Interfaces:**
- Consumes: `groupExperience`, `assignGroupIds` from `src/experienceGroups.js`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/profileMarkdown.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { markdownToProfile, profileToMarkdown, DEFAULT_PROFILE } from '../src/profileMarkdown.js';

const md = (work) => `# User Profile

## Work Experience

${work}

## Skills

| Skill | Proficiency | Years |
|-------|-------------|-------|
`;

describe('markdownToProfile — work experience', () => {
  it('parses title, company and dates', () => {
    const p = markdownToProfile(md('### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n'));
    expect(p.workExperience[0]).toMatchObject({
      title: 'Senior Dev', company: 'Acme Corporation', dates: 'Mar 2022 - Jun 2024',
    });
  });

  it('groups consecutive entries at an identical company', () => {
    const p = markdownToProfile(md(
      '### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n\n'
      + '### Dev at Acme Corporation\n**Dates:** Jan 2019 - Mar 2022\n\nBuilt things.\n',
    ));
    expect(p.workExperience[0]._groupId).toBeTruthy();
    expect(p.workExperience[0]._groupId).toBe(p.workExperience[1]._groupId);
  });

  it('does not group different companies', () => {
    const p = markdownToProfile(md(
      '### Dev at Acme\n**Dates:** 2019 - 2022\n\nA.\n\n### Intern at Initech\n**Dates:** 2018\n\nB.\n',
    ));
    expect(p.workExperience[0]._groupId).toBeUndefined();
  });

  it('does not mutate DEFAULT_PROFILE across calls', () => {
    markdownToProfile(md('### Dev at Acme\n**Dates:** 2019 - 2022\n\nA.\n'));
    expect(DEFAULT_PROFILE.workExperience).toHaveLength(0);
  });
});

describe('profileToMarkdown', () => {
  it('round-trips a grouped pair back into a grouped pair', () => {
    const source = markdownToProfile(md(
      '### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n\n'
      + '### Dev at Acme Corporation\n**Dates:** Jan 2019 - Mar 2022\n\nBuilt things.\n',
    ));
    const reparsed = markdownToProfile(profileToMarkdown(source));
    expect(reparsed.workExperience).toHaveLength(2);
    expect(reparsed.workExperience[0]._groupId).toBe(reparsed.workExperience[1]._groupId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/profileMarkdown.test.js`
Expected: FAIL on the two grouping tests. The `DEFAULT_PROFILE` mutation test may already pass; keep it as a regression guard.

- [ ] **Step 3: Group on profile import, and stop aliasing `DEFAULT_PROFILE`**

In `resume-designer/src/profileMarkdown.js`, add the import:

```js
import { assignGroupIds } from './experienceGroups.js';
```

Replace the shallow copy at `:131`:

```js
  const profile = { ...DEFAULT_PROFILE };
```

with:

```js
  // Deep-ish copy: a shallow spread ALIASES DEFAULT_PROFILE's arrays, so a parser
  // that pushes would permanently mutate the module constant for the session.
  const profile = {
    ...DEFAULT_PROFILE,
    contactInfo: { ...DEFAULT_PROFILE.contactInfo },
    workExperience: [], skills: [], education: [], projects: [],
    certifications: [], achievements: [], customSections: [],
  };
```

Then group at `:148`:

```js
      profile.workExperience = assignGroupIds(parseWorkExperience(sectionContent));
```

- [ ] **Step 4: Serialize grouped runs into both prompts**

In `resume-designer/src/aiService.js`, add the import:

```js
import { groupExperience } from './experienceGroups.js';
```

Replace the `buildProfileContext` work-experience block (`:645-654`):

```js
  if (profile.workExperience && profile.workExperience.length > 0) {
    profileContext += `### Work Experience\n`;
    for (const exp of profile.workExperience) {
      profileContext += `\n**${exp.title || 'Position'}** at **${exp.company || 'Company'}**`;
      if (exp.dates) profileContext += ` (${exp.dates})`;
      profileContext += `\n`;
      if (exp.details) profileContext += `${exp.details}\n`;
    }
    profileContext += '\n';
  }
```

with:

```js
  if (profile.workExperience && profile.workExperience.length > 0) {
    profileContext += `### Work Experience\n`;
    // Grouped runs emit ONE company heading with its roles beneath, so the model is
    // told that several positions are one tenure instead of inferring it from a
    // repeated company string — which it gets wrong for return stints and for
    // concurrent roles.
    for (const group of groupExperience(profile.workExperience)) {
      if (group.roles.length > 1) {
        profileContext += `\n**${group.company}** — ${group.roles.length} positions\n`;
        for (const { entry } of group.roles) {
          profileContext += `- **${entry.title || 'Position'}**`;
          if (entry.dates) profileContext += ` (${entry.dates})`;
          profileContext += `\n`;
          if (entry.details) profileContext += `${entry.details}\n`;
        }
      } else {
        const exp = group.roles[0].entry;
        profileContext += `\n**${exp.title || 'Position'}** at **${exp.company || 'Company'}**`;
        if (exp.dates) profileContext += ` (${exp.dates})`;
        profileContext += `\n`;
        if (exp.details) profileContext += `${exp.details}\n`;
      }
    }
    profileContext += '\n';
  }
```

Apply the same shape to the second serializer (`:777-789`), which writes into `context` under the heading `### Detailed Work Experience` and skips entries with neither a title nor a company:

```js
  if (profile.workExperience && profile.workExperience.length > 0) {
    context += `### Detailed Work Experience\n`;
    for (const group of groupExperience(profile.workExperience)) {
      if (group.roles.length > 1) {
        context += `\n**${group.company}** — ${group.roles.length} positions\n`;
        for (const { entry } of group.roles) {
          if (!entry.title && !entry.company) continue;
          context += `- **${entry.title || 'Untitled'}**`;
          if (entry.dates) context += ` (${entry.dates})`;
          context += `\n`;
          if (entry.details) context += `${entry.details}\n`;
        }
      } else {
        const exp = group.roles[0].entry;
        if (exp.title || exp.company) {
          context += `\n**${exp.title || 'Untitled'}** at ${exp.company || 'Unknown Company'}`;
          if (exp.dates) context += ` (${exp.dates})`;
          context += `\n`;
          if (exp.details) context += `${exp.details}\n`;
        }
      }
    }
    context += '\n';
  }
```

Both AI schemas (`aiService.js:203-209` extraction and `:509-522` generation) are **unchanged** — grouping is applied after extraction, never asked of the model.

- [ ] **Step 5: Add the profile authoring controls**

In `resume-designer/src/components/profile/ProfileTabs.jsx`, add the import:

```js
import { groupExperience } from '../../experienceGroups.js';
import { generateId } from '../../store.js';
```

`ItemList` (`:252`) keys entries by array index while their inputs are uncontrolled `defaultValue` fields, so deleting a middle entry already leaves stale text in the wrong card. Give entries a stable key. Replace the `items.map` inside `ItemList`:

```js
        items.map((item, i) => (
          <EntryCard key={item._key || (item._key = generateId('row'))} titleInput={renderTitle(item, i)} onDelete={() => onDelete(i)}>
            {renderBody(item, i)}
          </EntryCard>
        ))
```

Then in `ExperienceTab` (`:269`), add the grouping actions and pass a rail indicator. Replace the `renderBody` prop with one that appends the controls:

```js
        renderBody={(exp, i) => {
          const groups = groupExperience(items);
          const group = groups.find((g) => g.roles.some((r) => r.index === i));
          const isRunMember = !!group && group.roles.length > 1;
          const isLead = isRunMember && group.roles[0].index === i;
          const prev = i > 0 ? items[i - 1] : null;
          const canLinkAbove = !!prev && !!prev.company && prev.company === exp.company;
          const rewrite = (next) => { items.splice(0, items.length, ...next); refresh(); };
          return (
            <>
              <Input placeholder="Company" defaultValue={exp.company || ''} onChange={(e) => set(i, 'company')(e.target.value)} />
              <Input placeholder="Dates (e.g., Jan 2020 - Present)" defaultValue={exp.dates || ''} onChange={(e) => set(i, 'dates')(e.target.value)} />
              <Textarea
                rows={4}
                placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
                defaultValue={stripEmphasis(exp.details)}
                onChange={(e) => set(i, 'details')(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
                {isRunMember && (
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {isLead ? `${group.company} · ${group.roles.length} positions` : 'Same company as above'}
                  </span>
                )}
                {isRunMember ? (
                  <Button
                    variant="outline" size="sm" type="button" className="h-7 text-xs"
                    onClick={() => rewrite(items.map((entry, k) => (k === i ? { ...entry, _groupId: generateId('grp') } : entry)))}
                  >
                    Separate from company above
                  </Button>
                ) : (
                  <Button
                    variant="outline" size="sm" type="button" className="h-7 text-xs"
                    disabled={!canLinkAbove}
                    title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
                    onClick={() => {
                      const id = prev._groupId || generateId('grp');
                      rewrite(items.map((entry, k) => {
                        if (k === i - 1) return { ...entry, _groupId: id };
                        if (k === i) return { ...entry, _groupId: id };
                        return entry;
                      }));
                    }}
                  >
                    Link to company above
                  </Button>
                )}
              </div>
            </>
          );
        }}
```

Confirm `Button` is imported in this file:

Run: `grep -n "^import.*Button" src/components/profile/ProfileTabs.jsx`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/profileMarkdown.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full suite and the build**

Run: `npm run test && npx vite build`
Expected: both PASS.

- [ ] **Step 8: Manual verification**

Run: `npm run tauri:dev`

1. Open the profile, add two entries at the same company, click "Link to company above" — the lead row shows the company and position count.
2. Delete the *middle* of three profile entries; the remaining cards show their own values, not the deleted one's.
3. Ask the AI chat something that quotes your history and confirm it describes the linked roles as one employer.
4. Export the profile as Markdown, re-import it, and confirm the linked pair comes back linked.

- [ ] **Step 9: Commit**

```bash
git add src/aiService.js src/profileMarkdown.js src/components/profile/ProfileTabs.jsx test/profileMarkdown.test.js
git commit -m "feat(profile): group several positions at one employer"
```

---

## Final verification

Run before opening a PR. A green vitest run alone is **not** sufficient — it covers no component and asserts no rendered HTML beyond the two new renderer suites.

- [ ] `npm run test` — full suite green.
- [ ] `npm run lint` — clean.
- [ ] `npx vite build` — the only proof that every `.jsx` file still parses.
- [ ] `npm run tauri:dev` — WebKit, hands on. The ClaudePreview browser is Chromium; layout and scroll behaviour must be confirmed in the real engine.
- [ ] **Page-by-page PDF check at Letter and A4**, with a résumé long enough that a multi-role run straddles a page break. Confirm: no job is missing, the company header appears above its run, and the continuation page repeats the employer name. This is the failure mode the design exists to avoid and it is invisible at the default `continuous` page size.
- [ ] Repeat the PDF check on Windows if available; if not, note it as an on-device caveat in the PR body.
- [ ] Check every layout that renders experience — including **timeline**, whose markers are absolutely positioned off `.timeline-item` and whose `:last-child .timeline-line { display:none }` rule now fires on the last *role* rather than the last company. Adjust `styles/resume.css:1276` if the connector renders wrong.
