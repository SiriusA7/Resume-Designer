//! SPIKE — NOT PRODUCTION CODE. See `docs/ios/swiftui-lifecycle-spike.md`.
//!
//! Route 1 ("reparent") of the SwiftUI-shell spike. tao keeps `start_app()`,
//! the application lifecycle and the run loop, and builds the whole hierarchy
//! exactly as it does today. Once the window is scene-attached (which is
//! `ios_view.rs`'s job — this module deliberately waits for it rather than
//! duplicating it), we call a Swift `@objc` class that:
//!
//!   1. builds a `UIHostingController` around a real SwiftUI `NavigationStack`,
//!   2. makes it the window's `rootViewController`, and
//!   3. moves wry's existing `WKWebView` into a container inside it.
//!
//! The Swift lives in `src-tauri/ios/OPSpikeShell.swift` (tracked) and must be
//! copied into `src-tauri/gen/apple/Sources/resume-designer/` before building,
//! because `gen/` is gitignored and regenerated.
//!
//! Set `OP_SPIKE_SHELL=0` in the scheme's environment to launch the unmodified
//! web shell instead — that is the A/B control for the screenshots.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use tauri::{AppHandle, Manager, RunEvent, Runtime};

static INSTALLED: AtomicBool = AtomicBool::new(false);
static ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

/// Same reasoning as `ios_view::MAX_ATTEMPTS`: bound the retry so a permanently
/// sceneless app burns a fixed amount of work.
const MAX_ATTEMPTS: usize = 240;

pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if !matches!(event, RunEvent::Ready | RunEvent::MainEventsCleared) {
        return;
    }
    if INSTALLED.load(Ordering::Relaxed) {
        return;
    }
    if std::env::var("OP_SPIKE_SHELL").as_deref() == Ok("0") {
        INSTALLED.store(true, Ordering::Relaxed);
        eprintln!("[ios_shell] disabled by OP_SPIKE_SHELL=0");
        return;
    }
    if ATTEMPTS.fetch_add(1, Ordering::Relaxed) >= MAX_ATTEMPTS {
        INSTALLED.store(true, Ordering::Relaxed);
        eprintln!("[ios_shell] gave up: no scene-attached window after {MAX_ATTEMPTS} passes");
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| unsafe { install(webview.inner() as *mut AnyObject) });
}

/// # Safety
/// `webview` must be a `WKWebView` (or null), on the main thread.
unsafe fn install(webview: *mut AnyObject) {
    if webview.is_null() {
        return;
    }
    let ui_window: *mut AnyObject = msg_send![webview, window];
    if ui_window.is_null() {
        return;
    }
    // Wait for ios_view.rs to attach the UIWindowScene. Installing before that
    // would put a UIHostingController into a window UIKit never lays out, and
    // SwiftUI would size everything to zero.
    let scene: *mut AnyObject = msg_send![ui_window, windowScene];
    if scene.is_null() {
        return;
    }

    let Some(class) = AnyClass::get(c"OPSpikeShell") else {
        // The Swift file was not compiled into the app. Say so loudly and stop
        // retrying — this is the failure mode worth distinguishing from a
        // blank screen.
        INSTALLED.store(true, Ordering::Relaxed);
        eprintln!("[ios_shell] OPSpikeShell not found in the ObjC runtime — Swift file not built?");
        return;
    };
    let _: () = msg_send![class, installShellInWindow: ui_window, webView: webview];
    INSTALLED.store(true, Ordering::Relaxed);
    eprintln!("[ios_shell] SwiftUI shell installed");
}
