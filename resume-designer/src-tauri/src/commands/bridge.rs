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
                r#"{"error":"the app did not answer in time — is on paper running and unlocked?"}"#,
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
