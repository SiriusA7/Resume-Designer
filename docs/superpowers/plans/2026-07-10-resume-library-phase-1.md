# Resume Library Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the applications data layer (resume↔job links with outcome tracking), capture-on-tailor, and a Library dialog with tiered search, detail view, and live preview — Phase 1 of `docs/superpowers/specs/2026-07-10-resume-library-design.md`.

**Architecture:** A new framework-free store module `applications.js` (peer of `jobDescriptions.js`, own appStorage key) holds application records with timestamped `statusHistory`. JobsDialog's tailor flow auto-drafts `prepared` applications. A new `LibraryDialog` (real shadcn primitives) provides search (via a pure `librarySearch.js` module), a two-pane browse/detail UI, and a scaled live DOM preview using a new `renderResumeForLayout` helper extracted from main.js's layout switch.

**Tech Stack:** React 19 + Vite, plain JavaScript (`.jsx`/`.js`, NO TypeScript), shadcn/ui (Radix + Tailwind 3), vitest + jsdom, appStorage persistence facade.

## Global Constraints

- Work on a feature branch off `origin/next`: `git checkout -b feat/resume-library origin/next` (run from `resume-designer/`'s repo root `/Users/ashshah/Projects/Resume-Designer`). The `next` **tag** is a release anchor — never touch it; always say `origin/next` (branch).
- **Never push or open a PR without the user explicitly asking.** Local commits are part of executing this approved plan.
- Conventional commits, subject **must start lowercase** (commitlint runs on every PR commit): e.g. `feat(library): add applications store`.
- All `npm` commands run from `/Users/ashshah/Projects/Resume-Designer/resume-designer/`.
- Plain JavaScript only — no TypeScript syntax anywhere.
- shadcn/ui components must be the real primitives from `src/components/ui/` — never hand-rolled lookalikes.
- No React component test infra exists (no @testing-library). Service modules get vitest tests; UI components are verified in `npm run tauri:dev` (shipped engine is WKWebView — ClaudePreview Chromium is NOT sufficient for layout verification).
- Match existing style: JSDoc comment headers on service modules, single quotes, semicolons.

---

### Task 1: Applications store module

**Files:**
- Create: `resume-designer/src/applications.js`
- Create: `resume-designer/test/applications.test.js`
- Modify: `resume-designer/src/main.js:52` (import) and `resume-designer/src/main.js:302` (init call)

**Interfaces:**
- Consumes: `generateId` from `./store.js`, `appStorage` from `./appStorage.js`, `storageErrorToast` from `./storageToast.js`.
- Produces (later tasks rely on these exact names):
  - `initApplications()` → array
  - `getAllApplications()` → array (copy)
  - `getApplicationsForVariant(variantId)` → array
  - `getApplication(id)` → object|null
  - `addApplication({ variantId, variantName, jobId, jobSnapshot, status, notes })` → record
  - `setApplicationStatus(id, status)` → record|null
  - `updateApplication(id, patch)` → record|null (managed fields protected)
  - `deleteApplication(id)` → boolean
  - `recordTailorDrafts(variantId, variantName, jds)` → array of records
  - `subscribeApplications(cb)` / `getApplicationsSnapshot()` — useSyncExternalStore bridge
  - Constants: `PIPELINE_STATUSES`, `TERMINAL_STATUSES`, `APPLICATION_STATUSES`, `STATUS_LABELS`
- Record shape: `{ id, variantId, variantName, jobId, jobSnapshot: { title, company }, status, statusHistory: [{ status, at }], createdAt, updatedAt, appliedAt, notes }`

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/ashshah/Projects/Resume-Designer
git fetch origin && git checkout -b feat/resume-library origin/next
```

- [ ] **Step 2: Write the failing tests**

Create `resume-designer/test/applications.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import {
  initApplications, getAllApplications, getApplicationsForVariant,
  addApplication, setApplicationStatus, updateApplication, deleteApplication,
  recordTailorDrafts,
} from '../src/applications.js';

const KEY = 'resume-designer-applications';

function reload() {
  // Re-read what save() wrote, as a fresh boot would.
  return initApplications();
}

beforeEach(() => {
  localStorage.clear();
  initApplications();
});

describe('initApplications — stored shapes', () => {
  it('loads a normal array store', () => {
    localStorage.setItem(KEY, '[{"id":"app-1","variantId":"v1","status":"applied"}]');
    initApplications();
    expect(getAllApplications().map((a) => a.id)).toEqual(['app-1']);
  });

  it('self-heals an id-keyed object map into an array', () => {
    localStorage.setItem(KEY, '{"app-1":{"id":"app-1","variantId":"v1"}}');
    initApplications();
    expect(getAllApplications().map((a) => a.id)).toEqual(['app-1']);
  });

  it('degrades non-object JSON to an empty list', () => {
    localStorage.setItem(KEY, '"oops"');
    initApplications();
    expect(getAllApplications()).toEqual([]);
  });
});

describe('addApplication', () => {
  it('creates a prepared draft by default with a seeded history', () => {
    const app = addApplication({ variantId: 'v1', variantName: 'PM Resume' });
    expect(app.status).toBe('prepared');
    expect(app.statusHistory).toEqual([{ status: 'prepared', at: app.createdAt }]);
    expect(app.appliedAt).toBeNull();
    expect(app.jobSnapshot).toEqual({ title: '', company: '' });
    expect(reload().map((a) => a.id)).toEqual([app.id]);
  });

  it('sets appliedAt immediately when created past prepared', () => {
    const app = addApplication({ variantId: 'v1', status: 'applied' });
    expect(app.appliedAt).toBe(app.createdAt);
  });

  it('rejects unknown statuses back to prepared', () => {
    const app = addApplication({ variantId: 'v1', status: 'ghosted-lol' });
    expect(app.status).toBe('prepared');
  });
});

describe('setApplicationStatus', () => {
  it('appends to statusHistory and stamps appliedAt on first non-prepared status', () => {
    const app = addApplication({ variantId: 'v1' });
    const updated = setApplicationStatus(app.id, 'interview'); // skip straight past applied
    expect(updated.status).toBe('interview');
    expect(updated.statusHistory.map((h) => h.status)).toEqual(['prepared', 'interview']);
    expect(updated.appliedAt).not.toBeNull();
  });

  it('stamps appliedAt even for terminal statuses (rejected implies it was sent)', () => {
    const app = addApplication({ variantId: 'v1' });
    expect(setApplicationStatus(app.id, 'rejected').appliedAt).not.toBeNull();
  });

  it('does not re-stamp appliedAt on later transitions', () => {
    const app = addApplication({ variantId: 'v1' });
    const first = setApplicationStatus(app.id, 'applied').appliedAt;
    expect(setApplicationStatus(app.id, 'offer').appliedAt).toBe(first);
  });

  it('ignores unknown statuses and no-op repeats', () => {
    const app = addApplication({ variantId: 'v1' });
    setApplicationStatus(app.id, 'bogus');
    setApplicationStatus(app.id, 'prepared');
    expect(getAllApplications()[0].statusHistory).toHaveLength(1);
  });
});

describe('updateApplication', () => {
  it('patches notes and bumps updatedAt, protecting managed fields', () => {
    const app = addApplication({ variantId: 'v1' });
    const updated = updateApplication(app.id, {
      notes: 'recruiter said reapply in 6mo',
      status: 'offer', statusHistory: [], id: 'app-hax', createdAt: 'nope',
    });
    expect(updated.notes).toBe('recruiter said reapply in 6mo');
    expect(updated.status).toBe('prepared');
    expect(updated.statusHistory).toHaveLength(1);
    expect(updated.id).toBe(app.id);
    expect(updated.createdAt).toBe(app.createdAt);
  });
});

describe('deleteApplication', () => {
  it('removes the record and persists', () => {
    const app = addApplication({ variantId: 'v1' });
    expect(deleteApplication(app.id)).toBe(true);
    expect(deleteApplication(app.id)).toBe(false);
    expect(reload()).toEqual([]);
  });
});

describe('recordTailorDrafts — the dedupe-on-retailor rule', () => {
  const jds = [
    { id: 'jd-1', title: 'PM', company: 'Stripe' },
    { id: 'jd-2', title: 'EM', company: 'Linear' },
  ];

  it('creates one prepared draft per job description with snapshots', () => {
    const drafts = recordTailorDrafts('v1', 'PM Resume', jds);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].jobSnapshot).toEqual({ title: 'PM', company: 'Stripe' });
    expect(drafts.every((d) => d.status === 'prepared' && d.variantName === 'PM Resume')).toBe(true);
  });

  it('re-tailoring while still prepared updates the existing draft (no duplicate)', () => {
    recordTailorDrafts('v1', 'PM Resume', jds);
    recordTailorDrafts('v1', 'PM Resume v2', [jds[0]]);
    const all = getApplicationsForVariant('v1');
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.jobId === 'jd-1').variantName).toBe('PM Resume v2');
  });

  it('re-tailoring after the application advanced creates a new record', () => {
    const [draft] = recordTailorDrafts('v1', 'PM Resume', [jds[0]]);
    setApplicationStatus(draft.id, 'applied');
    recordTailorDrafts('v1', 'PM Resume', [jds[0]]);
    expect(getApplicationsForVariant('v1')).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/ashshah/Projects/Resume-Designer/resume-designer && npx vitest run test/applications.test.js`
Expected: FAIL — cannot resolve `../src/applications.js`.

- [ ] **Step 4: Write the implementation**

Create `resume-designer/src/applications.js`:

```js
/**
 * Applications Module
 *
 * A first-class "application" links a resume variant to a job it was tailored
 * for / sent to, and tracks the outcome through a timestamped status pipeline.
 * Records survive deletion of the variant or job description via the
 * variantName / jobSnapshot copies taken at creation (no foreign keys here).
 *
 * Storage: own appStorage key (array), same pattern as jobDescriptions.js.
 * React reads through subscribeApplications/getApplicationsSnapshot (the same
 * stable-snapshot bridge variantManager uses for useSyncExternalStore).
 */

import { generateId } from './store.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';

const STORAGE_KEY = 'resume-designer-applications';

export const PIPELINE_STATUSES = ['prepared', 'applied', 'heard_back', 'interview', 'offer'];
export const TERMINAL_STATUSES = ['rejected', 'no_response'];
export const APPLICATION_STATUSES = [...PIPELINE_STATUSES, ...TERMINAL_STATUSES];

export const STATUS_LABELS = {
  prepared: 'Prepared',
  applied: 'Applied',
  heard_back: 'Heard back',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  no_response: 'No response',
};

// In-memory cache of applications
let applications = [];

// --- React external-store bridge (see variantManager.js for the rationale) ---
const subscribers = new Set();
let snapshot = null;

function notify() {
  snapshot = [...applications];
  subscribers.forEach((cb) => cb());
}

export function subscribeApplications(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function getApplicationsSnapshot() {
  if (!snapshot) snapshot = [...applications];
  return snapshot;
}

/**
 * Initialize applications from storage. Self-heals an id-keyed object map to
 * the array shape this module requires (same legacy hazard jobDescriptions
 * hit) and degrades garbage to an empty list.
 */
export function initApplications() {
  try {
    const stored = appStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      applications = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? Object.values(parsed) : []);
    } else {
      applications = [];
    }
  } catch (e) {
    console.error('Failed to load applications:', e);
    applications = [];
  }
  notify();
  return applications;
}

function save() {
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
  } catch (e) {
    console.error('Failed to save applications:', e);
    storageErrorToast(
      'Could not save your application history — storage is full. Free up '
      + 'space (delete resumes you no longer need) and try again.',
      { once: true },
    );
  }
}

export function getAllApplications() {
  return [...applications];
}

export function getApplicationsForVariant(variantId) {
  return applications.filter((a) => a.variantId === variantId);
}

export function getApplication(id) {
  return applications.find((a) => a.id === id) || null;
}

/**
 * Add an application. Defaults to a 'prepared' draft; creating directly at a
 * later status (the manual "Add application" flow) stamps appliedAt too.
 */
export function addApplication({
  variantId,
  variantName = '',
  jobId = null,
  jobSnapshot = {},
  status = 'prepared',
  notes = '',
} = {}) {
  const now = new Date().toISOString();
  const safeStatus = APPLICATION_STATUSES.includes(status) ? status : 'prepared';
  const app = {
    id: generateId('app'),
    variantId,
    variantName,
    jobId,
    jobSnapshot: { title: jobSnapshot.title || '', company: jobSnapshot.company || '' },
    status: safeStatus,
    statusHistory: [{ status: safeStatus, at: now }],
    createdAt: now,
    updatedAt: now,
    appliedAt: safeStatus === 'prepared' ? null : now,
    notes,
  };
  applications.unshift(app);
  save();
  notify();
  return app;
}

/**
 * Transition an application's status. Appends to statusHistory; any move past
 * 'prepared' stamps appliedAt once (terminal states imply it was sent too).
 */
export function setApplicationStatus(id, status) {
  const app = applications.find((a) => a.id === id);
  if (!app) return null;
  if (!APPLICATION_STATUSES.includes(status) || app.status === status) return app;

  const now = new Date().toISOString();
  app.status = status;
  app.statusHistory = [...(app.statusHistory || []), { status, at: now }];
  app.updatedAt = now;
  if (!app.appliedAt && status !== 'prepared') app.appliedAt = now;

  save();
  notify();
  return app;
}

/**
 * Patch freeform fields (notes, jobSnapshot, appliedAt…). Managed fields —
 * id, status, statusHistory, createdAt — only change through their own APIs.
 */
export function updateApplication(id, patch = {}) {
  const app = applications.find((a) => a.id === id);
  if (!app) return null;

  const { id: _id, status: _s, statusHistory: _h, createdAt: _c, ...rest } = patch;
  Object.assign(app, rest, { updatedAt: new Date().toISOString() });

  save();
  notify();
  return app;
}

export function deleteApplication(id) {
  const index = applications.findIndex((a) => a.id === id);
  if (index === -1) return false;
  applications.splice(index, 1);
  save();
  notify();
  return true;
}

/**
 * Capture hook for the tailor flow: one 'prepared' draft per job description.
 * A still-prepared draft for the same variant+job is refreshed in place (a
 * re-tailor is not a new application); once it advanced past prepared, a
 * re-tailor is a genuinely new send and gets a new record.
 */
export function recordTailorDrafts(variantId, variantName, jds = []) {
  const now = new Date().toISOString();
  const result = [];
  let touched = false;

  for (const jd of jds) {
    const existing = applications.find(
      (a) => a.variantId === variantId && a.jobId === jd.id && a.status === 'prepared',
    );
    if (existing) {
      existing.variantName = variantName;
      existing.jobSnapshot = { title: jd.title || '', company: jd.company || '' };
      existing.updatedAt = now;
      touched = true;
      result.push(existing);
    } else {
      result.push(addApplication({
        variantId,
        variantName,
        jobId: jd.id,
        jobSnapshot: { title: jd.title, company: jd.company },
      }));
    }
  }

  if (touched) {
    save();
    notify();
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/applications.test.js`
Expected: PASS (all tests).

- [ ] **Step 6: Wire boot initialization in main.js**

In `resume-designer/src/main.js`, next to line 52:

```js
import { initApplications } from './applications.js';
```

And immediately after the `initJobDescriptions();` call (line 302):

```js
  initApplications();
```

- [ ] **Step 7: Run the full suite + lint, then commit**

Run: `npm run test && npm run lint`
Expected: all pass, no new lint errors.

```bash
git add resume-designer/src/applications.js resume-designer/test/applications.test.js resume-designer/src/main.js
git commit -m "feat(library): add applications store with status pipeline"
```

---

### Task 2: Capture on tailor

**Files:**
- Modify: `resume-designer/src/components/jobs/JobsDialog.jsx` (`handleTailor`, ~line 265–298)

**Interfaces:**
- Consumes: `recordTailorDrafts(variantId, variantName, jds)` from Task 1; `getCurrentId()` from `variantManager.js` (already imported in JobsDialog); `getVariants()` from `persistence.js` (partially imported — extend the import).

- [ ] **Step 1: Add imports**

In `JobsDialog.jsx`, extend the existing persistence import (line 30) to include `getVariants`:

```js
import { getSettings, saveSettings, saveVariantAnalysis, getVariantAnalysis, getVariants } from '../../persistence.js';
```

Add below it:

```js
import { recordTailorDrafts } from '../../applications.js';
```

- [ ] **Step 2: Record drafts on successful tailor**

In `handleTailor`, after `generateResumeChanges` resolves (inside the `try`, before the `if (result.changes …)` branch — a successful tailor records the link whether or not changes were suggested; "already well-tailored" still means this resume targets these jobs):

```js
      const variantId = getCurrentId();
      if (variantId) {
        const variantName = getVariants()[variantId]?.name || '';
        recordTailorDrafts(variantId, variantName, activeJDs);
      }
```

- [ ] **Step 3: Verify the dedupe behavior is already covered**

The record/refresh/new-record logic is fully tested in `test/applications.test.js` (Task 1); this task only wires the call. Run `npm run test` to confirm nothing regressed.

- [ ] **Step 4: Manual verification**

Run: `npm run dev` — open Jobs dialog, add a JD, tailor. Then in the browser console:
`JSON.parse(localStorage.getItem('resume-designer-applications'))`
Expected: one record with `status: "prepared"`, correct `variantId`, `jobId`, `jobSnapshot`.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add resume-designer/src/components/jobs/JobsDialog.jsx
git commit -m "feat(library): auto-draft applications when tailoring"
```

---

### Task 3: Library search module

**Files:**
- Create: `resume-designer/src/librarySearch.js`
- Create: `resume-designer/test/librarySearch.test.js`

**Interfaces:**
- Consumes: nothing app-specific (pure functions; callers pass data in).
- Produces:
  - `flattenResumeText(data)` → string
  - `makeSnippet(text, query, radius = 40)` → string|null
  - `searchLibrary(query, { variants, applications, jobDescriptions, threads, deep })` → `[{ variantId, quickHit, deepHits: [{ source: 'resume'|'job'|'chat', snippet }] }]`
    - `variants` is `getVariantList()` output (array of variant records with `.id .name .data`), order preserved in results.
    - Empty/blank query → every variant, `quickHit: false`, no deepHits.
    - Non-empty query → only matching variants.

- [ ] **Step 1: Write the failing tests**

Create `resume-designer/test/librarySearch.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { flattenResumeText, makeSnippet, searchLibrary } from '../src/librarySearch.js';

const resumeData = {
  name: 'Ash Shah',
  tagline: 'Product Designer',
  contact: { email: 'a@b.c', location: 'NYC' },
  summary: 'Designer who ships.',
  sections: [
    { id: 's1', title: 'Skills', type: 'list', content: ['Figma', 'Kubernetes'] },
    { id: 's2', title: 'About', type: 'text', content: 'Loves systems.' },
  ],
  experience: [
    { id: 'e1', title: 'Design Lead', company: 'Acme', dates: '2020–2024', bullets: ['Led a team of 5', 'Shipped the flagship app'] },
  ],
  education: ['BFA — RISD — 2016'],
  tools: 'Figma • Blender',
};

const variants = [
  { id: 'v1', name: 'Stripe PM resume', data: resumeData },
  { id: 'v2', name: 'General resume', data: { ...resumeData, name: 'Ash', sections: [], experience: [] } },
];

const applications = [
  { id: 'app-1', variantId: 'v2', jobId: 'jd-1', jobSnapshot: { title: 'Platform PM', company: 'Linear' }, status: 'applied' },
];

const jobDescriptions = [
  { id: 'jd-1', title: 'Platform PM', company: 'Linear', description: 'Own the roadmap for realtime sync.' },
];

const threads = [
  { id: 't1', homeVariantId: 'v1', messages: [{ role: 'user', content: 'emphasize my Kubernetes work please' }] },
];

describe('flattenResumeText', () => {
  it('includes name, sections (list + text), experience bullets, education, tools', () => {
    const text = flattenResumeText(resumeData);
    for (const needle of ['Ash Shah', 'Kubernetes', 'Loves systems.', 'Led a team of 5', 'RISD', 'Blender']) {
      expect(text).toContain(needle);
    }
  });

  it('handles null data', () => {
    expect(flattenResumeText(null)).toBe('');
  });
});

describe('makeSnippet', () => {
  it('returns a trimmed window around the match with ellipses', () => {
    const text = `${'x'.repeat(100)} the Kubernetes migration ${'y'.repeat(100)}`;
    const snip = makeSnippet(text, 'kubernetes');
    expect(snip).toContain('Kubernetes migration');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
  });

  it('returns null when there is no match', () => {
    expect(makeSnippet('nothing here', 'kubernetes')).toBeNull();
  });
});

describe('searchLibrary — quick tier', () => {
  it('empty query returns all variants in order', () => {
    const res = searchLibrary('', { variants, applications });
    expect(res.map((r) => r.variantId)).toEqual(['v1', 'v2']);
  });

  it('matches variant name', () => {
    const res = searchLibrary('stripe', { variants, applications });
    expect(res.map((r) => r.variantId)).toEqual(['v1']);
    expect(res[0].quickHit).toBe(true);
  });

  it('matches linked application company via jobSnapshot', () => {
    const res = searchLibrary('linear', { variants, applications });
    expect(res.map((r) => r.variantId)).toEqual(['v2']);
  });

  it('does NOT match resume content when deep is off', () => {
    expect(searchLibrary('kubernetes', { variants, applications })).toEqual([]);
  });
});

describe('searchLibrary — deep tier', () => {
  const ctx = { variants, applications, jobDescriptions, threads, deep: true };

  it('finds hits inside resume content with a snippet', () => {
    const res = searchLibrary('kubernetes', ctx);
    const v1 = res.find((r) => r.variantId === 'v1');
    expect(v1.deepHits.some((h) => h.source === 'resume' && h.snippet.includes('Kubernetes'))).toBe(true);
  });

  it('finds hits inside linked job description text', () => {
    const res = searchLibrary('realtime sync', ctx);
    expect(res.map((r) => r.variantId)).toEqual(['v2']);
    expect(res[0].deepHits[0].source).toBe('job');
  });

  it('finds hits inside that variant\'s chat threads', () => {
    const res = searchLibrary('emphasize my', ctx);
    const v1 = res.find((r) => r.variantId === 'v1');
    expect(v1.deepHits.some((h) => h.source === 'chat')).toBe(true);
  });

  it('a quick hit still reports quickHit alongside deepHits', () => {
    const res = searchLibrary('stripe', ctx);
    expect(res[0].quickHit).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/librarySearch.test.js`
Expected: FAIL — cannot resolve `../src/librarySearch.js`.

- [ ] **Step 3: Write the implementation**

Create `resume-designer/src/librarySearch.js`:

```js
/**
 * Library Search Module
 *
 * Tiered, in-memory search over resume variants for the Library dialog.
 * Quick tier (always on): variant name + linked applications' job title/company.
 * Deep tier (opt-in):     + flattened resume body text, linked job description
 *                         text, and the variant's chat thread messages.
 *
 * Pure functions — callers pass all data in; nothing here touches storage.
 * Single-user data volumes make a per-keystroke linear scan trivially fast.
 */

/** Flatten a variant's data object into one searchable text blob. */
export function flattenResumeText(data) {
  if (!data) return '';
  const parts = [data.name, data.tagline, data.summary, data.tools];
  for (const value of Object.values(data.contact || {})) parts.push(value);
  for (const section of data.sections || []) {
    parts.push(section.title);
    if (Array.isArray(section.content)) parts.push(...section.content);
    else parts.push(section.content);
  }
  for (const exp of data.experience || []) {
    parts.push(exp.title, exp.company, exp.dates, ...(exp.bullets || []));
  }
  for (const edu of data.education || []) parts.push(edu);
  return parts.filter((p) => typeof p === 'string' && p).join('\n');
}

/** A short window of text around the first case-insensitive match, or null. */
export function makeSnippet(text, query, radius = 40) {
  if (!text || !query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const window = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`;
}

function includes(haystack, q) {
  return typeof haystack === 'string' && haystack.toLowerCase().includes(q);
}

/**
 * Search the library.
 * @returns [{ variantId, quickHit, deepHits: [{ source, snippet }] }]
 *   Empty query → all variants (browse mode). Non-empty → matches only.
 */
export function searchLibrary(query, {
  variants = [],
  applications = [],
  jobDescriptions = [],
  threads = [],
  deep = false,
} = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    return variants.map((v) => ({ variantId: v.id, quickHit: false, deepHits: [] }));
  }

  const results = [];
  for (const variant of variants) {
    const apps = applications.filter((a) => a.variantId === variant.id);

    const quickHit = includes(variant.name, q)
      || apps.some((a) => includes(a.jobSnapshot?.title, q) || includes(a.jobSnapshot?.company, q));

    const deepHits = [];
    if (deep) {
      const resumeSnippet = makeSnippet(flattenResumeText(variant.data), q);
      if (resumeSnippet) deepHits.push({ source: 'resume', snippet: resumeSnippet });

      for (const app of apps) {
        const jd = jobDescriptions.find((j) => j.id === app.jobId);
        if (!jd) continue;
        const jdSnippet = makeSnippet(`${jd.title}\n${jd.company}\n${jd.description}`, q);
        if (jdSnippet) {
          deepHits.push({ source: 'job', snippet: jdSnippet });
          break; // one job hit per variant is enough signal
        }
      }

      for (const thread of threads) {
        if (thread.homeVariantId !== variant.id) continue;
        const msg = (thread.messages || []).find((m) => includes(m?.content, q));
        if (msg) {
          deepHits.push({ source: 'chat', snippet: makeSnippet(msg.content, q) });
          break; // one chat hit per variant is enough signal
        }
      }
    }

    if (quickHit || deepHits.length > 0) {
      results.push({ variantId: variant.id, quickHit, deepHits });
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/librarySearch.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + lint + commit**

```bash
npm run test && npm run lint
git add resume-designer/src/librarySearch.js resume-designer/test/librarySearch.test.js
git commit -m "feat(library): add tiered library search module"
```

---

### Task 4: renderResumeForLayout helper

**Files:**
- Modify: `resume-designer/src/renderer.js` (append after the last renderer, ~line 1109)
- Modify: `resume-designer/src/main.js:1324-1362` (replace the layout switch)
- Create: `resume-designer/test/rendererLayouts.test.js`

**Interfaces:**
- Produces: `renderResumeForLayout(data, layout)` → HTML string. Unknown/missing layout falls back to the default sidebar renderer. Layout keys: `sidebar`, `stacked`, `stacked-vertical`, `right-sidebar`, `compact`, `executive`, `classic`, `classic-featured`, `modern`, `timeline`, `creative` (must match main.js's switch cases exactly).

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/rendererLayouts.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { renderResume, renderResumeTimeline, renderResumeForLayout } from '../src/renderer.js';
import { EMPTY_RESUME } from '../src/store.js';

describe('renderResumeForLayout', () => {
  it('renders the default sidebar layout for "sidebar" and unknown layouts', () => {
    expect(renderResumeForLayout(EMPTY_RESUME, 'sidebar')).toBe(renderResume(EMPTY_RESUME));
    expect(renderResumeForLayout(EMPTY_RESUME, 'not-a-layout')).toBe(renderResume(EMPTY_RESUME));
    expect(renderResumeForLayout(EMPTY_RESUME, undefined)).toBe(renderResume(EMPTY_RESUME));
  });

  it('dispatches named layouts to their renderer', () => {
    expect(renderResumeForLayout(EMPTY_RESUME, 'timeline')).toBe(renderResumeTimeline(EMPTY_RESUME));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rendererLayouts.test.js`
Expected: FAIL — `renderResumeForLayout` is not exported.

- [ ] **Step 3: Add the helper to renderer.js**

Append at the end of `resume-designer/src/renderer.js`:

```js
// Layout id → renderer. Single source of truth for the layout dispatch that
// main.js (live editor) and the Library preview share.
const LAYOUT_RENDERERS = {
  sidebar: renderResume,
  stacked: renderResumeStacked,
  'stacked-vertical': renderResumeStackedVertical,
  'right-sidebar': renderResumeRightSidebar,
  compact: renderResumeCompact,
  executive: renderResumeExecutive,
  classic: renderResumeClassic,
  'classic-featured': renderResumeClassicFeatured,
  modern: renderResumeModern,
  timeline: renderResumeTimeline,
  creative: renderResumeCreative,
};

/** Render resume data with the renderer for `layout` (unknown → sidebar). */
export function renderResumeForLayout(data, layout) {
  return (LAYOUT_RENDERERS[layout] || renderResume)(data);
}
```

- [ ] **Step 4: Replace the switch in main.js**

In `resume-designer/src/main.js`, replace the whole `switch (currentLayout) { … }` block (lines 1323–1362, including the `// Render based on current layout` comment) with:

```js
  // Render based on current layout
  container.innerHTML = renderResumeForLayout(data, currentLayout);
```

Then simplify main.js's renderer import (lines 8–20) to:

```js
import { renderResumeForLayout } from './renderer.js';
```

(Remove the eleven individual renderer imports — they were only used by the switch. If any other main.js call sites use one directly, keep those imports; verify with a grep before deleting.)

- [ ] **Step 5: Run tests + lint**

Run: `npx vitest run test/rendererLayouts.test.js && npm run test && npm run lint`
Expected: all PASS; lint will catch any now-unused imports left behind.

- [ ] **Step 6: Verify the editor still renders every layout**

Run: `npm run dev` — switch through a few layouts in the Design tab (sidebar, timeline, creative). Expected: identical rendering to before.

- [ ] **Step 7: Commit**

```bash
git add resume-designer/src/renderer.js resume-designer/src/main.js resume-designer/test/rendererLayouts.test.js
git commit -m "refactor(renderer): extract renderResumeForLayout dispatch"
```

---

### Task 5: Library dialog shell — list, search, filters, wiring

**Files:**
- Create: `resume-designer/src/hooks/useApplications.js`
- Create: `resume-designer/src/components/library/LibraryDialog.jsx`
- Create: `resume-designer/src/components/library/statusStyles.js`
- Modify: `resume-designer/src/App.jsx` (mount the dialog)
- Modify: `resume-designer/src/components/Header.jsx` (toolbar item + dropdown footer)

**Interfaces:**
- Consumes: `useVariants()` (`{ currentId, list }`), `useApplications()` (array), `searchLibrary` (Task 3), `STATUS_LABELS`/`APPLICATION_STATUSES` (Task 1), `getAllJobDescriptions()`, `loadThreads()`, `loadVariant(id)`.
- Produces: window event contract `rd:open-library` opens the dialog. `statusStyles.js` exports `STATUS_BADGE_CLASSES` (status → Tailwind class string) reused by Task 6. `LibraryDialog` renders `<DetailPane variant={…} applications={…} onAfterDelete={…} onClose={…} />` for the selected variant — Task 6 supplies that component; until then use the placeholder below.

- [ ] **Step 1: Create the hook**

Create `resume-designer/src/hooks/useApplications.js`:

```js
import { useSyncExternalStore } from 'react';
import { subscribeApplications, getApplicationsSnapshot } from '../applications.js';

/** Reactive read of all application records (stable snapshot, see useVariants). */
export function useApplications() {
  return useSyncExternalStore(subscribeApplications, getApplicationsSnapshot);
}
```

- [ ] **Step 2: Create the status style map**

Create `resume-designer/src/components/library/statusStyles.js`:

```js
/**
 * Status → Badge classes for application chips. Muted = draft, warm = in
 * motion, green = win, gray = closed. Shared by the list chips and the
 * detail-pane cards so the two can't drift.
 */
export const STATUS_BADGE_CLASSES = {
  prepared: 'border-transparent bg-muted text-muted-foreground',
  applied: 'border-transparent bg-secondary text-secondary-foreground',
  heard_back: 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300',
  interview: 'border-transparent bg-orange-100 text-orange-900 dark:bg-orange-500/20 dark:text-orange-300',
  offer: 'border-transparent bg-green-100 text-green-900 dark:bg-green-500/20 dark:text-green-300',
  rejected: 'border-transparent bg-muted text-muted-foreground',
  no_response: 'border-transparent bg-muted text-muted-foreground',
};
```

- [ ] **Step 3: Create the dialog**

Create `resume-designer/src/components/library/LibraryDialog.jsx`. Follow JobsDialog's conventions (always mounted, opens on a window event, `glass-card` DialogContent, explicit close button):

```jsx
import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '../ui/dialog.jsx';
import { Input } from '../ui/input.jsx';
import { Badge } from '../ui/badge.jsx';
import { Checkbox } from '../ui/checkbox.jsx';
import { Label } from '../ui/label.jsx';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select.jsx';
import { cn } from '@/lib/utils';
import { useVariants } from '../../hooks/useVariants.js';
import { useApplications } from '../../hooks/useApplications.js';
import { searchLibrary } from '../../librarySearch.js';
import { getAllJobDescriptions } from '../../jobDescriptions.js';
import { loadThreads } from '../../chatThreads.js';
import { APPLICATION_STATUSES, STATUS_LABELS } from '../../applications.js';
import { STATUS_BADGE_CLASSES } from './statusStyles.js';
import DetailPane from './DetailPane.jsx';

// Relative-then-absolute date, same behavior as the header selector.
function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const DEEP_SOURCE_LABELS = { resume: 'in resume', job: 'in job description', chat: 'in chat' };

export default function LibraryDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [deep, setDeep] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'untracked' | a status string
  const [selectedId, setSelectedId] = useState(null);

  const { currentId, list } = useVariants();
  const applications = useApplications();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('rd:open-library', onOpen);
    return () => window.removeEventListener('rd:open-library', onOpen);
  }, []);

  // Default the selection to the current variant each time the dialog opens.
  useEffect(() => {
    if (open) setSelectedId(currentId);
  }, [open, currentId]);

  const results = useMemo(() => {
    if (!open) return [];
    return searchLibrary(query, {
      variants: list,
      applications,
      jobDescriptions: getAllJobDescriptions(),
      threads: loadThreads().threads,
      deep,
    });
  }, [open, query, deep, list, applications]);

  const rows = useMemo(() => {
    const byId = new Map(list.map((v) => [v.id, v]));
    return results
      .map((r) => ({ ...r, variant: byId.get(r.variantId) }))
      .filter((r) => r.variant)
      .filter((r) => {
        if (statusFilter === 'all') return true;
        const apps = applications.filter((a) => a.variantId === r.variantId);
        if (statusFilter === 'untracked') return apps.length === 0;
        return apps.some((a) => a.status === statusFilter);
      });
  }, [results, list, applications, statusFilter]);

  const selected = list.find((v) => v.id === selectedId) || null;
  const selectedApps = applications.filter((a) => a.variantId === selectedId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[82vh] w-[94vw] max-w-[980px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">
          Search and browse your resumes and job applications
        </DialogDescription>

        <div className="flex shrink-0 items-start justify-between gap-3 border-b px-[22px] pb-4 pt-5">
          <div className="space-y-1">
            <DialogTitle>Resume Library</DialogTitle>
            <p className="text-[13px] text-muted-foreground">
              Search your resumes, see what each was tailored for, and track outcomes.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* LEFT: search + list */}
          <div className="flex w-[340px] shrink-0 flex-col border-r">
            <div className="space-y-2.5 border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search resumes…"
                  className="pl-8"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Checkbox id="lib-deep" checked={deep} onCheckedChange={(v) => setDeep(v === true)} />
                  <Label htmlFor="lib-deep" className="text-xs text-muted-foreground">
                    Search everything
                  </Label>
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-7 w-[130px] text-xs" aria-label="Filter by status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="untracked">Untracked</SelectItem>
                    {APPLICATION_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {rows.length === 0 && (
                <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                  {query
                    ? (deep ? 'No matches.' : 'No name or job matches. Try “Search everything”.')
                    : 'No resumes yet.'}
                </div>
              )}
              {rows.map(({ variant, quickHit, deepHits }) => {
                const apps = applications.filter((a) => a.variantId === variant.id);
                const firstDeep = !quickHit && deepHits[0];
                return (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setSelectedId(variant.id)}
                    className={cn(
                      'w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-accent',
                      variant.id === selectedId && 'bg-accent',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-[13.5px] font-medium">{variant.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatDate(variant.updatedAt)}
                      </span>
                    </div>
                    {apps.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {apps.slice(0, 2).map((a) => (
                          <Badge key={a.id} variant="outline" className={cn('text-[10px]', STATUS_BADGE_CLASSES[a.status])}>
                            {a.jobSnapshot?.company || a.jobSnapshot?.title || 'Job'} · {STATUS_LABELS[a.status]}
                          </Badge>
                        ))}
                        {apps.length > 2 && (
                          <span className="text-[10px] text-muted-foreground">+{apps.length - 2}</span>
                        )}
                      </div>
                    )}
                    {firstDeep && (
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        <span className="font-medium">{DEEP_SOURCE_LABELS[firstDeep.source]}:</span> {firstDeep.snippet}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* RIGHT: detail */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <DetailPane
                variant={selected}
                applications={selectedApps}
                onAfterDelete={() => setSelectedId(null)}
                onClose={() => setOpen(false)}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                Select a resume to see its details
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Placeholder DetailPane (replaced in Task 6)**

Create `resume-designer/src/components/library/DetailPane.jsx`:

```jsx
export default function DetailPane({ variant }) {
  return <div className="p-5 text-[13px] text-muted-foreground">{variant.name}</div>;
}
```

- [ ] **Step 5: Mount in App.jsx**

In `resume-designer/src/App.jsx`, add with the other dialog imports:

```js
import LibraryDialog from './components/library/LibraryDialog.jsx';
```

and next to `{storageReady && <JobsDialog />}` (line 96):

```jsx
      {storageReady && <LibraryDialog />}
```

- [ ] **Step 6: Header wiring**

In `resume-designer/src/components/Header.jsx`:

1. Add `LibraryBig` to the existing `lucide-react` import.
2. Add to `toolItems` (line 183, after the `jobs` entry):

```js
    { key: 'library', label: 'Resume Library', short: 'Library', Icon: LibraryBig, run: () => window.dispatchEvent(new CustomEvent('rd:open-library')) },
```

3. In the variant selector `DropdownMenuContent` (line 237), after the `{list.map(…)}` block, add a footer item (`DropdownMenuSeparator` is already imported):

```jsx
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent('rd:open-library'))}>
                <LibraryBig className="size-3.5 shrink-0" />
                <span>View all resumes…</span>
              </DropdownMenuItem>
```

- [ ] **Step 7: Manual verification**

Run: `npm run dev` and verify:
- Header shows a Library button; clicking opens the dialog. The dropdown's "View all resumes…" also opens it.
- List shows all variants, current one preselected; typing filters by name instantly.
- After a tailor run (Task 2 data), the row shows a `Company · Prepared` chip; the status `<select>` filter narrows rows.
- "Search everything" surfaces content matches with an `in resume:` snippet line.
- No console errors.

- [ ] **Step 8: Full suite + lint + commit**

```bash
npm run test && npm run lint
git add resume-designer/src/hooks/useApplications.js resume-designer/src/components/library/ resume-designer/src/App.jsx resume-designer/src/components/Header.jsx
git commit -m "feat(library): add library dialog with tiered search and status chips"
```

---

### Task 6: Detail pane — applications, statuses, notes, variant actions

**Files:**
- Rewrite: `resume-designer/src/components/library/DetailPane.jsx` (replaces Task 5's placeholder)
- Modify: `resume-designer/src/variantManager.js` (add `refreshVariants` export)

**Interfaces:**
- Consumes: Task 1 API (`setApplicationStatus`, `updateApplication`, `deleteApplication`, `addApplication`, `APPLICATION_STATUSES`, `STATUS_LABELS`); `getAllJobDescriptions`, `getJobDescription`; `loadVariant`, `deleteCurrentVariant`, `createVariant`, `generateUniqueVariantName` (persistence), `renameVariant`/`deleteVariant` (persistence), `getVariants` (persistence); `STATUS_BADGE_CLASSES` (Task 5); `PreviewPane` (Task 7 — until then, omit its import/usage; Task 7 adds it).
- Produces: `refreshVariants()` in variantManager — recomputes + publishes the variants snapshot after persistence-level edits made outside variantManager.
- Props contract (fixed by Task 5): `{ variant, applications, onAfterDelete, onClose }`.

- [ ] **Step 1: Add refreshVariants to variantManager.js**

After `getVariantsSnapshot` (line 68):

```js
/**
 * Recompute + publish the variants snapshot after persistence-level edits made
 * outside this module (the Library dialog renames/deletes non-current variants
 * straight through persistence.js, which can't notify subscribers itself).
 */
export function refreshVariants() {
  notify();
}
```

- [ ] **Step 2: Write the DetailPane**

Replace `resume-designer/src/components/library/DetailPane.jsx` with:

```jsx
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { Separator } from '../ui/separator.jsx';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../ui/alert-dialog.jsx';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select.jsx';
import { cn } from '@/lib/utils';
import {
  addApplication, deleteApplication, setApplicationStatus, updateApplication,
  APPLICATION_STATUSES, STATUS_LABELS,
} from '../../applications.js';
import { getAllJobDescriptions, getJobDescription } from '../../jobDescriptions.js';
import {
  loadVariant, deleteCurrentVariant, createVariant, getCurrentId, refreshVariants,
} from '../../variantManager.js';
import {
  deleteVariant, renameVariant, getVariants, generateUniqueVariantName,
} from '../../persistence.js';
import { loadThreads, countThreadsForVariant } from '../../chatThreads.js';
import { STATUS_BADGE_CLASSES } from './statusStyles.js';

function shortDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

/** One application card: status select, dates, notes, inline JD expand. */
function ApplicationCard({ app, onRequestDelete }) {
  const [notes, setNotes] = useState(app.notes || '');
  const [showJd, setShowJd] = useState(false);
  const jd = app.jobId ? getJobDescription(app.jobId) : null;

  // Re-seed local notes when switching between applications.
  useEffect(() => { setNotes(app.notes || ''); }, [app.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium">
            {app.jobSnapshot?.title || 'Untitled role'}
            {app.jobSnapshot?.company ? ` @ ${app.jobSnapshot.company}` : ''}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {app.appliedAt ? `Applied ${shortDate(app.appliedAt)}` : `Prepared ${shortDate(app.createdAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Select value={app.status} onValueChange={(s) => setApplicationStatus(app.id, s)}>
            <SelectTrigger size="sm" className={cn('h-7 w-[130px] text-xs', STATUS_BADGE_CLASSES[app.status])}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPLICATION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label="Delete application"
            onClick={() => onRequestDelete(app)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => { if (notes !== (app.notes || '')) updateApplication(app.id, { notes }); }}
        placeholder="Notes (e.g. recruiter said reapply in 6 months)"
        className="min-h-[52px] text-[12.5px]"
      />

      {jd && (
        <div>
          <button
            type="button"
            onClick={() => setShowJd((v) => !v)}
            className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            {showJd ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            Job description
            {jd.url && (
              <a
                href={jd.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="ml-1 inline-flex items-center gap-0.5 underline"
              >
                open <ExternalLink className="size-3" />
              </a>
            )}
          </button>
          {showJd && (
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11.5px] text-muted-foreground">
              {jd.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Manual fallback: link this resume to a job it was sent to. */
function AddApplicationForm({ variant }) {
  const [adding, setAdding] = useState(false);
  const [jobId, setJobId] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const jds = getAllJobDescriptions();

  const submit = () => {
    const jd = jds.find((j) => j.id === jobId);
    if (!jd && !title.trim() && !company.trim()) return;
    addApplication({
      variantId: variant.id,
      variantName: variant.name,
      jobId: jd ? jd.id : null,
      jobSnapshot: jd ? { title: jd.title, company: jd.company } : { title: title.trim(), company: company.trim() },
      status: 'applied', // manual adds exist because you actually applied
    });
    setAdding(false);
    setJobId(''); setTitle(''); setCompany('');
  };

  if (!adding) {
    return (
      <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
        <Plus className="size-3.5" /> Add application
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      {jds.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs">Saved job</Label>
          <Select value={jobId} onValueChange={setJobId}>
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue placeholder="Pick a saved job description…" />
            </SelectTrigger>
            <SelectContent>
              {jds.map((jd) => (
                <SelectItem key={jd.id} value={jd.id}>{jd.title} @ {jd.company}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {!jobId && (
        <div className="flex gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" className="h-8 text-xs" />
          <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" className="h-8 text-xs" />
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={submit}>Add</Button>
        <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
      </div>
    </div>
  );
}

export default function DetailPane({ variant, applications, onAfterDelete, onClose }) {
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(variant.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingDeleteApp, setPendingDeleteApp] = useState(null);

  useEffect(() => { setRenaming(false); setNewName(variant.name); }, [variant.id, variant.name]);

  const isCurrent = getCurrentId() === variant.id;
  const isLastVariant = Object.keys(getVariants()).length <= 1;

  const openVariant = () => { loadVariant(variant.id); onClose(); };

  const duplicate = () => {
    const name = generateUniqueVariantName(`${variant.name} (Copy)`, getVariants());
    createVariant(name, JSON.parse(JSON.stringify(variant.data))); // loads the copy + notifies
  };

  const commitRename = () => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== variant.name) {
      renameVariant(variant.id, trimmed);
      refreshVariants();
    }
    setRenaming(false);
  };

  const doDelete = () => {
    setConfirmDelete(false);
    if (isCurrent) {
      if (deleteCurrentVariant().ok) onAfterDelete();
    } else {
      deleteVariant(variant.id);
      refreshVariants();
      onAfterDelete();
    }
  };

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          {renaming ? (
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
              autoFocus
              className="h-8 max-w-[320px] text-[15px] font-semibold"
            />
          ) : (
            <h3 className="truncate text-[15px] font-semibold">{variant.name}</h3>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            Created {shortDate(variant.createdAt)} · Updated {shortDate(variant.updatedAt)}
            {(() => {
              const n = countThreadsForVariant(loadThreads().threads, variant.id);
              return n > 0 ? ` · ${n} chat thread${n === 1 ? '' : 's'}` : '';
            })()}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" onClick={openVariant} disabled={isCurrent}>
            {isCurrent ? 'Current' : 'Open'}
          </Button>
          <Button size="sm" variant="outline" onClick={duplicate}>Duplicate</Button>
          <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>Rename</Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={isLastVariant}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <h4 className="text-[13px] font-medium">Applications</h4>
        {applications.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            Not linked to any job yet. Tailoring against a job creates a link automatically.
          </p>
        )}
        {applications.map((app) => (
          <ApplicationCard key={app.id} app={app} onRequestDelete={setPendingDeleteApp} />
        ))}
        <AddApplicationForm variant={variant} />
      </div>

      <AlertDialog open={!!pendingDeleteApp} onOpenChange={(v) => { if (!v) setPendingDeleteApp(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this application?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the link to {pendingDeleteApp?.jobSnapshot?.company || 'this job'} and its status history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { deleteApplication(pendingDeleteApp.id); setPendingDeleteApp(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{variant.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The resume is deleted permanently. Its application history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

Note for the implementer: check `src/components/ui/select.jsx` — if `SelectTrigger` doesn't accept a `size` prop (plain shadcn doesn't), drop `size="sm"` and rely on the `h-7`/`h-8` classes. Match whatever the primitive actually exposes; do not modify the primitive.

- [ ] **Step 3: Manual verification**

Run: `npm run dev` and verify in the Library dialog:
- Status select advances an application; chip colors change in the list immediately (shared store notify).
- Deleting an application asks for confirmation first; the meta line shows a chat-thread count for variants that have threads.
- Notes persist across close/reopen (blur saves; check localStorage key).
- Add application: with a saved JD picked, and again freeform title/company; both appear as `Applied` cards.
- Open switches variant and closes the dialog; Duplicate creates "(Copy)"; Rename inline works and the header dropdown updates (refreshVariants); Delete asks for confirmation, works for current and non-current variants, is disabled for the last one.
- Deleting a variant keeps its applications visible if you re-add? (No — applications remain in storage; verify `resume-designer-applications` still holds them.)

- [ ] **Step 4: Full suite + lint + commit**

```bash
npm run test && npm run lint
git add resume-designer/src/components/library/DetailPane.jsx resume-designer/src/variantManager.js
git commit -m "feat(library): detail pane with application tracking and variant actions"
```

---

### Task 7: Live preview pane

**Files:**
- Create: `resume-designer/src/components/library/PreviewPane.jsx`
- Modify: `resume-designer/src/components/library/DetailPane.jsx` (mount it)

**Interfaces:**
- Consumes: `renderResumeForLayout` (Task 4), `getSettings` from `persistence.js`, `pageDimsIn` from `pageSetup.js`.
- Produces: `<PreviewPane variant={variant} />` — a scaled, inert first-page render.

- [ ] **Step 1: Create PreviewPane**

Create `resume-designer/src/components/library/PreviewPane.jsx`:

```jsx
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderResumeForLayout } from '../../renderer.js';
import { getSettings } from '../../persistence.js';
import { pageDimsIn } from '../../pageSetup.js';

/**
 * Inert, scaled live render of a variant's first page. Reuses the app's real
 * renderer + global .resume stylesheet, so it's always accurate to the current
 * layout setting; no thumbnail cache, rendered only for the selected variant.
 * (Global palette/spacing services style the live editor only — the preview
 * shows the default palette. Acceptable for Phase 1.)
 */
export default function PreviewPane({ variant }) {
  const settings = getSettings();
  const layout = settings.layout || 'sidebar';
  const html = useMemo(() => renderResumeForLayout(variant.data, layout), [variant, layout]);

  const dims = pageDimsIn(settings); // settings carries pageSize/orientation/pageWidthIn
  const pageW = dims.widthIn * 96;
  const pageH = (dims.heightIn || 11) * 96; // continuous → clip to one letter page

  const boxRef = useRef(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    if (boxRef.current) setScale(boxRef.current.clientWidth / pageW);
  }, [pageW, variant.id]);

  return (
    <div
      ref={boxRef}
      className="overflow-hidden rounded-md border bg-white shadow-sm"
      style={{ height: scale ? pageH * scale : undefined }}
      aria-hidden="true"
    >
      {scale > 0 && (
        <div
          className="resume pointer-events-none select-none"
          data-layout={layout}
          style={{ width: `${pageW}px`, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
```

(`dangerouslySetInnerHTML` is safe here: the renderer escapes all user content via `escapeHtml`, and this is the exact HTML already injected into the live editor. `data-editable` attributes are inert — nothing binds listeners inside the dialog, and `pointer-events-none` backstops.)

- [ ] **Step 2: Mount in DetailPane**

In `DetailPane.jsx`, add the import:

```js
import PreviewPane from './PreviewPane.jsx';
```

and render it between the header block and the `<Separator />`:

```jsx
      <PreviewPane variant={variant} />
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev` and verify:
- Selecting different resumes shows their distinct first pages, scaled to pane width, no horizontal overflow, no scrollbars inside the preview box.
- Preview is non-interactive (no text cursor / inline-edit affordances).
- Switch the app's layout in the Design tab, reopen Library — preview follows the layout.

- [ ] **Step 4: Full suite + lint + commit**

```bash
npm run test && npm run lint
git add resume-designer/src/components/library/PreviewPane.jsx resume-designer/src/components/library/DetailPane.jsx
git commit -m "feat(library): live first-page preview in detail pane"
```

---

### Task 8: End-to-end verification in the real engine

**Files:** none (verification only; fix-forward anything found, committing fixes with `fix(library): …`).

- [ ] **Step 1: Full automated pass**

Run: `npm run test && npm run lint`
Expected: everything green.

- [ ] **Step 2: WebKit verification via tauri dev**

Run: `npm run tauri:dev` (Rust compile on first run). The shipped engine is WKWebView — this step is mandatory for a layout-heavy dialog; Chromium preview does not count. Walk the whole flow:

1. Open Library from the header button and from the dropdown footer item.
2. Search by name; toggle "Search everything" and search for a word that only exists in a resume bullet, a JD, and a chat message — confirm all three source tags appear.
3. Tailor a resume against 2 active JDs → 2 `prepared` chips appear; re-tailor → still 2 (dedupe).
4. Advance one to Applied → Interview; set another to Rejected. Confirm chips, the status filter, and `appliedAt` behavior.
5. Add a manual application (freeform). Add notes; close and reopen the app; confirm persistence (Tauri file-backed storage, not localStorage).
6. Delete a JD in the Jobs dialog → the application card keeps title/company (snapshot) and drops the JD expand link.
7. Delete a non-current variant from the detail pane → header dropdown updates; its applications remain in storage.
8. Preview: check scaling/clipping for 2–3 layouts; check dialog behavior at a narrow window width; check dark mode chips.
9. Scroll behavior inside both panes (WebKit scroll quirks are a known hazard in this app).

- [ ] **Step 3: Report**

Summarize verification results to the user. **Do not push or open a PR** — ask the user how they want to proceed (per repo rules, pushing/PRing requires an explicit request).
