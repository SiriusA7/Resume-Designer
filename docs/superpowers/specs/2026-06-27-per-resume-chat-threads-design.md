# Per-Résumé Chat Threads — Design

**Status:** Approved (brainstorm) — ready for implementation plan
**Date:** 2026-06-27

## Goal

Scope the AI chat threads to the résumé (variant) they belong to, instead of one
global list shared across every résumé. The thread selector shows the current
résumé's threads, plus a "General" group and an "other résumés' threads" group so
any thread is still reachable. A single thread may be continued under more than
one résumé over time, with each résumé-context boundary made explicit to both the
user and the AI.

## Background — current state

- Threads are a single global array under `resume-designer-chat-threads`
  (`src/chatThreads.js`). Thread shape: `{ id, name, messages, createdAt, updatedAt }`.
  No résumé association exists today.
- `loadThreads()` returns all threads and picks the most-recently-updated as current.
- `src/components/chat/useChat.js` owns thread state and `newThread` / `switchThread`
  / `deleteThread`, and already imports `store`.
- `src/components/chat/ThreadSelector.jsx` renders a flat `threads.map` popover with
  a "+" (new) and per-row delete.
- `store.setData(data, skipSave, variantId)` sets the module-level `currentVariantId`
  and emits `'dataLoaded'` on every variant load/switch.
- `aiService.getResumeContext()` already attaches the **currently-active** résumé to
  every chat call.

## Decisions (from brainstorm)

1. **Chat follows the résumé.** Switching the active résumé auto-opens that résumé's
   most-recently-updated thread, or a fresh empty thread homed to it if it has none.
2. **Other-résumé threads open in place.** Opening a thread from the "other résumés'"
   (or "General") group does **not** change the active résumé; it just loads the
   conversation. An affordance lets you jump to the thread's résumé.
3. **Context-switch divider + AI note.** When a turn is sent while the active résumé
   differs from the thread's previous turn, insert a visible divider
   (`Now discussing: «Name» [Jump to «Name»]`) and pass an explicit note to the AI.
   Each divider's button switches the active résumé to that section's résumé.
4. **Pre-existing/global threads → "General".** Threads without a home résumé live in
   a General group, shown for every résumé and always reachable; re-homeable.
5. **On résumé delete → prompt.** If the deleted variant has homed threads, ask:
   move them to General, or delete them.

## Data model (`src/chatThreads.js`)

- Thread gains **one field**: `homeVariantId: string | null` (`null` = General).
  `makeThread(name, initialMessages, homeVariantId = null)`.
- **Context markers** live inside a thread's `messages` as lightweight items:
  `{ id, role: 'context', variantId, variantName, timestamp }`.
- **Per-turn tagging:** user (and resulting assistant/error) messages carry the
  `variantId` they were sent under, so transitions can be detected without guessing.
- Persistence is unchanged — the same single `resume-designer-chat-threads` array,
  now with the extra field. Old threads simply lack `homeVariantId` and are treated
  as `null` (General), so the change is fully backward-compatible.

### New pure helpers (the bulk of the testable logic)

- `migrateThreads(threads)` → ensures every thread has a `homeVariantId` (missing →
  `null`). Pure; callers persist.
- `groupThreadsByHome(threads, currentVariantId, variants)` →
  `{ current: Thread[], general: Thread[], others: { variantId, variantName, threads: Thread[] }[] }`,
  each list sorted by `updatedAt` desc. `variants` supplies display names; a thread
  whose `homeVariantId` no longer matches any variant falls into General.
- `lastTurnVariantId(messages)` → the `variantId` of the last non-context message
  (or `null`).
- `withContextMarker(messages, activeVariantId, activeVariantName)` → returns the
  messages with a `context` marker appended **only when** `activeVariantId` differs
  from `lastTurnVariantId(messages)` (and the thread is non-empty); otherwise
  returns the list unchanged.
- `contextNoteForAI(activeVariantName)` → the short system-note string injected into
  the request when a switch occurred.

## Behavior

### Chat follows the résumé (`useChat.js` + small `store.js` addition)

- `store.js` exposes `getCurrentVariantId()` and includes the variant id on the
  variant-change signal (so `useChat` can read which résumé is now active without a
  guess). `useChat` subscribes to that change.
- On variant switch: persist the current thread, then `switchThread()` to that
  variant's most-recently-updated thread; if it has none, `newThread()` homed to the
  new variant.
- The "+" / `newThread()` homes the new thread to the current variant.
- On boot, `loadThreads()` runs through `migrateThreads()`, and the initially-current
  thread is the active variant's most-recent (falling back to a fresh homed thread).

### Opening cross-résumé threads + dividers + AI note

- `switchThread(id)` works for any thread regardless of home; it never changes the
  active résumé.
- On send (all AI flows in `useChat`), build the outgoing messages through
  `withContextMarker(...)` using the active variant id/name. A marker is persisted
  into the thread when the résumé context changed since the last turn.
- `ChatPanel.jsx` (message list) renders a `role:'context'` message as a divider with
  the résumé name and a **Jump** button that invokes the app's existing
  switch-to-variant action (the same path used elsewhere to change the active
  résumé). The same action backs the cross-résumé banner's Jump.
- The AI request builder (`aiService` / the `useChat` history mapping) converts a
  trailing context change into a system note via `contextNoteForAI(...)`. Because
  `getResumeContext()` already sends the active résumé's data, the model receives the
  correct résumé plus an explicit "you're now working on «Name»" cue.

### Thread selector UI (`ThreadSelector.jsx`)

Grouped popover, in order:

1. **This résumé** — `homeVariantId === currentVariantId`. The "+" creates here.
2. **General** — `homeVariantId == null`. Always shown.
3. **Other résumés' threads** — everything else, grouped by résumé with the résumé
   name as each group's header.

Group headers are shown only for non-empty groups. Each row keeps rename/delete; the
per-row overflow gains **Move to this résumé** (re-home to the current variant).

When the currently-open thread's home ≠ the active résumé, a slim banner sits atop
the chat: *"Thread from «Home» — Jump"* (covers the "jump to the thread's résumé"
affordance; the in-thread dividers cover the rest).

## Migration

`migrateThreads()` defaults any missing `homeVariantId` to `null` (General) on load.
The read path never writes (consistent with the existing empty-read guard); the field
is persisted on the next normal save. No data is moved or mis-attributed.

## Résumé deletion

Hook the existing variant-delete flow: if the variant has homed threads, prompt the
user to either **move them to General** (`homeVariantId = null`) or **delete them**.
With no homed threads, deletion is unchanged.

## Re-homing

`Move to this résumé` (per-row, in the selector overflow) sets a thread's
`homeVariantId` to the active variant. This is how General threads (and any
misfiled thread) get adopted into a résumé.

## Units touched

- `src/chatThreads.js` — `homeVariantId` field + the pure helpers above (most logic).
- `src/components/chat/useChat.js` — variant subscription + follow-the-résumé switch,
  context-marker-on-send, re-home action, delete-variant thread handling.
- `src/components/chat/ThreadSelector.jsx` — grouped UI, re-home action, jump buttons.
- `src/components/chat/ChatPanel.jsx` (+ message renderer) — context divider with jump
  button; the home banner.
- `src/store.js` — `getCurrentVariantId()` accessor + variant id on the change signal.
- `src/aiService.js` — derive the system note from a trailing context marker.
- The variant-delete flow — the keep/delete prompt.

## Edge cases

- **Active variant has zero threads:** open a fresh empty thread homed to it (never
  show another résumé's thread as "current" implicitly).
- **A thread's `homeVariantId` points at a deleted variant** (e.g. a race): it falls
  into General via `groupThreadsByHome`.
- **Empty thread + immediate résumé switch:** no marker is inserted (no prior turn).
- **Same-résumé turns:** never insert a marker (only on a real transition).
- **Streamed flows mid-switch:** the existing `commitToThread(startThreadId, …)` keeps
  routing a streamed result to its origin thread; the context marker is computed from
  the active variant captured at send time, consistent with that.

## Testing

Vitest over the pure `chatThreads.js` helpers (no jsdom needed):

- `migrateThreads` — missing field → `null`; existing values preserved.
- `groupThreadsByHome` — current / general / others split; deleted-home → General;
  per-group `updatedAt` sort.
- `lastTurnVariantId` — ignores `context` markers; empty → `null`.
- `withContextMarker` — inserts only on transition; no-op on same variant or empty
  thread; marker carries variant id + name.
- `contextNoteForAI` — note shape.

Hook/DOM behavior (follow-the-résumé switching, divider rendering + jump, selector
grouping, re-home, delete prompt) verified in the app/preview, per the project's
existing convention for layout-dependent behavior.

## Out of scope (YAGNI)

- Per-variant storage keys (rejected — fights cross-résumé visibility).
- Auto-guessing a home résumé for legacy threads (rejected — unreliable).
- Renaming/merging résumé groups, drag-to-reorder threads, multi-select.
- Any change to how résumé *data* is sent to the AI beyond the context note
  (`getResumeContext()` already sends the active résumé).
