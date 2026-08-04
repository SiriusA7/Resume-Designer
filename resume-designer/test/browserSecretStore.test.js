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
    // Mirrors IndexedDB's single-transaction get+conditional-put.
    update: async (id, decide) => {
      const current = files.has(id) ? files.get(id) : null;
      const next = decide(current);
      if (next) files.set(id, next);
      return { wrote: !!next, current };
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
    expect(await readSecret(backend)).toMatchObject({ status: 'found', value: 'sk-or-v1-secret' });
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
    expect(await readSecret(backend)).toMatchObject({ status: 'found', value: 'sk-two' });
  });

  // Clearing stores an empty ciphertext rather than deleting the record: an
  // absent record and a stored empty one mean different things to getSettings.
  it('round-trips an empty value as the cleared sentinel', async () => {
    const backend = makeBackend();
    await writeSecret(backend, '');
    expect(await readSecret(backend)).toMatchObject({ status: 'found', value: '' });
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
    expect(await readSecret(backend)).toMatchObject({ status: 'found', value: 'sk-ours' });
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
      expect(await readSecret(backend)).toMatchObject({ status: 'unreadable' });
      // Crucially, it did not replace the missing key.
      expect(backend.files.has(WRAP_KEY_ID)).toBe(false);
    });

    it('treats a corrupt record as no credential rather than throwing', async () => {
      const backend = makeBackend();
      await writeSecret(backend, 'sk-secret');
      backend.files.set(SECRET_ID, { iv: new Uint8Array(12), data: new Uint8Array(8) });

      // Boot must not die on a damaged record.
      await expect(readSecret(backend)).resolves.toMatchObject({ status: 'unreadable' });
    });

    it('treats a malformed record as no credential', async () => {
      const backend = makeBackend();
      backend.files.set(SECRET_ID, { nonsense: true });
      await expect(readSecret(backend)).resolves.toMatchObject({ status: 'unreadable' });
    });
  });
});

// A wrapping key can be present and unusable — corrupt IndexedDB, or one stored
// without `encrypt` usage. Truthiness was the whole test, so that value went
// straight to crypto.subtle.encrypt, which rejects. `browser-unreadable` became
// a dead end: the UI says "enter your key again to replace it" and every
// attempt failed on the very key the replacement was meant to escape.
describe('unusable wrapping keys', () => {
  const cases = [
    ['a corrupt non-key value', { nope: true }],
    ['a plain-object impostor missing usages', { type: 'secret', algorithm: { name: 'AES-GCM' } }],
    ['the wrong algorithm', {
      type: 'secret', algorithm: { name: 'AES-CBC' }, usages: ['encrypt', 'decrypt'],
    }],
  ];

  it.each(cases)('replaces %s so a new key can be saved', async (_label, bogus) => {
    const backend = makeBackend();
    backend.files.set(WRAP_KEY_ID, bogus);
    // Ciphertext that nothing could ever have decrypted with that key.
    backend.files.set(SECRET_ID, { iv: new Uint8Array(12), data: new Uint8Array(8), version: 3 });
    expect(await readSecret(backend)).toMatchObject({ status: 'unreadable' });

    // The action the UI prescribes must actually work.
    await writeSecret(backend, 'sk-replacement');

    expect(await readSecret(backend)).toMatchObject({
      status: 'found', value: 'sk-replacement',
    });
  });

  // A key stored with only `decrypt` is structurally a CryptoKey and still
  // cannot encrypt — the "non-encrypt-capable" half.
  it('replaces a real CryptoKey that cannot encrypt', async () => {
    const backend = makeBackend();
    backend.files.set(WRAP_KEY_ID, await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    ));

    await writeSecret(backend, 'sk-replacement');

    expect(await readSecret(backend)).toMatchObject({
      status: 'found', value: 'sk-replacement',
    });
  });

  // The dangerous direction. A USABLE key must never be replaced: doing so
  // destroys a credential that was perfectly readable, which is the whole
  // reason the check is structural rather than `instanceof`.
  it('never replaces a usable key', async () => {
    const backend = makeBackend();
    await writeSecret(backend, 'sk-original');
    const key = backend.files.get(WRAP_KEY_ID);

    await writeSecret(backend, 'sk-second');

    expect(backend.files.get(WRAP_KEY_ID)).toBe(key);
    expect(await readSecret(backend)).toMatchObject({ status: 'found', value: 'sk-second' });
  });
});

// Two tabs replacing the SAME unusable key. An unconditional put let the
// loser's key land after the winner had already encrypted with theirs — and the
// loser's own ciphertext write was then rejected as stale by compare-and-set.
// Good ciphertext, wrong key: unreadable after reload, which is worse than the
// corruption being repaired.
describe('concurrent wrapping-key replacement', () => {
  it('leaves the winner’s key and ciphertext readable', async () => {
    const backend = makeBackend();
    backend.files.set(WRAP_KEY_ID, { nope: 'unusable' });

    // Tab A replaces the bad key and stores a credential under its own.
    await writeSecret(backend, 'sk-from-tab-a');
    const winnerKey = backend.files.get(WRAP_KEY_ID);
    const winnerVersion = backend.files.get(SECRET_ID).version;

    // Tab B started BEFORE A and still believes the key is the unusable one.
    // Its secret write carries the version it observed then, so CAS rejects it.
    __resetBrowserSecretStoreForTests();
    let servedStale = false;
    const staleView = {
      ...backend,
      get: async (id) => {
        if (id === WRAP_KEY_ID && !servedStale) {
          servedStale = true;
          return { nope: 'unusable' };
        }
        return backend.get(id);
      },
    };

    const result = await writeSecret(staleView, 'sk-from-tab-b', { expectVersion: 0 });

    // B's credential is correctly refused as stale...
    expect(result.wrote).toBe(false);
    // ...and, the point of the fix, B did NOT displace A's key on the way.
    expect(backend.files.get(WRAP_KEY_ID)).toBe(winnerKey);
    expect(backend.files.get(SECRET_ID).version).toBe(winnerVersion);
    // So A's credential is still decryptable — the state the bug destroyed.
    expect(await readSecret(backend)).toMatchObject({
      status: 'found', value: 'sk-from-tab-a',
    });
  });
});
