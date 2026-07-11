# Resume Library: search, details, and application outcome tracking

**Date:** 2026-07-10
**Status:** Approved design, pending implementation plan
**Scope:** Phase 1 (this spec, fully specified) + Phase 2 (committed direction, detailed later)

## Problem

Past resumes are only reachable through the header dropdown (name + updated
date). There is no way to search them, no detail view, no record of which
job(s) a resume was tailored for, and no way to track application outcomes
(heard back / interview / offer). User feedback asked for search; this design
adds search plus the quality-of-life layer around browsing and outcome
tracking.

A key gap in the current data model: tailoring (JobsDialog `handleTailor`)
runs against active job descriptions but never records which ones onto the
variant. The resume↔job link must be captured at tailor time; it cannot be
reconstructed retroactively.

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Outcome tracking unit | New first-class **application** record (resume + job + status), not fields on the variant or JD |
| Primary UI surface | Dedicated **Library dialog**; header dropdown stays for quick switching |
| Search scope | Tiered: default name + job/company; opt-in deep search over resume content, JD text, chat threads |
| Status model | Pipeline (`prepared → applied → heard_back → interview → offer`) + terminal states (`rejected`, `no_response`), every transition timestamped |
| Capture flow | Auto-draft application(s) on tailor, plus manual "Add application" fallback in the detail view |
| Build order | Two phases: Phase 1 data layer + library dialog; Phase 2 timeline + metrics |
| Preview | Live scaled DOM render of the selected resume's first page (no thumbnail cache) |

## Phase 1

### Data model: `src/applications.js`

New framework-free service module, peer of `jobDescriptions.js` /
`chatThreads.js`, persisting an array under its own `appStorage` key
`resume-designer-applications`.

```js
{
  id: 'app-...',
  variantId,            // resume used
  variantName,          // snapshot at creation (survives variant deletion)
  jobId,                // link into jobDescriptions store; nullable
  jobSnapshot: { title, company },  // snapshot (survives JD deletion)
  status: 'prepared' | 'applied' | 'heard_back' | 'interview'
        | 'offer' | 'rejected' | 'no_response',
  statusHistory: [{ status, at }],  // append-only, one entry per transition
  createdAt, appliedAt, updatedAt,  // appliedAt null until status >= applied
  notes: ''
}
```

Rationale:

- **Snapshots** (`variantName`, `jobSnapshot`): JDs and variants are
  deletable; snapshots keep application history intact with no foreign-key
  enforcement. `jobId` remains for deep-linking while the JD exists.
- **`statusHistory`**: every transition timestamped means Phase 2's timeline
  and duration metrics require no new data. Setting a status appends and
  updates the `status` field.
- **`prepared`**: the auto-draft state. Prepared records that never advance
  are visually muted and excluded from outcome metrics.

API surface: `getApplications()`, `getApplicationsForVariant(variantId)`,
`addApplication(fields)`, `setApplicationStatus(id, status)`,
`updateApplication(id, patch)` (notes etc.), `deleteApplication(id)`,
plus a change-subscription hook consistent with existing stores.

### Capture

- **Auto-draft on tailor:** JobsDialog `handleTailor` creates one `prepared`
  application per active JD, linking the tailored variant.
  - Re-tailoring the same variant against the same JD while the application
    is still `prepared` **updates** the existing record (bump `updatedAt`),
    not a duplicate. Once status is `applied` or later, a re-tailor creates a
    **new** record (a genuinely new send).
- **Manual fallback:** "Add application" in the detail view — pick an
  existing JD or type title/company inline, set applied date. Covers sends
  that never went through tailoring.

### Library dialog: `src/components/library/LibraryDialog.jsx`

Entry points: a "Library" control in the header next to the variant
dropdown, and a "View all…" footer row inside the existing dropdown. Built
from real shadcn primitives in `components/ui/` (Dialog, Command, Badge,
Select/stepper) — no hand-rolled lookalikes.

Wide two-pane layout (SettingsDialog-scale):

**Left pane — search + list**
- Search input at top.
- Rows sorted by `updatedAt` desc: variant name, relative date, and up to
  ~2 application chips (`Company · Status`, color-coded by status: muted =
  prepared, warm = heard_back/interview, green = offer, gray =
  rejected/no_response) with `+N` overflow.
- Filter chips above the list: by status (e.g. only interview+), and
  "has application / untracked" toggle. No date-range filter in Phase 1.

**Right pane — detail view of selected resume**
- **Preview:** live scaled-down DOM render of the first page using the
  existing HTML render pipeline, rendered only for the selected item. No
  caching, no image generation.
- **Applications:** one card per application — job title @ company, applied
  date, current status as a one-click inline stepper/select (advance stage
  or set terminal state), notes field, link to full JD if it still exists.
  "Add application" button (manual fallback).
- **Meta:** created/updated dates, linked chat threads (via existing
  `homeVariantId`), actions reusing existing variant operations: Open,
  Duplicate, Rename, Delete.

### Search behavior

- **Quick (default):** instant substring/fuzzy match on variant name +
  linked application job title/company. In-memory, per keystroke.
- **Deep (opt-in):** a "Search everything" toggle, also auto-offered when
  quick search returns nothing ("No name matches — search inside
  resumes?"). Additionally scans:
  - flattened resume body text (from the variant `data` object),
  - linked JD `description` text,
  - that resume's chat thread messages (last-50 persistence limit applies).
- Deep matches render a one-line snippet with the hit highlighted and a
  source tag: `in resume` / `in job description` / `in chat`.
- All scans are in-memory over the loaded stores; no index, no persistence.
  Revisit only if data volume ever makes this slow (single-user app —
  unlikely).

### Edge cases

- Delete JD or variant → applications persist via snapshots.
- Delete application → confirm dialog; also offered when deleting a
  `prepared` draft.
- Storage: new key, additive only; no migration of `resume-designer-data`.
- Existing resumes have no application links (link is captured at tailor
  time going forward); they appear as "untracked" and can be linked via the
  manual fallback.

### Testing (vitest, `resume-designer/test/`)

- `applications.js`: CRUD; transitions append to `statusHistory`; `appliedAt`
  set on first `applied`; snapshot integrity after JD/variant deletion;
  dedupe-on-retailor rule (prepared updates vs. post-applied duplicates).
- Search: tiered matching, quick-vs-deep hit classification, snippet
  extraction, empty query.
- Capture: tailor with N active JDs creates/updates N prepared records.
- UI verified in `npm run tauri:dev` (WebKit is the shipping engine;
  ClaudePreview Chromium is not sufficient for layout-heavy dialog work).

## Phase 2 (committed direction, spec'd later)

- **Timeline tab** in the Library dialog: horizontal time axis, one dot per
  application at `appliedAt` (fallback `createdAt`), colored by status;
  click/hover opens the application; `statusHistory` renders as a stage
  progression on hover.
- **Stats strip** (not a dashboard): applications sent, response rate,
  interview rate, median days-to-first-response, per-resume comparison.
  Computed on the fly from `statusHistory` — no new persisted data.

## Out of scope (explicit decisions, not omissions)

- Follow-up reminders / nudges
- Browser-extension or clipboard job capture
- Metrics export
- Cached thumbnails for all list rows (revisit if the list feels blind)
- AI analysis of "why this resume works"
- Multi-user anything
