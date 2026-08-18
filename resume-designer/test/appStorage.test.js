import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  appStorage,
  initAppStorage,
  whenStorageReady,
  markStorageReady,
  __resetAppStorageForTests,
  setProfileMapping,
} from '../src/appStorage.js';

// In-memory fake of the Rust backend (the `invoke` seam).
function makeBackend(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    loadAll: vi.fn(async () => Object.fromEntries(files)),
    write: vi.fn(async (key, value) => { files.set(key, value); }),
    delete: vi.fn(async (key) => { files.delete(key); }),
    clear: vi.fn(async () => { files.clear(); }),
  };
}

beforeEach(() => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  localStorage.clear();
});

describe('passthrough mode (browser / no init)', () => {
  it('reads and writes localStorage directly before any init', () => {
    appStorage.setItem('resume-zoom', '1.25');
    expect(localStorage.getItem('resume-zoom')).toBe('1.25');
    expect(appStorage.getItem('resume-zoom')).toBe('1.25');
    appStorage.removeItem('resume-zoom');
    expect(localStorage.getItem('resume-zoom')).toBeNull();
  });

  it('lists keys and reports a durable (true) flush as a no-op', async () => {
    localStorage.setItem('resume-designer-data', '{}');
    expect(appStorage.keys()).toContain('resume-designer-data');
    // Passthrough is synchronous, so flush() always reports durable.
    await expect(appStorage.flush()).resolves.toBe(true);
  });
});

describe('cached mode (disk backend)', () => {
  it('serves reads from the boot snapshot', async () => {
    const backend = makeBackend({ 'resume-designer-data': '{"a":1}' });
    await initAppStorage({ backend });
    expect(appStorage.getItem('resume-designer-data')).toBe('{"a":1}');
    expect(appStorage.keys()).toEqual(['resume-designer-data']);
  });

  it('write-behinds set/remove and coalesces multiple sets per key', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem('resume-zoom', '1');
    appStorage.setItem('resume-zoom', '2');
    appStorage.setItem('resume-zoom', '3');
    expect(appStorage.getItem('resume-zoom')).toBe('3'); // sync read
    await appStorage.flush();
    // Coalesced: one disk write for the final value, not three.
    expect(backend.write).toHaveBeenCalledTimes(1);
    expect(backend.write).toHaveBeenCalledWith('resume-zoom', '3');
    appStorage.removeItem('resume-zoom');
    await appStorage.flush();
    expect(backend.delete).toHaveBeenCalledWith('resume-zoom');
    expect(backend.files.size).toBe(0);
  });

  it('coalesces keystroke-rate writes across turns into far fewer disk writes', async () => {
    // The application-notes field calls setItem() on every keystroke. The
    // write-behind throttle must collapse a typing burst into a handful of disk
    // writes (bounded by DRAIN_COALESCE_MS), NOT one serialized write per
    // keystroke — otherwise a long note queues hundreds of atomic writes and
    // the native close handler waits on the whole chain.
    vi.useFakeTimers();
    try {
      const backend = makeBackend();
      await initAppStorage({ backend });
      for (let i = 1; i <= 10; i++) {
        appStorage.setItem('resume-app-notes', 'x'.repeat(i)); // one per keystroke
        await vi.advanceTimersByTimeAsync(40); // < the coalescing window
      }
      await appStorage.flush();
      // 10 keystrokes ≈ 400ms → a couple of throttled writes, not ten, and the
      // final value is durable on disk.
      expect(backend.write.mock.calls.length).toBeLessThanOrEqual(3);
      expect(backend.files.get('resume-app-notes')).toBe('x'.repeat(10));
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the pending coalescing timer when a flush forces the drain', async () => {
    // flush() drains immediately, bypassing the coalescing timer. That timer
    // must be cancelled, or it fires later, drains a fresh keystroke early, and
    // clears drainScheduled while a newer timer is pending — cascading
    // overlapping timers back toward one backend write per keystroke.
    vi.useFakeTimers();
    try {
      const backend = makeBackend();
      await initAppStorage({ backend });
      appStorage.setItem('resume-app-notes', 'a'); // arms the coalescing timer
      expect(vi.getTimerCount()).toBe(1);
      await appStorage.flush(); // forces a drain...
      expect(vi.getTimerCount()).toBe(0); // ...and must leave no stale timer armed
      expect(backend.files.get('resume-app-notes')).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() empties cache and backend', async () => {
    const backend = makeBackend({ a: '1', b: '2' });
    await initAppStorage({ backend });
    appStorage.clear();
    await appStorage.flush();
    expect(appStorage.keys()).toEqual([]);
    expect(backend.clear).toHaveBeenCalled();
  });

  it('skips a queued write when the key is removed before the write lands', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem('resume-zoom', '1');
    // Start the flush so drain() snapshots the write op, then remove the key
    // before the queued write executes. Without the cache.has() guard the
    // stale write op would materialize a spurious '' file on disk.
    const inFlight = appStorage.flush();
    appStorage.removeItem('resume-zoom');
    await inFlight;
    await appStorage.flush();
    expect(backend.write).not.toHaveBeenCalled();
    expect(backend.delete).toHaveBeenCalledTimes(1);
    expect(backend.files.size).toBe(0);
  });

  it('retries a failed write once, then keeps the value in cache and reports', async () => {
    const backend = makeBackend();
    backend.write
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'));
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    appStorage.setItem('resume-designer-data', '{"keep":"me"}');
    await appStorage.flush();
    expect(backend.write).toHaveBeenCalledTimes(2); // first try + one retry
    expect(errSpy).toHaveBeenCalled();
    // The session keeps working from cache even though disk failed.
    expect(appStorage.getItem('resume-designer-data')).toBe('{"keep":"me"}');
    errSpy.mockRestore();
  });

  it('flush() reports true when writes reach disk', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem('resume-zoom', '1.5');
    await expect(appStorage.flush()).resolves.toBe(true);
  });

  it('flush() reports false when a write permanently fails (durability barrier)', async () => {
    const backend = makeBackend();
    backend.write.mockRejectedValue(new Error('disk full')); // both attempts fail
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    appStorage.setItem('resume-designer-data', '{"v":1}');
    // The durability signal callers (backup reload, PDF print) rely on:
    // resolves false → don't reload/render against stale disk.
    await expect(appStorage.flush()).resolves.toBe(false);
    // A later flush with no new failures is durable again.
    backend.write.mockResolvedValue(undefined);
    appStorage.setItem('resume-zoom', '2');
    await expect(appStorage.flush()).resolves.toBe(true);
    errSpy.mockRestore();
  });

  it('retries a recovered key on the next flush — no false durable while a prior write is unpersisted', async () => {
    const backend = makeBackend();
    backend.write.mockRejectedValue(new Error('disk full')); // both attempts fail
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    appStorage.setItem('resume-designer-data', '{"v":1}');
    // Disk full → not durable, and the value never reached disk.
    await expect(appStorage.flush()).resolves.toBe(false);
    expect(backend.files.has('resume-designer-data')).toBe(false);

    // Disk frees up (restore the real file-writing impl, not mockResolvedValue
    // which would resolve without persisting). With NO new edit, the next flush
    // must retry the still-dirty failed key and only report durable once it
    // actually lands — otherwise the print/reload/relaunch paths would proceed
    // on a `true` that never hit disk.
    backend.write.mockImplementation(async (key, value) => { backend.files.set(key, value); });
    await expect(appStorage.flush()).resolves.toBe(true);
    expect(backend.files.get('resume-designer-data')).toBe('{"v":1}');
    errSpy.mockRestore();
  });

  it('readOnly mode never writes to the backend', async () => {
    const backend = makeBackend({ 'resume-designer-data': '{}' });
    await initAppStorage({ backend, readOnly: true });
    appStorage.setItem('resume-zoom', '2');
    await appStorage.flush();
    expect(backend.write).not.toHaveBeenCalled();
    expect(appStorage.getItem('resume-zoom')).toBe('2'); // cache still serves it
  });

  it('rejects in readOnly mode when disk data cannot load (print window aborts, never captures stale)', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    const backend = makeBackend();
    backend.loadAll.mockRejectedValue(new Error('disk unreadable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // After adoption the print window's localStorage is empty/stale, so a
    // passthrough fallback would render a wrong resume. initAppStorage must
    // reject so printEntry emits print-error and the export fails loudly
    // instead of capturing a blank/default PDF.
    await expect(initAppStorage({ backend, readOnly: true })).rejects.toThrow('disk unreadable');
    errSpy.mockRestore();
  });

  it('degrades to passthrough (no throw) when the MAIN window cannot load disk data', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    const backend = makeBackend();
    backend.loadAll.mockRejectedValue(new Error('disk unreadable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The main window is the sole writer: degrade to localStorage rather than
    // booting empty (which would look like total data loss). Reads/writes still
    // work — this graceful path must survive the readOnly-rejects change above.
    await expect(initAppStorage({ backend })).resolves.toBeUndefined();
    expect(appStorage.getItem('resume-designer-data')).toBe('{"v":1}');
    appStorage.setItem('resume-zoom', '2');
    expect(localStorage.getItem('resume-zoom')).toBe('2');
    errSpy.mockRestore();
  });
});

describe('boot migration (localStorage → disk adoption)', () => {
  it('adopts resume-* keys when the disk store is empty, then clears them', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    localStorage.setItem('resume-designer-history-variant-1', '{"h":[]}');
    localStorage.setItem('resume-zoom', '1.5');
    localStorage.setItem('unrelated-key', 'leave-me');
    const backend = makeBackend();
    await initAppStorage({ backend });
    expect(backend.files.get('resume-designer-data')).toBe('{"v":1}');
    expect(backend.files.get('resume-designer-history-variant-1')).toBe('{"h":[]}');
    expect(backend.files.get('resume-zoom')).toBe('1.5');
    expect(appStorage.getItem('resume-designer-data')).toBe('{"v":1}');
    // Adopted keys leave localStorage; foreign keys stay.
    expect(localStorage.getItem('resume-designer-data')).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('leave-me');
  });

  it('does not adopt when the disk store already has data', async () => {
    localStorage.setItem('resume-designer-data', '{"stale":"localStorage"}');
    const backend = makeBackend({ 'resume-designer-data': '{"disk":"wins"}' });
    await initAppStorage({ backend });
    expect(appStorage.getItem('resume-designer-data')).toBe('{"disk":"wins"}');
    // localStorage untouched when adoption is skipped.
    expect(localStorage.getItem('resume-designer-data')).toBe('{"stale":"localStorage"}');
  });

  // A hard kill mid-adoption (after some disk writes, before localStorage is
  // cleared) must not strand the user on a partial disk snapshot: the pending
  // marker written before the first key flags the interruption, and the next
  // boot redoes the copy from the still-intact localStorage.
  it('re-adopts from localStorage when the pending marker survives a killed run', async () => {
    localStorage.setItem('resume-designer-data', '{"v":"FULL"}');
    localStorage.setItem('resume-zoom', '2');
    const backend = makeBackend({
      '__adoption_pending__': '1',
      'resume-designer-data': '{"v":"PARTIAL"}',
    });
    await initAppStorage({ backend });
    expect(appStorage.getItem('resume-designer-data')).toBe('{"v":"FULL"}');
    expect(appStorage.getItem('resume-zoom')).toBe('2');
    expect(backend.files.get('resume-designer-data')).toBe('{"v":"FULL"}');
    expect(backend.files.has('__adoption_pending__')).toBe(false);
    // Adoption completed this time — localStorage handed over.
    expect(localStorage.getItem('resume-designer-data')).toBeNull();
  });

  it('writes the pending marker before the first key and removes it after the last', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    localStorage.setItem('resume-zoom', '1.5');
    const backend = makeBackend();
    const order = [];
    backend.write.mockImplementation(async (k, v) => { order.push(`write:${k}`); backend.files.set(k, v); });
    backend.delete.mockImplementation(async (k) => { order.push(`delete:${k}`); backend.files.delete(k); });
    await initAppStorage({ backend });
    expect(order[0]).toBe('write:__adoption_pending__');
    expect(order[order.length - 1]).toBe('delete:__adoption_pending__');
    expect(backend.files.has('__adoption_pending__')).toBe(false);
  });

  it('clears a stale marker when there is nothing left to adopt', async () => {
    // Killed between marker-removal steps in a way that left the marker but no
    // owned localStorage keys — must not loop forever; just drop the marker.
    const backend = makeBackend({
      '__adoption_pending__': '1',
      'resume-designer-data': '{"v":"DISK"}',
    });
    await initAppStorage({ backend });
    expect(backend.files.has('__adoption_pending__')).toBe(false);
    expect(appStorage.getItem('resume-designer-data')).toBe('{"v":"DISK"}');
  });

  it('aborts adoption and leaves localStorage intact if a disk write fails', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    const backend = makeBackend();
    backend.write.mockRejectedValue(new Error('disk full'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await initAppStorage({ backend });
    // Migration failed → keep running OFF localStorage (passthrough), no data loss.
    expect(localStorage.getItem('resume-designer-data')).toBe('{"v":1}');
    expect(appStorage.getItem('resume-designer-data')).toBe('{"v":1}');
    errSpy.mockRestore();
  });

  it('cleans the partial disk copy when adoption aborts midway', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    localStorage.setItem('resume-zoom', '1.5');
    const backend = makeBackend();
    backend.write
      .mockImplementationOnce(async (key, value) => { backend.files.set(key, value); })
      .mockRejectedValue(new Error('disk full'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await initAppStorage({ backend });
    // The half-written copy must be wiped: a surviving partial copy would make
    // the next boot see a non-empty disk, skip adoption forever, and silently
    // shadow the newer localStorage data.
    expect(backend.clear).toHaveBeenCalledTimes(1);
    expect(backend.files.size).toBe(0);
    // localStorage stays fully intact as the source of truth.
    expect(localStorage.getItem('resume-designer-data')).toBe('{"v":1}');
    expect(localStorage.getItem('resume-zoom')).toBe('1.5');
    expect(appStorage.getItem('resume-zoom')).toBe('1.5'); // passthrough serves it
    errSpy.mockRestore();
  });

  it('adopts successfully on the next boot after a partial-write abort', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    localStorage.setItem('resume-zoom', '1.5');
    const backend = makeBackend();
    backend.write
      .mockImplementationOnce(async (key, value) => { backend.files.set(key, value); })
      .mockRejectedValueOnce(new Error('disk full'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await initAppStorage({ backend }); // first boot: partial write → abort + clean
    expect(backend.files.size).toBe(0);

    // Second boot: same backend (disk store genuinely empty after the cleanup),
    // same seeded localStorage, writes healthy again (the once-mocks are spent).
    __resetAppStorageForTests();
    await initAppStorage({ backend });
    expect(backend.files.get('resume-designer-data')).toBe('{"v":1}');
    expect(backend.files.get('resume-zoom')).toBe('1.5');
    expect(appStorage.getItem('resume-designer-data')).toBe('{"v":1}');
    // Adoption completed: ownership handed over from localStorage to disk.
    expect(localStorage.getItem('resume-designer-data')).toBeNull();
    expect(localStorage.getItem('resume-zoom')).toBeNull();
    errSpy.mockRestore();
  });

  it('skips migration in readOnly mode', async () => {
    localStorage.setItem('resume-designer-data', '{"v":1}');
    const backend = makeBackend();
    await initAppStorage({ backend, readOnly: true });
    expect(backend.write).not.toHaveBeenCalled();
    expect(localStorage.getItem('resume-designer-data')).toBe('{"v":1}');
  });
});

describe('a disk load that fails has somewhere to fall back to, or refuses', () => {
  const failingBackend = () => ({
    loadAll: vi.fn(async () => { throw new Error('storage_load_all failed'); }),
    write: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  });

  it('uses localStorage when localStorage is still where the data is', async () => {
    // The pre-adoption install: the disk store has never been populated, so
    // localStorage genuinely holds the resumes and passthrough over it is the
    // real data rather than a blank slate.
    localStorage.setItem('resume-designer-data', '{"variants":{"v-1":{}}}');
    await initAppStorage({ backend: failingBackend() });

    expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"v-1":{}}}');
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    expect(localStorage.getItem('resume-designer-applications')).toBe('[{"id":"a-1"}]');
  });

  it('refuses to accept work when localStorage was already emptied by adoption', async () => {
    // The established install, and the case that lost data. Adoption empties
    // localStorage once the disk store owns the keys, so passthrough here is not
    // a fallback — it is a blank, WRITABLE store. Edits went into localStorage,
    // the next launch found the disk store non-empty and skipped adoption, and
    // they were never read again: the session's work gone and the older disk
    // data back in its place.
    expect(localStorage.length).toBe(0);
    await initAppStorage({ backend: failingBackend() });

    // Reads answer empty — there is genuinely nothing loaded.
    expect(appStorage.getItem('resume-designer-data')).toBeNull();

    // …and a write goes NOWHERE durable. Not to localStorage, where the next
    // launch would never look, and not to the disk store, which must stay
    // exactly as it is for that launch to load.
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    expect(localStorage.getItem('resume-designer-applications')).toBeNull();
    await expect(appStorage.flush()).resolves.toBe(true);
  });
});

describe('storage-ready mount gate', () => {
  it('stays closed after initAppStorage and opens only via markStorageReady', async () => {
    // The React gate must cover the legacy Electron migration that init()
    // runs AFTER initAppStorage — were the facade to open it itself, chat
    // (etc.) would mount against a pre-migration empty store and its next
    // save would overwrite the migrated data. So initAppStorage must NOT
    // resolve the gate; only main.js's post-migration markStorageReady does.
    let opened = false;
    whenStorageReady().then(() => { opened = true; });

    await initAppStorage({ backend: makeBackend() });
    await Promise.resolve(); // flush microtasks
    await Promise.resolve();
    expect(opened).toBe(false);

    markStorageReady();
    await Promise.resolve();
    expect(opened).toBe(true);
  });
});

describe('profile mapping', () => {
  it('namespaces per-profile keys once a profile is active', () => {
    setProfileMapping('p1');
    appStorage.setItem('resume-designer-data', '{"a":1}');
    expect(localStorage.getItem('resume-p--p1--resume-designer-data')).toBe('{"a":1}');
    expect(localStorage.getItem('resume-designer-data')).toBeNull();
    expect(appStorage.getItem('resume-designer-data')).toBe('{"a":1}');
    appStorage.removeItem('resume-designer-data');
    expect(localStorage.getItem('resume-p--p1--resume-designer-data')).toBeNull();
  });

  it('leaves shared keys and physical keys unmapped', () => {
    setProfileMapping('p1');
    appStorage.setItem('resume-designer-theme', 'dark');
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    appStorage.setItem('resume-p--p2--resume-zoom', '1.5');
    expect(localStorage.getItem('resume-p--p2--resume-zoom')).toBe('1.5');
  });

  it('keys() returns physical names', () => {
    setProfileMapping('p1');
    appStorage.setItem('resume-designer-data', 'x');
    expect(appStorage.keys()).toContain('resume-p--p1--resume-designer-data');
  });

  it('is identity before any profile is set (boot/migration reads)', () => {
    appStorage.setItem('resume-designer-data', 'y');
    expect(localStorage.getItem('resume-designer-data')).toBe('y');
  });
});

describe('restore guard (blocks external writers mid-import, replays on failed restore)', () => {
  it('defers external writes while armed; import writes before it still land', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });

    // The import's own synchronous restore write happens BEFORE the guard arms.
    appStorage.setItem('resume-designer-data', 'restored');
    appStorage.beginRestoreGuard();

    // A late async completion tries to write while the restore awaits its flush.
    appStorage.setItem('resume-designer-chat-threads', 'late-reply');
    appStorage.removeItem('resume-designer-data'); // …and something tries to drop a restored key
    await appStorage.flush();

    // Guarded ops never reached disk; the pre-guard restore write did. This arm
    // has NO snapshot, so reads return the committed cache — the deferred write is
    // invisible to reads and not persisted (read-your-writes applies only in the
    // snapshot-isolated window).
    expect(backend.files.get('resume-designer-data')).toBe('restored');
    expect(backend.files.has('resume-designer-chat-threads')).toBe(false);
    expect(appStorage.getItem('resume-designer-chat-threads')).toBeNull();
  });

  it('replays the latest skipped write per key after a failed-restore rollback', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.beginRestoreGuard();
    appStorage.setItem('resume-designer-chat-threads', 'first');
    appStorage.setItem('resume-designer-chat-threads', 'latest'); // only the latest survives

    // Failure path: disarm, (rollback would run here), replay, flush.
    appStorage.endRestoreGuard();
    appStorage.flushDeferredWrites();
    await appStorage.flush();

    expect(backend.files.get('resume-designer-chat-threads')).toBe('latest');
    expect(appStorage.getItem('resume-designer-chat-threads')).toBe('latest');
  });

  it('discards deferred writes when the guard stays armed (success path reloads)', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.beginRestoreGuard();
    appStorage.setItem('resume-designer-chat-threads', 'lost-on-reload');
    await appStorage.flush();
    // No flushDeferredWrites(): a successful restore reloads, discarding these.
    expect(backend.files.has('resume-designer-chat-threads')).toBe(false);
  });

  it('serves pre-restore reads under the guard so read-modify-writes replay safely', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    // The import already wrote the RESTORED value to cache, then arms the guard
    // with the pre-restore snapshot (the value it removed).
    appStorage.setItem('resume-token-usage', 'RESTORED');
    appStorage.beginRestoreGuard(new Map([['resume-token-usage', 'PRE:100']]));

    // A read-modify-write writer reads PRE-restore (not the uncommitted RESTORED
    // value) and accumulates across completions via its own in-flight deferred write.
    expect(appStorage.getItem('resume-token-usage')).toBe('PRE:100');
    appStorage.setItem('resume-token-usage', 'PRE:100+a');
    expect(appStorage.getItem('resume-token-usage')).toBe('PRE:100+a');
    appStorage.setItem('resume-token-usage', 'PRE:100+a+b');

    // Failed restore: disarm, rollback restores pre-restore, replay the deferred.
    appStorage.endRestoreGuard();
    appStorage.setItem('resume-token-usage', 'PRE:100'); // (rollback restores pre-restore)
    appStorage.flushDeferredWrites();
    await appStorage.flush();
    // The accumulated write replayed on top of pre-restore — prior history intact,
    // NOT clobbered with the RESTORED-derived value.
    expect(backend.files.get('resume-token-usage')).toBe('PRE:100+a+b');
  });

  it('reads an ABSENT pre-restore key as null, then replays the writer\'s OWN new write', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem('resume-token-usage', 'IMPORTED:50'); // the backup ADDED a new key
    await appStorage.flush();
    // Empty pre-restore map + the key listed as WRITTEN → beginRestoreGuard marks
    // it absent (null): mirrors an import adding a previously-absent key.
    appStorage.beginRestoreGuard(new Map(), ['resume-token-usage']);

    // A read-modify-write writer sees "absent" (not the uncommitted imported value),
    // so its write is its OWN first record derived from null.
    expect(appStorage.getItem('resume-token-usage')).toBeNull();
    appStorage.setItem('resume-token-usage', 'usage-a'); // its deferred write

    // Failed restore: rollback removes the added (imported) key; replay then writes
    // the writer's OWN record — real paid activity — NOT the discarded imported value.
    appStorage.endRestoreGuard();
    appStorage.removeItem('resume-token-usage'); // (rollback removes the added key)
    appStorage.flushDeferredWrites();
    await appStorage.flush();
    expect(backend.files.get('resume-token-usage')).toBe('usage-a');
  });

  it('maps snapshot keys to physical so a format-1 (logical) written key isolates', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    setProfileMapping('p1'); // owned reads/writes now map to resume-p--p1--<logical>
    appStorage.setItem('resume-designer-data', 'IMPORTED'); // import added it (writes the physical key)
    await appStorage.flush();
    // The import passes the LOGICAL written key; beginRestoreGuard must map it to
    // physical, or the mapped read would miss it and leak the imported value.
    appStorage.beginRestoreGuard(new Map(), ['resume-designer-data']);
    expect(appStorage.getItem('resume-designer-data')).toBeNull(); // reads absent, not IMPORTED
  });

  it('reads the committed cache (not a deferred stale value) when the guard has no snapshot', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem('resume-designer-chat-threads', 'IMPORTED');
    await appStorage.flush();
    appStorage.beginRestoreGuard(); // stay-put re-arm: no snapshot
    appStorage.setItem('resume-designer-chat-threads', 'STALE-post-alert'); // deferred (blocked)
    // A recovery export must serialize the committed cache, NOT the deferred value.
    expect(appStorage.getItem('resume-designer-chat-threads')).toBe('IMPORTED');
    expect(backend.files.get('resume-designer-chat-threads')).toBe('IMPORTED'); // cache protected
  });
});
