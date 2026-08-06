import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OPENROUTER_KEY_KEY } from '../src/profileKeys.js';

// Two ways the credential could change without the UI hearing about it. Both
// leave ChatPanel/useChat on a stale `configured`: a composer still enabled
// against a key that was cleared, or disabled against one that was just saved,
// until the next reload or unrelated settings change.
//
// Every listener re-reads through getSettings() rather than trusting the event
// payload, so a notification is never WRONG — only sometimes redundant. That is
// what makes it safe to fire from failure paths.

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invokeMock(...args) }));

/** A two-ended channel pair standing in for two tabs on one origin. */
function channelPair() {
  const ends = [];
  return () => {
    const self = {
      onmessage: null,
      postMessage: (data) => {
        for (const other of ends) if (other !== self) other.onmessage?.({ data });
      },
    };
    ends.push(self);
    return self;
  };
}

/**
 * The IndexedDB-shaped backend the browser secret store talks to — the same
 * fake secretStore.test.js uses. NOT the appStorage backend shape: this one
 * needs get/put/add/update, and an appStorage-shaped fake fails the
 * version read with "stored copy couldn't be checked" instead.
 */
function makeBackend() {
  const files = new Map();
  return {
    files,
    get: async (id) => (files.has(id) ? files.get(id) : null),
    put: async (id, value) => { files.set(id, value); },
    // IndexedDB add(): rejects rather than overwriting, which stops a second
    // context clobbering a wrapping key existing ciphertext depends on.
    add: async (id, value) => {
      if (files.has(id)) throw new Error('ConstraintError');
      files.set(id, value);
    },
    // IndexedDB's single-transaction get + conditional put.
    update: async (id, decide) => {
      const current = files.has(id) ? files.get(id) : null;
      const next = decide(current);
      if (next) files.set(id, next);
      return { wrote: !!next, current };
    },
  };
}

/** Fresh module copy — IS_TAURI is read at import time. */
async function loadStore({ tauri = false } = {}) {
  vi.resetModules();
  if (tauri) window.isTauri = true;
  else delete window.isTauri;
  return import('../src/secretStore.js');
}

const waitFor = async (cond, tries = 50) => {
  for (let i = 0; i < tries; i += 1) {
    if (cond()) return true;
    await new Promise((r) => { setTimeout(r, 2); });
  }
  return cond();
};

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
});

describe('a remote credential change notifies this tab', () => {
  // secretStore dispatched no in-page events at all. Another tab saving or
  // clearing the key updated `cached`/`mode` here, and nothing recomputed the
  // UI — so the fix is a notifier persistence.js wires to
  // SETTINGS_UPDATED_EVENT. Driven through the REAL broadcast path.
  it('fires when another tab clears the key', async () => {
    const backend = makeBackend();
    const makeChannel = channelPair();

    const tabA = await loadStore();
    await tabA.initSecretStore({ backend, channel: makeChannel() });
    await tabA.setSecret('sk-shared');

    const tabB = await loadStore();
    const notified = vi.fn();
    tabB.setCredentialChangeNotifier(notified);
    await tabB.initSecretStore({ backend, channel: makeChannel() });
    expect(tabB.getSecret()).toBe('sk-shared');
    notified.mockClear();

    await tabA.setSecret('');

    expect(await waitFor(() => tabB.getSecret() === '')).toBe(true);
    expect(notified).toHaveBeenCalled();
  });

  it('fires when another tab saves a key', async () => {
    const backend = makeBackend();
    const makeChannel = channelPair();

    const tabA = await loadStore();
    await tabA.initSecretStore({ backend, channel: makeChannel() });

    const tabB = await loadStore();
    const notified = vi.fn();
    tabB.setCredentialChangeNotifier(notified);
    await tabB.initSecretStore({ backend, channel: makeChannel() });
    notified.mockClear();

    await tabA.setSecret('sk-fresh');

    expect(await waitFor(() => tabB.getSecret() === 'sk-fresh')).toBe(true);
    expect(notified).toHaveBeenCalled();
  });

  // The notification must not be able to break an adoption: by the time it
  // goes out, the credential state is already committed.
  it('survives a notifier that throws', async () => {
    const backend = makeBackend();
    const makeChannel = channelPair();

    const tabA = await loadStore();
    await tabA.initSecretStore({ backend, channel: makeChannel() });
    await tabA.setSecret('sk-shared');

    const tabB = await loadStore();
    tabB.setCredentialChangeNotifier(() => { throw new Error('render blew up'); });
    await tabB.initSecretStore({ backend, channel: makeChannel() });

    await tabA.setSecret('');

    // The adoption still completed despite the throwing listener.
    expect(await waitFor(() => tabB.getSecret() === '')).toBe(true);
  });
});

describe('saveApiKey notifies even when the write reports a failure', () => {
  // setSecret has three paths that change the effective credential and THEN
  // throw: the memory-only fallback, the write-conflict adoption, and a
  // plaintext-cleanup failure after the ciphertext write landed. Dispatching
  // only after a clean resolve left getSettings() returning a new key while the
  // UI kept its old enabled state until reload.
  //
  // The keychain build is the simplest of the three to drive: a rejected
  // `secret_set` leaves the store unchanged, but saveApiKey must still notify —
  // the same `finally` that covers the partial-success paths.
  async function loadPersistence() {
    vi.resetModules();
    window.isTauri = true;
    const secretStore = await import('../src/secretStore.js');
    const persistence = await import('../src/persistence.js');
    return { secretStore, persistence };
  }

  async function countEvents(name, fn) {
    let n = 0;
    const onEvent = () => { n += 1; };
    window.addEventListener(name, onEvent);
    try { await fn(); } finally { window.removeEventListener(name, onEvent); }
    return n;
  }

  it('dispatches when the write rejects', async () => {
    const { secretStore, persistence } = await loadPersistence();
    invokeMock.mockResolvedValue(null);
    await secretStore.initSecretStore();

    const fired = await countEvents(persistence.SETTINGS_UPDATED_EVENT, async () => {
      invokeMock.mockRejectedValueOnce(new Error('keychain refused'));
      await persistence.saveApiKey('sk-fails').catch(() => { /* expected */ });
    });

    expect(fired).toBeGreaterThan(0);
  });

  it('still dispatches on a clean save', async () => {
    const { secretStore, persistence } = await loadPersistence();
    invokeMock.mockResolvedValue(null);
    await secretStore.initSecretStore();

    const fired = await countEvents(persistence.SETTINGS_UPDATED_EVENT, async () => {
      await persistence.saveApiKey('sk-clean');
    });

    expect(fired).toBeGreaterThan(0);
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe(null);
  });
});
