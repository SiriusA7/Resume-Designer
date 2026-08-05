# Optional Position Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user turn the grouped-employer presentation off globally, and stop markdown import from silently deciding whether adjacent same-company entries are one employer.

**Architecture:** Two independent halves. The render toggle is a **global** setting read through the single `renderResumeForLayout` entry point, which decorates a shallow copy — it never reads, writes or clears `_groupId`. The import prompt makes grouping opt-in at the parse boundary and asks only when the file actually contains candidates.

**Tech Stack:** React 19, Vite, plain JavaScript (no TypeScript), Tailwind 3 + shadcn/ui, vitest + jsdom, Tauri 2 (WKWebView).

Source spec: [`docs/superpowers/specs/2026-08-05-optional-position-grouping-design.md`](../specs/2026-08-05-optional-position-grouping-design.md)

## Global Constraints

- **Never commit, push, or open a PR without being explicitly asked.** Each task ends with a commit step; run it only when the human has approved that task.
- **Conventional commits, subject starts lowercase.** commitlint runs in CI on *every* commit in a PR.
- **`groupPositions` is read as `!== false`.** Absence means grouped. No migration, no existing résumé changes behaviour.
- **The toggle NEVER touches `_groupId`.** It must not read, write, mint or clear one. Turning grouping back on restores every group exactly.
- **Do not mutate `viewData` in `main.js`.** It is the store's own object when no AI change session is live, so writing a flag onto it would silently persist. Decorate a shallow copy instead.
- **Do not change the run rule** in `src/experienceGroups.js` — `groupExperience`, `companyKey`, `assignGroupIds` and `datesAreContinuous` all stay as they are.
- **Do not change AI generation** (`onboardingLogic.js`, date-gated and verified) or **profile extraction** (`aiService.js`, which no longer groups at all).
- **No new markdown grammar.** The exported format is unchanged so a file written by this build still opens in an older one.
- **`vitest` covers nothing under `src/components/**`** — `vitest.config.js` includes only `test/**/*.test.js` and there is no `@testing-library`. Any task touching a `.jsx` file must run `npx vite build`, and behavioural claims about components need a rendered check.

---

## File Structure

| File | Change |
|---|---|
| `src/renderer.js` | `renderExperienceEntries` takes `data`; `renderResumeForLayout` accepts the flag and decorates a copy. |
| `src/main.js` | Reads `groupPositions` from settings and passes it at the single render call. |
| `src/components/structure/DesignTab.jsx` | The Segmented control. |
| `src/parser.js` | `parseResume(markdown, options)` — grouping becomes opt-in. |
| `src/profileMarkdown.js` | `markdownToProfile(markdown, options)` — same. |
| `src/variantManager.js` | Detect candidates, ask, import accordingly. |
| `src/components/profile/ProfileDialog.jsx` | Same for the profile Import button. |
| `test/renderExperience.test.js` | Flag on/off cases. |
| `test/parser.test.js` | The `group` option. |
| `test/profileMarkdown.test.js` | The `group` option. |

---

### Task 1: Render the toggle

Self-contained: after this task the flag works end to end, with no UI to set it yet.

**Files:**
- Modify: `resume-designer/src/renderer.js`
- Modify: `resume-designer/src/main.js`
- Test: `resume-designer/test/renderExperience.test.js`

**Interfaces:**
- Consumes: `groupExperience(entries)` from `src/experienceGroups.js`.
- Produces: `renderExperienceEntries(data, variant)` — note the FIRST argument is now the whole résumé data object, not the entries array. `renderResumeForLayout(data, layout, opts)` where `opts` is `{ groupPositions }`. Task 2 calls neither; it only adds the control that feeds `main.js`.

- [ ] **Step 1: Write the failing tests**

`test/renderExperience.test.js` currently calls `renderExperienceEntries(entriesArray)`. Every existing call must become `renderExperienceEntries({ experience: entriesArray })`. Update them all, then append this block:

```js
describe('renderExperienceEntries — grouping toggle', () => {
  const twoRoles = [
    e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
    e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
  ];

  it('groups when the flag is absent', () => {
    const host = parse(renderExperienceEntries({ experience: twoRoles }));
    expect(host.querySelectorAll('.experience-group-header')).toHaveLength(1);
    expect(host.querySelectorAll('.is-grouped')).toHaveLength(2);
  });

  it('groups when the flag is explicitly true', () => {
    const host = parse(renderExperienceEntries({ experience: twoRoles, groupPositions: true }));
    expect(host.querySelectorAll('.experience-group-header')).toHaveLength(1);
  });

  it('renders every role flat when the flag is false', () => {
    const host = parse(renderExperienceEntries({ experience: twoRoles, groupPositions: false }));
    expect(host.querySelectorAll('.experience-group-header')).toHaveLength(0);
    expect(host.querySelectorAll('.is-grouped')).toHaveLength(0);
    expect(host.querySelectorAll('.is-group-lead')).toHaveLength(0);
    expect(host.querySelectorAll('.is-group-last')).toHaveLength(0);
  });

  it('gives every role its own editable company when off', () => {
    const host = parse(renderExperienceEntries({ experience: twoRoles, groupPositions: false }));
    const companies = [...host.querySelectorAll('.experience-company')];
    expect(companies).toHaveLength(2);
    companies.forEach((n, i) => expect(n.dataset.editable).toBe(`experience[${i}].company`));
  });

  it('leaves _groupId untouched when off', () => {
    const input = { experience: twoRoles, groupPositions: false };
    renderExperienceEntries(input);
    expect(input.experience.map((x) => x._groupId)).toEqual(['g1', 'g1']);
  });

  it('turns grouping off in the timeline variant too', () => {
    const host = parse(renderExperienceEntries({ experience: twoRoles, groupPositions: false }, 'timeline'));
    expect(host.querySelectorAll('.experience-group-header')).toHaveLength(0);
    expect(host.querySelectorAll('.is-grouped')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/renderExperience.test.js`
Expected: FAIL. The toggle cases fail because the flag is ignored; the pre-existing cases fail on the new `{ experience }` argument shape until Step 3 lands.

- [ ] **Step 3: Make `renderExperienceEntries` take the data object**

In `resume-designer/src/renderer.js`, replace the whole of `renderExperienceEntries` with:

```js
/**
 * Render every experience entry, grouping consecutive roles at one employer.
 *
 * Takes the whole résumé data object, not just the entries, so it can read the
 * `groupPositions` display preference alongside them. Absence means grouped:
 * only an explicit `false` turns it off, so no existing résumé changes.
 *
 * With grouping OFF every entry renders as a run of one — the pre-feature
 * output, each role carrying its own editable company. `_groupId` is never
 * read, written or cleared here, so turning it back on restores every group
 * exactly as it was.
 *
 * @param {object} data Résumé data: `{ experience, groupPositions? }`
 * @param {'default'|'timeline'} variant
 * @returns {string} HTML
 */
export function renderExperienceEntries(data, variant = 'default') {
  const entries = data?.experience;
  const groups = data?.groupPositions === false
    ? (Array.isArray(entries) ? entries : []).map((entry, index) => ({
      groupId: null, company: '', roles: [{ entry, index }],
    }))
    : groupExperience(entries);
  return groups
    .map((group) => group.roles
      .map((role, position) => {
        const isLead = position === 0;
        const isLast = position === group.roles.length - 1;
        return variant === 'timeline'
          ? renderTimelineExperience(role.entry, role.index, group, isLead, isLast)
          : renderExperience(role.entry, role.index, group, isLead, isLast);
      })
      .join(''))
    .join('');
}
```

A run of one already renders flat: `renderExperience` and `renderTimelineExperience` both compute `grouped = !!group && group.roles.length > 1`, so a single-role group adds no marker classes and no header, and keeps `data-editable` on the company. That is why building one-role groups is enough and no other renderer changes.

- [ ] **Step 4: Update the 11 call sites**

Each currently reads `renderExperienceEntries(data.experience)`. Replace every occurrence of:

```js
${renderExperienceEntries(data.experience)}
```

with:

```js
${renderExperienceEntries(data)}
```

And the single timeline site. Replace:

```js
${renderExperienceEntries(data.experience, 'timeline')}
```

with:

```js
${renderExperienceEntries(data, 'timeline')}
```

- [ ] **Step 5: Verify no call site was missed**

Run: `grep -n "renderExperienceEntries(data.experience" src/renderer.js`
Expected: no output. A missed site would pass the entries array as `data`, so `data.experience` would be `undefined` and that layout would render no experience at all.

- [ ] **Step 6: Let the flag reach the renderer**

In `resume-designer/src/renderer.js`, replace `renderResumeForLayout`:

```js
export function renderResumeForLayout(data, layout, opts = {}) {
  // Decorate a COPY. `viewData` in main.js is the store's own object whenever no
  // AI change session is in flight, so writing the flag onto it would persist a
  // display preference into the résumé's saved data.
  const view = opts.groupPositions === false ? { ...data, groupPositions: false } : data;
  return (LAYOUT_RENDERERS[layout] || renderResume)(view);
}
```

- [ ] **Step 7: Read the setting in main.js**

`main.js` already reads settings into module state — `currentLayout = settings.layout || 'sidebar'` at both `:445` and `:684`. Add a sibling beside each:

```js
  currentGroupPositions = settings.groupPositions !== false;
```

Declare `let currentGroupPositions = true;` next to the existing `currentLayout` declaration. Then at the single render call (`:1449`):

```js
  container.innerHTML = renderResumeForLayout(viewData, currentLayout, { groupPositions: currentGroupPositions });
```

Find the exact declaration first:

Run: `grep -n "let currentLayout" src/main.js`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/renderExperience.test.js`
Expected: PASS, including the six new cases.

- [ ] **Step 9: Run the full gates**

Run: `npm run test && npx vite build && npm run lint`
Expected: full suite green with no regressions; build exit 0; 0 lint errors (2 pre-existing warnings in `chat/DeleteVariantThreadsDialog.jsx` and `chat/useChat.js`).

- [ ] **Step 10: Commit**

```bash
git add src/renderer.js src/main.js test/renderExperience.test.js
git commit -m "feat(design): let grouped positions be turned off"
```

---

### Task 2: The Design-tab control

**Files:**
- Modify: `resume-designer/src/components/structure/DesignTab.jsx`

**Interfaces:**
- Consumes: the `groupPositions` setting Task 1 taught `main.js` to read, and the existing `Segmented`, `ControlGroup`, `getSettings` and `dispatchDesignChange` already in this file.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Confirm how a sibling control persists**

`DesignTab` seeds state from `getSettings()` on mount and pushes changes out through `dispatchDesignChange`. Read the orientation control and its handler so you follow the same idiom:

Run: `grep -n "handleSetOrientation" -B 2 -A 6 src/components/structure/DesignTab.jsx`
Expected: a `useState` seeded from `initialSettings.orientation`, and a handler that sets state then dispatches.

Then find how `main.js` consumes those events, so you know which `type` actually persists and re-renders:

Run: `grep -n "rd:design-change" -A 25 src/main.js | head -40`

Report what you find. If `main.js` does not persist arbitrary detail types to settings, you must ALSO add a case for `groupPositions` there that writes the setting and re-renders — say so and do it, rather than dispatching an event nothing listens for.

- [ ] **Step 2: Add the state**

Beside the other `useState` seeds in `DesignTab` (around `:514-517`):

```js
  const [groupPositions, setGroupPositions] = useState(initialSettings.groupPositions !== false);
```

- [ ] **Step 3: Add the handler**

Beside `handleSetOrientation`:

```js
  function handleSetGroupPositions(value) {
    setGroupPositions(value);
    // Collapsing a run into flat cards changes block heights, so the sheets must
    // re-split — a stale .resume-page split is how content gets clipped out of
    // the exported PDF.
    dispatchDesignChange({ type: 'groupPositions', value });
  }
```

- [ ] **Step 4: Add the control**

In the same `PanelSection` as the other layout-level choices, following the orientation control's markup exactly:

```jsx
          <ControlGroup label="Positions at one employer">
            <Segmented
              stretch
              options={[
                { value: true, label: 'Grouped' },
                { value: false, label: 'Separate' },
              ]}
              value={groupPositions}
              onChange={handleSetGroupPositions}
            />
          </ControlGroup>
```

Check the exact wrapper name used by the neighbouring controls before writing this — if they use something other than `ControlGroup`, match them:

Run: `grep -n "ControlGroup" src/components/structure/DesignTab.jsx | head -3`

- [ ] **Step 5: Build**

Run: `npx vite build`
Expected: exit 0. This is the only automated proof for this file — `vitest` covers nothing under `src/components/**`.

Run: `npm run test && npm run lint`
Expected: no regressions; 0 lint errors.

- [ ] **Step 6: Verify by rendering**

Start the dev server (`on-paper-dev`, port 3000, from `.claude/launch.json`). Do NOT enter an API key — hide the onboarding overlay and render `DesignTab` into your own container. Bare `"react"` will not resolve in the browser console: fetch the transformed source of `/src/components/structure/DesignTab.jsx` and read its import specifiers to find Vite's pre-bundled React and react-dom URLs.

Report: the control renders with two options; "Grouped" is selected by default; clicking "Separate" dispatches an `rd:design-change` event whose `detail` is `{ type: 'groupPositions', value: false }` (attach a listener and capture it).

- [ ] **Step 7: Commit**

```bash
git add src/components/structure/DesignTab.jsx
git commit -m "feat(design): add a grouped-positions control"
```

---

### Task 3: Ask before grouping on import

**Files:**
- Modify: `resume-designer/src/parser.js`
- Modify: `resume-designer/src/profileMarkdown.js`
- Modify: `resume-designer/src/variantManager.js`
- Modify: `resume-designer/src/components/profile/ProfileDialog.jsx`
- Test: `resume-designer/test/parser.test.js`
- Test: `resume-designer/test/profileMarkdown.test.js`

**Interfaces:**
- Consumes: `assignGroupIds(entries)` from `src/experienceGroups.js`, unchanged.
- Produces: `parseResume(markdown, { group = false } = {})` and `markdownToProfile(markdown, { group = false } = {})`. Both DEFAULT TO NOT GROUPING, so any caller that does not opt in gets the conservative behaviour.

- [ ] **Step 1: Write the failing tests**

Append to `test/parser.test.js`:

```js
describe('parseResume — grouping is opt-in', () => {
  const twoAcme = doc(
    '### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- a\n\n'
    + '### Dev — Acme Corporation\n**Jan 2019 – Mar 2022**\n- b\n',
  );

  it('does not group by default', () => {
    const r = parseResume(twoAcme);
    expect(r.experience[0]._groupId).toBeUndefined();
    expect(r.experience[1]._groupId).toBeUndefined();
  });

  it('groups when asked', () => {
    const r = parseResume(twoAcme, { group: true });
    expect(r.experience[0]._groupId).toBeTruthy();
    expect(r.experience[0]._groupId).toBe(r.experience[1]._groupId);
  });
});
```

Append to `test/profileMarkdown.test.js`:

```js
describe('markdownToProfile — grouping is opt-in', () => {
  const twoAcme = md(
    '### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n\n'
    + '### Dev at Acme Corporation\n**Dates:** Jan 2019 - Mar 2022\n\nBuilt things.\n',
  );

  it('does not group by default', () => {
    const p = markdownToProfile(twoAcme);
    expect(p.workExperience[0]._groupId).toBeUndefined();
    expect(p.workExperience[1]._groupId).toBeUndefined();
  });

  it('groups when asked', () => {
    const p = markdownToProfile(twoAcme, { group: true });
    expect(p.workExperience[0]._groupId).toBeTruthy();
    expect(p.workExperience[0]._groupId).toBe(p.workExperience[1]._groupId);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/parser.test.js test/profileMarkdown.test.js`
Expected: the two "does not group by default" cases FAIL — both parsers currently group unconditionally.

- [ ] **Step 3: Make parsing opt-in**

In `resume-designer/src/parser.js`, change the signature to `export function parseResume(markdown, { group = false } = {}) {` and replace the grouping line:

```js
  // Grouping is OPT-IN. The exported markdown carries no _groupId, so adjacency
  // is the only signal here — and adjacency cannot tell a promotion from a
  // return stint whose intervening job is simply absent from the file. The
  // importer asks the user instead of guessing.
  if (group) resume.experience = assignGroupIds(resume.experience);
```

In `resume-designer/src/profileMarkdown.js`, change the signature to `export function markdownToProfile(markdown, { group = false } = {}) {` and replace its grouping line:

```js
      profile.workExperience = group
        ? assignGroupIds(parseWorkExperience(sectionContent))
        : parseWorkExperience(sectionContent);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/parser.test.js test/profileMarkdown.test.js`
Expected: PASS, including the four new cases.

- [ ] **Step 5: Ask, in the résumé import path**

**The dialog must NOT live in `variantManager.js`.** `src/components/ui/confirm.jsx` imports React and Radix, while `variantManager.js` is a plain service module whose only imports are other `.js` services — and `test/storageGuards.test.js` imports it. Pulling a React component in there would drag the UI layer into a service module and put it in that test's import graph.

Instead `importVariant` takes an optional **callback** and the UI supplies the dialog. Read the current function first:

Run: `grep -n "export async function importVariant" -A 14 src/variantManager.js`

Replace it with:

```js
/**
 * @param {File} file
 * @param {{ confirmGrouping?: (runCount: number) => Promise<boolean> }} [options]
 *   `confirmGrouping` is injected by the UI so this module stays free of React.
 *   Omitted, nothing is ever grouped — the conservative default.
 */
export async function importVariant(file, { confirmGrouping = null } = {}) {
  try {
    // Import WITHOUT grouping (parseResume's default), then work out whether
    // grouping would change anything. No adjacent same-company entries means
    // nothing to decide and no dialog: the question only appears when the
    // answer matters.
    const data = await importFile(file);
    const entries = Array.isArray(data?.experience) ? data.experience : [];
    const grouped = assignGroupIds(entries);
    const runCount = groupExperience(grouped).filter((g) => g.roles.length > 1).length;
    if (runCount > 0 && confirmGrouping && await confirmGrouping(runCount)) {
      data.experience = grouped;
    }
    const name = file.name.replace(/\.(json|md|markdown)$/i, '');
    // createVariant returns null when the variant couldn't be persisted
    // (it already surfaced the storage error to the user).
    return createVariant(name, data) !== null;
  } catch (err) {
    alert('Import failed: ' + err.message);
    return false;
  }
}
```

Add one import at the top of `variantManager.js` — both are plain service functions, no UI:

```js
import { assignGroupIds, groupExperience } from './experienceGroups.js';
```

Then in `resume-designer/src/components/Header.jsx`, which already calls `importVariant(file)` at `:122`, pass the dialog in:

```js
      importVariant(file, {
        confirmGrouping: (runCount) => confirmDestructive({
          title: runCount === 1
            ? '1 employer has more than one role'
            : `${runCount} employers have more than one role`,
          description: 'Group each employer’s roles under a single company heading? Keep them separate if any of them are return stints rather than promotions.',
          actionLabel: 'Group',
        }),
      });
```

`confirmDestructive` is declared as `confirmDestructive({ title, description, actionLabel = 'Confirm', destructive = true })`. Confirm whether `destructive: false` is genuinely supported before deciding whether to pass it — this is a question, not a deletion:

Run: `grep -n "destructive" src/components/ui/confirm.jsx`

If the flag only changes button styling, pass `destructive: false` so the Group action is not styled as dangerous. If it is unused, omit it and say so in your report rather than passing a prop the component ignores.

Check whether `Header.jsx` already imports `confirmDestructive`; add the import only if it does not:

Run: `grep -n "confirmDestructive" src/components/Header.jsx`

- [ ] **Step 6: Ask, in the profile import path**

`src/components/profile/ProfileDialog.jsx:142` already calls `markdownToProfile(text)` directly, and it is a `.jsx` UI file, so the dialog goes inline — no callback needed. Read the handler first:

Run: `grep -n "markdownToProfile" -B 12 -A 12 src/components/profile/ProfileDialog.jsx`

Apply the same detect-then-ask rule: parse with the new default (ungrouped), compute what grouping would produce, prompt only when at least one run of 2+ would form, and use the grouped array only if the user says yes:

```js
      const imported = markdownToProfile(text);
      const entries = Array.isArray(imported?.workExperience) ? imported.workExperience : [];
      const grouped = assignGroupIds(entries);
      const runCount = groupExperience(grouped).filter((g) => g.roles.length > 1).length;
      if (runCount > 0) {
        const ok = await confirmDestructive({
          title: runCount === 1
            ? '1 employer has more than one role'
            : `${runCount} employers have more than one role`,
          description: 'Group each employer’s roles under a single company heading? Keep them separate if any of them are return stints rather than promotions.',
          actionLabel: 'Group',
        });
        if (ok) imported.workExperience = grouped;
      }
```

Add `import { assignGroupIds, groupExperience } from '../../experienceGroups.js';` and `confirmDestructive` if not already imported. The enclosing handler must be `async` — check, and make it so if it is not.

- [ ] **Step 7: Run the gates**

Run: `npm run test && npx vite build && npm run lint`
Expected: full suite green; build exit 0; 0 lint errors.

- [ ] **Step 8: Verify the detect-then-ask rule**

Two checks, reported with real output:

1. A markdown résumé with NO adjacent same-company entries imports with no dialog at all. Prove it by asserting on the parsed result plus the fact that `groupExperience` finds no run of 2+ — no dialog can be triggered when the run list is empty.
2. A markdown résumé WITH two adjacent same-company entries produces exactly one candidate run, so the prompt is reached.

Both are testable at the module level without a browser, because the detection is a pure computation over the parsed data. Write them as a temporary probe, report the output, and do not commit the probe.

- [ ] **Step 9: Commit**

```bash
git add src/parser.js src/profileMarkdown.js src/variantManager.js src/components/profile/ProfileDialog.jsx test/parser.test.js test/profileMarkdown.test.js
git commit -m "feat(import): ask before grouping roles at one employer"
```

---

## Final verification

- [ ] `npm run test` — green.
- [ ] `npm run lint` — 0 errors.
- [ ] `npx vite build` — exit 0.
- [ ] **Rendered**: with the toggle off a 2-role run emits zero group headers and both roles keep an editable company; toggling back on restores exactly one header plus the lead/last markers; the `_groupId` values are unchanged throughout.
- [ ] **Hands-on in `npm run tauri:dev`** on WKWebView, launched **by absolute path**, confirming **Settings → About reads `1.0.0`** first — four bundles on this machine share the frozen `com.resumedesigner.app` identifier and "open by name" resolves to whichever the updater last wrote.
- [ ] In the real app: flip the toggle and confirm the résumé **repaginates** rather than leaving a stale split, then export a **page-by-page PDF at Letter and A4 in both states**.
- [ ] Import a markdown résumé with two adjacent same-company entries and confirm the prompt appears; import one without and confirm it does not.
