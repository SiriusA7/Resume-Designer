//! One-time macOS bundle rename: `Resume Designer.app` → `On Paper.app`.
//!
//! The updater re-roots an update onto the RUNNING bundle's path. It strips the
//! archive's top-level folder name on purpose — `entry.path()?.iter().skip(1)`
//! in tauri-plugin-updater — so that an update lands wherever the user actually
//! put the app. The cost is that an auto-updated install keeps the folder name
//! it was first installed under, permanently.
//!
//! Nothing in `Info.plist` papers over that. `CFBundleDisplayName` drives the
//! app menu and the About box only; Finder, Dock and Spotlight all report the
//! FILENAME — verified against `NSFileManager.displayName(atPath:)`, which
//! returns the filename both with and without a localized `InfoPlist.strings`.
//! Renaming the directory on disk is the only thing that changes what users see.
//!
//! # Why this runs at EXIT and not at startup
//!
//! macOS resolves the executable path once, at exec time, and `current_exe()`
//! keeps returning that original string forever — it does **not** follow a
//! rename, and it reports `Ok(stale_path)` rather than an error. Renaming a live
//! process's own bundle therefore leaves the app holding a path that no longer
//! exists, and two things read it:
//!
//! - the updater derives `extract_path` from it, so installing an update in that
//!   session fails; and
//! - `tauri::process::restart` spawns from it, so the app quits without coming
//!   back.
//!
//! Doing the rename on the way out avoids both: the path stays valid for the
//! whole life of the process, and the next launch starts from the new name with
//! a correct `current_exe()`. It is best-effort and idempotent — if the exit
//! handler does not run (force quit, crash), the next clean exit retries.
//!
//! `RunEvent::Exit` *does* fire on Cmd+Q — verified end-to-end by quitting that
//! way and watching the bundle rename. Note this is NOT the same as the window's
//! close-requested hook, which Cmd+Q genuinely does bypass (see the storage-flush
//! caveat in TAURI.md); the two are easy to conflate.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The one historical name this migration recognizes. Matching a specific
/// string rather than "anything that is not the current name" is what keeps a
/// user who deliberately renamed their copy from having it renamed back.
const OLD_BUNDLE_NAME: &str = "Resume Designer.app";
const NEW_BUNDLE_NAME: &str = "On Paper.app";

/// Set by the updater once an update has been installed.
static UPDATE_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Record that an update was installed, so the rename is skipped on this exit.
///
/// The relaunch that follows an install resolves the binary from the path this
/// process was exec'd with; renaming first would point it at a path that no
/// longer exists and the app would quit instead of reopening. Skipping costs
/// nothing — the rename happens on the next clean exit instead.
pub fn suppress_until_next_launch() {
    UPDATE_INSTALLED.store(true, Ordering::Relaxed);
}

/// Where the running bundle should be renamed to, or `None` to leave it alone.
///
/// Deliberately narrow. It fires for exactly one name, in the two directories
/// macOS apps are installed into, only when no update is about to relaunch us,
/// and only when the destination is free. Everything else is left untouched: a
/// bundle the user renamed themselves, a build under `target/`, a copy running
/// from a mounted DMG, and — importantly — an install that already has BOTH
/// bundles, where picking a winner is not this function's call to make.
///
/// `exists` is injected so the decision is testable without touching the disk.
pub fn rename_target(
    bundle: &Path,
    home: Option<&Path>,
    update_installed: bool,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if update_installed {
        return None;
    }
    if bundle.file_name()? != OsStr::new(OLD_BUNDLE_NAME) {
        return None;
    }
    let parent = bundle.parent()?;
    let installed = parent == Path::new("/Applications")
        || home.is_some_and(|h| parent == h.join("Applications"));
    if !installed {
        return None;
    }
    let target = parent.join(NEW_BUNDLE_NAME);
    // A duplicate install: renaming would either fail or clobber the other
    // bundle. Leave both in place — deleting an app is the user's decision.
    if exists(&target) {
        return None;
    }
    Some(target)
}

/// The `.app` directory containing the running executable, if there is one.
/// The layout is fixed by macOS: `<Name>.app/Contents/MacOS/<binary>`.
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Rename the running bundle if it still carries the pre-rename name.
///
/// Call from `RunEvent::Exit` only — see the module docs for why startup is the
/// wrong place. Renaming here is safe: the rename moves a directory inode and
/// the kernel's image handle follows it, so even a still-winding-down process is
/// unaffected.
///
/// Best-effort by design — a failure is logged and ignored. A stale folder name
/// is cosmetic; failing an app shutdown over it would not be.
pub fn heal() {
    let Some(bundle) = running_bundle() else {
        return;
    };
    let home = dirs::home_dir();
    let Some(target) = rename_target(
        &bundle,
        home.as_deref(),
        UPDATE_INSTALLED.load(Ordering::Relaxed),
        &|p| p.exists(),
    ) else {
        return;
    };
    match std::fs::rename(&bundle, &target) {
        Ok(()) => eprintln!("bundle_name: renamed {bundle:?} -> {target:?}"),
        Err(e) => eprintln!("bundle_name: could not rename {bundle:?}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/someone";
    const OLD_IN_APPS: &str = "/Applications/Resume Designer.app";
    fn free(_: &Path) -> bool {
        false
    }
    fn taken(_: &Path) -> bool {
        true
    }
    fn home() -> Option<PathBuf> {
        Some(PathBuf::from(HOME))
    }
    /// The normal case: not restarting, destination free.
    fn target_for(path: &str) -> Option<PathBuf> {
        rename_target(Path::new(path), home().as_deref(), false, &free)
    }

    #[test]
    fn renames_the_old_name_in_applications() {
        assert_eq!(
            target_for(OLD_IN_APPS),
            Some(PathBuf::from("/Applications/On Paper.app"))
        );
    }

    #[test]
    fn renames_the_old_name_in_the_user_applications_folder() {
        assert_eq!(
            target_for("/Users/someone/Applications/Resume Designer.app"),
            Some(PathBuf::from("/Users/someone/Applications/On Paper.app"))
        );
    }

    // An installed update means a relaunch is imminent, and the relaunch spawns
    // from the path this process was exec'd with. Renaming first would send it
    // to a path that no longer exists, so the app would quit instead of
    // reopening — the update would appear to uninstall the app.
    #[test]
    fn declines_while_an_update_is_waiting_to_relaunch() {
        let got = rename_target(Path::new(OLD_IN_APPS), home().as_deref(), true, &free);
        assert_eq!(got, None);
    }

    // The situation that prompted this: an auto-updated install and a fresh DMG
    // install side by side. Renaming would clobber the other bundle, so the
    // migration declines and leaves the choice to the user.
    #[test]
    fn declines_when_the_destination_already_exists() {
        let got = rename_target(Path::new(OLD_IN_APPS), home().as_deref(), false, &taken);
        assert_eq!(got, None);
    }

    #[test]
    fn ignores_a_bundle_that_is_already_correctly_named() {
        assert_eq!(target_for("/Applications/On Paper.app"), None);
    }

    // A user who renamed their own copy keeps it. This is why the check is an
    // exact match against the historical name and not "anything unexpected".
    #[test]
    fn ignores_a_name_the_user_chose() {
        for name in ["Resume Designer 2.app", "My Resume App.app", "Paper.app"] {
            let path = format!("/Applications/{name}");
            assert_eq!(target_for(&path), None, "{name}");
        }
    }

    // Dev builds live under target/…/bundle/macos/ and stale ones still carry
    // the old name. Renaming a build artifact would be pure interference.
    #[test]
    fn ignores_bundles_outside_the_install_directories() {
        for parent in [
            "/Users/someone/Projects/app/src-tauri/target/release/bundle/macos",
            "/Volumes/On Paper 2.0.0",
            "/Users/someone/Downloads",
            "/Applications/Utilities",
        ] {
            let path = format!("{parent}/{OLD_BUNDLE_NAME}");
            assert_eq!(target_for(&path), None, "{parent}");
        }
    }

    // A missing HOME must not accidentally make some other path look like the
    // user's Applications folder.
    #[test]
    fn without_a_home_only_the_system_applications_folder_matches() {
        assert_eq!(
            rename_target(Path::new(OLD_IN_APPS), None, false, &free),
            Some(PathBuf::from("/Applications/On Paper.app"))
        );
        assert_eq!(
            rename_target(
                Path::new("/Users/someone/Applications/Resume Designer.app"),
                None,
                false,
                &free
            ),
            None
        );
    }

    #[test]
    fn tolerates_a_path_with_no_parent() {
        assert_eq!(target_for("/"), None);
    }
}
