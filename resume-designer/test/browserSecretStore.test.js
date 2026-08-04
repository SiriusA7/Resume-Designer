import { describe, it, expect } from 'vitest';
import { readSecret, writeSecret } from '../src/browserSecretStore.js';

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
    delete: async (id) => { files.delete(id); },
  };
}

const SECRET_ID = 'openrouter-key-v1';
const WRAP_KEY_ID = 'wrap-key-v1';

describe('browserSecretStore', () => {
  it('round-trips a credential', async () => {
    const backend = makeBackend();
    await writeSecret(backend, 'sk-or-v1-secret');
    expect(await readSecret(backend)).toBe('sk-or-v1-secret');
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
    expect(await readSecret(backend)).toBe('sk-two');
  });

  // Clearing stores an empty ciphertext rather than deleting the record: an
  // absent record and a stored empty one mean different things to getSettings.
  it('round-trips an empty value as the cleared sentinel', async () => {
    const backend = makeBackend();
    await writeSecret(backend, '');
    expect(await readSecret(backend)).toBe('');
    expect(backend.files.has(SECRET_ID)).toBe(true);
  });

  describe('unreadable records', () => {
    it('reports nothing stored when there is no record', async () => {
      expect(await readSecret(makeBackend())).toBeNull();
    });

    // Generating a wrapping key during a READ would produce one that cannot
    // decrypt the stored ciphertext — turning "could not read" into "you have
    // no key" and destroying any chance of a later successful read.
    it('does not mint a wrapping key while reading', async () => {
      const backend = makeBackend();
      await writeSecret(backend, 'sk-secret');
      backend.files.delete(WRAP_KEY_ID);

      expect(await readSecret(backend)).toBeNull();
      // Crucially, it did not replace the missing key.
      expect(backend.files.has(WRAP_KEY_ID)).toBe(false);
    });

    it('treats a corrupt record as no credential rather than throwing', async () => {
      const backend = makeBackend();
      await writeSecret(backend, 'sk-secret');
      backend.files.set(SECRET_ID, { iv: new Uint8Array(12), data: new Uint8Array(8) });

      // Boot must not die on a damaged record.
      await expect(readSecret(backend)).resolves.toBeNull();
    });

    it('treats a malformed record as no credential', async () => {
      const backend = makeBackend();
      backend.files.set(SECRET_ID, { nonsense: true });
      await expect(readSecret(backend)).resolves.toBeNull();
    });
  });
});
