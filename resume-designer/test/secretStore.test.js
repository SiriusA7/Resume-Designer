import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OPENROUTER_KEY_KEY } from '../src/profileKeys.js';

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

  describe('browser build', () => {
    it('keeps using appStorage when there is no keychain', async () => {
      const store = await loadStore({ tauri: false });
      setPlaintext('sk-browser');
      await store.initSecretStore();

      expect(store.isKeychainAvailable()).toBe(false);
      expect(store.getSecret()).toBe('sk-browser');
      // Nothing was invoked — there is no backend to invoke.
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
  });

  describe('unreachable keychain', () => {
    // secret_get resolving to null means "no entry"; REJECTING means the
    // keychain could not be read. Collapsing the two would make a locked
    // keychain look like a fresh install and send the migration down the path
    // that deletes the plaintext original.
    it('does not mistake a read failure for an absent credential', async () => {
      const store = await loadStore();
      setPlaintext('sk-legacy');
      invokeMock.mockRejectedValue(new Error('keychain locked'));

      await store.initSecretStore();

      expect(store.isKeychainAvailable()).toBe(false);
      expect(plaintext()).toBe('sk-legacy');
      // No secret_set was attempted against a keychain we cannot even read.
      expect(invokeMock).toHaveBeenCalledTimes(1);
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
