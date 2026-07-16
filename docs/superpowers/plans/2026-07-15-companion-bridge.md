# Companion Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loopback HTTP bridge inside the Resume Designer Tauri app that lets the (future) Chrome companion extension list resumes, fetch resume data + profile, proxy AI completions, export a variant's PDF, log applications, and store learned Q&A answers.

**Architecture:** A thin Rust `tiny_http` server on `127.0.0.1:17872` forwards every HTTP request to the main webview as a Tauri event (`bridge:request`) and blocks on a per-request channel. A framework-free JS dispatcher (`src/bridge.js`) routes the request through a pure, dependency-injected router (`src/bridgeRoutes.js`) — where auth and all endpoint logic live — and answers via the `bridge_respond` Tauri command. All reads and writes therefore go through the running app's JS modules, preserving appStorage's single-writer contract. Spec: `docs/superpowers/specs/2026-07-15-companion-extension-design.md`.

**Tech Stack:** Rust (tiny_http 0.12, std mpsc), Tauri 2 events/commands, plain JS service modules (no TypeScript), vitest (jsdom), curl for end-to-end verification.

## Global Constraints

- All npm commands run from `resume-designer/`; all cargo commands from `resume-designer/src-tauri/`.
- Plain JavaScript only — no TypeScript anywhere in `src/`.
- Conventional commits, subject starts lowercase (commitlint checks every PR commit).
- Never commit to `next` or `main` directly — work happens on a feature branch (`feat/companion-bridge`), created at execution start.
- New appStorage keys MUST be added to `BACKUP_FIXED_KEYS` in `src/persistence.js` (backup/restore round-trips only listed keys).
- The bridge binds `127.0.0.1` only. `/health` is the only unauthenticated route; every other route requires `Authorization: Bearer <token>`.
- JS test runner: `npx vitest run <file>` (repo `npm run test` = `vitest run --passWithNoTests`).
- Manual verification uses `npm run tauri:dev`; the dev app shares the real app-data dir (`~/Library/Application Support/com.resumedesigner.app/`).

---

### Task 1: Rust bridge module — pending-response state + `bridge_respond` command

**Files:**
- Create: `resume-designer/src-tauri/src/commands/bridge.rs`
- Modify: `resume-designer/src-tauri/src/commands/mod.rs` (add `pub mod bridge;` next to the existing `pub mod storage;` around line 44)
- Modify: `resume-designer/src-tauri/Cargo.toml` (add `tiny_http = "0.12"` to `[dependencies]`)

**Interfaces:**
- Produces: `BridgePending` (managed state), `bridge_respond(id: u64, status: u16, body: String)` Tauri command, `resolve_pending(...)` internal fn, `timeout_for_path(path: &str) -> Duration`, `BRIDGE_PORT: u16 = 17872`. Task 2 consumes all of these; the JS side (Task 6) calls `bridge_respond` by name with camelCase args (Tauri auto-converts: `id`, `status`, `body`).

- [ ] **Step 1: Add the dependency**

In `resume-designer/src-tauri/Cargo.toml`, under `[dependencies]` (after the `dirs = "5"` line), add:

```toml
# Loopback HTTP listener for the companion-extension bridge (commands/bridge.rs).
# Requests are forwarded to the webview as events; JS answers via bridge_respond.
tiny_http = "0.12"
```

- [ ] **Step 2: Write `bridge.rs` with the state, command, helpers, and their tests**

Create `resume-designer/src-tauri/src/commands/bridge.rs`:

```rust
//! Loopback HTTP bridge for the companion browser extension.
//!
//! A tiny_http server on 127.0.0.1 forwards every request to the main
//! webview as a `bridge:request` event and blocks on a per-request channel.
//! JS routes the request (auth, endpoints — see src/bridge.js) and answers
//! via the `bridge_respond` command. Rust stays a dumb pipe on purpose: all
//! reads/writes go through the running app's JS modules, preserving
//! appStorage's single-writer contract.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

/// Fixed port. If it's taken, the bridge simply doesn't start (logged);
/// the app itself is unaffected.
pub const BRIDGE_PORT: u16 = 17872;

/// Cap request bodies well above any realistic payload (AI messages).
const MAX_BODY_BYTES: usize = 1_048_576; // 1 MiB

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// What JS hands back for one request.
pub struct JsResponse {
    pub status: u16,
    pub body: String,
}

/// Managed state: request id -> channel back to the waiting HTTP thread.
#[derive(Default)]
pub struct BridgePending(pub Mutex<HashMap<u64, SyncSender<JsResponse>>>);

/// AI completions and PDF exports are slow (model latency / hidden print
/// window render + capture); everything else answers from memory.
fn timeout_for_path(path: &str) -> Duration {
    if path.starts_with("/ai/") || path.ends_with("/pdf") {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(30)
    }
}

/// Resolve one pending request. Returns Err if the id is unknown (JS answered
/// twice, or the HTTP thread already timed out and removed it).
fn resolve_pending(pending: &BridgePending, id: u64, response: JsResponse) -> Result<(), String> {
    let sender = {
        let mut map = pending
            .0
            .lock()
            .map_err(|_| "bridge pending-map lock poisoned".to_string())?;
        map.remove(&id)
    };
    match sender {
        Some(tx) => tx
            .send(response)
            .map_err(|_| format!("bridge request {id} receiver dropped")),
        None => Err(format!("no pending bridge request with id {id}")),
    }
}

/// JS answers a forwarded request. `body` is a ready-to-send JSON string.
#[tauri::command]
pub fn bridge_respond(
    id: u64,
    status: u16,
    body: String,
    pending: State<'_, BridgePending>,
) -> Result<(), String> {
    resolve_pending(&pending, id, JsResponse { status, body })
}

#[derive(Clone, serde::Serialize)]
struct BridgeRequestPayload {
    id: u64,
    method: String,
    path: String,
    /// Raw Authorization header value ("" when absent). Token check is JS-side.
    authorization: String,
    body: String,
}

/// Start the listener. Called once from setup(); never panics — a failed
/// bind (port in use) logs and returns, leaving the app fully functional.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", BRIDGE_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("bridge: failed to bind 127.0.0.1:{BRIDGE_PORT}: {e}");
                return;
            }
        };
        println!("bridge: listening on 127.0.0.1:{BRIDGE_PORT}");
        for request in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || handle_request(app, request));
        }
    });
}

fn respond_json(request: tiny_http::Request, status: u16, body: &str) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

fn handle_request(app: AppHandle, mut request: tiny_http::Request) {
    // Read the body with a hard cap so a hostile local process can't OOM us.
    let mut body = String::new();
    {
        let mut limited = request.as_reader().take((MAX_BODY_BYTES + 1) as u64);
        if limited.read_to_string(&mut body).is_err() {
            respond_json(request, 400, r#"{"error":"unreadable request body"}"#);
            return;
        }
    }
    if body.len() > MAX_BODY_BYTES {
        respond_json(request, 413, r#"{"error":"request body too large"}"#);
        return;
    }

    let method = request.method().as_str().to_string();
    let path = request.url().split('?').next().unwrap_or("").to_string();
    let authorization = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = sync_channel::<JsResponse>(1);
    {
        let pending = app.state::<BridgePending>();
        let Ok(mut map) = pending.0.lock() else {
            respond_json(request, 500, r#"{"error":"bridge state lock poisoned"}"#);
            return;
        };
        map.insert(id, tx);
    }

    let timeout = timeout_for_path(&path);
    let payload = BridgeRequestPayload { id, method, path, authorization, body };
    if let Err(e) = app.emit_to("main", "bridge:request", payload) {
        let pending = app.state::<BridgePending>();
        if let Ok(mut map) = pending.0.lock() {
            map.remove(&id);
        }
        eprintln!("bridge: emit failed: {e}");
        respond_json(request, 502, r#"{"error":"app window unavailable"}"#);
        return;
    }

    match rx.recv_timeout(timeout) {
        Ok(res) => respond_json(request, res.status, &res.body),
        Err(_) => {
            // Timed out (or sender dropped): remove our entry so a late
            // bridge_respond gets a clean "no pending request" error.
            let pending = app.state::<BridgePending>();
            if let Ok(mut map) = pending.0.lock() {
                map.remove(&id);
            }
            respond_json(
                request,
                504,
                r#"{"error":"the app did not answer in time — is Resume Designer running and unlocked?"}"#,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_is_long_for_ai_and_pdf_short_otherwise() {
        assert_eq!(timeout_for_path("/ai/complete"), Duration::from_secs(180));
        assert_eq!(timeout_for_path("/resumes/v-1/pdf"), Duration::from_secs(180));
        assert_eq!(timeout_for_path("/resumes"), Duration::from_secs(30));
        assert_eq!(timeout_for_path("/health"), Duration::from_secs(30));
    }

    #[test]
    fn resolve_pending_roundtrips_a_response() {
        let pending = BridgePending::default();
        let (tx, rx) = sync_channel::<JsResponse>(1);
        pending.0.lock().unwrap().insert(7, tx);

        resolve_pending(&pending, 7, JsResponse { status: 200, body: "{}".into() }).unwrap();
        let got = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(got.status, 200);
        assert_eq!(got.body, "{}");
        // Entry consumed: a second resolve for the same id must error.
        assert!(resolve_pending(&pending, 7, JsResponse { status: 200, body: "{}".into() }).is_err());
    }

    #[test]
    fn resolve_pending_unknown_id_errors() {
        let pending = BridgePending::default();
        let err = resolve_pending(&pending, 99, JsResponse { status: 200, body: "{}".into() })
            .unwrap_err();
        assert!(err.contains("no pending bridge request"));
    }
}
```

- [ ] **Step 3: Register the module**

In `resume-designer/src-tauri/src/commands/mod.rs`, next to the existing `pub mod storage;` (~line 44), add:

```rust
/// Loopback HTTP bridge for the companion browser extension.
pub mod bridge;
```

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test bridge` (from `resume-designer/src-tauri/`)
Expected: the 3 tests in `commands::bridge::tests` PASS. Then `cargo check` — compiles with no warnings about bridge.rs (`start` is not yet called; if an unused warning appears, that's expected until Task 2 and acceptable for this commit only if `cargo check` still exits 0).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/bridge.rs src-tauri/src/commands/mod.rs
git commit -m "feat(bridge): add loopback bridge state, respond command, and request forwarding"
```

---

### Task 2: Wire the bridge into the app (lib.rs) and verify the timeout path with curl

**Files:**
- Modify: `resume-designer/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `commands::bridge::{BridgePending, bridge_respond, start}` from Task 1.
- Produces: a running listener on `127.0.0.1:17872` in every desktop build. Tasks 6–10 rely on the event name `bridge:request` and command name `bridge_respond`.

- [ ] **Step 1: Manage state, start the server, register the command**

In `resume-designer/src-tauri/src/lib.rs`:

a. After `.manage(commands::PreviewPdfPath::default())` add:

```rust
        .manage(commands::bridge::BridgePending::default())
```

b. Inside `.setup(|app| { ... })`, inside the existing `#[cfg(desktop)]` block (right after `app.manage(commands::updater::PendingUpdate::default());`), add:

```rust
                // Companion-extension bridge: loopback HTTP listener that
                // forwards requests to the webview (see commands/bridge.rs).
                commands::bridge::start(app.handle().clone());
```

c. In `tauri::generate_handler![...]`, after `commands::storage::storage_clear,` add:

```rust
            commands::bridge::bridge_respond,
```

- [ ] **Step 2: Compile**

Run: `cargo check` (from `resume-designer/src-tauri/`)
Expected: success, no unused-fn warning for `start` anymore.

- [ ] **Step 3: Verify the listener + timeout behavior end-to-end**

Run: `npm run tauri:dev` (from `resume-designer/`), wait for the window, then in another shell:

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17872/health
```

Expected: curl waits (no JS listener exists yet) and the `-m 5` client timeout fires — exit code 28, `000` printed. Then rerun without `-m`:

```bash
time curl -s http://127.0.0.1:17872/health
```

Expected after ~30s: `{"error":"the app did not answer in time — is Resume Designer running and unlocked?"}` with status 504. This proves: server bound, event emitted, pending-map timeout cleanup works. Quit the dev app.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(bridge): start loopback listener and register bridge_respond"
```

---

### Task 3: `learnedAnswers.js` storage module (TDD)

**Files:**
- Create: `resume-designer/src/learnedAnswers.js`
- Test: `resume-designer/test/learnedAnswers.test.js`

**Interfaces:**
- Consumes: `appStorage` facade, `generateId` from `src/store.js`, `storageErrorToast` from `src/storageToast.js` (mirror `src/applications.js`'s save pattern exactly).
- Produces: `initLearnedAnswers()`, `getAllLearnedAnswers() -> [{id, question, normalized, answer, createdAt, updatedAt}]`, `saveLearnedAnswer(question, answer) -> entry` (upsert by normalized question), `deleteLearnedAnswer(id)`, `normalizeQuestion(q) -> string`. Storage key: `resume-designer-learned-answers`.

- [ ] **Step 1: Write the failing tests**

Create `resume-designer/test/learnedAnswers.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import {
  initLearnedAnswers, getAllLearnedAnswers, saveLearnedAnswer,
  deleteLearnedAnswer, normalizeQuestion,
} from '../src/learnedAnswers.js';

const KEY = 'resume-designer-learned-answers';

beforeEach(() => {
  localStorage.clear();
  initLearnedAnswers();
});

describe('normalizeQuestion', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeQuestion('  What is your  Notice Period?! ')).toBe('what is your notice period');
  });
  it('handles empty and non-string input', () => {
    expect(normalizeQuestion('')).toBe('');
    expect(normalizeQuestion(null)).toBe('');
  });
});

describe('saveLearnedAnswer', () => {
  it('adds a new answer with id and timestamps', () => {
    const entry = saveLearnedAnswer('Notice period?', '4 weeks');
    expect(entry.id).toBeTruthy();
    expect(entry.question).toBe('Notice period?');
    expect(entry.normalized).toBe('notice period');
    expect(entry.answer).toBe('4 weeks');
    expect(entry.createdAt).toBeTruthy();
    expect(getAllLearnedAnswers()).toHaveLength(1);
  });

  it('upserts by normalized question instead of duplicating', () => {
    const first = saveLearnedAnswer('Notice period?', '4 weeks');
    const second = saveLearnedAnswer('notice PERIOD', '2 weeks');
    expect(getAllLearnedAnswers()).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(getAllLearnedAnswers()[0].answer).toBe('2 weeks');
  });

  it('persists across reload', () => {
    saveLearnedAnswer('Work authorization?', 'US citizen');
    initLearnedAnswers(); // fresh boot re-reads storage
    expect(getAllLearnedAnswers()).toHaveLength(1);
    expect(getAllLearnedAnswers()[0].answer).toBe('US citizen');
  });

  it('rejects empty question or answer', () => {
    expect(() => saveLearnedAnswer('', 'x')).toThrow();
    expect(() => saveLearnedAnswer('q', '')).toThrow();
  });
});

describe('initLearnedAnswers — stored shapes', () => {
  it('self-heals a corrupt store to an empty list', () => {
    localStorage.setItem(KEY, '{"not":"an array"}');
    initLearnedAnswers();
    expect(getAllLearnedAnswers()).toEqual([]);
  });
});

describe('deleteLearnedAnswer', () => {
  it('removes by id', () => {
    const { id } = saveLearnedAnswer('Pronouns?', 'they/them');
    deleteLearnedAnswer(id);
    expect(getAllLearnedAnswers()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/learnedAnswers.test.js` (from `resume-designer/`)
Expected: FAIL — cannot resolve `../src/learnedAnswers.js`.

- [ ] **Step 3: Implement the module**

Create `resume-designer/src/learnedAnswers.js`:

```js
/**
 * Learned Answers Module
 *
 * Q&A pairs the companion extension learns while filling job applications
 * (notice period, work authorization, ...). Keyed by a normalized form of the
 * question so re-asked questions upsert instead of piling up duplicates.
 * Fed back into the AI mapping call as context on later applications.
 *
 * Storage: own appStorage key (array), same pattern as applications.js.
 */

import { generateId } from './store.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';

const STORAGE_KEY = 'resume-designer-learned-answers';

let answers = [];

/** Lowercase, strip punctuation, collapse whitespace — the upsert key. */
export function normalizeQuestion(q) {
  return String(q ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function save() {
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  } catch (e) {
    // Mirror applications.js: human-readable message + once-per-session toast.
    console.error('Failed to save learned answers:', e);
    storageErrorToast('Could not save learned answers — storage may be full.', { once: true });
  }
}

/** Load from storage; self-heal anything that isn't an array to []. */
export function initLearnedAnswers() {
  try {
    const raw = appStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    answers = Array.isArray(parsed) ? parsed : [];
  } catch {
    answers = [];
  }
  return answers;
}

export function getAllLearnedAnswers() {
  return answers.slice();
}

/** Upsert by normalized question. Throws on empty question/answer. */
export function saveLearnedAnswer(question, answer) {
  const q = String(question ?? '').trim();
  const a = String(answer ?? '').trim();
  if (!q) throw new Error('learned answer needs a question');
  if (!a) throw new Error('learned answer needs an answer');
  const normalized = normalizeQuestion(q);
  const now = new Date().toISOString();
  const existing = answers.find((e) => e.normalized === normalized);
  if (existing) {
    existing.question = q;
    existing.answer = a;
    existing.updatedAt = now;
    save();
    return existing;
  }
  const entry = { id: generateId('ans'), question: q, normalized, answer: a, createdAt: now, updatedAt: now };
  answers.push(entry);
  save();
  return entry;
}

export function deleteLearnedAnswer(id) {
  const before = answers.length;
  answers = answers.filter((e) => e.id !== id);
  if (answers.length !== before) save();
}
```

Note: `generateId('ans')` follows the confirmed pattern — `applications.js` calls `generateId('app')` the same way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/learnedAnswers.test.js`
Expected: all PASS.

- [ ] **Step 5: Init at boot**

In `resume-designer/src/main.js`, add to the imports near `initApplications`:

```js
import { initLearnedAnswers } from './learnedAnswers.js';
```

and inside `init()`, directly after the existing `initApplications();` line, add:

```js
  initLearnedAnswers();
```

- [ ] **Step 6: Full test suite + commit**

Run: `npm run test` — expected: all suites pass.

```bash
git add src/learnedAnswers.js test/learnedAnswers.test.js src/main.js
git commit -m "feat(bridge): learned-answers store for application q&a"
```

---

### Task 4: Backup coverage for the new storage keys

**Files:**
- Modify: `resume-designer/src/persistence.js` (`BACKUP_FIXED_KEYS`, ~line 323)
- Test: `resume-designer/test/backupKeys.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resume-designer-learned-answers` and `resume-designer-bridge-token` round-trip through full backup/restore. (The token key is created in Task 6; listing it now is harmless — backup skips absent keys.)

- [ ] **Step 1: Write the failing test**

In `resume-designer/test/backupKeys.test.js`, add inside the `describe('isOwnedKey', ...)` block:

```js
  it('accepts the bridge keys', () => {
    expect(isOwnedKey('resume-designer-learned-answers')).toBe(true);
    expect(isOwnedKey('resume-designer-bridge-token')).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/backupKeys.test.js`
Expected: FAIL — both `isOwnedKey` calls return false.

- [ ] **Step 3: Add the keys**

In `resume-designer/src/persistence.js`, in `BACKUP_FIXED_KEYS` after `'resume-designer-token-usage',`:

```js
  'resume-designer-learned-answers',
  'resume-designer-bridge-token',
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/backupKeys.test.js` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence.js test/backupKeys.test.js
git commit -m "feat(bridge): include learned answers and bridge token in backups"
```

---

### Task 5: `completeForBridge` export in aiService

**Files:**
- Modify: `resume-designer/src/aiService.js` (add one export near `chat`, after `callOpenRouter` ~line 1045)

**Interfaces:**
- Consumes: internal `callOpenRouter(modelId, messages, options)` (returns the response text string when `options.structured` is not set), `getApiKey()`, `getSettings()`, `validateModelId()` — all already in the file.
- Produces: `completeForBridge(messages, options) -> Promise<string>`. Options: `{ systemPrompt?, reasoningEffort? }`. Usage tracking lands under feature name `bridge` (the option key is `feature`, as used by `generateResumeChanges`).

- [ ] **Step 1: Add the export**

In `resume-designer/src/aiService.js`, directly after the `callOpenRouter` function ends (~line 1045), add:

```js
/**
 * Minimal completion for the local companion-extension bridge. Unlike chat(),
 * no resume/job context is injected — the bridge request carries its own
 * messages. Uses the settings' default model; tracked as feature 'bridge'.
 */
export async function completeForBridge(messages, options = {}) {
  if (!getApiKey()) throw new Error('No OpenRouter API key configured. Add your key in Settings.');
  const settings = getSettings();
  const modelId = validateModelId(settings.defaultModel);
  return callOpenRouter(modelId, messages, {
    feature: 'bridge',
    systemPrompt: options.systemPrompt,
    reasoningEffort: options.reasoningEffort,
  });
}
```

- [ ] **Step 2: Lint + existing tests**

Run: `npm run lint && npm run test`
Expected: clean; no behavior change to existing suites. (This thin wrapper is exercised for real by the curl verification in Task 7 — no mocked-fetch unit test adds signal here.)

- [ ] **Step 3: Commit**

```bash
git add src/aiService.js
git commit -m "feat(bridge): context-free ai completion entry point"
```

---

### Task 6: `bridgeRoutes.js` — the pure router (TDD)

**Files:**
- Create: `resume-designer/src/bridgeRoutes.js`
- Test: `resume-designer/test/bridgeRoutes.test.js`

**Interfaces:**
- Consumes: nothing directly — every capability arrives as an injected dep.
- Produces: `createBridgeRouter(deps) -> async ({method, path, authorization, body}) -> {status, body}` where `body` is a plain object (Task 7 JSON-stringifies it). Deps contract (Task 7 supplies the real ones):
  - `version: string`
  - `getToken(): string`
  - `getVariants(): {[id]: {id, name, data, updatedAt}}`
  - `getUserProfile(): object`
  - `getLearnedAnswers(): array`
  - `addApplication(fields): object`
  - `saveLearnedAnswer(question, answer): object`
  - `complete(messages, options): Promise<string>`
  - `exportVariantPdf(variantId): Promise<string>` (base64)

- [ ] **Step 1: Write the failing tests**

Create `resume-designer/test/bridgeRoutes.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createBridgeRouter } from '../src/bridgeRoutes.js';

const VARIANTS = {
  'v-1': { id: 'v-1', name: 'Backend Resume', data: { name: 'Ash' }, updatedAt: '2026-07-01T00:00:00.000Z' },
  'v-2': { id: 'v-2', name: 'Frontend Resume', data: { name: 'Ash' }, updatedAt: '2026-07-10T00:00:00.000Z' },
};

function makeDeps(overrides = {}) {
  return {
    version: '1.0.0',
    getToken: () => 'tok-123',
    getVariants: () => VARIANTS,
    getUserProfile: () => ({ markdown: '# Ash' }),
    getLearnedAnswers: () => [{ id: 'ans-1', question: 'Notice period?', answer: '4 weeks' }],
    addApplication: vi.fn((fields) => ({ id: 'app-1', ...fields })),
    saveLearnedAnswer: vi.fn((q, a) => ({ id: 'ans-2', question: q, answer: a })),
    complete: vi.fn(async () => 'ai says hi'),
    exportVariantPdf: vi.fn(async () => 'JVBERi0base64=='),
    ...overrides,
  };
}

const AUTH = 'Bearer tok-123';
const route = (deps, req) => createBridgeRouter(deps)(req);

describe('auth', () => {
  it('health needs no token', async () => {
    const res = await route(makeDeps(), { method: 'GET', path: '/health', authorization: '', body: '' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, app: 'resume-designer', version: '1.0.0' });
  });
  it('rejects a missing or wrong token with 401', async () => {
    for (const authorization of ['', 'Bearer wrong', 'tok-123']) {
      const res = await route(makeDeps(), { method: 'GET', path: '/resumes', authorization, body: '' });
      expect(res.status).toBe(401);
    }
  });
  it('rejects everything when no token is provisioned yet', async () => {
    const res = await route(makeDeps({ getToken: () => '' }), { method: 'GET', path: '/resumes', authorization: 'Bearer ', body: '' });
    expect(res.status).toBe(401);
  });
});

describe('GET /resumes', () => {
  it('lists id/name/updatedAt, newest first, no resume data', async () => {
    const res = await route(makeDeps(), { method: 'GET', path: '/resumes', authorization: AUTH, body: '' });
    expect(res.status).toBe(200);
    expect(res.body.resumes).toEqual([
      { id: 'v-2', name: 'Frontend Resume', updatedAt: '2026-07-10T00:00:00.000Z' },
      { id: 'v-1', name: 'Backend Resume', updatedAt: '2026-07-01T00:00:00.000Z' },
    ]);
  });
});

describe('GET /resumes/:id', () => {
  it('returns data, profile, and learned answers', async () => {
    const res = await route(makeDeps(), { method: 'GET', path: '/resumes/v-1', authorization: AUTH, body: '' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('v-1');
    expect(res.body.data).toEqual({ name: 'Ash' });
    expect(res.body.profile).toEqual({ markdown: '# Ash' });
    expect(res.body.learnedAnswers).toHaveLength(1);
  });
  it('404s an unknown id', async () => {
    const res = await route(makeDeps(), { method: 'GET', path: '/resumes/nope', authorization: AUTH, body: '' });
    expect(res.status).toBe(404);
  });
});

describe('GET /resumes/:id/pdf', () => {
  it('returns base64 and a filename derived from the variant name', async () => {
    const deps = makeDeps();
    const res = await route(deps, { method: 'GET', path: '/resumes/v-1/pdf', authorization: AUTH, body: '' });
    expect(res.status).toBe(200);
    expect(deps.exportVariantPdf).toHaveBeenCalledWith('v-1');
    expect(res.body).toEqual({ filename: 'Backend-Resume.pdf', pdfBase64: 'JVBERi0base64==' });
  });
  it('404s an unknown id without exporting', async () => {
    const deps = makeDeps();
    const res = await route(deps, { method: 'GET', path: '/resumes/nope/pdf', authorization: AUTH, body: '' });
    expect(res.status).toBe(404);
    expect(deps.exportVariantPdf).not.toHaveBeenCalled();
  });
  it('maps an export failure to 500 with the message', async () => {
    const deps = makeDeps({ exportVariantPdf: vi.fn(async () => { throw new Error('another PDF export is in progress'); }) });
    const res = await route(deps, { method: 'GET', path: '/resumes/v-1/pdf', authorization: AUTH, body: '' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/in progress/);
  });
});

describe('POST /ai/complete', () => {
  const MSGS = [{ role: 'user', content: 'map these fields' }];
  it('delegates messages and options to complete()', async () => {
    const deps = makeDeps();
    const res = await route(deps, {
      method: 'POST', path: '/ai/complete', authorization: AUTH,
      body: JSON.stringify({ messages: MSGS, systemPrompt: 'sys', reasoningEffort: 'low' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'ai says hi' });
    expect(deps.complete).toHaveBeenCalledWith(MSGS, { systemPrompt: 'sys', reasoningEffort: 'low' });
  });
  it('400s invalid JSON and invalid messages', async () => {
    const bad = [
      'not json',
      JSON.stringify({}),
      JSON.stringify({ messages: [] }),
      JSON.stringify({ messages: [{ role: 'user' }] }),
    ];
    for (const body of bad) {
      const res = await route(makeDeps(), { method: 'POST', path: '/ai/complete', authorization: AUTH, body });
      expect(res.status).toBe(400);
    }
  });
  it('maps an upstream AI failure to 502', async () => {
    const deps = makeDeps({ complete: vi.fn(async () => { throw new Error('rate limited'); }) });
    const res = await route(deps, { method: 'POST', path: '/ai/complete', authorization: AUTH, body: JSON.stringify({ messages: MSGS }) });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/rate limited/);
  });
});

describe('POST /applications', () => {
  it('creates an applied record with a job snapshot', async () => {
    const deps = makeDeps();
    const res = await route(deps, {
      method: 'POST', path: '/applications', authorization: AUTH,
      body: JSON.stringify({ variantId: 'v-1', company: 'Acme', title: 'Staff Engineer', notes: 'via extension' }),
    });
    expect(res.status).toBe(201);
    expect(deps.addApplication).toHaveBeenCalledWith({
      variantId: 'v-1',
      variantName: 'Backend Resume',
      jobSnapshot: { title: 'Staff Engineer', company: 'Acme' },
      status: 'applied',
      notes: 'via extension',
    });
    expect(res.body.application.id).toBe('app-1');
  });
  it('400s a missing variantId and 404s an unknown one', async () => {
    let res = await route(makeDeps(), { method: 'POST', path: '/applications', authorization: AUTH, body: JSON.stringify({ company: 'Acme' }) });
    expect(res.status).toBe(400);
    res = await route(makeDeps(), { method: 'POST', path: '/applications', authorization: AUTH, body: JSON.stringify({ variantId: 'nope' }) });
    expect(res.status).toBe(404);
  });
});

describe('POST /profile/answers', () => {
  it('saves a q&a pair', async () => {
    const deps = makeDeps();
    const res = await route(deps, {
      method: 'POST', path: '/profile/answers', authorization: AUTH,
      body: JSON.stringify({ question: 'Notice period?', answer: '4 weeks' }),
    });
    expect(res.status).toBe(201);
    expect(deps.saveLearnedAnswer).toHaveBeenCalledWith('Notice period?', '4 weeks');
  });
  it('400s empty question or answer', async () => {
    for (const body of [JSON.stringify({ question: '', answer: 'x' }), JSON.stringify({ question: 'q', answer: '' })]) {
      const res = await route(makeDeps(), { method: 'POST', path: '/profile/answers', authorization: AUTH, body });
      expect(res.status).toBe(400);
    }
  });
});

describe('fallthrough', () => {
  it('404s unknown routes and wrong methods', async () => {
    for (const req of [
      { method: 'GET', path: '/nope', authorization: AUTH, body: '' },
      { method: 'POST', path: '/resumes', authorization: AUTH, body: '{}' },
      { method: 'DELETE', path: '/resumes/v-1', authorization: AUTH, body: '' },
    ]) {
      const res = await route(makeDeps(), req);
      expect(res.status).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/bridgeRoutes.test.js`
Expected: FAIL — cannot resolve `../src/bridgeRoutes.js`.

- [ ] **Step 3: Implement the router**

Create `resume-designer/src/bridgeRoutes.js`:

```js
/**
 * Bridge Router
 *
 * Pure request routing for the companion-extension bridge: auth check +
 * endpoint logic, with every capability injected (see bridge.js for the real
 * deps). Pure so vitest can drive the full HTTP surface without Tauri.
 *
 * Contract with bridge.js / bridge.rs: input is {method, path, authorization,
 * body:string}; output is {status, body:object} — bridge.js stringifies body.
 */

const json = (status, body) => ({ status, body });

/** "Backend Resume" -> "Backend-Resume.pdf" (safe cross-platform filename). */
function pdfFilename(name) {
  const base = String(name || 'Resume').trim().replace(/[^\p{L}\p{N} _.-]+/gu, '').replace(/\s+/g, '-');
  return `${base || 'Resume'}.pdf`;
}

/** Own-key variant lookup — inherited keys (__proto__, constructor) must 404, not resolve. */
const findVariant = (variants, id) => (Object.hasOwn(variants, id) ? variants[id] : undefined);

export function createBridgeRouter(deps) {
  return async function handleBridgeRequest({ method, path, authorization, body }) {
    if (method === 'GET' && path === '/health') {
      return json(200, { ok: true, app: 'resume-designer', version: deps.version });
    }

    const token = deps.getToken();
    if (!token || authorization !== `Bearer ${token}`) {
      return json(401, { error: 'invalid or missing bearer token' });
    }

    let parsed = null;
    if (method === 'POST') {
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return json(400, { error: 'invalid JSON body' });
      }
    }

    try {
      if (method === 'GET' && path === '/resumes') {
        const resumes = Object.values(deps.getVariants())
          .map((v) => ({ id: v.id, name: v.name, updatedAt: v.updatedAt }))
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return json(200, { resumes });
      }

      const detail = method === 'GET' && path.match(/^\/resumes\/([^/]+)$/);
      if (detail) {
        const variant = findVariant(deps.getVariants(), detail[1]);
        if (!variant) return json(404, { error: `no resume with id ${detail[1]}` });
        return json(200, {
          id: variant.id,
          name: variant.name,
          updatedAt: variant.updatedAt,
          data: variant.data,
          profile: deps.getUserProfile(),
          learnedAnswers: deps.getLearnedAnswers(),
        });
      }

      const pdf = method === 'GET' && path.match(/^\/resumes\/([^/]+)\/pdf$/);
      if (pdf) {
        const variant = findVariant(deps.getVariants(), pdf[1]);
        if (!variant) return json(404, { error: `no resume with id ${pdf[1]}` });
        const pdfBase64 = await deps.exportVariantPdf(variant.id);
        return json(200, { filename: pdfFilename(variant.name), pdfBase64 });
      }

      if (method === 'POST' && path === '/ai/complete') {
        const messages = parsed.messages;
        const valid = Array.isArray(messages) && messages.length > 0
          && messages.every((m) => m && typeof m.role === 'string' && typeof m.content === 'string');
        if (!valid) return json(400, { error: 'messages must be a non-empty array of {role, content}' });
        try {
          const text = await deps.complete(messages, {
            systemPrompt: parsed.systemPrompt,
            reasoningEffort: parsed.reasoningEffort,
          });
          return json(200, { text });
        } catch (err) {
          return json(502, { error: err?.message || 'AI request failed' });
        }
      }

      if (method === 'POST' && path === '/applications') {
        const variantId = typeof parsed.variantId === 'string' ? parsed.variantId.trim() : '';
        if (!variantId) return json(400, { error: 'variantId is required' });
        const variant = findVariant(deps.getVariants(), variantId);
        if (!variant) return json(404, { error: `no resume with id ${variantId}` });
        const application = deps.addApplication({
          variantId,
          variantName: variant.name,
          jobSnapshot: {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            company: typeof parsed.company === 'string' ? parsed.company : '',
          },
          status: 'applied',
          notes: typeof parsed.notes === 'string' ? parsed.notes : '',
        });
        return json(201, { application });
      }

      if (method === 'POST' && path === '/profile/answers') {
        const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
        const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
        if (!question || !answer) return json(400, { error: 'question and answer are required' });
        const saved = deps.saveLearnedAnswer(question, answer);
        return json(201, { answer: saved });
      }

      return json(404, { error: `no route: ${method} ${path}` });
    } catch (err) {
      return json(500, { error: err?.message || 'internal error' });
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/bridgeRoutes.test.js`
Expected: all PASS. Then `npm run lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/bridgeRoutes.js test/bridgeRoutes.test.js
git commit -m "feat(bridge): pure request router with auth and all v1 endpoints"
```

---

### Task 7: `bridge.js` glue — token, event listener, wiring into init(); curl verification

**Files:**
- Create: `resume-designer/src/bridge.js`
- Modify: `resume-designer/src/main.js` (call `initBridge()` inside `init()`)

**Interfaces:**
- Consumes: `createBridgeRouter` (Task 6), `completeForBridge` (Task 5), `getAllLearnedAnswers`/`saveLearnedAnswer` (Task 3), `getVariants`/`getUserProfile` from `persistence.js`, `addApplication` from `applications.js`, `bridge_respond` command + `bridge:request` event (Tasks 1–2). `exportVariantPdfBase64` from `pdf.js` does not exist yet (Task 8) — wire it as a stub that throws, so the route 500s cleanly until Task 8 replaces it.
- Produces: `initBridge()`, `getBridgeToken()` (Task 9's Settings UI reads this). Token storage key `resume-designer-bridge-token`.

- [ ] **Step 1: Implement `bridge.js`**

Create `resume-designer/src/bridge.js`:

```js
/**
 * Bridge Glue
 *
 * Tauri-side wiring for the companion-extension bridge: owns the pairing
 * token, subscribes to `bridge:request` events from the Rust loopback server
 * (src-tauri/src/commands/bridge.rs), routes them through the pure router
 * (bridgeRoutes.js) with the app's real modules injected, and answers via the
 * `bridge_respond` command. No-op outside Tauri (browser dev/tests).
 */

import { appStorage } from './appStorage.js';
import { createBridgeRouter } from './bridgeRoutes.js';
import { getVariants, getUserProfile } from './persistence.js';
import { addApplication } from './applications.js';
import { getAllLearnedAnswers, saveLearnedAnswer } from './learnedAnswers.js';
import { completeForBridge } from './aiService.js';

const TOKEN_KEY = 'resume-designer-bridge-token';

// Same Tauri sniff as appStorage.js (duplicated for the same cycle reason).
const IS_TAURI =
  typeof window !== 'undefined' &&
  ('isTauri' in window || '__TAURI_INTERNALS__' in window || '__TAURI__' in window);

export function getBridgeToken() {
  return appStorage.getItem(TOKEN_KEY) || '';
}

function ensureBridgeToken() {
  let token = getBridgeToken();
  if (!token) {
    token = crypto.randomUUID();
    appStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

export async function initBridge() {
  if (!IS_TAURI) return;
  ensureBridgeToken();

  const [{ listen }, { invoke }, { getVersion }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/app'),
  ]);
  const version = await getVersion();

  // PDF export lands in Task 8 (pdf.js). Until then the route 500s cleanly.
  let exportVariantPdf = async () => {
    throw new Error('PDF export over the bridge is not available yet');
  };
  try {
    const pdf = await import('./pdf.js');
    if (typeof pdf.exportVariantPdfBase64 === 'function') {
      exportVariantPdf = pdf.exportVariantPdfBase64;
    }
  } catch (e) {
    console.warn('[Bridge] pdf module unavailable:', e);
  }

  const handle = createBridgeRouter({
    version,
    getToken: getBridgeToken,
    getVariants,
    getUserProfile,
    getLearnedAnswers: getAllLearnedAnswers,
    addApplication,
    saveLearnedAnswer,
    complete: completeForBridge,
    exportVariantPdf,
  });

  await listen('bridge:request', async (event) => {
    const { id, method, path, authorization, body } = event.payload || {};
    let res;
    try {
      res = await handle({ method, path, authorization, body });
    } catch (err) {
      res = { status: 500, body: { error: err?.message || 'internal error' } };
    }
    try {
      await invoke('bridge_respond', { id, status: res.status, body: JSON.stringify(res.body) });
    } catch (err) {
      // Late answer after the HTTP thread timed out — nothing to do.
      console.warn('[Bridge] respond failed:', err);
    }
  });
  console.log('[Bridge] ready on 127.0.0.1:17872');
}
```

- [ ] **Step 2: Wire into init()**

In `resume-designer/src/main.js`, inside `init()` right after the `initUpdateFlow()` call (~line 402, dynamic-import section — the bridge must never load in the print window, and `init()` only runs in the main window):

```js
  // Companion-extension bridge (desktop only; no-op in browser dev).
  const { initBridge } = await import('./bridge.js');
  initBridge();
```

Note `initBridge()` is deliberately not awaited — bridge readiness must not block app boot.

- [ ] **Step 3: Lint + full JS suite**

Run: `npm run lint && npm run test`
Expected: clean.

- [ ] **Step 4: End-to-end curl verification**

Run `npm run tauri:dev`, wait for the window, then in another shell:

```bash
B=http://127.0.0.1:17872
TOKEN=$(cat ~/Library/Application\ Support/com.resumedesigner.app/storage/resume-designer-bridge-token)

curl -s $B/health
# -> {"ok":true,"app":"resume-designer","version":"1.0.0"} (instant, no auth)

curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer nope" $B/resumes
# -> 401

curl -s -H "Authorization: Bearer $TOKEN" $B/resumes
# -> {"resumes":[{"id":"...","name":"...","updatedAt":"..."}, ...]} matching the app's variants

ID=$(curl -s -H "Authorization: Bearer $TOKEN" $B/resumes | python3 -c 'import sys,json;print(json.load(sys.stdin)["resumes"][0]["id"])')
curl -s -H "Authorization: Bearer $TOKEN" $B/resumes/$ID | python3 -m json.tool | head -20
# -> id/name/data/profile/learnedAnswers

curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"question":"Notice period?","answer":"4 weeks"}' $B/profile/answers
# -> 201 {"answer":{...}}

curl -s -X POST -H "Authorization: Bearer $TOKEN" -d "{\"variantId\":\"$ID\",\"company\":\"Curl Test Co\",\"title\":\"Engineer\"}" $B/applications
# -> 201 {"application":{...,"status":"applied"}}

curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"messages":[{"role":"user","content":"Reply with exactly: bridge-ok"}]}' $B/ai/complete
# -> {"text":"bridge-ok"} (requires an OpenRouter key configured in Settings)
```

Also verify in the app UI: the library's application tracker shows the "Curl Test Co" record. Delete it afterwards from the UI (it's test data). Quit the dev app.

- [ ] **Step 5: Commit**

```bash
git add src/bridge.js src/main.js
git commit -m "feat(bridge): wire loopback requests through the js router"
```

---

### Task 8: Variant-parameterized headless PDF export

**Files:**
- Modify: `resume-designer/src/main.js` (`initPrintMode`, ~line 565: variant override via `?variant=`)
- Modify: `resume-designer/src/pdf.js` (`generatePdfNative` gains a `variantId` param + in-flight guard; new export `exportVariantPdfBase64`)

**Interfaces:**
- Consumes: existing `generatePdfNative` flow (hidden print window → `print-ready` → `capturePdfFromWindow` → temp slot), `readPdfPreview`/`discardPdfPreview` from `native.js` (already imported in pdf.js).
- Produces: `exportVariantPdfBase64(variantId) -> Promise<string base64>` — Task 7's dynamic lookup picks it up with zero further wiring. Print window URL grows an optional `?variant=<id>`.

- [ ] **Step 1: Variant override in the print window**

In `resume-designer/src/main.js`, inside `initPrintMode()`, find the data-loading block:

```js
    const variantId = getCurrentVariantId();
    const variants = getVariants();
    const variant = variantId ? variants[variantId] : null;
```

Replace with:

```js
    // Bridge exports pass ?variant=<id> to render a specific variant; the
    // user-facing export flow omits it and captures the current one.
    const overrideId = new URLSearchParams(window.location.search).get('variant');
    const variantId = overrideId || getCurrentVariantId();
    const variants = getVariants();
    const variant = variantId ? variants[variantId] : null;
    if (overrideId && !variant?.data) {
      // Fail loudly through the existing print-error path rather than
      // silently capturing the current variant.
      throw new Error(`Print window: no variant with id ${overrideId}`);
    }
```

- [ ] **Step 2: Parameterize `generatePdfNative` and add the in-flight guard**

In `resume-designer/src/pdf.js`:

a. Above `generatePdfNative` (~line 139) add:

```js
// One native export at a time: the PreviewPdfPath temp slot in Rust is a
// single slot, so a bridge export racing a user export would clobber it.
let nativeExportInFlight = false;
```

b. Change the signature `async function generatePdfNative(_resumeEl, _filename) {` to:

```js
async function generatePdfNative(_resumeEl, _filename, variantId = null) {
```

and make its first statement:

```js
  if (nativeExportInFlight) {
    throw new Error('another PDF export is in progress — try again in a moment');
  }
  nativeExportInFlight = true;
```

Wrap the REST of the existing function body in a NEW outer `try { ... } finally { nativeExportInFlight = false; }`. The existing inner `finally` (listener cleanup + window close) is NOT sufficient: the `appStorage.flush()` durability throw and the `listen()` calls happen before it, and a throw there would strand the guard `true` forever. The re-entrancy throw stays above the guard-set so a rejected caller never releases the active export's guard.

c. In the `new WebviewWindow(PRINT_LABEL, { url: '/print.html', ... })` options, change the `url` line to:

```js
      url: variantId ? `/print.html?variant=${encodeURIComponent(variantId)}` : '/print.html',
```

d. At the end of the file add the bridge entry point:

```js
/**
 * Headless variant export for the companion-extension bridge: render the
 * given variant in the hidden print window, capture, and return the PDF as
 * base64. Uses the same temp-slot flow as the interactive export (guarded by
 * nativeExportInFlight) and always cleans the slot up.
 */
export async function exportVariantPdfBase64(variantId) {
  await generatePdfNative(null, null, variantId);
  try {
    const base64 = await readPdfPreview();
    if (!base64) throw new Error('could not read the generated PDF');
    return base64;
  } finally {
    await discardPdfPreview();
  }
}
```

- [ ] **Step 3: Lint + suite (regression check)**

Run: `npm run lint && npm run test`
Expected: clean — pagination/renderer suites unaffected.

- [ ] **Step 4: Verify both export paths in the dev app**

Run `npm run tauri:dev`:

a. Interactive path regression: click Download PDF in the app — preview appears, cancel it. (The guard + param must not break the normal flow.)

b. Bridge path:

```bash
B=http://127.0.0.1:17872
TOKEN=$(cat ~/Library/Application\ Support/com.resumedesigner.app/storage/resume-designer-bridge-token)
ID=$(curl -s -H "Authorization: Bearer $TOKEN" $B/resumes | python3 -c 'import sys,json;print(json.load(sys.stdin)["resumes"][0]["id"])')
curl -s -H "Authorization: Bearer $TOKEN" $B/resumes/$ID/pdf \
  | python3 -c 'import sys,json,base64;d=json.load(sys.stdin);open("/tmp/bridge-test.pdf","wb").write(base64.b64decode(d["pdfBase64"]));print(d["filename"])'
open /tmp/bridge-test.pdf
```

Expected: the PDF opens and shows the correct variant (pick a non-current variant id to prove the override works). Also request a bogus id — expect 404 — and fire two PDF requests concurrently — expect one 200 and one 500 "in progress". Quit the dev app.

- [ ] **Step 5: Commit**

```bash
git add src/main.js src/pdf.js
git commit -m "feat(bridge): headless per-variant pdf export endpoint"
```

---

### Task 9: Settings UI — show the bridge address + pairing token

**Files:**
- Modify: `resume-designer/src/components/SettingsDialog.jsx` (Data tab, after the legacy-Electron import block, ~line 476)

**Interfaces:**
- Consumes: `getBridgeToken()` from `src/bridge.js` (Task 7); existing `SectionHeader`, `Input`, `Button`, `Eye`/`EyeOff` imports in the file (add any of these that aren't already imported, from the same modules the file already uses).
- Produces: user-visible pairing info — the extension plan (plan 2) tells the user to copy the token from here.

- [ ] **Step 1: Add state + import**

In `SettingsDialog.jsx` add to the imports:

```js
import { getBridgeToken } from '../bridge.js';
```

(match the file's existing relative-import style — if siblings are imported as `'../persistence.js'`, this is consistent). In the component body, next to the existing `showKey` state, add:

```js
  const [showBridgeToken, setShowBridgeToken] = useState(false);
  const [copiedBridgeToken, setCopiedBridgeToken] = useState(false);
```

- [ ] **Step 2: Add the section**

Inside the Data tab (`{tab === 'data' && ( <section> ... )}`), directly after the closing of the `isTauri && (... legacy import ...)` block, add:

```jsx
                {isTauri && (
                  <div className="mt-6">
                    <SectionHeader
                      title="Companion extension"
                      description="The browser extension pairs with the app at this address using this token. Treat the token like a password."
                    />
                    <div className="flex items-center gap-2">
                      <Input readOnly value="http://127.0.0.1:17872" className="w-52 shrink-0 font-mono text-xs" />
                      <Input
                        readOnly
                        type={showBridgeToken ? 'text' : 'password'}
                        value={getBridgeToken()}
                        className="font-mono text-xs"
                        aria-label="Bridge pairing token"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        title="Show/hide token"
                        aria-label="Show/hide token"
                        onClick={() => setShowBridgeToken((v) => !v)}
                      >
                        {showBridgeToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={async () => {
                          await navigator.clipboard.writeText(getBridgeToken());
                          setCopiedBridgeToken(true);
                          setTimeout(() => setCopiedBridgeToken(false), 1500);
                        }}
                      >
                        {copiedBridgeToken ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>
                )}
```

Use the REAL shadcn primitives already in `src/components/ui/` via the file's existing imports — do not hand-roll lookalikes.

- [ ] **Step 3: Verify visually**

Run `npm run tauri:dev` → Settings → Data tab. Expected: the section renders under the legacy-import block; the token field shows dots, the eye toggles it, Copy puts the exact on-disk token (compare with `cat ~/Library/Application\ Support/com.resumedesigner.app/storage/resume-designer-bridge-token`) on the clipboard and flips to "Copied" briefly. Also confirm the section does NOT appear in browser dev (`npm run dev` — no `isTauri`).

- [ ] **Step 4: Lint + commit**

Run: `npm run lint` — clean.

```bash
git add src/components/SettingsDialog.jsx
git commit -m "feat(bridge): pairing token section in settings data tab"
```

---

### Task 10: Bridge API reference doc + final verification sweep

**Files:**
- Create: `docs/bridge-api.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the endpoint reference the extension plan (plan 2) builds against.

- [ ] **Step 1: Write `docs/bridge-api.md`**

Document, from the code as built (correct any drift against Tasks 6–8 rather than copying this plan blindly): base URL `http://127.0.0.1:17872`; auth header `Authorization: Bearer <token>` (token in Settings → Data → Companion extension; only `/health` is public); one section per endpoint with method, path, request body, response body, and error statuses (`401`, `400`, `404`, `500`, `502` AI upstream, `504` app-not-answering, `413` body cap); the request/response examples from Task 7 Step 4 and Task 8 Step 4 as curl transcripts; a "Design notes" section stating the single-writer rationale (all traffic round-trips through the running app's JS) and the one-export-at-a-time PDF constraint.

- [ ] **Step 2: Full verification sweep**

```bash
npm run lint && npm run test        # from resume-designer/  -> clean, all suites pass
cargo test && cargo check           # from resume-designer/src-tauri/ -> bridge tests pass
```

Then one full curl pass against `npm run tauri:dev` covering: health, 401, resumes list, resume detail, PDF (opens correctly), ai/complete, applications (record visible in the library UI, then deleted), profile/answers (answer survives an app restart). This is the acceptance gate for the plan.

- [ ] **Step 3: Commit**

```bash
git add docs/bridge-api.md
git commit -m "docs(bridge): endpoint reference for the companion extension"
```

---

## Out of scope for this plan

The Chrome extension itself (`extension/`: manifest, side panel, content-script scanner, fill engine, AI prompt + eval fixtures) is **plan 2**, written after this bridge lands so it can build against real endpoint behavior documented in `docs/bridge-api.md`.
