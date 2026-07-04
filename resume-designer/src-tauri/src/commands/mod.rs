use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// Server-side single-slot binding between `pick_pdf_save_path` and
/// `capture_pdf_from_window`. The picker stores the user-chosen path here;
/// the capture command takes it back out and writes the PDF to that path.
///
/// This means the renderer can NEVER supply a save path directly — even a
/// compromised/injected script can only write the PDF to a path the user
/// just confirmed via the native save dialog.
#[derive(Default)]
pub struct PendingPdfPath(pub Mutex<Option<PathBuf>>);

/// Server-side slot for the just-generated PREVIEW PDF — a temp file the user
/// has not saved yet. `capture_pdf_from_window` writes here; `read_pdf_preview`
/// streams it to the renderer for display; `save_pdf_preview` copies it to the
/// user-confirmed `PendingPdfPath`; `discard_pdf_preview` deletes it on cancel.
#[derive(Default)]
pub struct PreviewPdfPath(pub Mutex<Option<PathBuf>>);

#[cfg(target_os = "macos")]
mod pdf_macos;
#[cfg(target_os = "windows")]
mod pdf_windows;
// Shared per-sheet → multi-page PDF merge (pure lopdf) for both desktop captures.
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod pdf_merge;

// `pub` so `generate_handler!` in lib.rs can name the commands as
// `commands::migration::probe_legacy_electron_data`. The macro
// references compiler-generated helper items that sit next to the
// command function, so a plain `pub use` re-export wouldn't be enough.
pub mod migration;

// Per-key disk storage backing the renderer's persistence (replaces
// webview localStorage). Not platform-gated: every build needs it.
pub mod storage;

// Desktop-only: runtime update-channel selection (stable/beta) for the updater.
// `tauri-plugin-updater` is itself a cfg(desktop) dependency.
#[cfg(desktop)]
pub mod updater;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

/// A region of the web view to capture, in CSS pixel coordinates relative to
/// that web view's document. In the new background-window flow this is
/// measured by the print window's own JS against its own `getBoundingClientRect()`,
/// so origin is always (0, 0) in practice — but the field stays for flexibility.
///
/// `#[allow(dead_code)]` because the Windows path uses `page_size` instead and
/// discards this struct via `let _ = capture_rect`, which fires an unused-fields
/// lint on that target build.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PdfResult {
    pub fn canceled() -> Self {
        Self {
            success: false,
            canceled: Some(true),
            ..Default::default()
        }
    }

    pub fn success(path: String) -> Self {
        Self {
            success: true,
            file_path: Some(path),
            ..Default::default()
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(message.into()),
            ..Default::default()
        }
    }
}

/// Show a save-file dialog and stash the chosen path in `PendingPdfPath` for
/// the subsequent `capture_pdf_from_window` call to consume. Returns the path
/// as a string for renderer-side logging/UX only — the renderer never feeds
/// this back into the capture command.
///
/// Separated from the capture step so the renderer can spawn its hidden print
/// window only AFTER the user has picked a path — keeping the main window
/// unchanged during the (possibly long) dialog interaction.
#[tauri::command]
pub async fn pick_pdf_save_path(
    window: WebviewWindow,
    default_name: Option<String>,
    pending: State<'_, PendingPdfPath>,
) -> Result<Option<String>, String> {
    // Invalidate any prior unconsumed path BEFORE we show the dialog. If a
    // previous export armed the slot but never reached capture (cancelled,
    // errored, app killed mid-flight), that path must not leak into a later
    // capture call without a fresh user confirmation. Doing this up-front
    // also covers the dialog-cancel branch below for free.
    {
        let mut slot = pending
            .0
            .lock()
            .map_err(|_| "PDF save-path slot lock poisoned".to_string())?;
        *slot = None;
    }

    let default_name = default_name.unwrap_or_else(|| "Resume.pdf".to_string());
    let (tx, rx) = oneshot::channel::<Option<PathBuf>>();
    window
        .dialog()
        .file()
        .add_filter("PDF Documents", &["pdf"])
        .set_file_name(&default_name)
        .save_file(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });
    match rx.await {
        Ok(Some(p)) => {
            let mut slot = pending
                .0
                .lock()
                .map_err(|_| "PDF save-path slot lock poisoned".to_string())?;
            *slot = Some(p.clone());
            Ok(Some(p.to_string_lossy().into_owned()))
        }
        // Slot already cleared above — no further bookkeeping needed.
        _ => Ok(None),
    }
}

/// Capture a PDF from a target window's web view (identified by label) into a
/// TEMP file, and stash that path in `PreviewPdfPath`. The target is typically a
/// hidden Tauri window the renderer just spawned at `/print.html`, which renders
/// only the resume and signals readiness via a `print-ready` event before this
/// is invoked.
///
/// The renderer never chooses where the file lands: this writes to a temp path,
/// the renderer reads it back via `read_pdf_preview` to show a preview, and
/// `save_pdf_preview` copies it to the path the native picker confirmed.
#[tauri::command]
#[allow(unused_variables)]
pub async fn capture_pdf_from_window(
    app: AppHandle,
    window_label: String,
    page_size: Option<PageSize>,
    capture_rect: Option<CaptureRect>,
    capture_rects: Option<Vec<CaptureRect>>,
    preview: State<'_, PreviewPdfPath>,
) -> Result<PdfResult, String> {
    // Generate to a temp file the user previews before choosing where to save.
    // Unique per export (pid + nanos) so overlapping exports never collide.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_path = std::env::temp_dir().join(format!(
        "resume-designer-preview-{}-{}.pdf",
        std::process::id(),
        nanos
    ));
    let save_path = temp_path.to_string_lossy().into_owned();

    let target = match app.get_webview_window(&window_label) {
        Some(w) => w,
        None => {
            return Ok(PdfResult::error(format!(
                "No webview window with label '{}'",
                window_label
            )))
        }
    };

    #[cfg(target_os = "macos")]
    let result = {
        let _ = page_size;
        // Prefer the per-sheet rects (one PDF page each, merged + scaled). Fall
        // back to the single whole-view rect for older callers / the empty case.
        let rects = capture_rects
            .filter(|v| !v.is_empty())
            .or_else(|| capture_rect.clone().map(|r| vec![r]))
            .unwrap_or_default();
        pdf_macos::capture_pdf(target, save_path, rects).await
    };
    #[cfg(target_os = "windows")]
    let result = {
        let _ = page_size;
        // Per-sheet capture (mirror macOS): one PDF page per `.resume-page` sheet,
        // each printed at its own size, so an oversized `.is-overflowing` sheet on
        // ANY page exports at its true height instead of being split against the
        // first sheet's size (which mis-paginated multi-page resumes). Fall back to
        // the single whole-view rect for the empty / older-caller case.
        let rects = capture_rects
            .filter(|v| !v.is_empty())
            .or_else(|| capture_rect.clone().map(|r| vec![r]))
            .unwrap_or_default();
        pdf_windows::capture_pdf(target, save_path, rects).await
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = {
        let _ = (target, save_path, capture_rect, capture_rects);
        PdfResult::error("PDF export is not supported on this platform")
    };

    // Stash the temp path so read/save/discard can find it; clean up on failure.
    if result.success {
        if let Ok(mut slot) = preview.0.lock() {
            *slot = Some(temp_path);
        }
    } else {
        let _ = std::fs::remove_file(&temp_path);
    }
    Ok(result)
}

/// Read the just-generated preview PDF as base64 so the renderer can show it in
/// an `<iframe>` before the user saves. Read-only — never writes.
#[tauri::command]
pub async fn read_pdf_preview(preview: State<'_, PreviewPdfPath>) -> Result<String, String> {
    let path = {
        let slot = preview
            .0
            .lock()
            .map_err(|_| "preview slot lock poisoned".to_string())?;
        slot.clone()
    };
    let path = path.ok_or_else(|| "No preview PDF available".to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read preview PDF: {}", e))?;
    Ok(STANDARD.encode(bytes))
}

/// Copy the preview temp PDF to the user-confirmed path (from `pick_pdf_save_path`),
/// then delete the temp. The renderer supplies neither the bytes nor the path.
#[tauri::command]
pub async fn save_pdf_preview(
    pending: State<'_, PendingPdfPath>,
    preview: State<'_, PreviewPdfPath>,
) -> Result<PdfResult, String> {
    let dest = {
        let mut slot = pending
            .0
            .lock()
            .map_err(|_| "PDF save-path slot lock poisoned".to_string())?;
        slot.take()
    };
    let dest = match dest {
        Some(p) => p,
        None => {
            return Ok(PdfResult::error(
                "No pending PDF save path. Call pick_pdf_save_path first.",
            ))
        }
    };
    let src = {
        let slot = preview
            .0
            .lock()
            .map_err(|_| "preview slot lock poisoned".to_string())?;
        slot.clone()
    };
    let src = match src {
        Some(p) => p,
        None => return Ok(PdfResult::error("No preview PDF to save.")),
    };
    match std::fs::copy(&src, &dest) {
        Ok(_) => {
            if let Ok(mut slot) = preview.0.lock() {
                *slot = None;
            }
            let _ = std::fs::remove_file(&src);
            Ok(PdfResult::success(dest.to_string_lossy().into_owned()))
        }
        Err(e) => Ok(PdfResult::error(format!("Failed to save PDF file: {}", e))),
    }
}

/// Delete the preview temp PDF when the user cancels. Best-effort.
#[tauri::command]
pub async fn discard_pdf_preview(preview: State<'_, PreviewPdfPath>) -> Result<(), String> {
    let path = {
        let mut slot = preview
            .0
            .lock()
            .map_err(|_| "preview slot lock poisoned".to_string())?;
        slot.take()
    };
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Indicates whether a save_path was returned. Returns `None` on cancellation.
/// Kept here so the renderer can use a single PdfResult shape in the success
/// path without inventing a parallel "user cancelled" type.
#[allow(dead_code)]
pub fn canceled_result() -> PdfResult {
    PdfResult::canceled()
}
