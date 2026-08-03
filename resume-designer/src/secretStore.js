/**
 * OS keychain facade for the OpenRouter API key.
 *
 * The key used to live in appStorage like everything else, which means a
 * plaintext file under `<app_data_dir>/storage/` (desktop) or a localStorage
 * entry (browser). That directory is swept into Time Machine, Backblaze and
 * folder-sync tools, so the credential travelled into every backup image the
 * user ever made. It now lives in the macOS Keychain / Windows Credential
 * Manager via commands/secret.rs.
 *
 * ## Why there is an in-memory copy
 *
 * `getSettings()` is synchronous and sits under `getApiKey()`, which every AI
 * request path calls inline. Tauri's `invoke` is async, so the credential
 * cannot be fetched at read time without turning that whole call graph async.
 * Instead the key is hydrated ONCE at boot into `cached` and read
 * synchronously from there — the same cache-then-drain shape appStorage
 * already uses for disk. The credential is in process memory either way; it
 * has to be, to sign a request.
 *
 * ## The migration invariant
 *
 * `profiles.js#extractSharedApiKey` established the rule this module follows:
 * never strip the old copy until the new write is durable. If the keychain
 * write failed while the plaintext strip succeeded, the only durable copy of
 * the credential would vanish on restart. `secret_set` resolves only on a
 * confirmed write, so awaiting it IS the durability signal — and a rejected
 * `secret_get` must never be mistaken for "no key stored" (see commands/secret.rs).
 */

import { appStorage } from './appStorage.js';
import { OPENROUTER_KEY_KEY } from './profileKeys.js';

// Canonical Tauri sniff — same predicate as appStorage.js / native.js.
// Duplicated rather than imported for the same reason appStorage duplicates
// it: this module sits underneath native.js in the import graph.
const IS_TAURI =
  typeof window !== 'undefined' &&
  ('isTauri' in window || '__TAURI_INTERNALS__' in window || '__TAURI__' in window);

// The keychain entry name. Same string as the old storage key so the two
// stores address the credential identically — and, like every other
// `resume-designer-*` key, it is a data address rather than branding and must
// not be renamed with the app (see the naming rules in CLAUDE.md).
const SECRET_NAME = OPENROUTER_KEY_KEY;

// The credential, hydrated at boot. `null` means "no key configured".
let cached = null;

// Whether the keychain answered at boot. False in the browser build, and on
// desktop when the keychain could not be reached at all.
let available = false;

async function invokeSecret(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

/** True when the credential is being held in the OS keychain. */
export function isKeychainAvailable() {
  return available;
}

/**
 * The credential, read synchronously — this is what lets `getSettings()` stay
 * synchronous. Returns `null` when none is configured.
 *
 * Falls through to appStorage whenever the keychain is not the live store:
 * the browser build, and every read that happens before `initSecretStore()`
 * has run. That keeps boot-time readers working unchanged.
 */
export function getSecret() {
  return available ? cached : appStorage.getItem(OPENROUTER_KEY_KEY);
}

/**
 * Drop any plaintext copy left in appStorage. Only ever called once the
 * keychain copy is known durable.
 *
 * Returns whether the strip reached disk. A failed flush is not an error the
 * user needs to see — the keychain already holds the credential, so the next
 * boot simply retries the strip.
 */
async function stripPlaintextCopy() {
  if (appStorage.getItem(OPENROUTER_KEY_KEY) === null) return true;
  appStorage.removeItem(OPENROUTER_KEY_KEY);
  return appStorage.flush();
}

/**
 * Write the credential, replacing whatever is stored.
 *
 * Throws if the keychain rejects the write, so the Settings dialog can tell
 * the user their key was NOT saved rather than silently dropping it. The
 * in-memory copy is only updated after the write is confirmed, so a failed
 * save never leaves the app using a key it did not persist.
 */
export async function setSecret(value) {
  // Clearing writes an EMPTY value rather than removing the entry. That erases
  // the credential just as well, and keeps getSettings' masking guarantee: a
  // stored empty string hides a stale key left in the per-profile blob by a
  // pre-extraction install, which an absent entry would let resurface.
  if (!available) {
    appStorage.setItem(OPENROUTER_KEY_KEY, value);
    cached = value;
    return;
  }
  await invokeSecret('secret_set', { name: SECRET_NAME, value });
  cached = value;
  // A pre-migration plaintext copy can still exist if an earlier strip failed
  // to flush. Now that a newer credential is durable in the keychain, the
  // stale one is pure liability.
  await stripPlaintextCopy();
}

/**
 * Boot entry point. Hydrates `cached` and performs the one-time move of an
 * existing plaintext key into the keychain.
 *
 * Runs after ensureProfilesInitialized() — which is what consolidates the key
 * into OPENROUTER_KEY_KEY via extractSharedApiKey — and before
 * markStorageReady(), so React never renders a settings state that is missing
 * a key the user does have.
 */
export async function initSecretStore() {
  if (!IS_TAURI) {
    // Browser build and jsdom tests: no keychain exists. The key stays in
    // appStorage exactly as before — this path ships to nobody, since the
    // product is the desktop app. getSecret() reads appStorage directly while
    // `available` is false, so there is nothing to hydrate here.
    available = false;
    return;
  }

  let stored;
  try {
    stored = await invokeSecret('secret_get', { name: SECRET_NAME });
    available = true;
  } catch (err) {
    // The keychain could not be reached — locked, access denied, or missing.
    // Note this is NOT the same as "no entry stored", which arrives as a
    // resolved `null`. See handleUnavailableKeychain below.
    available = false;
    handleUnavailableKeychain(err);
    return;
  }

  if (stored !== null) {
    cached = stored;
    // The keychain is authoritative once populated. A plaintext copy at this
    // point is a leftover from a migration whose strip did not flush.
    await stripPlaintextCopy();
    return;
  }

  // Keychain is reachable but empty. Migrate a plaintext original if one is
  // there; otherwise the user simply has no key configured yet.
  const plaintext = appStorage.getItem(OPENROUTER_KEY_KEY);
  if (!plaintext) return;

  try {
    await invokeSecret('secret_set', { name: SECRET_NAME, value: plaintext });
  } catch {
    // Keep the plaintext copy: it is still the only durable one, and the next
    // boot retries. Stripping it here is the data-loss bug extractSharedApiKey
    // was written to avoid.
    cached = plaintext;
    return;
  }
  cached = plaintext;
  await stripPlaintextCopy();
}

/**
 * Decide what happens when the OS keychain cannot be reached on a desktop
 * build — locked, access denied, or otherwise erroring.
 *
 * TODO(ash): implement. This is a security-versus-availability call, not a
 * mechanical one, so it is deliberately left for a human to make.
 *
 * At this point `available` is already false, and `initSecretStore` returns
 * immediately after this runs. `cached` is still null, so unless this sets it
 * the app behaves as though no key is configured. The plaintext copy in
 * appStorage — if the user predates this migration — is untouched and readable
 * via `appStorage.getItem(OPENROUTER_KEY_KEY)`.
 *
 * @param {unknown} err the rejection from `secret_get`
 */
function handleUnavailableKeychain(err) {
  void err;
}
