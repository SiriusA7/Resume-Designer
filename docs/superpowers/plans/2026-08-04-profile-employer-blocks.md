# Profile Employer Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the profile Experience tab render several positions at one employer as a single employer block — company stated once, roles beneath — so a promotion stops looking like a duplicated job entry.

**Architecture:** `ExperienceTab` stops mapping over entries and maps over `groupExperience(items)`, the same helper the résumé renderer uses. A run of 2+ renders as an employer block (one company field, roles as sub-blocks holding only title/dates/details). A run of one collapses to today's flat card. The data model does not change: `workExperience[]` stays flat with an optional `_groupId`.

**Tech Stack:** React 19, Vite, plain JavaScript (no TypeScript), Tailwind 3 + shadcn/ui, vitest + jsdom, Tauri 2 (WKWebView).

Source spec: [`docs/superpowers/specs/2026-08-04-profile-employer-blocks-design.md`](../specs/2026-08-04-profile-employer-blocks-design.md)

## Global Constraints

- **Never commit, push, or open a PR without being explicitly asked.** Each task ends with a commit step; run it only when the human has approved that task.
- **Conventional commits, subject starts lowercase.** commitlint runs in CI on *every* commit in a PR.
- **Only `resume-designer/src/components/profile/ProfileTabs.jsx` may change.** No other file, in any task.
- **The data model does not change.** `workExperience[]` stays a flat array of `{ id, title, company, dates, details, _groupId? }`. No migration, no new storage key, no `roles[]`.
- **`_groupId` keeps its underscore** — `diffResumeData` skips `key.startsWith('_')`.
- **Group ids are minted fresh per tenure and never reused.**
- **Re-render, never remount.** The company input's blur must use the tab-local `bumpGrouping` reducer. Routing it through `refresh` bumps the parent's remount key and unmounts the pressed button mid-click — a defect already fixed once.
- **Never write to an entry during render.** Ids and group ids are minted only inside event handlers.
- **Revalidate inside the action.** Inputs are uncontrolled, so a control's gating can be stale by the time it is clicked; every handler re-reads `items` at click time.
- **Education, Projects and MoreTab must render byte-identically.** They share `ItemList`/`EntryCard`.
- **`vitest` covers nothing under `src/components/**`.** `npx vite build` is the only automated proof the JSX parses. Rendered verification is mandatory, not optional.

**Note on TDD:** the project has no component test harness (`vitest.config.js` includes only `test/**/*.test.js`; there is no `@testing-library`). Classic red-green TDD is unavailable for this file. Each task therefore ends with a **rendered measurement** step that plays the same role: it must fail before the change and pass after.

---

## File Structure

**Modified — one file only:**

| Region of `ProfileTabs.jsx` | Change |
|---|---|
| New `RoleSubCard` component | A role inside an employer block: title header, dates, details, optional detach action. No company field. |
| New `EmployerBlock` component | Company field once, position count, delete-employer, role sub-blocks, add-role. |
| New `SoloJobCard` component | A run of one: today's flat card (title, company, dates, details) plus add-role and link-above. |
| `ExperienceTab` | Maps over `groupExperience(items)`; owns all handlers. |
| `EntryCard` / `ItemList` | Revert to pre-`5785ecb` signatures once `ExperienceTab` stops using them. |

---

### Task 1: Render employer blocks and collapsed solo cards

The structural change. After this task the editor shows what the résumé prints.

**Files:**
- Modify: `resume-designer/src/components/profile/ProfileTabs.jsx`

**Interfaces:**
- Consumes: `groupExperience(entries)` from `src/experienceGroups.js`, returning `Array<{ groupId: string|null, company: string, roles: Array<{ entry: object, index: number }> }>` where `index` is the entry's position in the flat array. Also `generateId(prefix)` from `src/store.js`.
- Produces: `RoleSubCard`, `EmployerBlock`, `SoloJobCard` components, and an `ExperienceTab` that renders groups. Task 2 adds employer delete + company fan-out to these. Task 3 removes the now-dead `ItemList` props.

- [ ] **Step 1: Capture the "before" measurement**

This is the failing check. Start the dev server and render the current component with a two-role run, then record that the second card still carries a company input.

Run the dev server (`.claude/launch.json` defines `on-paper-dev` on port 3000). In the page, dynamically import `ProfileTabContent` from `/src/components/profile/ProfileTabs.jsx`. React and react-dom are pre-bundled by Vite — discover their URLs by fetching the transformed module source and reading its import specifiers; a bare `"react"` will NOT resolve in the browser console. Do NOT enter an API key; hide the onboarding overlay and render into your own container.

Fixture:

```js
const G = 'grp-x';
const profile = { workExperience: [
  { id:'a1', title:'Senior AR Prototype Engineer', company:'Magic Leap', dates:'2021 - Present', details:'', _groupId:G },
  { id:'a2', title:'AR Prototype Engineer', company:'Magic Leap', dates:'2019 - 2021', details:'', _groupId:G },
  { id:'b1', title:'Junior Designer', company:'Northwind', dates:'2017 - 2018', details:'' },
]};
```

Record and report: the number of inputs whose `placeholder` is `"Company"` (expected: **3** — one per card, the bug), and the number of elements matching `.rounded-\[10px\]` (expected: **3** cards).

- [ ] **Step 2: Add the three new components**

In `resume-designer/src/components/profile/ProfileTabs.jsx`, insert these immediately **above** `function ExperienceTab(`:

```jsx
// ── Experience: employer blocks ─────────────────────────────────────────
// The résumé prints several positions at one employer as a company header with
// dated roles beneath. These render the same shape in the editor, so the two
// surfaces agree. A run of ONE collapses to SoloJobCard — nesting appears only
// where a progression exists, so it means something.

// One role inside an employer block. Deliberately has NO company field: the
// block states the employer once, so there is nothing to repeat and nothing to
// get out of sync.
function RoleSubCard({ exp, index, set, onDelete, onDetach, canDetach }) {
  return (
    <div className="space-y-2.5 rounded-[8px] border bg-background/40 p-2.5">
      <div className="flex items-center gap-2.5">
        <Input
          className="font-medium" placeholder="Job title"
          defaultValue={exp.title || ''}
          onChange={(e) => set(index, 'title')(e.target.value)}
        />
        <Button
          type="button" variant="ghost" size="icon"
          title="Delete role" aria-label="Delete role"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        placeholder="Dates (e.g., Jan 2020 - Present)"
        defaultValue={exp.dates || ''}
        onChange={(e) => set(index, 'dates')(e.target.value)}
      />
      <Textarea
        rows={4}
        placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
        defaultValue={stripEmphasis(exp.details)}
        onChange={(e) => set(index, 'details')(e.target.value)}
      />
      {canDetach && (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <Button
            variant="outline" size="sm" type="button" className="h-7 text-xs"
            onClick={onDetach}
          >
            Make this its own employer
          </Button>
        </div>
      )}
    </div>
  );
}

// A run of 2+: the employer stated once, its roles beneath.
function EmployerBlock({ group, set, onCompanyChange, onCompanyBlur, onAddRole, onDeleteRole, onDetachRole, onDeleteEmployer }) {
  return (
    <div className="space-y-2.5 rounded-[10px] border bg-card p-[13px]">
      <div className="flex items-end gap-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label className="text-xs text-muted-foreground">Employer</Label>
          <Input
            className="font-semibold" placeholder="Company"
            defaultValue={group.company}
            onChange={(e) => onCompanyChange(group, e.target.value)}
            onBlur={onCompanyBlur}
          />
        </div>
        <span className="shrink-0 whitespace-nowrap pb-2 text-[11.5px] font-medium text-muted-foreground">
          {group.roles.length} positions
        </span>
        <Button
          type="button" variant="ghost" size="icon"
          title="Delete employer" aria-label="Delete employer"
          className="mb-0.5 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDeleteEmployer(group)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-2">
        {group.roles.map((role, position) => (
          <RoleSubCard
            key={role.entry.id || `role-${role.index}`}
            exp={role.entry}
            index={role.index}
            set={set}
            onDelete={() => onDeleteRole(role.index)}
            onDetach={() => onDetachRole(role.index)}
            canDetach={position > 0}
          />
        ))}
      </div>
      <Button
        variant="outline" size="sm" type="button" className="h-7 w-full text-xs"
        onClick={() => onAddRole(group)}
      >
        <Plus className="h-3.5 w-3.5" /> Add role at this company
      </Button>
    </div>
  );
}

// A run of ONE: today's flat card, unchanged in shape. It keeps its own company
// field, because there is no block above it to state the employer.
function SoloJobCard({ exp, index, set, onCompanyBlur, onAddRole, onDelete, onLinkAbove, canLinkAbove, showLinkAbove }) {
  const canAddRole = !!(exp.company || '').trim();
  return (
    <div className="space-y-2.5 rounded-[10px] border bg-card p-[13px]">
      <div className="flex items-center gap-2.5">
        <Input
          className="font-medium" placeholder="Job title"
          defaultValue={exp.title || ''}
          onChange={(e) => set(index, 'title')(e.target.value)}
        />
        {canAddRole && (
          <Button
            variant="outline" size="sm" type="button" className="h-7 shrink-0 text-xs"
            title="Add role at this company"
            onClick={() => onAddRole(index)}
          >
            <Plus className="h-3.5 w-3.5" /> Add role
          </Button>
        )}
        <Button
          type="button" variant="ghost" size="icon"
          title="Delete" aria-label="Delete"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        placeholder="Company"
        defaultValue={exp.company || ''}
        onChange={(e) => set(index, 'company')(e.target.value)}
        onBlur={onCompanyBlur}
      />
      <Input
        placeholder="Dates (e.g., Jan 2020 - Present)"
        defaultValue={exp.dates || ''}
        onChange={(e) => set(index, 'dates')(e.target.value)}
      />
      <Textarea
        rows={4}
        placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
        defaultValue={stripEmphasis(exp.details)}
        onChange={(e) => set(index, 'details')(e.target.value)}
      />
      {showLinkAbove && (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <Button
            variant="outline" size="sm" type="button" className="h-7 text-xs"
            disabled={!canLinkAbove}
            title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
            onClick={() => onLinkAbove(index)}
          >
            Link to company above
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Replace `ExperienceTab`'s body**

Replace the whole of `function ExperienceTab(...) { ... }` with:

```jsx
function ExperienceTab({ profile, scheduleSave, refresh }) {
  const items = profile.workExperience;
  const set = (i, field) => (v) => { items[i][field] = v; scheduleSave(); };
  // Local re-render ONLY, to re-derive the grouping after a company edit. It must
  // not go through `refresh`: that bumps the parent's `version`, which is the tab
  // wrapper's React key, so blurring the company input would remount the tab and
  // unmount the button being pressed before its click fired.
  const [, bumpGrouping] = useReducer((n) => n + 1, 0);
  const groups = groupExperience(items);
  const rewrite = (next) => { items.splice(0, items.length, ...next); refresh(); };

  // Splice a new role after the run's LAST member, carrying the run's id and
  // company. Walks `items` at click time — the company input is uncontrolled, so
  // a render-time bound can point past a boundary just typed into existence.
  const addRoleAt = (leadIndex) => {
    const lead = items[leadIndex];
    if (!lead) return;
    const company = (lead.company || '').trim();
    if (!company) return;
    const id = lead._groupId || generateId('grp');
    let last = leadIndex;
    if (lead._groupId) {
      while (last + 1 < items.length) {
        const entry = items[last + 1];
        if (!entry || entry._groupId !== lead._groupId || entry.company !== lead.company) break;
        last += 1;
      }
    }
    const next = [...items];
    if (!next[leadIndex]._groupId) next[leadIndex] = { ...next[leadIndex], _groupId: id };
    next.splice(last + 1, 0, {
      id: generateId('exp'), title: '', company: lead.company, dates: '', details: '', _groupId: id,
    });
    rewrite(next);
  };

  // Detach a role into its own employer. Trailing members of the SAME run follow
  // it, so detaching the middle role of a 3-role block yields [A] + [B,C] rather
  // than orphaning C.
  const detachRole = (index) => {
    const cur = items[index];
    if (!cur) return;
    const oldId = cur._groupId;
    const freshId = generateId('grp');
    const next = [...items];
    next[index] = { ...next[index], _groupId: freshId };
    for (let k = index + 1; k < next.length; k += 1) {
      const entry = next[k];
      if (!oldId || entry._groupId !== oldId || entry.company !== cur.company) break;
      next[k] = { ...entry, _groupId: freshId };
    }
    rewrite(next);
  };

  // Merge this entry into the employer above. Never writes `company` — copying a
  // neighbour's name is how a role gets filed under an employer the user never
  // worked for. The clicked entry's trailing run members come with it.
  const linkAbove = (index) => {
    const cur = items[index];
    const above = items[index - 1];
    if (!cur || !above || !above.company || above.company !== cur.company) return;
    const id = above._groupId || generateId('grp');
    const oldId = cur._groupId;
    const next = [...items];
    next[index - 1] = { ...above, _groupId: id };
    next[index] = { ...cur, _groupId: id };
    for (let k = index + 1; k < next.length; k += 1) {
      const entry = next[k];
      if (!oldId || entry._groupId !== oldId || entry.company !== cur.company) break;
      next[k] = { ...entry, _groupId: id };
    }
    rewrite(next);
  };

  const deleteEntry = (index) => { items.splice(index, 1); refresh(); };

  return (
    <section>
      <SectionHeader
        title="Detailed work experience"
        description="Add details beyond what's on your resume - challenges faced, technologies used, team size, impact metrics, lessons learned. Several positions at one employer sit together under a single company heading."
      />
      <div className="space-y-3">
        {items.length === 0 ? (
          <Empty title="No experience entries yet" subtitle="Add detailed information about your work history" />
        ) : (
          groups.map((group) => {
            const lead = group.roles[0];
            if (group.roles.length > 1) {
              return (
                <EmployerBlock
                  key={lead.entry.id || `emp-${lead.index}`}
                  group={group}
                  set={set}
                  onCompanyChange={() => {}}
                  onCompanyBlur={bumpGrouping}
                  onAddRole={(g) => addRoleAt(g.roles[0].index)}
                  onDeleteRole={deleteEntry}
                  onDetachRole={detachRole}
                  onDeleteEmployer={() => {}}
                />
              );
            }
            const i = lead.index;
            const prev = i > 0 ? items[i - 1] : null;
            return (
              <SoloJobCard
                key={lead.entry.id || `exp-${i}`}
                exp={lead.entry}
                index={i}
                set={set}
                onCompanyBlur={bumpGrouping}
                onAddRole={addRoleAt}
                onDelete={() => deleteEntry(i)}
                onLinkAbove={linkAbove}
                canLinkAbove={!!prev && !!prev.company && prev.company === lead.entry.company}
                showLinkAbove={i > 0}
              />
            );
          })
        )}
        <AddButton
          onClick={() => {
            items.push({ id: generateId('exp'), title: '', company: '', dates: '', details: '' });
            refresh();
          }}
        >
          Add experience entry
        </AddButton>
      </div>
    </section>
  );
}
```

`onCompanyChange` and `onDeleteEmployer` are deliberate no-ops here; Task 2 implements them. Everything else is functional after this task.

- [ ] **Step 4: Run the automated gates**

Run: `npm run test`
Expected: `Test Files 56 passed (56)`, `Tests 764 passed (764)` — no regressions.

Run: `npx vite build`
Expected: exit 0. This is the only automated proof the JSX parses.

Run: `npm run lint`
Expected: 0 errors (2 pre-existing warnings in `chat/DeleteVariantThreadsDialog.jsx` and `chat/useChat.js`).

- [ ] **Step 5: Re-measure — the check from Step 1 must now pass**

Render the identical fixture from Step 1 and report:

- inputs with `placeholder="Company"` → expected **2**, not 3 (the employer block has one; the Northwind solo card has one; the second Magic Leap role has none).
- the employer block contains exactly **2** elements matching `.rounded-\[8px\]` (the role sub-cards).
- the block header shows the text `2 positions`.
- the Northwind card is a `.rounded-\[10px\]` card with its own Company input and an `Add role` button.
- an entry with an empty company shows **no** `Add role` button.
- **Long-name check:** re-render with the company `International Business Machines Corporation` and report the width of the job-title input inside each role sub-card and whether the block header overflows (`scrollWidth > clientWidth`). The title input must stay above 250px and the header must not overflow.

- [ ] **Step 6: Commit**

```bash
git add resume-designer/src/components/profile/ProfileTabs.jsx
git commit -m "feat(profile): render one employer block per company"
```

---

### Task 2: Employer-level delete and the shared company field

Completes the two handlers Task 1 stubbed.

**Files:**
- Modify: `resume-designer/src/components/profile/ProfileTabs.jsx`

**Interfaces:**
- Consumes: `EmployerBlock`'s `onCompanyChange(group, value)` and `onDeleteEmployer(group)` props from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Add the `confirmDestructive` import**

`ProfileTabs.jsx` does not currently import it. Add it alongside the other `@/components/ui` imports:

```jsx
import { confirmDestructive } from '@/components/ui/confirm';
```

Verify the export exists first:

Run: `grep -n "export function confirmDestructive" resume-designer/src/components/ui/confirm.jsx`
Expected: one hit — `export function confirmDestructive({ title, description, actionLabel = 'Confirm', destructive = true })`.

- [ ] **Step 2: Implement the two handlers**

In `ExperienceTab`, add these next to the other handlers:

```jsx
  // The block shows ONE company field for the whole employer, so an edit applies
  // to every role in it. Mutates in place like `set` does — the inputs are
  // uncontrolled, so no re-render is needed per keystroke, and the run rule stays
  // satisfied because every member changes together.
  const setGroupCompany = (group, value) => {
    for (const role of group.roles) items[role.index].company = value;
    scheduleSave();
  };

  // Removes several entries at once, so it asks first. Splices by descending
  // index so earlier removals cannot shift the ones still to come.
  const deleteEmployer = async (group) => {
    const count = group.roles.length;
    const ok = await confirmDestructive({
      title: `Delete ${group.company || 'this employer'}?`,
      description: `All ${count} positions at this employer will be permanently removed from your profile.`,
      actionLabel: 'Delete',
    });
    if (!ok) return;
    const next = [...items];
    const indices = group.roles.map((r) => r.index).sort((a, b) => b - a);
    for (const idx of indices) next.splice(idx, 1);
    rewrite(next);
  };
```

- [ ] **Step 3: Wire them into `EmployerBlock`**

In the `groups.map(...)` branch that renders `EmployerBlock`, replace the two stubs:

```jsx
                  onCompanyChange={setGroupCompany}
                  onDeleteEmployer={deleteEmployer}
```

- [ ] **Step 4: Run the automated gates**

Run: `npm run test && npx vite build && npm run lint`
Expected: 764 tests passing across 56 files; build exit 0; 0 lint errors.

- [ ] **Step 5: Verify by rendering**

Using the same harness and fixture as Task 1 Step 1:

- Type a new company into the block's Employer field, then read `profile.workExperience` and confirm **both** Magic Leap entries now carry the new value and still share one `_groupId` — i.e. the block did not split.
- Click the block's Delete-employer button and confirm a confirmation dialog appears naming **2 positions**; cancel it and confirm `workExperience` still has 3 entries.
- Confirm the delete on an individual role sub-card removes only that entry.

Report the actual array contents after each, not a summary.

- [ ] **Step 6: Commit**

```bash
git add resume-designer/src/components/profile/ProfileTabs.jsx
git commit -m "feat(profile): rename or delete a whole employer at once"
```

---

### Task 3: Remove the dead list slots

`ExperienceTab` no longer uses `ItemList`, so the props added for it are dead.

**Files:**
- Modify: `resume-designer/src/components/profile/ProfileTabs.jsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EntryCard` and `ItemList` back at their pre-`5785ecb` signatures.

- [ ] **Step 1: Confirm the props really are dead**

Run: `grep -n "headerExtra\|itemClassName\|renderHeaderExtra" resume-designer/src/components/profile/ProfileTabs.jsx`
Expected: hits **only** inside the `EntryCard` and `ItemList` definitions — no call site passes them. If any caller still does, stop and report rather than deleting.

- [ ] **Step 2: Revert `EntryCard`**

```jsx
// One entry card: a title Input + ghost-destructive trash in the header row,
// then the body fields beneath. Mirrors the spec's `rounded-lg border bg-card`.
function EntryCard({ titleInput, onDelete, children }) {
  return (
    <div className="space-y-2.5 rounded-[10px] border bg-card p-[13px]">
      <div className="flex items-center gap-2.5">
        {titleInput}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Delete"
          aria-label="Delete"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Revert `ItemList`**

```jsx
// Generic add/delete list of entry cards.
function ItemList({ items, emptyTitle, emptySubtitle, addLabel, onAdd, onDelete, renderTitle, renderBody }) {
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <Empty title={emptyTitle} subtitle={emptySubtitle} />
      ) : (
        items.map((item, i) => (
          <EntryCard key={item.id || `row-${i}`} titleInput={renderTitle(item, i)} onDelete={() => onDelete(i)}>
            {renderBody(item, i)}
          </EntryCard>
        ))
      )}
      <AddButton onClick={onAdd}>{addLabel}</AddButton>
    </div>
  );
}
```

- [ ] **Step 4: Check whether `cn` is still used**

Removing `className` from `EntryCard` may orphan the `cn` import.

Run: `grep -c "cn(" resume-designer/src/components/profile/ProfileTabs.jsx`
If the count is 0, remove `import { cn } from '@/lib/utils';`. If it is above 0, leave the import — `SectionHeader` uses it. Report which case applied.

- [ ] **Step 5: Run the automated gates**

Run: `npm run test && npx vite build && npm run lint`
Expected: 764 tests passing across 56 files; build exit 0; 0 lint errors.

- [ ] **Step 6: Prove Education, Projects and MoreTab are byte-identical**

The strongest available check, and the one that matters for shared components: render the tabs to static markup at `HEAD` and at `HEAD~1` and diff them.

Create two throwaway git worktrees (one at `HEAD`, one at `HEAD~1`), symlink `node_modules` into each, and render `ProfileTabContent` for tabs `education`, `projects` and `more` to a string via `react-dom/server` under a vitest run configured with the React plugin and the `@` alias. Use one seeded profile with at least two entries per tab. Byte-diff the two dumps.

Expected: **zero** differences for education, projects and more. Report the diff output verbatim. Remove both worktrees afterwards and confirm `git status --porcelain` in the repo is empty.

- [ ] **Step 7: Commit**

```bash
git add resume-designer/src/components/profile/ProfileTabs.jsx
git commit -m "refactor(profile): drop the list slots the employer blocks replaced"
```

---

## Final verification

Run before offering this for review.

- [ ] `npm run test` — 764 across 56 files, green.
- [ ] `npm run lint` — 0 errors.
- [ ] `npx vite build` — exit 0. The only automated proof every `.jsx` file still parses.
- [ ] **Rendered pass**, covering in one session: a single-role job renders flat; adding a role restructures it into a block with **one** company field; a three-role block detaches its middle role into `[A]` + `[B,C]`; a 40+ character employer name starves nothing; an empty-company entry offers no add-role.
- [ ] **Hands-on in `npm run tauri:dev`** on WKWebView. Launch **by absolute path** and confirm **Settings → About reads `1.0.0`** before trusting anything you see — four bundles on this machine share the frozen `com.resumedesigner.app` identifier, and "open by name" resolves to whichever the updater last wrote. A whole test cycle was already lost to this.
- [ ] Confirm the résumé still renders grouped runs correctly — this plan changes only the profile editor, so any change there is a regression.
