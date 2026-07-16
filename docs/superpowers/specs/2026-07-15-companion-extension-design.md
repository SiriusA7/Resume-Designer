# Resume Designer Companion — Chrome extension design

**Date:** 2026-07-15
**Status:** Approved design, not yet planned/implemented
**Audience:** Personal use first, architected to ship as a companion product later.

## Problem

Job application sites make you re-type information that already exists in your
resume and profile: contact details, work history, education, plus the same
twenty oddball questions every company asks (work authorization, notice
period, salary expectations, "how did you hear about us"). Resume Designer
already holds this data in structured form; a Chrome extension should use it,
via AI, to fill application forms — with the user reviewing every value before
it lands and always clicking Submit themselves.

## Decisions (from brainstorm)

- **Audience:** personal first, designed to ship — no architecture that needs
  a rewrite to productize.
- **Fill UX:** review-then-fill. AI proposes values into a side-panel list;
  the user edits, then clicks Fill. Never one-shot fills the page unseen.
- **v1 scope:** text/select/radio fields **plus** resume-PDF attachment to
  file inputs. Cover letters, Workday widget automation, and wizard
  auto-navigation are out (see Non-goals).
- **Bridge:** loopback HTTP server inside the running Tauri app (Option A
  below). The running app is the sole storage writer; the extension is a
  client.
- **AI:** proxied through the app. The OpenRouter key never enters the
  extension.

## Architecture

Three pieces; two live in this repo.

### 1. `extension/` (new top-level directory)

Manifest V3 Chrome extension. Plain JS/JSX + Vite, matching the app's
no-TypeScript convention. Components:

- **Side panel UI** (`sidePanel` API): connection status, resume variant
  picker, the review-then-fill list, unanswered-questions inputs, and the
  "log application" action.
- **Content script:** scans the page's form into compact field descriptors;
  executes the fill; never talks to the network itself.
- **Background service worker:** owns all communication with the bridge;
  relays between side panel and content script.

### 2. Bridge server (new Rust module in `src-tauri`)

Loopback-only HTTP server on `127.0.0.1`, started with the app. Auth: a
pairing token generated in app Settings, pasted once into the extension, sent
as a header on every request. Rationale for in-app server over alternatives:

- **vs. native messaging host:** appStorage's write-behind cache means the
  running app must be the sole writer to the storage files; an external
  binary could not safely create application records. The in-app server keeps
  one writer, needs no second signed binary, and no per-OS manifest
  registration.
- **vs. export/import pack:** live data, no staleness, and enables the
  application-logging and profile-learning loops. (An export pack could later
  become a degraded offline mode.)

Constraint accepted: the app must be running to fill — in practice you have
it open anyway to choose the resume and track the application.

Endpoints (v1):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Connection check for the panel's status indicator |
| `GET /resumes` | List variants (id, name, updated) for the picker |
| `GET /resumes/:id` | Structured resume data + user profile |
| `GET /resumes/:id/pdf` | Freshly exported PDF bytes for file-input attachment |
| `POST /ai/complete` | AI proxy: reuses app model settings + token tracking |
| `POST /applications` | Create an "applied" record via applications.js |
| `POST /profile/answers` | Persist a learned question→answer pair |

### 3. AI mapping call

Request: array of field descriptors + selected resume JSON + user profile +
learned Q&A pairs. Response contract (strict JSON):

```json
{
  "fields": [{ "field_id": "...", "value": "...", "confidence": 0.0, "source": "resume|profile|learned" }],
  "needs_human": [{ "field_id": "...", "question": "..." }]
}
```

`needs_human` covers questions the data genuinely cannot answer; they render
as empty inputs in the review panel.

## Fill flow

1. User opens the side panel on an application page; panel shows bridge
   status and the resume picker (later: pre-select by matching page
   URL/company against stored job descriptions).
2. Content script scans the form. Per field it extracts: label (via
   `label[for]`, `aria-label`, placeholder, nearest text), field type,
   options list (for selects/radios), required flag. Descriptors only — the
   raw DOM never leaves the page.
3. Panel sends descriptors + resume + profile to `POST /ai/complete`; renders
   the review list with inline editing; low-confidence values are flagged;
   `needs_human` fields await typing.
4. **Fill:** content script writes values using the native-setter technique
   (`HTMLInputElement.prototype` value setter, then dispatch `input`/`change`)
   so framework-controlled inputs register the change. File inputs get the
   PDF via `DataTransfer`. Unfillable fields (custom widgets) stay
   highlighted in the panel for manual completion.
5. **The user always clicks Submit.** Auto-submit is a design invariant, not
   a setting.
6. Panel offers "Log application" → `POST /applications` with company/role
   scraped from the page + the variant id → record appears in the library's
   application tracker.

## Learning loop

When the user types an answer into a `needs_human` field, the panel offers to
save it (`POST /profile/answers`) as a normalized question→answer pair in the
user profile. Subsequent applications include these pairs in the AI context,
so recurring questions (notice period, work authorization, salary band) stop
needing human input. Data stays in the local profile.

## Hard parts, handled honestly

- **Framework-controlled inputs:** native-setter trick; well-trodden.
- **Custom dropdowns/typeaheads (Workday, Ashby):** v1 is best-effort — try
  `<select>` semantics, otherwise flag for manual. No per-site shadow-DOM
  puppeteering.
- **Multi-page wizards:** no orchestration; re-run the scan per page. The
  learning loop makes later pages fast.
- **Security/privacy:** loopback + pairing token so web pages can't hit the
  bridge; page field labels go to OpenRouter under the user's key (same trust
  model as the app); the extension holds no secrets.

## Testing

- **Scanner and fill engine:** pure JS modules with vitest + fixture HTML
  captured from real Greenhouse/Lever/Ashby forms (same pattern as
  `resume-designer/test/`).
- **Bridge:** Rust unit tests for auth and request/response serialization.
- **AI prompt:** small eval fixture set (descriptors in → expected mapping
  out) so prompt changes are verified, not vibed.

## Non-goals (v1)

- Cover-letter generation (fast-follow; the app already holds
  job-description context).
- Workday/shadow-DOM widget automation.
- Wizard auto-navigation, auto-submit (never), Firefox/Safari ports, any
  cloud component or accounts.

## Open questions for the implementation plan

- Fixed port vs. dynamic port + discovery file for the bridge.
- Exact PDF export path for `GET /resumes/:id/pdf` (reuse the print/export
  pipeline headlessly).
- Chrome Web Store packaging details — deferred until shipping.
