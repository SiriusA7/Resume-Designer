# Profile Experience tab — employer blocks

**Status:** approved 2026-08-04. Follows on from
[2026-08-03-multiple-positions-same-employer-design.md](2026-08-03-multiple-positions-same-employer-design.md),
which this does not change — the data model, the run rule, and every résumé-side
decision stand exactly as specified there.

## The problem

The résumé prints several positions at one employer as a company header with
individually-dated roles beneath. The profile editor does not. It lists one
full-weight card per entry, each with its own **company** field — so a second
role at the same employer restates "Magic Leap" and carries the same four
inputs at the same visual weight as the first.

The user's words: *"It looks like we just duplicated the same experience entry
for the second position."* That is exactly what it looks like, because the thing
being duplicated is the employer.

Two rounds of incremental fixes — moving the add-role control into the card
header, adding a left-edge rail, revising the section copy — improved
discoverability without touching this. They repositioned controls around a
layout whose structure was the actual problem.

### Why it happened

The 2026-08-03 design made grouping a **render-time** concern and kept
`experience[]` flat. That was correct for the résumé, where eleven layouts and
three path-addressing systems depend on the flatness, and it remains correct.

The error was letting the profile *editor* inherit the storage shape as its
visual shape. The résumé renders groups; the editor listed rows. Same data, and
the editor was the one surface with no reason not to show the grouping.

## The design

### Structure

`ExperienceTab` maps over `groupExperience(items)` — the same helper
(`src/experienceGroups.js`) the renderer uses — instead of over entries. Both
surfaces therefore derive their structure from one rule.

A **run of 2+** renders as an **employer block**:

- the **company** field once, at the top of the block, with a muted "N positions"
- each role as a sub-block carrying **title**, **dates**, **details** only —
  no company field, so there is nothing to repeat and nothing to desynchronise
- **+ Add role at \<company\>** inside the block

A **run of one collapses**: it renders as today's flat card — title, company,
dates, details — with no employer wrapper and no nesting. This mirrors the
résumé-side decision: nesting appears only where a real progression exists, so
it *means* something. Most jobs are single-role and should not pay for a header
plus a nested role box.

The visible restructure when a job gains its second role is intentional. It is
the clearest possible signal that two entries have become one employer.

### Data

**Unchanged.** `workExperience[]` stays a flat array of
`{ id, title, company, dates, details, _groupId? }`. No migration, no new
storage key, no schema version. A run is still a maximal set of CONSECUTIVE
entries sharing a non-empty `_groupId` AND the same non-empty `company`.

Group ids stay minted fresh per tenure and are never reused.

### Actions

Each is ONE write (the tab's existing `rewrite(next)`), so each is a single undo
step. All revalidate against the current `items` at click time, because the
inputs are uncontrolled and render-time state can be stale.

| Action | Where | Behaviour |
|---|---|---|
| **+ Add role at \<company\>** | employer block; and on a collapsed single-role card | Splices a new entry after the run's last member, carrying the run's `_groupId` (minting one if the run is a single card) and the company, with a fresh `id`. Requires a non-empty **trimmed** company. |
| **Make this its own employer** | every role except the block's first | Mints a fresh id for that role **and every trailing member of the same run**, so detaching the middle role of a three-role block yields `[A]` + `[B,C]` rather than orphaning C. |
| **Delete role** | each role sub-block | Removes that entry. Removing the last remaining role removes the employer with it. |
| **Delete employer** | employer block header | Goes through `confirmDestructive` naming the count — "Delete Magic Leap and its 2 positions?" — because it removes several entries at once. Requires adding the `confirmDestructive` import to `ProfileTabs.jsx`; it is already used this way in `StructurePanel.jsx`. |
| **Link to company above** | collapsed single-role card, when not the first entry | Merges this entry into the employer above, carrying its own trailing run members with it. Never writes `company` — copying a neighbour's name is how a role gets filed under an employer the user never worked for; the action instead requires the two companies to already match, revalidated at click time. |

**On that last row:** an earlier draft of this table omitted it, which would have
left two separate single-role cards at the same employer with no way to merge —
"+ Add role" creates a *blank* role rather than absorbing the existing card. It
is the only path from two imported-but-ungrouped entries to one block, so it
stays.

**Company edits fan out.** The single company field writes to every role in the
run in one write. This matches the résumé's company header, which already
behaves this way. Consequence, accepted: two roles in one group cannot hold
differing company spellings, which the flat model technically permits. That
state is unreachable through this UI and self-heals — the run rule requires
equal companies, so a divergent entry simply drops out of the run and renders on
its own.

### Components

`ExperienceTab` **stops using the generic `ItemList`**. Education (`:556`),
Projects (`:592`) and MoreTab's custom sections (`EntryCard` at `:679`) keep it
and must render byte-identically.

This **removes the `renderHeaderExtra` and `itemClassName` props** added in
`5785ecb`, along with `EntryCard`'s matching `headerExtra` and `className`
slots. Verified: `ExperienceTab` is their only consumer — Education and Projects
pass neither, and MoreTab's direct `EntryCard` passes neither — so once
`ExperienceTab` stops using `ItemList`, all four are dead and revert to the
pre-`5785ecb` signatures.

Bending a shared two-tab list component into a two-level renderer would couple
Education and Projects to a structure neither has.

### Constraints carried forward

These are load-bearing and were each established by a defect:

- **Re-render, never remount.** The company input's blur must keep using the
  tab-local `bumpGrouping` reducer. Routing it through `refresh` bumps the
  parent's remount key and unmounts the pressed button mid-click.
- **Never write during render.** Ids and group ids are minted only in event
  handlers.
- **Revalidate in the action.** `localEdit`-style suppression means a control's
  gating can be stale when clicked; every handler re-reads current data.
- `_groupId` keeps its underscore — `diffResumeData` skips `key.startsWith('_')`.

### Out of scope

No drag reordering in the profile (it has none today). No change to the résumé
renderer, pagination, markdown, or the AI prompts. No change to
`src/experienceGroups.js`.

## Verification

`vitest` covers nothing under `src/components/**`, so the suite cannot prove any
of this. The gate is:

1. `npm run test` — no regressions (764 across 56 files).
2. `npx vite build` — the only automated proof the JSX parses.
3. **Render the component and measure**, as with the previous round: confirm a
   single-role job renders flat; that adding a role restructures it into a block
   with one company field; that a long employer name (40+ chars) does not starve
   the title input or push controls outside the card; and that Education and
   Projects render byte-identically to before.
4. Hands-on in `npm run tauri:dev` on WKWebView — **launched by absolute path**,
   confirming Settings → About reads `1.0.0`, because four bundles on this
   machine share the frozen `com.resumedesigner.app` identifier and "open by
   name" resolves to whichever the updater last wrote.
