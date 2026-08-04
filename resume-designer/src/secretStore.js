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

// The credential, hydrated at boot. `null` means "no key configured".
let cached = null;

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

async function onRemoteCredentialChange() {
  // Memory-only: nothing to re-read, so the only safe response to "something
  // changed elsewhere" is to stop trusting what this tab holds. Without it, two
  // session tabs sharing a key left one spending against a value the user
  // cleared in the other, indefinitely.
  if (!browserBackend) {
    if (mode === 'session') cached = null;
    return undefined;
  }
  return serializeCredentialOp(() => adoptRemoteChange());
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
 * @param {{edited: boolean, readOnly: boolean, value: string}} state
 */
export function shouldWriteCredential({ edited, readOnly, value }) {
  return !!edited || (!!readOnly && value !== '');
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
  return mode === 'browser';
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

  const queued = appStorage.getItem(OPENROUTER_KEY_KEY) !== null;
  if (queued) appStorage.removeItem(OPENROUTER_KEY_KEY);

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
export function keychainReadOnlyMessage() {
  const lead = 'Your system keychain could not be reached, so the key was not saved.';
  return cached !== null
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
      await writeSecret(browserBackend, value);
      // The write landed, so encryption is working again — leave the degraded
      // state rather than continuing to report clear-text storage.
      mode = 'browser';
      cached = value;
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
export async function initSecretStore({ backend = null, channel = null } = {}) {
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

  // Migrate a key an older version left in localStorage. Ordering matters
  // exactly as it does for the keychain: the plaintext original is the only
  // durable copy until the encrypted write lands, so it is stripped after,
  // never before.
  const legacy = appStorage.getItem(OPENROUTER_KEY_KEY);
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

    if (wrote) {
      cached = legacy;
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
        return;
      }
      cached = winner.value;
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
  const plaintext = appStorage.getItem(OPENROUTER_KEY_KEY);
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
export const BROWSER_UNREADABLE_MESSAGE =
  'The key stored in this browser could not be read. Enter it again to replace it.';

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
      if (!wrote) {
        // Someone got there first. Their value is the newer fact — but the
        // follow-up read can itself fail, and adopting THAT as absence is how
        // the cleared credential would come back. adoptBrowserRead now fails
        // closed on it.
        await adoptBrowserRead(await readSecret(browserBackend));
      } else {
        mode = 'browser';
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
  cached = appStorage.getItem(OPENROUTER_KEY_KEY);
  console.error(
    '[secretStore] keychain unavailable — serving the existing key, refusing writes',
    err,
  );
}
