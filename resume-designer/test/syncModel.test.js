import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mapKey } from '../src/profileKeys.js';

// appStorage is the only dependency, and it is mocked so these tests stay
// pure: the real one is an async coalescing writer over a disk backend.
//
// The mock reproduces the real asymmetry deliberately, because it is what a
// naive implementation gets wrong: `keys()` returns PHYSICAL, profile-
// namespaced keys, while `getItem`/`setItem` take LOGICAL ones. A mock that
// returned logical keys from `keys()` would pass against code that never
// syncs anything.
//
// The mapping is the REAL `mapKey`, not a hand-rolled namespacer: it is the
// IDENTITY for shared keys (`resume-designer-profiles`,
// `resume-designer-active-profile`) and for anything the app does not own. A
// mock that namespaced every key never exercised the shared-key path — the one
// `collectUnits`' `?? physical` fallback exists for.
const PROFILE = 'ptest';
const disk = new Map();
const physical = (k) => mapKey(PROFILE, k);
vi.mock('../src/appStorage.js', () => ({
  appStorage: {
    getItem: (k) => (disk.has(physical(k)) ? disk.get(physical(k)) : null),
    // `String(value)` mirrors the real setItem — the reason applyUnits has to
    // refuse a payload that is not a string (it would store "undefined").
    setItem: (k, v) => { disk.set(physical(k), String(v)); },
    keys: () => [...disk.keys()],
  },
  // profiles.js imports this beside appStorage; syncModel reaches profiles.js
  // for getActiveProfileId. Never called here — the active profile is set by
  // seeding its key below, the same way the real app reads it.
  setProfileMapping: () => {},
}));

const { collectUnits, applyUnits, parkLoser, touchUnit, resolveConflict } = await import('../src/sync/syncModel.js');
// The résumé store, not the storage map above: parking into the LOADED
// variant's history has to go through it.
const { store: resumeStore } = await import('../src/store.js');

const DATA = 'resume-designer-data';
const AT = '2026-08-09T00:00:00.000Z';

beforeEach(() => {
  disk.clear();
  disk.set(physical('resume-designer-active-profile'), PROFILE);
  disk.set(physical(DATA), JSON.stringify({
    variants: { 'v-1': { name: 'Design Engineer' } },
    currentVariantId: 'v-1',
    settings: { pageSize: 'letter' },
  }));
  disk.set(physical('resume-designer-applications'), '[]');
  disk.set(physical('resume-zoom'), '1.5');
  // A SHARED key (never namespaced) that nonetheless syncs — see
  // SYNCED_SHARED_KEYS in syncKeys.js.
  disk.set(physical('resume-designer-profiles'), JSON.stringify([{ id: PROFILE, name: 'Personal' }]));
});

describe('collectUnits', () => {
  it('emits a unit per résumé and per synced key, and nothing device-local', () => {
    const ids = collectUnits().map((u) => u.id);
    expect(ids).toContain('resume:v-1');
    expect(ids).toContain('key:resume-designer-applications');
    // A shared key, stored unnamespaced: it reaches this list only through the
    // `?? physical` fallback for a key `splitPhysicalKey` cannot split.
    expect(ids).toContain('key:resume-designer-profiles');
    expect(ids).not.toContain('key:resume-zoom');
    expect(ids).not.toContain('key:resume-designer-active-profile');
    // The data blob never travels whole — it travels decomposed.
    expect(ids).not.toContain('key:resume-designer-data');
  });

  it('leaves an unstamped unit’s time unknown instead of claiming it changed now', () => {
    // A `new Date()` fallback made every unit this device collected newer than
    // any real remote stamp, so resolveConflict handed this device every
    // conflict and parked or discarded the other device's genuine edit — on a
    // timestamp it never earned. Nothing calls touchUnit yet, so that was every
    // unit. An unknown time has to LOSE to a real one.
    touchUnit('resume:v-1');
    const units = collectUnits();
    const stamped = units.find((u) => u.id === 'resume:v-1');
    const unstamped = units.find((u) => u.id === 'key:resume-designer-applications');

    expect(Number.isFinite(Date.parse(stamped.modifiedAt))).toBe(true);
    expect(unstamped.modifiedAt).toBe(null);
    // The remote edit is two years older and still wins, because it is the only
    // side that knows when it changed.
    const remote = { id: unstamped.id, modifiedAt: '2024-01-01T00:00:00.000Z' };
    expect(resolveConflict(unstamped, remote).winner).toBe(remote);
  });

  it('marks token usage with its own kind so the transport can merge it', () => {
    disk.set(physical('resume-designer-token-usage'), JSON.stringify({ events: [], summary: {} }));
    const unit = collectUnits().find((u) => u.id === 'key:resume-designer-token-usage');
    expect(unit.kind).toBe('tokenUsage');
  });

  it('never collects another profile’s key, which getItem would read as the active profile’s', () => {
    // appStorage's cache holds EVERY profile's physical keys. Reducing one to
    // its logical name with no profile check emits it as if it belonged to the
    // active profile, and reads its payload with getItem — which maps to the
    // ACTIVE profile. So the inactive profile's key is either emitted with the
    // wrong profile's value (a SECOND unit under the same id — below) or with
    // an empty one, which lands on another device as setItem(key, '') and wipes
    // the chat threads it names.
    disk.set('resume-p--pother--resume-designer-chat-threads', JSON.stringify([{ id: 't-1' }]));
    disk.set(physical('resume-designer-job-descriptions'), JSON.stringify(['mine']));
    disk.set('resume-p--pother--resume-designer-job-descriptions', JSON.stringify(['theirs']));

    const units = collectUnits();
    const ids = units.map((u) => u.id);
    expect(ids).not.toContain('key:resume-designer-chat-threads');
    expect(ids.filter((id) => id === 'key:resume-designer-job-descriptions')).toHaveLength(1);
    expect(units.find((u) => u.id === 'key:resume-designer-job-descriptions').payload)
      .toBe(JSON.stringify(['mine']));
    for (const unit of units) expect(unit.payload, unit.id).not.toBe('');
  });

  it('skips a synced key getItem cannot read, rather than emitting an empty payload', () => {
    // An unprefixed owned key — pre-adoption residue — is in keys() but reads
    // back as null through getItem, which maps to the active profile. `?? ''`
    // turned that into a unit whose payload CLEARS the key on every other
    // device, and an empty history payload makes store.js's loadHistory throw
    // on JSON.parse('') and reset that variant's history.
    disk.set('resume-designer-chat-threads', JSON.stringify([{ id: 't-1' }]));
    expect(collectUnits().map((u) => u.id)).not.toContain('key:resume-designer-chat-threads');
  });
});

describe('applyUnits', () => {
  it('lands a remote résumé without touching the local currentVariantId', () => {
    applyUnits([{
      id: 'resume:v-2', kind: 'resume',
      payload: JSON.stringify({ name: 'Product Lead' }),
      modifiedAt: AT,
    }]);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(Object.keys(blob.variants).sort()).toEqual(['v-1', 'v-2']);
    expect(blob.currentVariantId).toBe('v-1');
  });

  it('merges token usage instead of replacing it', () => {
    disk.set(physical('resume-designer-token-usage'), JSON.stringify({
      events: [{ id: 'mine', timestamp: '2026-08-01T00:00:00.000Z', inputTokens: 1 }],
      summary: {},
    }));
    applyUnits([{
      id: 'key:resume-designer-token-usage', kind: 'tokenUsage',
      payload: JSON.stringify({
        events: [{ id: 'theirs', timestamp: '2026-08-02T00:00:00.000Z', inputTokens: 2 }],
        summary: {},
      }),
      modifiedAt: AT,
    }]);
    const merged = JSON.parse(disk.get(physical('resume-designer-token-usage')));
    expect(merged.events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    expect(merged.summary.totalInputTokens).toBe(3);
  });

  it('refuses a unit for a key that is device-local', () => {
    const before = disk.get(physical('resume-zoom'));
    applyUnits([{ id: 'key:resume-zoom', kind: 'plain', payload: '"2"', modifiedAt: AT }]);
    expect(disk.get(physical('resume-zoom'))).toBe(before);
  });

  it('refuses every device-local key, including the stored credential and this device’s sync bookkeeping', () => {
    // A device-local key never leaves a machine, so one arriving is a bug on
    // the other end or an attack on this one. Honouring it would let a remote
    // unit overwrite the OpenRouter credential, or rewrite the sync state this
    // device uses to decide what it has already sent.
    for (const key of ['resume-designer-openrouter-key', 'resume-designer-sync-state', 'resume-designer-theme']) {
      const { applied } = applyUnits([{ id: `key:${key}`, kind: 'plain', payload: '"stolen"', modifiedAt: AT }]);
      expect(applied, key).toBe(0);
      expect(disk.has(physical(key)), key).toBe(false);
    }
  });

  it('unions a version-history unit into local history instead of overwriting the loser parked in it', () => {
    // Version history syncs precisely so a conflict's losing edit is not
    // stranded on the device that received it (syncKeys.js) — and it is
    // append-shaped, so a whole-key setItem here destroyed exactly that: the
    // loser parkLoser had just written, gone the moment the other device's
    // history landed.
    disk.set(physical('resume-designer-history-v-9'), JSON.stringify({
      history: [{ data: { name: 'The version that lost' }, timestamp: '2026-08-09T00:00:00.000Z', description: 'Conflicting edit synced from another device', changeType: 'sync-conflict' }],
      historyIndex: 0,
    }));
    const payload = JSON.stringify({
      history: [{ data: { name: 'Edited on the iPhone' }, timestamp: '2026-08-08T00:00:00.000Z', description: 'Edit', changeType: 'edit' }],
      historyIndex: 0,
    });
    expect(applyUnits([{ id: 'key:resume-designer-history-v-9', kind: 'plain', payload, modifiedAt: AT }]).applied).toBe(1);

    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-9')));
    expect(stored.history.map((e) => e.changeType)).toEqual(['edit', 'sync-conflict']);
    expect(stored.historyIndex).toBe(1);
  });

  it('lands a history unit for the LOADED variant through the store, so the next edit does not undo the merge', () => {
    // store.js holds the loaded variant's history in memory and saveHistory
    // rewrites the whole key from that array — which never saw a merge written
    // straight to storage. So a storage-only merge survives exactly until the
    // next keystroke, which is the same trap parkLoser documents.
    resumeStore.setData({ name: 'Loaded' }, true, 'v-loaded');
    applyUnits([{
      id: 'key:resume-designer-history-v-loaded',
      kind: 'plain',
      payload: JSON.stringify({
        history: [{ data: { name: 'From the other device' }, timestamp: '2026-08-08T00:00:00.000Z', description: 'Edit on iPhone', changeType: 'edit' }],
        historyIndex: 0,
      }),
      modifiedAt: AT,
    }]);

    resumeStore.update('name', 'Edited after the sync');

    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-loaded')));
    expect(stored.history.map((e) => e.description)).toContain('Edit on iPhone');
    // The merge archives; it does not restore. The document is still the local
    // one, and the redo future is empty so the edit above spliced nothing away.
    expect(resumeStore.getData().name).toBe('Edited after the sync');
    expect(stored.historyIndex).toBe(stored.history.length - 1);
  });

  it('lands the blob’s settings and userProfile units, which used to be dropped in silence', () => {
    // splitData emits them and mergeData reassembles them, but applyUnits
    // matched only `resume:` and `key:` — so settings and the user profile
    // synced OUT of a device and never back into it.
    const { applied } = applyUnits([
      { id: 'data:settings', kind: 'plain', payload: JSON.stringify({ pageSize: 'a4' }), modifiedAt: AT },
      { id: 'data:userProfile', kind: 'plain', payload: JSON.stringify({ name: 'Ash' }), modifiedAt: AT },
    ]);

    expect(applied).toBe(2);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(blob.settings).toEqual({ pageSize: 'a4' });
    expect(blob.userProfile).toEqual({ name: 'Ash' });
    // Reassembly leaves the rest of the blob alone, device-local field included.
    expect(blob.currentVariantId).toBe('v-1');
    expect(Object.keys(blob.variants)).toEqual(['v-1']);
  });

  it('refuses a data unit for a field that never travels, and does not count it', () => {
    // `currentVariantId` is absent from splitData's list on purpose: which
    // résumé is open is a property of a device. mergeData refuses it, so the
    // count here has to refuse it too rather than report a phantom apply.
    const { applied } = applyUnits([{ id: 'data:currentVariantId', kind: 'plain', payload: '"v-2"', modifiedAt: AT }]);
    expect(applied).toBe(0);
    expect(JSON.parse(disk.get(physical(DATA))).currentVariantId).toBe('v-1');
  });

  it('lands the units around a corrupt payload, and counts only the ones that landed', () => {
    // mergeData skips an unparseable payload so one bad record cannot stop the
    // rest of a sync (syncUnits.js). Counting it anyway reported 3 applied when
    // 2 landed — and `applied` is the only thing that tells a caller a no-op
    // from a failure.
    const { applied } = applyUnits([
      { id: 'resume:v-2', kind: 'resume', payload: JSON.stringify({ name: 'Product Lead' }), modifiedAt: AT },
      { id: 'resume:v-3', kind: 'resume', payload: '{ not json', modifiedAt: AT },
      { id: 'key:resume-designer-applications', kind: 'plain', payload: '[{"id":"a-1"}]', modifiedAt: AT },
    ]);
    expect(applied).toBe(2);
    const blob = JSON.parse(disk.get(physical(DATA)));
    expect(Object.keys(blob.variants).sort()).toEqual(['v-1', 'v-2']);
    expect(disk.get(physical('resume-designer-applications'))).toBe('[{"id":"a-1"}]');
  });

  it('refuses a malformed unit rather than writing the text “undefined” into a real key', () => {
    // appStorage.setItem does String(value), so a unit that crossed the native
    // bridge without a payload would store the literal string "undefined" —
    // data that looks written and parses nowhere.
    const before = disk.get(physical('resume-designer-applications'));
    const { applied } = applyUnits([{ id: 'key:resume-designer-applications', kind: 'plain', modifiedAt: AT }]);
    expect(applied).toBe(0);
    expect(disk.get(physical('resume-designer-applications'))).toBe(before);
  });

  it('reports how many landed, so a caller can tell a no-op from a failure', () => {
    expect(applyUnits([]).applied).toBe(0);
  });
});

describe('parkLoser', () => {
  // The real key/shape, confirmed against src/store.js (saveHistory/
  // loadHistory) and src/components/HistoryDialog.jsx: the value at
  // `resume-designer-history-<variantId>` (BACKUP_HISTORY_PREFIX + variantId
  // — no "-variant-" infix) is `{ history: [...], historyIndex }`, and each
  // entry the dialog renders carries `data`, `timestamp`, `description` and
  // `changeType`. A brief that wrote a bare array to
  // `resume-designer-history-variant-<id>` would park the loser at a key
  // nothing reads and in a shape loadHistory() would discard on the next load.
  it('writes a losing résumé into that résumé’s version history, in the shape store.js reads', () => {
    const ok = parkLoser('resume:v-1', JSON.stringify({ name: 'The version that lost' }));
    expect(ok).toBe(true);
    const historyData = JSON.parse(disk.get(physical('resume-designer-history-v-1')));
    expect(Array.isArray(historyData.history)).toBe(true);
    const entry = historyData.history.at(-1);
    expect(entry.data).toEqual({ name: 'The version that lost' });
    expect(entry.changeType).toBe('sync-conflict');
    expect(typeof entry.description).toBe('string');
    expect(entry.description.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
  });

  it('adds to existing history rather than clobbering it, and keeps historyIndex on the entry that was current', () => {
    disk.set(physical('resume-designer-history-v-1'), JSON.stringify({
      history: [
        { data: { name: 'Older' }, timestamp: '2026-07-31T00:00:00.000Z', description: 'Older', changeType: 'edit' },
        { data: { name: 'Design Engineer' }, timestamp: '2026-08-01T00:00:00.000Z', description: 'Initial state', changeType: 'initial' },
      ],
      historyIndex: 1,
    }));
    parkLoser('resume:v-1', JSON.stringify({ name: 'The version that lost' }));
    const historyData = JSON.parse(disk.get(physical('resume-designer-history-v-1')));

    expect(historyData.history).toHaveLength(3);
    expect(historyData.history.map((e) => e.description)).toContain('Older');
    // The index moved by one, but it still points at the same ENTRY: parking
    // changes what history holds, not what the document considers current.
    expect(historyData.history[historyData.historyIndex].description).toBe('Initial state');
    // And the parked entry is in the PAST, not in the redo future that
    // store.js's pushHistory splices away on the next edit.
    const parkedAt = historyData.history.findIndex((e) => e.changeType === 'sync-conflict');
    expect(parkedAt).toBeLessThan(historyData.historyIndex);
    // Not the entry one undo away either — the index moves up with the park, so
    // parking AT the index makes the loser what the next Cmd+Z restores. Same
    // rule as store.js's adoptHistoryEntry, which the loaded variant takes.
    expect(historyData.history[historyData.historyIndex - 1].description).toBe('Older');
  });

  it('keeps a parked loser through the next local edit, which is the entire point of parking it', () => {
    // The loaded variant's history lives in store.js's in-memory array, and
    // saveHistory rewrites the whole key from it — an array that never saw an
    // entry written straight to storage. On top of that, pushHistory splices
    // away everything after historyIndex before it appends. So a park that
    // wrote the key directly (or appended into that future) was gone one
    // keystroke later, and "newer wins is safe because nothing is destroyed"
    // was destroying the losing version it promised to keep.
    resumeStore.setData({ name: 'Design Engineer' }, true, 'v-park');
    expect(parkLoser('resume:v-park', JSON.stringify({ name: 'The version that lost' }))).toBe(true);

    resumeStore.update('name', 'Edited after the park');

    const historyData = JSON.parse(disk.get(physical('resume-designer-history-v-park')));
    const parked = historyData.history.filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
    expect(parked[0].data).toEqual({ name: 'The version that lost' });
    // The winner is still what the document shows — parking archives, it does
    // not restore.
    expect(resumeStore.getData().name).toBe('Edited after the park');
  });

  it('parks out of undo’s way, so one Cmd+Z does not restore another device’s rejected résumé', () => {
    // Landing the entry AT historyIndex put it one slot below the index once
    // the index moved up to keep pointing at the same entry — which is the undo
    // target. A park would then hand the user the version their newer edit had
    // just beaten, on the next Cmd+Z. Splice-safety only needs a position at or
    // below the index, so the entry goes BELOW it and undo is untouched.
    resumeStore.setData({ name: 'First' }, true, 'v-undo');
    resumeStore.update('name', 'Second');
    expect(parkLoser('resume:v-undo', JSON.stringify({ name: 'The version that lost' }))).toBe(true);

    expect(resumeStore.undo()).toBe(true);
    expect(resumeStore.getData().name).toBe('First');

    // And it is still parked — out of undo's way, not out of history.
    const stored = JSON.parse(disk.get(physical('resume-designer-history-v-undo')));
    const parked = stored.history.filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
    expect(parked[0].data).toEqual({ name: 'The version that lost' });
  });

  it('refuses a unit that is not a résumé, which has no history to park in', () => {
    expect(parkLoser('key:resume-designer-applications', '[]')).toBe(false);
    expect(parkLoser('key:resume-designer-history-v-1', '{}')).toBe(false);
  });
});

describe('touchUnit', () => {
  it('records a modification time that collectUnits then reports', () => {
    touchUnit('resume:v-1');
    const unit = collectUnits().find((u) => u.id === 'resume:v-1');
    const state = JSON.parse(disk.get(physical('resume-designer-sync-state')));
    expect(unit.modifiedAt).toBe(state['resume:v-1'].modifiedAt);
  });
});
