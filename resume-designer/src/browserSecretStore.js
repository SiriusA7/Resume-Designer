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

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    get: (id) => request(tx('readonly').get(id)),
    put: (id, value) => request(tx('readwrite').put(value, id)),
    delete: (id) => request(tx('readwrite').delete(id)),
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

async function ensureWrappingKey(backend) {
  const existing = await loadWrappingKey(backend);
  if (existing) return existing;
  // extractable: false is the whole point — see the module note.
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  await backend.put(WRAP_KEY_ID, key);
  return key;
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
