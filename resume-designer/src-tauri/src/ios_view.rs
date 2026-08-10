//! iOS view-hierarchy fixup — a workaround for upstream bugs in wry and tao.
//!
//! **This is not app logic. Delete this module once the upstream fixes land.**
//!
//! Without it the app launches, runs, and renders perfectly into a 0×0 viewport
//! on a UIWindow that never composites: a black screen with a fully live app
//! behind it. Three stacked causes, all measured on an iOS 27.0 simulator
//! during Phase 0 (see `docs/ios/phase-0-findings.md`):
//!
//! 1. **The WKWebView is created 0×0 and never resized.** wry's iOS branch does
//!    `initWithFrame: ns_view.frame()` (`wry-0.55.1/src/wkwebview/mod.rs:447-451`)
//!    — the parent's frame *at creation time* — and sets no autoresizing mask.
//!    Every `setAutoresizingMask` in that file (`:504`, `:507`, `:521`, `:677`)
//!    is macOS-only; the iOS path is a bare `addSubview` at `:705`.
//! 2. **The immediate superview is 0×0 too** (the grandparent is correct, at the
//!    full 402×874), so sizing only the webview leaves it inside a zero-sized
//!    ancestor.
//! 3. **The UIWindow has no `windowScene`,** which orphans it on iOS 13+: it can
//!    be sized, unhidden and fully populated and will still never be displayed,
//!    and `makeKeyAndVisible()` is a silent no-op. tao only assigns a scene when
//!    `multiple_scenes_enabled()` is true
//!    (`tao-0.35.3/src/platform_impl/ios/view.rs:540`), i.e. when the Info.plist
//!    manifest sets `UIApplicationSupportsMultipleScenes`. `set_focus()` then
//!    branches on the very association nothing ever made
//!    (`.../ios/window.rs:96-102`).
//!
//! We trigger this ourselves and cannot stop: the `UIApplicationSceneManifest`
//! in `Info.ios.plist` is mandatory (without it the app does not launch on the
//! iOS 27 SDK, per tauri-apps/tauri#15719), and it is the same change that moves
//! tao onto the scene lifecycle where the window is never attached.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager, RunEvent, Runtime};

/// `UIViewAutoresizingFlexibleWidth (1 << 1) | UIViewAutoresizingFlexibleHeight (1 << 4)`
/// — the mask wry sets on macOS and omits on iOS. Once it is set, later
/// rotations and split-view resizes are handled by UIKit rather than by us.
const FLEXIBLE_WIDTH_AND_HEIGHT: usize = (1 << 1) | (1 << 4);

/// Upper bound on retries. See [`on_run_event`] for why retrying is needed at
/// all; this exists only so a permanently sceneless app burns a fixed amount of
/// work instead of re-running the fixup on every run-loop pass forever.
const MAX_ATTEMPTS: usize = 120;

/// Set once the webview is sized and its window is scene-attached and key.
static FIXUP_COMPLETE: AtomicBool = AtomicBool::new(false);
static ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

/// Drives the fixup from the Tauri run loop. Call it for every `RunEvent`.
///
/// A single pass is not enough, and a pass from `setup()` is far too early —
/// `setup()` runs before `UIApplicationMain`, so there is no view hierarchy yet.
/// `RunEvent::Ready` is the first useful moment but is still not guaranteed to
/// be late enough: with `UIApplicationSupportsMultipleScenes` false, tao emits
/// it from `application:didFinishLaunchingWithOptions:`
/// (`tao-0.35.3/src/platform_impl/ios/app_state.rs:609-611`), which UIKit calls
/// *before* it connects the UIWindowScene — so `connectedScenes` can still be
/// empty on that first pass and cause 3 above would go unfixed.
///
/// The retry therefore rides `RunEvent::MainEventsCleared`, which tao drives
/// from a `kCFRunLoopBeforeWaiting` observer on the main run loop
/// (`.../ios/event_loop.rs:281`) and so fires on every main-loop pass
/// independently of `ControlFlow` — an event-driven retry with no thread and no
/// sleeping. It stops the instant the window is scene-attached and key, which in
/// practice is the first pass after UIKit connects the scene.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if !matches!(event, RunEvent::Ready | RunEvent::MainEventsCleared) {
        return;
    }
    if FIXUP_COMPLETE.load(Ordering::Relaxed) {
        return;
    }
    if ATTEMPTS.fetch_add(1, Ordering::Relaxed) >= MAX_ATTEMPTS {
        FIXUP_COMPLETE.store(true, Ordering::Relaxed);
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // We are already on the main thread here, so tauri-runtime-wry runs this
    // closure inline rather than posting it to the event loop.
    let _ = window.with_webview(|webview| unsafe { apply(webview.inner() as *mut AnyObject) });
}

/// Sizes the webview and its superview, then attaches and shows the window.
///
/// # Safety
/// `webview` must be a `WKWebView` (or null), on the main thread.
unsafe fn apply(webview: *mut AnyObject) {
    if webview.is_null() {
        return;
    }

    // Causes 1 + 2: the webview is 0×0 *and* so is its immediate superview, so
    // both need the frame and the mask. The superview's own bounds are the
    // right target when UIKit has laid it out; when it is still zero, fall back
    // to the screen, which is what the whole hierarchy should fill anyway.
    let superview: *mut AnyObject = msg_send![webview, superview];
    let mut target = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    if !superview.is_null() {
        target = msg_send![superview, bounds];
    }
    if target.size.width <= 0.0 || target.size.height <= 0.0 {
        let screen: *mut AnyObject = msg_send![class!(UIScreen), mainScreen];
        if !screen.is_null() {
            target = msg_send![screen, bounds];
        }
    }
    if target.size.width <= 0.0 || target.size.height <= 0.0 {
        // Nothing sane to size to yet; leave it for the next run-loop pass.
        return;
    }

    if !superview.is_null() {
        let _: () = msg_send![superview, setFrame: target];
        let _: () = msg_send![superview, setAutoresizingMask: FLEXIBLE_WIDTH_AND_HEIGHT];
    }
    let _: () = msg_send![webview, setFrame: target];
    let _: () = msg_send![webview, setAutoresizingMask: FLEXIBLE_WIDTH_AND_HEIGHT];
    let _: () = msg_send![webview, setHidden: false];
    let _: () = msg_send![webview, setAlpha: 1.0f64];

    // Cause 3: attach the window to a scene before showing it, or the show is a
    // no-op and the window stays uncomposited.
    let window: *mut AnyObject = msg_send![webview, window];
    if window.is_null() {
        return;
    }
    let scene: *mut AnyObject = msg_send![window, windowScene];
    if scene.is_null() {
        attach_window_scene(window);
    }
    let _: () = msg_send![window, setHidden: false];
    let _: () = msg_send![window, makeKeyAndVisible];

    let scene: *mut AnyObject = msg_send![window, windowScene];
    let is_key: bool = msg_send![window, isKeyWindow];
    if !scene.is_null() && is_key {
        FIXUP_COMPLETE.store(true, Ordering::Relaxed);
    }
}

/// Assigns the first connected `UIWindowScene` to `window`. No-op when UIKit has
/// not connected one yet — the caller retries on the next run-loop pass.
///
/// # Safety
/// `window` must be a non-null `UIWindow`, on the main thread.
unsafe fn attach_window_scene(window: *mut AnyObject) {
    let application: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
    if application.is_null() {
        return;
    }
    let connected: *mut AnyObject = msg_send![application, connectedScenes];
    if connected.is_null() {
        return;
    }
    let scenes: *mut AnyObject = msg_send![connected, allObjects];
    if scenes.is_null() {
        return;
    }
    let count: usize = msg_send![scenes, count];
    let window_scene_class = class!(UIWindowScene);
    for index in 0..count {
        let scene: *mut AnyObject = msg_send![scenes, objectAtIndex: index];
        let is_window_scene: bool = msg_send![scene, isKindOfClass: window_scene_class];
        if is_window_scene {
            let _: () = msg_send![window, setWindowScene: scene];
            return;
        }
    }
}
