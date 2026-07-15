# Multi-Profile Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two (or more) people share one Resume Designer install with fully separated workspaces (résumés, job descriptions, applications, chats, history, onboarding), switchable from the header.

**Architecture:** Profile isolation happens at the `appStorage` facade: per-profile logical keys map to physical keys `resume-p:<profileId>:<logicalKey>`. Shared machine-level keys pass through unmapped. Switching writes an active-profile pointer and reloads the window. Existing data is adopted into a first profile by a crash-safe one-time migration. Spec: `docs/superpowers/specs/2026-07-15-multi-profile-workspaces-design.md`.

**Tech Stack:** Plain JS (no TypeScript), React 19 for UI, real shadcn/ui primitives from `src/components/ui/`, vitest in `resume-designer/test/`.

## Global Constraints

- All commands run from `resume-designer/` unless noted.
- Conventional commits, subject starts lowercase (commitlint runs on every PR commit).
- **Never push or open a PR without the user asking.** Commits on the feature branch are fine.
- Plain JavaScript only — no TypeScript syntax anywhere.
- UI uses the real shadcn primitives in `src/components/ui/` (`@/components/ui/...` imports) — never hand-rolled lookalikes.
- New storage keys MUST be handled by the backup system; `test/backupKeys.test.js` guards this.
- WebKit is the shipping engine: layout/scroll-sensitive UI must be verified in `npm run tauri:dev` (Task 10).
- The physical-prefix format `resume-p:<id>:<key>` starts with `resume-` ON PURPOSE — the disk-adoption scan in `appStorage.js` (`OWNED_PREFIX = 'resume-'`) must keep matching namespaced keys.
- Profile ids must never contain `:` (the physical-key separator).

## File Structure

- Create: `src/profileKeys.js` — pure key classification: shared-key set, physical-prefix helpers, and the owned-key lists (moved here from `persistence.js` so `profiles.js` can use them without an import cycle).
- Create: `src/profiles.js` — registry CRUD, adoption migration, per-profile export/import helpers. Imports `appStorage` + `profileKeys` only.
- Modify: `src/appStorage.js` — key-mapping layer (`setProfileMapping`).
- Modify: `src/persistence.js` — settings API-key overlay, backup format 2, format-1 scoping.
- Modify: `src/main.js`, `src/printEntry.js` — boot wiring.
- Create: `src/components/profile/ProfileSwitcher.jsx`, `src/components/profile/ProfileManagerDialog.jsx`.
- Modify: `src/components/Header.jsx` — mount the switcher.
- Tests: `test/profileKeys.test.js`, `test/profiles.test.js`, `test/profileBackup.test.js`; extend `test/appStorage.test.js`, `test/backupKeys.test.js`, `test/importBackup.test.js`.

---

### Task 1: `profileKeys.js` — pure key classification

**Files:**
- Create: `src/profileKeys.js`
- Modify: `src/persistence.js` (move `BACKUP_FIXED_KEYS` / history prefix / `isOwnedKey` here; re-export `isOwnedKey` for existing importers)
- Test: `test/profileKeys.test.js`

**Interfaces:**
- Produces (used by every later task):
  - `PROFILES_KEY = 'resume-designer-profiles'`, `ACTIVE_PROFILE_KEY = 'resume-designer-active-profile'`, `OPENROUTER_KEY_KEY = 'resume-designer-openrouter-key'`
  - `PHYSICAL_PREFIX = 'resume-p:'`
  - `BACKUP_FIXED_KEYS: string[]`, `BACKUP_HISTORY_PREFIX = 'resume-designer-history-'`, `isOwnedKey(key): boolean` (same behavior as today)
  - `isSharedKey(key): boolean`
  - `physicalKey(profileId, logicalKey): string`
  - `splitPhysicalKey(key): { profileId, logicalKey } | null`
  - `mapKey(profileId | null, key): string` (identity when profileId is null, key is shared, or key is already physical)

- [ ] **Step 1: Write the failing test**

Create `test/profileKeys.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY, PHYSICAL_PREFIX,
  isSharedKey, isOwnedKey, physicalKey, splitPhysicalKey, mapKey,
} from '../src/profileKeys.js';

describe('key classification', () => {
  it('marks machine-level keys shared', () => {
    for (const k of [
      'resume-designer-theme',
      'resume-designer-update-channel',
      'resume-designer-auto-update-check',
      'resume-designer-model-catalog',
      'resume-designer-electron-migration-attempted',
      PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY,
    ]) expect(isSharedKey(k), k).toBe(true);
  });

  it('leaves per-profile keys unshared', () => {
    for (const k of [
      'resume-designer-data', 'resume-designer-job-descriptions',
      'resume-designer-applications', 'resume-designer-chat-threads',
      'resume-designer-history-abc', 'resume-zoom',
      'resume-designer-onboarding-complete',
    ]) expect(isSharedKey(k), k).toBe(false);
  });

  it('isOwnedKey keeps its historical behavior', () => {
    expect(isOwnedKey('resume-designer-data')).toBe(true);
    expect(isOwnedKey('resume-designer-history-x1')).toBe(true);
    expect(isOwnedKey('resume-designer-theme')).toBe(true);
    expect(isOwnedKey('resume-designer-model-catalog')).toBe(false);
    expect(isOwnedKey('unrelated')).toBe(false);
  });
});

describe('physical key mapping', () => {
  it('round-trips physicalKey/splitPhysicalKey', () => {
    const p = physicalKey('p1a2b3', 'resume-designer-data');
    expect(p).toBe(`${PHYSICAL_PREFIX}p1a2b3:resume-designer-data`);
    expect(splitPhysicalKey(p)).toEqual({ profileId: 'p1a2b3', logicalKey: 'resume-designer-data' });
    expect(splitPhysicalKey('resume-designer-data')).toBeNull();
    expect(splitPhysicalKey(`${PHYSICAL_PREFIX}noseparator`)).toBeNull();
  });

  it('mapKey namespaces per-profile keys and nothing else', () => {
    expect(mapKey('p1', 'resume-designer-data')).toBe(`${PHYSICAL_PREFIX}p1:resume-designer-data`);
    expect(mapKey('p1', 'resume-designer-theme')).toBe('resume-designer-theme');       // shared
    expect(mapKey('p1', `${PHYSICAL_PREFIX}p2:resume-zoom`)).toBe(`${PHYSICAL_PREFIX}p2:resume-zoom`); // already physical
    expect(mapKey(null, 'resume-designer-data')).toBe('resume-designer-data');         // mapping inactive
    // keys we don't own (e.g. __adoption_pending__) are never namespaced
    expect(mapKey('p1', '__adoption_pending__')).toBe('__adoption_pending__');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/profileKeys.test.js`
Expected: FAIL — `Cannot find module '../src/profileKeys.js'`

- [ ] **Step 3: Write the implementation**

Create `src/profileKeys.js`:

```js
/**
 * Profile key classification — pure, no imports (both appStorage.js and
 * profiles.js depend on this, so it must sit below both in the import graph).
 *
 * Physical layout: per-profile logical keys live at
 * `resume-p:<profileId>:<logicalKey>`. The prefix starts with `resume-`
 * deliberately so appStorage's one-time localStorage→disk adoption
 * (OWNED_PREFIX = 'resume-') still matches namespaced keys.
 */

export const PROFILES_KEY = 'resume-designer-profiles';
export const ACTIVE_PROFILE_KEY = 'resume-designer-active-profile';
export const OPENROUTER_KEY_KEY = 'resume-designer-openrouter-key';
export const PHYSICAL_PREFIX = 'resume-p:';

// Machine-level keys: one value per install, never namespaced by profile.
const SHARED_KEYS = new Set([
  'resume-designer-theme',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  'resume-designer-model-catalog',
  'resume-designer-electron-migration-attempted',
  PROFILES_KEY,
  ACTIVE_PROFILE_KEY,
  OPENROUTER_KEY_KEY,
]);

// The exhaustive owned-key list (moved verbatim from persistence.js; that
// module re-exports isOwnedKey so its importers keep working). Listed
// explicitly rather than via a wildcard so future contributors notice if
// they add a new key and forget to include it in the backup.
export const BACKUP_FIXED_KEYS = [
  // Core data
  'resume-designer-data',
  'resume-designer-job-descriptions',
  'resume-designer-applications',
  'resume-designer-chat-threads',
  'resume-designer-chat-history',          // legacy, harmless to round-trip
  'resume-designer-token-usage',
  // UI / personalization
  'resume-designer-theme',
  'resume-designer-onboarding-complete',
  'resume-edit-hint-dismissed',
  'resume-header-style',
  'resume-accent-settings',
  'resume-font-settings',
  'resume-spacing-settings',
  'resume-photo-settings',
  'resume-zoom',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
];
// Undo/redo history lives at this prefix, one key per variant.
export const BACKUP_HISTORY_PREFIX = 'resume-designer-history-';

export function isOwnedKey(key) {
  return BACKUP_FIXED_KEYS.includes(key) || key.startsWith(BACKUP_HISTORY_PREFIX);
}

export function isSharedKey(key) {
  return SHARED_KEYS.has(key);
}

export function isPhysicalKey(key) {
  return typeof key === 'string' && key.startsWith(PHYSICAL_PREFIX);
}

export function physicalKey(profileId, logicalKey) {
  return `${PHYSICAL_PREFIX}${profileId}:${logicalKey}`;
}

export function splitPhysicalKey(key) {
  if (!isPhysicalKey(key)) return null;
  const rest = key.slice(PHYSICAL_PREFIX.length);
  const i = rest.indexOf(':');
  if (i < 1) return null;
  return { profileId: rest.slice(0, i), logicalKey: rest.slice(i + 1) };
}

/**
 * Logical → physical for the active profile. Identity when mapping is
 * inactive (null id), for shared keys, for already-physical keys, and for
 * keys the app doesn't own (markers like __adoption_pending__).
 */
export function mapKey(profileId, key) {
  if (!profileId || isSharedKey(key) || isPhysicalKey(key) || !isOwnedKey(key)) return key;
  return physicalKey(profileId, key);
}
```

In `src/persistence.js`, delete the local `BACKUP_FIXED_KEYS`, `BACKUP_HISTORY_PREFIX`, and `isOwnedKey` definitions (lines around 323–349) and replace with:

```js
import {
  BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX, isOwnedKey,
} from './profileKeys.js';

export { isOwnedKey }; // re-export: backupKeys.test.js and others import it from here
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/profileKeys.test.js test/backupKeys.test.js test/importBackup.test.js`
Expected: PASS (the move must not change `isOwnedKey` behavior)

- [ ] **Step 5: Commit**

```bash
git add src/profileKeys.js src/persistence.js test/profileKeys.test.js
git commit -m "feat(profiles): add pure profile key classification module"
```

---

### Task 2: appStorage mapping layer

**Files:**
- Modify: `src/appStorage.js`
- Test: `test/appStorage.test.js` (extend)

**Interfaces:**
- Consumes: `mapKey` from Task 1.
- Produces: `setProfileMapping(profileId | null)` exported from `appStorage.js`. After it is called with an id, `getItem/setItem/removeItem` transparently namespace per-profile keys. `keys()` keeps returning PHYSICAL keys (callers that enumerate — backup, adoption — need the real names). `__resetAppStorageForTests()` also resets the mapping.

- [ ] **Step 1: Write the failing test**

Append to `test/appStorage.test.js`:

```js
import { setProfileMapping } from '../src/appStorage.js'; // add to existing import block

describe('profile mapping', () => {
  it('namespaces per-profile keys once a profile is active', () => {
    setProfileMapping('p1');
    appStorage.setItem('resume-designer-data', '{"a":1}');
    expect(localStorage.getItem('resume-p:p1:resume-designer-data')).toBe('{"a":1}');
    expect(localStorage.getItem('resume-designer-data')).toBeNull();
    expect(appStorage.getItem('resume-designer-data')).toBe('{"a":1}');
    appStorage.removeItem('resume-designer-data');
    expect(localStorage.getItem('resume-p:p1:resume-designer-data')).toBeNull();
  });

  it('leaves shared keys and physical keys unmapped', () => {
    setProfileMapping('p1');
    appStorage.setItem('resume-designer-theme', 'dark');
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    appStorage.setItem('resume-p:p2:resume-zoom', '1.5');
    expect(localStorage.getItem('resume-p:p2:resume-zoom')).toBe('1.5');
  });

  it('keys() returns physical names', () => {
    setProfileMapping('p1');
    appStorage.setItem('resume-designer-data', 'x');
    expect(appStorage.keys()).toContain('resume-p:p1:resume-designer-data');
  });

  it('is identity before any profile is set (boot/migration reads)', () => {
    appStorage.setItem('resume-designer-data', 'y');
    expect(localStorage.getItem('resume-designer-data')).toBe('y');
  });
});
```

Note: `__resetAppStorageForTests()` runs in the file's global `beforeEach`; add `setProfileMapping(null)` to that reset (Step 3) so these tests don't leak into others.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/appStorage.test.js`
Expected: FAIL — `setProfileMapping` is not exported

- [ ] **Step 3: Implement the mapping**

In `src/appStorage.js`:

```js
import { mapKey } from './profileKeys.js';

// Active profile for key namespacing. Null until profiles.js resolves the
// active profile at boot (ensureProfilesInitialized / the print window's
// activateProfileMappingForPrint) — identity mapping until then, which is
// exactly what the pre-profile boot steps (Electron migration, adoption)
// rely on to see unprefixed keys.
let activeProfileId = null;

export function setProfileMapping(profileId) {
  activeProfileId = profileId || null;
}
```

Then apply the mapping as the FIRST line of `getItem`, `setItem`, and `removeItem`:

```js
  getItem(key) {
    key = mapKey(activeProfileId, key);
    // ...existing body unchanged
  },
  setItem(key, value) {
    key = mapKey(activeProfileId, key);
    // ...existing body unchanged
  },
  removeItem(key) {
    key = mapKey(activeProfileId, key);
    // ...existing body unchanged
  },
```

`keys()`, `clear()`, and `flush()` are untouched. Add `activeProfileId = null;` to `__resetAppStorageForTests()`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — with mapping inactive by default, nothing else changes behavior.

- [ ] **Step 5: Commit**

```bash
git add src/appStorage.js test/appStorage.test.js
git commit -m "feat(profiles): namespace per-profile keys at the appStorage facade"
```

---

### Task 3: `profiles.js` — registry CRUD

**Files:**
- Create: `src/profiles.js`
- Test: `test/profiles.test.js`

**Interfaces:**
- Consumes: `appStorage`, `setProfileMapping`; constants/helpers from `profileKeys.js`.
- Produces (used by Tasks 4, 6–9):
  - `loadRegistry(): Array<{id, name, emoji, createdAt}> | null` (null when absent/corrupt/empty)
  - `generateProfileId(): string` (no `:`)
  - `getActiveProfileId(): string | null`
  - `setActiveProfile(id): void` (throws if id not in registry)
  - `createProfile({ name, emoji }): profile` (appends to registry; workspace starts empty)
  - `renameProfile(id, { name, emoji }): void`
  - `deleteProfile(id): void` (throws for active profile or last remaining; deletes all `resume-p:<id>:*` keys)

- [ ] **Step 1: Write the failing test**

Create `test/profiles.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { appStorage, setProfileMapping, __resetAppStorageForTests } from '../src/appStorage.js';
import {
  loadRegistry, generateProfileId, getActiveProfileId, setActiveProfile,
  createProfile, renameProfile, deleteProfile,
} from '../src/profiles.js';
import { PROFILES_KEY, ACTIVE_PROFILE_KEY } from '../src/profileKeys.js';

beforeEach(() => {
  __resetAppStorageForTests();
  localStorage.clear();
});

function seedRegistry() {
  const a = createProfile({ name: 'Ash', emoji: '🦊' });
  const b = createProfile({ name: 'Partner', emoji: '🐙' });
  appStorage.setItem(ACTIVE_PROFILE_KEY, a.id);
  return { a, b };
}

describe('registry CRUD', () => {
  it('creates profiles with unique colon-free ids', () => {
    const { a, b } = seedRegistry();
    expect(a.id).not.toContain(':');
    expect(a.id).not.toBe(b.id);
    expect(loadRegistry().map((p) => p.name)).toEqual(['Ash', 'Partner']);
  });

  it('loadRegistry returns null for absent or corrupt data', () => {
    expect(loadRegistry()).toBeNull();
    appStorage.setItem(PROFILES_KEY, 'not json');
    expect(loadRegistry()).toBeNull();
    appStorage.setItem(PROFILES_KEY, '[]');
    expect(loadRegistry()).toBeNull();
  });

  it('renames and re-emojis a profile', () => {
    const { a } = seedRegistry();
    renameProfile(a.id, { name: 'Ash S', emoji: '🦉' });
    const reg = loadRegistry();
    expect(reg.find((p) => p.id === a.id)).toMatchObject({ name: 'Ash S', emoji: '🦉' });
  });

  it('setActiveProfile validates membership', () => {
    const { b } = seedRegistry();
    setActiveProfile(b.id);
    expect(getActiveProfileId()).toBe(b.id);
    expect(() => setActiveProfile('nope')).toThrow();
  });

  it('deleteProfile removes the workspace keys and guards active/last', () => {
    const { a, b } = seedRegistry();
    appStorage.setItem(`resume-p:${b.id}:resume-designer-data`, '{}');
    appStorage.setItem(`resume-p:${b.id}:resume-designer-history-v1`, '[]');
    expect(() => deleteProfile(a.id)).toThrow(/active/i);
    deleteProfile(b.id);
    expect(appStorage.keys().some((k) => k.includes(b.id))).toBe(false);
    expect(loadRegistry()).toHaveLength(1);
    expect(() => deleteProfile(a.id)).toThrow(); // last remaining
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/profiles.test.js`
Expected: FAIL — module missing

- [ ] **Step 3: Implement `src/profiles.js` (CRUD half)**

```js
/**
 * Profile registry + lifecycle. Storage-only module: imports the appStorage
 * facade and pure key helpers, no DOM and no React, so vitest imports it
 * directly. The switch/reload orchestration lives in the UI (ProfileSwitcher).
 */
import { appStorage, setProfileMapping } from './appStorage.js';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY, PHYSICAL_PREFIX,
  isOwnedKey, isSharedKey, isPhysicalKey, physicalKey, splitPhysicalKey,
} from './profileKeys.js';

export function loadRegistry() {
  try {
    const parsed = JSON.parse(appStorage.getItem(PROFILES_KEY) || 'null');
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((p) => p && typeof p.id === 'string' && p.id && typeof p.name === 'string');
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

function saveRegistry(registry) {
  appStorage.setItem(PROFILES_KEY, JSON.stringify(registry));
}

// Colon-free (":" separates the physical-key segments), collision-checked
// against the current registry by the caller's read-modify-write.
export function generateProfileId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function getActiveProfileId() {
  return appStorage.getItem(ACTIVE_PROFILE_KEY) || null;
}

export function setActiveProfile(id) {
  const registry = loadRegistry() || [];
  if (!registry.some((p) => p.id === id)) throw new Error(`Unknown profile id: ${id}`);
  appStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function createProfile({ name, emoji = '🙂' }) {
  const registry = loadRegistry() || [];
  const profile = { id: generateProfileId(), name: name || 'New profile', emoji, createdAt: new Date().toISOString() };
  saveRegistry([...registry, profile]);
  return profile;
}

export function renameProfile(id, { name, emoji }) {
  const registry = loadRegistry() || [];
  saveRegistry(registry.map((p) => (p.id === id
    ? { ...p, ...(name !== undefined ? { name } : {}), ...(emoji !== undefined ? { emoji } : {}) }
    : p)));
}

export function deleteProfile(id) {
  const registry = loadRegistry() || [];
  if (registry.length <= 1) throw new Error('Cannot delete the last profile.');
  if (id === getActiveProfileId()) throw new Error('Cannot delete the active profile — switch away first.');
  const prefix = `${PHYSICAL_PREFIX}${id}:`;
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  saveRegistry(registry.filter((p) => p.id !== id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/profiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/profiles.js test/profiles.test.js
git commit -m "feat(profiles): registry crud with delete guards"
```

---

### Task 4: adoption migration + boot wiring

**Files:**
- Modify: `src/profiles.js` (add adoption), `src/main.js`, `src/printEntry.js`
- Test: `test/profiles.test.js` (extend)

**Interfaces:**
- Consumes: Task 3's CRUD.
- Produces:
  - `ensureProfilesInitialized(): Promise<string>` — resolves the active profile id; creates registry + migrates unprefixed keys on first run; heals dangling pointers; resumes an interrupted adoption; activates the mapping; runs `extractSharedApiKey()`.
  - `activateProfileMappingForPrint(): void` — read-only mapping activation for the print window (no writes, no adoption).
  - `extractSharedApiKey(): void` (also used by Task 6 after legacy imports; idempotent).

**Crash-safety ordering** (mirrors the disk-adoption marker pattern): marker → registry + pointer → migrate keys → delete marker. A boot that finds the marker with a registry resumes `migrateUnprefixedKeys(activeId)` under the SAME id (idempotent: copy overwrites, delete of a missing key is a no-op). A boot that finds the marker without a registry redoes the whole adoption (no keys were moved yet — the registry write precedes any key move).

- [ ] **Step 1: Write the failing tests**

Append to `test/profiles.test.js`:

```js
import { ensureProfilesInitialized, extractSharedApiKey } from '../src/profiles.js';
import { OPENROUTER_KEY_KEY } from '../src/profileKeys.js';

describe('adoption migration', () => {
  it('adopts existing unprefixed data into a first profile named from the user profile', async () => {
    localStorage.setItem('resume-designer-data', JSON.stringify({
      variants: {}, currentVariantId: null,
      settings: { openrouterKey: 'sk-or-abc' },
      userProfile: { contactInfo: { fullName: 'Ash Shah' } },
    }));
    localStorage.setItem('resume-designer-history-v1', '[]');
    localStorage.setItem('resume-designer-theme', 'dark');

    const id = await ensureProfilesInitialized();

    const reg = loadRegistry();
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ id, name: 'Ash Shah' });
    expect(getActiveProfileId()).toBe(id);
    // per-profile keys moved under the namespace…
    expect(localStorage.getItem(`resume-p:${id}:resume-designer-history-v1`)).toBe('[]');
    expect(localStorage.getItem('resume-designer-history-v1')).toBeNull();
    // …shared keys did not move…
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    // …the API key was extracted to the shared key and stripped from the blob…
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-or-abc');
    const blob = JSON.parse(localStorage.getItem(`resume-p:${id}:resume-designer-data`));
    expect(blob.settings.openrouterKey).toBeUndefined();
    // …and mapped reads now resolve through the namespace.
    expect(appStorage.getItem('resume-designer-history-v1')).toBe('[]');
  });

  it('is a fast no-op on later boots and heals a dangling active pointer', async () => {
    const first = await ensureProfilesInitialized();
    appStorage.setItem(ACTIVE_PROFILE_KEY, 'ghost');
    setProfileMapping(null); // simulate fresh boot
    const healed = await ensureProfilesInitialized();
    expect(healed).toBe(first);
    expect(getActiveProfileId()).toBe(first);
  });

  it('rebuilds a lost registry from existing namespaced data (no data loss)', async () => {
    // Corrupt/missing registry while workspaces exist on disk: recovery must
    // re-list the observed namespaces, never adopt-as-new (which would orphan
    // every namespaced key behind an empty fresh profile).
    localStorage.setItem('resume-p:pold:resume-designer-data',
      '{"variants":{},"userProfile":{"contactInfo":{"fullName":"Ash Shah"}}}');
    localStorage.setItem('resume-p:pold:resume-zoom', '1.25');
    localStorage.setItem(PROFILES_KEY, '{corrupt');

    const id = await ensureProfilesInitialized();
    expect(id).toBe('pold');
    expect(loadRegistry()).toHaveLength(1);
    expect(loadRegistry()[0]).toMatchObject({ id: 'pold', name: 'Ash Shah' });
    expect(appStorage.getItem('resume-zoom')).toBe('1.25'); // mapped read works again
  });

  it('resumes an interrupted adoption under the same profile id', async () => {
    localStorage.setItem('resume-designer-data', '{"variants":{}}');
    localStorage.setItem('__profile_adoption_pending__', '1');
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'pfixed', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pfixed');

    const id = await ensureProfilesInitialized();
    expect(id).toBe('pfixed');
    expect(localStorage.getItem('resume-p:pfixed:resume-designer-data')).toBe('{"variants":{}}');
    expect(localStorage.getItem('__profile_adoption_pending__')).toBeNull();
  });

  it('extractSharedApiKey never clobbers an existing shared key', () => {
    appStorage.setItem(OPENROUTER_KEY_KEY, 'sk-keep');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-old' } }));
    extractSharedApiKey();
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-keep');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/profiles.test.js`
Expected: FAIL — `ensureProfilesInitialized` not exported

- [ ] **Step 3: Implement adoption in `src/profiles.js`**

```js
// Deliberately OUTSIDE the `resume-` owned keyspace (like appStorage's
// __adoption_pending__) so backups never carry it.
const PROFILE_ADOPTION_MARKER = '__profile_adoption_pending__';

// Move every unprefixed per-profile owned key under the given profile's
// namespace. Idempotent: re-running overwrites the copy and skips
// already-moved (now missing) sources. Mapping must be INACTIVE here —
// physical targets pass through mapKey untouched either way.
function migrateUnprefixedKeys(profileId) {
  for (const k of appStorage.keys()) {
    if (!k || isSharedKey(k) || isPhysicalKey(k) || !isOwnedKey(k)) continue;
    const v = appStorage.getItem(k);
    if (v !== null) appStorage.setItem(physicalKey(profileId, k), v);
    appStorage.removeItem(k);
  }
}

// Best-effort profile name for adoption: the user's own name if they filled
// it in. Reads the UNPREFIXED blob (adoption runs before mapping activates).
function adoptionProfileName() {
  try {
    const data = JSON.parse(appStorage.getItem('resume-designer-data') || 'null');
    const name = data?.userProfile?.contactInfo?.fullName;
    return (typeof name === 'string' && name.trim()) ? name.trim() : 'My profile';
  } catch {
    return 'My profile';
  }
}

/**
 * One-time move of settings.openrouterKey (per-profile blob) to the shared
 * key, so one configured key serves every profile. Idempotent; an existing
 * shared key wins (never clobbered by a stale key from an imported backup).
 * Runs with mapping ACTIVE (reads the active profile's blob).
 */
export function extractSharedApiKey() {
  try {
    const raw = appStorage.getItem('resume-designer-data');
    if (!raw) return;
    const data = JSON.parse(raw);
    const inBlob = data?.settings?.openrouterKey;
    if (!inBlob) return;
    if (!appStorage.getItem(OPENROUTER_KEY_KEY)) appStorage.setItem(OPENROUTER_KEY_KEY, inBlob);
    delete data.settings.openrouterKey;
    appStorage.setItem('resume-designer-data', JSON.stringify(data));
  } catch {
    // Corrupt blob: leave it for loadFromStorage()'s own error handling.
  }
}

/**
 * Boot entry point (main.js, after initAppStorage + Electron migration,
 * before markStorageReady). Resolves the active profile, running the
 * one-time adoption when needed, then activates key mapping.
 */
// Registry lost/corrupt while namespaced workspaces exist: rebuild it from
// the profile ids observed in physical keys. Names are best-effort (each
// namespace's own userProfile fullName). NEVER adopt-as-new in this state —
// that would orphan every namespaced key behind an empty fresh profile.
function rebuildRegistryFromKeys() {
  const ids = new Set();
  for (const k of appStorage.keys()) {
    const split = splitPhysicalKey(k);
    if (split && isOwnedKey(split.logicalKey)) ids.add(split.profileId);
  }
  if (!ids.size) return null;
  const registry = [...ids].map((id) => {
    let name = 'Recovered profile';
    try {
      const data = JSON.parse(appStorage.getItem(physicalKey(id, 'resume-designer-data')) || 'null');
      const n = data?.userProfile?.contactInfo?.fullName;
      if (typeof n === 'string' && n.trim()) name = n.trim();
    } catch { /* keep the fallback name */ }
    return { id, name, emoji: '🙂', createdAt: new Date().toISOString() };
  });
  saveRegistry(registry);
  return registry;
}

export async function ensureProfilesInitialized() {
  let registry = loadRegistry() || rebuildRegistryFromKeys();

  if (!registry) {
    // True first boot with profile support (or an adoption killed before the
    // registry write — no keys moved yet in that case). Marker FIRST, then
    // registry + pointer, THEN the key moves: a crash mid-move resumes
    // under the same id via the marker branch below.
    const id = generateProfileId();
    appStorage.setItem(PROFILE_ADOPTION_MARKER, '1');
    const profile = { id, name: adoptionProfileName(), emoji: '🙂', createdAt: new Date().toISOString() };
    saveRegistry([profile]);
    appStorage.setItem(ACTIVE_PROFILE_KEY, id);
    migrateUnprefixedKeys(id);
    appStorage.removeItem(PROFILE_ADOPTION_MARKER);
    setProfileMapping(id);
    extractSharedApiKey();
    return id;
  }

  let active = getActiveProfileId();
  if (!registry.some((p) => p.id === active)) {
    active = registry[0].id;
    appStorage.setItem(ACTIVE_PROFILE_KEY, active);
  }
  if (appStorage.getItem(PROFILE_ADOPTION_MARKER)) {
    migrateUnprefixedKeys(active); // resume interrupted adoption, same id
    appStorage.removeItem(PROFILE_ADOPTION_MARKER);
  }
  setProfileMapping(active);
  extractSharedApiKey();
  return active;
}

/**
 * Print window: activate mapping WITHOUT writes or adoption (readOnly store).
 * The main window has always completed adoption before a print window can
 * exist. A missing registry/pointer leaves mapping off — identical to the
 * pre-profile behavior.
 */
export function activateProfileMappingForPrint() {
  const registry = loadRegistry();
  const active = getActiveProfileId();
  if (registry && registry.some((p) => p.id === active)) setProfileMapping(active);
}
```

- [ ] **Step 4: Wire the boot paths**

`src/main.js` — in `init()`, extend the storage bootstrap (add the import `import { ensureProfilesInitialized } from './profiles.js';`):

```js
  try {
    await initAppStorage();
    await maybeAutoMigrateLegacyData();
    await ensureProfilesInitialized();   // profiles resolve BEFORE the React gate opens
  } finally {
    markStorageReady();
  }
```

`src/printEntry.js` — right after `initAppStorage({ readOnly: true })` resolves (inside its `.then`), add:

```js
    const { activateProfileMappingForPrint } = await import('./profiles.js');
    activateProfileMappingForPrint();
```

(Match the file's existing promise style; the import is dynamic to keep the print bundle graph lean.)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/profiles.js src/main.js src/printEntry.js test/profiles.test.js
git commit -m "feat(profiles): crash-safe adoption migration and boot wiring"
```

---

### Task 5: shared API key overlay in settings

**Files:**
- Modify: `src/persistence.js` (`getSettings`, `saveSettings`)
- Test: `test/profiles.test.js` (extend; keep settings tests near the extraction tests)

**Interfaces:**
- Consumes: `OPENROUTER_KEY_KEY` from Task 1.
- Produces: `getSettings().openrouterKey` reads the shared key (blob value as fallback for pre-extraction states); `saveSettings({ openrouterKey })` writes the shared key and strips the field from the blob. All other callers (`SettingsDialog`, `aiService.getApiKey`) work unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/profiles.test.js`:

```js
import { getSettings, saveSettings } from '../src/persistence.js';

describe('shared api key overlay', () => {
  it('saveSettings routes openrouterKey to the shared key and strips it from the blob', () => {
    saveSettings({ openrouterKey: 'sk-new', defaultModel: 'm' });
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-new');
    const blob = JSON.parse(appStorage.getItem('resume-designer-data'));
    expect(blob.settings.openrouterKey).toBeUndefined();
    expect(blob.settings.defaultModel).toBe('m');
    expect(getSettings().openrouterKey).toBe('sk-new');
  });

  it('getSettings falls back to a blob-resident key before extraction ran', () => {
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-blob' } }));
    expect(getSettings().openrouterKey).toBe('sk-blob');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/profiles.test.js`
Expected: FAIL — key still written into the blob / overlay missing

- [ ] **Step 3: Implement in `src/persistence.js`**

Add `OPENROUTER_KEY_KEY` to the existing `profileKeys.js` import. Replace `getSettings` and `saveSettings`:

```js
// Save settings. openrouterKey is machine-level (shared across profiles) and
// routes to its own key; everything else merges into the per-profile blob.
export function saveSettings(settings) {
  const { openrouterKey, ...rest } = settings;
  if (openrouterKey !== undefined) {
    appStorage.setItem(OPENROUTER_KEY_KEY, openrouterKey);
  }
  const storage = loadFromStorage();
  storage.settings = { ...storage.settings, ...rest };
  delete storage.settings.openrouterKey; // never persists in the blob anymore
  saveToStorage(storage);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, {
      detail: { settings: { ...storage.settings, openrouterKey: getSettings().openrouterKey } }
    }));
  }
}

// Get settings. The shared machine-level key overlays the blob; a blob value
// still wins as fallback for pre-extraction installs (adoption strips it on
// the next boot).
export function getSettings() {
  const storage = loadFromStorage();
  const s = storage.settings || DEFAULT_STORAGE.settings;
  const shared = appStorage.getItem(OPENROUTER_KEY_KEY);
  // Legacy OpenRouter-era guarantees preserved (see original comment).
  return { autoFallback: false, customModels: [], ...s, openrouterKey: shared || s.openrouterKey || '' };
}
```

Also remove `openrouterKey: ''` from `DEFAULT_STORAGE.settings` — the overlay now guarantees the field.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS (watch `onboardingSaveQuota.test.js` / settings-adjacent suites for assumptions about the blob shape; fix fallout within this task)

- [ ] **Step 5: Commit**

```bash
git add src/persistence.js test/profiles.test.js
git commit -m "feat(profiles): share the openrouter api key across profiles"
```

---

### Task 6: backup format 2 + format-1 scoping

**Files:**
- Modify: `src/persistence.js`
- Test: `test/profileBackup.test.js` (create), `test/importBackup.test.js` (must keep passing)

**Interfaces:**
- Consumes: registry helpers from Task 3 (`loadRegistry`, `getActiveProfileId`), key helpers from Task 1.
- Produces:
  - `exportFullBackup(filename)` emits format 2: `{ backupFormat: 2, kind: 'full', createdAt, source, registry, activeProfile, shared: {key: value}, profiles: { [id]: { keys: {logicalKey: value} } } }`
  - `importFullBackupFromEnvelope(parsed)` dispatches: `backupFormat === 2 && kind === 'full'` → full multi-profile restore; `backupFormat === 1` → restore into the ACTIVE profile only (legacy semantics, now scoped so other profiles survive).
  - `BACKUP_SHARED_KEYS` (module const): `['resume-designer-theme', 'resume-designer-update-channel', 'resume-designer-auto-update-check', OPENROUTER_KEY_KEY]`.

- [ ] **Step 1: Write the failing tests**

Create `test/profileBackup.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appStorage, setProfileMapping, __resetAppStorageForTests } from '../src/appStorage.js';
import { createProfile, ensureProfilesInitialized, loadRegistry, getActiveProfileId } from '../src/profiles.js';
import { importFullBackupFromEnvelope, exportFullBackup } from '../src/persistence.js';
import { OPENROUTER_KEY_KEY, ACTIVE_PROFILE_KEY } from '../src/profileKeys.js';

beforeEach(() => {
  __resetAppStorageForTests();
  localStorage.clear();
});

// jsdom: capture the download instead of clicking a real anchor.
function captureDownload() {
  const blobs = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (b) => { blobs.push(b); return 'blob:x'; },
    revokeObjectURL: () => {},
  });
  return async () => JSON.parse(await blobs[0].text());
}

async function seedTwoProfiles() {
  localStorage.setItem('resume-designer-data', '{"variants":{"v1":{}},"settings":{},"userProfile":{"contactInfo":{"fullName":"Ash"}}}');
  const ashId = await ensureProfilesInitialized();
  const partner = createProfile({ name: 'Partner', emoji: '🐙' });
  appStorage.setItem(`resume-p:${partner.id}:resume-designer-data`, '{"variants":{"v2":{}}}');
  appStorage.setItem('resume-designer-theme', 'dark');
  appStorage.setItem(OPENROUTER_KEY_KEY, 'sk-shared');
  return { ashId, partnerId: partner.id };
}

describe('format-2 export/restore', () => {
  it('round-trips both profiles, the registry, and shared keys', async () => {
    const { ashId, partnerId } = await seedTwoProfiles();
    const readDownload = captureDownload();
    exportFullBackup();
    const envelope = await readDownload();

    expect(envelope).toMatchObject({ backupFormat: 2, kind: 'full', activeProfile: ashId });
    expect(Object.keys(envelope.profiles).sort()).toEqual([ashId, partnerId].sort());
    expect(envelope.shared['resume-designer-theme']).toBe('dark');
    expect(envelope.shared[OPENROUTER_KEY_KEY]).toBe('sk-shared');

    localStorage.clear();
    __resetAppStorageForTests();
    importFullBackupFromEnvelope(envelope);
    expect(loadRegistry()).toHaveLength(2);
    expect(localStorage.getItem(`resume-p:${partnerId}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    expect(localStorage.getItem(ACTIVE_PROFILE_KEY)).toBe(ashId);
  });
});

describe('format-1 import scoping', () => {
  it('restores a legacy envelope into the active profile without touching others', async () => {
    const { ashId, partnerId } = await seedTwoProfiles();
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: {
        'resume-designer-data': '{"variants":{"legacy":{}}}',
        'resume-designer-theme': 'light',
      },
    });
    // active profile replaced…
    expect(localStorage.getItem(`resume-p:${ashId}:resume-designer-data`)).toBe('{"variants":{"legacy":{}}}');
    // …partner untouched, registry intact…
    expect(localStorage.getItem(`resume-p:${partnerId}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
    expect(loadRegistry()).toHaveLength(2);
    // …shared owned keys in the envelope still land (theme is shared)…
    expect(localStorage.getItem('resume-designer-theme')).toBe('light');
    // …and the shared api key survives (not part of format-1 envelopes).
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-shared');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/profileBackup.test.js`
Expected: FAIL — export still emits `backupFormat: 1`; format-1 import wipes the partner's keys

- [ ] **Step 3: Implement in `src/persistence.js`**

Add imports: `loadRegistry`, `getActiveProfileId` from `./profiles.js`; `OPENROUTER_KEY_KEY`, `PROFILES_KEY`, `ACTIVE_PROFILE_KEY`, `splitPhysicalKey`, `physicalKey` from `./profileKeys.js`.

```js
// Shared machine-level keys that belong in a backup (parity with the old
// BACKUP_FIXED_KEYS entries for theme/updates, plus the shared api key —
// model-catalog and migration flags stay cache/flag-only, never backed up).
const BACKUP_SHARED_KEYS = [
  'resume-designer-theme',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  OPENROUTER_KEY_KEY,
];
```

Replace `collectOwnedKeys()` with an active-profile-scoped version (format-1 paths only touch the active workspace now):

```js
// Physical keys belonging to the ACTIVE profile, plus any unprefixed owned
// keys (pre-adoption states), plus shared owned keys. This is the "what a
// format-1 restore may remove/replace" set — other profiles are untouchable.
function collectActiveOwnedKeys() {
  const active = getActiveProfileId();
  return appStorage.keys().filter((k) => {
    if (!k) return false;
    const split = splitPhysicalKey(k);
    if (split) return split.profileId === active && isOwnedKey(split.logicalKey);
    return isOwnedKey(k); // unprefixed per-profile keys AND shared owned keys (theme etc.)
  });
}
```

In `importFullBackupFromEnvelope`, change the header validation to dispatch on format, and use the scoped collector:

```js
export function importFullBackupFromEnvelope(parsed) {
  if (parsed && parsed.backupFormat === 2 && parsed.kind === 'full') {
    return importFullBackupV2(parsed);
  }
  if (!parsed || parsed.backupFormat !== 1 ||
      !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(
      'Not a Resume Designer backup envelope (missing "backupFormat: 1" or a format-2 "kind: full").'
    );
  }
  // …existing string validation unchanged…
  const removed = collectActiveOwnedKeys();          // was collectOwnedKeys()
  for (const k of removed) appStorage.removeItem(k); // removeItem passes physical keys through unmapped
  // …the remaining two-pass mapped-setItem write logic is UNCHANGED: setItem
  // maps logical keys into the active profile, shared keys pass through.
```

Add the format-2 restore and rewrite `exportFullBackup`:

```js
function importFullBackupV2(parsed) {
  const registry = Array.isArray(parsed.registry)
    ? parsed.registry.filter((p) => p && typeof p.id === 'string' && p.id && !p.id.includes(':'))
    : [];
  if (!registry.length || !parsed.profiles || typeof parsed.profiles !== 'object') {
    throw new Error('Invalid format-2 backup: missing registry or profiles.');
  }
  for (const [pid, entry] of Object.entries(parsed.profiles)) {
    for (const [k, v] of Object.entries(entry?.keys || {})) {
      if (typeof v !== 'string') throw new Error(`Invalid backup: ${pid}/"${k}" must be a string value.`);
      if (!isOwnedKey(k)) throw new Error(`Invalid backup: unrecognized key "${k}".`);
    }
  }

  // Clean slate across ALL namespaces (full restore replaces everything).
  for (const k of appStorage.keys()) {
    const split = splitPhysicalKey(k);
    const owned = split ? isOwnedKey(split.logicalKey) : isOwnedKey(k);
    if (owned || k === PROFILES_KEY || k === ACTIVE_PROFILE_KEY || k === OPENROUTER_KEY_KEY) {
      appStorage.removeItem(k);
    }
  }

  appStorage.setItem(PROFILES_KEY, JSON.stringify(registry));
  const active = registry.some((p) => p.id === parsed.activeProfile)
    ? parsed.activeProfile : registry[0].id;
  appStorage.setItem(ACTIVE_PROFILE_KEY, active);

  for (const [k, v] of Object.entries(parsed.shared || {})) {
    if (BACKUP_SHARED_KEYS.includes(k) && typeof v === 'string') appStorage.setItem(k, v);
  }

  // Same quota strategy as format 1, per profile: critical keys first,
  // bulky history best-effort.
  let keysImported = 0;
  let historySkipped = 0;
  for (const [pid, entry] of Object.entries(parsed.profiles)) {
    if (!registry.some((p) => p.id === pid)) continue;
    const entries = Object.entries(entry.keys || {});
    const nonHistory = entries.filter(([k]) => !k.startsWith(BACKUP_HISTORY_PREFIX));
    const history = entries.filter(([k]) => k.startsWith(BACKUP_HISTORY_PREFIX));
    for (const [k, v] of nonHistory) {
      appStorage.setItem(physicalKey(pid, k), normalizeImportedValue(k, v));
      keysImported++;
    }
    for (const [k, v] of history) {
      if (writeOwnedKeyOrSkip(physicalKey(pid, k), v)) keysImported++;
      else historySkipped++;
    }
  }
  return { keysImported, removedExistingKeys: 0, historySkipped };
}

/**
 * Write a JSON file containing the registry, shared keys, and every
 * profile's owned keys (format 2). Pre-adoption unprefixed keys are
 * impossible here (adoption runs before any UI), but shared owned keys
 * (theme, update settings) route to the shared section.
 */
export function exportFullBackup(filename) {
  const profiles = {};
  const shared = {};
  for (const k of appStorage.keys()) {
    if (!k) continue;
    const split = splitPhysicalKey(k);
    if (split && isOwnedKey(split.logicalKey)) {
      const v = appStorage.getItem(k);
      if (v !== null) ((profiles[split.profileId] ||= { keys: {} }).keys)[split.logicalKey] = v;
    } else if (BACKUP_SHARED_KEYS.includes(k)) {
      const v = appStorage.getItem(k);
      if (v !== null) shared[k] = v;
    }
  }
  const backup = {
    backupFormat: 2,
    kind: 'full',
    createdAt: new Date().toISOString(),
    source: 'in-app',
    registry: loadRegistry() || [],
    activeProfile: getActiveProfileId(),
    shared,
    profiles,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const name = filename || `resume-designer-backup-${stamp}.json`;
  downloadFile(JSON.stringify(backup, null, 2), name, 'application/json');
  const keysExported = Object.values(profiles)
    .reduce((n, p) => n + Object.keys(p.keys).length, Object.keys(shared).length);
  return { keysExported, filename: name };
}
```

Note: `writeOwnedKeyOrSkip` receives a PHYSICAL key now — update its history check to `key.includes(BACKUP_HISTORY_PREFIX)` (prefix may be preceded by the namespace) and keep everything else identical.

`importFullBackupMerge` (Electron merge flow) needs NO changes — its mapped `getItem`/`setItem` calls now operate on the active profile, which is the intended semantics.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: PASS, including untouched `test/importBackup.test.js` (its format-1 envelopes now restore into whatever profile is active — with no registry in those tests, mapping is inactive and behavior is byte-identical to today).

- [ ] **Step 5: Commit**

```bash
git add src/persistence.js test/profileBackup.test.js
git commit -m "feat(profiles): multi-profile backup format 2 and scoped legacy restore"
```

---

### Task 7: per-profile export/import

**Files:**
- Modify: `src/profiles.js`, `src/persistence.js` (export `downloadFile`)
- Test: `test/profileBackup.test.js` (extend)

**Interfaces:**
- Consumes: Task 3 CRUD, Task 1 helpers, `downloadFile` from persistence.
- Produces:
  - `exportProfileBackup(profileId): { keysExported, filename }` — file envelope `{ backupFormat: 2, kind: 'profile', createdAt, name, emoji, keys: {logicalKey: value} }`
  - `importProfileBackup(parsed): profile` — validates, creates a NEW profile (never overwrites), writes its keys, returns the registry entry.

- [ ] **Step 1: Write the failing test**

Append to `test/profileBackup.test.js`:

```js
import { exportProfileBackup, importProfileBackup } from '../src/profiles.js';

describe('per-profile export/import', () => {
  it('exports one profile and imports it as a NEW profile', async () => {
    const { partnerId } = await seedTwoProfiles();
    const readDownload = captureDownload();
    await exportProfileBackup(partnerId); // async: lazy-imports downloadFile
    const envelope = await readDownload();
    expect(envelope).toMatchObject({ backupFormat: 2, kind: 'profile', name: 'Partner' });
    expect(envelope.keys['resume-designer-data']).toBe('{"variants":{"v2":{}}}');

    const imported = importProfileBackup(envelope);
    expect(imported.id).not.toBe(partnerId); // always a fresh identity
    expect(loadRegistry()).toHaveLength(3);
    expect(localStorage.getItem(`resume-p:${imported.id}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
  });

  it('rejects non-profile envelopes and unowned keys', async () => {
    await seedTwoProfiles();
    expect(() => importProfileBackup({ backupFormat: 1, keys: {} })).toThrow();
    expect(() => importProfileBackup({
      backupFormat: 2, kind: 'profile', name: 'X', keys: { evil: 'x' },
    })).toThrow(/unrecognized/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/profileBackup.test.js`
Expected: FAIL — functions missing

- [ ] **Step 3: Implement in `src/profiles.js`**

Export `downloadFile` from `persistence.js` (`export function downloadFile(...)` — it's currently private) and import it in `profiles.js` — no cycle: persistence already imports profiles, so import LAZILY inside the function to keep the graph acyclic:

```js
export function exportProfileBackup(profileId, filename) {
  const registry = loadRegistry() || [];
  const profile = registry.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Unknown profile id: ${profileId}`);
  const prefix = `${PHYSICAL_PREFIX}${profileId}:`;
  const keys = {};
  for (const k of appStorage.keys()) {
    if (!k || !k.startsWith(prefix)) continue;
    const logical = k.slice(prefix.length);
    if (!isOwnedKey(logical)) continue;
    const v = appStorage.getItem(k);
    if (v !== null) keys[logical] = v;
  }
  const envelope = {
    backupFormat: 2,
    kind: 'profile',
    createdAt: new Date().toISOString(),
    name: profile.name,
    emoji: profile.emoji,
    keys,
  };
  const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  const name = filename || `resume-designer-profile-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  // Lazy import: persistence.js imports this module, so a static import here
  // would create a cycle. downloadFile has no module state — safe to pull late.
  return import('./persistence.js').then(({ downloadFile }) => {
    downloadFile(JSON.stringify(envelope, null, 2), name, 'application/json');
    return { keysExported: Object.keys(keys).length, filename: name };
  });
}

export function importProfileBackup(parsed) {
  if (!parsed || parsed.backupFormat !== 2 || parsed.kind !== 'profile'
      || !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error('Not a Resume Designer profile export (expected backupFormat 2, kind "profile").');
  }
  for (const [k, v] of Object.entries(parsed.keys)) {
    if (typeof v !== 'string') throw new Error(`Invalid profile export: key "${k}" must be a string value.`);
    if (!isOwnedKey(k)) throw new Error(`Invalid profile export: unrecognized key "${k}".`);
  }
  const profile = createProfile({
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported profile',
    emoji: typeof parsed.emoji === 'string' ? parsed.emoji : '🙂',
  });
  for (const [k, v] of Object.entries(parsed.keys)) {
    appStorage.setItem(physicalKey(profile.id, k), v);
  }
  return profile;
}
```

(Adjust the test: `exportProfileBackup` returns a promise — `await exportProfileBackup(partnerId)`.)

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/profiles.js src/persistence.js test/profileBackup.test.js
git commit -m "feat(profiles): per-profile export and import-as-new-profile"
```

---

### Task 8: ProfileSwitcher in the header

**Files:**
- Create: `src/components/profile/ProfileSwitcher.jsx`
- Modify: `src/components/Header.jsx`

**Interfaces:**
- Consumes: `loadRegistry`, `getActiveProfileId`, `setActiveProfile`, `createProfile` from `profiles.js`; `appStorage.flush`; `flushPendingProfileSave` from `userProfilePanel.js`; shadcn `DropdownMenu` + `Button` primitives.
- Produces: `<ProfileSwitcher />` rendered in the Header's right-hand cluster; dispatches `rd:open-profile-manager` for Task 9's dialog.

- [ ] **Step 1: Implement the component**

Create `src/components/profile/ProfileSwitcher.jsx`:

```jsx
import { useState } from 'react';
import { Check, Plus, Users } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { appStorage } from '../../appStorage.js';
import { loadRegistry, getActiveProfileId, setActiveProfile, createProfile } from '../../profiles.js';
import { flushPendingProfileSave } from '../../userProfilePanel.js';

// Flush pending saves, repoint the active profile, reload. The reload is the
// whole switching mechanism — every module re-boots from the new namespace
// (same pattern as the backup-restore reload in backupFlow.js).
async function switchTo(id) {
  flushPendingProfileSave();
  const durable = await appStorage.flush();
  if (!durable) {
    toast.error('Could not save your latest changes to disk — profile switch cancelled.');
    return;
  }
  setActiveProfile(id);
  await appStorage.flush();
  window.location.reload();
}

export function ProfileSwitcher() {
  const [registry, setRegistry] = useState(() => loadRegistry() || []);
  const activeId = getActiveProfileId();
  const active = registry.find((p) => p.id === activeId);
  if (!active || registry.length === 0) return null; // pre-adoption boot: hide

  const refresh = () => setRegistry(loadRegistry() || []);

  const onNewProfile = async () => {
    const name = window.prompt('Name for the new profile:');
    if (!name || !name.trim()) return;
    const profile = createProfile({ name: name.trim() });
    await switchTo(profile.id);
  };

  return (
    <DropdownMenu onOpenChange={(open) => open && refresh()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" title="Switch profile">
          <span aria-hidden>{active.emoji}</span>
          <span className="max-w-28 truncate text-sm">{active.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Profiles</DropdownMenuLabel>
        {registry.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => p.id !== activeId && switchTo(p.id)}>
            <span aria-hidden>{p.emoji}</span>
            <span className="flex-1 truncate">{p.name}</span>
            {p.id === activeId && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNewProfile}>
          <Plus className="size-4" /> New profile…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent('rd:open-profile-manager'))}>
          <Users className="size-4" /> Manage profiles…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Before finalizing, READ `src/components/ui/dropdown-menu.jsx` and `Header.jsx`'s existing menus and match their exact item idioms (icon sizing classes, `onSelect` vs `onClick`); replace `window.prompt` with the same inline-input pattern Header uses for variant rename if one exists — `window.prompt` is a fallback only if no in-house pattern exists.

- [ ] **Step 2: Mount in `Header.jsx`**

Import `{ ProfileSwitcher } from './profile/ProfileSwitcher.jsx'` and render it in the right-hand control cluster (next to the settings/profile buttons — read the JSX around the `headerActions` / right-side `div` and slot it first in that group).

- [ ] **Step 3: Verify in the browser preview**

Run: `npm run dev`, open the preview.
Expected: switcher shows the adopted profile's emoji + name; "New profile…" creates and reloads into an empty workspace with onboarding; switching back restores the original data.

- [ ] **Step 4: Lint and test**

Run: `npm run lint && npx vitest run`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/components/profile/ProfileSwitcher.jsx src/components/Header.jsx
git commit -m "feat(profiles): header profile switcher with reload-based switching"
```

---

### Task 9: Manage Profiles dialog

**Files:**
- Create: `src/components/profile/ProfileManagerDialog.jsx`
- Modify: `src/App.jsx` (mount the always-rendered dialog, same pattern as ProfileDialog)

**Interfaces:**
- Consumes: full `profiles.js` API (rename/delete/export/import), `confirmDestructive` from `@/components/ui/confirm`, shadcn `Dialog`/`Button`/`Input`.
- Produces: dialog opened by the `rd:open-profile-manager` event.

- [ ] **Step 1: Implement the dialog**

Create `src/components/profile/ProfileManagerDialog.jsx`. Follow `ProfileDialog.jsx`'s always-mounted + window-event pattern. Full requirements (implement each; consult existing dialogs for idioms):

```jsx
import { useEffect, useRef, useState } from 'react';
import { Download, Pencil, Trash2, Upload } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDestructive } from '@/components/ui/confirm';
import { toast } from 'sonner';
import {
  loadRegistry, getActiveProfileId, renameProfile, deleteProfile,
  exportProfileBackup, importProfileBackup,
} from '../../profiles.js';

export function ProfileManagerDialog() {
  const [open, setOpen] = useState(false);
  const [registry, setRegistry] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: '', emoji: '' });
  const fileRef = useRef(null);
  const activeId = getActiveProfileId();

  useEffect(() => {
    const onOpen = () => { setRegistry(loadRegistry() || []); setOpen(true); };
    window.addEventListener('rd:open-profile-manager', onOpen);
    return () => window.removeEventListener('rd:open-profile-manager', onOpen);
  }, []);

  const refresh = () => setRegistry(loadRegistry() || []);

  const onDelete = async (p) => {
    const ok = await confirmDestructive({
      title: `Delete profile "${p.name}"?`,
      description: 'Their résumés, job descriptions, applications, and chats are permanently removed. Export the profile first if you might need it again.',
      confirmLabel: 'Delete profile',
    });
    if (!ok) return;
    try { deleteProfile(p.id); refresh(); toast.success(`Deleted "${p.name}".`); }
    catch (e) { toast.error(String(e.message || e)); }
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const profile = importProfileBackup(parsed);
      refresh();
      toast.success(`Imported "${profile.name}" as a new profile.`);
    } catch (err) {
      toast.error(String(err.message || err));
    }
  };

  const saveEdit = (id) => {
    renameProfile(id, { name: draft.name.trim() || undefined, emoji: draft.emoji.trim() || undefined });
    setEditingId(null);
    refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage profiles</DialogTitle>
          <DialogDescription>
            Each profile is a separate workspace — résumés, job descriptions, applications, and chats.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {registry.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              {editingId === p.id ? (
                <>
                  <Input className="w-12 text-center" value={draft.emoji} maxLength={4}
                    onChange={(e) => setDraft((d) => ({ ...d, emoji: e.target.value }))} />
                  <Input className="flex-1" value={draft.name} autoFocus
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(p.id); }} />
                  <Button size="sm" onClick={() => saveEdit(p.id)}>Save</Button>
                </>
              ) : (
                <>
                  <span aria-hidden>{p.emoji}</span>
                  <span className="flex-1 truncate text-sm">
                    {p.name}
                    {p.id === activeId && <span className="ml-2 text-xs text-muted-foreground">(current)</span>}
                  </span>
                  <Button variant="ghost" size="icon" title="Rename"
                    onClick={() => { setEditingId(p.id); setDraft({ name: p.name, emoji: p.emoji }); }}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Export this profile"
                    onClick={() => exportProfileBackup(p.id).catch((e) => toast.error(String(e.message || e)))}>
                    <Download className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Delete" disabled={p.id === activeId || registry.length <= 1}
                    onClick={() => onDelete(p)}>
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div>
          <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={onImport} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> Import profile…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

Check `@/components/ui/confirm`'s actual export signature before using (`confirmDestructive` exists — Header imports it; match its argument shape).

- [ ] **Step 2: Mount in `App.jsx`**

Render `<ProfileManagerDialog />` alongside the other always-mounted dialogs (find where `ProfileDialog` is mounted and add it there).

- [ ] **Step 3: Verify in the browser preview**

Run: `npm run dev`. Exercise rename, emoji change, export (file downloads), import (new profile appears), delete guards (active + last disabled/blocked).

- [ ] **Step 4: Lint and test**

Run: `npm run lint && npx vitest run`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/components/profile/ProfileManagerDialog.jsx src/App.jsx
git commit -m "feat(profiles): manage-profiles dialog with export, import, and guards"
```

---

### Task 10: verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npx vitest run`
Expected: clean, all suites green.

- [ ] **Step 2: WKWebView manual pass**

Run: `npm run tauri:dev` and walk this checklist against REAL existing data (the dev app shares the production storage dir — export a whole-app backup FIRST from the running app, before the adoption-migration boot):

1. First boot: data intact, profile switcher shows your name, console logs adoption.
2. Relaunch: no re-migration (fast boot, no marker).
3. New profile → onboarding runs → build a small résumé → switch back and forth: both workspaces intact, AI works in both (shared key).
4. Settings → Data → Export Backup, then Import: both profiles round-trip.
5. Per-profile export → import: appears as a third profile.
6. PDF export in each profile (print window must read the right namespace).
7. Update channel + theme persist across profiles.

- [ ] **Step 3: Report**

Report results to the user, including the pre-migration backup location. Do NOT push or open a PR unless asked.
