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

/** Poll until `check` passes — a broadcast lands asynchronously. */
async function waitFor(check, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return false;
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

  // The browser build encrypts at rest under a non-exportable key, so the
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
        // Mirrors IndexedDB's add(): rejects rather than overwriting, which is
        // what stops a second context clobbering a wrapping key that existing
        // ciphertext depends on.
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
    };

    // Each tab has its own module-local `cached`. Without a broadcast, clearing
    // the key in one tab leaves the others holding a credential the user
    // believes they deleted — and spending against it until they reload.
    it('revokes a cleared key in other tabs', async () => {
      const backend = makeBackend();
      // A two-ended channel pair, standing in for two tabs on one origin.
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) {
              if (other !== self) other.onmessage?.({ data });
            }
          },
        };
        ends.push(self);
        return self;
      };

      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend, channel: makeChannel() });
      await tabA.setSecret('sk-shared');

      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend, channel: makeChannel() });
      expect(tabB.getSecret()).toBe('sk-shared');

      // The user clears it in tab A.
      await tabA.setSecret('');
      // Tab B must not go on using a credential the user deleted.
      expect(await waitFor(() => tabB.getSecret() === '')).toBe(true);
    });

    // The revocation hole one state over: a tab in `browser-degraded` still
    // holds the legacy key in `cached`, so gating the broadcast handler on
    // normal `browser` mode dropped the clear on the floor and that tab kept
    // spending against the deleted credential.
    it('revokes a cleared key in a DEGRADED tab too', async () => {
      const backend = makeBackend();
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) if (other !== self) other.onmessage?.({ data });
          },
        };
        ends.push(self);
        return self;
      };

      // Tab B boots degraded: a legacy plaintext key it could not encrypt.
      setPlaintext('sk-legacy');
      let allowWrites = false;
      const gated = {
        ...backend,
        update: async (id, decide) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.update(id, decide);
        },
        add: async (id, v) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.add(id, v);
        },
      };
      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend: gated, channel: makeChannel() });
      expect(tabB.isBrowserDegraded()).toBe(true);
      expect(tabB.getSecret()).toBe('sk-legacy');

      // Tab A can write, and the user clears the key there.
      allowWrites = true;
      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend, channel: makeChannel() });
      await tabA.setSecret('');

      // The degraded tab must honour the revocation, not carry on regardless.
      expect(await waitFor(() => tabB.getSecret() === '')).toBe(true);
      expect(tabB.isBrowserDegraded()).toBe(false);
    });

    // A broadcast has already said the stored credential is not what this tab
    // holds. If the confirming read fails, keeping the old value is the unsafe
    // half of the choice — a CLEAR would leave this tab spending against a
    // revoked key indefinitely. So it retries, then fails closed.
    it('drops a stale key when a broadcast cannot be confirmed', async () => {
      const backend = makeBackend();
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) if (other !== self) other.onmessage?.({ data });
          },
        };
        ends.push(self);
        return self;
      };

      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend, channel: makeChannel() });
      await tabA.setSecret('sk-shared');

      let readsFail = false;
      const flaky = {
        ...backend,
        get: async (id) => {
          if (readsFail) throw new Error('idb read failed');
          return backend.get(id);
        },
      };
      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend: flaky, channel: makeChannel() });
      expect(tabB.getSecret()).toBe('sk-shared');

      // Tab A clears; tab B's confirming read is broken throughout.
      readsFail = true;
      await tabA.setSecret('');

      expect(await waitFor(() => tabB.getSecret() === null)).toBe(true);
      expect(tabB.isBrowserUnreadable()).toBe(true);
    });

    // ...but a read that recovers within the retries keeps the tab working,
    // rather than punishing one transient blip.
    it('recovers within the retries instead of failing closed', async () => {
      const backend = makeBackend();
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) if (other !== self) other.onmessage?.({ data });
          },
        };
        ends.push(self);
        return self;
      };

      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend, channel: makeChannel() });
      await tabA.setSecret('sk-first');

      let failuresLeft = 0;
      const flaky = {
        ...backend,
        get: async (id) => {
          if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('transient'); }
          return backend.get(id);
        },
      };
      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend: flaky, channel: makeChannel() });

      failuresLeft = 1; // one blip, then fine
      await tabA.setSecret('sk-second');

      expect(await waitFor(() => tabB.getSecret() === 'sk-second')).toBe(true);
      expect(tabB.isBrowserUnreadable()).toBe(false);
    });

    // Ordering, not logic: every individual step here is correct. A Clear
    // arriving while a Save's decrypt is still in flight would cache '' first,
    // then the older handler would cache the paid key back — the revocation
    // undone by scheduling.
    it('adopts closely spaced broadcasts in order', async () => {
      const backend = makeBackend();
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) if (other !== self) other.onmessage?.({ data });
          },
        };
        ends.push(self);
        return self;
      };

      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend, channel: makeChannel() });

      // Instrumented rather than timing-staged. Reproducing the exact
      // interleaving is not reliably possible here — the handler RE-READS the
      // store, so a late finisher reads the current value rather than a stale
      // one, and provoking a genuinely stale read needs a read that completes
      // before the clear is written but adopts after it. What IS deterministic
      // is the property that makes the hazard impossible: adoptions never
      // overlap. Without the queue this reaches 2.
      let inFlight = 0;
      let maxConcurrent = 0;
      const instrumented = {
        ...backend,
        get: async (id) => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          const value = await backend.get(id);
          inFlight -= 1;
          return value;
        },
      };
      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend: instrumented, channel: makeChannel() });

      // Save then Clear, back to back — two broadcasts in quick succession.
      await tabA.setSecret('sk-paid-key');
      await tabA.setSecret('');

      // The LAST thing that happened was the clear, so that is what must stick.
      expect(await waitFor(() => tabB.getSecret() === '')).toBe(true);
      // ...and still, once every queued adoption has drained.
      await new Promise((r) => setTimeout(r, 150));
      expect(tabB.getSecret()).toBe('');
      // The reason it sticks: no two adoptions were ever in flight together.
      expect(maxConcurrent).toBe(1);
    });

    // A degraded tab's recovery started before another tab's clear must not
    // resurrect the older key. Deferring to what is already stored is what
    // stops it.
    it('recovery defers to a credential another tab already stored', async () => {
      const backend = makeBackend();
      setPlaintext('sk-legacy');
      let allowWrites = false;
      const gated = {
        ...backend,
        update: async (id, decide) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.update(id, decide);
        },
        add: async (id, v) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.add(id, v);
        },
      };

      const degraded = await loadStore({ tauri: false });
      await degraded.initSecretStore({ backend: gated });
      expect(degraded.isBrowserDegraded()).toBe(true);

      // Another tab writes a CLEAR into the shared store meanwhile.
      allowWrites = true;
      const other = await loadStore({ tauri: false });
      await other.initSecretStore({ backend });
      await other.setSecret('');

      // The degraded tab now recovers. It must adopt the clear, not overwrite
      // it with the legacy key it was still holding.
      await degraded.recoverSecretStore();

      expect(degraded.getSecret()).toBe('');
      expect(degraded.isBrowserDegraded()).toBe(false);
    });

    // Memory-only tabs share no store, so a receiver cannot learn the new
    // value — but it can learn that what it holds is stale, which is the half
    // that matters when the change was a clear.
    it('drops a memory-only key when another tab changes it', async () => {
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) if (other !== self) other.onmessage?.({ data });
          },
        };
        ends.push(self);
        return self;
      };

      // No backend at all: both tabs are memory-only.
      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ channel: makeChannel() });
      await tabA.setSecret('sk-session-key');

      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ channel: makeChannel() });
      await tabB.setSecret('sk-session-key');
      expect(tabB.getSecret()).toBe('sk-session-key');

      await tabA.setSecret('');

      expect(await waitFor(() => tabB.getSecret() === null)).toBe(true);
    });

    // The listener is attached before the initial decrypt, so a clear arriving
    // mid-boot could be adopted FIRST and then overwritten by the older startup
    // read — the tab resuming with the revoked key.
    it('does not let a slow boot read overwrite a clear that arrived during it', async () => {
      const backend = makeBackend();

      const seed = await loadStore({ tauri: false });
      await seed.initSecretStore({ backend });
      await seed.setSecret('sk-old');

      // A second tab that can write the clear.
      const other = await loadStore({ tauri: false });
      await other.initSecretStore({ backend });

      // Booting tab: its reads are slow.
      // Snapshot FIRST, then delay: a slow read observes the store when it
      // starts and delivers that later. Delaying and then reading models a read
      // that sees the future, which is what made an earlier version of this
      // test pass against the unfixed code.
      let slow = true;
      const slowBackend = {
        ...backend,
        get: async (id) => {
          const snapshot = await backend.get(id);
          if (slow) await new Promise((r) => setTimeout(r, 60));
          return snapshot;
        },
      };
      const channel = { onmessage: null, postMessage: () => {} };
      const booting = await loadStore({ tauri: false });
      const bootPromise = booting.initSecretStore({ backend: slowBackend, channel });

      // Mid-boot: the other tab clears and the broadcast lands.
      await new Promise((r) => setTimeout(r, 10));
      await other.setSecret('');
      slow = false;
      channel.onmessage?.({ data: { type: 'credential-changed' } });

      await bootPromise;

      // The clear is the newer fact and must win, whatever order they finished.
      expect(await waitFor(() => booting.getSecret() === '')).toBe(true);
    });

    // Two degraded tabs, the SETTLED half of the race: B's clear has already
    // committed by the time A recovers, so A must defer to it rather than
    // resurrect its legacy key.
    //
    // This exercises the defer branch, NOT the compare-and-set. The interleaved
    // half — B committing between A's read and A's write — cannot be staged
    // from outside, because making it unobservable is exactly what the CAS
    // does. That guarantee is covered directly by the version test below.
    it('recovery defers to a clear that already committed', async () => {
      const backend = makeBackend();
      setPlaintext('sk-legacy');

      // Tab A boots degraded.
      let allowWrites = false;
      const gated = {
        ...backend,
        update: async (id, decide) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.update(id, decide);
        },
        add: async (id, v) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.add(id, v);
        },
      };
      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend: gated });
      expect(tabA.isBrowserDegraded()).toBe(true);

      // Tab B clears the credential and commits it, AFTER A's recovery would
      // have read "missing" — simulated by letting B write first, then running
      // A's recovery with writes re-enabled.
      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend });
      await tabB.setSecret('');
      allowWrites = true;

      await tabA.recoverSecretStore();

      // A must adopt the clear, not resurrect its legacy key.
      expect(tabA.getSecret()).toBe('');
      // ...and the stored record is still the cleared one.
      const roundTrip = await loadStore({ tauri: false });
      await roundTrip.initSecretStore({ backend });
      expect(roundTrip.getSecret()).toBe('');
    });

    // Losing the CAS is not the end of it: the follow-up read can itself fail,
    // and treating THAT as "nothing stored" let the degraded tab's legacy key
    // be written back over the newer empty record — resurrecting the credential
    // the other tab had just cleared.
    it('fails closed when the post-CAS re-read is unreadable', async () => {
      const backend = makeBackend();
      setPlaintext('sk-legacy');

      let allowWrites = false;
      let breakReads = false;
      let landClear = null;

      const gated = {
        ...backend,
        get: async (id) => {
          if (breakReads) throw new Error('idb read failed');
          return backend.get(id);
        },
        // Injected at exactly the point the race happens: recovery has already
        // read "nothing stored", and the other tab's clear commits before this
        // write is evaluated. Staging it from outside is not possible — the
        // whole point of the CAS is that the gap is not observable.
        update: async (id, decide) => {
          if (!allowWrites) throw new Error('quota exceeded');
          if (landClear) {
            const run = landClear;
            landClear = null;
            await run();
            breakReads = true; // ...and the follow-up read then fails
          }
          return backend.update(id, decide);
        },
        add: async (id, v) => {
          if (!allowWrites) throw new Error('quota exceeded');
          return backend.add(id, v);
        },
      };

      const degraded = await loadStore({ tauri: false });
      await degraded.initSecretStore({ backend: gated });
      expect(degraded.isBrowserDegraded()).toBe(true);

      // Drop the legacy entry before the second tab boots, or ITS migration
      // writes sk-legacy into the store and recovery below reads `found`,
      // taking the defer branch and never reaching the CAS at all.
      localStorage.removeItem(OPENROUTER_KEY_KEY);
      const other = await loadStore({ tauri: false });
      await other.initSecretStore({ backend });

      allowWrites = true;
      landClear = () => other.setSecret('');
      await degraded.recoverSecretStore().catch(() => {});

      const stored = backend.files.get('openrouter-key-v1');
      // The legacy key must NOT have been written back over the clear.
      expect(stored.version).toBe(1);
      expect(degraded.getSecret()).toBeNull();
      expect(degraded.isBrowserUnreadable()).toBe(true);
    });

    // Two tabs doing the first migration. One observes "nothing stored", the
    // other migrates and then the user clears — and the first tab, resuming,
    // writes the legacy paid key over the newer empty ciphertext.
    it('boot migration cannot overwrite a newer cross-tab clear', async () => {
      const backend = makeBackend();

      let landClear = null;
      const raced = {
        ...backend,
        // Injected between this tab's read and its migration write, which is
        // the window the compare-and-set closes.
        update: async (id, decide) => {
          if (landClear) {
            const run = landClear;
            landClear = null;
            await run();
          }
          return backend.update(id, decide);
        },
      };

      // The second tab boots FIRST and with no legacy entry present, or its own
      // boot migration consumes the entry and the tab under test never reaches
      // the write this is about.
      const other = await loadStore({ tauri: false });
      await other.initSecretStore({ backend });
      landClear = async () => {
        await other.setSecret('sk-legacy'); // its migration
        await other.setSecret('');          // then the user clears
      };

      // Now stage the legacy entry for the tab under test.
      setPlaintext('sk-legacy');
      const booting = await loadStore({ tauri: false });
      await booting.initSecretStore({ backend: raced });

      // The clear must survive: no resurrection of the legacy key.
      expect(booting.getSecret()).toBe('');
      const after = await loadStore({ tauri: false });
      await after.initSecretStore({ backend });
      expect(after.getSecret()).toBe('');
    });

    // An ordinary Save that pauses while encrypting must not land after another
    // tab's Clear and resurrect the credential. The user typed that key BEFORE
    // the clear, so committing it afterwards is not last-writer-wins, it is an
    // older write arriving late.
    it('an in-flight save cannot undo a clear that committed first', async () => {
      const backend = makeBackend();

      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend });
      await tabA.setSecret('sk-original');

      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend });

      // B clears while A's next save is conceptually mid-flight: A still holds
      // the version it observed before the clear.
      await tabB.setSecret('');

      await expect(tabA.setSecret('sk-late')).rejects.toThrow(/changed in another tab/i);

      // The clear stands, and A has adopted it rather than keeping its own.
      expect(tabA.getSecret()).toBe('');
      const after = await loadStore({ tauri: false });
      await after.initSecretStore({ backend });
      expect(after.getSecret()).toBe('');
    });

    // `cached === null` means "no credential" in `browser` but "exists and
    // cannot be read" in `browser-unreadable`. Dropping to session there hides
    // the record and sends every later save past IndexedDB until reload.
    it('does not fall back to memory when an unreadable record exists', async () => {
      const backend = makeBackend();
      const seed = await loadStore({ tauri: false });
      await seed.initSecretStore({ backend });
      await seed.setSecret('sk-stored');
      backend.files.delete('wrap-key-v1'); // now undecryptable forever

      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      expect(store.isBrowserUnreadable()).toBe(true);

      // The replacement write also fails.
      backend.update = async () => { throw new Error('quota exceeded'); };
      await expect(store.setSecret('sk-replacement')).rejects.toThrow(/quota/i);

      // It must stay retryable against IndexedDB, not claim memory-only.
      expect(store.isBrowserUnreadable()).toBe(true);
    });

    // The compare-and-set itself, exercised directly: a write that observed an
    // older version is refused rather than clobbering.
    it('refuses a write whose observed version has moved on', async () => {
      const backend = makeBackend();
      const { writeSecret, readSecret } = await import('../src/browserSecretStore.js');

      await writeSecret(backend, 'sk-first');
      const observed = await readSecret(backend);
      // Someone else writes in between.
      await writeSecret(backend, 'sk-second');

      const wrote = await writeSecret(backend, 'sk-stale', { expectVersion: observed.version });
      expect(wrote.wrote).toBe(false);
      expect(await readSecret(backend)).toMatchObject({ value: 'sk-second' });
    });

    it('picks up a key another tab saved', async () => {
      const backend = makeBackend();
      const ends = [];
      const makeChannel = () => {
        const self = {
          onmessage: null,
          postMessage: (data) => {
            for (const other of ends) if (other !== self) other.onmessage?.({ data });
          },
        };
        ends.push(self);
        return self;
      };

      const tabA = await loadStore({ tauri: false });
      await tabA.initSecretStore({ backend, channel: makeChannel() });
      const tabB = await loadStore({ tauri: false });
      await tabB.initSecretStore({ backend, channel: makeChannel() });

      await tabA.setSecret('sk-entered-in-a');

      expect(await waitFor(() => tabB.getSecret() === 'sk-entered-in-a')).toBe(true);
    });

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
      backend.update = async () => { throw new Error('quota exceeded'); };
      setPlaintext('sk-legacy');

      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });

      expect(plaintext()).toBe('sk-legacy');
      expect(store.getSecret()).toBe('sk-legacy');
    });

    // ...and says so. Leaving `mode` at `browser` would have Settings report
    // that only ciphertext is stored while the readable entry sits untouched —
    // the same lie `read-only` exists to prevent on the desktop side — and
    // nothing would ever retry, since an untouched Save writes no credential.
    it('reports degraded, not encrypted, when the migration write fails', async () => {
      const backend = makeBackend();
      backend.update = async () => { throw new Error('quota exceeded'); };
      setPlaintext('sk-legacy');

      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });

      expect(store.isEncryptedInBrowser()).toBe(false);
      expect(store.isBrowserDegraded()).toBe(true);
    });

    it('recovers from degraded once the browser accepts the write', async () => {
      const files = new Map();
      let allowWrites = false;
      const backend = {
        files,
        get: async (id) => (files.has(id) ? files.get(id) : null),
        put: async (id, v) => {
          if (!allowWrites) throw new Error('quota exceeded');
          files.set(id, v);
        },
        add: async (id, v) => {
          if (!allowWrites) throw new Error('quota exceeded');
          if (files.has(id)) throw new Error('ConstraintError');
          files.set(id, v);
        },
        update: async (id, decide) => {
          if (!allowWrites) throw new Error('quota exceeded');
          const current = files.has(id) ? files.get(id) : null;
          const next = decide(current);
          if (next) files.set(id, next);
          return { wrote: !!next, current };
        },
      };
      setPlaintext('sk-legacy');

      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      expect(store.isBrowserDegraded()).toBe(true);

      // Quota frees up; Settings runs recovery on the next Save.
      allowWrites = true;
      await store.recoverSecretStore();

      expect(store.isBrowserDegraded()).toBe(false);
      expect(store.isEncryptedInBrowser()).toBe(true);
      // The readable copy is finally gone, and the key survives a reload.
      expect(plaintext()).toBeNull();
      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend });
      expect(next.getSecret()).toBe('sk-legacy');
    });

    // An unreadable record is NOT an absent one. Collapsing them would let the
    // migration write a stale plaintext copy over a credential that is merely
    // undecryptable right now — replacing a newer key, or resurrecting one the
    // user deliberately cleared. Same rule commands/secret.rs states for the
    // keychain's Ok(None) vs Err.
    it('never migrates plaintext over a record it could not read', async () => {
      const backend = makeBackend();
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      await store.setSecret('sk-current');
      const ciphertext = backend.files.get('openrouter-key-v1');

      // A stale copy survives from an old install, and the read now fails.
      setPlaintext('sk-stale');
      const broken = { ...backend, get: async () => { throw new Error('idb read failed'); } };
      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend: broken });

      expect(next.isBrowserUnreadable()).toBe(true);
      expect(next.isEncryptedInBrowser()).toBe(false);
      // The stored credential is untouched, and the stale copy was not adopted.
      expect(backend.files.get('openrouter-key-v1')).toBe(ciphertext);
      expect(next.getSecret()).toBeNull();
    });

    it('resumes normally once the record reads again', async () => {
      const backend = makeBackend();
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      await store.setSecret('sk-current');

      let failing = true;
      const flaky = {
        ...backend,
        get: async (id) => {
          if (failing) throw new Error('idb read failed');
          return backend.get(id);
        },
      };
      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend: flaky });
      expect(next.isBrowserUnreadable()).toBe(true);

      failing = false;
      await next.recoverSecretStore();

      expect(next.isBrowserUnreadable()).toBe(false);
      expect(next.getSecret()).toBe('sk-current');
    });

    // Recovery used to flip the mode back without reconciling anything, so a
    // legacy plaintext copy either lingered beside fresh ciphertext or stayed
    // the only durable credential while cached read null — with Settings
    // reporting encrypted storage either way.
    it('reconciles a plaintext copy when an unreadable store recovers', async () => {
      const backend = makeBackend();
      setPlaintext('sk-legacy');

      let failing = true;
      const flaky = {
        ...backend,
        get: async (id) => {
          if (failing) throw new Error('idb read failed');
          return backend.get(id);
        },
      };
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend: flaky });
      expect(store.isBrowserUnreadable()).toBe(true);
      // Untouched while unreadable — absence was never established.
      expect(plaintext()).toBe('sk-legacy');

      // The read recovers and finds nothing stored, so the legacy copy IS the
      // credential and has to be migrated, not abandoned.
      failing = false;
      await store.recoverSecretStore();

      expect(store.isEncryptedInBrowser()).toBe(true);
      expect(store.getSecret()).toBe('sk-legacy');
      expect(plaintext()).toBeNull();
      // ...and it is genuinely encrypted now, so it survives a reload.
      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend });
      expect(next.getSecret()).toBe('sk-legacy');
    });

    // The copy tells the user to enter their key again. A permanently
    // unreadable record — wrapping key cleared — must therefore be replaceable.
    it('lets a new key replace a permanently unreadable record', async () => {
      const backend = makeBackend();
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      await store.setSecret('sk-old');
      // Wipe the wrapping key: the ciphertext can never be decrypted again.
      backend.files.delete('wrap-key-v1');

      const next = await loadStore({ tauri: false });
      await next.initSecretStore({ backend });
      expect(next.isBrowserUnreadable()).toBe(true);

      // Recovery genuinely cannot help here...
      await expect(next.recoverSecretStore()).rejects.toThrow(/could not be read/i);
      // ...but typing a replacement must work, or the instruction is a dead end.
      await next.setSecret('sk-replacement');

      expect(next.isEncryptedInBrowser()).toBe(true);
      expect(next.getSecret()).toBe('sk-replacement');
      const after = await loadStore({ tauri: false });
      await after.initSecretStore({ backend });
      expect(after.getSecret()).toBe('sk-replacement');
    });

    // A first-time save that the browser refuses left `cached` null and the mode
    // at `browser`, so AI could not be configured at all — even though `session`
    // exists for exactly "cannot persist, hold it in memory". Nothing durable
    // was at stake, so retaining it costs nothing.
    it('keeps a first key in memory when the browser refuses to store it', async () => {
      const backend = makeBackend();
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      expect(store.getSecret()).toBeNull();

      backend.update = async () => { throw new Error('quota exceeded'); };

      // Still an error — it was NOT saved, and the caller has to say so.
      await expect(store.setSecret('sk-typed')).rejects.toMatchObject({
        retainedInMemory: true,
      });

      // ...but the session works rather than the app being unconfigurable.
      expect(store.getSecret()).toBe('sk-typed');
      expect(store.isEncryptedInBrowser()).toBe(false);
    });

    // The other half: with a credential already stored, a failed overwrite must
    // NOT drop to session — that would report memory-only while ciphertext sits
    // in the store, and hide the value that is actually persisted.
    it('does not drop to session when a stored credential already exists', async () => {
      const backend = makeBackend();
      const store = await loadStore({ tauri: false });
      await store.initSecretStore({ backend });
      await store.setSecret('sk-stored');

      backend.update = async () => { throw new Error('quota exceeded'); };
      await expect(store.setSecret('sk-new')).rejects.toThrow(/quota/i);

      expect(store.isEncryptedInBrowser()).toBe(true);
      expect(store.getSecret()).toBe('sk-stored');
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

  // ensureProfilesInitialized runs extractSharedApiKey on its happy paths only;
  // an adoption that cannot finish returns early without it. boot therefore
  // calls it independently, or a credential still inside the per-profile blob
  // is never consolidated — initSecretStore finds nothing to migrate, reports
  // healthy storage, and getSettings quietly serves the readable blob value.
  describe('boot extracts the credential even when adoption degraded', () => {
    it('migrates a blob-resident key into the keychain', async () => {
      const { extractSharedApiKey } = await import('../src/profiles.js');
      localStorage.setItem('resume-designer-data', JSON.stringify({
        variants: {}, settings: { openrouterKey: 'sk-in-blob', theme: 'dark' },
      }));

      // The boot sequence, minus the profile adoption that failed.
      await extractSharedApiKey();
      const store = await loadStore();
      invokeMock.mockImplementation(async (cmd) => (cmd === 'secret_get' ? null : undefined));
      await store.initSecretStore();

      // It reached the keychain...
      expect(invokeMock).toHaveBeenCalledWith('secret_set', {
        name: OPENROUTER_KEY_KEY,
        value: 'sk-in-blob',
      });
      expect(store.getSecret()).toBe('sk-in-blob');
      // ...and is no longer readable in either plaintext home.
      expect(plaintext()).toBeNull();
      const blob = JSON.parse(localStorage.getItem('resume-designer-data'));
      expect(blob.settings.openrouterKey).toBeUndefined();
      expect(blob.settings.theme).toBe('dark');
    });
  });

  // The read-only banner promises the user can fix things without restarting.
  // Two outstanding conditions are NOT reachable through the credential write,
  // so Save has to do them explicitly or the promise is empty.
  describe('in-session recovery', () => {
    // Already-migrated install: nothing in plaintext to fall back to, so a
    // transient startup read failure leaves NO credential. Saving cannot fix it
    // — the field seeds empty and writing that unknown value is exactly what
    // shouldWriteCredential refuses. Re-READING is the fix.
    it('recovers an existing key by re-reading, without writing', async () => {
      const store = await loadStore();
      invokeMock.mockRejectedValue(new Error('keychain locked'));
      await store.initSecretStore();

      expect(store.isReadOnly()).toBe(true);
      expect(store.getSecret()).toBeNull();

      // The user unlocks the keychain and hits Save.
      invokeMock.mockReset();
      invokeMock.mockResolvedValue('sk-existing');
      await store.recoverSecretStore();

      expect(store.isReadOnly()).toBe(false);
      expect(store.isKeychainAvailable()).toBe(true);
      expect(store.getSecret()).toBe('sk-existing');
      // Crucially it never wrote — an empty field must not reach the keychain.
      expect(invokeMock).not.toHaveBeenCalledWith('secret_set', expect.anything());
    });

    // A reachable-but-EMPTY keychain alongside a surviving plaintext key is the
    // migration case. Adopting the empty read as truth would discard the user's
    // only credential, so recovery has to run the same migration boot would.
    it('migrates a plaintext fallback rather than adopting an empty read', async () => {
      const store = await loadStore();
      setPlaintext('sk-fallback');
      invokeMock.mockRejectedValue(new Error('keychain locked'));
      await store.initSecretStore();
      expect(store.getSecret()).toBe('sk-fallback');

      invokeMock.mockReset();
      invokeMock.mockImplementation(async (cmd) => (cmd === 'secret_get' ? null : undefined));
      await store.recoverSecretStore();

      expect(invokeMock).toHaveBeenCalledWith('secret_set', {
        name: OPENROUTER_KEY_KEY,
        value: 'sk-fallback',
      });
      expect(store.getSecret()).toBe('sk-fallback');
      expect(plaintext()).toBeNull();
    });

    it('stays read-only and reports when the keychain is still locked', async () => {
      const store = await loadStore();
      invokeMock.mockRejectedValue(new Error('keychain locked'));
      await store.initSecretStore();

      await expect(store.recoverSecretStore()).rejects.toThrow(/locked/i);
      expect(store.isReadOnly()).toBe(true);
    });

    // Promoting the mode back to `keychain` made isReadOnly() false, which made
    // shouldWriteCredential() false, which made the prompted Save a no-op —
    // leaving the readable copy on disk for good. Cleanup is tracked separately
    // so the retry re-runs it regardless of the credential decision.
    it('keeps cleanup pending until the strip actually lands', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      setPlaintext('sk-real');
      const { appStorage } = await import('../src/appStorage.js');
      const flushSpy = vi.spyOn(appStorage, 'flush').mockResolvedValue(false);
      invokeMock.mockResolvedValue(undefined);

      await expect(store.setSecret('sk-new')).rejects.toThrow(/older copy of your key/i);
      expect(store.isCleanupPending()).toBe(true);

      // The retry needs no credential rewrite, so it must run the cleanup on
      // its own account.
      flushSpy.mockResolvedValue(true);
      await store.recoverSecretStore();

      expect(store.isCleanupPending()).toBe(false);
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

    // appStorage.flush() reports durability for the WHOLE dirty batch, so a
    // disk-full resume autosave would otherwise make every credential save
    // throw "an older copy could not be removed" — when there was no older copy
    // at all — and block Settings on something unrelated to the key.
    it('ignores an unrelated flush failure when no credential copy is queued', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      // Nothing of ours in storage; some other write is failing.
      const { appStorage } = await import('../src/appStorage.js');
      vi.spyOn(appStorage, 'flush').mockResolvedValue(false);
      invokeMock.mockResolvedValue(undefined);

      await expect(store.setSecret('sk-new')).resolves.toBeUndefined();
      expect(store.isCleanupPending()).toBe(false);
    });

    // During a restore, appStorage defers removals into a buffer the SUCCESSFUL
    // restore path then discards — while flush() can still report true. Taking
    // that as done left the readable credential on disk with cleanupPending
    // false, so a transient keychain failure after the restore's reload could
    // serve a key the user had just cleared.
    it('does not call cleanup done while a restore guard defers the delete', async () => {
      const store = await loadStore();
      invokeMock.mockResolvedValue(null);
      await store.initSecretStore();

      setPlaintext('sk-real');
      const { appStorage } = await import('../src/appStorage.js');
      vi.spyOn(appStorage, 'isRestoreGuardActive').mockReturnValue(true);
      invokeMock.mockResolvedValue(undefined);

      await expect(store.setSecret('sk-new')).rejects.toThrow(/older copy of your key/i);
      expect(store.isCleanupPending()).toBe(true);
      // The readable copy is untouched, which is precisely why it must not be
      // reported as removed.
      expect(plaintext()).toBe('sk-real');
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
