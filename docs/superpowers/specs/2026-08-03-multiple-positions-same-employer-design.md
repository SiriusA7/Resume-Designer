# Multiple positions at the same employer

**Date:** 2026-08-03
**Status:** Approved design, not yet planned/implemented
**Delivery:** One PR into `next`. The work splits cleanly into commits by
subsystem (grouping helper + renderer, pagination + print CSS, ordering,
Structure panel authoring, markdown import/export, profile field, tests), and
the ordering and pagination commits are independently reviewable because each
fixes a defect that exists today.

## Problem

The app cannot express one employer with more than one position — a promotion, a
lateral move, a contract-to-FTE conversion, or a return after leaving. Both
surfaces are affected:

1. **Profile.** `workExperience` (`profileMarkdown.js:15`) is a flat list of
   `{ title, company, dates, details }`. Two positions at one employer means two
   independent entries that happen to repeat the company string. Nothing records
   that they are the same job.
2. **Résumé.** The same flatness reaches the page. `renderExperience`
   (`renderer.js:598`) emits one `.experience-item` per entry, so a promotion
   prints the employer twice as two apparently unrelated jobs. Total tenure has
   to be mentally summed, and a stable five-year run reads as job-hopping — the
   opposite of the truth.

## Scope

All four real-world cases are in scope, decided explicitly:

- **P1 Promotion** — sequential roles, contiguous dates.
- **P2 Lateral move** — same, without the upward step.
- **P3 Boomerang** — non-contiguous stints at one employer, with other
  employment in between.
- **P4 Concurrent roles** — two titles held at once, or a contract-to-FTE
  conversion, with overlapping date spans.

P3 and P4 are the constraint that decides the data model. Any design collapsing
a group to a single bullet list or a single date span can express P1 and P2 only.

## Chosen presentation

A company header with individually-dated roles nested beneath it, each role
keeping its own bullets — the standard résumé convention:

```
Acme Corporation
    Senior Product Designer                     Mar 2022 – Jun 2024
      · Led the design system rebuild across 4 product lines
    Product Designer                            Jan 2019 – Mar 2022
      · Shipped the mobile checkout redesign

Junior Designer — Northwind Studio              Jun 2017 – Dec 2018
      · Production design for client campaigns
```

**A job where only one role was ever held renders exactly as it does today** —
flat, no header, no indent. The nesting appears only where a real progression
exists, so indentation carries meaning rather than decorating every entry, and
nothing regresses for existing résumés. This was chosen over uniform nesting,
which spends two extra lines and an indent per ordinary job to say one thing.

The header shows the company **name only**. See D4.

## Verified findings that shaped the design

These were established by reading the code, and several overturned working
assumptions. They are recorded because the design only makes sense in their light.

### The résumé is not markdown

The live document is a plain JS object (`EMPTY_RESUME`, `store.js:554`)
persisted as JSON. `parseResume` has exactly two call sites, both in
`persistence.js` — file import (`:1180`) and `migrateBuiltInVariants` (`:1225`),
the latter effectively dead (it fetches `/resumes/*.md`, a directory that does
not exist, and early-returns on Tauri). Markdown is an import edge and an export
edge, nothing more. This lowers the stakes on every markdown grammar decision.

### The markdown round trip is already lossy

The writer emits dates inline on the H3 (`persistence.js:1117`); the reader
expects them on a separate entirely-bold line (`parser.js:157`). So
`{title:'Job Title', company:'Company Name', dates:'Jan 2020 – Present'}`
re-parses with the dates folded into `company` and `dates` empty. There is no
working round trip to preserve, and no test coverage on either side.

### `dates` has three incompatible dash conventions

Hexdump-verified: `aiService.js:516` and `ProfileTabs.jsx:291` emit ASCII hyphen
`0x2d`; `store.js:580` (`EMPTY_RESUME`) and `StructurePanel.jsx:548` (Add
experience) emit en dash `0xe28093`. Any heuristic that splits a `dates` string
on a dash works on the sample résumé and fails on both real-data paths.
Broadening to the hyphen then collides with the app's own `YYYY-MM` convention
(`aiService.js:514`), which `experienceSortValue` (`store.js:50`) already parses
as an internal month marker.

### `itemSel` is a silent whitelist, not a filter

`splittableConfig` (`pagination.js:105-144`) is a closed five-branch class
dispatch. `.experience-section` declares `itemSel: ':scope > .experience-item'`
(or `':scope > .timeline-item'`) — **direct-child** selectors. `makeNode`
collects `wrapEl.querySelectorAll(cfg.itemSel)`, `buildColumnRecursive` appends
only `u.leaf` nodes plus enumerated heads, and `paginateTwo` finishes with
`resumeEl.replaceChildren(pages)`. **Any direct child that is neither a head nor
an `itemSel` match is dropped from the rebuilt tree.** Introducing a
`.experience-group` wrapper would therefore delete every grouped role from the
screen and the exported PDF, with no error — and because `continuous` is the
default page size (`pageSetup.js:22`) and does not restructure, the loss would
only appear once a user selected Letter or A4.

### Sort modes reorder the array destructively

`applySort` (`StructurePanel.jsx:395-411`) rebuilds the whole flat array and
writes it with one `store.update('experience', sorted)`. `date` — the default
mode (`:311`) — sorts by `experienceSortValue` (`store.js:37-60`), which keys on
the **end date only**; `relevance` sorts by `_relevanceRank`.
`applySort('custom')` is an explicit no-op, so a reordered array **is** the saved
data with no UI path back.

### The change pipeline is depth-agnostic; the semantic layer is not

`store.getByPath`, `diffEngine.setByPath`/`getByPath`, `changeApply`,
`changePreview` and `changeSession` all resolve arbitrarily deep paths already.
What encodes the two-level shape is six hand-rolled regexes
(`inlineEditor.js:369`, `:406`, `:473`, `:485`, `useChat.js:91`,
`diffEngine.js:405`) and four independent literal copies of the flat experience
JSON schema in the AI prompts (`aiService.js:115`, `:203`, `:509`,
`onboardingLogic.js:82`). Three of those regexes are unanchored and match only
the first index, so under a nested `roles[]` grammar they would resolve a role
path to the company group and paste `undefined at Acme` into the user's prompt.

### `setByPath` auto-vivifies, so wrong paths corrupt rather than error

`diffEngine.js:351` creates missing intermediates. A model emitting an outdated
path does not fail — it manufactures the field and the bogus record is persisted.

### Every profile write path is unguarded

`saveUserProfile` (`persistence.js:277-282`) is `{ ...DEFAULT_STORAGE.userProfile,
...profile }` — a shape-blind shallow spread — and ProfileDialog's `scheduleSave`
fires on any keystroke in any tab. `saveExtractedProfile` (`aiService.js:1529`)
concatenates unvalidated AI output. `markdownToProfile` (`profileMarkdown.js:131`)
builds from a second shape constant. `getUserProfile` is returned verbatim over
the loopback bridge (`bridgeRoutes.js:60`) to a separately-versioned companion
extension.

### Nothing path-addresses the profile

`workExperience[` has zero hits in `src/`.

## Design

### D1 — Data

`experience[]` stays a **flat array**. Each entry gains exactly one optional
field:

```js
{ id, title, company, dates, bullets: [], _groupId?: string }
```

The underscore prefix is deliberate and load-bearing: `diffResumeData` skips
`key.startsWith('_')` (`diffEngine.js:104`), matching the existing `_expanded`
and `_relevanceRank` convention. Grouping therefore never surfaces as a diff card
showing an opaque generated string, and no AI tailoring pass can clobber it. It
still survives undo/redo, variants and backups, all of which deep-clone the whole
document.

**The path grammar is unchanged.** `experience[2].bullets[0]` means exactly what
it means today. No regex, no AI schema, no prompt, and no consumer of the path
vocabulary changes.

The user profile takes the **same** optional `_groupId` on its existing flat
`workExperience` entries, under the same run rule. Its shape is otherwise
unchanged; see D13.

### D2 — Grouping rule

A **run** is a maximal set of *consecutive* entries sharing the same non-empty
`_groupId` **and** the same non-empty `company` string. An entry failing either
test is a run of one.

`_groupId` is minted fresh per tenure and **never reused**.

Both halves are load-bearing:

- **Fresh ids per tenure** make accidental fusion structurally impossible. P3 is
  two different ids, so deleting, dragging or sorting away the job between two
  boomerang stints cannot merge them into one fabricated tenure.
- **Company equality** is the anti-corruption rule. `changeApply` has no insert
  primitive — only REMOVE splices; everything else is a positional
  `store.update`. An AI asked to insert a role mid-array therefore performs a
  shift-rewrite in place, leaving the group id attached to the index while
  replacing the content. `diffArray` matches by `id` first
  (`diffEngine.js:160-172`), so the entry object genuinely stays with the index.
  Without company equality a foreign employer inherits the header. With it, the
  rewritten entry visibly drops out of the run and renders flat under its own
  company — the corruption self-heals into a signal.

P4 needs no special handling: concurrent roles are two adjacent entries sharing a
`_groupId` whose `dates` strings happen to overlap. The model neither knows nor
cares.

### D3 — Rendering

One shared helper, `groupExperience(entries) -> [{ company, roles: [entry] }]`,
consumed by all 11 layouts (10 through `renderExperience`, `renderer.js:598`; the
timeline through `renderTimelineExperience`, `:1080`). Grouping must live in
exactly one helper or a missed layout silently renders the old flat shape.

**There is no `.experience-group` DOM wrapper.** A run renders as sibling
`.experience-item` (or `.timeline-item`) nodes carrying marker classes:

- The lead role gains `.is-group-lead` plus an extra **first child**
  `<div class="experience-group-header" data-editable="experience[L].company">`.
- Every run member gains `.is-grouped`, which CSS-indents the role content and
  hides its own `.experience-company`. That element stays **in the DOM** — with
  no `data-editable`, so Tab cannot focus an invisible edit target — to serve the
  continuation-page reveal in D6c.
- A run of one renders today's exact markup with no marker classes (the
  single-role requirement).

Avoiding the wrapper is what keeps every role a direct child of
`.experience-section`, which in turn leaves untouched: both pagination `itemSel`
arms, `:last-child` for the entry border (`resume.css:409`) and the timeline
connector (`:1276`), the absolutely-positioned timeline marker gutter (`:1249`),
the one-`SortableItem`-per-entry drag list, and `moveInArray`'s index arithmetic.

**`data-editable` is only ever placed on a node whose path resolves to a
string** — never on a container path.

### D3b — Harden `startEditing` (pre-existing defect)

Independent of this feature: `startEditing` (`inlineEditor.js` ~`:790`) does
`store.get(path)` and, for anything that is not a string, falls through to
`element.textContent = String(sourceValue)`. A `data-editable` carrying a
container path therefore replaces that whole subtree with the literal text
`[object Object]`, makes it contentEditable and selects it; `finishEditing` then
writes that string over the entry object through all three of its branches.
Reachable today by Tab (`handleKeyDown` walks
`querySelectorAll('[data-editable]')`) or a stray click (`handleClick` uses
`closest('[data-editable]')`).

Fix: bail out of edit mode entirely if `store.get(path)` is not a string, number,
`null` or `undefined`. The design should not rely on a naming convention to
prevent data destruction.

### D4 — No derived company span

The company header carries the **name only**. No date range is derived, stored or
rendered on it. Every role beneath already prints its own `dates`.

Deriving a span was considered and rejected on four independent grounds: the
three-way dash mismatch above; the collision with the app's `YYYY-MM` convention
if the split is broadened to the hyphen; the falsity of the
reverse-chronological premise under the shipped `relevance` and `custom` sort
modes, which would print a **false end date on a currently-held role**; and the
absence of any data location for a derived string, which leaves it either inert
to click on a page where everything else edits, or holding a synthetic path that
`setByPath` auto-vivifies into a persisted phantom field.

This feature introduces **no new date parsing anywhere**. `experienceSortValue`
(`store.js:37-60`) remains the codebase's only `dates` parser.

An explicit, editable group span stored on the lead entry remains available as a
later addition if a user asks for it.

### D5 — Company name ownership

`company` continues to live on every entry. The header displays the lead role's
value. Editing the header writes `company` to every entry in the run as **one**
store mutation: build the next array in JS and call `store.update('experience',
next)` once, preceded by `store.setChangeMetadata('Renamed company')`.

`finishEditing` (`inlineEditor.js` ~`:836-852`) is a three-branch if/else where
every branch calls exactly `store.update(path, newValue)` — one path, one write —
so the fan-out has no home today. Inline editing routes to it through a new
branch keyed on a `data-editable-group` DOM attribute listing the run's indices.
That attribute is **DOM metadata, not a store path**, so D1's guarantee holds.

A loop would push history and emit `change` per call (`store.js:182-197`),
costing one undo press and one full re-render per role with torn intermediate
states. `applySort` (`StructurePanel.jsx:410`) already establishes the
single-array-write pattern, so no new store primitive is needed. Every
group-level operation — link, unlink, add role, rename — uses this same one-write
rule and is therefore one undo step.

### D6 — Pagination

The only change to `splittableConfig` is to add `':scope >
.experience-group-header'` as the **first** entry of the `.experience-item`
branch's `head` array (`pagination.js:112-114`). Neither `.experience-section`
`itemSel` arm changes and no `.experience-group` branch is added. Head placement
gives the correct visual order for free.

**D6b — print CSS.** Add
`.experience-group-header { break-after: avoid; page-break-after: avoid; }` to
**both** print.css blocks: the `@media print` block (which Windows PrintToPdf and
browser Cmd+P read) and the `html.pdf-export-mode` mirror. `continuous` is the
default page size and routes to `paginateContinuous`, which does no measuring and
lets the browser break — without this rule a printed page can end on a bare
company name with its roles overleaf, so the *default* configuration would
disagree with the measured path.

**D6c — continuation-page reveal.** When a run splits across a page break, the
employer name repeats. A small post-pagination pass reveals the CSS-hidden
`.experience-company` on the first grouped role of each sheet that is not the run
lead. This is a correctness requirement, not polish: today every entry carries
its own company through a break (`renderer.js:603`), so suppressing it without a
reveal is a strict regression on multi-page résumés — exactly the shape this
feature targets. The element is already rendered and merely hidden, so the pass
needs no head cloning, no `firstOf` changes and no measurement rework.

### D7 — Ordering is run-aware

Every code path that reorders `experience[]` partitions it into runs first,
orders the **runs** (by `max(experienceSortValue)` for `date`, by
`min(_relevanceRank)` for `relevance`), preserves member order inside each run,
then flattens — using the same helper D3 needs.

Two call sites: `applySort` (`StructurePanel.jsx:395-411`) and
`buildResumeData`'s unconditional post-generation sort (`onboardingLogic.js`).

Without this, both shipped sorts deterministically interleave a foreign employer
into a run, D2's adjacency rule silently drops the company header from the
preview and the PDF, and — because `applySort('custom')` is a no-op — the
shredded order becomes the saved data with no way back. `date` is the default
mode, and P4 (contract-to-FTE) is precisely the case that interleaves.

### D8 — Authoring UI

The experience list stays **exactly one level deep**: one `SortableItem` per
entry, one `DndContext`, one `moveInArray`, no nested `SortableList`, no changes
to `Sortable.jsx`.

Rendering a run as a single draggable unit is not an option. `SortableList`
computes `from = ids.indexOf(active.id)` and `to = ids.indexOf(over.id)` over the
**rendered** ids (`Sortable.jsx:37-42`) and `StructurePanel` hands them straight
to `store.moveInArray` (`:414-419`). Today rendered index equals array index;
group containers make them diverge, so dragging the third visible unit above the
second fires `moveInArray(2, 1)` and splices the *array's* index 2 into position
1 — the wrong entry moves, it lands inside the run, and the dragged entry never
moves. `Sortable.jsx` also scopes each list to its own `DndContext` with
`restrictToParentElement` (`:17-22`, `:49`), so a nested role list could not drag
a role out of its group regardless.

Grouping is shown as a **left-edge rail** on run members, with the company name
on the run's lead row. Three actions, each a single `store.update('experience',
next)` with `setChangeMetadata` so each is one undo step:

- **Link to company above** — copies the previous entry's `_groupId`, minting one
  if absent. Disabled at index 0 and when the companies differ.
- **Separate from company above** — mints a fresh id.
- **+ Add role at this company** — on a run's lead row; splices the new entry
  adjacent with the id pre-set. Never push-then-drag, which would be two history
  entries and would route the user through the operation that breaks runs.

A drag that leaves an entry non-adjacent to its run **clears that entry's
`_groupId`**. Self-healing, immediately visible in the rail, and re-linked with
one click.

Two existing contracts the implementation must preserve: collapse state is
persisted on the entry via `store.updateSilent('experience[i]._expanded')`
(`StructurePanel.jsx:230`), and the accordion body stays **mounted** when
collapsed (`:253`) because its inputs are uncontrolled and must keep their DOM
values across toggles. Role rows need stable keys or a delete will show stale
text in the wrong row.

### D9 — Markdown

No new grammar. On import, mint one fresh `_groupId` per maximal run of
consecutive entries with an identical non-empty company — the same predicate the
renderer uses, so import, export and render agree by construction. On export,
emit run members consecutively (order is already preserved).

Auto-grouping was chosen over always-explicit: consecutive same-employer entries
in a reverse-chronological list are a promotion in the overwhelming majority of
cases, false positives (two separate "Freelance" stints) are immediately visible
in both the rail and the rendered header, and undone with one click. Never
auto-grouping means every imported résumé needs manual re-linking.

Because the grammar does not change, a new-format `.md` opened by an older build
degrades perfectly — it simply renders ungrouped.

Two pre-existing defects fixed in the same change, since this design depends on
the import path and adds its first tests to it:

- The reader/writer date asymmetry (`persistence.js:1117` vs `parser.js:157`).
- Parser-built entries have no `id`, so React keys and dnd-kit ids fall back to
  positional (`StructurePanel.jsx:568-570`) for precisely the entries the
  importer will be grouping. Assign `id: generateId('exp')` at construction.

### D10 — Generation

In `buildResumeData` (`onboardingLogic.js`), after the now run-aware sort, mint
one fresh `_groupId` per maximal run of consecutive entries with an identical
non-empty company — the same rule as D9.

Without this, nothing the AI produces is ever grouped and the app's flagship path
cannot satisfy the core requirement. No schema change, no prompt change, and no
reliance on the model understanding grouping.

### D11 — Grouping is UI-only, not AI-addressable

Decided explicitly. The `_` prefix keeps `_groupId` out of the diff engine, so
the AI can neither create nor modify groups. Grouping is a one-time structural
statement about the user's own history, not something a per-job tailoring pass
should rewrite. The flagship generation path still produces groups because D10
writes the field directly.

### D12 — Diff labels

Add `company`, `dates` and `title` to `getPathLabel`'s map
(`diffEngine.js:404-420`), which currently falls through to the raw key and
renders "Experience #2 - company". One-line quality fix that makes a fanned-out
rename legible in review.

Related: `jobRecommendations.findInExperience` (`:210-224`) returns on the first
company match, so a group-wide rename would hit only the lead. Under D2's company
equality this splits the run visibly rather than diverging silently, which is
acceptable; the clean fix is to apply a matched `.company` path across the
matched entry's whole run in a single array write.

### D13 — Profile grouping

The profile carries the same optional `_groupId` under the same D2 run rule
(consecutive entries, same `_groupId`, same `company`). Three consequences:

**Authoring.** `ItemList` (`ProfileTabs.jsx:252`) has no drag reordering — only
add and delete — so none of D8's drag hazards exist here. Each entry card gains
the same two actions, **Link to company above** (disabled at index 0 and when the
companies differ) and **Separate from company above**, plus the same left-edge
rail so membership is visible. A run's lead row gains **+ Add role at this
company**, splicing adjacent, because `onAdd` currently appends to the end
(`ProfileTabs.jsx:283`).

**Prompt serialization.** This is the payoff, and the only reason profile
grouping earns its place. `buildProfileContext` (`aiService.js:645-654`) emits
one `**Title** at **Company** (dates)` line per entry, so today the model must
re-derive from a repeated company string whether two entries are one tenure or
two — and P3 and P4 are exactly where it gets that wrong. Grouped runs instead
emit one company heading with their roles beneath. The change is purely
additive: an entry without `_groupId` serializes exactly as it does now.

**Markdown.** `profileToMarkdown` (`:41`) and `parseWorkExperience` (`:174`) keep
the existing `### Title at Company` grammar. On import, apply D9's rule — mint one
fresh `_groupId` per run of consecutive entries with an identical company.

Both AI schemas (`aiService.js:203-209` extraction, `:509-522` generation) are
**unchanged**. Grouping is applied after extraction by the same rule, consistent
with D11.

## Migration

**None**, for the résumé or the profile. An entry without `_groupId` is already
valid in both. This is deliberate: `migrateSectionAreas` (`store.js:96-112`) is
the prior art here, and `test/sectionAreas.test.js:68-77` documents that
undo/redo snapshots and AI-created content bypass migrations entirely — so any
design requiring one would have to tolerate un-migrated data anyway.

A genuinely nested profile (`workExperience: [{ company, roles: [] }]`) was
designed and then rejected. Because every profile write path is unguarded, a
read-time migration would upgrade the on-disk shape as a side effect of editing a
phone number; and downgrade is a first-class supported path (update-channel
switch, or reinstalling a prior `.dmg`), where an older build reading nested
entries emits `**Position** at **Company**` with no detail from
`aiService.js:648` and `:781` — blanking the entire work history from every
prompt while `accountStats` still reports the entry count — after which
`profileMarkdown`'s placeholder guard drops every entry on the next round trip.
The flat-plus-optional-field approach costs nothing and keeps old builds working,
keeps the bridge wire shape at `bridgeRoutes.js:60` unchanged, and needs no
schema version marker.

## Not building

- **Per-group layout toggle.** Multiplies render paths across 11 layouts for a
  preference nobody has asked for.
- **Nested drag-and-drop.** See D8.
- **AI-addressable grouping.** See D11.
- **Explicit group date spans.** See D4; available later if wanted.

## Verification gate

`vitest.config.js:8` includes only `test/**/*.test.js` and there is no
`@testing-library` dependency, so components are invisible to the suite and a
green run proves nothing about the renderer or the Structure panel. The gate is
therefore:

1. **`test/parser.test.js`** — first ever. Round trip, the grouping predicate,
   and the date asymmetry fix.
2. **Pagination test** — assert every original `data-experience-id` survives
   `flatten` + `buildColumnRecursive` for a **mixed** section (one solo entry
   plus a two-role run), in **both** the flat and timeline shapes. Model it on
   the sidebar-tools case at `test/pagination.test.js:56-110`.
3. **Ordering tests** — run-aware `date` and `relevance` sorts keep runs intact
   and preserve member order.
4. **Grouping helper tests** — P1–P4, plus the company-equality and
   never-reuse rules.
5. **`test/profileMarkdown.test.js`** — also first ever. The `## Work
   Experience` round trip, import-time grouping, and `buildProfileContext`
   emitting a grouped run as one company heading (D13).
6. **`npx vite build`** — the only thing that proves `src/components/**` still
   parses.
7. **`npm run tauri:dev`** — WebKit, hands on. Preview is Chromium; layout and
   scroll behaviour must be confirmed in the real engine.
8. **PDF check, page by page, at Letter and A4** — on both platforms. The
   pagination failure mode this design exists to avoid is invisible at the
   default `continuous` page size.

## Risks

- **The reveal pass (D6c) runs after pagination**, so it must not invalidate
  measurements taken before it. If it proves to disturb layout, the fallback is
  to state explicitly that page 2 shows roles without an employer — but that is a
  regression against today's behaviour and should be a last resort.
- **Timeline is the only bespoke experience renderer** and has the hardest CSS:
  markers are absolutely positioned off `.timeline-item` (`resume.css:1249`) and
  `.timeline-item:last-child .timeline-line { display:none }` (`:1276`) fires on
  the last role rather than the last company once runs exist. Note also that
  `.experience-title-row` (`renderer.js:1089`) and `.timeline-experience`
  (`:1052`) have **no CSS rule anywhere** — inert hooks that will mislead anyone
  who leans on them.
- **`.experience-item` carries a bottom border** (`resume.css:409-418`). If run
  members keep it unmodified, every promotion draws a divider — precisely the
  visual this feature exists to remove.
- **Pre-existing, and made more consequential by D13:** `ItemList` keys profile
  entries by array index (`ProfileTabs.jsx:259`) while their inputs are
  uncontrolled `defaultValue` fields, so deleting a middle entry already leaves
  stale text in the wrong card. Grouping makes entry adjacency meaningful, which
  raises the cost of that bug. Worth fixing with a stable key in the same change;
  called out here because it is not caused by this design.
