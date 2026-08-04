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

/**
 * Where the credential lives, decided once at boot.
 *
 *  - `session`    browser build and jsdom tests: no keychain exists, so the
 *                 credential is held in memory for this session and never
 *                 written anywhere. It used to persist through appStorage,
 *                 which in the browser IS localStorage — the precise sink
 *                 CodeQL flagged, reached by the precise path this module was
 *                 written to remove. The README offers this build to real
 *                 users ("prefer not to install anything"), so it cannot be
 *                 waved through as a dev-only path.
 *  - `keychain`   desktop, keychain answered: the mode nearly everyone is in.
 *  - `read-only`  desktop, keychain unreachable (locked, denied, broken).
 *                 Keeps serving a pre-migration plaintext key so someone who
 *                 already has one is not locked out of their own AI, but
 *                 refuses to write plaintext — though it still RETRIES the
 *                 keychain, since that fault is usually transient.
 *
 * `session` and `read-only` both mean "no keychain", and are still not
 * interchangeable: the first accepts new keys (holding them in memory), the
 * second refuses them.
 */
let mode = 'session';

/**
 * Reset the module between tests, mirroring __resetAppStorageForTests. `cached`
 * and `mode` are module state and survive a test otherwise, so one test's saved
 * credential silently answers the next one's reads.
 */
export function __resetSecretStoreForTests() {
  mode = 'session';
  cached = null;
}

async function invokeSecret(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

/** True when the credential is being held in the OS keychain. */
export function isKeychainAvailable() {
  return mode === 'keychain';
}

/**
 * True when the keychain faulted and the app is serving an existing plaintext
 * key without being able to save changes. Lets the UI explain why saving is
 * refused instead of just failing.
 */
export function isReadOnly() {
  return mode === 'read-only';
}

/**
 * The credential, read synchronously — this is what lets `getSettings()` stay
 * synchronous. Returns `null` when none is configured.
 *
 * Always the in-memory copy now, in every mode — there is no store left to read
 * through in the browser build. Reads that happen BEFORE initSecretStore() has
 * run therefore see `null`; that is fine, because the only pre-init reader of
 * the credential is extractSharedApiKey, which goes to appStorage directly, and
 * init completes before markStorageReady opens the React gate.
 */
export function getSecret() {
  return cached;
}

/**
 * Drop any plaintext copy left in appStorage. Only ever called once the
 * keychain copy is known durable.
 *
 * Returns whether the strip reached DISK, which callers must not ignore. A
 * failed flush leaves the old credential durably readable, and every later boot
 * that finds the keychain unavailable serves that file as the fallback — so a
 * key the user replaced, or deleted outright, can come back.
 *
 * setSecret surfaces the failure, because there is a user standing there who
 * can retry. The two boot-time callers deliberately do not: there is no such
 * moment during startup, nothing is lost by waiting, and initSecretStore
 * retries the strip on every subsequent boot, so it self-heals as soon as one
 * flush succeeds. The exposure window is a degraded boot landing before that.
 */
async function stripPlaintextCopy() {
  if (appStorage.getItem(OPENROUTER_KEY_KEY) === null) return true;
  appStorage.removeItem(OPENROUTER_KEY_KEY);
  try {
    return await appStorage.flush();
  } catch {
    return false;
  }
}

/** Thrown when the keychain faulted, so the UI can explain rather than guess. */
export const KEYCHAIN_READ_ONLY_MESSAGE =
  'Your system keychain could not be reached, so the key was not saved. '
  + 'Your existing key still works for now. Unlock your keychain and try again.';

/**
 * Thrown when the keychain took the new value but the older plaintext copy
 * could not be deleted. Worded for both saving and clearing, since either can
 * leave that copy behind.
 */
export const PLAINTEXT_CLEANUP_MESSAGE =
  'Your system keychain was updated, but an older copy of your key could not be '
  + 'removed from this app’s data folder. Try again.';

/**
 * Write the credential, replacing whatever is stored.
 *
 * Throws if the keychain rejects the write, so the Settings dialog can tell
 * the user their key was NOT saved rather than silently dropping it. The
 * in-memory copy is only updated after the write is confirmed, so a failed
 * save never leaves the app using a key it did not persist.
 */
export async function setSecret(value) {
  // Browser build: hold it for this session and write it NOWHERE. Persisting
  // here meant appStorage in passthrough, i.e. localStorage — the same sink,
  // reached by the same path, that this module exists to get the credential out
  // of. A key that survives the tab is a key sitting in clear text on disk.
  if (mode === 'session') {
    cached = value;
    return;
  }

  // `read-only` reaches here too, and deliberately so. What that state forbids
  // is writing PLAINTEXT — not trying the keychain. Refusing to even attempt it
  // made KEYCHAIN_READ_ONLY_MESSAGE a lie: it tells the user to unlock their
  // keychain and try again, and trying again could never succeed short of
  // relaunching the app. A keychain fault at boot is usually transient (locked
  // on login, a prompt dismissed), so the retry is the common case, not the
  // exotic one.
  try {
    await invokeSecret('secret_set', { name: SECRET_NAME, value });
  } catch (err) {
    // Still down. Report it in the terms the UI explains, and stay read-only —
    // falling back to a plaintext write would quietly recreate the very
    // exposure the keychain exists to remove, at the moment the user is least
    // likely to notice, since from their side the save would appear to succeed.
    if (mode === 'read-only') throw new Error(KEYCHAIN_READ_ONLY_MESSAGE);
    throw err;
  }

  // The write landed, which proves the keychain is usable again — leave
  // read-only rather than making the user relaunch to escape it.
  mode = 'keychain';
  cached = value;
  // A pre-migration plaintext copy can still exist if an earlier strip failed
  // to flush, or because this session started degraded. Now that a newer
  // credential is durable in the keychain, the stale one is pure liability.
  //
  // Report a failed cleanup instead of resolving: the keychain genuinely holds
  // the new value, but the old file still holds the OLD one, and that is not a
  // detail the user can be left unaware of. CLEARING is the case that bites —
  // the app would say the credential is gone while it stays durable on disk,
  // ready to be served as the fallback on any later boot where the keychain is
  // unavailable. The message says what actually happened rather than claiming
  // nothing was saved.
  if (!(await stripPlaintextCopy())) throw new Error(PLAINTEXT_CLEANUP_MESSAGE);
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
    // Browser build and jsdom tests: no keychain exists, so the credential is
    // held for this session only.
    //
    // Adopt whatever a previous version persisted, so this session keeps
    // working, then delete it — the browser build no longer keeps the key at
    // rest, and leaving the old localStorage entry behind would preserve the
    // exact exposure this change removes. The user re-enters it next session;
    // that is the price of the browser build not having a keychain to use.
    mode = 'session';
    cached = appStorage.getItem(OPENROUTER_KEY_KEY);
    await stripPlaintextCopy();
    return;
  }

  let stored;
  try {
    stored = await invokeSecret('secret_get', { name: SECRET_NAME });
    mode = 'keychain';
  } catch (err) {
    // The keychain could not be reached — locked, access denied, or missing.
    // NOT the same as "no entry stored", which arrives as a resolved `null`:
    // treating the two alike would read as a fresh install and send the
    // migration below down the branch that deletes the plaintext original.
    handleUnavailableKeychain(err);
    return;
  }

  if (stored !== null) {
    cached = stored;
    // The keychain is authoritative once populated. A plaintext copy at this
    // point is a leftover from a migration whose strip did not flush. Result
    // ignored on purpose — see stripPlaintextCopy: no user is present to retry,
    // and this call IS the retry.
    await stripPlaintextCopy();
    return;
  }

  // Keychain is reachable but empty. Migrate a plaintext original if one is
  // there; otherwise the user simply has no key configured yet.
  //
  // `=== null`, NOT truthiness. An upgraded install that CLEARED its key holds
  // '' here as a masking sentinel — getSettings reads a stored empty value as
  // "the user cleared this" and hides any stale credential still sitting in the
  // per-profile blob from a pre-extraction install. Skipping the empty value
  // would leave the keychain with no entry, so getSecret returns null,
  // getSettings falls through to that stale blob key, and a credential the user
  // explicitly deleted comes back to life.
  const plaintext = appStorage.getItem(OPENROUTER_KEY_KEY);
  if (plaintext === null) return;

  try {
    await invokeSecret('secret_set', { name: SECRET_NAME, value: plaintext });
  } catch (err) {
    // The read worked but the write was denied, so the credential's only
    // durable copy is still the plaintext file. Keep it — stripping here is the
    // data-loss bug extractSharedApiKey was written to avoid — and degrade to
    // read-only rather than leaving `mode` at 'keychain'. Left as 'keychain',
    // isKeychainAvailable() would report true and Settings would tell the user
    // their key is held in the system keychain when it plainly is not, with no
    // warning until some later save happened to fail too.
    handleUnavailableKeychain(err);
    return;
  }
  cached = plaintext;
  // Result ignored on purpose, as above: the migration succeeded, and a failed
  // strip is retried by the hydration branch on the next boot.
  await stripPlaintextCopy();
}

/**
 * The OS keychain could not be used on a desktop build — locked, access denied,
 * or otherwise erroring. Degrade to READ-ONLY.
 *
 * Reached two ways: the boot read failed outright, or the read succeeded but
 * the migration write was denied. Both leave the credential's only durable copy
 * in plaintext, so both must report the same thing — claiming the keychain
 * holds a key it does not is the failure mode this exists to prevent.
 *
 * Serving the pre-migration plaintext copy keeps someone who already has a key
 * working: their AI does not go dark because an unrelated OS service faulted,
 * and the file being read is one that already exists — nothing new is exposed.
 *
 * Refusing writes (see setSecret) is the other half, and the more important
 * one. The tempting fallback is to write plaintext "just this once", but that
 * silently recreates the exposure the keychain exists to remove, at the moment
 * the user is least able to notice: from their side the save looks like it
 * worked. Better to fail loudly and let them unlock the keychain.
 *
 * The cost, accepted deliberately: a user with NO key yet cannot configure one
 * until the keychain recovers. That is the narrower harm — a new user is
 * already mid-setup and can act on a clear error, whereas silent plaintext
 * would persist unnoticed for the life of the install.
 *
 * @param {unknown} err the rejection from `secret_get`
 */
function handleUnavailableKeychain(err) {
  mode = 'read-only';
  cached = appStorage.getItem(OPENROUTER_KEY_KEY);
  console.error(
    '[secretStore] keychain unavailable — serving the existing key, refusing writes',
    err,
  );
}
