/**
 * A refused write has to reach the native sheet that caused it.
 *
 * `setItem` returns when the CACHE takes the value, so `persistThreads`'s own
 * try/catch sees nothing on a device: the disk write is behind a coalescing
 * drain and the refusal arrives later through `onWriteFailure`, naming the key
 * and nothing else. On iOS the chat is a native sheet over the page, so the
 * global toast the web relies on renders underneath it — the projection is the
 * only way this can be said. Same for the structure editor and the résumé blob.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping }
  from '../src/appStorage.js';
import { persistThreads, threadsSaveFailed, CHAT_THREADS_STATE_EVENT }
  from '../src/chatThreads.js';
import { saveToStorage, dataSaveFailed, DATA_SAVE_STATE_EVENT }
  from '../src/persistence.js';

const THREADS = 'resume-designer-chat-threads';
const DATA = 'resume-designer-data';

let refuse = null;

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  refuse = null;
  const files = new Map();
  await initAppStorage({
    backend: {
      loadAll: vi.fn(async () => Object.fromEntries(files)),
      write: vi.fn(async (key, value) => {
        if (refuse === key) throw new Error('no space left on device');
        files.set(key, value);
      }),
      delete: vi.fn(async (key) => { files.delete(key); }),
      clear: vi.fn(async () => { files.clear(); }),
    },
  });
});

const thread = (title) => [{ id: 't1', name: title, messages: [] }];

describe('a chat that is not reaching disk', () => {
  it('reports the refusal, announces it, and takes it back when a write lands', async () => {
    // The whole arc in one test on purpose: the flag is module state, and two
    // tests sharing it would pass in one order and not the other.
    const announced = [];
    const listener = () => announced.push(threadsSaveFailed());
    window.addEventListener(CHAT_THREADS_STATE_EVENT, listener);
    try {
      refuse = THREADS;
      persistThreads(thread('Cover letter'));
      // Nothing is known yet — the cache took it, which is all `setItem` says.
      expect(threadsSaveFailed()).toBe(false);

      await appStorage.flush();
      expect(threadsSaveFailed()).toBe(true);
      // And it SAID so. Without the event nothing republishes the projection —
      // a disk refusal is not a React change — so the warning would wait for
      // whatever unrelated mutation happened to publish next.
      expect(announced).toEqual([true]);

      refuse = null;
      persistThreads(thread('Cover letter'));
      await appStorage.flush();
      expect(threadsSaveFailed()).toBe(false);
      expect(announced).toEqual([true, false]);
    } finally {
      window.removeEventListener(CHAT_THREADS_STATE_EVENT, listener);
    }
  });
});

describe('a résumé that is not reaching disk', () => {
  it('reports the refusal and takes it back when a write lands', async () => {
    // The structure sheet is the one that needed this: it is a native sheet
    // over the page, so the canvas behind it goes on showing the edit while
    // the toast that would say otherwise renders underneath.
    const announced = [];
    const listener = () => announced.push(dataSaveFailed());
    window.addEventListener(DATA_SAVE_STATE_EVENT, listener);
    try {
      refuse = DATA;
      expect(saveToStorage({ variants: {}, currentVariantId: null })).toBe(true);
      // `true` — and that is the whole problem. In cached mode `setItem` takes
      // the value without touching the disk, so the return value says nothing
      // about durability and this writer cannot tell the caller anything.
      expect(dataSaveFailed()).toBe(false);

      await appStorage.flush();
      expect(dataSaveFailed()).toBe(true);
      expect(announced).toEqual([true]);

      refuse = null;
      saveToStorage({ variants: {}, currentVariantId: null });
      await appStorage.flush();
      expect(dataSaveFailed()).toBe(false);
      expect(announced).toEqual([true, false]);
    } finally {
      window.removeEventListener(DATA_SAVE_STATE_EVENT, listener);
    }
  });
});
