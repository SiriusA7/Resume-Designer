import { describe, it, expect, beforeEach } from 'vitest';
import {
  readSecret, writeSecret, __resetBrowserSecretStoreForTests,
} from '../src/browserSecretStore.js';

// The browser build has no keychain. Holding the key in memory was safe but
// hostile — the app reloads itself on profile switch, profile create/delete and
// backup restore, so users lost it constantly. Encrypting before storing is the
// remediation CodeQL's own alert text prescribes, so the credential persists
// without anything readable reaching disk.
//
// jsdom ships no IndexedDB, hence the injected backend — the same shape
// initAppStorage({ backend }) already uses.

function makeBackend() {
  const files = new Map();
  return {
    files,
    get: async (id) => (files.has(id) ? files.get(id) : null),
    put: async (id, value) => { files.set(id, value); },
    // Mirrors IndexedDB's add(): rejects rather than overwriting.
    add: async (id, value) => {
      if (files.has(id)) throw new Error('ConstraintError');
      files.set(id, value);
    },
  };
}

const SECRET_ID = 'openrouter-key-v1';
const WRAP_KEY_ID = 'wrap-key-v1';

describe('browserSecretStore', () => {
  beforeEach(() => { __resetBrowserSecretStoreForTests(); });

  it('round-trips a credential', async () => {
    const backend = makeBackend();
    await writeSecret(backend, 'sk-or-v1-secret');
    expect(await readSecret(backend)).toEqual({ status: 'found', value: 'sk-or-v1-secret' });
  });

  // The point of the exercise: what lands in storage is not the credential.
  it('stores ciphertext, not the key', async () => {
    const backend = makeBackend();
    await writeSecret(backend, 'sk-or-v1-secret');

    const record = backend.files.get(SECRET_ID);
    const bytes = new Uint8Array(record.data);
    const asText = new TextDecoder().decode(bytes);
    expect(asText).not.toContain('sk-or-v1-secret');
    // Nor anywhere else in the serialized record.
    expect(JSON.stringify(Array.from(bytes))).not.toContain('sk-or');
  });

  // The property that makes this more than obfuscation: the browser holds the
  // key material and will not hand it back, so copying the profile off the
  // machine yields ciphertext and an opaque handle.
  it('wraps under a key the browser refuses to export', async () => {
    const backend = makeBackend();
    await writeSecret(backend, 'sk-secret');

    const wrapKey = backend.files.get(WRAP_KEY_ID);
    expect(wrapKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', wrapKey)).rejects.toThrow();
  });

  // AES-GCM loses confidentiality outright if an IV repeats under one key, and
  // this key is long-lived by design.
  it('uses a fresh IV for every write', async () => {
    const backend = makeBackend();
    await writeSecret(backend, 'sk-one');
    const first = Array.from(new Uint8Array(backend.files.get(SECRET_ID).iv));
    await writeSecret(backend, 'sk-two');
    const second = Array.from(new Uint8Array(backend.files.get(SECRET_ID).iv));

    expect(first).not.toEqual(second);
    expect(await readSecret(backend)).toEqual({ status: 'found', value: 'sk-two' });
  });

  // Clearing stores an empty ciphertext rather than deleting the record: an
  // absent record and a stored empty one mean different things to getSettings.
  it('round-trips an empty value as the cleared sentinel', async () => {
    const backend = makeBackend();
    await writeSecret(backend, '');
    expect(await readSecret(backend)).toEqual({ status: 'found', value: '' });
    expect(backend.files.has(SECRET_ID)).toBe(true);
  });

  // Two first-time saves in flight at once — a double-click on Save is enough.
  // Both see no wrapping key; if both generate one, the key and the ciphertext
  // land in separate writes and the final ciphertext need not match the final
  // key. The next read then fails to decrypt and reports no credential at all.
  it('serializes wrapping-key creation across overlapping writes', async () => {
    const backend = makeBackend();

    await Promise.all([writeSecret(backend, 'sk-a'), writeSecret(backend, 'sk-b')]);

    // Exactly one key exists, and whichever ciphertext won decrypts under it.
    const out = await readSecret(backend);
    expect(out.status).toBe('found');
    expect(out.value).toMatch(/^sk-[ab]$/);
  });

  // The cross-context case the in-flight guard cannot cover: another tab stored
  // a key between our read and our write. `add` makes us lose rather than
  // overwrite a key their ciphertext already depends on.
  it('defers to a wrapping key another context stored first', async () => {
    const backend = makeBackend();
    // Someone else got there first, and wrote ciphertext under their key.
    await writeSecret(backend, 'sk-theirs');
    const theirKey = backend.files.get(WRAP_KEY_ID);
    __resetBrowserSecretStoreForTests();

    await writeSecret(backend, 'sk-ours');

    // Their key survived, so their earlier ciphertext would still decrypt.
    expect(backend.files.get(WRAP_KEY_ID)).toBe(theirKey);
    expect(await readSecret(backend)).toEqual({ status: 'found', value: 'sk-ours' });
  });

  describe('unreadable records', () => {
    it('reports nothing stored when there is no record', async () => {
      expect(await readSecret(makeBackend())).toEqual({ status: 'missing' });
    });

    // Generating a wrapping key during a READ would produce one that cannot
    // decrypt the stored ciphertext — turning "could not read" into "you have
    // no key" and destroying any chance of a later successful read.
    it('does not mint a wrapping key while reading', async () => {
      const backend = makeBackend();
      await writeSecret(backend, 'sk-secret');
      backend.files.delete(WRAP_KEY_ID);

      // UNREADABLE, not missing: ciphertext is present, so absence was never
      // established and nothing may be written over it.
      expect(await readSecret(backend)).toEqual({ status: 'unreadable' });
      // Crucially, it did not replace the missing key.
      expect(backend.files.has(WRAP_KEY_ID)).toBe(false);
    });

    it('treats a corrupt record as no credential rather than throwing', async () => {
      const backend = makeBackend();
      await writeSecret(backend, 'sk-secret');
      backend.files.set(SECRET_ID, { iv: new Uint8Array(12), data: new Uint8Array(8) });

      // Boot must not die on a damaged record.
      await expect(readSecret(backend)).resolves.toEqual({ status: 'unreadable' });
    });

    it('treats a malformed record as no credential', async () => {
      const backend = makeBackend();
      backend.files.set(SECRET_ID, { nonsense: true });
      await expect(readSecret(backend)).resolves.toEqual({ status: 'unreadable' });
    });
  });
});
