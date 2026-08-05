# Optional position grouping — render toggle and import prompt

**Status:** approved 2026-08-05. Follows on from
[2026-08-03-multiple-positions-same-employer-design.md](2026-08-03-multiple-positions-same-employer-design.md)
and [2026-08-04-profile-employer-blocks-design.md](2026-08-04-profile-employer-blocks-design.md).
Neither is superseded; this makes one of their decisions optional and closes
two review findings against it.

## Why

Two review findings said markdown import should not infer grouping: the
exporter writes no `_groupId`, so a separation the user deliberately made is
destroyed by an export → re-import round trip, and adjacency alone cannot tell
a promotion from a return.

Both are factually correct. Auto-grouping on import was a **deliberate,
recorded choice** — the alternative was that every imported résumé arrives
fully unlinked. The 2026-08-03 spec states the reasoning.

What changed since is that every *other* grouping path has been made
conservative: AI generation is date-gated, profile extraction no longer groups
at all, and neither editor fuses on its own. Markdown import became the last
path inferring grouping from adjacency.

The resolution is to stop choosing on the user's behalf in either direction:
**ask at import**, and let the grouped presentation itself be **switched off**.

## Two halves, deliberately separate

These sit on opposite sides of the line this feature has been drawing
throughout:

- The **render toggle** is presentation. Reversible, destroys nothing, safe to
  default on.
- The **import prompt** is data. It decides which `_groupId`s exist, which is
  why it must ask rather than infer.

Keeping them apart is what lets the toggle default to "on" without that being a
guess about the user's history.

## Part 1 — render toggle

### Storage

A new per-résumé field `groupPositions` on the résumé data object, following the
existing `toolsDisplay` precedent exactly: written with
`store.update('groupPositions', …)`, read by a small renderer helper.

Read as `data?.groupPositions !== false`. **Absence means grouped**, so there is
no migration, no new storage key, and no existing résumé changes behaviour.
Only an explicit `false` turns grouping off.

Per-résumé, not global — matching layout, accent and `toolsDisplay`. One résumé
may group while another does not.

### Rendering

`renderExperienceEntries(experience, variant)` becomes
`renderExperienceEntries(data, variant)`, reading both `data.experience` and the
flag. This is shorter at the 11 call sites, not longer, since they already hold
`data`.

With grouping **off**, every entry renders as a run of one: the flat card, its
own `.experience-company` with `data-editable`, no `.experience-group-header`,
and none of `is-grouped` / `is-group-lead` / `is-group-last`. Identical to the
pre-feature output.

**`_groupId` is never read, written or cleared by the toggle.** Turning it back
on restores every group exactly as it was.

### Control

A `Segmented` in the Design tab — "Grouped" / "Separate" — alongside the other
per-résumé design choices.

It **must** dispatch a design change so pagination re-runs. Block heights change
when a run collapses to flat cards, and a stale `.resume-page` split is how
content gets clipped out of the exported PDF.

## Part 2 — import prompt

### Résumé markdown

`parseResume(markdown)` currently calls `assignGroupIds` unconditionally. That
becomes opt-in: `parseResume(markdown, { group = false })`.

`variantManager`'s import path decides whether to ask. It runs the grouper on a
copy first and compares: if no id **would** be minted, there is nothing to
decide and no dialog appears. Only when the file contains adjacent same-company
entries does the user see:

> **2 employers appear with more than one role — group them?**
> [ Group ] [ Keep separate ]

"Keep separate" imports with no `_groupId` on any entry; the user can still link
any pair in one click afterwards.

### Profile markdown

The same treatment for `markdownToProfile` and the Profile dialog's Import
button, with the same detect-then-ask rule.

## Out of scope

No change to AI generation (its date gate is correct and verified), to profile
extraction (which no longer groups at all), to either editor's link/separate
actions, or to the run rule in `src/experienceGroups.js`. No new markdown
grammar: the exported format is unchanged, so a file written by this build still
opens in an older one.

The round trip remains lossy in the sense the findings identified — a deliberate
separation is not encoded in the file — but it is no longer *silently* lossy,
because re-import asks.

## Verification

`vitest` covers service modules but **nothing** under `src/components/**`.

1. `npm run test` — no regressions; new cases for the parse-time `group` option
   and the renderer's flag.
2. `npx vite build` — the only automated proof the JSX parses.
3. **Rendered**: with the toggle off, a 2-role run emits zero group headers and
   both roles keep an editable company; toggling back on restores exactly one
   header and the lead/last markers; `_groupId` values are unchanged throughout.
4. **Hands-on** in `npm run tauri:dev` on WKWebView, launched by absolute path,
   confirming Settings → About reads `1.0.0` first — four bundles on this
   machine share the frozen `com.resumedesigner.app` identifier. Confirm the
   toggle repaginates rather than leaving a stale split, and check a
   page-by-page PDF at Letter and A4 in both states.
