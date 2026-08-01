# Bridge API reference

The **companion bridge** is a loopback HTTP server the On Paper desktop
app runs so a browser companion extension can read your resumes, ask the app's
AI to draft answers, export PDFs, and record job applications — all against the
one running app instance, with no separate account or cloud service.

This document is the authoritative endpoint reference. It is written from the
code as built:

- Routing, statuses, validation — `resume-designer/src/bridgeRoutes.js`
- Token / dependency wiring — `resume-designer/src/bridge.js`
- Loopback server, port, body cap, timeouts — `resume-designer/src-tauri/src/commands/bridge.rs`

## Base URL

```
http://127.0.0.1:17872
```

The server binds `127.0.0.1` only — it is never reachable off the machine. The
port (`17872`) is fixed. If the port is already in use the bridge does not
start (it logs and gives up); the app itself is unaffected.

## Authentication

Every endpoint **except `GET /health`** requires a bearer token:

```
Authorization: Bearer <token>
```

The token is a per-install random UUID. Find it in the app under **Settings →
Data → Companion extension** (the address and token are shown there; the token
is masked behind a show/hide toggle and has a copy button). Treat it like a
password — anyone with the token and local machine access can drive the app.

The token is part of the backup-owned keyspace, so **full backups include it**:
restoring a backup on the same machine keeps existing pairings working without
re-pairing. That is safe to leave in the backup file — the server is
loopback-only, so the token is useless off the machine. The flip side: after
**replace-importing** a backup taken on a different install, the app's token is
different from the one your extension paired with, so the extension must be
re-paired (copy the new token from Settings).

A missing or wrong token on any authenticated route returns:

```
HTTP 401
{"error":"invalid or missing bearer token"}
```

## Conventions

- All request and response bodies are JSON. Responses always carry
  `Content-Type: application/json`.
- `POST` bodies must be valid JSON. A malformed body returns
  `400 {"error":"invalid JSON body"}`.
- Request bodies must be valid UTF-8. A body that can't be read as UTF-8 text
  returns `400 {"error":"unreadable request body"}` (enforced in Rust before
  the request reaches the router).
- Request bodies are capped at **1 MiB**. A larger body returns
  `413 {"error":"request body too large"}` (enforced in Rust before the request
  reaches the router).
- Because every request round-trips through the running app's JavaScript (see
  [Design notes](#design-notes)), the app must be **running and unlocked**. If
  the webview does not answer in time the server returns
  `504 {"error":"the app did not answer in time — is On Paper running and unlocked?"}`.
  Timeouts: **180 s** for `/ai/*` and any `…/pdf` path (model latency / PDF
  render), **30 s** for everything else.
- If the app window is unavailable to receive the request at all, the server
  returns `502 {"error":"app window unavailable"}`.
- If the server's internal request-tracking state is unusable (a poisoned lock
  after a panic — should not happen in practice), it returns
  `500 {"error":"bridge state lock poisoned"}`.

### Status codes at a glance

| Status | Meaning |
| ------ | ------- |
| `200`  | OK (GET routes, `POST /ai/complete`) |
| `201`  | Created (`POST /applications`, `POST /profile/answers`) |
| `400`  | Invalid JSON body, non-UTF-8 request body, or request-body validation failed |
| `401`  | Missing/invalid bearer token |
| `404`  | Unknown resume id, or unknown route |
| `413`  | Request body exceeds 1 MiB |
| `500`  | Unhandled error inside the router (e.g. PDF export failed), or the Rust-side bridge state lock is poisoned |
| `502`  | AI upstream failed (`/ai/complete`), or app window unavailable |
| `504`  | The app did not answer within the timeout |

---

## Endpoints

In the examples below, `$TOKEN` is the pairing token from Settings.

### `GET /health`

Liveness probe. **Public** — the only route that does not require a token. Use
it to confirm the bridge is up and to read the app version.

**Response** `200`

```json
{"ok":true,"app":"resume-designer","version":"1.0.0"}
```

```bash
curl -s http://127.0.0.1:17872/health
```

---

### `GET /resumes`

List every resume variant, newest first (sorted by `updatedAt` descending).

**Response** `200`

```json
{
  "resumes": [
    {"id":"custom-1770251688327","name":"Backend Engineer - Acme Corp","updatedAt":"2026-07-15T22:21:02.749Z"},
    {"id":"custom-1770248233098","name":"Frontend Engineer - Globex","updatedAt":"2026-07-04T02:41:46.505Z"}
  ]
}
```

Each entry is a lightweight summary — `id`, `name`, `updatedAt` only. Fetch the
full document with `GET /resumes/:id`.

```bash
curl -s http://127.0.0.1:17872/resumes \
  -H "Authorization: Bearer $TOKEN"
```

**Errors:** `401`.

---

### `GET /resumes/:id`

Full detail for one resume variant, plus the user's shared profile and learned
answers (returned alongside so the extension can fill forms in one round-trip).

**Response** `200`

```json
{
  "id": "custom-1770251688327",
  "name": "Backend Engineer - Acme Corp",
  "updatedAt": "2026-07-15T22:21:02.749Z",
  "data": { "name": "Jane Q. Applicant", "tagline": "…", "summary": "…", "contact": {}, "experience": [] },
  "profile": { },
  "learnedAnswers": []
}
```

- `data` — the full resume document for this variant.
- `profile` — the user's shared profile (`getUserProfile()`), independent of the
  variant.
- `learnedAnswers` — every saved question/answer pair (see
  `POST /profile/answers`).

```bash
curl -s http://127.0.0.1:17872/resumes/custom-1770251688327 \
  -H "Authorization: Bearer $TOKEN"
```

**Errors:** `401`; `404 {"error":"no resume with id <id>"}` if the id is
unknown. Note: ids are matched by **own key only** — inherited object keys such
as `__proto__` or `constructor` do not resolve and return `404`.

---

### `GET /resumes/:id/pdf`

Render the given variant to a vector PDF and return it base64-encoded. The
render happens headlessly in a hidden print window against that specific variant
(not the currently-open one).

**Response** `200`

```json
{"filename":"Backend-Engineer---Acme-Corp.pdf","pdfBase64":"JVBERi0…"}
```

- `filename` — derived from the variant name: trimmed, characters outside
  letters/numbers/`_ . -`/space stripped, spaces collapsed to `-`, then
  `.pdf`. Empty names fall back to `Resume.pdf`.
- `pdfBase64` — the PDF bytes, base64-encoded. Decode to get a valid PDF.

```bash
curl -s http://127.0.0.1:17872/resumes/custom-1770251688327/pdf \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json,base64; open('out.pdf','wb').write(base64.b64decode(json.load(sys.stdin)['pdfBase64']))"
file out.pdf   # PDF document, version 1.5, N pages
```

**Errors:** `401`; `404 {"error":"no resume with id <id>"}`; `500` if the export
fails, including when another export is already running —
`{"error":"another PDF export is in progress — try again in a moment"}` (see
[one export at a time](#one-export-at-a-time)); `504` if the render exceeds
180 s.

---

### `POST /ai/complete`

Run a one-shot completion through the app's configured AI (OpenRouter model set
in Settings). No resume context is injected — the caller supplies the full
message list.

**Request**

```json
{
  "messages": [{"role":"user","content":"Reply with exactly: bridge-ok"}],
  "systemPrompt": "optional system prompt",
  "reasoningEffort": "none | low | medium | high (optional)"
}
```

- `messages` (required) — non-empty array of `{role, content}`, both strings.
- `systemPrompt` (optional) — sent as the system message; when omitted, the
  app's default assistant system prompt is used.
- `reasoningEffort` (optional) — forwarded to the model.

**Response** `200`

```json
{"text":"bridge-ok"}
```

```bash
curl -s http://127.0.0.1:17872/ai/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: bridge-ok"}]}'
```

**Errors:** `401`; `400 {"error":"invalid JSON body"}` (malformed body) or
`400 {"error":"messages must be a non-empty array of {role, content}"}`
(validation); `502 {"error":"<upstream message>"}` if the AI request fails
(e.g. no API key configured, or the model call errors); `504` if the model does
not respond within 180 s.

---

### `POST /applications`

Record a job application against a variant. Appears in the app's application
tracker (Library) immediately.

**Request**

```json
{
  "variantId": "custom-1770251688327",
  "company": "Curl Test Co",
  "title": "Engineer",
  "notes": "optional"
}
```

- `variantId` (required) — must be a known resume id.
- `company`, `title`, `notes` (optional) — strings; default to `""`.

**Response** `201`

```json
{
  "application": {
    "id": "app-1784154104644-1cp6lfpmnvati",
    "variantId": "custom-1770251688327",
    "variantName": "Backend Engineer - Acme Corp",
    "jobId": null,
    "jobSnapshot": {"title":"Engineer","company":"Curl Test Co"},
    "status": "applied",
    "statusHistory": [{"status":"applied","at":"2026-07-15T22:21:44.644Z"}],
    "createdAt": "2026-07-15T22:21:44.644Z",
    "updatedAt": "2026-07-15T22:21:44.644Z",
    "appliedAt": "2026-07-15T22:21:44.644Z",
    "notes": ""
  }
}
```

The record is always created with `status: "applied"`. `variantName` is filled
in from the resolved variant.

```bash
curl -s http://127.0.0.1:17872/applications \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variantId":"custom-1770251688327","company":"Curl Test Co","title":"Engineer"}'
```

**Errors:** `401`; `400 {"error":"invalid JSON body"}` or
`400 {"error":"variantId is required"}`; `404 {"error":"no resume with id <id>"}`
if `variantId` is unknown.

---

### `POST /profile/answers`

Save a learned question/answer pair (notice period, work authorization, etc.) to
the shared profile. Upserts by a normalized form of the question, so re-saving
the same question updates the existing answer. Returned by every
`GET /resumes/:id` in `learnedAnswers`.

**Request**

```json
{"question":"Notice period?","answer":"4 weeks"}
```

- `question` (required) — non-empty after trimming.
- `answer` (required) — non-empty after trimming.

**Response** `201`

```json
{
  "answer": {
    "id": "ans-1784154104633-m1g5ig13wib5q",
    "question": "Notice period?",
    "normalized": "notice period",
    "answer": "4 weeks",
    "createdAt": "2026-07-15T22:21:44.633Z",
    "updatedAt": "2026-07-15T22:21:44.633Z"
  }
}
```

```bash
curl -s http://127.0.0.1:17872/profile/answers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"Notice period?","answer":"4 weeks"}'
```

**Errors:** `401`; `400 {"error":"invalid JSON body"}` or
`400 {"error":"question and answer are required"}`.

---

### Unknown routes

Any authenticated request that matches no route returns:

```
HTTP 404
{"error":"no route: <METHOD> <path>"}
```

---

## Design notes

### Single writer — everything round-trips through the app's JS

The Rust loopback server is deliberately a **dumb pipe**. It reads the request,
forwards it to the main webview as a `bridge:request` event, and blocks on a
per-request channel until the app's JavaScript answers via the `bridge_respond`
command. All reads and writes — resumes, profile, applications, learned answers,
PDF export — go through the running app's own JS modules (`persistence.js`,
`applications.js`, `learnedAnswers.js`, `aiService.js`, `pdf.js`).

This preserves `appStorage`'s **single-writer contract**: the running app is the
only process that touches the on-disk store. The bridge never reads or writes
storage files directly, so there is no cache-coherence risk between the bridge
and the live app, and no way for a companion request to corrupt state the app
has in memory. The cost is that the app must be running and unlocked to answer —
hence the `504` when the webview is silent and the `502` when the window is
unavailable.

### One PDF export at a time

PDF export drives a single hidden print window through a single-occupancy native
temp slot. The export path is guarded so only one export runs at a time: a
second concurrent `GET /resumes/:id/pdf` fails fast with
`500 {"error":"another PDF export is in progress — try again in a moment"}`
rather than corrupting the in-flight render. The guard is released on every exit
path (success or failure), so a failed export never permanently blocks future
ones. Callers should serialize PDF requests, or retry on that specific error.
