# Plan 2 Handoff: Resume Designer Companion — the Chrome extension

**Audience:** Codex (gpt-5.6-sol), executing autonomously in this repo.
**Date:** 2026-07-15. Plan 1 (the in-app bridge) is COMPLETE — merged/merging via PR #88 (`feat/companion-bridge` → `next`), CI green, Codex review clean, manual PDF regression verified.

## Mission

Build the `extension/` Manifest V3 Chrome extension that AI-fills job application forms using a resume chosen from Resume Designer, talking to the app's loopback bridge. This is plan 2 of the approved two-plan project. The extension is the ONLY missing piece — the entire app-side API is built, tested, and documented.

## Read these first (in order)

1. `docs/superpowers/specs/2026-07-15-companion-extension-design.md` — the approved spec. It is the requirements authority for UX and scope.
2. `docs/bridge-api.md` — the as-built bridge API contract. Verbatim-accurate against the code (statuses, shapes, timeouts, sanitized curl transcripts). Build against THIS, not the spec's sketch, wherever they differ.
3. `CLAUDE.md` (repo root) and `~/.claude/CLAUDE.md` — project + behavioral rules. They bind you too.
4. For house style on service modules and tests: `resume-designer/src/bridgeRoutes.js` + `resume-designer/test/bridgeRoutes.test.js` (written this branch; canonical pattern).

## Non-negotiable decisions (already approved — do not relitigate)

- **Review-then-fill UX** in Chrome's **side panel** (`sidePanel` API): scan → AI proposes per-field values → user edits inline → user clicks Fill → **user always clicks Submit themselves. NEVER auto-submit — design invariant, not a setting.**
- **v1 scope:** text/select/radio/checkbox fields + attaching the resume PDF to file inputs (via `DataTransfer`). Explicitly OUT: cover-letter generation, Workday/shadow-DOM widget automation, wizard auto-navigation, Firefox/Safari, any cloud component or accounts.
- **Content script sends field DESCRIPTORS, never raw DOM** (label via `label[for]`/`aria-label`/placeholder/nearest text, type, options list, required flag).
- **Fill engine** uses the native-setter technique (`HTMLInputElement.prototype` value setter + dispatch `input`/`change`) so React/Vue-controlled inputs register changes. Unfillable custom widgets stay flagged in the panel for manual completion.
- **Learning loop:** answers the user types for `needs_human` fields are offered for saving via `POST /profile/answers`; learned answers come back in `GET /resumes/:id` and go into the AI context.
- **After fill:** offer "Log application" → `POST /applications` (creates an 'applied' record in the app's tracker) with company/title scraped from the page.
- **Plain JavaScript, no TypeScript.** Vite build. React is fine for the side panel (repo uses React 19); content script + background stay framework-free.
- The extension holds **no AI keys** — all AI goes through `POST /ai/complete`.

## Bridge contract essentials (details in docs/bridge-api.md)

- Base `http://127.0.0.1:17872`; every route except `GET /health` needs `Authorization: Bearer <token>`. The user pastes the token from the app (Settings → Data → "Companion extension") into the extension once — build that pairing UI (store token in `chrome.storage.local`; `/health` + an authed probe for the "connected" indicator).
- Routes: `GET /resumes` (list), `GET /resumes/:id` → `{id, name, updatedAt, data, profile, learnedAnswers}`, `GET /resumes/:id/pdf` → `{filename, pdfBase64}`, `POST /ai/complete` `{messages, systemPrompt?, reasoningEffort?}` → `{text}`, `POST /applications` `{variantId, company, title, notes?}` → 201, `POST /profile/answers` `{question, answer}` → 201.
- **Gotchas (hard-won, respect them):**
  - **ALWAYS send `systemPrompt` on `/ai/complete`** — if omitted, the app substitutes its resume-consultant chat persona, which will wreck strict-JSON mapping output.
  - `/resumes/:id/pdf` returns `500 {"error":"another PDF export is in progress — try again in a moment"}` while the app's own PDF preview dialog is open or another export runs. Serialize PDF calls; surface a retry affordance.
  - Timeouts: app answers within 30s (180s for `/ai/complete` and `/pdf`); `504` means the app isn't answering — show "Is Resume Designer running?".
  - The AI response is free text from whatever model the user selected — demand strict JSON in your systemPrompt, parse defensively (strip code fences), and retry once on parse failure before degrading.
  - Request bodies cap at 1 MiB (`413`) — keep descriptor payloads lean.
- The app must be RUNNING for the extension to work; the panel's disconnected state should say so and link nothing (loopback only).

## Suggested AI mapping contract (from the spec — refine as needed)

Request context: field descriptors + selected resume `data` + `profile` + `learnedAnswers`. Response (strict JSON):
`{"fields":[{"field_id","value","confidence","source":"resume|profile|learned"}],"needs_human":[{"field_id","question"}]}`
Low-confidence values get flagged in the review list; `needs_human` render as empty inputs with a "save answer" affordance.

## Structure (follow the spec's component split)

```
extension/
  manifest.json        # MV3: sidePanel, activeTab or host perms as minimal as possible,
                       # host_permissions for http://127.0.0.1:17872/*, storage
  vite.config.js       # multi-entry: sidepanel (React app), background (SW), content (iife)
  src/sidepanel/       # React UI: pairing, resume picker, review list, fill/log actions
  src/background.js    # owns ALL bridge fetches; relays panel <-> content script
  src/content/scan.js  # DOM -> descriptors (pure logic separated for tests)
  src/content/fill.js  # mapping -> DOM writes (native setter, DataTransfer PDF)
  test/                # vitest + jsdom: scanner + fill engine against fixture HTML
  test/fixtures/       # captured real Greenhouse/Lever/Ashby form HTML (sanitized)
README.md              # load-unpacked + pairing walkthrough for Ash
```

Keep the scanner and fill engine pure and unit-tested (the repo's test discipline is real: TDD, fixtures from actual job-board forms, pristine output). The AI prompt gets a small eval fixture set (descriptors in → expected mapping shape out) so prompt edits are checked, not vibed.

## Git / process rules (bind exactly as in plan 1)

- Branch: `feat/companion-extension` off `next` if PR #88 is merged, else off `feat/companion-bridge`.
- Conventional commits, **subject starts lowercase** (commitlint runs on every PR commit). Commit per coherent task.
- **Never push or open a PR unless Ash asks.**
- Surgical changes: app-side (`resume-designer/`) edits only if genuinely required and minimal — the bridge is done; don't refactor it. (Known optional hardening — Host-header check vs DNS rebinding in `src-tauri/src/commands/bridge.rs` — only if Ash asks.)
- Verification you can run: vitest suites, `npm run lint`, `npx vite build` in `extension/`, and curl against a running dev app (`npm run tauri:dev` from `resume-designer/`; token file: `~/Library/Application Support/com.resumedesigner.app/storage/resume-designer-bridge-token`). You cannot click the desktop app's GUI or Chrome's UI — end-to-end in-browser testing is Ash's manual pass; write the README walkthrough for it and keep a checklist of what needs human verification.

## Definition of done (v1)

1. `extension/` builds clean; loads unpacked in Chrome with no manifest warnings.
2. Pairing flow works (token paste → connected indicator green against a running dev app).
3. On a fixture-faithful Greenhouse or Lever form: scan → AI mapping → review list → Fill writes every plain field correctly (React-controlled inputs included), PDF attaches to the file input, unfillable fields are flagged.
4. `needs_human` answers save to the profile and are used on the next mapping call.
5. "Log application" creates a correct 'applied' record.
6. Scanner + fill engine + mapping-parse have vitest coverage against fixtures; all suites + lint green.
7. README walkthrough written; human-verification checklist appended to it.
8. Work committed on the branch in reviewable conventional commits; NOT pushed.

## Context you don't have to rediscover

- Plan 1's execution ledger (`.superpowers/sdd/progress.md`) lists accepted minors and deferred items — nothing there blocks you.
- The app's storage is single-writer (the running app). You never touch its files; everything goes over the bridge. That constraint is architectural, not stylistic.
- ClaudePreview/Chromium ≠ the app's WKWebView — irrelevant for the extension itself (it runs in real Chrome), but remember any app-side change needs WKWebView thinking.
