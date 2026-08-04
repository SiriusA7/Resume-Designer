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
 * key store; `crypto.subtle.exportKey` on it REJECTS, so no script — ours or an
 * injected one — can read the key material out and carry it away. Copying the
 * browser profile off the machine yields ciphertext and an opaque key handle.
 *
 * What it does NOT defend against, stated plainly: script running on this
 * origin can still ask the browser to decrypt, because it can use the handle
 * even though it cannot read it. That is inherent to any browser-side secret,
 * and it is a strictly smaller exposure than a readable key sitting in
 * localStorage — which is what this replaces.
 *
 * ## Backend injection
 *
 * The IndexedDB access is behind a small {get, put, delete} backend, mirroring
 * `initAppStorage({ backend })`, so the logic is reachable from vitest — jsdom
 * ships no IndexedDB.
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
 * Decrypt the stored credential. Returns null when there is nothing stored, and
 * also when the record cannot be decrypted — a wrapping key cleared out from
 * under the ciphertext, or a corrupt record. Both mean "no usable credential",
 * and neither is worth failing boot over.
 */
export async function readSecret(backend) {
  try {
    const record = await backend.get(SECRET_ID);
    if (!record || !record.iv || !record.data) return null;
    const key = await loadWrappingKey(backend);
    if (!key) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * Encrypt and store the credential. Throws on failure so the caller can tell
 * the user their key was not saved, rather than silently keeping a value that
 * will be gone after the next reload.
 *
 * A fresh IV per write: AES-GCM catastrophically loses confidentiality if an IV
 * is ever reused under the same key, and this key is long-lived by design.
 */
export async function writeSecret(backend, value) {
  const key = await ensureWrappingKey(backend);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(value),
  );
  await backend.put(SECRET_ID, { iv, data });
}

// No delete: clearing stores an EMPTY ciphertext instead, exactly as the
// keychain path stores an empty value. An absent record and a stored empty one
// mean different things to getSettings — the second masks a stale credential
// left in a per-profile blob by a pre-extraction install, the first would let
// it resurface.
