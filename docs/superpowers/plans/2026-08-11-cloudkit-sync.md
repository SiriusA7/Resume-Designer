# CloudKit Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync a person's résumés, job descriptions, applications, chat threads and version history across their Apple devices through their own iCloud account.

**Architecture:** JS owns *what a unit is* — classifying storage keys, splitting `resume-designer-data` into a record per résumé, merging token usage, and writing a conflict's loser into version history. Swift owns *transport only* — zones, change tokens, conflict detection, retry — and treats every payload as an opaque string. This split exists because the native side must never learn the document's schema, and it is what makes a future Mac client a transport-only job.

**Tech Stack:** Plain ES modules under `src/sync/`, vitest, SwiftUI + CloudKit (`CKSyncEngine` where available, `CKDatabase` operations otherwise).

**Design:** `docs/superpowers/specs/2026-08-11-cloudkit-sync-design.md`

## Global Constraints

- **Swift never parses a payload.** A record is `{ unitId, kind, payload, modifiedAt }`; `payload` is an opaque JSON string. Any decomposition of the résumé document happens in JS.
- **Storage keys are frozen.** `resume-designer-*` / `resume-*` key names are filenames and data addresses. Never rename one. Any key-related change is driven off `BACKUP_FIXED_KEYS` in `src/profileKeys.js`.
- **The on-disk format does not change.** Decomposition is a sync-layer view; what `appStorage` writes to disk stays byte-identical.
- **Never sweep on the bare string `resume-`** — it also names the `.resume-page` / `.resume-sidebar` CSS classes pagination depends on.
- **Device-local keys never leave the machine:** `currentVariantId` (inside the data blob), `resume-zoom`, `resume-designer-active-profile`, `resume-designer-theme`, `resume-designer-update-channel`, `resume-designer-auto-update-check`, `resume-designer-bridge-token`, `resume-designer-model-catalog`, `resume-designer-electron-migration-attempted`.
- **The API key never syncs.** It lives in the OS keychain, not `appStorage`.
- **Deletions are explicit tombstones.** Absence is never read as deletion — an empty local store meeting a populated cloud must not wipe the cloud.
- **Payloads over 700KB encoded** are stored as a `CKAsset`, chosen purely on byte count.
- **One CloudKit record zone per profile**, in the private database.
- Conventional commits, subjects start lowercase. Never commit or push without being asked.
- Gate before every commit: `npm run test`, `npm run lint` (2 pre-existing warnings are the baseline), `npx vite build`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/sync/syncKeys.js` | Classify every logical storage key as synced or device-local. Nothing else. |
| `src/sync/syncUnits.js` | Split `resume-designer-data` into units and reassemble it. Pure. |
| `src/sync/syncMerge.js` | Token-usage merge and conflict resolution. Pure. |
| `src/sync/syncModel.js` | The only file that touches `appStorage`. Collects units, applies remote units, writes conflict losers to history. |
| `src/iosShell.js` | Bridge commands the Swift transport calls. |
| `src-tauri/ios/OPSync.swift` | CloudKit transport: zones, tokens, push/pull, conflict detection, assets. |

---

### Task 1: Key classification

Every logical key is synced or device-local, and nothing falls through. This is the task that makes a mistake loud instead of quiet.

**Files:**
- Create: `resume-designer/src/sync/syncKeys.js`
- Test: `resume-designer/test/syncKeys.test.js`

**Interfaces:**
- Consumes: `BACKUP_FIXED_KEYS`, `BACKUP_HISTORY_PREFIX` from `src/profileKeys.js`
- Produces: `classifyKey(logicalKey) -> 'synced' | 'local' | 'unknown'`, `DEVICE_LOCAL_KEYS: string[]`

- [ ] **Step 1: Write the failing test**

```js
// resume-designer/test/syncKeys.test.js
import { describe, it, expect } from 'vitest';
import { classifyKey, DEVICE_LOCAL_KEYS } from '../src/sync/syncKeys.js';
import { BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX } from '../src/profileKeys.js';

describe('classifyKey', () => {
  it('classifies every key the backup knows about', () => {
    // The whole point: a key added to BACKUP_FIXED_KEYS without a sync
    // decision fails here rather than silently defaulting to synced (which
    // would leak device state) or local (which would lose content).
    for (const key of BACKUP_FIXED_KEYS) {
      expect(classifyKey(key), key).not.toBe('unknown');
    }
  });

  it('syncs version history, which is the conflict recovery path', () => {
    expect(classifyKey(`${BACKUP_HISTORY_PREFIX}variant-abc`)).toBe('synced');
  });

  it('keeps device state on the device', () => {
    expect(classifyKey('resume-zoom')).toBe('local');
    expect(classifyKey('resume-designer-theme')).toBe('local');
    expect(classifyKey('resume-designer-active-profile')).toBe('local');
    expect(classifyKey('resume-designer-update-channel')).toBe('local');
    expect(classifyKey('resume-designer-model-catalog')).toBe('local');
  });

  it('syncs content', () => {
    expect(classifyKey('resume-designer-data')).toBe('synced');
    expect(classifyKey('resume-designer-applications')).toBe('synced');
    expect(classifyKey('resume-designer-job-descriptions')).toBe('synced');
    expect(classifyKey('resume-designer-chat-threads')).toBe('synced');
  });

  it('reports an unrecognised key rather than guessing', () => {
    expect(classifyKey('resume-designer-something-new')).toBe('unknown');
    expect(classifyKey('')).toBe('unknown');
  });

  it('never lists a device-local key that is not a real key', () => {
    for (const key of DEVICE_LOCAL_KEYS) {
      expect(BACKUP_FIXED_KEYS.includes(key), key).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js`
Expected: FAIL — `Failed to resolve import "../src/sync/syncKeys.js"`

- [ ] **Step 3: Write the implementation**

```js
// resume-designer/src/sync/syncKeys.js
/**
 * Which storage keys sync, and which stay on the device.
 *
 * Exhaustive over `BACKUP_FIXED_KEYS` by construction: anything not named here
 * comes back 'unknown', and the test above fails. That is deliberate — a key
 * added later without a sync decision must not default to either answer.
 * Defaulting to synced leaks device state (a synced `currentVariantId` makes
 * one device change documents because another did); defaulting to local loses
 * content silently.
 */
import { BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX } from '../profileKeys.js';

/** Never leaves the machine. Each entry has a reason, because none is obvious. */
export const DEVICE_LOCAL_KEYS = [
  // A zoom that suits a phone is wrong on a Mac.
  'resume-zoom',
  // Commonly "follow the system", which a synced value fights on a device
  // whose system setting differs.
  'resume-designer-theme',
  // Which profile you are in is a property of a device.
  'resume-designer-active-profile',
  // A beta Mac beside a stable phone is a legitimate setup.
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  // The loopback companion bridge is machine-specific.
  'resume-designer-bridge-token',
  // A regenerable cache.
  'resume-designer-model-catalog',
  // A historical fact about one machine.
  'resume-designer-electron-migration-attempted',
];

const LOCAL = new Set(DEVICE_LOCAL_KEYS);

export function classifyKey(logicalKey) {
  if (typeof logicalKey !== 'string' || !logicalKey) return 'unknown';
  if (LOCAL.has(logicalKey)) return 'local';
  // Version history is per-variant and syncs: it is where a conflict's losing
  // edit is parked, and a loser stranded on one device is no use from another.
  if (logicalKey.startsWith(BACKUP_HISTORY_PREFIX)) return 'synced';
  if (BACKUP_FIXED_KEYS.includes(logicalKey)) return 'synced';
  return 'unknown';
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Check `DEVICE_LOCAL_KEYS` against the real list**

Run: `cd resume-designer && node -e "import('./src/profileKeys.js').then(m=>console.log(m.BACKUP_FIXED_KEYS.join('\n')))"`

Read the output. Every key printed must be either in `DEVICE_LOCAL_KEYS` or a content key you are content to sync. If `resume-designer-openrouter-key` appears, it is the legacy credential name — leave it unclassified only if `BACKUP_FIXED_KEYS` does not contain it; if it does, add it to `DEVICE_LOCAL_KEYS` with the comment `// A credential. Never syncs; see the spec.` and add a test asserting `classifyKey('resume-designer-openrouter-key') === 'local'`.

- [ ] **Step 6: Commit**

```bash
git add resume-designer/src/sync/syncKeys.js resume-designer/test/syncKeys.test.js
git commit -m "feat(sync): classify which storage keys sync"
```

---

### Task 2: Split and reassemble the résumé document

`resume-designer-data` holds every résumé plus `currentVariantId`, `settings` and `userProfile` in one file. Splitting it is what stops two devices editing *different* résumés from colliding.

**Files:**
- Create: `resume-designer/src/sync/syncUnits.js`
- Test: `resume-designer/test/syncUnits.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `splitData(blob) -> SyncUnit[]` where `SyncUnit` is `{ id: string, kind: 'resume'|'plain', payload: string }`
  - `mergeData(blob, units) -> object` — returns a new blob, never mutates
  - `RESUME_UNIT_PREFIX = 'resume:'`

- [ ] **Step 1: Write the failing test**

```js
// resume-designer/test/syncUnits.test.js
import { describe, it, expect } from 'vitest';
import { splitData, mergeData, RESUME_UNIT_PREFIX } from '../src/sync/syncUnits.js';

const BLOB = {
  variants: {
    'v-1': { name: 'Design Engineer', data: { name: 'Ash' } },
    'v-2': { name: 'Product Lead', data: { name: 'Ash' } },
  },
  currentVariantId: 'v-1',
  settings: { pageSize: 'letter' },
  userProfile: { headline: 'Designer' },
};

describe('splitData', () => {
  it('emits one unit per résumé', () => {
    const ids = splitData(BLOB).filter((u) => u.kind === 'resume').map((u) => u.id);
    expect(ids.sort()).toEqual([`${RESUME_UNIT_PREFIX}v-1`, `${RESUME_UNIT_PREFIX}v-2`]);
  });

  it('gives settings and the user profile their own units', () => {
    const ids = splitData(BLOB).map((u) => u.id);
    expect(ids).toContain('data:settings');
    expect(ids).toContain('data:userProfile');
  });

  it('never emits currentVariantId', () => {
    // Which résumé is open is device-local. Syncing it makes one device change
    // documents because another did.
    const serialized = JSON.stringify(splitData(BLOB));
    expect(serialized).not.toContain('currentVariantId');
    expect(serialized).not.toContain('v-1"'); // not as a bare value anywhere
  });

  it('survives a blob with nothing in it', () => {
    expect(splitData({})).toEqual([]);
    expect(splitData(null)).toEqual([]);
  });
});

describe('mergeData', () => {
  it('round-trips a blob through split and merge unchanged', () => {
    const merged = mergeData(BLOB, splitData(BLOB));
    expect(merged).toEqual(BLOB);
  });

  it('keeps the local currentVariantId, which never travelled', () => {
    const local = { ...BLOB, currentVariantId: 'v-2' };
    expect(mergeData(local, splitData(BLOB)).currentVariantId).toBe('v-2');
  });

  it('preserves top-level keys the splitter did not know about', () => {
    // A future key added to the blob must not be destroyed by a sync round
    // trip written before it existed.
    const withExtra = { ...BLOB, futureThing: { a: 1 } };
    expect(mergeData(withExtra, splitData(BLOB)).futureThing).toEqual({ a: 1 });
  });

  it('adds a résumé that only exists remotely', () => {
    const units = splitData(BLOB);
    const merged = mergeData({ variants: {}, currentVariantId: null }, units);
    expect(Object.keys(merged.variants).sort()).toEqual(['v-1', 'v-2']);
  });

  it('does not mutate the blob it was given', () => {
    const local = JSON.parse(JSON.stringify(BLOB));
    mergeData(local, splitData({ ...BLOB, variants: { 'v-3': { name: 'New' } } }));
    expect(Object.keys(local.variants).sort()).toEqual(['v-1', 'v-2']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd resume-designer && npx vitest run test/syncUnits.test.js`
Expected: FAIL — `Failed to resolve import "../src/sync/syncUnits.js"`

- [ ] **Step 3: Write the implementation**

```js
// resume-designer/src/sync/syncUnits.js
/**
 * Splitting `resume-designer-data` into sync units, and putting it back.
 *
 * That one file holds every résumé plus `currentVariantId`, `settings` and
 * `userProfile`. A record per storage key would therefore make editing résumé
 * A on a phone collide with résumé B on a Mac and silently discard one — the
 * central case for a résumé app, not an edge case. So the blob is decomposed.
 *
 * The on-disk format is untouched: this is a view for the sync layer only, and
 * `mergeData` reassembles exactly what was there.
 *
 * Pure — no storage, no DOM.
 */

export const RESUME_UNIT_PREFIX = 'resume:';

/** Top-level blob keys that become their own units. */
const PLAIN_FIELDS = ['settings', 'userProfile'];

/**
 * `currentVariantId` is absent from this list ON PURPOSE and must stay absent:
 * which résumé is open is a property of a device.
 */
export function splitData(blob) {
  if (!blob || typeof blob !== 'object') return [];
  const units = [];

  const variants = blob.variants;
  if (variants && typeof variants === 'object') {
    for (const [id, variant] of Object.entries(variants)) {
      units.push({
        id: `${RESUME_UNIT_PREFIX}${id}`,
        kind: 'resume',
        payload: JSON.stringify(variant),
      });
    }
  }

  for (const field of PLAIN_FIELDS) {
    if (blob[field] !== undefined) {
      units.push({ id: `data:${field}`, kind: 'plain', payload: JSON.stringify(blob[field]) });
    }
  }

  return units;
}

/**
 * Reassemble, without mutating `blob`.
 *
 * Unknown top-level keys are carried through untouched: a key added to the
 * document after this code was written must survive a sync round trip.
 */
export function mergeData(blob, units) {
  const base = blob && typeof blob === 'object' ? blob : {};
  const next = { ...base, variants: { ...(base.variants || {}) } };

  for (const unit of Array.isArray(units) ? units : []) {
    if (!unit || typeof unit.payload !== 'string') continue;
    let value;
    try {
      value = JSON.parse(unit.payload);
    } catch {
      // A corrupt payload is skipped rather than allowed to throw: one bad
      // record must not stop the rest of a sync landing.
      continue;
    }
    if (unit.id.startsWith(RESUME_UNIT_PREFIX)) {
      next.variants[unit.id.slice(RESUME_UNIT_PREFIX.length)] = value;
    } else if (unit.id.startsWith('data:')) {
      const field = unit.id.slice('data:'.length);
      if (PLAIN_FIELDS.includes(field)) next[field] = value;
    }
  }

  return next;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd resume-designer && npx vitest run test/syncUnits.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/sync/syncUnits.js resume-designer/test/syncUnits.test.js
git commit -m "feat(sync): split the résumé document into per-résumé units"
```

---

### Task 3: Token-usage merge and conflict resolution

Two rules live here. Newer-wins for almost everything, and a real merge for the one unit where newer-wins is actively wrong.

**Files:**
- Create: `resume-designer/src/sync/syncMerge.js`
- Test: `resume-designer/test/syncMerge.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `mergeTokenUsage(a, b) -> object`
  - `resolveConflict(local, remote) -> { winner, loser }` where both arguments are `{ payload: string, modifiedAt: string }`

- [ ] **Step 1: Write the failing test**

```js
// resume-designer/test/syncMerge.test.js
import { describe, it, expect } from 'vitest';
import { mergeTokenUsage, resolveConflict } from '../src/sync/syncMerge.js';

const event = (id, over = {}) => ({
  id, timestamp: '2026-08-01T00:00:00.000Z', provider: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5', feature: 'chat',
  inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheCreation: 0,
  reasoningTokens: 5, cost: 0.5, ...over,
});

const usage = (events) => ({ events, summary: { byModel: {}, byFeature: {} } });

describe('mergeTokenUsage', () => {
  it('unions events by id rather than letting one device replace the other', () => {
    const merged = mergeTokenUsage(usage([event('a'), event('b')]), usage([event('b'), event('c')]));
    expect(merged.events.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent and order-independent', () => {
    const x = usage([event('a'), event('b')]);
    const y = usage([event('b'), event('c')]);
    expect(mergeTokenUsage(x, y)).toEqual(mergeTokenUsage(y, x));
    expect(mergeTokenUsage(mergeTokenUsage(x, y), y)).toEqual(mergeTokenUsage(x, y));
  });

  it('recomputes the summary rather than merging it', () => {
    // `summary` is derived from `events`, so merging it would double-count.
    const merged = mergeTokenUsage(
      usage([event('a', { inputTokens: 1, outputTokens: 2, cost: 0.1 })]),
      usage([event('b', { inputTokens: 3, outputTokens: 4, cost: 0.3 })]),
    );
    expect(merged.summary.totalInputTokens).toBe(4);
    expect(merged.summary.totalOutputTokens).toBe(6);
    expect(merged.summary.totalCost).toBeCloseTo(0.4, 10);
    expect(merged.summary.byModel['anthropic/claude-sonnet-4.5'].calls).toBe(2);
  });

  it('orders events oldest first, as the tracker writes them', () => {
    const merged = mergeTokenUsage(
      usage([event('late', { timestamp: '2026-08-09T00:00:00.000Z' })]),
      usage([event('early', { timestamp: '2026-08-01T00:00:00.000Z' })]),
    );
    expect(merged.events.map((e) => e.id)).toEqual(['early', 'late']);
  });

  it('survives a side with no events', () => {
    expect(mergeTokenUsage(usage([]), usage([event('a')])).events).toHaveLength(1);
    expect(mergeTokenUsage(null, usage([event('a')])).events).toHaveLength(1);
    expect(mergeTokenUsage(null, null).events).toEqual([]);
  });
});

describe('resolveConflict', () => {
  const local = { payload: '{"a":1}', modifiedAt: '2026-08-05T00:00:00.000Z' };
  const remote = { payload: '{"a":2}', modifiedAt: '2026-08-09T00:00:00.000Z' };

  it('keeps the newer edit and hands back the loser', () => {
    expect(resolveConflict(local, remote)).toEqual({ winner: remote, loser: local });
    expect(resolveConflict(remote, local)).toEqual({ winner: remote, loser: local });
  });

  it('prefers the remote on an exact tie, so two devices agree', () => {
    // Both sides run this. If they broke the tie differently they would
    // converge on different winners and sync forever.
    const a = { payload: '{"a":1}', modifiedAt: '2026-08-05T00:00:00.000Z' };
    const b = { payload: '{"a":2}', modifiedAt: '2026-08-05T00:00:00.000Z' };
    expect(resolveConflict(a, b).winner).toBe(b);
  });

  it('treats an unparseable timestamp as older than a real one', () => {
    const broken = { payload: '{}', modifiedAt: 'not a date' };
    expect(resolveConflict(broken, local).winner).toBe(local);
    expect(resolveConflict(local, broken).winner).toBe(local);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd resume-designer && npx vitest run test/syncMerge.test.js`
Expected: FAIL — `Failed to resolve import "../src/sync/syncMerge.js"`

- [ ] **Step 3: Write the implementation**

```js
// resume-designer/src/sync/syncMerge.js
/**
 * The two merge rules. Pure — no storage, no DOM.
 */

/**
 * Union two token-usage documents.
 *
 * The ONE unit where newer-wins is actively wrong: both devices append events,
 * so taking the newer document discards the other's calls outright. Every
 * event carries a unique id and `summary` is derived from `events`, so the
 * correct merge is a union by id followed by a recomputed summary — which also
 * means the summary can never drift from the events it describes.
 *
 * Mirrors the accumulation in `trackUsage` (src/tokenTrackingService.js).
 */
export function mergeTokenUsage(a, b) {
  const events = new Map();
  for (const doc of [a, b]) {
    for (const event of Array.isArray(doc?.events) ? doc.events : []) {
      if (event && typeof event.id === 'string') events.set(event.id, event);
    }
  }
  const merged = [...events.values()].sort(
    (x, y) => String(x.timestamp).localeCompare(String(y.timestamp)),
  );
  return { events: merged, summary: summarize(merged) };
}

function summarize(events) {
  const summary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    totalCalls: 0,
    byModel: {},
    byFeature: {},
  };
  const bucket = () => ({
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0, calls: 0,
  });
  for (const e of events) {
    const input = e.inputTokens || 0;
    const output = e.outputTokens || 0;
    // `|| 0`: events written before reasoningTokens existed lack the field.
    const reasoning = e.reasoningTokens || 0;
    const cost = e.cost || 0;

    summary.totalInputTokens += input;
    summary.totalOutputTokens += output;
    summary.totalReasoningTokens += reasoning;
    summary.totalCost += cost;
    summary.totalCalls += 1;

    for (const [map, key] of [[summary.byModel, e.model], [summary.byFeature, e.feature]]) {
      if (!key) continue;
      if (!map[key]) map[key] = bucket();
      map[key].inputTokens += input;
      map[key].outputTokens += output;
      map[key].reasoningTokens += reasoning;
      map[key].cost += cost;
      map[key].calls += 1;
    }
  }
  return summary;
}

/**
 * Newer wins.
 *
 * Both devices run this, so the tie-break has to be one both sides compute the
 * same way — otherwise they converge on different winners and sync forever.
 * The remote wins an exact tie, arbitrarily but consistently.
 *
 * An unparseable timestamp loses to a real one: a record with a broken stamp
 * should not be able to overwrite a good edit.
 */
export function resolveConflict(local, remote) {
  const at = (side) => {
    const value = Date.parse(side?.modifiedAt ?? '');
    return Number.isFinite(value) ? value : -Infinity;
  };
  return at(local) > at(remote)
    ? { winner: local, loser: remote }
    : { winner: remote, loser: local };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd resume-designer && npx vitest run test/syncMerge.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src/sync/syncMerge.js resume-designer/test/syncMerge.test.js
git commit -m "feat(sync): merge token usage and resolve conflicts by recency"
```

---

### Task 4: The sync model — the only file that touches storage

Collects units from `appStorage`, applies remote units back, and writes a conflict's loser into version history.

**Files:**
- Create: `resume-designer/src/sync/syncModel.js`
- Test: `resume-designer/test/syncModel.test.js`
- Modify: `resume-designer/src/profileKeys.js` — add `resume-designer-sync-state` to `BACKUP_FIXED_KEYS`

**Interfaces:**
- Consumes: `classifyKey` (Task 1), `splitData` / `mergeData` / `RESUME_UNIT_PREFIX` (Task 2), `mergeTokenUsage` / `resolveConflict` (Task 3)
- Produces:
  - `collectUnits() -> SyncUnit[]` where `SyncUnit` is `{ id, kind, payload, modifiedAt }`
  - `applyUnits(units) -> { applied: number }`
  - `parkLoser(unitId, payload) -> boolean`
  - `touchUnit(unitId)` — stamps a unit's local modification time

**Why a new key:** units other than a résumé have no modification timestamp anywhere in storage, and conflict resolution needs one. `resume-designer-sync-state` maps `unitId -> { modifiedAt }`. It is added to `BACKUP_FIXED_KEYS` so it is profile-namespaced like everything else, and classified `local` in Task 1's list because it describes this device's view of sync.

- [ ] **Step 1: Add the new key to the inventory**

In `resume-designer/src/profileKeys.js`, inside `BACKUP_FIXED_KEYS`, after `'resume-designer-token-usage',` add:

```js
  // Per-unit modification times for CloudKit sync. Device-local (see
  // src/sync/syncKeys.js) but namespaced and round-tripped like every other
  // key, because it is per-profile.
  'resume-designer-sync-state',
```

Then in `resume-designer/src/sync/syncKeys.js` add `'resume-designer-sync-state',` to `DEVICE_LOCAL_KEYS` with the comment `// This device's view of what it has synced.`

- [ ] **Step 2: Run Task 1's test to confirm the inventory still classifies cleanly**

Run: `cd resume-designer && npx vitest run test/syncKeys.test.js`
Expected: PASS — the new key is classified `local`, so "classifies every key the backup knows about" still holds

- [ ] **Step 3: Write the failing test**

```js
// resume-designer/test/syncModel.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// appStorage is the only dependency, and it is mocked so these tests stay
// pure: the real one is an async coalescing writer over a disk backend.
const store = new Map();
vi.mock('../src/appStorage.js', () => ({
  appStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
    keys: () => [...store.keys()],
  },
}));

const { collectUnits, applyUnits, parkLoser, touchUnit } = await import('../src/sync/syncModel.js');

const DATA = 'resume-designer-data';

beforeEach(() => {
  store.clear();
  store.set(DATA, JSON.stringify({
    variants: { 'v-1': { name: 'Design Engineer' } },
    currentVariantId: 'v-1',
    settings: { pageSize: 'letter' },
  }));
  store.set('resume-designer-applications', '[]');
  store.set('resume-zoom', '1.5');
});

describe('collectUnits', () => {
  it('emits a unit per résumé and per synced key, and nothing device-local', () => {
    const ids = collectUnits().map((u) => u.id);
    expect(ids).toContain('resume:v-1');
    expect(ids).toContain('key:resume-designer-applications');
    expect(ids).not.toContain('key:resume-zoom');
    // The data blob never travels whole — it travels decomposed.
    expect(ids).not.toContain('key:resume-designer-data');
  });

  it('stamps every unit with a modification time', () => {
    for (const unit of collectUnits()) {
      expect(Number.isFinite(Date.parse(unit.modifiedAt)), unit.id).toBe(true);
    }
  });

  it('marks token usage with its own kind so the transport can merge it', () => {
    store.set('resume-designer-token-usage', JSON.stringify({ events: [], summary: {} }));
    const unit = collectUnits().find((u) => u.id === 'key:resume-designer-token-usage');
    expect(unit.kind).toBe('tokenUsage');
  });
});

describe('applyUnits', () => {
  it('lands a remote résumé without touching the local currentVariantId', () => {
    applyUnits([{
      id: 'resume:v-2', kind: 'resume',
      payload: JSON.stringify({ name: 'Product Lead' }),
      modifiedAt: '2026-08-09T00:00:00.000Z',
    }]);
    const blob = JSON.parse(store.get(DATA));
    expect(Object.keys(blob.variants).sort()).toEqual(['v-1', 'v-2']);
    expect(blob.currentVariantId).toBe('v-1');
  });

  it('merges token usage instead of replacing it', () => {
    store.set('resume-designer-token-usage', JSON.stringify({
      events: [{ id: 'mine', timestamp: '2026-08-01T00:00:00.000Z', inputTokens: 1 }],
      summary: {},
    }));
    applyUnits([{
      id: 'key:resume-designer-token-usage', kind: 'tokenUsage',
      payload: JSON.stringify({
        events: [{ id: 'theirs', timestamp: '2026-08-02T00:00:00.000Z', inputTokens: 2 }],
        summary: {},
      }),
      modifiedAt: '2026-08-09T00:00:00.000Z',
    }]);
    const merged = JSON.parse(store.get('resume-designer-token-usage'));
    expect(merged.events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    expect(merged.summary.totalInputTokens).toBe(3);
  });

  it('refuses a unit for a key that is device-local', () => {
    const before = store.get('resume-zoom');
    applyUnits([{ id: 'key:resume-zoom', kind: 'plain', payload: '"2"', modifiedAt: '2026-08-09T00:00:00.000Z' }]);
    expect(store.get('resume-zoom')).toBe(before);
  });

  it('reports how many landed, so a caller can tell a no-op from a failure', () => {
    expect(applyUnits([]).applied).toBe(0);
  });
});

describe('parkLoser', () => {
  it('writes a losing résumé into that résumé’s version history', () => {
    const ok = parkLoser('resume:v-1', JSON.stringify({ name: 'The version that lost' }));
    expect(ok).toBe(true);
    const history = JSON.parse(store.get('resume-designer-history-variant-v-1'));
    expect(history.at(-1).data).toEqual({ name: 'The version that lost' });
    expect(history.at(-1).reason).toBe('sync-conflict');
  });

  it('refuses a unit that is not a résumé, which has no history to park in', () => {
    expect(parkLoser('key:resume-designer-applications', '[]')).toBe(false);
  });
});

describe('touchUnit', () => {
  it('records a modification time that collectUnits then reports', () => {
    touchUnit('resume:v-1');
    const unit = collectUnits().find((u) => u.id === 'resume:v-1');
    const state = JSON.parse(store.get('resume-designer-sync-state'));
    expect(unit.modifiedAt).toBe(state['resume:v-1'].modifiedAt);
  });
});
```

- [ ] **Step 4: Run the test and watch it fail**

Run: `cd resume-designer && npx vitest run test/syncModel.test.js`
Expected: FAIL — `Failed to resolve import "../src/sync/syncModel.js"`

- [ ] **Step 5: Write the implementation**

```js
// resume-designer/src/sync/syncModel.js
/**
 * The sync layer's only contact with storage.
 *
 * Everything above this file is pure; everything below it is `appStorage`.
 * Swift calls into here through the bridge and never learns any of it: a unit
 * crosses as `{ id, kind, payload, modifiedAt }` with an opaque payload.
 */
import { appStorage } from '../appStorage.js';
import { classifyKey } from './syncKeys.js';
import { splitData, mergeData, RESUME_UNIT_PREFIX } from './syncUnits.js';
import { mergeTokenUsage, resolveConflict } from './syncMerge.js';

const DATA_KEY = 'resume-designer-data';
const TOKEN_KEY = 'resume-designer-token-usage';
const STATE_KEY = 'resume-designer-sync-state';
const KEY_UNIT_PREFIX = 'key:';
const HISTORY_PREFIX = 'resume-designer-history-variant-';

const readJSON = (key, fallback) => {
  const raw = appStorage.getItem(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const state = () => readJSON(STATE_KEY, {});

/** Now, or the recorded time if this unit has one. */
function modifiedAtFor(unitId, recorded) {
  return recorded[unitId]?.modifiedAt || new Date().toISOString();
}

/**
 * Stamp a unit as changed locally. Called when the app writes something the
 * sync layer cares about; without it, units other than résumés have no
 * timestamp anywhere in storage and conflicts could not be resolved.
 */
export function touchUnit(unitId) {
  const next = state();
  next[unitId] = { modifiedAt: new Date().toISOString() };
  appStorage.setItem(STATE_KEY, JSON.stringify(next));
}

/**
 * Everything this device would push.
 *
 * The data blob is decomposed rather than sent whole — see syncUnits.js.
 * Device-local keys are filtered out here rather than at the transport, so a
 * transport bug cannot leak them.
 */
export function collectUnits() {
  const recorded = state();
  const units = [];

  for (const unit of splitData(readJSON(DATA_KEY, null))) {
    units.push({ ...unit, modifiedAt: modifiedAtFor(unit.id, recorded) });
  }

  for (const key of appStorage.keys()) {
    if (key === DATA_KEY) continue; // decomposed above
    if (classifyKey(key) !== 'synced') continue;
    const id = `${KEY_UNIT_PREFIX}${key}`;
    units.push({
      id,
      kind: key === TOKEN_KEY ? 'tokenUsage' : 'plain',
      payload: appStorage.getItem(key) ?? '',
      modifiedAt: modifiedAtFor(id, recorded),
    });
  }

  return units;
}

/**
 * Land units that arrived from another device.
 *
 * Résumé units are merged into the blob so `currentVariantId` — which never
 * travelled — is left alone. Token usage takes the union rule. A unit naming a
 * device-local key is refused: nothing should have sent it, and honouring it
 * would let one device's zoom overwrite another's.
 */
export function applyUnits(units) {
  const incoming = Array.isArray(units) ? units : [];
  const resumeUnits = incoming.filter((u) => u?.id?.startsWith(RESUME_UNIT_PREFIX));
  let applied = 0;

  if (resumeUnits.length > 0) {
    const blob = readJSON(DATA_KEY, {});
    appStorage.setItem(DATA_KEY, JSON.stringify(mergeData(blob, resumeUnits)));
    applied += resumeUnits.length;
  }

  for (const unit of incoming) {
    if (!unit?.id?.startsWith(KEY_UNIT_PREFIX)) continue;
    const key = unit.id.slice(KEY_UNIT_PREFIX.length);
    if (classifyKey(key) !== 'synced') continue;

    if (key === TOKEN_KEY) {
      let remote;
      try {
        remote = JSON.parse(unit.payload);
      } catch {
        continue;
      }
      const merged = mergeTokenUsage(readJSON(TOKEN_KEY, null), remote);
      appStorage.setItem(TOKEN_KEY, JSON.stringify(merged));
    } else {
      appStorage.setItem(key, unit.payload);
    }
    applied += 1;
  }

  return { applied };
}

/**
 * Park a conflict's losing version in that résumé's history.
 *
 * This is what makes newer-wins safe: nothing is destroyed, and recovery is a
 * restore the app already supports. Only résumés have history, so a non-résumé
 * unit returns false rather than inventing somewhere to put it.
 */
export function parkLoser(unitId, payload) {
  if (typeof unitId !== 'string' || !unitId.startsWith(RESUME_UNIT_PREFIX)) return false;
  const variantId = unitId.slice(RESUME_UNIT_PREFIX.length);
  if (!variantId) return false;

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return false;
  }

  const key = `${HISTORY_PREFIX}${variantId}`;
  const history = readJSON(key, []);
  const entries = Array.isArray(history) ? history : [];
  entries.push({
    at: new Date().toISOString(),
    reason: 'sync-conflict',
    data,
  });
  appStorage.setItem(key, JSON.stringify(entries));
  return true;
}

export { resolveConflict };
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd resume-designer && npx vitest run test/syncModel.test.js`
Expected: PASS, 9 tests

- [ ] **Step 7: Check the history entry shape against the real one**

Run: `cd resume-designer && grep -n "at:\|data:\|label\|reason" src/versionHistory.js | head -20`

The entries `parkLoser` writes must be readable by whatever renders version history. If the real entries carry fields this one omits (a label, a variant name), add them to the object in `parkLoser` and extend the test's assertion to check them. If the history file is not `src/versionHistory.js`, find it with `grep -rln "resume-designer-history-variant" src`.

- [ ] **Step 8: Run the full gate and commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
git add resume-designer/src/sync/ resume-designer/test/sync*.test.js resume-designer/src/profileKeys.js
git commit -m "feat(sync): collect, apply and park sync units"
```

Expected: all tests pass, lint at its 2 pre-existing warnings, build succeeds.

---

### Task 5: Bridge commands

Swift's only way into the model.

**Files:**
- Modify: `resume-designer/src/iosShell.js` — add commands to `createCommandDispatcher`'s action map, and `sync` to `buildSnapshot`
- Modify: `resume-designer/src/main.js` — inject the sync deps
- Test: `resume-designer/test/iosShell.test.js` — add to the `mount()` describe block

**Interfaces:**
- Consumes: `collectUnits`, `applyUnits`, `parkLoser`, `touchUnit` (Task 4)
- Produces: commands `syncCollect`, `syncApply`, `syncParkLoser`; snapshot key `sync`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe` block in `resume-designer/test/iosShell.test.js` that defines `mount()`:

```js
  it('hands Swift units it never has to understand', async () => {
    const collectUnits = vi.fn(() => ([
      { id: 'resume:v-1', kind: 'resume', payload: '{"name":"A"}', modifiedAt: '2026-08-09T00:00:00.000Z' },
    ]));
    const { send } = await mount({ collectUnits });
    expect(send({ type: 'syncCollect' })).toEqual({ ok: true });
    expect(collectUnits).toHaveBeenCalled();
  });

  it('applies units and parks a conflict loser', async () => {
    const applyUnits = vi.fn(() => ({ applied: 1 }));
    const parkLoser = vi.fn(() => true);
    const { send } = await mount({ applyUnits, parkLoser });

    send({ type: 'syncApply', units: '[{"id":"resume:v-1","kind":"resume","payload":"{}","modifiedAt":"2026-08-09T00:00:00.000Z"}]' });
    expect(applyUnits).toHaveBeenCalledWith([
      { id: 'resume:v-1', kind: 'resume', payload: '{}', modifiedAt: '2026-08-09T00:00:00.000Z' },
    ]);

    send({ type: 'syncParkLoser', unitId: 'resume:v-1', payload: '{"name":"lost"}' });
    expect(parkLoser).toHaveBeenCalledWith('resume:v-1', '{"name":"lost"}');
  });

  it('reports malformed units as data rather than throwing', async () => {
    const applyUnits = vi.fn();
    const { send } = await mount({ applyUnits });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(send({ type: 'syncApply', units: 'not json' }).ok).toBe(false);
    expect(applyUnits).not.toHaveBeenCalled();
    spy.mockRestore();
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd resume-designer && npx vitest run test/iosShell.test.js`
Expected: FAIL — `unknown-command:syncCollect`

- [ ] **Step 3: Add the commands**

In `resume-designer/src/iosShell.js`, inside the object passed to `createCommandDispatcher` (alongside `moveItem` / `addItem`), add:

```js
    // CloudKit sync. Swift calls these and never parses a payload: a unit is
    // `{ id, kind, payload, modifiedAt }` and the payload is an opaque string.
    // Units cross as a JSON STRING because the command channel is a JS string
    // literal — the same reason a picked file crosses as base64.
    syncCollect: () => {
      const units = deps.collectUnits();
      window.webkit?.messageHandlers?.[SHELL_HANDLER]?.postMessage({
        kind: 'syncUnits', units,
      });
    },
    syncApply: ({ units }) => {
      const parsed = JSON.parse(String(units ?? '[]'));
      if (!Array.isArray(parsed)) throw new Error('syncApply needs an array of units');
      deps.applyUnits(parsed);
    },
    syncParkLoser: ({ unitId, payload }) =>
      deps.parkLoser(String(unitId ?? ''), String(payload ?? '')),
```

- [ ] **Step 4: Inject the dependencies**

In `resume-designer/src/main.js`, add to the top-level imports:

```js
import { collectUnits, applyUnits, parkLoser, touchUnit } from './sync/syncModel.js';
```

and inside the `initIOSShell({ … })` call, after `removeListItem`, add:

```js
    // CloudKit sync. The model owns what a unit is; the shell only carries it.
    collectUnits, applyUnits, parkLoser, touchUnit,
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd resume-designer && npx vitest run test/iosShell.test.js`
Expected: PASS

- [ ] **Step 6: Run the full gate and commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
git add resume-designer/src/iosShell.js resume-designer/src/main.js resume-designer/test/iosShell.test.js
git commit -m "feat(sync): expose the sync model over the bridge"
```

---

### Task 6: CloudKit container and zones

The first task with a device dependency. It ends with a zone existing in your real iCloud account.

**Files:**
- Create: `resume-designer/src-tauri/ios/OPSync.swift`
- Modify: `resume-designer/src-tauri/gen/apple/project.yml` — add the iCloud entitlement

**Interfaces:**
- Consumes: nothing
- Produces: `OPSyncEngine` with `func zone(for profileId: String) async throws -> CKRecordZone`, `struct SyncUnit: Codable { let id, kind, payload, modifiedAt: String }`

- [ ] **Step 1: Add the entitlement**

In `resume-designer/src-tauri/gen/apple/project.yml`, under the iOS target's `entitlements.properties`, add:

```yaml
        com.apple.developer.icloud-container-identifiers:
          - iCloud.com.resumedesigner.app
        com.apple.developer.icloud-services:
          - CloudKit
        com.apple.developer.ubiquity-kvstore-identifier: $(TeamIdentifierPrefix)$(CFBundleIdentifier)
```

The container identifier is `iCloud.com.resumedesigner.app` — derived from the frozen bundle identifier, which must not change.

- [ ] **Step 2: Write the transport skeleton**

```swift
// resume-designer/src-tauri/ios/OPSync.swift
//
// CloudKit transport. Zones, tokens, push, pull, conflict detection, retry.
//
// **This file never parses a payload.** A unit crosses as
// `{ id, kind, payload, modifiedAt }` with `payload` an opaque JSON string,
// because decomposing the résumé document is schema knowledge and the native
// side does not hold any. That is also what makes a future Mac client a
// transport-only job: it reimplements this file and nothing below it.
//
// Its JS counterpart is src/sync/syncModel.js.

import CloudKit
import Foundation

/// Mirrors the unit shape in src/sync/syncModel.js.
struct SyncUnit: Codable, Equatable {
  let id: String
  /// "resume" | "plain" | "tokenUsage" — enough to route a conflict without
  /// understanding the contents.
  let kind: String
  let payload: String
  let modifiedAt: String
}

/// Payloads larger than this go to a CKAsset. CloudKit caps a record's fields
/// at roughly 1MB; the headroom covers the other fields and encoding overhead,
/// so the decision never has to be revisited at the boundary.
let opSyncAssetThreshold = 700 * 1024

@MainActor
final class OPSyncEngine {
  private let container = CKContainer(identifier: "iCloud.com.resumedesigner.app")
  private var database: CKDatabase { container.privateCloudDatabase }
  private var zones: [String: CKRecordZone] = [:]

  /// One zone per profile: atomic per-profile fetches, and a clean per-profile
  /// delete. The zone name is the profile id, which is already a stable
  /// identifier on disk.
  func zone(for profileId: String) async throws -> CKRecordZone {
    if let cached = zones[profileId] { return cached }
    let zone = CKRecordZone(zoneName: profileId)
    let saved = try await database.modifyRecordZones(saving: [zone], deleting: [])
    _ = saved
    zones[profileId] = zone
    return zone
  }

  /// Whether sync can run at all. Checked before every operation: signed out
  /// is a normal state, not an error, and must never wipe local data.
  func accountAvailable() async -> Bool {
    (try? await container.accountStatus()) == .available
  }
}
```

- [ ] **Step 3: Compile**

Run: `cd resume-designer && OP_SIM_UDID=<your-simulator-udid> npm run ios:sim`
Expected: builds and installs with no `error:` lines. Use `npm run ios:sim` and never a bare `tauri ios build` — only the script runs `xcodegen generate`, without which a new Swift file is not in the target and the failure reads as nonsense.

- [ ] **Step 4: Verify a zone is really created**

Add temporarily to `OPShell.swift`'s `activate` handling:

```swift
      Task { @MainActor in
        let engine = OPSyncEngine()
        NSLog("[OPSync] account available: \(await engine.accountAvailable())")
        if let zone = try? await engine.zone(for: "probe-zone") {
          NSLog("[OPSync] zone ok: \(zone.zoneID.zoneName)")
        } else {
          NSLog("[OPSync] zone FAILED")
        }
      }
```

Build to a **device** (the simulator has no iCloud account unless you sign one in):

```bash
cd resume-designer && rm -rf src-tauri/gen/apple/build/arm64 \
  && (cd src-tauri/gen/apple && xcodegen generate >/dev/null) \
  && npx tauri ios build --debug --target aarch64 \
  && xcrun devicectl device install app --device <device-udid> "src-tauri/gen/apple/build/arm64/On Paper.ipa" \
  && xcrun devicectl device process launch --device <device-udid> com.resumedesigner.app
```

Expected in Console.app filtered to "OPSync": `account available: true` then `zone ok: probe-zone`.

If `account available: false`, the device is not signed into iCloud. If the zone fails with a permissions error, the entitlement or the provisioning profile does not carry the container — check the container exists in the CloudKit dashboard.

- [ ] **Step 5: Remove the probe and commit**

Delete the temporary `Task { … }` block added in Step 4.

```bash
git add resume-designer/src-tauri/ios/OPSync.swift resume-designer/src-tauri/gen/apple/project.yml
git commit -m "feat(sync): add the CloudKit container and per-profile zones"
```

---

### Task 7: Push and pull

**Files:**
- Modify: `resume-designer/src-tauri/ios/OPSync.swift`
- Modify: `resume-designer/src-tauri/ios/OPShell.swift` — handle the `syncUnits` message

**Interfaces:**
- Consumes: `SyncUnit`, `OPSyncEngine.zone(for:)`, `opSyncAssetThreshold` (Task 6)
- Produces: `func push(_ units: [SyncUnit], profileId: String) async throws -> [SyncUnit]` (returns units that lost a conflict), `func pull(profileId: String) async throws -> [SyncUnit]`

- [ ] **Step 1: Add record conversion**

Append to `OPSync.swift`:

```swift
private let opSyncRecordType = "SyncUnit"

extension OPSyncEngine {
  /// A unit as a record. The payload goes into a field, or into an asset when
  /// it is too large — chosen purely on byte count, so this stays ignorant of
  /// what it is carrying.
  func record(for unit: SyncUnit, in zone: CKRecordZone) throws -> CKRecord {
    let id = CKRecord.ID(recordName: unit.id, zoneID: zone.zoneID)
    let record = CKRecord(recordType: opSyncRecordType, recordID: id)
    record["kind"] = unit.kind as CKRecordValue
    record["modifiedAt"] = unit.modifiedAt as CKRecordValue

    let data = Data(unit.payload.utf8)
    if data.count > opSyncAssetThreshold {
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
      try data.write(to: url)
      record["asset"] = CKAsset(fileURL: url)
    } else {
      record["payload"] = unit.payload as CKRecordValue
    }
    return record
  }

  /// The inverse. Returns nil for a record missing both payload forms, which
  /// is a corrupt record rather than an empty unit.
  func unit(from record: CKRecord) -> SyncUnit? {
    let kind = record["kind"] as? String ?? "plain"
    let modifiedAt = record["modifiedAt"] as? String ?? ""
    if let payload = record["payload"] as? String {
      return SyncUnit(id: record.recordID.recordName, kind: kind,
                      payload: payload, modifiedAt: modifiedAt)
    }
    if let asset = record["asset"] as? CKAsset,
       let url = asset.fileURL,
       let data = try? Data(contentsOf: url),
       let payload = String(data: data, encoding: .utf8) {
      return SyncUnit(id: record.recordID.recordName, kind: kind,
                      payload: payload, modifiedAt: modifiedAt)
    }
    return nil
  }
}
```

- [ ] **Step 2: Add push and pull**

Append to `OPSync.swift`:

```swift
extension OPSyncEngine {
  /// Send units up. Returns the ones that LOST a conflict, for the caller to
  /// park in version history.
  ///
  /// Per-record outcomes, not all-or-nothing: one failed record is retried and
  /// does not fail its neighbours.
  func push(_ units: [SyncUnit], profileId: String) async throws -> [SyncUnit] {
    guard await accountAvailable() else { return [] }
    let zone = try await self.zone(for: profileId)
    let records = try units.map { try record(for: $0, in: zone) }

    let result = try await database.modifyRecords(
      saving: records, deleting: [], savePolicy: .ifServerRecordUnchanged
    )

    var losers: [SyncUnit] = []
    for (recordID, outcome) in result.saveResults {
      guard case .failure(let error) = outcome else { continue }
      guard let ckError = error as? CKError, ckError.code == .serverRecordChanged,
            let serverRecord = ckError.serverRecord,
            let serverUnit = unit(from: serverRecord),
            let localUnit = units.first(where: { $0.id == recordID.recordName })
      else { continue }

      // Newer wins. The tie goes to the server so both devices break it the
      // same way — otherwise they converge on different winners and sync
      // forever.
      let localAt = ISO8601DateFormatter().date(from: localUnit.modifiedAt) ?? .distantPast
      let serverAt = ISO8601DateFormatter().date(from: serverUnit.modifiedAt) ?? .distantPast
      if localAt > serverAt {
        // Ours is newer: overwrite the server, and their copy is the loser.
        let forced = try record(for: localUnit, in: zone)
        forced.setValuesForKeys([:])
        _ = try? await database.modifyRecords(
          saving: [forced], deleting: [], savePolicy: .changedKeys
        )
        losers.append(serverUnit)
      } else {
        // Theirs is newer: ours is the loser and the server already holds the
        // winner, which the next pull will bring down.
        losers.append(localUnit)
      }
    }
    return losers
  }

  /// Fetch what changed since the last pull. Tokens are per-zone and persisted
  /// by the caller so a pull is incremental rather than a full download.
  func pull(profileId: String, since token: CKServerChangeToken?) async throws
    -> (units: [SyncUnit], token: CKServerChangeToken?) {
    guard await accountAvailable() else { return ([], token) }
    let zone = try await self.zone(for: profileId)

    let result = try await database.recordZoneChanges(
      inZoneWith: zone.zoneID, since: token
    )
    let units = result.modificationResultsByID.values.compactMap { outcome -> SyncUnit? in
      guard case .success(let modification) = outcome else { return nil }
      return unit(from: modification.record)
    }
    return (units, result.changeToken)
  }
}
```

- [ ] **Step 3: Compile**

Run: `cd resume-designer && OP_SIM_UDID=<your-simulator-udid> npm run ios:sim`
Expected: no `error:` lines.

If `modifyRecords(saving:deleting:savePolicy:)` or `recordZoneChanges(inZoneWith:since:)` do not exist on this SDK, check the available async CloudKit API with:

```bash
grep -rn "func modifyRecords\|func recordZoneChanges" \
  "$(xcrun --sdk iphoneos --show-sdk-path)/System/Library/Frameworks/CloudKit.framework/Modules/CloudKit.swiftmodule/" 2>/dev/null | head
```

and adjust the call sites to the signatures that are actually there. Do not change the semantics: per-record outcomes, `.ifServerRecordUnchanged` on save, and an incremental token on fetch.

- [ ] **Step 4: Commit**

```bash
git add resume-designer/src-tauri/ios/OPSync.swift
git commit -m "feat(sync): push and pull records with per-record outcomes"
```

---

### Task 8: Wire the loop together

The end-to-end path: collect from JS, push, pull, apply back, park losers.

**Files:**
- Modify: `resume-designer/src-tauri/ios/OPShell.swift` — handle the `syncUnits` message and drive the loop
- Modify: `resume-designer/src-tauri/ios/OPSync.swift` — persist the change token

**Interfaces:**
- Consumes: `push`, `pull` (Task 7); bridge commands `syncCollect`, `syncApply`, `syncParkLoser` (Task 5)
- Produces: `func syncNow(profileId: String) async` on `OPSyncEngine`

- [ ] **Step 1: Persist the change token**

Append to `OPSync.swift`:

```swift
extension OPSyncEngine {
  /// The change token, per profile. `UserDefaults` rather than the app's own
  /// storage: it is device-local sync bookkeeping and must never round-trip
  /// through a backup, where restoring an old token would silently skip
  /// changes.
  private func tokenKey(_ profileId: String) -> String { "op.sync.token.\(profileId)" }

  func storedToken(for profileId: String) -> CKServerChangeToken? {
    guard let data = UserDefaults.standard.data(forKey: tokenKey(profileId)) else { return nil }
    return try? NSKeyedUnarchiver.unarchivedObject(
      ofClass: CKServerChangeToken.self, from: data
    )
  }

  func store(token: CKServerChangeToken?, for profileId: String) {
    guard let token,
          let data = try? NSKeyedArchiver.archivedData(
            withRootObject: token, requiringSecureCoding: true
          )
    else { return }
    UserDefaults.standard.set(data, forKey: tokenKey(profileId))
  }
}
```

- [ ] **Step 2: Add the message handler**

In `OPShell.swift`'s `userContentController(_:didReceive:)`, in the `switch body["kind"] as? String` block, before `case "activated":` add:

```swift
    case "syncUnits":
      // The reply to `syncCollect`. Units are opaque here — see OPSync.swift.
      guard let raw = body["units"] as? [[String: Any]] else { return }
      let units: [SyncUnit] = raw.compactMap { item in
        guard let id = item["id"] as? String,
              let kind = item["kind"] as? String,
              let payload = item["payload"] as? String,
              let modifiedAt = item["modifiedAt"] as? String
        else { return nil }
        return SyncUnit(id: id, kind: kind, payload: payload, modifiedAt: modifiedAt)
      }
      Task { @MainActor in await self.model?.completeSyncCollection(units) }
```

- [ ] **Step 3: Drive the loop from ShellModel**

Add to `ShellModel` in `OPShell.swift`:

```swift
  /// The sync engine, and the continuation waiting on `syncCollect`'s reply.
  private let sync = OPSyncEngine()
  private var pendingCollection: CheckedContinuation<[SyncUnit], Never>?

  func completeSyncCollection(_ units: [SyncUnit]) {
    pendingCollection?.resume(returning: units)
    pendingCollection = nil
  }

  /// One reconciliation. Local writes have already landed locally — this is
  /// background reconciliation and nothing in the app waits on it.
  func syncNow(profileId: String) async {
    let units = await withCheckedContinuation { (continuation: CheckedContinuation<[SyncUnit], Never>) in
      pendingCollection = continuation
      send("syncCollect")
    }

    let losers = (try? await sync.push(units, profileId: profileId)) ?? []
    for loser in losers where loser.kind == "resume" {
      send("syncParkLoser", ["unitId": loser.id, "payload": loser.payload])
    }

    let token = sync.storedToken(for: profileId)
    guard let pulled = try? await sync.pull(profileId: profileId, since: token) else { return }
    sync.store(token: pulled.token, for: profileId)
    guard !pulled.units.isEmpty,
          let encoded = try? JSONEncoder().encode(pulled.units),
          let json = String(data: encoded, encoding: .utf8)
    else { return }
    send("syncApply", ["units": json])
  }
```

- [ ] **Step 4: Compile and verify the loop end to end on two devices**

Run: `cd resume-designer && OP_SIM_UDID=<your-simulator-udid> npm run ios:sim`
Expected: no `error:` lines.

Then build to your iPhone and a second Apple device signed into the same iCloud account (the recipe is in Task 6, Step 4). On device A, edit a résumé's name. Trigger `syncNow`. On device B, trigger `syncNow` and confirm the edit arrives.

Then the conflict path: put both devices in airplane mode, edit the SAME résumé differently on each, bring both online, sync A then B. Expected: both devices end with the newer edit, and the older one appears in that résumé's version history on the device that lost.

- [ ] **Step 5: Commit**

```bash
git add resume-designer/src-tauri/ios/
git commit -m "feat(sync): reconcile local and remote in one pass"
```

---

### Task 9: Settings control and status

Sync a user cannot see or turn off is not finished.

**Files:**
- Modify: `resume-designer/src-tauri/ios/OPShell.swift` — a Sync section in `SettingsSheet`
- Modify: `resume-designer/src/iosShell.js` — `buildSettings` gains `syncEnabled` and `syncStatus`

**Interfaces:**
- Consumes: `syncNow` (Task 8)
- Produces: settings projection fields `syncEnabled: Bool`, `syncStatus: String`

- [ ] **Step 1: Write the failing test**

Add to the `describe('buildSettings')` block in `resume-designer/test/iosShell.test.js`:

```js
  it('projects sync state, defaulting to off', () => {
    expect(buildSettings({}).syncEnabled).toBe(false);
    expect(buildSettings({}).syncStatus).toBe('');
    expect(buildSettings({ syncEnabled: true, syncStatus: 'Synced just now' }))
      .toMatchObject({ syncEnabled: true, syncStatus: 'Synced just now' });
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd resume-designer && npx vitest run test/iosShell.test.js`
Expected: FAIL — `expected undefined to be false`

- [ ] **Step 3: Extend the projection**

In `resume-designer/src/iosShell.js`, in `buildSettings`, add to the destructured parameters `syncEnabled = false, syncStatus = ''` and to the returned object:

```js
    // Sync is OFF until asked for: it writes a person's résumés into their
    // iCloud account, which is not a default to assume.
    syncEnabled: !!syncEnabled,
    syncStatus: typeof syncStatus === 'string' ? syncStatus : '',
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd resume-designer && npx vitest run test/iosShell.test.js`
Expected: PASS

- [ ] **Step 5: Add the Swift fields and the settings section**

In `OPShell.swift`'s `Settings` struct add:

```swift
    var syncEnabled: Bool
    var syncStatus: String
```

In `SettingsSheet`'s form, before the closing brace of the last `Section`, add:

```swift
        Section {
          Toggle("Sync with iCloud", isOn: syncBinding)
          if !snapshot.settings.syncStatus.isEmpty {
            Text(snapshot.settings.syncStatus)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        } header: {
          Text("Sync")
        } footer: {
          Text("Your résumés stay in your own iCloud account. "
               + "Nothing is sent to On Paper.")
        }
```

with the binding alongside the sheet's other bindings:

```swift
  private var syncBinding: Binding<Bool> {
    Binding(
      get: { model.snapshot.settings.syncEnabled },
      set: { model.send("setSyncEnabled", ["value": $0 ? "true" : "false"]) }
    )
  }
```

- [ ] **Step 6: Add the command**

In `resume-designer/src/iosShell.js`'s action map, beside the other settings commands:

```js
    setSyncEnabled: ({ value }) => deps.setSyncEnabled(value === 'true'),
```

and in `resume-designer/src/main.js`'s `initIOSShell({ … })`:

```js
    setSyncEnabled: (on) => saveSettings({ syncEnabled: on }),
```

- [ ] **Step 7: Run the full gate, verify on device, and commit**

```bash
cd resume-designer && npm run test && npm run lint && npx vite build
```

Then build to the device and confirm the toggle appears in Settings, that turning it on starts a sync, and that turning it off stops one.

```bash
git add resume-designer/src resume-designer/test resume-designer/src-tauri/ios
git commit -m "feat(sync): add the iCloud sync toggle and status"
```

---

## Self-review notes

Checked against the spec:

- **Platform scope** — Tasks 6-9 are iOS-only; nothing in Tasks 1-5 references a platform, so the Mac client reimplements Tasks 6-8 alone. ✅
- **Record granularity** — Task 2. ✅
- **Conflict resolution** — Task 3 (`resolveConflict`), Task 4 (`parkLoser`), Task 7 (detection), Task 8 (the loop). ✅
- **Multi-profile zones** — Task 6. ✅
- **What syncs / device-local** — Task 1, enforced by an exhaustiveness test. ✅
- **Token-usage merge** — Task 3. ✅
- **Record size / assets** — Task 7, Step 1. ✅
- **Offline** — the loop never blocks the app (Task 8) and every operation checks `accountAvailable` first (Tasks 6-7). ✅
- **First sync on a fresh device** — partially covered: `mergeData` adds remote résumés without removing local ones, and nothing in this plan deletes. **No tombstone mechanism is built**, so deleting a résumé on one device does not delete it on another. That is a deliberate gap, called out below rather than half-built.
- **Account changes, quota** — `accountAvailable` gates every operation; quota surfacing is **not** built.

## Known gaps, deliberately

1. **Deletion does not propagate.** Deleting a résumé on one device leaves it on the others, and the next sync restores it. A tombstone record type plus a reaping rule is its own design problem — getting it wrong deletes people's résumés — and it needs a spec section before it needs a task.
2. **Sync is manual.** `syncNow` has no caller. Subscriptions, background refresh, and a trigger on app foreground are a follow-on; this plan ends with a loop that provably works when run.
3. **Quota exceeded is not surfaced.** The write fails and is retried; the user is not told.
4. **No retention.** Neither version history nor the token log is pruned, so both grow without bound against the asset threshold.

Each is a follow-on plan, not a missing step in this one.
