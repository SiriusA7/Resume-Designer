# Multi-profile workspaces: switch between people in one app

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan

## Problem

The app is single-person by construction: one user profile, and all data
(résumés/variants, job descriptions, applications, chat threads, per-variant
history) lives in a flat set of `resume-designer-*` storage keys with no
notion of "whose." The user wants to help their partner apply for jobs from
the same installation without mixing the two people's résumés, applications,
AI context, or Library stats.

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Separation scope | **Everything** — full workspace per person (profile, résumés, JDs, applications, chats, history, onboarding state). Machine-level settings stay shared |
| Switching mechanism | **Namespace at the appStorage facade + window reload** — no hot-switch, no data-model restructure |
| API key | **Shared across profiles** — extract `openrouterKey` out of per-profile settings into a shared key |
| Backups | **Both**: whole-app backup covers all profiles (default); new per-profile export/import for moving one person between machines |
| Legacy backups | Restore into the currently active profile (today's semantics) |

## Data model

Two new **shared** keys:

- `resume-designer-profiles` — registry: `[{ id, name, emoji, createdAt }]`
- `resume-designer-active-profile` — the profile id to load at boot

**Per-profile keys** (namespaced; everything describing a person's work):

- `resume-designer-data` (variants, currentVariantId, settings, userProfile)
- `resume-designer-job-descriptions`
- `resume-designer-applications`
- `resume-designer-chat-threads`
- `resume-designer-chat-history` (legacy, round-trips through backups)
- `resume-designer-history-<variantId>` (whole prefix)
- `resume-designer-token-usage`
- `resume-designer-onboarding-complete` — a new profile gets the full
  onboarding flow
- View/design state: `resume-zoom`, `resume-edit-hint-dismissed`,
  `resume-accent-settings`, `resume-spacing-settings`, `resume-header-style`

**Shared keys** (machine-level):

- `resume-designer-theme`, `resume-designer-update-channel`,
  `resume-designer-auto-update-check`, `resume-designer-model-catalog`,
  `resume-designer-electron-migration-attempted`
- New: `resume-designer-openrouter-key` (see below), plus the two new keys
  above

The exact partition list is finalized at implementation time by enumerating
every owned key (grep for `'resume-` across `src/`); any key not explicitly
shared defaults to per-profile.

### API key extraction

`settings.openrouterKey` moves to the shared `resume-designer-openrouter-key`
key so the machine is configured once and every profile uses it. `getSettings()`
overlays the shared key onto the settings object it returns; `saveSettings()`
routes `openrouterKey` writes to the shared key. One-time migration moves the
existing value out of the active settings blob. All other settings (model
choices, reasoning efforts, palette, layout, chat panel width) stay
per-profile.

## Mechanism: namespacing at the facade

`appStorage` gains a key-mapping layer at its single choke point: per-profile
logical keys map to physical keys `p:<profileId>:<logicalKey>` (each still one
disk file per key on Tauri, unchanged atomic tmp+rename writes). Shared keys
pass through unmapped. No other module changes — everything keeps calling
`getSettings()` / `loadThreads()` / etc. against logical keys.

Profile registry helpers live in a new pure module (`src/profiles.js`):
create / rename / delete / setActive / list, plus the id generation. The
facade consults only the active-profile id (read once at init, before any
mapped read).

### Migration (one-time adoption)

On first boot with profile support: existing unprefixed per-profile keys are
migrated into a first profile named from `userProfile.fullName` (fallback
"My profile"), reusing the crash-safe `ADOPTION_PENDING_KEY` marker pattern
already proven in `appStorage` — a boot that finds the marker knows a prior
migration was killed mid-copy and redoes it. Runs inside the existing boot
order contract (`initAppStorage()` → migrations → `markStorageReady()`).

### Switching

Header profile button (emoji + name) → dropdown: the profile list,
"New profile…", "Manage profiles…" (rename / emoji / delete). Switch = flush
pending writes (`flushPendingProfileSave()` + facade `flush()`) → set
`resume-designer-active-profile` → `location.reload()` — the same reload
pattern as backup-restore, ~1s. New profiles start empty and run onboarding.

Guards: cannot delete the last profile; deleting the active profile switches
to another first; a dangling active-profile pointer falls back to the first
registry entry; an empty/corrupt registry triggers re-adoption as a single
profile.

## Backup & restore

- **Whole-app backup** (existing button, default): includes the registry,
  shared keys, and every profile's namespaced keys. Restore replaces
  everything — both people. Backup format version bumps; `isOwnedKey` /
  `BACKUP_FIXED_KEYS` handling extends to mapped keys (regression test per
  the BACKUP_FIXED_KEYS rule).
- **Legacy (pre-profile) backups**: detected by format; restore into the
  currently active profile, preserving today's semantics.
- **Per-profile export/import** (new): exports one profile's logical keys +
  profile name into a marked file; import always creates a **new** profile
  from it (never overwrites silently). Lives in the Manage profiles UI.

## Error handling

- Facade reads before profile resolution are impossible by construction (the
  active id resolves during `initAppStorage()`, which already must run first).
- Registry/pointer corruption paths above degrade to "single profile, data
  intact"; migration failures leave the marker so the next boot retries.
- Per-profile import validates the file marker and shape before touching the
  registry.

## Testing

- Unit (vitest, `test/`): key-mapping (per-profile vs shared vs history
  prefix), registry CRUD + guards, migration idempotence (marker semantics),
  API-key overlay in `getSettings`/`saveSettings`, backup round-trips for all
  three formats, `isOwnedKey` still true for mapped keys.
- Manual WKWebView pass (`npm run tauri:dev`): adoption of real data, switch
  flow, new-profile onboarding, backup/restore/export/import, per the
  preview-is-Chromium project rule.

## Out of scope

- Hot switching without reload.
- Profile passwords/privacy separation (both people share the machine
  account).
- Per-profile theme or update channel.
