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
    synchronizable_entry(&name)?
        .set_password(&value)
        .map_err(|e| format!("keychain write {name}: {e}"))?;
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
