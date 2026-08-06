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
import { OPENROUTER_KEY_KEY, withoutLegacyCredential, splitPhysicalKey } from './profileKeys.js';
import { createIndexedDbBackend, readSecret, writeSecret } from './browserSecretStore.js';

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

// The per-profile data blob, which can carry a pre-migration credential inside
// `settings.openrouterKey`. Mapped to the active profile by appStorage.
const RESUME_DATA_KEY = 'resume-designer-data';

// The credential, hydrated at boot. `null` means "no key configured".
let cached = null;

// Version of the stored record `cached` came from, so an ordinary save can
// compare-and-set against what it last SAW rather than blindly overwriting.
// Without it, a save that paused while encrypting could land after another
// tab's Clear and resurrect the credential.
let cachedVersion = 0;

// Set when a browser save could not be stored and the value is being held in
// memory instead. NOT a mode: switching to `session` made the failure permanent
// for the tab — every later save took the memory-only branch and RESOLVED, so
// Settings reported success for a save that still vanished on reload. As a flag
// the encrypted store stays the target and the next save retries it. Cleared by
// any adoption, which replaces the very value the flag describes.
let memoryOnlyFallback = false;

// The credential extractSharedApiKey could NOT move out of a data blob, held
// for the session rather than passed down from boot. RECOVERY needs it too —
// it runs long after init, when the boot parameter is out of scope, and the
// value exists nowhere else. Threading it call-by-call also meant every new
// consumer was a fresh chance to forget one, which is how the two recovery
// paths ended up without it.
//
// It cannot go stale: it is only ever consulted when appStorage has no shared
// copy AND the durable store has nothing, and in that state re-migrating it is
// exactly right. Once anything durable holds the credential, every consulting
// branch is unreachable — a `found` browser read and a non-null `secret_get`
// both return before it.
let strandedCredential = null;

// Set once initSecretStore has finished, on every path including the failing
// ones. Read by getSettings to decide whether a null credential is "not asked
// yet" or "asked, and the answer is no". See isSecretStoreReady.
let secretStoreReady = false;

/**
 * Where the credential lives, decided once at boot.
 *
 *  - `keychain`   desktop, keychain answered: the mode nearly everyone is in.
 *  - `read-only`  desktop, keychain unreachable (locked, denied, broken).
 *                 Keeps serving a pre-migration plaintext key so someone who
 *                 already has one is not locked out of their own AI, but
 *                 refuses to write plaintext — though it still RETRIES the
 *                 keychain, since that fault is usually transient.
 *  - `browser`    browser build: encrypted at rest via browserSecretStore,
 *                 under a non-exportable key. Persists properly, so it
 *                 survives the reloads the app does to itself on profile
 *                 switch and backup restore.
 *  - `browser-unreadable`
 *                 a credential IS stored here but will not decrypt. Nothing
 *                 gets written over it, because absence was never established
 *                 — see readSecret's three outcomes.
 *  - `browser-degraded`
 *                 IndexedDB opened but the encrypted write failed (quota, I/O,
 *                 a CryptoKey that would not clone). The credential is still in
 *                 the legacy plaintext entry, deliberately — it is the only
 *                 durable copy. Distinct from `browser` because reporting that
 *                 one while a readable copy sits in localStorage is the same
 *                 lie `read-only` exists to avoid on the desktop side.
 *  - `session`    browser build WITHOUT crypto.subtle or IndexedDB — a
 *                 non-secure context, or private browsing. Memory only. The
 *                 fallback is deliberately memory rather than plaintext: this
 *                 module exists because the key used to go to localStorage,
 *                 the exact sink CodeQL flagged.
 *
 * `session` and `read-only` both mean "nowhere durable to put it", and are
 * still not interchangeable: the first accepts new keys (holding them in
 * memory), the second refuses them.
 */
// ## The whole state space, in one place
//
// Six modes were added one review finding at a time, and every recent bug was
// the same mistake: a rule applied to the state in front of me and not to its
// siblings. The revocation broadcast alone had to be fixed three times —
// healthy tabs, then degraded ones, then unconfirmable reads. Anything touching
// this module should check its change against every ROW here, not just the one
// it came for.
//
//                     getSecret     setSecret            broadcast in   recover
//   keychain          cached        keychain write       n/a            cleanup only
//   read-only         cached (may   retries keychain,    n/a            re-read, adopt
//                     be null)      never plaintext                     (shares boot path)
//   browser           cached        encrypted write      re-read+adopt  n/a
//                                   + announce
//   browser-degraded  cached        retries encrypted    re-read+adopt  re-read, DEFER to
//                     (plaintext)   write, promotes                     a newer value,
//                                   + announce                          else write+announce
//   browser-unreadable null         write REPLACES the   re-read+adopt  re-read, adopt
//                                   unreadable record                    or stay
//                                   + announce
//   session           cached        memory only          DROP cached    n/a
//                                   + announce           (cannot re-read)
//
// Every mutating cell announces, and every mode reacts to an announcement.
// Those two columns were each filled in one row at a time across four separate
// findings, which is the strongest argument for reading the whole table.
//
// Invariants that hold across every row:
//
//  1. A read that FAILED is never treated as a read that found nothing. Only an
//     established absence licenses a migration or an overwrite.
//  2. The old copy is stripped only after the new one is durable — never before.
//  3. A mode never claims a stronger guarantee than the credential's actual
//     resting place, because the UI copy is derived from the mode.
//  4. Whatever the UI tells the user to do must be reachable from the state
//     they are in. Guards that make the prompted action a no-op broke this
//     three separate times.
//  5. Failing closed beats serving a value a broadcast has contradicted.
let mode = 'session';

// The IndexedDB-backed encrypted store, in `browser` mode only.
let browserBackend = null;

/**
 * Cross-tab notification for the browser build.
 *
 * Each tab has its own module-local `cached`, so without this, clearing the key
 * in one tab leaves every other tab holding a credential the user believes they
 * deleted — and going on spending against it until that tab happens to reload.
 * A stale key after a change is a nuisance; a revoked one still in use is not.
 *
 * The message carries NO credential — only the fact that something changed.
 * Receivers re-read from the encrypted store, which is the authority anyway, so
 * the secret is never put onto a second channel to solve a problem about the
 * first.
 */
const CREDENTIAL_CHANNEL = 'on-paper-credential';
let credentialChannel = null;

/**
 * Every credential mutation runs to completion before the next one starts.
 *
 * Each broadcast used to launch an untracked async handler, so closely spaced
 * updates could be adopted out of ORDER: a Clear arriving while a Save's
 * decrypt was still in flight would cache '' first, and the older handler would
 * then cache the paid key back. The revocation undone by scheduling rather than
 * by any wrong decision — every individual step was correct.
 *
 * Local writes share the queue for the same reason: a write and an inbound
 * adoption interleaving leaves `cached` reflecting whichever finished last
 * rather than whichever happened last.
 */
let credentialQueue = Promise.resolve();

function serializeCredentialOp(run) {
  // `run` on both settlements: one failed operation must not stall the queue.
  const result = credentialQueue.then(run, run);
  credentialQueue = result.then(() => {}, () => {});
  return result;
}

function openCredentialChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CREDENTIAL_CHANNEL);
  } catch {
    return null;
  }
}

function announceCredentialChange() {
  try {
    credentialChannel?.postMessage({ type: 'credential-changed' });
  } catch {
    // A closed or unavailable channel must never fail a save that succeeded.
  }
}

/**
 * Another tab changed the credential. Re-read rather than trusting anything on
 * the wire.
 *
 * Runs in EVERY browser mode, not just the healthy one. Gating on `browser`
 * left the revocation hole this broadcast exists to close: a tab sitting in
 * `browser-degraded` still holds the legacy key in `cached`, so a clear
 * broadcast from another tab was dropped on the floor and it carried on
 * spending against the credential the user had deleted. `browser-unreadable`
 * has the same shape — another tab may have just replaced the record it could
 * not read.
 *
 * Adoption goes through the shared path so a remote change promotes this tab
 * out of the degraded state too, strips any readable copy, and cannot diverge
 * from what boot would have concluded. It writes via writeSecret rather than
 * setSecret, so no broadcast is re-emitted and there is no loop.
 *
 * An `unreadable` result is RETRIED and then fails closed, which is the
 * opposite of what boot does — deliberately. At boot, unreadable means "we
 * cannot establish what is stored", and keeping quiet is right. Here a
 * broadcast has already told us the stored credential is no longer what this
 * tab holds. Keeping it because the confirmation failed is the unsafe half of
 * the choice: if that broadcast was a CLEAR, the tab goes on making paid
 * requests with a revoked key indefinitely. So after the retries the cached
 * value is dropped and the tab reports unreadable, which the UI explains and
 * recovery can resolve.
 */
const REMOTE_READ_ATTEMPTS = 3;
const REMOTE_READ_BACKOFF_MS = 50;

// Called after this tab's credential changes for a reason the UI could not see
// coming — another tab saved or cleared it. Everything else that mutates the
// credential is driven by a local action whose caller dispatches
// SETTINGS_UPDATED_EVENT afterwards; a remote adoption has no such caller, so
// without this the other tab's chat UI keeps its old enabled/disabled state
// until reload: a composer still enabled against a key that was cleared, or
// disabled against one that was just saved.
//
// Injected rather than imported. The event constant lives in persistence.js,
// which imports THIS module, so importing it back would close a cycle.
let credentialChangeNotifier = null;

/** Wired by persistence.js at import time. */
export function setCredentialChangeNotifier(fn) {
  credentialChangeNotifier = typeof fn === 'function' ? fn : null;
}

function notifyCredentialChanged() {
  // A listener that throws must not abort an adoption — the credential state is
  // already committed by the time we get here.
  try {
    if (credentialChangeNotifier) credentialChangeNotifier();
  } catch (_) { /* a UI refresh failure is not an adoption failure */ }
}

async function onRemoteCredentialChange() {
  // Memory-only: nothing to re-read, so the only safe response to "something
  // changed elsewhere" is to stop trusting what this tab holds. Without it, two
  // session tabs sharing a key left one spending against a value the user
  // cleared in the other, indefinitely.
  if (!browserBackend) {
    if (mode === 'session') cached = null;
    notifyCredentialChanged();
    return undefined;
  }
  try {
    return await serializeCredentialOp(() => adoptRemoteChange());
  } finally {
    // `finally`, so the fail-closed path notifies too. That path is the one the
    // UI most needs to hear about: it drops `cached` and moves to
    // `browser-unreadable`, so a composer left enabled would send with no key.
    notifyCredentialChanged();
  }
}

async function adoptRemoteChange() {
  for (let attempt = 0; attempt < REMOTE_READ_ATTEMPTS; attempt += 1) {
    const read = await readSecret(browserBackend);
    if (read.status !== 'unreadable') {
      await adoptBrowserRead(read);
      return;
    }
    if (attempt < REMOTE_READ_ATTEMPTS - 1) {
      await new Promise((resolve) => { setTimeout(resolve, REMOTE_READ_BACKOFF_MS); });
    }
  }

  // Could not confirm what is stored. Fail closed rather than keep a value a
  // broadcast has already contradicted.
  mode = 'browser-unreadable';
  cached = null;
  // The one path that discards `cached` WITHOUT going through
  // adoptBrowserRead, which clears this at its top. Left set, Settings ranks
  // the memory-only message above the unreadable one and tells the user the key
  // it just dropped is still good for this session — the opposite of what
  // happened, and it hides that a durable record needs replacing.
  memoryOnlyFallback = false;
}

/**
 * Whether a Settings save should write the credential at all.
 *
 * Extracted from SettingsDialog so it is reachable by vitest — the suite covers
 * service modules only, so this rule passed a green run while being wrong twice
 * in a row. Same reasoning as changeApply's selectUndecided.
 *
 * Two failures pull in opposite directions:
 *
 *  - Writing on EVERY save destroys keys. On an already-migrated install a
 *    failed secret_get leaves nothing to seed the field from, so it shows
 *    empty, and saving to change an unrelated option puts '' over a real
 *    keychain credential as soon as the keychain returns. Blank-but-untouched
 *    means "unknown", not "clear it".
 *  - Writing ONLY when the user typed strands the recovery. When the keychain
 *    was unreachable at startup the field holds the real credential, recovered
 *    from the legacy plaintext file, and the read-only banner tells the user to
 *    save again to move it back into the keychain. Requiring an edit made that
 *    instruction do nothing.
 *
 * A non-empty field in read-only mode is exactly the recoverable case; an empty
 * one is exactly the unknown case. They do not overlap, so both hold.
 *
 * `memoryOnly` is the same shape and was missed a fourth time. A first save the
 * browser refused keeps the key in memory, and the copy says "saving again will
 * retry" — but reopening Settings reseeds the field and clears `edited`, so the
 * advertised retry wrote nothing and the key vanished on reload. Whether a state
 * belongs here is not about what it is CALLED: it is whether the UI promises
 * that Save recovers it and the field holds a value to write. The case table in
 * the tests is the guard against a fifth one, so add a row before a clause.
 *
 * `unreadable` is its own parameter rather than being folded into `readOnly` by
 * the caller, which is how it went wrong: the two look alike — "something is
 * stored, the field cannot be trusted to reflect it" — but they differ in the
 * one respect this rule turns on. A read-only field holds the RECOVERED
 * credential, so a non-empty untouched field is the recovery. An unreadable
 * record leaves `cached` null, so a non-empty field can only be STALE — and
 * with Settings already open when another tab clears the key, saving an
 * unrelated setting wrote that stale value back over the Clear. Only a
 * deliberate edit may replace an unreadable record, which is exactly what the
 * UI asks for ("Enter your key again to replace it").
 *
 * The caller pre-computing `readOnly: isReadOnly() || isBrowserUnreadable()`
 * put that decision back in the untested component, which is what extracting
 * this function was meant to prevent.
 *
 * @param {{edited: boolean, readOnly: boolean, memoryOnly?: boolean,
 *          unreadable?: boolean, value: string}} state
 */
export function shouldWriteCredential({ edited, readOnly, memoryOnly, unreadable, value }) {
  if (unreadable) return !!edited;
  return !!edited || ((!!readOnly || !!memoryOnly) && value !== '');
}

/**
 * Reset the module between tests, mirroring __resetAppStorageForTests. `cached`
 * and `mode` are module state and survive a test otherwise, so one test's saved
 * credential silently answers the next one's reads.
 */
export function __resetSecretStoreForTests() {
  mode = 'session';
  cached = null;
  browserBackend = null;
  credentialChannel = null;
  cleanupPending = false;
  cachedVersion = 0;
  memoryOnlyFallback = false;
  secretStoreReady = false;
  strandedCredential = null;
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
 * True when the credential is encrypted at rest in the browser build — it
 * persists across reloads and restarts, under a key the browser will not
 * export. Distinguishes that from `session`, where nothing could be stored and
 * the key really does vanish, so the UI can stop telling one set of users the
 * other's story.
 */
export function isEncryptedInBrowser() {
  return mode === 'browser' && !memoryOnlyFallback;
}

/**
 * True when a browser save could not be stored and the key is being held for
 * this session only — while the encrypted store is still the target, so the
 * next save retries it rather than silently succeeding into memory forever.
 */
export function isMemoryOnlyFallback() {
  return memoryOnlyFallback;
}

/**
 * True when the browser CAN encrypt but the credential is still sitting in the
 * legacy plaintext entry because an encrypted write failed. The UI must say so
 * and offer the retry — silently keeping clear text while reporting encrypted
 * storage is the failure this state exists to prevent.
 */
export function isBrowserDegraded() {
  return mode === 'browser-degraded';
}

/**
 * True when a credential IS stored in this browser but cannot be decrypted —
 * a failed IndexedDB read, or a wrapping key cleared out from under the
 * ciphertext. Distinct from "no key configured": nothing may be written over it
 * blindly, and the user needs telling rather than silently losing AI.
 */
export function isBrowserUnreadable() {
  return mode === 'browser-unreadable';
}

// Set whenever a strip fails to reach disk: the credential is durable in its
// proper store, but an older READABLE copy survives. Tracked here rather than
// at each call site so it always reflects reality — and so the retry the UI
// prompts for can actually re-run the cleanup. Without it, a recovery that
// promoted the mode back to `keychain` made isReadOnly() false, which made
// shouldWriteCredential() false, which made the prompted Save a no-op that left
// the credential in plaintext for good.
let cleanupPending = false;

/** True when an older readable copy of the credential is still on disk. */
export function isCleanupPending() {
  return cleanupPending;
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
 * Whether initSecretStore has finished, on any path including a failed one.
 *
 * Exists so getSettings can tell "the store has not answered yet" from "the
 * store answered null". They used to be the same observation, which was fine
 * while null could only mean absence — but `browser-unreadable` returns null
 * DELIBERATELY, to fail closed, and the legacy blob fallback was undoing that
 * and putting a possibly-revoked credential back into use. The blob is a
 * MIGRATION source, readable only until this module has spoken.
 */
export function isSecretStoreReady() {
  return secretStoreReady;
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
/**
 * Remove `settings.openrouterKey` from the active profile's blob and from every
 * other profile's physical blob. Returns whether anything changed, so the
 * caller knows whether a flush is worth consulting.
 *
 * Mirrors extractSharedApiKey's sweep, and for the same reason: a credential in
 * a profile the user never opens is still a readable credential on disk.
 */
function scrubEveryBlobCredential() {
  let changed = false;
  // The mapped key: the active physical blob with mapping on, the unprefixed
  // one with it off.
  const keys = [RESUME_DATA_KEY];
  for (const key of appStorage.keys()) {
    const split = splitPhysicalKey(key);
    if (split?.logicalKey === RESUME_DATA_KEY) keys.push(key);
  }
  for (const key of keys) {
    const blob = appStorage.getItem(key);
    if (blob === null) continue;
    // Always the LOGICAL key: withoutLegacyCredential matches on it, and every
    // key in this list is a `resume-designer-data` blob by construction.
    const scrubbed = withoutLegacyCredential(RESUME_DATA_KEY, blob);
    if (scrubbed === blob) continue;
    appStorage.setItem(key, scrubbed);
    changed = true;
  }
  return changed;
}

// `scrubBlob` asks one question: can scrubbing destroy the ONLY durable copy?
// It cannot when something durable of ours already exists (every mode but
// `session`), and it cannot when the credential is EMPTY — a cleared key has
// nothing to destroy, and the blob is then the thing being cleared.
//
// In `session` a save is memory-only, so scrubbing a real key there would
// delete the user's only durable credential and replace it with one that dies
// on reload: PR #89's finding 40 from the other side, caught by its existing
// regression test.
//
// Computed as a DEFAULT rather than passed by each caller, which is the fix for
// the third bug in this area. Three call sites decide this — boot's no-backend
// branch, setSecret's session branch, and the cleanup retry in recovery — and
// the retry was the one still taking the bare default, so a session clear whose
// scrub failed removed the sentinel on retry WITHOUT scrubbing, leaving the next
// boot to unmask a stale blob. One default, no call site to forget.
async function stripPlaintextCopy({ scrubBlob = mode !== 'session' || cached === '' } = {}) {
  // A restore has appStorage's guard armed: removeItem only records into
  // `deferredDuringRestore` — it touches neither the cache nor disk — while
  // flush() can still report true. Worse, the SUCCESSFUL restore path then
  // discards those deferred writes, so the readable credential survives with
  // cleanupPending false, and a transient keychain failure after the restore's
  // reload can serve a key the user had just cleared.
  //
  // Report it as outstanding instead. The restore reloads the app, and boot's
  // own strip is the retry.
  if (appStorage.isRestoreGuardActive()) {
    cleanupPending = true;
    return false;
  }

  // The DATA BLOB is a plaintext copy too, and used not to be scrubbed here at
  // all — extraction owned it, and extraction is exactly what fails in the
  // states that leave one behind. In `session` mode with a stranded blob
  // credential the omission was visible: Clear updated `cached` and nothing
  // else, so it looked like it worked until the next boot read the same
  // plaintext blob and put the paid key straight back.
  //
  // EVERY profile's blob, not just the active one. "The rest are extraction's
  // job on the next boot" is true in the modes that have a next boot to fix
  // them — and false in exactly the mode this matters most for. In `session`
  // there is no durable sentinel to write, so the next boot's sweep reaches an
  // inactive profile's surviving credential and adopts it: a Clear the user
  // performed, undone by a profile they never opened.
  //
  // BEFORE the shared removal below, and the order is load-bearing. An EMPTY
  // shared value is the sentinel MASKING a stale blob credential, and the next
  // lines delete it. Unmasking before the thing being masked is gone is the
  // worst available order: passthrough setItem throws synchronously once
  // localStorage is full, so the sentinel would already be removed and the next
  // boot would scan the blobs with nothing masking them.
  let blobQueued = false;
  if (scrubBlob) {
    try {
      blobQueued = scrubEveryBlobCredential();
    } catch {
      // Storage refused the rewrite. Report it outstanding and leave the shared
      // value ALONE — if it is the empty sentinel, it is still the only thing
      // standing between a stale blob and the next boot's sweep.
      cleanupPending = true;
      return false;
    }
  }

  // A scrub is still OWED — a previous strip left one — and this pass is not
  // permitted to attempt it. That is the non-empty session save: the blob may
  // be the only durable copy, so `scrubBlob` is false by design.
  //
  // Removing the shared value here would drop the empty sentinel that is the
  // sole thing masking that stale blob, and the next boot would extract the old
  // key back OVER the replacement the user just typed — which in this mode
  // exists only in memory, so the old key simply wins. Worse, the flush below
  // would then clear `cleanupPending` and report the whole thing a success.
  //
  // Change nothing and stay pending. Not a dead end: the next boot seeds
  // `cached` from that same sentinel, so `scrubBlob` is true there and the debt
  // is retried — and in this mode a reload is never far away.
  if (cleanupPending && !scrubBlob) return false;

  const sharedQueued = appStorage.getItem(OPENROUTER_KEY_KEY) !== null;
  if (sharedQueued) appStorage.removeItem(OPENROUTER_KEY_KEY);

  const queued = sharedQueued || blobQueued;

  // With nothing of OURS outstanding, do not consult the flush at all.
  // appStorage.flush() reports durability for the whole dirty batch, so an
  // unrelated failing write — a disk-full resume autosave — would otherwise
  // make every credential save throw "an older copy could not be removed" when
  // there was no older copy in the first place, blocking Settings on something
  // that has nothing to do with the key.
  if (!queued && !cleanupPending) return true;

  // Flush even when the cache already shows it gone. A cache miss is NOT proof
  // the file is gone: removeItem drops the key from the cache immediately, and
  // if the disk delete then fails, appStorage re-marks it dirty and leaves the
  // retry to the next flush (see its drain()). Early-returning true on the miss
  // meant the retry the user was told to perform reported success while the old
  // credential sat on disk — the precise "durable === true while it never
  // reached disk" failure appStorage's own comment warns about.
  //
  // The result is still batch-wide, so a failure elsewhere in the same drain is
  // attributed to us. There is no per-key durability signal to ask for, and for
  // a credential that error is the right way round: claiming a readable copy
  // might survive when it does not costs a retry, while the reverse leaves the
  // key on disk with the user told it is gone.
  let ok;
  try {
    ok = await appStorage.flush();
  } catch {
    ok = false;
  }
  cleanupPending = !ok;
  return ok;
}

/** Thrown when the keychain faulted, so the UI can explain rather than guess. */
/**
 * Thrown when the keychain faulted, so the UI can explain rather than guess.
 *
 * Branches on whether a usable credential actually survives. Invariant 3 in the
 * table above: never claim a stronger position than the credential's real one.
 * On an already-migrated install there is no plaintext fallback, so `cached` is
 * null and telling that user their "existing key still works" is false at the
 * moment they most need an accurate account — first-time onboarding, or a save
 * that just failed with nothing configured. The Settings banner was fixed for
 * this; the thrown message said it anyway.
 */
/**
 * Whether a credential that will actually AUTHENTICATE is available right now.
 *
 * Deliberately NOT `getSecret() !== null`. `''` is a stored sentinel meaning the
 * user cleared their key — presence and usability are different questions, and
 * every place that answers one while meaning the other has been a bug. This is
 * the fourth: `getSettings().openrouterKey` resolves to `''`, AI is
 * unconfigured, and a read-only session was telling the user their existing key
 * still worked.
 *
 * Exported so the Settings copy and the thrown save message share one answer.
 * Both derived it independently from `!== null`, which is exactly how the two
 * drifted from the truth in the same way.
 */
export function hasUsableSecret() {
  return cached !== null && cached !== '';
}

/**
 * Whether the store can say AUTHORITATIVELY that no credential is configured.
 *
 * Deliberately not `getSecret() === null`. In `read-only` and
 * `browser-unreadable`, `cached` is null because the store could not be READ —
 * the answer is unknown, not "none". A caller filling a gap must never treat
 * unknown as empty: the Electron merge did, and staged the previous
 * installation's key on top of a current credential that was merely unreadable,
 * which the next boot then served as the read-only fallback.
 *
 * `''` is not a gap either — that is the user's Clear, a decision to preserve.
 * `getSecret() === null` covers it, since a cleared key reads as `''`.
 *
 * Lives here, next to hasUsableSecret, rather than being assembled at the call
 * site from `isReadOnly() || isBrowserUnreadable()`. Pre-combining mode
 * predicates in a caller is what put the shouldWriteCredential bug in
 * SettingsDialog where the suite could not see it, and backupFlow — this
 * function's caller — is likewise outside the vitest surface.
 */
export function hasNoCredentialConfigured() {
  return cached === null && mode !== 'read-only' && mode !== 'browser-unreadable';
}

export function keychainReadOnlyMessage() {
  const lead = 'Your system keychain could not be reached, so the key was not saved.';
  return hasUsableSecret()
    ? `${lead} Your existing key still works for now. Unlock your keychain and try again.`
    : `${lead} Your saved key can’t be read either, so AI features stay unavailable`
      + ' until it unlocks. Unlock your keychain and try again.';
}

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
  // Browser build: encrypted at rest under a key the browser will not export,
  // so it survives reloads without ever putting the credential itself on disk.
  // Clearing stores an empty ciphertext rather than deleting the record, for
  // the same masking reason as the keychain path.
  // `browser-unreadable` included deliberately: replacing a record that cannot
  // be decrypted is exactly what the UI tells the user to do, and a fresh write
  // regenerates the wrapping key if that is what went missing.
  if (mode === 'browser' || mode === 'browser-degraded' || mode === 'browser-unreadable') {
    // Shares the queue with inbound adoptions: a local write and a remote one
    // interleaving would leave `cached` reflecting whichever FINISHED last
    // rather than whichever happened last.
    return serializeCredentialOp(async () => {
      // Nothing durable of ours yet? Then a failed write costs the user
      // everything — AI cannot be configured at all — and retaining the value
      // in memory costs nothing, because there is no stored credential for it
      // to misrepresent. `session` is the mode that already means exactly this.
      // CONFIRMED missing, not merely "cached is null". In
      // `browser-unreadable` a durable record exists and simply cannot be read,
      // so dropping to `session` there would hide it and send every later save
      // past IndexedDB until reload. Only `browser` with nothing stored is an
      // established absence.
      //
      // The question is whether anything DURABLE AND USABLE is stored, which
      // `cached === null` only approximated. Three states answer "no", and the
      // guard has now been wrong about two of them:
      //
      //  - `null`  nothing stored at all. The original case.
      //  - `''`    the Clear sentinel: something IS stored, and what it says is
      //            "no key". Retaining a typed value misrepresents nothing, and
      //            refusing left the user with AI unconfigured after a failed
      //            save — the exact state the null case falls back for.
      //  - `memoryOnlyFallback`  a value is cached but was never stored. The
      //            flag is only ever set when nothing was stored, and any
      //            successful write or adoption clears it.
      //
      // `hasUsableSecret()` already draws the first two together, which is why
      // it is reused here rather than restated. A real stored key is the only
      // case that must NOT fall back: dropping to memory-only there would report
      // nothing persisted while ciphertext sits in the store.
      //
      // The failed write leaves the durable value untouched either way, so a
      // Clear sentinel stays in place and goes on masking any stale blob copy.
      const noDurableCredential = mode === 'browser' && (!hasUsableSecret() || memoryOnlyFallback);

      // Compare-and-set against the newest version this tab can establish.
      //
      // In `browser` mode that is `cachedVersion`, observed at read time. In the
      // degraded and unreadable modes there is none from boot — but "I never
      // observed a version" is not a licence to bypass ordering, which is what
      // an earlier version of this code assumed. Read one now, inside the
      // queue: a record that will not DECRYPT still has a readable version, so
      // even a deliberate replacement of a broken record can be ordered against
      // whatever another tab last wrote.
      //
      // Only a read that FAILS OUTRIGHT leaves nothing to compare — the single
      // `unreadable` exit that carries no version, when the IndexedDB get itself
      // throws. That used to fall through to an unconditional write, which is
      // precisely the ordering bypass this block exists to close: a transient
      // read failure here, another tab clearing the key while this value
      // encrypts, and the replacement lands last and resurrects a credential the
      // user deleted. An unorderable write is refused instead. IndexedDB read
      // failures are transient by nature, so the retry the user is asked for is
      // a real remedy rather than a dead end.
      let expectVersion = cachedVersion;
      if (mode !== 'browser') {
        const seen = await readSecret(browserBackend);
        expectVersion = seen.status === 'missing' ? 0 : seen.version;
        if (expectVersion === undefined) throw new Error(VERSION_UNREADABLE_MESSAGE);
      }

      let result;
      try {
        // Always a compare-and-set. `cachedVersion` is seeded to 0 and only ever
        // assigned a number, and the guard above rules out the other source of
        // `undefined`, so there is no longer any path to an unordered write.
        result = await writeSecret(browserBackend, value, { expectVersion });
      } catch (err) {
        if (noDurableCredential) {
          // Retryable: the mode stays `browser`, so the next save targets the
          // store again. Only the flag records that this value is unstored.
          memoryOnlyFallback = true;
          cached = value;
          // PROACTIVE, not from the finding: announce here too. This is the
          // `session` row's reasoning one mode over — no other tab can learn the
          // new VALUE, because nothing durable was written, but it can learn
          // that its own is stale. Without it, two tabs each holding a
          // memory-only key had no way to revoke: the user clears in one and the
          // other goes on making paid requests. That is the revocation hole this
          // module has already had to close three times, in the one state whose
          // write path always fails.
          announceCredentialChange();
          // Still an error: it was NOT saved, and the caller has to say so.
          // Flagged so onboarding can tell "usable this session" apart from
          // "lost entirely" — the first should not block setup.
          const retained = new Error(MEMORY_ONLY_FALLBACK_MESSAGE);
          retained.retainedInMemory = true;
          throw retained;
        }
        throw err;
      }

      if (!result.wrote) {
        // Another tab moved the credential on while this save was in flight.
        // Adopting theirs rather than retrying ours is the point: a retry would
        // put this (older) value back and undo their Clear.
        const winner = await readSecret(browserBackend);
        await adoptBrowserRead(winner);
        throw new Error(CREDENTIAL_CONFLICT_MESSAGE);
      }

      // The write landed, so encryption is working again — leave the degraded
      // state rather than continuing to report clear-text storage.
      mode = 'browser';
      memoryOnlyFallback = false;
      cached = value;
      cachedVersion = result.version;
      // Tell the other tabs BEFORE the cleanup below, which can throw: a cleared
      // credential must be revoked everywhere even if removing an old readable
      // copy fails.
      announceCredentialChange();
      // A legacy plaintext entry survives a failed migration on purpose. Now that
      // ciphertext is durable it is pure liability, and a failed removal is
      // reported rather than swallowed — same reasoning as the keychain path.
      if (!(await stripPlaintextCopy())) throw new Error(PLAINTEXT_CLEANUP_MESSAGE);
    });
  }

  // No encrypted store available (non-secure context, private browsing): hold
  // it for this session and write it NOWHERE. Falling back to appStorage here
  // would mean localStorage — the same sink, reached by the same path, that
  // this module exists to get the credential out of.
  if (mode === 'session') {
    cached = value;
    // Broadcast even here. There is no shared store, so another tab cannot
    // learn the new VALUE — but it can learn that this one is stale, and a
    // revoked key still in use is the failure that matters. Receivers drop
    // theirs; re-entry is already this mode's normal cost.
    announceCredentialChange();
    // This mode holds nothing durable, but a stranded blob credential IS
    // durable, and leaving it made Clear a lie: memory said gone, the next boot
    // read the same plaintext blob and restored the paid key.
    //
    // ONLY on a clear. A session SAVE must leave the blob alone — it is the
    // only durable copy, and the value replacing it evaporates on reload.
    // `cached` is `value` by now, so the default computes the same answer the
    // explicit argument used to.
    if (!(await stripPlaintextCopy())) throw new Error(PLAINTEXT_CLEANUP_MESSAGE);
    return;
  }

  // `read-only` reaches here too, and deliberately so. What that state forbids
  // is writing PLAINTEXT — not trying the keychain. Refusing to even attempt it
  // made keychainReadOnlyMessage() a lie: it tells the user to unlock their
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
    if (mode === 'read-only') throw new Error(keychainReadOnlyMessage());
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
 * The browser half of boot, run INSIDE the credential queue.
 *
 * Separated so it can be queued: the broadcast listener is attached before this
 * runs, so a clear arriving mid-decrypt would otherwise be adopted first and
 * then overwritten by this older read.
 */
async function initBrowserCredential() {
  if (!browserBackend) {
    // No encrypted store at all (non-secure context, private browsing). Adopt a
    // legacy copy so this session works, then remove it — memory-only is the
    // fallback, never plaintext.
    mode = 'session';
    cached = appStorage.getItem(OPENROUTER_KEY_KEY);
    // Scrub the blobs on exactly the same rule the session WRITE path uses:
    // when the credential is empty. An empty shared value is the user's Clear,
    // and the cleanup below deletes it — so it is the last durable thing
    // masking a stale blob credential extraction could not remove. Without the
    // scrub, the next boot scans those blobs with no sentinel present and
    // adopts the paid key the user deleted.
    //
    // A REAL key must not scrub: in this mode the blob is then the only durable
    // copy, and removing it is PR #89's finding 40.
    await stripPlaintextCopy();
    return;
  }

  const read = await readSecret(browserBackend);
  if (read.status === 'unreadable') {
    // Something IS stored and cannot be read right now. Absence was never
    // established, so adoption must not run: writing a legacy plaintext copy
    // over this record would replace a newer credential, or resurrect one the
    // user deliberately cleared. Leave it all alone.
    //
    // Deliberately does NOT serve a legacy plaintext copy the way the desktop
    // read-only path does, and the asymmetry is the point. On desktop that copy
    // IS the pre-migration credential and the keychain holds nothing newer.
    // Here we know ciphertext exists, so any plaintext beside it is the OLDER
    // value — serving it silently would mean a revoked or superseded key and
    // unexplained failures. The record is left intact and the user is asked to
    // re-enter, which also replaces it.
    mode = 'browser-unreadable';
    cached = null;
    return;
  }
  await adoptBrowserRead(read);
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
export async function initSecretStore({
  backend = null,
  channel = null,
  // A credential extractSharedApiKey could NOT move out of a data blob, because
  // storage refused the write. It is still readable there, so claiming
  // protected storage over it breaks invariant 3 — see the use below.
  strandedPlaintext = null,
} = {}) {
  // In a `finally`, so EVERY exit marks the store as having answered — the
  // early return for an unreachable keychain, the browser return, and a throw
  // alike. Anything else leaves getSettings serving the legacy blob fallback
  // forever on exactly the paths where the credential is least certain.
  try {
    await runInitSecretStore({ backend, channel, strandedPlaintext });
  } finally {
    secretStoreReady = true;
  }
}

async function runInitSecretStore({ backend, channel, strandedPlaintext }) {
  strandedCredential = strandedPlaintext;
  if (!IS_TAURI) {
    // Browser build. Encrypt at rest if the platform allows it, and fall back
    // to memory-only when it does not — never back to plaintext.
    browserBackend = backend || await createIndexedDbBackend();

    // Injectable for tests, like the backend. Absent in older browsers, which
    // simply lose cross-tab sync rather than anything else.
    // Constructing it can THROW as well as be absent — an opaque origin or a
    // storage-restricted context rejects it. Cross-tab sync is optional; an
    // optional feature must never abort boot. Uncaught, this skipped both the
    // encrypted read and the memory-only fallback, and main.js opens the React
    // gate in its `finally` regardless, so the app came up with cached null and
    // AI apparently unconfigured while the credential sat safely in storage.
    credentialChannel = channel || openCredentialChannel();
    if (credentialChannel) {
      credentialChannel.onmessage = (event) => {
        if (event?.data?.type === 'credential-changed') onRemoteCredentialChange();
      };
    }

    // Queued alongside remote changes. The listener above is already live by
    // this point, so without it a clear arriving mid-decrypt would be adopted
    // FIRST and then overwritten by this older startup read — the tab resuming
    // with the revoked key until some later notification. Queuing also means a
    // broadcast that lands during boot simply runs after it and re-reads,
    // rather than being missed.
    await serializeCredentialOp(() => initBrowserCredential());

    // Nothing of ours stored, but a readable credential is sitting in a data
    // blob that extraction could not move — passthrough setItem throws
    // synchronously once localStorage is full, and extraction catches it. Left
    // alone, this tab reported healthy `browser` mode and Settings claimed
    // encrypted storage, while getSettings went on serving the plaintext blob
    // value to every AI request. Indefinitely: nothing retries.
    //
    // `browser-degraded` is that situation exactly — "the write failed, the
    // credential is in ordinary readable browser storage, saving again will
    // retry" — so its copy and its recovery both already fit.
    //
    // Guarded on `cached === null`, which also scopes this to the browser:
    // on desktop the failed write stays in appStorage's cache, so
    // adoptKeychainRead finds it as the legacy copy and migrates it, and
    // `cached` is not null by the time anything gets here.
    // Only `browser-degraded` when there is a backend to be degraded ABOUT.
    // With none, that mode routes Save and Clear through the encrypted store,
    // where readSecret(null) can only fail — so the user cannot even clear the
    // key — and the no-backend broadcast handler drops `cached` for `session`
    // alone, so other tabs keep spending against a credential this one was told
    // to revoke. `session` already means "memory only, and a remote change
    // drops it", which is the truth here; only the value was missing, because
    // initBrowserCredential seeds it from the shared key and extraction never
    // managed to write one.
    // NO-BACKEND ONLY now. With a backend, adoptBrowserRead above owns the
    // stranded value — it migrates it into encrypted storage when it can, and
    // leaves it in the blob when it cannot, which is strictly better than
    // anything decidable out here.
    //
    // Narrowing this also closed a hole I had not been told about: the previous
    // form fired on ANY `cached === null`, including `browser-unreadable`, and
    // flipped it to `browser-degraded` serving the blob value. That mode holds
    // `cached` null precisely because a stored record exists that may be NEWER,
    // so the plaintext beside it is the older value — serving it is the
    // resurrection the mode exists to prevent.
    if (!browserBackend && cached === null && strandedCredential) {
      cached = strandedCredential;   // mode stays `session`
    }
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

  await adoptKeychainRead(stored);
}

/**
 * Take up the state implied by a SETTLED browser read — `found` or `missing`,
 * never `unreadable`.
 *
 * The browser twin of adoptKeychainRead, and shared with recovery for the same
 * reason: recovery that merely flipped the mode back skipped the migration and
 * the cleanup entirely, so a legacy plaintext copy either lingered beside fresh
 * ciphertext or stayed the only durable credential while `cached` read null —
 * with Settings reporting encrypted storage in both cases.
 */
async function adoptBrowserRead(read) {
  // Every exit below overwrites `cached` — with the stored value, with the
  // legacy plaintext one, or with null — so the unstored value the flag was
  // describing is gone by the time any of them returns. Leaving it set outlived
  // its subject: a tab whose first save failed, then adopting another tab's
  // successful write, kept reporting session-only storage in Settings while
  // isEncryptedInBrowser() stayed false, both contradicting the ciphertext it
  // had just taken up. Cleared here, at the top, so no exit can forget it.
  memoryOnlyFallback = false;

  // ENFORCED, not just documented. Every non-`found` status used to fall
  // through to the `missing` treatment, so an `unreadable` read reaching here
  // set `cached` to null — which then satisfies the legacy-migration condition
  // below and wrote the plaintext key over a record we could not even read,
  // resurrecting a credential another tab had just cleared.
  //
  // Three of the four call sites check the status first. The precondition
  // belongs here anyway: it is invariant 1, and the cost of a caller forgetting
  // it lands on the user's credential rather than on a crash.
  if (read.status === 'unreadable') {
    mode = 'browser-unreadable';
    cached = null;
    return;
  }

  mode = 'browser';
  cached = read.status === 'found' ? read.value : null;
  cachedVersion = read.status === 'found' ? (read.version || 0) : 0;

  // Migrate a key an older version left in localStorage. Ordering matters
  // exactly as it does for the keychain: the plaintext original is the only
  // durable copy until the encrypted write lands, so it is stripped after,
  // never before.
  // `?? strandedCredential`: the credential extraction could not move is a
  // legacy copy like any other, it just happens to still be sitting in a data
  // blob rather than in the shared key. The write that failed was to
  // localStorage; IndexedDB is demonstrably working (the read above succeeded),
  // so this is migratable — and migrating it is strictly better than the
  // degraded state, which only holds a memory copy.
  //
  // Load-bearing for the cleanup at the end of this function. That scrub now
  // removes the blob credential, so reaching it WITHOUT having migrated meant
  // deleting the only durable copy and leaving `browser-degraded` claiming the
  // key was in ordinary browser storage when it was in memory alone. The
  // failure branch below returns before the scrub, so a failed encrypt keeps
  // the blob.
  //
  // `??` not `||`: a stored '' Clear must win over any stranded value.
  const legacy = appStorage.getItem(OPENROUTER_KEY_KEY) ?? strandedCredential;
  if (legacy !== null && cached === null) {
    let wrote;
    try {
      // COMPARE-AND-SET on "still nothing stored", the same guard degraded
      // recovery uses. This read-then-write had the identical race and I fixed
      // only the other one: two tabs doing the first migration, one suspended
      // after observing `missing` while the other migrates and then clears —
      // the suspended tab resumes and writes the legacy paid key over the newer
      // empty ciphertext.
      wrote = await writeSecret(browserBackend, legacy, { expectVersion: 0 });
    } catch {
      // Keep the plaintext copy — still the only durable one — and say so.
      // Left at `browser`, isEncryptedInBrowser() would tell Settings only
      // ciphertext is stored while the readable entry sits untouched.
      mode = 'browser-degraded';
      cached = legacy;
      return;
    }

    if (wrote.wrote) {
      cached = legacy;
      cachedVersion = wrote.version;
    } else {
      // Another tab got there between our read and this write; theirs is the
      // newer fact. Read it directly rather than recursing through this
      // function, and fail closed on anything that is not a confirmed value —
      // stripping the legacy copy against an unconfirmed store would destroy
      // the only credential we still hold.
      const winner = await readSecret(browserBackend);
      if (winner.status !== 'found') {
        mode = 'browser-unreadable';
        cached = null;
        cachedVersion = 0;
        return;
      }
      cached = winner.value;
      cachedVersion = winner.version || 0;
    }
  }
  await stripPlaintextCopy();
}

/**
 * Take up the state implied by a SUCCESSFUL `secret_get`.
 *
 * Shared by boot and by the in-session recovery so the recovery cannot skip the
 * migration a boot would have done. That matters: a keychain that is reachable
 * but EMPTY, while a plaintext original still exists, is the migration case —
 * adopting the empty read as the truth there would discard the user's only key.
 */
async function adoptKeychainRead(stored) {
  mode = 'keychain';

  if (stored !== null) {
    cached = stored;
    // The keychain is authoritative once populated. A plaintext copy at this
    // point is a leftover from a migration whose strip did not flush. Result
    // ignored here — no user is necessarily present, and cleanupPending records
    // it either way.
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
  // `?? strandedCredential`, for the case appStorage cannot answer for: on
  // desktop the disk store can fall back to PASSTHROUGH localStorage (see
  // initAppStorage), where setItem throws synchronously on quota instead of
  // queueing — so extraction's shared-key write leaves nothing behind at all.
  // Reading only appStorage then concluded "no key", and with secretStoreReady
  // set that also stops getSettings serving the blob, so a readable credential
  // the user still has became unusable until storage happened to recover.
  //
  // I had scoped the stranded value to the browser on the argument that a
  // desktop failure stays in the write-behind cache. True in CACHED mode only.
  //
  // `??` and not `||`: a stored '' is the user's Clear and must win over any
  // stranded value.
  const plaintext = appStorage.getItem(OPENROUTER_KEY_KEY) ?? strandedCredential;
  if (plaintext === null) { cached = null; return; }

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
 * Re-attempt what a degraded startup left unfinished, WITHOUT touching the
 * credential's value.
 *
 * Two things can be outstanding, and both are things the read-only banner
 * explicitly promises the user can fix without restarting:
 *
 *  - The keychain was unreadable, so on an already-migrated install there was
 *    no plaintext to fall back to and `cached` is null. The user's key exists
 *    and is simply unavailable. Saving cannot fix that — the Settings field is
 *    seeded empty, and writing an unknown empty value over a live credential is
 *    the failure shouldWriteCredential exists to prevent. Re-READING is the fix.
 *  - A strip never reached disk, leaving a readable copy behind.
 *
 * Returns whether anything changed. Throws if the keychain is still unreachable
 * or the cleanup still fails, so the caller can keep showing why.
 */
export const CREDENTIAL_CONFLICT_MESSAGE =
  'Your key was changed in another tab while this was saving, so this save was not applied. '
  + 'Check the key shown and save again if you still want to change it.';

export const MEMORY_ONLY_FALLBACK_MESSAGE =
  'Your key couldn’t be saved in this browser, so it’s being kept for this session only — '
  + 'you’ll need to enter it again next time.';

export const BROWSER_UNREADABLE_MESSAGE =
  'The key stored in this browser could not be read. Enter it again to replace it.';

export const VERSION_UNREADABLE_MESSAGE =
  'Your key couldn’t be saved because this browser’s stored copy couldn’t be checked. '
  + 'Nothing was changed — try saving again.';

export async function recoverSecretStore() {
  // Joins the credential queue. Recovery mutates `cached` and `mode` exactly as
  // a write does, so leaving it outside meant an inbound adoption could
  // interleave with it and the last WRITER stopped being the last decision.
  return serializeCredentialOp(() => runRecovery());
}

async function runRecovery() {
  let changed = false;

  // Retry the decrypt: an IndexedDB read can fail transiently. If it now says
  // the record is genuinely gone, that is a settled answer and normal browser
  // mode resumes — but a still-unreadable record stays untouched.
  if (mode === 'browser-unreadable') {
    const read = await readSecret(browserBackend);
    if (read.status === 'unreadable') throw new Error(BROWSER_UNREADABLE_MESSAGE);
    // adoptBrowserRead, not a bare mode flip: the plaintext reconciliation boot
    // would have done was skipped when we entered this state, and it still has
    // to happen.
    await adoptBrowserRead(read);
    changed = true;
  }

  // Browser: the encrypted write failed at boot, so the credential is still in
  // the readable entry. Retrying is not reachable through the credential write
  // either — the field is untouched, so shouldWriteCredential says no.
  if (mode === 'browser-degraded' && cached !== null) {
    const pending = cached;
    // Re-read before committing, then COMPARE-AND-SET on the write. Another tab
    // may have written while this retry waited its turn, and a clear that
    // committed elsewhere must not be undone by a retry that started before it.
    //
    // The re-read alone was not enough, and this comment used to say so: a
    // remote write landing between the read and the write still won the record.
    // The write below now carries the version the read observed, and the check
    // happens inside the same IndexedDB transaction as the put, so there is no
    // longer a gap for another tab to land in.
    const current = await readSecret(browserBackend);
    if (current.status === 'found') {
      // Someone else already has a credential in place — defer to it.
      await adoptBrowserRead(current);
    } else if (current.status === 'missing') {
      // COMPARE-AND-SET against "still nothing stored" (version 0). Two
      // degraded tabs made the read-then-write version unsafe: A reads
      // missing, B clears and broadcasts, A overwrites B's newer empty
      // ciphertext with its legacy key — and both tabs then converge on a
      // credential the user explicitly cleared. The per-tab queue cannot see
      // B, so the check has to live in the same transaction as the write.
      const wrote = await writeSecret(browserBackend, pending, { expectVersion: 0 });
      if (!wrote.wrote) {
        // Someone got there first. Their value is the newer fact — but the
        // follow-up read can itself fail, and adopting THAT as absence is how
        // the cleared credential would come back. adoptBrowserRead now fails
        // closed on it.
        await adoptBrowserRead(await readSecret(browserBackend));
      } else {
        mode = 'browser';
        cachedVersion = wrote.version;
        // Recovery writes went unannounced entirely, so other tabs kept
        // whatever they had. It is a credential change like any other.
        announceCredentialChange();
        await stripPlaintextCopy();
      }
    } else {
      // Invariant 1: a failed read is not an established absence, so nothing
      // gets written over it.
      throw new Error(BROWSER_UNREADABLE_MESSAGE);
    }
    changed = true;
  }

  if (IS_TAURI && mode === 'read-only') {
    // Propagates if still locked — the caller reports it.
    const stored = await invokeSecret('secret_get', { name: SECRET_NAME });
    await adoptKeychainRead(stored);
    changed = true;
  }

  if (cleanupPending) {
    if (!(await stripPlaintextCopy())) throw new Error(PLAINTEXT_CLEANUP_MESSAGE);
    changed = true;
  }
  return changed;
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
  // PROACTIVE sibling of the adoptKeychainRead fix: this reads the same shared
  // key, so the same stranded write leaves it serving null while the user's
  // credential sits readable in a blob. Same `??` for the same reason.
  cached = appStorage.getItem(OPENROUTER_KEY_KEY) ?? strandedCredential;
  console.error(
    '[secretStore] keychain unavailable — serving the existing key, refusing writes',
    err,
  );
}
