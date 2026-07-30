//! Runtime-selectable updater channel.
//!
//! The renderer picks a channel (`stable` | `beta`) and we build the updater
//! with that channel's endpoint, so a single installed build can switch
//! channels without reinstalling. The JS `plugin-updater` `check()` cannot
//! override endpoints, so channel selection has to happen here in Rust.
//!
//! Desktop-only: `tauri-plugin-updater` is a `cfg(desktop)` dependency, and
//! `UpdaterExt` only exists there.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

// THESE ARE THE ENDPOINTS THAT SHIP. `plugins.updater.endpoints` in
// tauri.conf.json is inert at runtime — the JS `plugin-updater` check() can't
// override an endpoint, so native.js routes through `check_update_on_channel`,
// which builds its own updater from `endpoints_for()` below. If you change the
// release location, change it HERE (test/updaterEndpoints.test.js enforces that
// the config value tracks this one, so the two can't silently diverge).
//
// Both URLs hardcode the repo slug, and they are compiled into every shipped
// binary — so a repo rename strands the installed base on GitHub's 301 forever.
// See "Preparing for a repo rename" in TAURI.md before touching the slug.
//
// GitHub's `/releases/latest` redirect excludes pre-releases, so stable users
// never see beta builds; the beta channel reads the rolling `next` pre-release.
const STABLE_ENDPOINT: &str =
    "https://github.com/ashproto/Resume-Designer/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/ashproto/Resume-Designer/releases/download/next/latest.json";

// The beta channel is a *superset*: it also reads the stable manifest so a beta
// user still receives a stable release that's newer than the latest pre-release
// (GitHub's `/releases/latest` excludes pre-releases, so the two never overlap).
fn endpoints_for(channel: &str) -> Vec<&'static str> {
    match channel {
        "beta" | "next" => vec![BETA_ENDPOINT, STABLE_ENDPOINT],
        _ => vec![STABLE_ENDPOINT],
    }
}

// `a >= b` by semver. Unparseable versions sort last, so a parseable candidate
// always wins; if neither parses we keep the incumbent (`a`).
fn version_ge(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(va), Ok(vb)) => va >= vb,
        (Ok(_), Err(_)) => true,
        (Err(_), Ok(_)) => false,
        (Err(_), Err(_)) => true,
    }
}

/// Holds the update found by `check_update_on_channel` until
/// `install_pending_update` consumes it. The renderer shows a "download now?"
/// prompt between the two steps, mirroring the documented Tauri updater flow.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// Streamed to the renderer during download so it can render progress. The
/// shape matches the old `plugin-updater` `downloadAndInstall` events
/// (PascalCase `event` tag, camelCase data fields) so the renderer's existing
/// switch handles it unchanged.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// Check a single endpoint's manifest in isolation. Returning a `Result` (rather
/// than letting `?` escape) lets the caller treat a per-endpoint failure as
/// non-fatal and continue to the channel's other endpoint(s).
async fn check_endpoint(app: &AppHandle, endpoint: &str) -> Result<Option<Update>, String> {
    let url = Url::parse(endpoint).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// Check the given channel's endpoint for an update. Stores the result (if any)
/// in `PendingUpdate` and returns lightweight metadata for the renderer.
#[tauri::command]
pub async fn check_update_on_channel(
    app: AppHandle,
    channel: String,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    // Check each of the channel's endpoints independently and keep the
    // highest-version update. (Tauri's multi-endpoint support is first-wins,
    // not max-version, so the superset can't be expressed as a single builder.)
    //
    // A per-endpoint failure is non-fatal: a beta user must still be offered a
    // newer *stable* release even when the rolling `next` manifest is briefly
    // missing/404 (e.g. while the pre-release is being republished). We surface
    // an error only when *no* endpoint could be reached.
    let mut best: Option<Update> = None;
    let mut first_error: Option<String> = None;
    let mut checked_any = false;
    for endpoint in endpoints_for(&channel) {
        match check_endpoint(&app, endpoint).await {
            Ok(found) => {
                checked_any = true;
                if let Some(candidate) = found {
                    best = match best {
                        Some(current) if version_ge(&current.version, &candidate.version) => {
                            Some(current)
                        }
                        _ => Some(candidate),
                    };
                }
            }
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }

    // Every endpoint errored — report the first failure rather than silently
    // masquerading as "up to date".
    if !checked_any {
        return Err(
            first_error.unwrap_or_else(|| "no update endpoint could be checked".to_string())
        );
    }

    let info = best.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });

    *pending
        .0
        .lock()
        .map_err(|_| "pending-update lock poisoned".to_string())? = best;

    Ok(info)
}

/// Download + install the update stashed by `check_update_on_channel`,
/// streaming progress over `on_event`. The renderer triggers the restart
/// afterwards via the process plugin (unchanged from the prior flow).
#[tauri::command]
pub async fn install_pending_update(
    pending: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "pending-update lock poisoned".to_string())?
        .take()
        .ok_or_else(|| "no pending update to install".to_string())?;

    let mut started = false;
    let progress = on_event.clone();
    let finish = on_event.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress.send(DownloadEvent::Started { content_length });
                }
                let _ = progress.send(DownloadEvent::Progress { chunk_length });
            },
            move || {
                let _ = finish.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
