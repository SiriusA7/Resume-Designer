# User-Facing Changelog — Design Spec

**Date:** 2026-07-01
**Status:** Approved (design); implementation not started
**Related memory:** `changelog-feature-design`

## Goal

Let users see *what changed* in a release — a clean, digestible summary — before and after they update, and browse a historical list of past releases in-app. Keep deep technical detail available but tucked behind an expander. Generate the user-facing summary with AI at release time so it reads for humans, not as a raw commit dump.

## Current state (verified against the code)

- **No changelog file** exists anywhere in the repo. **No AI generation** exists.
- **Release notes today** are produced by a bash step in `.github/workflows/release.yml`: roughly `git log <range> --no-merges --pretty='- %s' | grep -E '^- (feat|fix|perf)(\(|:|!)'`, falling back to `"- Maintenance and internal improvements."`. Conventional-commit subjects only — raw, noisy, not user-oriented.
- Those notes are written into two places by the release workflow: the `notes` field of the updater manifest `latest.json`, and the GitHub Release body.
- **The app already fetches the notes but ignores them.** `src-tauri/src/commands/updater.rs` → `check_update_on_channel` returns `UpdateInfo { version, current_version, notes }`, where `notes` = the Tauri `Update.body` (i.e. `latest.json`'s `notes`) — verified at `updater.rs:57,144`. On the JS side, `src/native.js` `checkForUpdates` invokes that command and, on an available update, emits a status with `version`/`currentVersion`/`message` but **never forwards `update.notes`** (verified `native.js:274-282`). The download/restart dialogs are hardcoded strings.
- **Updater manifest endpoints:** stable = `releases/latest/download/latest.json`; beta = `releases/download/next/latest.json` (`updater.rs:20-23`). The repo is public.
- **Settings → Updates tab** (`src/components/SettingsDialog.jsx`, desktop only) has: channel selector (stable/beta), "check for updates on launch" toggle, a "Check for Updates" button (`triggerManualUpdateCheck`), and a current-version line. No changelog UI.
- **Update flow orchestration:** `src/updateFlow.js` (`triggerManualUpdateCheck`, `handleUpdateStatus`, background poll) turns the `emitStatus` payloads into toasts; `startupUpdateCheck` runs on launch.

**Implication:** the visible feature (showing notes before/after update + history) needs no AI and no new secret — it's wiring data that already reaches the JS boundary. Only the *quality* of the notes needs the AI step.

## Data contract

Every release yields a notes payload with two parts:

- **`summary`** — a short, de-noised, user-facing changelog. Grouped (e.g. `Highlights`, `Improvements`, `Fixes`). No `chore`/`ci`/`docs`/`refactor`/`test` internals, no commit hashes, no PR numbers. This is what the update dialogs and history rows show by default.
- **`full`** — the raw conventional-commit list (today's bash output). Shown behind a "Full changelog" expander for the technically curious.

Serialized form (a machine-readable release asset, `changelog.json`):

```json
{
  "version": "1.4.0",
  "date": "2026-07-01T10:30:00Z",
  "summary": "### Highlights\n- …\n\n### Fixes\n- …",
  "full": "- feat(chat): …\n- fix(pagination): …"
}
```

The updater manifest `latest.json.notes` carries the **markdown of `summary`** (so the existing `Update.body` → `UpdateInfo.notes` path surfaces the clean text with zero Rust changes). The `full` log lives in `changelog.json` + a collapsible section of the GitHub Release body.

## Design

### Half A — Generation (CI, at release)

In `release.yml`, replace/augment the bash notes step:

1. Collect the commit range (as today).
2. Call an AI model via **GitHub Models** — the official `actions/ai-inference` action — to transform the commits → `summary` markdown. Auth is the runner's built-in `GITHUB_TOKEN` with `permissions: models: read`; **no external key**. A modest model is plenty (summarizing a commit list is easy). Prompt constrains it to: group into Highlights/Improvements/Fixes, drop internal-only commits, plain user language, no hashes.
3. Keep the raw `git log` output as `full`.
4. Emit:
   - `latest.json.notes` = `summary` (markdown).
   - A `changelog.json` release asset = `{ version, date, summary, full }`.
   - GitHub Release body = `summary` on top + a `<details>`-wrapped `full` log.

**Hard requirement — fallback:** if the AI call fails for any reason (rate limit, network, malformed output, GitHub Models disabled), the step falls back to **today's bash-generated notes** for `summary`. A release must never fail or block on the AI step.

**No secret required.** GitHub Models is free (rate-limited) and authenticated by the built-in `GITHUB_TOKEN` (`models: read` job permission) — nothing to add in repo settings. The only possible one-time step is enabling GitHub Models for the `ashproto` account/org if it isn't already on (a policy toggle, not a secret). Free-tier limits (~50 requests/day even on higher-tier models) are far above our load of one summary per release; anything over the limit hits the bash fallback.

### Half B — Consumption (app UI)

Three surfaces, all consuming `summary` (+ `full` behind an expander):

1. **Before update** — when an update is available, show the `summary` ("What's new in v‹x›") in the update-available step before the user chooses Download. Requires forwarding `update.notes` through `native.js` `emitStatus` (currently dropped) and rendering it — either in a small "what's new" dialog/panel replacing the bare `dialog.ask`, or as expandable content in the update toast.
2. **After update** — on first launch after a version bump (detected by comparing a `lastSeenVersion` in appStorage against the running version), show a "You're now on v‹x› — here's what changed" panel with the `summary`.
3. **History** — a "What's New" view in Settings → Updates: a list of past releases, each row = version + date + `summary`, expandable to `full`.

### History source — Both (bundle + fetch)

- **Bundled:** the release build writes a `changelog.json` (or an accumulated `changelog-history.json`) into the app bundle, so history up to the installed version is available **offline**.
- **Fetched:** when online, the history view also fetches newer releases from GitHub (the public releases list / per-release `changelog.json` assets) and merges them in, so releases newer than the installed build appear too. Offline → bundled-only, no error.

Merge by version; dedupe; sort newest-first.

## Architecture / data flow

```
commits ──(CI: AI summarize, bash fallback)──► summary + full
   │
   ├─► latest.json.notes = summary ──► Update.body ──► UpdateInfo.notes ──► native.js emitStatus
   │                                                                          │
   │                                                        ┌─────────────────┴───────────────┐
   │                                                   before-update panel        after-update panel
   │
   ├─► changelog.json (release asset)  ──fetch──►  history view (merged with…)
   └─► changelog(-history).json (bundled) ──────►  history view (offline base)
```

## Phasing

- **Phase 1 — UI on existing notes (no key, no CI change).** Forward `notes` through `native.js`; render it in the before-update + after-update surfaces; build the Settings history view sourced by **fetching the GitHub Releases API** (each release's `body` is the summary — raw today, but real). No structured `changelog.json` and no bundled file yet, so history is fetch-only (offline → empty-state). Delivers the whole visible feature immediately, using today's notes.
- **Phase 2 — AI generation + structured data (free, no secret).** Add the CI AI-summarize step via GitHub Models (bash fallback), the per-release `changelog.json` asset, the bundled offline history file, and the release-body formatting. The history view then prefers the structured `summary`/`full` split and **merges bundled (offline base) with fetched (newer)**; the before/after panels get the clean summary automatically via `latest.json.notes`.

Phase 1 is independent of Phase 2 and ships on its own; Phase 2 upgrades note *quality*, adds the `summary`/`full` split, and makes history work offline.

## Error handling

- CI AI step: any failure → bash-notes fallback; never blocks the release.
- App fetch: network failure → bundled-only history + a quiet "couldn't load latest" affordance; never a hard error.
- Missing/empty `notes`: surfaces degrade to "No release notes for this version." rather than empty panels.
- Malformed `changelog.json`: ignored per-entry; the rest of history still renders.

## Testing

- CI: unit-test the notes transform/fallback (given commits/AI-output/AI-failure → expected `summary`/`full`); dry-run the workflow step.
- App: unit-test the history merge/dedupe/sort, the `lastSeenVersion` "did we just update?" logic, and the markdown rendering of `summary`. The live before/after-update panels need a real update event (Chromium preview can't produce one; app is WebKit) — verify via unit tests + a manual pass in `tauri dev`.

## Out of scope (YAGNI)

- No in-app "edit the changelog" authoring UI — notes come from commits/CI.
- No changelog for the browser build (updater is desktop-only).
- No i18n/localization of notes.
- No per-user changelog personalization.
- No changelog analytics.

## Open questions

All resolved during brainstorming:
- Generation location → **CI at release** (not on-device).
- AI provider → **GitHub Models** (`actions/ai-inference`, free, `GITHUB_TOKEN` + `models: read` — no secret).
- History source → **Both** (bundle + fetch newer).
- Digestibility → **summary + expandable full log** (the data contract).
