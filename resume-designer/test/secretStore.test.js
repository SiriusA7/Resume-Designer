import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OPENROUTER_KEY_KEY } from '../src/profileKeys.js';
import { shouldWriteCredential } from '../src/secretStore.js';

// The OpenRouter API key used to sit in appStorage like resume content, which
// on desktop means a plaintext file under app_data_dir — a directory that gets
// swept into Time Machine, Backblaze and folder-sync tools, carrying the
// credential into every backup image the user makes. It now lives in the OS
// keychain (commands/secret.rs), and this module owns the move.
//
// The invariant under test is the one profiles.js#extractSharedApiKey
// established: NEVER strip the plaintext copy until the keychain copy is
// durable. Get that backwards and a failed keychain write leaves the user with
// no credential at all after a restart.

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invokeMock(...args) }));

// appStorage runs in passthrough mode under jsdom, so its writes land in
// localStorage under the unmapped key (the credential is a SHARED key, so it
// is never profile-namespaced). Asserting against localStorage directly keeps
// the test independent of module identity across resetModules().
const plaintext = () => localStorage.getItem(OPENROUTER_KEY_KEY);
const setPlaintext = (v) => localStorage.setItem(OPENROUTER_KEY_KEY, v);

/** Load a fresh copy of the module, since IS_TAURI is read at import time. */
async function loadStore({ tauri = true } = {}) {
  vi.resetModules();
  if (tauri) window.isTauri = true;
  else delete window.isTauri;
  return import('../src/secretStore.js');
}

describe('secretStore', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
  });

  // This rule got it wrong in both directions across successive rounds of
  // review, each time while living in SettingsDialog where the suite could not
  // see it. Enumerated here rather than spot-checked, because the failures came
  // from states nobody thought to check, not from bad logic in the ones they did.
  describe('shouldWriteCredential', () => {
    const cases = [
      // edited, readOnly, value            expected  why
      [true, false, 'sk-new', true, 'user typed a key normally'],
      [true, false, '', true, 'user deliberately emptied the field'],
      [true, true, 'sk-new', true, 'user typed while degraded'],
      [false, false, 'sk-existing', false, 'untouched save of an unrelated setting'],
      [false, false, '', false, 'untouched and empty in normal mode'],
      // THE round-nine bug: already migrated, secret_get failed, nothing to
      // seed from. Writing here puts '' over a live keychain credential.
      [false, true, '', false, 'degraded with NO fallback — value is unknown, not empty'],
      // THE round-eleven bug: degraded WITH a recovered plaintext key. The
      // banner tells the user to save again to move it back into the keychain;
      // skipping the write made that instruction a no-op.
      [false, true, 'sk-fallback', true, 'degraded WITH a fallback — this is the recovery'],
    ];

    it.each(cases)('edited=%s readOnly=%s value=%p -> %s (%s)', (edited, readOnly, value, expected) => {
      expect(shouldWriteCredential({ edited, readOnly, value })).toBe(expected);
    });

    // The two clauses must stay disjoint: an empty field in read-only means
    // "unknown", a non-empty one means "recoverable". If that ever blurs, one
    // of the two bugs above comes back.
    it('never writes an unknown value, and never skips a recoverable one', () => {
      expect(shouldWriteCredential({ edited: false, readOnly: true, value: '' })).toBe(false);
      expect(shouldWriteCredential({ edited: false, readOnly: true, value: 'k' })).toBe(true);
    });
  });

  // The browser build has no keychain, so the credential is held for the
  // session and written nowhere. It used to persist through appStorage — which
  // in a browser IS localStorage, the exact sink CodeQL flagged, reached by the
  // exact path this module exists to remove. The README offers this build to
  // real users ("prefer not to install anything"), so it is not a dev-only path
  // that can be waved through.
  // The browser build encrypts at rest under a non-extractable key, so the
  // credential survives the reloads the app performs on itself — profile
  // switch, profile create/delete, backup restore — without anything readable
  // reaching disk.
  describe('browser build with encrypted storage', () => {
    const makeBackend = () => {
      const files = new Map();
      return {
        files,
        get: async (id) => (files.has(id) ? files.get(id) : null),
        put: async (id, value) => { files.set(id, value); },
        delete: async (id) => { files.delete(id); },
      };
    };

    // THE regression this exists to prevent: holding the key in memory meant a
    // profile switch or backup restore silently unconfigured the user's AI.
    it('survives a reload', async () => {
      const backend = makeBackend();

      const first = await loadStore({ tauri: false });
      await first.initSecretStore({ backend });
      await first.setSecret('sk-typed-in');
      expect(first.isEncryptedInBrowser()).toBe(true);

      // Reload: a brand new module instance, same browser storage.
      const second = await loadStore({ tauri: false });
      await second.initSecretStore({ backend });

      expect(second.getSecret()).toBe('sk-typed-in');
      // ...and nothing readable was written to localStorage on the way.
      expect(plaintext()).toBeNull();
    });

    it('moves a key an older version left in localStorage into encrypted storage', async () => {
      const backend = makeBackend();
      setPlaintext('sk-legacy');

      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });

      expect(store.getSecret()).toBe('sk-legacy');
      // The readable copy is gone...
      expect(plaintext()).toBeNull();
      // ...and it survives the next reload from the encrypted record.
      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend });
      expect(next.getSecret()).toBe('sk-legacy');
    });

    // Same ordering rule as the keychain migration: the plaintext original is
    // the only durable copy until the encrypted write lands.
    it('KEEPS the plaintext copy when the encrypted write fails', async () => {
      const backend = makeBackend();
      backend.put = async () => { throw new Error('quota exceeded'); };
      setPlaintext('sk-legacy');

      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });

      expect(plaintext()).toBe('sk-legacy');
      expect(store.getSecret()).toBe('sk-legacy');
    });

    it('clears to an empty value that still round-trips', async () => {
      const backend = makeBackend();
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      await store.setSecret('sk-real');

      await store.setSecret('');

      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend });
      // '' not null — null would let getSettings fall back to a stale blob key.
      expect(next.getSecret()).toBe('');
    });
  });

  describe('browser build', () => {
    it('adopts a previously persisted key, then deletes it from storage', async () => {
      const store = await loadStore({ tauri: false });
      setPlaintext('sk-browser');
      await store.initSecretStore();

      expect(store.isKeychainAvailable()).toBe(false);
      // Still usable this session...
      expect(store.getSecret()).toBe('sk-browser');
      // ...but the localStorage copy an older version left behind is gone.
      expect(plaintext()).toBeNull();
      // Nothing was invoked — there is no backend to invoke.
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('never writes a saved key to storage', async () => {
      const store = await loadStore({ tauri: false });
      await store.initSecretStore();

      await store.setSecret('sk-typed-in');

      expect(store.getSecret()).toBe('sk-typed-in');
      // The whole point: a key that survives the tab is a key in clear text on
      // disk. The user re-enters it next session instead.
      expect(plaintext()).toBeNull();
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });

  describe('hydration', () => {
    it('reads the credential from the keychain', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue('sk-from-keychain');
      await store.initSecretStore();

      expect(store.isKeychainAvailable()).toBe(true);
      expect(store.getSecret()).toBe('sk-from-keychain');
    });

    it('clears a plaintext leftover once the keychain is populated', async () => {
      const store = await loadStore();
      // A previous migration wrote the keychain but its strip never flushed.
      setPlaintext('sk-stale');
      invokeMock.mockResolvedValue('sk-from-keychain');
      await store.initSecretStore();

      expect(store.getSecret()).toBe('sk-from-keychain');
      expect(plaintext()).toBeNull();
    });

    it('reports no credential when the keychain is empty and nothing is stored', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      expect(store.getSecret()).toBeNull();
      // Nothing to migrate, so no write was attempted.
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('one-time migration', () => {
    it('moves an existing plaintext key into the keychain and strips it', async () => {
      const store = await loadStore();
      setPlaintext('sk-legacy');
      invokeMock.mockImplementation(async (cmd) => (cmd === 'secret_get' ? null : undefined));

      await store.initSecretStore();

      expect(invokeMock).toHaveBeenCalledWith('secret_set', {
        name: OPENROUTER_KEY_KEY,
        value: 'sk-legacy',
      });
      expect(store.getSecret()).toBe('sk-legacy');
      expect(plaintext()).toBeNull();
    });

    // An install that CLEARED its key stores '' as a masking sentinel:
    // getSettings reads a stored empty value as "cleared" and hides a stale
    // credential still sitting in the per-profile blob. Skip the empty value
    // and the keychain ends up with no entry, getSecret returns null,
    // getSettings falls through to that stale blob key — and a credential the
    // user explicitly deleted comes back to life.
    it('migrates a CLEARED key, so it keeps masking a stale blob credential', async () => {
      const store = await loadStore();
      setPlaintext('');
      invokeMock.mockImplementation(async (cmd) => (cmd === 'secret_get' ? null : undefined));

      await store.initSecretStore();

      expect(invokeMock).toHaveBeenCalledWith('secret_set', {
        name: OPENROUTER_KEY_KEY,
        value: '',
      });
      // '' not null — null would let getSettings fall back to the blob.
      expect(store.getSecret()).toBe('');
    });

    // THE data-loss guard. A failed keychain write with an eager strip would
    // leave zero durable copies of the credential after the next restart.
    it('KEEPS the plaintext copy when the keychain write fails', async () => {
      const store = await loadStore();
      setPlaintext('sk-legacy');
      invokeMock.mockImplementation(async (cmd) => {
        if (cmd === 'secret_get') return null;
        throw new Error('keychain write denied');
      });

      await store.initSecretStore();

      expect(plaintext()).toBe('sk-legacy');
      // Still usable this session, so a keychain fault does not also break AI.
      expect(store.getSecret()).toBe('sk-legacy');
    });

    // The read succeeded, so `mode` had already become 'keychain'. Leaving it
    // there would make isKeychainAvailable() report true and Settings tell the
    // user their key is held in the system keychain when its only durable copy
    // is still the plaintext file — with no warning until a later save also
    // failed. A denied write has to report the same state as a denied read.
    it('reports read-only when the migration WRITE is denied', async () => {
      const store = await loadStore();
      setPlaintext('sk-legacy');
      invokeMock.mockImplementation(async (cmd) => {
        if (cmd === 'secret_get') return null;
        throw new Error('keychain write denied');
      });

      await store.initSecretStore();

      expect(store.isKeychainAvailable()).toBe(false);
      expect(store.isReadOnly()).toBe(true);
      // And it must not then write fresh plaintext on the next save.
      await expect(store.setSecret('sk-new')).rejects.toThrow(/keychain could not be reached/i);
      expect(plaintext()).toBe('sk-legacy');
    });
  });

  // A keychain that cannot be reached on desktop degrades to READ-ONLY: keep
  // serving a key the user already has, refuse to write new ones. The refusal
  // is the load-bearing half — falling back to a plaintext write would quietly
  // recreate the exposure the keychain exists to remove, at the moment the user
  // is least able to notice, because from their side the save looks fine.
  describe('unreachable keychain degrades to read-only', () => {
    const degraded = async (existing) => {
      const store = await loadStore();
      if (existing !== undefined) setPlaintext(existing);
      invokeMock.mockRejectedValue(new Error('keychain locked'));
      await store.initSecretStore();
      return store;
    };

    // secret_get resolving to null means "no entry"; REJECTING means the
    // keychain could not be read. Collapsing the two would make a locked
    // keychain look like a fresh install and send the migration down the path
    // that deletes the plaintext original.
    it('does not mistake a read failure for an absent credential', async () => {
      await degraded('sk-legacy');

      expect(plaintext()).toBe('sk-legacy');
      // No secret_set attempted against a keychain we cannot even read.
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('keeps serving the key the user already has', async () => {
      const store = await degraded('sk-legacy');

      expect(store.isKeychainAvailable()).toBe(false);
      expect(store.isReadOnly()).toBe(true);
      // Their AI does not go dark because an unrelated OS service faulted, and
      // the file being read already existed — nothing new is exposed.
      expect(store.getSecret()).toBe('sk-legacy');
    });

    it('REFUSES to write plaintext when the keychain is still down', async () => {
      const store = await degraded('sk-legacy');
      invokeMock.mockClear();

      await expect(store.setSecret('sk-new')).rejects.toThrow(/keychain could not be reached/i);

      // The whole point: no fresh plaintext was minted behind the user's back.
      expect(plaintext()).toBe('sk-legacy');
      expect(store.getSecret()).toBe('sk-legacy');
      // It DID try the keychain — read-only forbids plaintext, not the retry.
      expect(invokeMock).toHaveBeenCalledWith('secret_set', {
        name: OPENROUTER_KEY_KEY,
        value: 'sk-new',
      });
    });

    // A keychain fault at boot is usually transient — locked on login, a prompt
    // dismissed. Without this the error told the user to unlock and try again
    // while `setSecret` refused to call the keychain at all, so trying again
    // could never work short of relaunching the app.
    it('recovers when the keychain comes back, without a restart', async () => {
      const store = await degraded('sk-legacy');
      expect(store.isReadOnly()).toBe(true);

      // User unlocks the keychain, then saves again.
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(undefined);
      await store.setSecret('sk-new');

      expect(store.isReadOnly()).toBe(false);
      expect(store.isKeychainAvailable()).toBe(true);
      expect(store.getSecret()).toBe('sk-new');
      // And the plaintext copy it had been serving is finally cleaned up.
      expect(plaintext()).toBeNull();
    });

    // The accepted cost of this policy, pinned so it is a decision and not a
    // surprise: someone with no key yet cannot configure one WHILE the keychain
    // is down. They get a clear error, and the retry above means unlocking the
    // keychain is enough to continue — no restart. Silent plaintext would
    // instead have persisted unnoticed for the life of the install.
    it('blocks first-time setup while the keychain is down', async () => {
      const store = await degraded();

      expect(store.getSecret()).toBeNull();
      await expect(store.setSecret('sk-first')).rejects.toThrow(/not saved/i);
      expect(plaintext()).toBeNull();
    });
  });

  describe('writes', () => {
    it('persists through the keychain and clears any plaintext copy', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      setPlaintext('sk-stale');
      invokeMock.mockResolvedValue(undefined);
      await store.setSecret('sk-new');

      expect(store.getSecret()).toBe('sk-new');
      expect(plaintext()).toBeNull();
    });

    it('rejects and leaves the cached credential alone when the keychain refuses', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue('sk-old');
      await store.initSecretStore();

      invokeMock.mockRejectedValue(new Error('keychain denied'));
      await expect(store.setSecret('sk-new')).rejects.toThrow('keychain denied');

      // The dialog reports the failure; the app must not act as though the new
      // key was saved when it never reached the keychain.
      expect(store.getSecret()).toBe('sk-old');
    });

    // The keychain took the value, but the OLD one is still durably on disk and
    // every later boot that finds the keychain unavailable serves that file as
    // the fallback. Clearing is the case that bites: the app would report the
    // credential gone while it waits on disk to come back.
    it('reports a failed plaintext cleanup instead of claiming success', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      setPlaintext('sk-real');
      const { appStorage } = await import('../src/appStorage.js');
      vi.spyOn(appStorage, 'flush').mockResolvedValue(false);
      invokeMock.mockResolvedValue(undefined);

      // The user clears their key. The keychain accepts '', the strip does not
      // reach disk, and that must not be reported as a clean success.
      await expect(store.setSecret('')).rejects.toThrow(/older copy of your key/i);

      // The surviving FILE cannot be observed here: appStorage runs in
      // passthrough under jsdom, where removeItem hits localStorage
      // synchronously and is durable whatever flush returns. The failure this
      // guards is desktop cached mode, where the delete is queued and only the
      // flush proves it landed. What is testable — and what actually regressed
      // — is that a false flush is not swallowed.
      expect(store.getSecret()).toBe('');
    });

    // The retry the failure message tells the user to perform was the thing
    // reporting a false success. removeItem drops the key from appStorage's
    // cache immediately; if the disk delete then fails it is re-marked dirty and
    // retried by the NEXT flush. Treating the resulting cache miss as "already
    // clean" skipped that flush entirely.
    it('retries a queued deletion instead of trusting a cache miss', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      const { appStorage } = await import('../src/appStorage.js');
      setPlaintext('sk-real');
      invokeMock.mockResolvedValue(undefined);

      // First attempt: the disk delete does not land.
      const flushSpy = vi.spyOn(appStorage, 'flush').mockResolvedValue(false);
      await expect(store.setSecret('')).rejects.toThrow(/older copy of your key/i);

      // The user retries. The key is gone from the cache now, so a cache-miss
      // early return would claim success while the delete is still queued.
      flushSpy.mockClear();
      await expect(store.setSecret('')).rejects.toThrow(/older copy of your key/i);
      expect(flushSpy).toHaveBeenCalled();

      // Disk recovers; the queued delete finally lands and the save succeeds.
      flushSpy.mockResolvedValue(true);
      await expect(store.setSecret('')).resolves.toBeUndefined();
    });

    it('resolves normally when the cleanup lands', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      setPlaintext('sk-real');
      invokeMock.mockResolvedValue(undefined);

      await expect(store.setSecret('')).resolves.toBeUndefined();
      expect(plaintext()).toBeNull();
    });

    it('writes an empty value rather than deleting, so a stale blob key stays masked', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue('sk-old');
      await store.initSecretStore();

      invokeMock.mockResolvedValue(undefined);
      await store.setSecret('');

      expect(invokeMock).toHaveBeenCalledWith('secret_set', {
        name: OPENROUTER_KEY_KEY,
        value: '',
      });
      // getSettings treats '' as "cleared" and masks the blob; a deleted entry
      // would read as null and let a pre-extraction blob key resurface.
      expect(store.getSecret()).toBe('');
    });
  });
});
