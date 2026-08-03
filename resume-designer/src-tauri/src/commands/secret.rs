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

fn entry(name: &str) -> Result<Entry, String> {
    validate_name(name)?;
    Entry::new(SERVICE, name).map_err(|e| format!("keychain entry {name}: {e}"))
}

/// Read a secret.
///
/// `Ok(Some(v))` stored, `Ok(None)` no such entry, `Err` keychain unreachable.
/// See the module note — these three are load-bearing and distinct.
#[tauri::command(async)]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
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
    entry(&name)?
        .set_password(&value)
        .map_err(|e| format!("keychain write {name}: {e}"))
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
