# Experience date picker — structured month ranges

**Status:** approved 2026-08-06. Follows on from
[2026-08-03-multiple-positions-same-employer-design.md](2026-08-03-multiple-positions-same-employer-design.md),
[2026-08-04-profile-employer-blocks-design.md](2026-08-04-profile-employer-blocks-design.md)
and [2026-08-05-optional-position-grouping-design.md](2026-08-05-optional-position-grouping-design.md).
None is superseded. This adds a control those specs did not need and fills in
the machine-readable fields the first of them had to work around.

## Why

Experience dates are typed as free text. The request was a proper selector, but
the field carries a second cost that is not cosmetic.

`startDate` / `endDate` already exist on résumé experience entries. They are
produced only by AI generation ([aiService.js:517](../../../resume-designer/src/aiService.js)
asks the model for `"YYYY-MM"`) and read by two consumers: the sort key's
month-precision fallback ([store.js:54](../../../resume-designer/src/store.js))
and `interval()` in
[experienceGroups.js:97](../../../resume-designer/src/experienceGroups.js), the
gate that stops a return to a former employer fusing into a promotion.

The **profile** has no such fields. That is exactly why
`saveExtractedProfile` records this at
[aiService.js:1572](../../../resume-designer/src/aiService.js):

> The date gate that saves the generation path is unavailable: the profile entry
> shape is `{ title, company, dates, details }`, `dates` is a freeform string,
> and there is no machine-readable signal to gate on.

A picker that emits `YYYY-MM` removes that limitation at the source. The UX ask
and the data-integrity gap have the same fix.

## Shapes, stated once

The two are different and the spec depends on the distinction:

| | Key | Entry |
|---|---|---|
| Profile | `workExperience` | `{ id, title, company, dates, details, _groupId? }` |
| Résumé | `experience` | `{ id, title, company, dates, bullets[], startDate?, endDate?, _groupId? }` |

So `startDate` / `endDate` are **new on the profile side** and **existing but
never user-editable on the résumé side**.

## Decisions

1. **Structured *and* display.** The picker writes `startDate` / `endDate` as
   `YYYY-MM` **and** derives the human `dates` string. Purely additive — every
   existing reader of `dates` is untouched, and `saveUserProfile`
   ([persistence.js:324](../../../resume-designer/src/persistence.js)) spreads
   the profile with no field whitelist, so there is no migration.
2. **Month precision or nothing.** A picked value is always a valid `YYYY-MM`,
   so 100% of picked values are usable by the gate. Year-only conventions
   ("2019 – 2021") go through the freeform escape and get no structured fields,
   exactly as today.
3. **All three surfaces:** Profile Experience tab, Structure panel, and the
   rendered résumé's inline editor.
4. **One trigger, one popover.** The only shape that fits a `<time>` node on the
   rendered page, and therefore the only one that lets a single component serve
   all three surfaces.
5. **The generation prompt consumes them.** The profile serialization passes
   exact intervals so the model copies `2020-01` instead of inferring a month
   from prose.

The freeform escape is **kept**. Existing profiles hold strings like
"Summer 2019"; forcing them through a picker on first touch would be silent data
destruction.

## The data contract

Three fields move as one unit:

```js
{ dates: 'Jan 2020 – Present', startDate: '2020-01', endDate: 'Present' }
```

**R1 — Picking writes all three atomically.** One store write, one undo step,
one re-render. The precedent is the company-rename fan-out at
[inlineEditor.js:861](../../../resume-designer/src/inlineEditor.js), which
writes the whole `experience` array rather than N torn intermediate states.

**R2 — Any freeform edit to `dates` clears `startDate` and `endDate`.** A
hand-edited display string beside a stale machine value is a contradiction, and
the gate would act on the stale one. Clearing returns the entry to
*unstructured*, which `interval()` already handles by failing closed.

R2 has an accepted cost. An AI-generated entry currently keeps month precision
in the sort key by borrowing from `endDate` when the year still matches
([store.js:46-57](../../../resume-designer/src/store.js)). Hand-edit its date
text and that borrow is gone, so it sorts by year alone. This is the correct
outcome — the month is genuinely no longer known — but it is a behaviour change
and must not be reported as a regression.

**Separator** is the en dash `–`, matching both existing seeds
([store.js:599](../../../resume-designer/src/store.js),
[StructurePanel.jsx:308](../../../resume-designer/src/components/structure/StructurePanel.jsx)).
The Profile tab's placeholder text currently shows a hyphen; it is placeholder
copy, not data, and is updated to match.

**Ongoing** is the literal `Present`, already in `isOpenEnded`'s vocabulary
([experienceGroups.js:88](../../../resume-designer/src/experienceGroups.js)) and
already what the generation prompt asks for.

## Core module — `src/experienceDates.js`

Framework-free, top level, beside `experienceGroups.js`. The placement is
load-bearing: **vitest covers only service modules**, so every rule worth proving
must live here rather than in a component.

```js
// A month is { year: number, month: 1-12 }, or null when absent.
// A draft is { start: Month|null, end: Month|null, ongoing: boolean }.

readEntryDates(entry)     // → { start: Month|null, end: Month|null,
                          //     ongoing: boolean, freeform: boolean }
buildDateFields(draft)    // → { dates, startDate, endDate }   the atomic R1 write
freeformDateFields(text)  // → { dates: text, startDate: '', endDate: '' }  the R2 write
formatMonthYear(year, month)  // → 'Jan 2020'
```

`freeform: true` means the entry has no readable structured pair, so the picker
opens with nothing selected and shows the existing `dates` text in its freeform
field. `buildDateFields` returns `null` for a draft with no start, or with
`ongoing: false` and no end — the caller writes nothing rather than a half pair.

`formatMonthYear` uses a **hardcoded month-name table, never
`toLocaleString`**. The formatted string is persisted, so a locale-derived name
would make the same profile serialise differently on different machines — and
the app ships to macOS (WKWebView) and Windows (WebView2). A résumé authored in
one locale would render its dates in another.

`readEntryDates` reads the structured fields when present and reports
`freeform: true` otherwise; it never parses the display string to recover a
month. Recovering structure from prose is precisely what the strict/lenient
split at [experienceGroups.js:66](../../../resume-designer/src/experienceGroups.js)
exists to prevent.

## Control — `src/components/fields/ExperienceDateField.jsx`

Built on the real `Popover` primitive in
[popover.jsx](../../../resume-designer/src/components/ui/popover.jsx). The
trigger is a `Button variant="outline"` showing the formatted range; the panel
holds a Start column (year stepper + 12-month grid), an End column (Present
toggle, then the same), and the freeform input below a `Separator`.

**No `react-day-picker`, no shadcn `Calendar`.** Neither is installed. `Calendar`
is a *day* grid; résumé dates are month-granular, so adding a dependency in order
to suppress most of it would be worse than composing twelve cells on top of
`Popover`. `Popover`, `Button` and `Separator` are the real primitives — the
month grid is app-level composition above them, not a hand-rolled lookalike.

Two behaviours the panel needs:

- **Draft state, commit on close.** Writing through on every click re-renders and
  re-paginates the résumé, destroying the anchor node under an open popover. The
  panel holds a draft and commits once, on close.
- **End months earlier than the chosen start month are disabled.** A reversed
  range makes `interval()` return null, so the picker must not be able to produce
  one.

The trigger replaces the `dates` text input, so freeform entry costs one extra
click: open the popover, type in the field at the bottom. That is the accepted
cost of a control that also fits a `<time>` node on the rendered page. The
freeform field is always present and never disabled — a user who never wants the
grids can ignore them.

## The three hosts

Profile and Structure panel are ordinary React consumers: the field replaces the
`dates` `Input`, and the single-field setter is replaced by an atomic
three-field write per R1.

The inline editor is the one that needs care. `inlineEditor.js` is a
framework-free service module and **stays** framework-free. It gains a
registration hole in the shape
[variantManager.js:225](../../../resume-designer/src/variantManager.js)
established ("injected by the UI so this module stays free of React"):

```js
// inlineEditor.js
export function setDateEditorOpener(fn) { dateEditorOpener = fn; }

// handleClick, before startEditing
if (/^experience\[\d+\]\.dates$/.test(path) && dateEditorOpener) {
  dateEditorOpener({ path, rect: editable.getBoundingClientRect() });
  return;
}
```

A singleton rendered by `App.jsx` registers itself and renders the popover.
Four constraints, all inherited from how the AI button already survives on that
surface:

| Constraint | Why |
|---|---|
| Body-level `position: fixed`; never a DOM child of the date node | Pagination rebuilds the résumé with `replaceChildren`, so a nested overlay is destroyed on the next repaginate and swept into PDF capture |
| Excluded from `handleClick` the way `.editable-ai-container` is | Otherwise a click inside the picker starts a contenteditable edit underneath it |
| Hidden when the anchor scrolls out, via the existing `handleResumeScroll` | Same bounds guard the AI button uses at [inlineEditor.js:673](../../../resume-designer/src/inlineEditor.js) |
| Closed on commit and before export | Keeps it out of the PDF, and avoids the detached-anchor failure that produced the `#11` double-click fix |

Both renderer variants carry the path and both must work: `<time>` at
[renderer.js:675](../../../resume-designer/src/renderer.js) and `<span>` at
[renderer.js:1171](../../../resume-designer/src/renderer.js).

On this surface the write goes through one `store.update('experience', next)`
with all three fields set on the target entry — the company-rename precedent —
not three separate scalar updates. The Profile tab writes to `workExperience`
through its own setter and saves via `saveUserProfile`; R1 binds both.

## Generation prompt

`aiService`'s profile serialization includes the exact interval for entries that
have one, so the model copies `2020-01` rather than inferring. The generation
path already gates grouping on `datesAreContinuous`; this is what makes that gate
reliable rather than lucky. Entries without structured dates serialise exactly as
they do today.

## Out of scope

- **Extraction grouping stays off.** `saveExtractedProfile` is unchanged and the
  comment at [aiService.js:1572](../../../resume-designer/src/aiService.js)
  stands. Re-enabling it would also require tightening the extraction prompt at
  [onboardingLogic.js:88](../../../resume-designer/src/onboardingLogic.js), which
  asks for `"Start Date"` rather than a format — a separate change whose success
  depends on model compliance and cannot be verified without live AI runs.
- **Education dates.** Year-only by convention; a month picker fits them badly.
- **The markdown format.** Profile export still writes `**Dates:** …` and
  nothing more, so structured dates are lost on export → re-import. This is the
  same accepted lossiness as `_groupId`, and the 2026-08-05 spec froze the
  grammar so files written by this build still open in older ones.
- **The path grammar.** `experience[i].dates` remains the AI-addressable path.
  `startDate` / `endDate` are not addressable, matching `_groupId`.
- **`assignGroupIds` defaults.** `canJoin` stays opt-in. The warning at
  [experienceGroups.js:154](../../../resume-designer/src/experienceGroups.js)
  still holds: complete-document callers carry no structured dates, so a
  date-based gate must not become the default.

## Verification

1. `npm run test` — new cases in `test/experienceDates.test.js`: strict
   `YYYY-MM` round trip, the en dash, `Present` handling, locale independence
   (assert the literal `'Jan 2020'`), reversed ranges refused, and R2 clearing.
   The case that matters most is the integration one: `buildDateFields` output
   for two adjacent tenures must satisfy `datesAreContinuous`, asserting that the
   writer and the gate agree.
2. `npx vite build` — the only automated proof the JSX parses; vitest never loads
   `src/components/**`.
3. **Hands-on in `npm run tauri:dev`** on WKWebView, launched by absolute path,
   confirming Settings → About reads `1.0.0` first (several bundles on this
   machine share the frozen `com.resumedesigner.app` identifier). The inline
   surface is the one that can regress the pagination and PDF work that just
   landed, and Chromium preview will not show it. Specifically: open the picker
   on a role near a page break and confirm the résumé still paginates correctly
   after commit; scroll while it is open; and export a page-by-page PDF at Letter
   and A4 with the picker closed, confirming no overlay appears in the output.
