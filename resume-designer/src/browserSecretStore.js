/**
 * Encrypted-at-rest credential storage for the browser build.
 *
 * The desktop app hands the API key to the OS keychain. A browser has no
 * keychain, and the first attempt at that gap — hold it in memory only — was
 * safe but hostile: the key did not survive a reload, and the app reloads
 * itself on profile switch, profile create/delete and backup restore, so users
 * lost it constantly.
 *
 * The fix is the one CodeQL's own alert text prescribes for this finding:
 * "Ensure that sensitive information is always encrypted before being stored
 * ... decrypt only at the point where it is necessary for it to be used in
 * cleartext." What goes to disk here is ciphertext, so persisting it is not
 * clear-text storage.
 *
 * ## Why this is worth more than obfuscation
 *
 * The AES-GCM wrapping key is generated with `extractable: false` and stored as
 * a live `CryptoKey` in IndexedDB. The browser keeps the raw bytes in its own
 * key store and `crypto.subtle.exportKey` REJECTS.
 *
 * ## What that does and does not buy — copy must match THIS, not the above
 *
 * It buys: the credential is never written in readable form, so anything that
 * scrapes storage values, or a stray export of just this object store, yields
 * ciphertext. That is a real improvement on the localStorage value it replaces.
 *
 * It does NOT buy two things that are easy to assume:
 *
 *  - Protection from same-origin script. Any script on this page — including an
 *    injected one — can fetch the same `CryptoKey` handle and ask the browser
 *    to decrypt. It cannot obtain the raw bytes; it does not need them.
 *  - Machine binding. The wrapping key and the ciphertext live in the SAME
 *    IndexedDB store, so a copy of the whole browser profile carries both
 *    halves. `extractable: false` blocks `exportKey`; it does not make the key
 *    unusable in a browser that loads a copied profile. A profile backup should
 *    be treated as containing the API key.
 *
 * Those limits are inherent to a browser-side secret, which is why the desktop
 * build uses the OS keychain instead.
 *
 * ## Backend injection
 *
 * The IndexedDB access is behind a small {get, put, add, update} backend,
 * mirroring `initAppStorage({ backend })`, so the logic is reachable from
 * vitest — jsdom ships no IndexedDB. `update` is the compare-and-set: a get and
 * a conditional put inside ONE transaction.
 */

// Bumped only if the stored shape changes; a mismatch is treated as "no key",
// never as a decrypt to guess at.
const WRAP_KEY_ID = 'wrap-key-v1';
const SECRET_ID = 'openrouter-key-v1';

const DB_NAME = 'on-paper-secrets';
const DB_VERSION = 1;
const STORE = 'secrets';

/**
 * Whether this environment can encrypt at rest.
 *
 * False in a non-secure context (crypto.subtle is unavailable off
 * localhost/https) and wherever IndexedDB is blocked, which includes some
 * private-browsing modes. Callers fall back to memory-only rather than
 * downgrading to plaintext.
 */
export function isEncryptedStorageSupported() {
  return typeof indexedDB !== 'undefined'
    && typeof crypto !== 'undefined'
    && !!crypto.subtle
    && typeof crypto.getRandomValues === 'function';
}

/**
 * Run one operation and settle on the TRANSACTION, not the request.
 *
 * A request's `success` fires before the transaction commits, and the
 * transaction can still abort afterwards — quota, I/O error, a competing
 * upgrade. Resolving on request success would let writeSecret report the
 * credential as durable, and let the caller delete the legacy plaintext copy,
 * for a write that never landed: no usable credential after the next reload.
 */
function runTx(db, mode, work) {
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const req = work(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result === undefined ? null : result);
    tx.onabort = () => reject(tx.error || new Error('indexeddb transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('indexeddb transaction failed'));
  });
}

/** The real IndexedDB backend. Returns null when the database cannot open. */
export async function createIndexedDbBackend() {
  if (!isEncryptedStorageSupported()) return null;
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('indexeddb blocked'));
    });
  } catch {
    return null;
  }
  return {
    get: (id) => runTx(db, 'readonly', (store) => store.get(id)),
    put: (id, value) => runTx(db, 'readwrite', (store) => store.put(value, id)),
    // Read and conditional write in ONE transaction — the compare-and-set the
    // credential record needs. IndexedDB serializes transactions over a store,
    // so nothing from another tab can land between the get and the put. A
    // separate get() followed by a put() cannot offer that, which is exactly
    // the window a degraded tab's recovery could overwrite a newer clear
    // through.
    update: (id, decide) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE, 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      const outcome = { wrote: false, current: null };
      req.onsuccess = () => {
        outcome.current = req.result === undefined ? null : req.result;
        // `decide` must stay SYNCHRONOUS: awaiting anything non-IDB here lets
        // the transaction auto-close before the put is issued.
        const next = decide(outcome.current);
        if (next) {
          store.put(next, id);
          outcome.wrote = true;
        }
      };
      tx.oncomplete = () => resolve(outcome);
      tx.onabort = () => reject(tx.error || new Error('indexeddb transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('indexeddb transaction failed'));
    }),
    // `add` rejects when the id already exists. That is what makes the
    // wrapping-key creation below safe against a second tab racing us: the
    // loser finds out rather than silently overwriting a key that existing
    // ciphertext was encrypted under.
    add: (id, value) => runTx(db, 'readwrite', (store) => store.add(value, id)),
  };
}

/**
 * The wrapping key, or null when none has been created yet.
 *
 * Read paths use this rather than `ensureWrappingKey`: generating a fresh key
 * during a read would produce one that cannot decrypt the stored ciphertext,
 * turning "I could not read your key" into "you have no key" AND destroying any
 * chance of a later successful read.
 */
async function loadWrappingKey(backend) {
  const key = await backend.get(WRAP_KEY_ID);
  return key || null;
}

// One in-flight creation at a time. Two overlapping first-time saves — a
// double-click on Save is enough — would otherwise both see no key, generate
// different ones, and write key and ciphertext in separate transactions. The
// final ciphertext then need not match the final key, and the next read fails
// to decrypt and reports no credential at all.
let creating = null;

async function ensureWrappingKey(backend) {
  const existing = await loadWrappingKey(backend);
  if (existing) return existing;
  if (!creating) {
    creating = (async () => {
      // extractable: false is the whole point — see the module note.
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
      try {
        // `add`, not `put`: if another context stored one between our read and
        // this write, we must lose rather than overwrite a key that their
        // ciphertext depends on.
        await backend.add(WRAP_KEY_ID, key);
        return key;
      } catch {
        const winner = await loadWrappingKey(backend);
        if (winner) return winner;
        throw new Error('could not create an encryption key for this browser');
      }
    })().finally(() => { creating = null; });
  }
  return creating;
}

/** Test seam: drop the in-flight creation between cases. */
export function __resetBrowserSecretStoreForTests() {
  creating = null;
}

/**
 * Decrypt the stored credential.
 *
 * Reports THREE outcomes, and they are not interchangeable — the same rule
 * commands/secret.rs states for the keychain, for the same reason:
 *
 *   { status: 'found', value }  a credential is stored and readable
 *   { status: 'missing' }       nothing is stored
 *   { status: 'unreadable' }    something IS stored but cannot be read now —
 *                               a failed IndexedDB read, a wrapping key cleared
 *                               out from under the ciphertext, a corrupt record
 *
 * Collapsing `unreadable` into `missing` is what makes it dangerous. The caller
 * would read it as "the user has no key", disable AI for the session, and — far
 * worse — let the migration branch write a legacy plaintext copy OVER the
 * unreadable record, replacing a newer credential or resurrecting one the user
 * deliberately cleared.
 *
 * Never throws: boot must not die on a damaged record.
 */
export async function readSecret(backend) {
  let record;
  try {
    record = await backend.get(SECRET_ID);
  } catch {
    // The read itself failed. Absence was not established, so nothing may be
    // written over this.
    return { status: 'unreadable' };
  }
  if (!record) return { status: 'missing' };
  // A record we cannot DECRYPT still has a readable `version`, and ordering
  // needs that even when the payload is useless — otherwise "cannot read it"
  // becomes a licence to overwrite whatever another tab just wrote.
  const version = record.version || 0;
  if (!record.iv || !record.data) return { status: 'unreadable', version };

  let key;
  try {
    key = await loadWrappingKey(backend);
  } catch {
    return { status: 'unreadable', version };
  }
  // Ciphertext with no key is stored-but-undecryptable, NOT absent.
  if (!key) return { status: 'unreadable', version };

  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data);
    // `version` lets a caller write only if nothing else has since — see
    // writeSecret's expectVersion. Records written before versioning read as 0.
    return {
      status: 'found',
      value: new TextDecoder().decode(plain),
      version: record.version || 0,
    };
  } catch {
    return { status: 'unreadable', version };
  }
}

/**
 * Encrypt and store the credential. Throws on failure so the caller can tell
 * the user their key was not saved, rather than silently keeping a value that
 * will be gone after the next reload.
 *
 * Returns `{ wrote, version }`. With `expectVersion` it is a compare-and-set: the
 * write is skipped, and `false` returned, if the stored record has moved on
 * since the caller read it. That is how a slow recovery is stopped from
 * overwriting a clear another tab committed in the meantime — a per-tab queue
 * cannot see other tabs, and a read followed by a separate write leaves a
 * window between them.
 *
 * A fresh IV per write: AES-GCM catastrophically loses confidentiality if an IV
 * is ever reused under the same key, and this key is long-lived by design.
 */
export async function writeSecret(backend, value, { expectVersion } = {}) {
  const key = await ensureWrappingKey(backend);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(value),
  );

  // Encryption happens BEFORE the transaction on purpose: awaiting a non-IDB
  // promise inside one lets it auto-close.
  let written = 0;
  const { wrote } = await backend.update(SECRET_ID, (current) => {
    const currentVersion = current?.version || 0;
    // A caller that observed a specific version writes only if nothing has
    // landed since. Everything happens inside one transaction, and IndexedDB
    // serializes transactions over the store, so no other tab can slip between
    // the check and the write.
    if (expectVersion !== undefined && currentVersion !== expectVersion) return null;
    written = currentVersion + 1;
    return { iv, data, version: written };
  });
  // The new version comes back so the caller can keep compare-and-setting
  // against what it last observed, rather than re-reading after every write.
  return { wrote, version: wrote ? written : null };
}

// No delete: clearing stores an EMPTY ciphertext instead, exactly as the
// keychain path stores an empty value. An absent record and a stored empty one
// mean different things to getSettings — the second masks a stale credential
// left in a per-profile blob by a pre-extraction install, the first would let
// it resurface.
