use tauri::WebviewWindow;
use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment9, ICoreWebView2PrintSettings, ICoreWebView2PrintSettings2,
    ICoreWebView2_16, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::{ExecuteScriptCompletedHandler, PrintToPdfStreamCompletedHandler};
// webview2-com 0.38 maps the raw COM args into Rust-native types for the
// completion handlers (callback.rs): HRESULT -> Result<()>, PCWSTR -> String,
// Option<Interface> -> Option<Interface>. So the handler closures below take
// `(Result<()>, String)` and `(Result<()>, Option<IStream>)` respectively.
use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

use super::{CaptureRect, PdfResult};

// CSS pixels are 1/96 in; PDF points are 1/72 in. UNLIKE WKWebView (which maps
// 1 px -> 1 pt and needs scaling), WebView2's print engine is Chromium's
// printToPDF: with ScaleFactor 1.0 and 0 margins it renders content at its true
// size (1 px -> 1/96 in) anchored at the page origin, so each per-sheet PDF
// already has the correct physical MediaBox = px * 72/96 points. We therefore do
// NOT scale the content — we only assert each page's MediaBox from px * PX_TO_PT.
const PX_TO_PT: f64 = 72.0 / 96.0;

/// Capture each `.resume-page` sheet of `target_window`'s WebView2 as its own PDF
/// page at that sheet's size, then concatenate them into one document at
/// `save_path`.
///
/// `rects` are the on-screen sheets (CSS px). WebView2 has no per-rect capture,
/// so for each sheet we hide every other `.resume-page` (via injected JS), print
/// the lone visible sheet at its own page size with `PrintToPdfStream`, then
/// restore the DOM. One rect (continuous) yields a single-page PDF; N rects (a
/// fixed size like Letter/A4) yield an N-page PDF whose pages ARE the on-screen
/// sheets — including any oversized `.is-overflowing` sheet, which prints at its
/// own taller height instead of being split against the first sheet's size.
pub async fn capture_pdf(
    target_window: WebviewWindow,
    save_path: String,
    rects: Vec<CaptureRect>,
) -> PdfResult {
    if rects.is_empty() {
        return PdfResult::error("No page rects supplied for PDF capture");
    }

    let mut pages: Vec<(Vec<u8>, f64, f64)> = Vec::with_capacity(rects.len());
    for (i, rect) in rects.iter().enumerate() {
        // Isolate sheet i: hide the other sheets and neutralize the page-break CSS
        // on the visible one (a trailing `break-after: page` would otherwise emit a
        // spurious blank second page), then force a reflow.
        if let Err(e) = run_script(&target_window, isolate_js(i)).await {
            let _ = run_script(&target_window, RESTORE_JS.to_string()).await;
            return PdfResult::error(format!("isolate sheet {}: {}", i, e));
        }
        // Print the lone visible sheet at its own physical size (px -> inches).
        match print_sheet(&target_window, rect.width / 96.0, rect.height / 96.0).await {
            Ok(bytes) => pages.push((bytes, rect.width * PX_TO_PT, rect.height * PX_TO_PT)),
            Err(e) => {
                let _ = run_script(&target_window, RESTORE_JS.to_string()).await;
                return PdfResult::error(format!("capture sheet {}: {}", i, e));
            }
        }
    }

    // Restore the DOM (best-effort; the hidden print window is discarded anyway).
    let _ = run_script(&target_window, RESTORE_JS.to_string()).await;

    let merged = match super::pdf_merge::merge_concat(pages) {
        Ok(bytes) => bytes,
        Err(e) => return PdfResult::error(format!("PDF merge failed: {}", e)),
    };

    match std::fs::write(&save_path, &merged) {
        Ok(()) => PdfResult::success(save_path),
        Err(e) => PdfResult::error(format!("Failed to write PDF file: {}", e)),
    }
}

/// Run `js` in the target webview, resolving once ExecuteScript completes.
/// Re-enters `with_webview` per call so we never hold a COM pointer across an
/// `.await` or thread boundary (WebView2 objects are UI-thread affine).
async fn run_script(target_window: &WebviewWindow, js: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    let slot = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let slot_handler = slot.clone();
    let slot_setup = slot;

    let render_result = target_window.with_webview(move |webview| {
        let setup: Result<(), String> = (|| unsafe {
            let core: ICoreWebView2_16 = webview
                .controller()
                .CoreWebView2()
                .and_then(|cw| cw.cast::<ICoreWebView2_16>())
                .map_err(|e| e.message().to_string())?;

            let js_hstring = HSTRING::from(&js);
            let handler = ExecuteScriptCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>, _json: String| -> windows::core::Result<()> {
                    let out = result.map_err(|e| format!("ExecuteScript failed: {}", e.message()));
                    send_once(&slot_handler, out);
                    Ok(())
                },
            ));
            core.ExecuteScript(&js_hstring, &handler)
                .map_err(|e| e.message().to_string())?;
            Ok(())
        })();

        if let Err(message) = setup {
            send_once(&slot_setup, Err(message));
        }
    });

    if let Err(e) = render_result {
        return Err(format!("Could not access WebView2 controller: {}", e));
    }

    match rx.await {
        Ok(result) => result,
        Err(_) => Err("ExecuteScript task was dropped".to_string()),
    }
}

/// Print the currently-visible content at the given page size (inches) and return
/// the PDF bytes, read from the in-memory stream on the UI thread.
async fn print_sheet(
    target_window: &WebviewWindow,
    width_in: f64,
    height_in: f64,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let slot = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let slot_handler = slot.clone();
    let slot_setup = slot;

    let render_result = target_window.with_webview(move |webview| {
        let setup: Result<(), String> = (|| unsafe {
            let core: ICoreWebView2_16 = webview
                .controller()
                .CoreWebView2()
                .and_then(|cw| cw.cast::<ICoreWebView2_16>())
                .map_err(|e| e.message().to_string())?;

            let env: ICoreWebView2Environment9 = core
                .Environment()
                .and_then(|e| e.cast::<ICoreWebView2Environment9>())
                .map_err(|e| e.message().to_string())?;

            let settings: ICoreWebView2PrintSettings = env
                .CreatePrintSettings()
                .map_err(|e| e.message().to_string())?;

            settings
                .SetPageWidth(width_in)
                .map_err(|e| e.message().to_string())?;
            settings
                .SetPageHeight(height_in)
                .map_err(|e| e.message().to_string())?;
            // Match the print orientation to the sheet so a landscape page
            // (width > height) isn't paginated/rotated as portrait.
            let orientation = if width_in > height_in {
                COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            };
            settings
                .SetMarginTop(0.0)
                .and_then(|_| settings.SetMarginBottom(0.0))
                .and_then(|_| settings.SetMarginLeft(0.0))
                .and_then(|_| settings.SetMarginRight(0.0))
                .and_then(|_| settings.SetOrientation(orientation))
                .and_then(|_| settings.SetShouldPrintBackgrounds(true))
                .map_err(|e| e.message().to_string())?;

            if let Ok(settings2) = settings.cast::<ICoreWebView2PrintSettings2>() {
                let _ = settings2.SetScaleFactor(1.0);
            }

            let handler = PrintToPdfStreamCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>,
                      stream: Option<IStream>|
                      -> windows::core::Result<()> {
                    let out = match result {
                        Ok(()) => match stream {
                            Some(s) => istream_to_vec(&s),
                            None => Err("PrintToPdfStream returned no stream".to_string()),
                        },
                        Err(e) => Err(format!("PrintToPdfStream failed: {}", e.message())),
                    };
                    send_once(&slot_handler, out);
                    Ok(())
                },
            ));

            core.PrintToPdfStream(&settings, &handler)
                .map_err(|e| e.message().to_string())?;
            Ok(())
        })();

        if let Err(message) = setup {
            send_once(&slot_setup, Err(message));
        }
    });

    if let Err(e) = render_result {
        return Err(format!("Could not access WebView2 controller: {}", e));
    }

    match rx.await {
        Ok(result) => result,
        Err(_) => Err("PrintToPdfStream task was dropped".to_string()),
    }
}

/// Read an `IStream` (rewound by WebView2 to the PDF start) fully into a `Vec<u8>`.
/// Runs on the UI thread inside the completion handler; never crosses a thread.
unsafe fn istream_to_vec(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut stat = STATSTG::default();
    stream
        .Stat(&mut stat, STATFLAG_NONAME)
        .map_err(|e| format!("IStream Stat: {}", e.message()))?;
    let size = stat.cbSize as usize;

    stream
        .Seek(0, STREAM_SEEK_SET, None)
        .map_err(|e| format!("IStream Seek: {}", e.message()))?;

    let mut buf = vec![0u8; size];
    let mut total = 0usize;
    while total < size {
        let mut read: u32 = 0;
        stream
            .Read(
                buf.as_mut_ptr().add(total) as *mut core::ffi::c_void,
                (size - total) as u32,
                Some(&mut read),
            )
            .ok()
            .map_err(|e| format!("IStream Read: {}", e.message()))?;
        if read == 0 {
            break; // EOF guard against a short Stat size
        }
        total += read as usize;
    }
    buf.truncate(total);
    Ok(buf)
}

// Deliver a result through the oneshot slot exactly once (the sender is taken on
// first delivery so a duplicate callback can't double-send).
fn send_once<T>(slot: &std::sync::Arc<std::sync::Mutex<Option<oneshot::Sender<T>>>>, value: T) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(value);
        }
    }
}

// JS that isolates the i-th `.resume-page`: show only it, hide the rest, and
// clear page-break properties on the visible one so a trailing `break-after:page`
// can't emit a blank trailing PDF page. Ends with a forced reflow.
fn isolate_js(index: usize) -> String {
    format!(
        "(function(i){{\
           var ps=document.querySelectorAll('.resume-page');\
           for(var k=0;k<ps.length;k++){{\
             if(k===i){{var s=ps[k].style;s.display='';s.breakBefore='auto';s.breakAfter='auto';s.pageBreakBefore='auto';s.pageBreakAfter='auto';}}\
             else{{ps[k].style.display='none';}}\
           }}\
           void document.body.offsetHeight;\
           return ps.length;\
         }})({});",
        index
    )
}

// JS that restores every `.resume-page` to its default display + page breaks.
const RESTORE_JS: &str = "(function(){\
  var ps=document.querySelectorAll('.resume-page');\
  for(var k=0;k<ps.length;k++){var s=ps[k].style;s.display='';s.breakBefore='';s.breakAfter='';s.pageBreakBefore='';s.pageBreakAfter='';}\
})();";
