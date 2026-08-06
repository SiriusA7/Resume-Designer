# Live models, composer, grounding, change preview, main sections, spellcheck

**Date:** 2026-07-25
**Status:** Approved design, not yet planned/implemented
**Delivery:** One combined PR into `next`. Scope was raised as a concern once
(six workstreams, two of them substantial) and the single-PR choice was
reaffirmed. Commits are therefore kept strictly one-per-workstream so the branch
stays bisectable and reviewable in slices.

## Problem

Six independent items, reported together:

1. **Stale models.** The picker's newest Anthropic model is Opus 4.8; OpenRouter
   currently serves Claude Opus 5. Users cannot reach the latest models.
2. **Composer breaks at narrow widths.** With the chat sidebar dragged small,
   the controls row scrunches and icons spill out of their own buttons.
3. **AI fabricates experience.** Generated resumes contain employers, metrics
   and achievements the user never had.
4. **Change proposals render wrong and don't stay in sync.** Inline previews
   hide or mangle content, and accepting changes in one surface leaves the
   other surfaces still offering accept/reject.
5. **No custom sections in the main area.** Users can add custom sections to the
   sidebar, with light control over their presentation. The main column offers
   neither.
6. **No spellcheck.** Nothing indicates a misspelling, and no corrections are
   offered. Should use the OS/system spellchecker.

## Root causes (verified, not assumed)

### 1. Stale models

`MODELS` (`aiService.js:30`) is a hardcoded 12-slug map, comment-dated
`2026-05-31`. `fetchModelCatalog()` (`aiService.js:313`) *already* fetches
`GET https://openrouter.ai/api/v1/models` every 24h — but reduces each entry to
`{ reasoning: boolean }`, discarding names, dates and everything else. The
picker never consults it. Live catalog today: **345 models, 58 providers.**

### 2. Composer

Measured at the 240px minimum panel width (`ChatPanel.jsx:16`): the control row
has **214px** for roughly **314px** of intrinsic content. `Button`'s base class
sets `whitespace-nowrap` and `[&_svg]:shrink-0`, but the buttons themselves
carry no `shrink-0`. The boxes compress; their icons refuse to. Icons overflow
their shrunken pills and the Send button escapes the composer card entirely.

### 3. Fabrication

`generateResumeFromProfileForJob` (`aiService.js:546`) instructs the model to
"create the BEST possible resume" and to "quantify achievements where possible",
with **no constraint anywhere requiring it to stay within the user's profile**.
`tailorResume` (`onboardingLogic.js:209`) asks it to position the candidate as
"ideal for the target role". `CHANGE_GENERATION_PROMPT` has no grounding rules.
Invention is the natural response to these instructions.

### 4. Change preview

Two separate defects.

**Rendering.** `renderer.js:44-46` converts `**x**` → `<strong>` and `_x_` →
`<em>` before display, so live nodes contain child markup.
`inlineChanges.js:189` snapshots `element.textContent` (flattening that markup
away) and line 194 assigns raw markdown back into `.textContent`. Consequences:
the preview shows literal `**asterisks**`, and **rejecting a change restores the
flattened snapshot, permanently destroying the original's bold/italic** — data
loss, not cosmetics.

`findElementByPath` (`inlineChanges.js:212`) uses bare `document.querySelector`,
returning the *first* document match. `pagination.js` clones nodes extensively
(`cloneNode` at lines 210, 220, 312, 361, 370, 373) to rebuild columns per page,
so that first match is frequently a clone or an off-screen measurement node.
Line 233 additionally falls back to a **prefix match**
(`[data-editable^="experience[0]"]`), which can bind a title change to a bullet
element and overwrite the wrong node. Lines 227 and 214 are the identical query
(dead code), and line 254 can return `null`, silently dropping the change.

**State.** Three independent trackers of "what is still pending", none
subscribing to the others:

| Surface | State |
|---|---|
| In-resume inline preview | `inlineChanges.js` module singletons: `currentChangeSet`, `appliedChanges`, `isActive` |
| Review dialog | `DiffDialog.jsx` React state: `applied`, `rejected`, `changeSet` |
| Chat message actions | `msg.pendingChanges` / `msg.applyData` on the message object |

Apply-all in the dialog leaves the inline highlights and the chat buttons
believing the changes are still pending.

### 5. Main-area sections

`sections[]` (`store.js:567`) is the only custom-section array:
`{ id, title, type: 'list' | 'skills', content: string[] }`. The main column is
hardcoded to `summary`, `experience[]`, `education[]`, `tools`. The sidebar's
"design control" is a single `Segmented` toggle writing `sections[i].type`
(`StructurePanel.jsx:186`), switching Bulleted vs Inline Tags.

The decisive finding: **sidebar-vs-main is already layout-dependent, not a
property of the data.** Of 11 layout renderers, 6 route sections through
`renderSidebar` (Sidebar, Right Sidebar, Compact, Executive, Modern, Timeline)
while **5 are sidebar-less and already render `data.sections` inline in the main
column** (Stacked, Stacked Vertical, Classic, Classic Featured, Creative). On
those five the feature effectively exists already; the UI label "Sidebar
Sections" is simply wrong there. The real gap is the 6 sidebar layouts, which
offer no main-column escape hatch.

### 6. Spellcheck

`spellcheck` is never set anywhere in the codebase — not on `Input`, `Textarea`,
or the `contentEditable` toggled on focus at `inlineEditor.js:802`. Nothing
suppresses the context menu in `tauri.conf.json`.

Platform reality, confirmed from the Tauri maintainer in
[tauri-apps/discussions/7482](https://github.com/orgs/tauri-apps/discussions/7482):
on **macOS WKWebView**, `spellcheck="true"` yields right-click suggestions but
**no red squiggle** — *"it should kinda work … but there won't be any visual
indicators"*. On **Windows WebView2** spellcheck is *"enabled by default"* with
full Chromium behaviour. So the primary requirement — *indicating* a
misspelling — is precisely what macOS will not provide natively, on the primary
platform.

## Decisions (from brainstorm)

- **Featured models are derived live**, not hardcoded, and always surface the
  best and newest from Anthropic and OpenAI. All 345 remain reachable below.
- **Composer collapses progressively to icons**; nothing hides, nothing wraps.
- **Strict grounding plus a gap report** — the model may never invent, and
  reports what the job wants that the profile lacks.
- **Change preview becomes data-driven**; direct DOM mutation is retired.
- **Sections unify** into one array with an `area` field, rather than a second
  parallel `mainSections[]`. The UI is relabelled accordingly.
- **Main sections get Bulleted, Inline Tags and Paragraph.** Structured
  title/org/dates "Entries" are explicitly deferred.
- **Spellcheck ships natively first**, with OS-backed visual indicators behind a
  verification spike.
- **One combined PR.**

## Design

### 1. Live model catalog

**Widen the cache.** Store per model: `id`, `name`, `created`, `contextLength`,
`maxTokens` (from `top_provider.max_completion_tokens`), `reasoning`, and input/
output modalities. ~345 × ~120B ≈ 40KB, acceptable for appStorage. Bump a cache
schema version so existing `{reasoning}`-only caches are discarded rather than
misread as complete records.

**Derive Featured** with two rules, both purely structural — no vendor-specific
version parsing, which was prototyped and rejected as fragile (it selected
`-fast`/`-pro` variants over their cheaper base siblings and over-stripped
`gemini-3.5-flash-lite` to `gemini`):

1. **Noise filter.** Reject dated snapshots (`-YYYY-MM-DD$`), task- or
   modality-specific variants (`-codex`, `-image`, `-audio`, `-tts`, `-embed`,
   `search-preview`, `deep-research`), open-weight lines (`-oss`, `gemma`), and
   `:free`/`:extended` tiers. Require `output_modalities === ['text']`.
2. **Prefix-sibling rule.** Drop `X` when another surviving id is a strict
   prefix of it — so `claude-opus-5` beats `claude-opus-5-fast`, and
   `gpt-5.6-sol` beats `gpt-5.6-sol-pro`.
3. **Family-root rule.** Collapse digit runs to `#`
   (`claude-opus-5` → `claude-opus-#`); keep the newest model per root, so
   Opus 5 appears without Opus 4.8, 4.7 and 4.6 alongside it.

Take the newest **4 per provider** by `created`, across six provider groups
ordered Anthropic, OpenAI, Google, xAI, DeepSeek, Mistral — a ~24-row Featured
section, close to today's 12 and still scannable without search. Validated
output against the live catalog:

- Anthropic — Claude Opus 5, Sonnet 5, Fable 5, Haiku 4.5
- OpenAI — GPT-5.6 Luna, Terra, Sol

**Refresh on open.** Stale-while-revalidate: render the cache immediately, kick
off a background fetch, swap in on resolve. A 5-minute soft TTL prevents
repeated opens from hammering the endpoint; the existing 24h hard TTL still
backs the reasoning-support path. A `CATALOG_UPDATED` event — mirroring the
existing `SETTINGS_UPDATED_EVENT` pattern — lets all three pickers re-render
together. A subtle "updating…" affordance and a relative freshness line show
what is happening.

**Picker UI.** Featured groups as today, then a searchable "All models" section
backed by the existing `Command` primitive plus `CommandInput`. If rendering all
345 rows proves sluggish, cap the unsearched list and expand on typing.

**`MODELS` stays**, demoted from source of truth to offline/first-run fallback
and as the `maxTokens` backstop.

**Touches:** `aiService.js`, `useChat.js`, `ModelSelector.jsx`,
`JobsDialog.jsx`, `onboardingLogic.js`. New `test/modelCatalog.test.js`.

### 2. Composer responsiveness

- `shrink-0` on the web-search, reasoning and send buttons so none compresses
  below its icon.
- The model trigger becomes the single flexible item: `min-w-0 flex-1`,
  replacing `max-w-40`, absorbing all slack and truncating.
- Below ~300px, the reasoning control drops its text label to icon-only,
  retaining the level in its tooltip and `aria-label`.

The panel resizes independently of the viewport, so **viewport media queries are
the wrong tool** — and `@tailwindcss/container-queries` is not installed. A
small `ResizeObserver` in `ChatComposer` sets a `compact` flag instead. No new
dependency, and engine-agnostic so it holds in WKWebView.

**Touches:** `ChatComposer.jsx`, `ModelSelector.jsx`.

### 3. AI grounding

A shared `GROUNDING_RULES` constant in `aiService.js`, injected into
`generateResumeFromProfileForJob`, `CHANGE_GENERATION_PROMPT`, `SYSTEM_PROMPT`,
`JOB_ANALYSIS_PROMPT`, and `tailorResume` in `onboardingLogic.js`:

- Use only facts present in the profile. Never invent employers, job titles,
  dates, degrees, certifications, tools, or metrics.
- Never introduce a number, percentage or currency figure absent from the
  profile. If a metric would strengthen a bullet but is not present, write the
  bullet without it. Do not estimate, and do not emit `[X]%`-style placeholders.
- Rephrasing, reframing, reordering and emphasis are allowed; adding new claims
  is not.
- Keyword alignment means describing genuinely-held skills in the job's
  vocabulary — never claiming skills the profile does not evidence.
- Never inflate scope or seniority ("contributed to" must not become "led").

Remove the phrasing that actively invites invention: "create the BEST possible
resume" becomes "create the strongest resume the profile truthfully supports",
and "quantify achievements where possible" becomes "quantify only where the
profile supplies the number".

**Gap report.** `generateResumeFromProfileForJob` returns an additional
top-level `gaps: [{ requirement, severity, note }]`, listing target-job
requirements the profile does not support. It is stripped from the payload
before the object becomes resume data, and surfaced on the post-generation
screen using the badge idiom already established in `AnalysisResults.jsx`.

**Accepted consequence:** resumes will be thinner for users with sparse
profiles. That is the honest output; the gap report converts the shortfall into
something actionable instead of silently fabricated.

**Touches:** `aiService.js`, `onboardingLogic.js`, `OnboardingWizard.jsx`, and a
new `GapReport.jsx` rendered on the post-generation step. New
`test/grounding.test.js`.

### 4. Change-proposal audit

**Single source of truth.** A new `changeSession.js` owns the active change set
and a per-path status (`pending` | `applied` | `rejected`), exposing
`subscribe`/`notify` in the same shape as `store.js`. `inlineChanges.js`,
`DiffDialog.jsx` and the chat message actions all become views over it, holding
no independent applied/rejected state. Accepting anywhere updates everywhere;
when nothing remains pending, every surface stands down together.

**Data-driven preview.** Direct DOM mutation is retired. Proposed changes become
a preview overlay on the resume data, and the resume re-renders through
`renderer.js` with change markers. Markdown emphasis, pagination and multi-page
layout then work by construction, because there is exactly one render path.
This removes `findElementByPath`, the prefix-match mis-binding, the
`textContent` round-trip and its data loss, and the pagination-clone collision
in a single stroke.

**Touches:** new `changeSession.js`; `inlineChanges.js` (largely removed),
`diffView.js`, `renderer.js`, `DiffDialog.jsx`, `MessageList.jsx`,
`useChat.js`, `store.js`. Existing `test/inlineChanges.test.js` is rewritten
against the new module.

### 5. Main-area sections

**Data model.** Keep the single `sections[]` array; add
`area: 'main' | 'sidebar'`. A one-time migration stamps `area: 'sidebar'` on
every existing section, preserving current output exactly. Because the array,
its indices and every `sections[i].content[j]` path are unchanged, existing AI
change paths, `data-editable` attributes, variants and backups keep working
untouched — the migration is additive.

**Rendering.**

- The **6 sidebar layouts** partition by `area`: `area === 'sidebar'` continues
  through `renderSidebar`; `area === 'main'` renders in the main column after
  `education`, in array order.
- The **5 sidebar-less layouts** ignore `area` entirely and render all sections
  in array order, exactly as today. This is deliberate: on those templates there
  is only one column, so the distinction is meaningless and forcing it would
  change existing resumes' output for no benefit.

**Display types.** `normalizeSectionType` extends from `list | skills` to
`list | skills | paragraph`. `paragraph` renders `content` as prose blocks
rather than list items, which suits the wider main column. Content remains
`string[]`, so the editor, AI paths and diff engine need no shape change.
Structured Entries (title/org/dates/bullets) are a non-goal here — they would
turn content items into objects and ripple through all 11 renderers, the inline
editor and the change paths.

**UI.** The `PanelSection` titled "Sidebar Sections" becomes "Sections", each
section gaining an area picker alongside its existing Display toggle. The label
is corrected because it is already wrong on 5 of 11 layouts today. Sections stay
sortable among themselves via the existing `Sortable` wiring.

The area picker is always shown, including on the 5 sidebar-less layouts where
it currently has no visual effect — `area` is a property of the résumé, not of
the active template, and hiding it would silently discard the user's choice when
they switch templates. On those layouts it carries a short note that the active
template renders a single column.

**Touches:** `store.js` (shape + migration), `renderer.js` (11 layouts),
`StructurePanel.jsx`, `parser.js`/`resumeParser.js` if they construct sections,
plus `CHANGE_GENERATION_PROMPT`'s path vocabulary. New
`test/sectionAreas.test.js`.

### 6. Spellcheck

**Stage 1 — native, unconditional.** Set `spellCheck` on every editable surface:
default it on in the `Input` and `Textarea` primitives, set
`element.spellcheck = true` alongside `contentEditable = 'true'` in
`inlineEditor.js`, and opt *out* explicitly on technical fields where it is
noise (the model-slug input, and other `font-mono` identifier fields). Confirm
the webview context menu reaches the native suggestion list on both platforms.

This alone gives Windows full squiggles and suggestions, and gives macOS
right-click corrections. It does **not** satisfy the "indicate a misspelling"
requirement on macOS.

**Stage 2 — OS-backed indicators, spike first.** Gated on a spike that must run
in `npm run tauri:dev`, because ClaudePreview is Chromium and cannot answer a
WebKit question. The spike verifies, in the shipped WKWebView:

1. Is `CSS.highlights` (CSS Custom Highlight API) available?
2. Does `text-decoration-line: spelling-error` paint a native squiggle?

If both hold, the implementation is: a Tauri command
`spellcheck(text, lang) -> [{ start, len, suggestions }]` backed by
**NSSpellChecker** on macOS and the **`ISpellChecker` COM API** on Windows — so
the user's own dictionary, learned words and language settings apply, which is
what "hook into the OS" actually means. Returned ranges are painted with the
Custom Highlight API, which touches no DOM — deliberately, given the data loss
workstream 4 traced to DOM mutation. A custom suggestion popover surfaces the
corrections and an "Add to dictionary" action.

If the spike fails, the fallback decision returns to the user rather than being
made silently: either accept native-only on macOS, or reconsider a bundled JS
dictionary.

Windows Rust must be type-checked locally with
`cargo check --target x86_64-pc-windows-gnu` per project rules, since PR CI
builds macOS only.

**PDF export must be unaffected.** Highlights are cleared, and `spellcheck` is
disabled, on the capture path before export.

**Touches:** `inlineEditor.js`, `input.jsx`, `textarea.jsx`, `ModelSelector.jsx`
(opt-out), new `spellcheck.js` + `src-tauri/src/commands/spellcheck.rs`, and the
PDF capture path. New `test/spellcheck.test.js` for the range/popover logic.

## Testing

- **Catalog:** unit-test the noise filter, prefix-sibling and family-root rules
  against a frozen catalog fixture; assert Opus 5 and GPT-5.6 Sol are featured
  and that `-fast`/`-pro`/dated/`:free` variants are excluded. Test cache
  versioning, soft-TTL revalidation, and the offline fallback path.
- **Composer:** assert `compact` thresholds and that no control drops below its
  icon width. Verify visually in `npm run tauri:dev`, not only preview —
  per project rules the shipped app is WKWebView.
- **Grounding:** assert the rules block is present in every built prompt and
  that `gaps` is parsed and stripped from resume data. Behavioural
  truthfulness cannot be unit-tested without live calls; verify by hand
  against a deliberately sparse profile.
- **Change session:** unit-test that accept/reject from any surface converges
  all surfaces, that rejection restores markup exactly, and that a change whose
  target no longer exists fails visibly instead of silently.
- **Sections:** assert the migration stamps `area: 'sidebar'` and that output is
  byte-identical to pre-migration for every existing fixture; assert the 5
  sidebar-less layouts ignore `area`; snapshot each of the 11 layouts with a
  main-area section present, in all three display types.
- **Spellcheck:** unit-test range mapping and the opt-out list. The spike's two
  WebKit capability questions, the context menu, and PDF cleanliness are
  **manual checks in `tauri:dev`** — they cannot be asserted in vitest or
  verified in the Chromium preview.

## Non-goals

- No redesign of the review dialog's visual language; this is correctness work.
- No change to how changes are *generated*, beyond the grounding rules.
- No provider additions beyond OpenRouter.
- No re-verification or hand-curation of the `MODELS` fallback list; it is a
  backstop, and staleness there is now harmless.
- No structured "Entries" section type (title/org/dates/bullets). Deferred.
- No grammar checking, no writing-style suggestions, no autocorrect-as-you-type
  that rewrites the user's text. Spellcheck indicates and offers; the user
  chooses.
- No custom dictionary UI beyond delegating "Add to dictionary" to the OS.
- No change to `area` semantics on sidebar-less layouts; their output is
  intentionally unchanged.
