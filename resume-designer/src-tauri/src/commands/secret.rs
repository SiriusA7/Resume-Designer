//! OS credential store for the app's secrets.
//!
//! `commands/storage.rs` writes each key to a plaintext file under
//! `<app_data_dir>/storage/`, which is the right home for resume content but
//! the wrong one for a credential: that directory is swept into Time Machine,
//! Backblaze and any folder-sync tool, so a plaintext API key travels into
//! every backup image the user ever makes. These commands put it in the
//! macOS Keychain / Windows Credential Manager instead, encrypted at rest and
//! prompting when another application reaches for it.
//!
//! The JS facade in `src/secretStore.js` is the only caller.
//!
//! ## `Ok(None)` and `Err` are NOT interchangeable
//!
//! `secret_get` reports "no entry stored" as `Ok(None)` and "the keychain
//! could not be reached" as `Err`. Callers must keep these apart. The boot
//! migration deletes the plaintext original once the keychain copy is in
//! place, and a locked or denied keychain collapsing into `Ok(None)` would
//! read as *the user has no key*, sending that migration down the path where
//! it destroys the only durable copy. `src/secretStore.js` preserves the
//! distinction; do not "simplify" it away on either side.

use keyring::{Entry, Error as KeyringError};
#[cfg(target_vendor = "apple")]
use security_framework::{
    base::Error as SecurityFrameworkError,
    passwords::{generic_password, set_generic_password_options, PasswordOptions},
};

/// Keychain service name. This is the frozen bundle identifier, matching the
/// address `app_data_dir()` already derives for this app — the credential
/// belongs to the same install identity as the data beside it. It is a data
/// address, not branding, and must not be renamed with the app (see the
/// naming rules in CLAUDE.md).
const SERVICE: &str = "com.resumedesigner.app";

/// Secret names come from a fixed app-side inventory, but validate anyway:
/// these strings cross the renderer boundary, and a compromised renderer
/// should not be able to enumerate or overwrite arbitrary keychain entries
/// belonging to this service. Mirrors `storage::validate_key`.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 200 {
        return Err("secret name must be 1-200 chars".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("invalid secret name: {name}"));
    }
    Ok(())
}

fn local_entry(name: &str) -> Result<Entry, String> {
    validate_name(name)?;
    Entry::new(SERVICE, name).map_err(|e| format!("keychain entry {name}: {e}"))
}

#[cfg(not(target_vendor = "apple"))]
fn synchronizable_entry(name: &str) -> Result<Entry, String> {
    local_entry(name)
}

/// "Every device" means every device running an app in the SAME KEYCHAIN
/// ACCESS GROUP — which today means iOS to iOS, and NOT iOS to the Mac.
///
/// `kSecAttrSynchronizable` decides whether an item rides iCloud Keychain. It
/// does not widen who may read it: that is the access group, which defaults to
/// `<team>.<bundle id>`, and iOS is `com.onpaper.app` while desktop is
/// `com.resumedesigner.app`. No `keychain-access-groups` entitlement is
/// configured on either, so the synchronized item is unreachable from the Mac
/// app however many devices it reaches.
///
/// That costs nothing today — the desktop app has no CloudKit sync, so nothing
/// over there is waiting for this key. It becomes a PREREQUISITE the moment
/// macOS sync starts: both App IDs need a shared access group, and the group
/// has to be added under the OLD identifier before any bundle-id rename, since
/// deleting a synchronized item propagates that deletion to every device.
/// Written down because the shape invites the opposite assumption — a review
/// read this as already carrying the desktop key across, and it does not.
#[cfg(target_vendor = "apple")]
struct SynchronizableEntry {
    name: String,
}

#[cfg(target_vendor = "apple")]
impl SynchronizableEntry {
    fn options(&self) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(SERVICE, &self.name);
        options.set_access_synchronized(Some(true));
        options
    }

    fn get_password(&self) -> keyring::Result<String> {
        let bytes = generic_password(self.options()).map_err(decode_apple_error)?;
        String::from_utf8(bytes).map_err(|e| KeyringError::BadEncoding(e.into_bytes()))
    }

    fn set_password(&self, password: &str) -> keyring::Result<()> {
        set_generic_password_options(password.as_bytes(), self.options())
            .map_err(decode_apple_error)
    }
}

#[cfg(target_vendor = "apple")]
fn synchronizable_entry(name: &str) -> Result<SynchronizableEntry, String> {
    validate_name(name)?;
    Ok(SynchronizableEntry {
        name: name.to_owned(),
    })
}

/// Does this failure mean "the synchronizable store is not usable here", as
/// opposed to "the item is not in it"?
///
/// `kSecAttrSynchronizable` is not merely an attribute of an item — it selects
/// a store. On a Mac or a device with iCloud Keychain disabled, restricted, or
/// signed out, that store can refuse the operation outright, and `secret_set`
/// wrote ONLY there: the error propagated, and entering, replacing or clearing
/// the API key failed with it. That is every AI feature in the app, on the
/// desktop build too, because `SynchronizableEntry` is chosen for every Apple
/// target and not just iOS.
///
/// APPLE ONLY, and the `cfg` is load-bearing for the same reason
/// `forget_legacy_local`'s is: everywhere else the two entry builders return
/// THE SAME keychain item, so "fall back to the local one" would just repeat
/// the call that has already failed and report the same error a second time.
/// Returning `false` there keeps the old path exactly as it was.
#[cfg(target_vendor = "apple")]
fn sync_unavailable(error: &KeyringError) -> bool {
    matches!(error, KeyringError::NoStorageAccess(_))
}

#[cfg(not(target_vendor = "apple"))]
fn sync_unavailable(_error: &KeyringError) -> bool {
    false
}

#[cfg(target_vendor = "apple")]
fn decode_apple_error(error: SecurityFrameworkError) -> KeyringError {
    match error.code() {
        -25291 | -25292 | -25294 | -25295 => KeyringError::NoStorageAccess(Box::new(error)),
        -25300 => KeyringError::NoEntry,
        _ => KeyringError::PlatformFailure(Box::new(error)),
    }
}

/// Drop the legacy NON-synchronizable item, once a synchronizable copy is
/// CONFIRMED in place. Best effort: the caller has already succeeded, and a
/// leftover here costs nothing until the synchronizable item goes away.
///
/// Why it has to go at all. Kept, it is a second stored value that no later
/// write ever updates — `secret_set` writes only the synchronizable item — so
/// it freezes at whatever the credential was on the day it was migrated. Read
/// order hides that until the synchronizable item disappears (an iCloud
/// Keychain reset, an Apple ID change), and then the fallback below serves the
/// stale value and re-synchronizes it to every device: a key the person
/// replaced, or revoked and cleared, silently back in use and billing.
///
/// APPLE ONLY, and the `cfg` is load-bearing rather than tidiness: everywhere
/// else the two entry builders return THE SAME keychain item, so this would
/// delete the credential that was just written.
///
/// On Apple it cannot touch the synchronizable item even by accident. `keyring`
/// reaches the file-based login keychain through the legacy `SecKeychain` API,
/// while `SynchronizableEntry` uses modern `SecItem` queries against the
/// data-protection keychain — different stores, not merely different query
/// attributes. Deleting the synchronizable one would be the far worse bug: that
/// deletion PROPAGATES, taking the credential off every device on the account.
#[cfg(target_vendor = "apple")]
fn forget_legacy_local(name: &str) {
    let _ = local_entry(name).map(|e| e.delete_credential());
}

#[cfg(not(target_vendor = "apple"))]
fn forget_legacy_local(_name: &str) {}

/// Read a secret.
///
/// `Ok(Some(v))` stored, `Ok(None)` no such entry, `Err` keychain unreachable.
/// See the module note — these three are load-bearing and distinct.
///
/// A synchronizable item and a local one are DIFFERENT items to the keychain: a
/// query for one never matches the other. So a miss here is not proof of
/// absence until the legacy local item has been looked for too, and finding one
/// upgrades it in place — once, because the next read matches the first branch.
#[tauri::command(async)]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match synchronizable_entry(&name)?.get_password() {
        Ok(v) => return Ok(Some(v)),
        Err(KeyringError::NoEntry) => {}
        // Same fall-through as NoEntry, for the same reason: neither is proof
        // the credential is absent. A store that cannot be read holds no
        // evidence about what is in it, and the local item may well have the
        // key. Note what this does NOT do — it does not turn the failure into
        // `Ok(None)`. If the local read also comes up empty this still returns
        // `Ok(None)` only because the local store answered; an unreachable
        // local keychain still errors, which is the distinction the module
        // note at the top calls load-bearing.
        Err(ref e) if sync_unavailable(e) => {}
        Err(e) => return Err(format!("keychain read {name}: {e}")),
    }
    match local_entry(&name)?.get_password() {
        Ok(v) => {
            // Best effort: a failed upgrade must not hide a key the person has.
            // The legacy item is retained on failure for exactly that reason —
            // it is still the only copy — and dropped only once the upgrade
            // itself reports success.
            if synchronizable_entry(&name)
                .and_then(|e| {
                    e.set_password(&v)
                        .map_err(|e| format!("keychain upgrade {name}: {e}"))
                })
                .is_ok()
            {
                forget_legacy_local(&name);
            }
            Ok(Some(v))
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read {name}: {e}")),
    }
}

/// Write a secret, replacing any existing value.
///
/// Errors are propagated rather than swallowed: the caller uses a successful
/// return as its durability signal before deleting a plaintext original, so a
/// silent failure here would lose the credential.
#[tauri::command(async)]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    match synchronizable_entry(&name)?.set_password(&value) {
        Ok(()) => {}
        // The store is unusable, so write the credential where it CAN go. A key
        // that lives on one machine is worth having; a key the app refuses to
        // store is not.
        //
        // `forget_legacy_local` is deliberately skipped on this branch — it is
        // the whole point. That call exists to drop a superseded local copy once
        // a synchronizable one is confirmed, and here the local copy is not
        // superseded, it is the only copy there is.
        //
        // RESIDUAL, stated rather than glossed: if a synchronizable item was
        // written earlier (iCloud Keychain on), then sync became unavailable and
        // the key was CHANGED, then sync came back, the read above prefers the
        // synchronizable item and serves the older key. That window needs all
        // four steps in that order. It is strictly better than the behaviour it
        // replaces, where the second step alone made the app unable to store a
        // key at all, and closing it properly needs a delete on a store that by
        // construction is refusing operations at the moment we would need it.
        Err(ref e) if sync_unavailable(e) => {
            return local_entry(&name)?
                .set_password(&value)
                .map_err(|e| format!("keychain write {name}: {e}"));
        }
        Err(e) => return Err(format!("keychain write {name}: {e}")),
    }
    // Here too, not only on the migrating read: this device may never have READ
    // the credential before the person set one — a device that only ever had
    // the key typed into it still has a legacy item from an older build, and
    // nothing else would ever come back for it. Every write is a moment the
    // legacy copy becomes stale, which is precisely when it stops being a
    // fallback and starts being a way to resurrect a revoked key.
    //
    // After the write and outside its `?`: this function's success is the
    // caller's durability signal for deleting the plaintext original, and a
    // failed cleanup of a superseded item is not a failure to store the key.
    forget_legacy_local(&name);
    Ok(())
}

// No delete command on purpose. "Clear all API keys" writes an EMPTY value
// rather than removing the entry, which both erases the credential and
// preserves an existing guarantee in persistence.js#getSettings: a stored
// empty string masks a stale key left in the per-profile blob by a
// pre-extraction install, whereas an absent entry would let that stale key
// resurface as though the user had never cleared it.

#[cfg(test)]
mod tests {
    use super::*;

    // The fallback's branching predicate. The keychain itself is not reachable
    // from a unit test, but which errors divert to the local store is the part
    // that can be wrong, and it is pure.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn an_unusable_store_diverts_to_the_local_one() {
        let unavailable = KeyringError::NoStorageAccess(Box::new(std::io::Error::other("no icloud keychain")));
        assert!(sync_unavailable(&unavailable));
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_missing_item_does_not_divert() {
        // NoEntry has its own arm and must keep it: diverting here would be
        // harmless for the read but would make every write fall back.
        assert!(!sync_unavailable(&KeyringError::NoEntry));
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn an_unexplained_failure_does_not_divert() {
        // PlatformFailure is the bucket decode_apple_error puts everything it
        // does not recognise into. Diverting on it would hide real keychain
        // faults behind a silent local write.
        let other = KeyringError::PlatformFailure(Box::new(std::io::Error::other("something else")));
        assert!(!sync_unavailable(&other));
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn errsecnotavailable_decodes_to_the_diverting_error() {
        // -25291 is errSecNotAvailable, the code Codex named. This is the join
        // between the mapping and the predicate: if decode_apple_error ever
        // reclassified it, the fallback above would silently stop engaging and
        // no other test would notice.
        let decoded = decode_apple_error(SecurityFrameworkError::from_code(-25291));
        assert!(sync_unavailable(&decoded));
    }

    #[test]
    fn accepts_app_secret_names() {
        assert!(validate_name("resume-designer-openrouter-key").is_ok());
        assert!(validate_name("a").is_ok());
        assert!(validate_name("with.dots_and-dashes.9").is_ok());
    }

    #[test]
    fn both_entry_builders_reject_a_bad_name() {
        assert!(synchronizable_entry("bad name").is_err());
        assert!(local_entry("bad name").is_err());
    }

    #[test]
    fn rejects_empty_and_oversized() {
        assert!(validate_name("").is_err());
        assert!(validate_name(&"a".repeat(201)).is_err());
        assert!(validate_name(&"a".repeat(200)).is_ok());
    }

    #[test]
    fn rejects_names_a_renderer_should_not_reach() {
        // Separators, whitespace and wildcards: a compromised renderer must not
        // be able to shape a name that addresses another service's entries.
        for bad in [
            "has space",
            "slash/name",
            "back\\slash",
            "colon:name",
            "new\nline",
            "star*",
            "nul\0byte",
            "unicodé",
        ] {
            assert!(validate_name(bad).is_err(), "should reject {bad:?}");
        }
    }
}
