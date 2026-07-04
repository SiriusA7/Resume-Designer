# Per-Résumé Chat Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the AI chat threads to the résumé (variant) they belong to, with a "General" group for legacy threads and an "other résumés' threads" section, so a thread can be continued under any résumé with each context boundary made explicit to user and AI.

**Architecture:** Keep the single global `resume-designer-chat-threads` array and add a `homeVariantId` field per thread (Approach A). All grouping/migration/marker logic lives as pure functions in `chatThreads.js` (unit-tested). `useChat.js` reacts to variant switches via `store.subscribe('dataLoaded')` + reads the active id from `variantManager.getCurrentId()`; the Jump button switches via `variantManager.loadVariant(id)`. The AI is told the current résumé name via a one-line system note composed in `aiService.chat()`.

**Tech Stack:** Vanilla JS + React (shadcn) chrome, vitest (run from `resume-designer/`).

**Run tests:** `cd resume-designer && npm test` (or `npx vitest run test/chatThreads.test.js`).

**Commit conventions:** lowercase subject; scopes `chat` / `store` / `ui`; body lines ≤100 chars; footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Use explicit `git add <paths>`, never `-a`.

---

## Refinements vs the spec (discovered during code exploration)

These change *how*, not *what* — behavior matches the approved spec.

1. **No `store.getCurrentVariantId()` accessor.** The store keeps `currentVariantId` private (history only). The active-variant source of truth is `variantManager.getCurrentId()` (non-React) / `useVariants().currentId` (React). Switching = `variantManager.loadVariant(id)`. Reacting = `store.subscribe((event) => event === 'dataLoaded' && …)`. `store.js` is **not** modified.
2. **Message renderer** is `MessageBubble` inside `src/components/chat/MessageList.jsx`. `src/markdownMessage.js` is unrelated legacy code — do not touch it.
3. **AI context note** is an always-on `The user is currently working on the résumé "«Name»".` line appended to the system prompt in `aiService.chat()` (the model always knows the current résumé; the visible divider remains the per-switch UX). No `contextNoteForAI` helper is needed.
4. **Variant-delete prompt** is a small custom dialog (3 outcomes: Cancel / Keep in General / Delete) because the shared `confirmDestructive` returns only a boolean.

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/chatThreads.js` | Thread model + **all pure logic** (migrate, group, marker, pick-current, reassign-on-delete) | Modify |
| `test/chatThreads.test.js` | Unit tests for the pure helpers | Create |
| `src/components/chat/useChat.js` | Home new threads; follow-the-résumé on switch; marker-on-send; re-home; expose grouped threads | Modify |
| `src/components/chat/ThreadSelector.jsx` | Grouped popover (This résumé / General / Other) + re-home + jump | Modify |
| `src/components/chat/MessageList.jsx` | Render `role:'context'` divider row (with Jump) | Modify |
| `src/components/chat/ChatPanel.jsx` | Pinned cross-résumé banner; thread new props through | Modify |
| `src/aiService.js` | Append "working on «Name»" to the system prompt in `chat()` | Modify |
| `src/components/Header.jsx` | Variant-delete: prompt to keep (→General) or delete homed threads | Modify |
| `src/components/chat/DeleteVariantThreadsDialog.jsx` | The 3-outcome dialog | Create |

---

## Task 1: `homeVariantId` on the thread model + `migrateThreads`

**Files:**
- Modify: `resume-designer/src/chatThreads.js` (`makeThread` ~29-38)
- Test: `resume-designer/test/chatThreads.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/chatThreads.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { makeThread, migrateThreads } from '../src/chatThreads.js';

describe('makeThread homeVariantId', () => {
  it('defaults homeVariantId to null (General)', () => {
    expect(makeThread('x').homeVariantId).toBe(null);
  });
  it('stores a provided homeVariantId', () => {
    expect(makeThread('x', [], 'v-1').homeVariantId).toBe('v-1');
  });
});

describe('migrateThreads', () => {
  it('adds homeVariantId: null to legacy threads missing the field', () => {
    const out = migrateThreads([{ id: 'a', name: 'A', messages: [] }]);
    expect(out[0].homeVariantId).toBe(null);
  });
  it('preserves an existing homeVariantId', () => {
    const out = migrateThreads([{ id: 'a', homeVariantId: 'v-9', messages: [] }]);
    expect(out[0].homeVariantId).toBe('v-9');
  });
  it('returns [] for a non-array', () => {
    expect(migrateThreads(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: FAIL — `migrateThreads is not a function` / `homeVariantId` undefined.

- [ ] **Step 3: Implement**

In `resume-designer/src/chatThreads.js`, update `makeThread` to accept + store `homeVariantId`:

```js
export function makeThread(name = 'New Chat', initialMessages = [], homeVariantId = null) {
  const now = new Date().toISOString();
  return {
    id: `thread-${Date.now()}-${randomSuffix()}`,
    name,
    messages: Array.isArray(initialMessages) ? initialMessages : [],
    createdAt: now,
    updatedAt: now,
    homeVariantId,
  };
}
```

Add `migrateThreads` near the other exported helpers (e.g. after `makeThread`):

```js
// Ensure every thread carries homeVariantId (legacy threads predate the field).
// Missing/undefined → null (the "General" group). Pure; callers persist.
export function migrateThreads(threads) {
  if (!Array.isArray(threads)) return [];
  return threads.map((t) => (t && t.homeVariantId === undefined ? { ...t, homeVariantId: null } : t));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/chatThreads.js resume-designer/test/chatThreads.test.js
git commit -m "feat(chat): add homeVariantId to threads + migrateThreads

Default missing homeVariantId to null (General) for backward-compatible
per-résumé thread scoping.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `groupThreadsByHome` + `pickCurrentThreadId`

These drive the selector grouping and the "follow-the-résumé" current-thread choice.

**Files:**
- Modify: `resume-designer/src/chatThreads.js`
- Test: `resume-designer/test/chatThreads.test.js`

- [ ] **Step 1: Write the failing test** (append to the test file)

```js
import { groupThreadsByHome, pickCurrentThreadId } from '../src/chatThreads.js';

const T = (id, home, updatedAt) => ({ id, name: id, messages: [], homeVariantId: home, updatedAt });

describe('groupThreadsByHome', () => {
  const variants = [{ id: 'v1', name: 'Acme' }, { id: 'v2', name: 'Globex' }];
  const threads = [
    T('a', 'v1', '2026-01-03'), T('b', 'v1', '2026-01-05'),
    T('c', null, '2026-01-02'), T('d', 'v2', '2026-01-04'),
    T('e', 'v-deleted', '2026-01-01'),
  ];
  it('splits into current / general / others and sorts current by updatedAt desc', () => {
    const g = groupThreadsByHome(threads, 'v1', variants);
    expect(g.current.map((t) => t.id)).toEqual(['b', 'a']);
    expect(g.general.map((t) => t.id)).toEqual(['c', 'e']); // deleted-home falls into General
    expect(g.others).toEqual([{ variantId: 'v2', variantName: 'Globex', threads: [threads[3]] }]);
  });
  it('current is empty when the active variant has no threads', () => {
    expect(groupThreadsByHome(threads, 'v2', variants).current.map((t) => t.id)).toEqual(['d']);
    expect(groupThreadsByHome([], 'v1', variants).current).toEqual([]);
  });
});

describe('pickCurrentThreadId', () => {
  const threads = [T('a', 'v1', '2026-01-03'), T('b', 'v1', '2026-01-05'), T('c', 'v2', '2026-01-09')];
  it('returns the most-recent thread homed to the active variant', () => {
    expect(pickCurrentThreadId(threads, 'v1')).toBe('b');
  });
  it('returns null when the active variant has no threads', () => {
    expect(pickCurrentThreadId(threads, 'v3')).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement** (add to `chatThreads.js`)

```js
// Newest-first by updatedAt (stable for equal timestamps).
function byUpdatedDesc(a, b) {
  return new Date(b.updatedAt) - new Date(a.updatedAt);
}

/**
 * Split threads for the selector, relative to the active variant.
 * A thread whose homeVariantId is null OR points at a variant not in `variants`
 * falls into `general`. `variants` is [{ id, name }] (useVariants().list).
 * @returns {{ current: Thread[], general: Thread[],
 *            others: { variantId, variantName, threads: Thread[] }[] }}
 */
export function groupThreadsByHome(threads, currentVariantId, variants = []) {
  const known = new Map(variants.map((v) => [v.id, v.name]));
  const current = [];
  const general = [];
  const othersByVariant = new Map();
  for (const t of Array.isArray(threads) ? threads : []) {
    const home = t.homeVariantId ?? null;
    if (home === currentVariantId) current.push(t);
    else if (home === null || !known.has(home)) general.push(t);
    else {
      if (!othersByVariant.has(home)) othersByVariant.set(home, []);
      othersByVariant.get(home).push(t);
    }
  }
  current.sort(byUpdatedDesc);
  general.sort(byUpdatedDesc);
  const others = [...othersByVariant.entries()].map(([variantId, ts]) => ({
    variantId, variantName: known.get(variantId), threads: ts.sort(byUpdatedDesc),
  }));
  return { current, general, others };
}

/** Id of the most-recently-updated thread homed to the active variant, or null. */
export function pickCurrentThreadId(threads, currentVariantId) {
  const homed = (Array.isArray(threads) ? threads : [])
    .filter((t) => (t.homeVariantId ?? null) === currentVariantId)
    .sort(byUpdatedDesc);
  return homed.length ? homed[0].id : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/chatThreads.js resume-designer/test/chatThreads.test.js
git commit -m "feat(chat): add groupThreadsByHome + pickCurrentThreadId helpers

Group threads into current/general/others for the selector and pick the
active variant's most-recent thread for follow-the-résumé switching.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `lastTurnVariantId` + `withContextMarker`

The context-switch divider logic. A `context` marker is appended to a thread's
messages only when a turn happens under a different variant than the previous turn.

**Files:**
- Modify: `resume-designer/src/chatThreads.js`
- Test: `resume-designer/test/chatThreads.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { lastTurnVariantId, withContextMarker } from '../src/chatThreads.js';

describe('lastTurnVariantId', () => {
  it('returns the variantId of the last non-context message', () => {
    const msgs = [
      { role: 'user', variantId: 'v1' },
      { role: 'context', variantId: 'v2' },
      { role: 'assistant', variantId: 'v1' },
    ];
    expect(lastTurnVariantId(msgs)).toBe('v1');
  });
  it('returns null for an empty thread', () => {
    expect(lastTurnVariantId([])).toBe(null);
  });
});

describe('withContextMarker', () => {
  it('appends a context marker when the active variant differs from the last turn', () => {
    const msgs = [{ id: 'm1', role: 'user', variantId: 'v1' }];
    const out = withContextMarker(msgs, 'v2', 'Globex');
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'context', variantId: 'v2', variantName: 'Globex' });
    expect(typeof out[1].id).toBe('string');
  });
  it('is a no-op when the active variant matches the last turn', () => {
    const msgs = [{ id: 'm1', role: 'user', variantId: 'v1' }];
    expect(withContextMarker(msgs, 'v1', 'Acme')).toBe(msgs);
  });
  it('is a no-op for an empty thread (no prior turn to switch from)', () => {
    const msgs = [];
    expect(withContextMarker(msgs, 'v1', 'Acme')).toBe(msgs);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement** (add to `chatThreads.js`)

```js
/** variantId of the last non-context message (the "current context"), or null. */
export function lastTurnVariantId(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role !== 'context') return messages[i].variantId ?? null;
  }
  return null;
}

/**
 * Append a `context` divider marker iff the active variant differs from the
 * thread's last turn AND the thread is non-empty. Returns the SAME array
 * reference when no marker is needed (cheap no-op for the common case).
 */
export function withContextMarker(messages, activeVariantId, activeVariantName) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return messages;
  if (lastTurnVariantId(list) === activeVariantId) return messages;
  const marker = {
    id: `ctx-${Date.now()}-${randomSuffix()}`,
    role: 'context',
    variantId: activeVariantId,
    variantName: activeVariantName,
    timestamp: new Date().toISOString(),
  };
  return [...list, marker];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/chatThreads.js resume-designer/test/chatThreads.test.js
git commit -m "feat(chat): add lastTurnVariantId + withContextMarker helpers

Insert a context-switch divider marker only when a turn happens under a
different résumé than the thread's previous turn.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `reassignThreadsForDeletedVariant`

Pure transform used when a résumé is deleted: either re-home its threads to
General or drop them.

**Files:**
- Modify: `resume-designer/src/chatThreads.js`
- Test: `resume-designer/test/chatThreads.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { reassignThreadsForDeletedVariant } from '../src/chatThreads.js';

describe('reassignThreadsForDeletedVariant', () => {
  const threads = [
    { id: 'a', homeVariantId: 'v1' }, { id: 'b', homeVariantId: 'v2' },
    { id: 'c', homeVariantId: null },
  ];
  it("mode 'general' clears homeVariantId for the deleted variant's threads", () => {
    const out = reassignThreadsForDeletedVariant(threads, 'v1', 'general');
    expect(out.find((t) => t.id === 'a').homeVariantId).toBe(null);
    expect(out.find((t) => t.id === 'b').homeVariantId).toBe('v2'); // untouched
  });
  it("mode 'delete' removes the deleted variant's threads", () => {
    const out = reassignThreadsForDeletedVariant(threads, 'v1', 'delete');
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement** (add to `chatThreads.js`)

```js
/**
 * When a variant is deleted, either move its threads to General
 * (mode 'general') or drop them (mode 'delete'). Pure; caller persists.
 */
export function reassignThreadsForDeletedVariant(threads, deletedVariantId, mode) {
  const list = Array.isArray(threads) ? threads : [];
  if (mode === 'delete') return list.filter((t) => (t.homeVariantId ?? null) !== deletedVariantId);
  return list.map((t) =>
    (t.homeVariantId ?? null) === deletedVariantId ? { ...t, homeVariantId: null } : t);
}

/** Count threads homed to a given variant (for the delete prompt). */
export function countThreadsForVariant(threads, variantId) {
  return (Array.isArray(threads) ? threads : [])
    .filter((t) => (t.homeVariantId ?? null) === variantId).length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd resume-designer && npx vitest run test/chatThreads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/chatThreads.js resume-designer/test/chatThreads.test.js
git commit -m "feat(chat): add reassignThreadsForDeletedVariant + countThreadsForVariant

Move a deleted résumé's threads to General or delete them, and count a
variant's threads for the delete prompt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: AI system note — name the current résumé in `chat()`

**Files:**
- Modify: `resume-designer/src/aiService.js` (`chat()` ~1056-1082)
- Test: `resume-designer/test/aiService.test.js` (extend if it exercises `chat`; otherwise verify manually — see Step 2)

- [ ] **Step 1: Read the current `chat()` body**

Run: `cd resume-designer && sed -n '1056,1082p' src/aiService.js`
Confirm it does: `processedMessages = [...messages]`, conditional résumé-context injection into the last user message, `const { hooks, ...rest } = options`, then calls `streamOpenRouter(model, processedMessages, { ...rest })` (or similar). Note the exact forward call.

- [ ] **Step 2: Implement**

In `chat()`, just before the `streamOpenRouter(...)` call, compose a system prompt that names the current résumé and forward it. `SYSTEM_PROMPT` and `store` are already in module scope:

```js
const { hooks, ...rest } = options;
// Always tell the model which résumé is active, so a thread continued under a
// different résumé isn't reasoned about against the old one. getResumeContext()
// already attaches the résumé's data; this is the explicit one-line cue.
const baseSystem = rest.systemPrompt || SYSTEM_PROMPT;
const activeName = store.getData()?.name;
const systemPrompt = activeName
  ? `${baseSystem}\n\nThe user is currently working on the résumé "${activeName}".`
  : baseSystem;
// ...forward { ...rest, systemPrompt } to streamOpenRouter (replace the existing
// forwarded options object).
```

Update the forward call to pass `{ ...rest, systemPrompt }` (instead of `rest`).

- [ ] **Step 3: Verify**

Run: `cd resume-designer && npm test` — existing `aiService.test.js` must still pass.
Manual: with a key configured, send a chat message; confirm no regression (response streams). The note is additive to the system prompt.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/aiService.js
git commit -m "feat(chat): name the active résumé in the chat system prompt

So a thread continued under a different résumé is reasoned about against the
résumé the user is now viewing, not the earlier one.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Home new threads to the current variant + variant-aware load

**Files:**
- Modify: `resume-designer/src/components/chat/useChat.js` — imports (13-15), init effect (713-721), `newThread` (644-650)

- [ ] **Step 1: Update imports** (line 13-15 block)

```js
import {
  loadThreads, persistThreads, makeThread, trimMessages, clearLegacyHistory,
  migrateThreads, pickCurrentThreadId,
} from '../../chatThreads.js';
import { getCurrentId } from '../../variantManager.js';
```

- [ ] **Step 2: Make `newThread` home to the active variant** (644-650)

```js
const newThread = () => {
  const t = makeThread('New Chat', [], getCurrentId());
  const next = [t, ...threadsRef.current];
  setThreads(next);
  persistThreads(next);
  switchThread(t.id, true);
};
```

- [ ] **Step 3: Make the init effect migrate + pick the active variant's thread** (713-721)

Replace the body that calls `loadThreads()` so it migrates and selects the
current variant's most-recent thread (creating a homed one if none):

```js
useEffect(() => {
  const { threads: loaded } = loadThreads();
  const migrated = migrateThreads(loaded);
  const activeId = getCurrentId();
  let cid = pickCurrentThreadId(migrated, activeId);
  let threadsToSet = migrated;
  if (!cid) {
    const t = makeThread('New Chat', [], activeId);
    threadsToSet = [t, ...migrated];
    cid = t.id;
  }
  setThreads(threadsToSet);
  persistThreads(threadsToSet);
  setCurrentThreadId(cid);
  setMessages(threadsToSet.find((t) => t.id === cid)?.messages || []);
  fetchModelCatalog().then(() => setReasoningSupported(modelSupportsReasoning(modelRef.current))).catch(() => {});
}, [setThreads, setCurrentThreadId, setMessages, modelRef, setReasoningSupported]);
```

(Keep the `fetchModelCatalog()` behavior the original effect had; copy its exact
form from lines 716-720 if it differs.)

- [ ] **Step 4: Verify (in-app)**

Run the app (`npm run dev`), open the chat with a key configured. New chats should
appear under the current résumé. No vitest covers the hook (DOM/React) — verify in
the preview per project convention.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/components/chat/useChat.js
git commit -m "feat(chat): home new threads to the active résumé + pick on load

New threads carry the current variant id; on load, open that variant's
most-recent thread (or a fresh homed one).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Chat follows the résumé (react to variant switch)

**Files:**
- Modify: `resume-designer/src/components/chat/useChat.js` — add a `store` subscription effect; import `store` already present (line 9)

- [ ] **Step 1: Add a follow-the-résumé effect** (near the other effects, after the init effect)

```js
// Follow the active résumé: when the user switches variants (store emits
// 'dataLoaded'), persist the current thread, reload threads from storage (to
// pick up any external mutation, e.g. a variant delete), and open that
// variant's most-recent thread — creating a fresh homed one if it has none.
useEffect(() => {
  const unsub = store.subscribe((event) => {
    if (event !== 'dataLoaded') return;
    const activeId = getCurrentId();
    if (currentThreadIdRef.current) persistCurrentThread(messagesRef.current);
    const migrated = migrateThreads(loadThreads().threads);
    let cid = pickCurrentThreadId(migrated, activeId);
    let next = migrated;
    if (!cid) {
      const t = makeThread('New Chat', [], activeId);
      next = [t, ...migrated];
      cid = t.id;
      persistThreads(next);
    }
    if (abortRef.current) { abortRef.current.abort(); clearStreaming(); }
    setThreads(next);
    setCurrentThreadId(cid);
    setMessages(next.find((t) => t.id === cid)?.messages || []);
  });
  return unsub;
}, [setThreads, setCurrentThreadId, setMessages]);
```

- [ ] **Step 2: Verify (in-app)**

Switch résumés via the Header variant dropdown; the chat should swap to that
résumé's most-recent thread (or a fresh empty one). Switching back restores the
prior thread. Verify in the preview.

- [ ] **Step 3: Commit**

```bash
git add resume-designer/src/components/chat/useChat.js
git commit -m "feat(chat): follow the active résumé on variant switch

Subscribe to the store's dataLoaded event; on switch, persist the current
thread and open the new résumé's most-recent (or a fresh homed) thread.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Tag turns + insert the context marker on send

**Files:**
- Modify: `resume-designer/src/components/chat/useChat.js` — `addMessage`/`commitToThread`/`addMessageTo` (162-196 region) and the `send`/flow start

Goal: every user/assistant/error message carries the `variantId` it was sent
under, and a `context` marker is appended before a turn whose variant differs
from the thread's last turn.

- [ ] **Step 1: Tag messages with the active variant id**

Update `addMessage` (178-179) and `addMessageTo` (the helper added in the earlier
chat-routing fix) to stamp `variantId: getCurrentId()`:

```js
const addMessage = (role, content, applyData = null) =>
  appendMessage({ id: uid(), role, content, applyData, variantId: getCurrentId(), timestamp: new Date().toISOString() });

const addMessageTo = (startThreadId, role, content, applyData = null) =>
  commitToThread(startThreadId, { id: uid(), role, content, applyData, variantId: getCurrentId(), timestamp: new Date().toISOString() });
```

Also stamp `variantId: getCurrentId()` on the streamed assistant/error commits in
`getAIResponse` (278-288) and `requestAIChanges` (362-389) — add `variantId: getCurrentId(),`
to each committed message object.

- [ ] **Step 2: Insert the context marker at the top of `send`** for the active thread

In `send` (572-602), right after the provider guard and BEFORE `addMessage('user', text)`
(line 590), insert a context marker into the current thread when the active variant
differs from the thread's last turn:

```js
import { withContextMarker } from '../../chatThreads.js'; // add to the existing import

// inside send(), before addMessage('user', text):
const withMarker = withContextMarker(messagesRef.current, getCurrentId(), store.getData()?.name);
if (withMarker !== messagesRef.current) {
  setMessages(withMarker);
  persistCurrentThread(withMarker);
}
```

To avoid duplicating this between `send` and `handleCommand`, define one local
helper in the hook body (near `addMessage`) and call it at the start of both:

```js
const markContextIfSwitched = () => {
  const withMarker = withContextMarker(messagesRef.current, getCurrentId(), store.getData()?.name);
  if (withMarker !== messagesRef.current) {
    setMessages(withMarker);
    persistCurrentThread(withMarker);
  }
};
```

In `send`, call `markContextIfSwitched();` immediately before `addMessage('user', text)`
(line 590). In `handleCommand`, call it as the first line (so `/feedback` etc. results
are also preceded by a divider when the résumé changed).

- [ ] **Step 3: Skip context markers in the AI history**

In `getAIResponse` (253-256) the history filter already keeps only `user`/`assistant`
roles, so `context` markers are naturally excluded. Confirm no other flow maps raw
messages to the API without that filter.

- [ ] **Step 4: Verify (in-app)**

Open a thread from "other résumés'" (Task 11) — or temporarily switch variants while
a thread is open — then send a message; a divider appears before the new turn. Sending
again under the same résumé adds no new divider. Verify in the preview.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/components/chat/useChat.js
git commit -m "feat(chat): tag turns with their résumé + mark context switches

Stamp each message with the active variant id and insert a context divider
when a turn happens under a different résumé than the thread's last turn.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Re-home action + expose grouped threads to the panel

**Files:**
- Modify: `resume-designer/src/components/chat/useChat.js` — add `moveThreadToCurrentVariant`; export it + a `currentVariantId` value in the hook return (729-739)

- [ ] **Step 1: Add the re-home handler** (near `deleteThread`)

```js
const moveThreadToCurrentVariant = (threadId) => {
  const activeId = getCurrentId();
  const next = threadsRef.current.map((t) =>
    t.id === threadId ? { ...t, homeVariantId: activeId, updatedAt: new Date().toISOString() } : t);
  setThreads(next);
  persistThreads(next);
};
```

- [ ] **Step 2: Expose what the selector needs** in the hook's return object (729-739)

Add to the returned object: `moveThreadToCurrentVariant,` and a live active id the
selector can group by: `currentVariantId: getCurrentId(),`. (It re-reads on every
render; the follow effect already re-renders on switch.)

- [ ] **Step 3: Verify**

Run: `cd resume-designer && npm test` (no regressions). Hook wiring verified with
Task 11 in the app.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/components/chat/useChat.js
git commit -m "feat(chat): expose re-home action + active variant id to the panel

Add moveThreadToCurrentVariant and surface currentVariantId so the selector
can group threads and re-home them.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Render the `context` divider row

**Files:**
- Modify: `resume-designer/src/components/chat/MessageList.jsx` — `MessageBubble` (75-131)

- [ ] **Step 1: Add a `context` branch at the very top of `MessageBubble`**

Right after the function opens (before the `role === 'error'` check), add:

```jsx
import { loadVariant } from '../../variantManager.js'; // add to imports

// ...inside MessageBubble(msg, ...), first lines:
if (msg.role === 'context') {
  return (
    <div className="my-2 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">Now discussing</span>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
        onClick={() => loadVariant(msg.variantId)}
        title={`Jump to ${msg.variantName}`}
      >
        {msg.variantName}
      </button>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
```

- [ ] **Step 2: Verify (in-app)**

With a thread that has a `context` marker (from Task 8), the divider renders as a
centered "Now discussing «Name»" row; clicking the name switches the active résumé
(via `loadVariant`). `loadVariant` no-ops on a deleted id, so a stale divider button
is safe. Verify in the preview.

- [ ] **Step 3: Commit**

```bash
git add resume-designer/src/components/chat/MessageList.jsx
git commit -m "feat(ui): render the context-switch divider with a jump button

A role:'context' message renders as a 'Now discussing «Name»' divider whose
button switches the active résumé via loadVariant.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Grouped thread selector + re-home + jump

**Files:**
- Modify: `resume-designer/src/components/chat/ThreadSelector.jsx` (props 17; popover 48-87)
- Modify: `resume-designer/src/components/chat/ChatPanel.jsx` (selector render 158-168)

- [ ] **Step 1: Pass the new props from ChatPanel** (158-168)

Add to the `<ThreadSelector .../>` call: `currentVariantId={chat.currentVariantId}`,
`variants={variants.list}`, `onMoveToCurrent={chat.moveThreadToCurrentVariant}`. Get
`variants` via the existing `useVariants()` hook (import it in ChatPanel:
`import { useVariants } from '../../hooks/useVariants.js'`, then `const variants = useVariants();`).

First confirm the list item shape: run `cd resume-designer && grep -n "getVariantsSnapshot\|list:" src/variantManager.js` and check that each `variants.list` item exposes `{ id, name }`. If the display name lives under a different key, map it to `{ id, name }` before passing to `groupThreadsByHome` (which keys headers off `name`).

- [ ] **Step 2: Group + render in ThreadSelector** (replace the flat map at 62-85)

```jsx
import { getThreadDisplayName, groupThreadsByHome } from '../../chatThreads.js';
import { loadVariant } from '../../variantManager.js';
// signature:
export function ThreadSelector({ threads, currentThreadId, currentVariantId, variants,
  onSwitch, onNew, onDelete, onMoveToCurrent }) {
```

Inside the popover body, compute groups and render three sections (current / general /
others). Each row keeps the existing hover-delete; "other" + "general" rows get a
small "Move here" affordance calling `onMoveToCurrent(t.id)`:

```jsx
const { current, general, others } = groupThreadsByHome(threads, currentVariantId, variants);

const Row = (t, { showMove } = {}) => (
  <div key={t.id}
    className={cn('group flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
      t.id === currentThreadId && 'bg-accent text-accent-foreground')}
    onClick={() => { onSwitch(t.id); setOpen(false); }}>
    <span className="min-w-0 flex-1 truncate">{getThreadDisplayName(t)}</span>
    {showMove && (
      <Button variant="ghost" size="icon" className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
        title="Move to this résumé" aria-label="Move to this résumé"
        onClick={(e) => { e.stopPropagation(); onMoveToCurrent(t.id); }}>
        <CornerUpLeft className="size-3.5" />
      </Button>
    )}
    <Button variant="ghost" size="icon"
      className="size-5 shrink-0 opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      title="Delete thread" aria-label="Delete thread"
      onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}>
      <X className="size-3.5" />
    </Button>
  </div>
);

const SectionLabel = ({ children }) => (
  <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>
);
```

Then in the scroll area:

```jsx
<div className="max-h-[320px] overflow-y-auto">
  {current.map((t) => Row(t))}
  {general.length > 0 && (<><SectionLabel>General</SectionLabel>{general.map((t) => Row(t, { showMove: true }))}</>)}
  {others.map((grp) => (
    <div key={grp.variantId}>
      <SectionLabel>{grp.variantName}</SectionLabel>
      {grp.threads.map((t) => Row(t, { showMove: true }))}
    </div>
  ))}
</div>
```

Add `CornerUpLeft` to the lucide-react import (line 2).

- [ ] **Step 3: Verify (in-app)**

The selector shows the current résumé's threads, then General, then a section per
other résumé. Clicking an "other" thread opens it WITHOUT switching résumés (the
follow effect only fires on a real variant switch, not on `onSwitch`). "Move here"
re-homes a thread to the current résumé. Verify in the preview.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/components/chat/ThreadSelector.jsx resume-designer/src/components/chat/ChatPanel.jsx
git commit -m "feat(ui): group the thread selector by résumé + add move-here

Split threads into This résumé / General / Other résumés' threads, with a
move-to-current action on non-current threads.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Pinned cross-résumé banner

**Files:**
- Modify: `resume-designer/src/components/chat/ChatPanel.jsx` — a `shrink-0` sibling between the header (closes ~169) and `<MessageList>` (171)

- [ ] **Step 1: Compute the open thread's home vs active variant** (in ChatPanel, near the `useChat()` consumption)

```jsx
const variants = useVariants(); // from Task 11
const openThread = chat.threads.find((t) => t.id === chat.currentThreadId);
const openHome = openThread?.homeVariantId ?? null;
const crossRésumé = openHome !== null && openHome !== chat.currentVariantId;
const homeName = variants.list.find((v) => v.id === openHome)?.name;
```

- [ ] **Step 2: Render the banner** between the header div and `<MessageList>`

```jsx
{chat.configured && crossRésumé && homeName && (
  <div className="shrink-0 border-b bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground flex items-center justify-between gap-2">
    <span className="min-w-0 truncate">Thread from «{homeName}»</span>
    <button type="button" className="shrink-0 font-medium text-foreground hover:underline"
      onClick={() => loadVariant(openHome)}>Jump</button>
  </div>
)}
```

Add `import { loadVariant } from '../../variantManager.js';` to ChatPanel imports.

- [ ] **Step 3: Verify (in-app)**

Open a thread from another résumé: the slim banner appears with a working Jump;
when the open thread belongs to the active résumé, no banner. Verify in the preview.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/components/chat/ChatPanel.jsx
git commit -m "feat(ui): banner when viewing a thread from another résumé

Pinned slim banner with a Jump action when the open thread's home differs
from the active résumé.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Variant-delete → keep/delete threads prompt

**Files:**
- Create: `resume-designer/src/components/chat/DeleteVariantThreadsDialog.jsx`
- Modify: `resume-designer/src/components/Header.jsx` — `handleDelete` (125-139)

- [ ] **Step 1: Build the 3-outcome dialog** (create the file)

Model it on the existing `confirm.jsx` AlertDialog pattern but with two actions +
cancel. Minimal imperative API mirroring `confirmDestructive`:

```jsx
import { useState } from 'react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';

let resolver = null;
let setStateExternal = null;

export function DeleteVariantThreadsHost() {
  const [state, setState] = useState(null); // { name, count } | null
  setStateExternal = setState;
  const finish = (result) => { setState(null); resolver?.(result); resolver = null; };
  if (!state) return null;
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) finish('cancel'); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{state.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This résumé has {state.count} chat thread{state.count === 1 ? '' : 's'}.
            Keep them (moved to General) or delete them too?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish('cancel')}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => finish('keep')}>Keep threads</AlertDialogAction>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => finish('delete')}>Delete threads</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function askDeleteVariantThreads({ name, count }) {
  return new Promise((resolve) => { resolver = resolve; setStateExternal?.({ name, count }); });
}
```

Mount `<DeleteVariantThreadsHost />` once where `ConfirmHost` is mounted (App root —
grep `ConfirmHost` to find it and add the sibling).

- [ ] **Step 2: Wire into `Header.handleDelete`** (125-139)

```jsx
import { loadThreads, persistThreads, reassignThreadsForDeletedVariant, countThreadsForVariant } from '../chatThreads.js';
import { getCurrentId } from '../variantManager.js';
import { askDeleteVariantThreads } from './chat/DeleteVariantThreadsDialog.jsx';

// inside handleDelete, after the last-variant guard and BEFORE deleteCurrentVariant():
const deletingId = getCurrentId();
const all = loadThreads().threads;
const n = countThreadsForVariant(all, deletingId);
if (n > 0) {
  const choice = await askDeleteVariantThreads({ name: currentName, count: n });
  if (choice === 'cancel') return;
  persistThreads(reassignThreadsForDeletedVariant(all, deletingId, choice === 'delete' ? 'delete' : 'general'));
} else {
  const ok = await confirmDestructive({ title: `Delete “${currentName}”?`,
    description: 'This résumé will be permanently deleted.', actionLabel: 'Delete' });
  if (!ok) return;
}
deleteCurrentVariant();
```

(Preserve the existing confirm copy/behavior for the no-threads path; the thread
reassignment MUST run before `deleteCurrentVariant()` so the variant id still exists.
After delete, `loadVariant(newId)` fires `dataLoaded`, and useChat's follow effect
reloads threads — so the moved/deleted threads are reflected automatically.)

- [ ] **Step 3: Verify (in-app)**

Delete a résumé that has threads: the prompt offers Keep / Delete / Cancel. "Keep"
moves them to General (visible in the selector after the switch); "Delete" removes
them; "Cancel" aborts. Deleting a résumé with no threads behaves as before. Verify
in the preview.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src/components/chat/DeleteVariantThreadsDialog.jsx resume-designer/src/components/Header.jsx
git commit -m "feat(ui): prompt to keep or delete threads on résumé delete

When a deleted résumé has chat threads, ask to move them to General or
delete them; reassign before the variant is removed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd resume-designer && npm test` — all green (69 existing + the new `chatThreads` tests).
- [ ] `cd resume-designer && npm run build` — compiles clean.
- [ ] In-app smoke (preview), using fabricated sample data only:
  - New chats home to the current résumé; switching résumés swaps the thread.
  - "Other résumés' threads" opens in place; banner + Jump work; dividers appear and jump.
  - General group holds legacy threads; "Move here" re-homes.
  - Résumé delete prompts keep/delete and behaves correctly.
- [ ] Open the PR into `next` and run it through the Codex flow.
