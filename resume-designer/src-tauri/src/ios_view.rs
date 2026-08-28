//! iOS view-hierarchy fixup — a workaround for upstream bugs in wry and tao.
//!
//! **This is not app logic. Delete this module once the upstream fixes land.**
//!
//! Without it the app launches, runs, and renders perfectly into a 0×0 viewport
//! on a UIWindow that never composites: a black screen with a fully live app
//! behind it. Measured on an iOS 27.0 simulator during Phase 0 (see
//! `docs/ios/phase-0-findings.md`).
//!
//! **One root cause, two symptoms.**
//!
//! The root cause is that **the UIWindow has no `windowScene`**, which orphans
//! it on iOS 13+: UIKit never lays the hierarchy out, the window never
//! composites, and `makeKeyAndVisible()` is a silent no-op. tao assigns a scene
//! only when `multiple_scenes_enabled()` is true
//! (`tao-0.35.3/src/platform_impl/ios/view.rs:540`) — and that *same* flag gates
//! the only call that registers `TaoSceneDelegate`
//! (`.../ios/view.rs:750`), so with `UIApplicationSupportsMultipleScenes = false`
//! the class is never registered and our static `UISceneDelegateClassName`
//! cannot resolve. `set_focus()` then branches on the very association nothing
//! ever made (`.../ios/window.rs:96-102`).
//!
//! Because nothing is ever laid out, two things follow:
//!
//! 1. **The immediate superview stays 0×0** (the grandparent is correct, at the
//!    full screen size). This is the load-bearing one: sizing it is what makes
//!    the webview visible.
//! 2. **The WKWebView is created 0×0**, because wry's iOS branch does
//!    `initWithFrame: ns_view.frame()`
//!    (`wry-0.55.1/src/wkwebview/mod.rs:447-451`) — the parent's frame *at
//!    creation time*.
//!
//! **Correction, because the delete-this-module contract depends on it:** an
//! earlier version of this comment claimed wry "sets no autoresizing mask" on
//! iOS. That is false. wry *does* set
//! `FlexibleWidth | FlexibleHeight` on the iOS webview at
//! `wry-0.55.1/src/wkwebview/mod.rs:519-523`. The mask is simply **inert**,
//! because an autoresizing mask only fires when the superview changes size and
//! the superview is never laid out at all. Do not wait for "wry adds an iOS
//! autoresizing mask" — it already shipped. The thing to wait for is tao
//! attaching a `windowScene` under a static scene manifest.
//!
//! **Do not try to fix this by setting `UIApplicationSupportsMultipleScenes` to
//! `true`.** That activates both paths and makes `connect_scene` call
//! `on_app_ready()` twice, hitting tao's own `bug!` panic.
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
/// — the same mask wry already sets on the webview itself
/// (`wry-0.55.1/src/wkwebview/mod.rs:519-523`). We set it on the *superview*,
/// which nobody sets and which is the view that actually needs it; re-setting it
/// on the webview is redundant but harmless. Once both are set, later rotations
/// and split-view resizes are handled by UIKit rather than by us.
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
        // Giving up here means a black screen — the exact failure this module
        // exists to prevent — so say so. This reaches the Xcode / simulator
        // console, the only diagnostic channel left after the file logger was
        // removed. The bound counts run-loop passes, not milliseconds, so it
        // carries no wall-clock guarantee; raise it before suspecting the objc
        // calls.
        eprintln!(
            "[ios_view] gave up after {MAX_ATTEMPTS} run-loop passes without a \
             scene-attached key window — the app will render into a 0x0 viewport"
        );
        return;
    }
    try_apply(app);
}

/// One fixup pass, without waiting for a run-loop event.
///
/// Called from `setup` as well as from the event loop, and that is the point:
/// `.run()` does not start pumping until the whole of Rust startup is done, so
/// the loop's first pass is ~150ms in. If UIKit has already connected a scene
/// by `setup` — it usually has — this shows the window there instead, which is
/// what lets the launch cover be on screen before the system hands off. A no-op
/// when nothing is ready yet; the loop retries as before.
pub fn try_apply<R: Runtime>(app: &AppHandle<R>) {
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
    // Not a diagnosed cause: both were already correct every time they were
    // measured (`hidden=false alpha=1`). Kept as belt-and-braces because a
    // hidden or transparent webview is indistinguishable from this module's
    // own failure mode, and ruling it out costs two selectors.
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
    // Showing this window is what dismisses UILaunchScreen, and the app has not
    // drawn yet — so put the launch screen back, as a plain UIKit view, in the
    // same turn. The chrome takes it down once it has rendered.
    crate::ios_shell::arm_launch_window(window);

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
