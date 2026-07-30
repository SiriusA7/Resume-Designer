//! One-time auto-migration from the legacy Electron build's Chromium
//! `localStorage` (stored as a LevelDB under the OS user-data dir) into
//! the current Tauri WebView's `localStorage`.
//!
//! Why this module exists: when the Tauri build replaces the Electron
//! one in-place, the new app's WebView (WKWebView on macOS, WebView2 on
//! Windows) reads/writes its own localStorage backend at a different
//! filesystem location than Electron's Chromium did. Same JS calls,
//! different physical store — the old data is "stranded" until we bridge
//! it. Renderer calls `probe_legacy_electron_data` at boot; if it
//! reports `found: true` and the current store is empty, it then calls
//! `import_legacy_electron_data` and writes the returned keys into its
//! own localStorage via the existing in-app backup-restore code path.
//!
//! Safety:
//! - The source LevelDB is copied to a temp directory and only the
//!   copy is opened. The rusty-leveldb crate opens read-write by
//!   default — operating on the copy means we never touch the originals
//!   even if the open path were to write recovery logs.
//! - Both commands are pure reads on the renderer side: they only
//!   return data; the renderer decides whether to apply it.
//! - The renderer is responsible for setting a "migration attempted"
//!   flag in its localStorage so this code never runs twice.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusty_leveldb::{LdbIterator, Options, DB};
use serde::Serialize;

// ---------- Chromium LevelDB localStorage encoding ----------
//
// Per-origin key format: `_<origin>\x00\x01<storage_key>`
// For Electron-packaged apps loading via loadFile(), `<origin>` is
// `file://`. The two-byte `\x00\x01` separator was empirically confirmed
// by inspecting the user's actual LevelDB; the single-`\x00` variant
// that some older docs describe doesn't appear in current Chromium /
// Electron builds.
const ORIGIN_PREFIX: &[u8] = b"_file://\x00\x01";

// Value format: [encoding_tag_byte][bytes...]
//   tag 0x00 = UTF-16LE
//   tag 0x01 = Latin1 / ISO-8859-1
// Chromium picks whichever encoding is smaller per-value.
const TAG_UTF16LE: u8 = 0x00;
const TAG_LATIN1: u8 = 0x01;

// ---------- App-owned localStorage keys ----------
//
// Listed explicitly so unrelated keys (e.g. `devtools://` entries from
// Chromium's own devtools instance) can't slip into our backup.
//
// FROZEN — DO NOT RENAME OR "KEEP IN SYNC" WITH THE FRONTEND.
//
// These strings are historical facts about a *shipped Electron app's*
// LevelDB that already exists on users' disks; they are not configuration.
// Nothing we ship from now on can change what that database was written
// with. An earlier version of this comment told you to keep the list in
// sync with the frontend's owned-key list — that instruction is wrong and
// actively dangerous: renaming these would make `is_app_key` match nothing,
// `find_existing` return None, and the probe report "Found 0 keys" for a
// database full of the user's resumes.
//
// Adding a *new* app-owned key to the frontend requires no change here —
// the Electron app never wrote it.
const FIXED_KEYS: &[&str] = &[
    "resume-designer-data",
    "resume-designer-job-descriptions",
    "resume-designer-chat-threads",
    "resume-designer-chat-history",
    "resume-designer-token-usage",
    "resume-designer-theme",
    "resume-designer-onboarding-complete",
    "resume-edit-hint-dismissed",
    "resume-header-style",
    "resume-accent-settings",
    "resume-font-settings",
    "resume-spacing-settings",
    "resume-photo-settings",
    "resume-zoom",
];
const HISTORY_PREFIX: &str = "resume-designer-history-";

fn is_app_key(k: &str) -> bool {
    FIXED_KEYS.contains(&k) || k.starts_with(HISTORY_PREFIX)
}

// ---------- Path lookup ----------
//
// Electron's userData dir defaults follow `app.getPath('userData')`,
// which is `<config-base>/<productName>` where `<config-base>` is:
//   macOS:   $HOME/Library/Application Support
//   Windows: %APPDATA%  (Roaming)
//   Linux:   $XDG_CONFIG_HOME or $HOME/.config
//
// `dirs::config_dir()` already returns exactly that base on every
// platform AND honors $XDG_CONFIG_HOME on Linux — we use it directly
// rather than constructing platform-specific paths by hand (which is
// how the previous implementation silently missed Linux users with a
// non-default $XDG_CONFIG_HOME).
//
// We check both productName variants because the lowercase-hyphenated
// one matched the on-disk reality for this app, while the
// capital-spaced one is what Electron would write if `productName`
// were set to the app's display name.
fn candidate_paths() -> Vec<PathBuf> {
    let Some(base) = dirs::config_dir() else {
        return Vec::new();
    };
    let suffix = Path::new("Local Storage").join("leveldb");
    vec![
        base.join("resume-designer").join(&suffix),
        base.join("Resume Designer").join(&suffix),
    ]
}

fn find_existing() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|p| p.is_dir())
}

// ---------- Decoding ----------

fn decode_value(buf: &[u8]) -> Option<String> {
    let (tag, body) = buf.split_first()?;
    match *tag {
        TAG_UTF16LE => {
            // UTF-16LE: pairs of bytes -> u16 code units.
            if body.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16(&units).ok()
        }
        TAG_LATIN1 => {
            // Latin1: each byte maps 1:1 to U+0000..U+00FF.
            Some(body.iter().map(|&b| b as char).collect())
        }
        _ => None,
    }
}

// ---------- Filesystem helpers ----------

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if ft.is_file() {
            fs::copy(&src_path, &dst_path)?;
        }
        // Skip symlinks / other types — shouldn't appear in a LevelDB.
    }
    Ok(())
}

/// Owned tempdir cleanup guard. Drops the directory recursively when
/// it goes out of scope, regardless of how `extract_keys` exits.
struct ScopedTempDir(PathBuf);
impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn make_temp_dir() -> io::Result<ScopedTempDir> {
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("rd-migration-{pid}-{nanos}"));
    fs::create_dir_all(&path)?;
    Ok(ScopedTempDir(path))
}

// ---------- Core extraction ----------

fn extract_keys(source_leveldb: &Path) -> Result<BTreeMap<String, String>, String> {
    // Copy to a tempdir so rusty-leveldb (which opens read-write) can't
    // mutate the source LevelDB. The guard cleans up on Drop.
    let temp = make_temp_dir().map_err(|e| format!("tempdir create failed: {e}"))?;
    let staged = temp.0.join("leveldb");
    copy_dir_recursive(source_leveldb, &staged)
        .map_err(|e| format!("copy to tempdir failed: {e}"))?;

    // Remove LOCK if Electron left one behind from an unclean exit.
    let lock = staged.join("LOCK");
    if lock.exists() {
        let _ = fs::remove_file(&lock);
    }

    let opts = Options { create_if_missing: false, ..Default::default() };

    let mut db = DB::open(&staged, opts).map_err(|e| format!("leveldb open failed: {e}"))?;
    let mut iter = db
        .new_iter()
        .map_err(|e| format!("leveldb iterator failed: {e}"))?;

    let mut out: BTreeMap<String, String> = BTreeMap::new();
    while let Some((key_buf, val_buf)) = iter.next() {
        if !key_buf.starts_with(ORIGIN_PREFIX) {
            continue;
        }
        let storage_key_bytes = &key_buf[ORIGIN_PREFIX.len()..];
        let Ok(storage_key) = std::str::from_utf8(storage_key_bytes) else {
            continue;
        };
        if !is_app_key(storage_key) {
            continue;
        }
        if let Some(value) = decode_value(&val_buf) {
            out.insert(storage_key.to_string(), value);
        }
    }
    Ok(out)
}

// ---------- Probe-only summary ----------
//
// Returned by `probe_legacy_electron_data`. `found: true` iff we located
// a LevelDB AND it contained at least one app key. The counts let the
// renderer build the success toast without re-parsing the envelope.

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub found: bool,
    pub source_path: Option<String>,
    pub key_count: u32,
    pub variant_count: u32,
    pub job_description_count: u32,
    pub user_profile_present: bool,
}

fn summarize(map: &BTreeMap<String, String>, src: &Path) -> ProbeResult {
    let data_json: Option<serde_json::Value> = map
        .get("resume-designer-data")
        .and_then(|s| serde_json::from_str(s).ok());

    let variant_count = data_json
        .as_ref()
        .and_then(|v| v.get("variants"))
        .and_then(|v| v.as_object().map(|o| o.len() as u32))
        .unwrap_or(0);

    let user_profile_present = data_json
        .as_ref()
        .and_then(|v| v.get("userProfile"))
        .map(|v| !v.is_null())
        .unwrap_or(false);

    let job_description_count = map
        .get("resume-designer-job-descriptions")
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| match &v {
            serde_json::Value::Array(a) => Some(a.len() as u32),
            serde_json::Value::Object(o) => Some(o.len() as u32),
            _ => None,
        })
        .unwrap_or(0);

    ProbeResult {
        found: !map.is_empty(),
        source_path: Some(src.to_string_lossy().into_owned()),
        key_count: map.len() as u32,
        variant_count,
        job_description_count,
        user_profile_present,
    }
}

#[tauri::command]
pub async fn probe_legacy_electron_data() -> ProbeResult {
    let Some(src) = find_existing() else {
        return ProbeResult::default();
    };
    match extract_keys(&src) {
        Ok(map) => summarize(&map, &src),
        Err(_) => ProbeResult {
            // Path exists but extraction failed — surface a path so the
            // renderer can log it, but report not-found so it skips import.
            source_path: Some(src.to_string_lossy().into_owned()),
            ..Default::default()
        },
    }
}

// ---------- Full import ----------
//
// Returns an envelope shaped to match what `importFullBackupFromEnvelope`
// in src/persistence.js consumes:
//   { backupFormat: 1, source: "...", keys: { <storageKey>: <value>, ... } }
//
// `createdAt` is intentionally omitted; the renderer can fill it in
// from `new Date().toISOString()` if it needs to display it.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationEnvelope {
    pub backup_format: u32,
    pub source: String,
    pub keys: BTreeMap<String, String>,
}

#[tauri::command]
pub async fn import_legacy_electron_data() -> Result<MigrationEnvelope, String> {
    let src = find_existing().ok_or_else(|| {
        "No legacy Electron data directory found (already migrated or no prior install).".to_string()
    })?;
    let keys = extract_keys(&src)?;
    if keys.is_empty() {
        return Err(format!(
            "Found LevelDB at {} but it contained no app keys.",
            src.display()
        ));
    }
    Ok(MigrationEnvelope {
        backup_format: 1,
        source: format!("electron-leveldb-auto ({})", src.display()),
        keys,
    })
}
