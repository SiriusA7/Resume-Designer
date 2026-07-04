use std::sync::{Arc, Mutex};

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_foundation::{NSData, NSError, NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::{WKPDFConfiguration, WKWebView};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

use super::{CaptureRect, PdfResult};

/// Shared oneshot slot the WKWebView createPDF completion handler fills exactly
/// once (the sender is taken on first delivery so a duplicate callback can't
/// double-send).
type PdfResultSlot = Arc<Mutex<Option<oneshot::Sender<Result<Vec<u8>, String>>>>>;

// CSS pixels are 1/96 in; PDF points are 1/72 in. WKWebView's createPDF maps
// 1 CSS px -> 1 pt, so an 816px / 8.5in sheet would otherwise be an 11.33in
// page. Scale every captured page by 72/96 to restore its true physical size.
const PX_TO_PT: f64 = 72.0 / 96.0;

/// Capture each rect of `target_window`'s WKWebView as its own PDF page, scale
/// each page to its real physical size, merge them into one document, and write
/// it to `save_path`.
///
/// `rects` are the on-screen `.resume-page` sheets (CSS px, doc-relative to the
/// resume). One rect (continuous) yields a single-page PDF; N rects (a fixed
/// size like Letter/A4) yield an N-page PDF whose pages ARE the on-screen
/// sheets — the screen and the PDF stay byte-for-byte the same layout engine.
pub async fn capture_pdf(
    target_window: WebviewWindow,
    save_path: String,
    rects: Vec<CaptureRect>,
) -> PdfResult {
    if rects.is_empty() {
        return PdfResult::error("No page rects supplied for PDF capture");
    }

    // Capture every sheet. createPDF captures the requested document region in
    // full, even if it extends past the (off-screen) window's viewport.
    let mut pages: Vec<(Vec<u8>, f64, f64)> = Vec::with_capacity(rects.len());
    for rect in &rects {
        match capture_one(&target_window, rect).await {
            Ok(bytes) => pages.push((bytes, rect.width, rect.height)),
            Err(e) => return PdfResult::error(e),
        }
    }

    let merged = match super::pdf_merge::merge_scaled(pages, PX_TO_PT) {
        Ok(bytes) => bytes,
        Err(e) => return PdfResult::error(format!("PDF merge failed: {}", e)),
    };

    match std::fs::write(&save_path, &merged) {
        Ok(()) => PdfResult::success(save_path),
        Err(e) => PdfResult::error(format!("Failed to write PDF file: {}", e)),
    }
}

/// Run WKWebView.createPDF once for a single rect and return its PDF bytes.
async fn capture_one(target_window: &WebviewWindow, rect: &CaptureRect) -> Result<Vec<u8>, String> {
    // Two delivery paths for the result:
    //   1. Cocoa completion handler (the happy path / API-level error).
    //   2. The setup-error path inside `with_webview` if the webview pointer
    //      is null or we're off the main thread. That closure returns `()` and
    //      can't propagate Result, so it sends through the same channel.
    let (pdf_tx, pdf_rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let pdf_slot = Arc::new(Mutex::new(Some(pdf_tx)));
    let pdf_slot_handler = pdf_slot.clone();
    let pdf_slot_setup_err = pdf_slot;
    let rect = rect.clone();

    let render_result = target_window.with_webview(move |webview| {
        let wkwebview_ptr = webview.inner();
        if wkwebview_ptr.is_null() {
            send_result(
                &pdf_slot_setup_err,
                Err("Tauri returned a null WKWebView pointer".to_string()),
            );
            return;
        }

        // Tauri runs `with_webview` callbacks on the main thread (Cocoa requires
        // UI work on main). If we ever end up elsewhere, fail loudly through the
        // channel rather than calling main-thread-only APIs.
        let mtm = match MainThreadMarker::new() {
            Some(m) => m,
            None => {
                send_result(
                    &pdf_slot_setup_err,
                    Err("PDF generation must run on the main thread".to_string()),
                );
                return;
            }
        };

        unsafe {
            let wkwebview: &WKWebView = &*(wkwebview_ptr as *const WKWebView);
            let configuration = WKPDFConfiguration::new(mtm);
            configuration.setRect(NSRect {
                origin: NSPoint { x: rect.x, y: rect.y },
                size: NSSize {
                    width: rect.width,
                    height: rect.height,
                },
            });

            let handler = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = if !error.is_null() {
                    let err_ref: &NSError = &*error;
                    let desc: Retained<NSString> = err_ref.localizedDescription();
                    Err(desc.to_string())
                } else if data.is_null() {
                    Err("WKWebView returned no PDF data".to_string())
                } else {
                    let data_ref: &NSData = &*data;
                    // PDF bytes are owned by the NSData the completion handler
                    // retains until it returns, so `as_bytes_unchecked` is safe
                    // for the duration of the `.to_vec()` copy.
                    Ok(data_ref.as_bytes_unchecked().to_vec())
                };
                send_result(&pdf_slot_handler, result);
            });

            wkwebview.createPDFWithConfiguration_completionHandler(Some(&configuration), &handler);
        }
    });

    if let Err(e) = render_result {
        return Err(format!("Could not access WKWebView: {}", e));
    }

    match pdf_rx.await {
        Ok(result) => result,
        Err(_) => Err("PDF render task was dropped".to_string()),
    }
}

// Deliver a capture result through the oneshot slot exactly once.
fn send_result(
    slot: &PdfResultSlot,
    result: Result<Vec<u8>, String>,
) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(result);
        }
    }
}
