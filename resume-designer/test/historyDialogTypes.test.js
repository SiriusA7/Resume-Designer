import { describe, it, expect } from 'vitest';
import { TYPE_LABELS, TYPE_ICONS } from '../src/components/historyEntryTypes.js';
import { CHANGE_TYPES } from '../src/store.js';

// The version-history dialog labels each entry by its `changeType` and falls
// back to 'Edit' with a pencil for anything it does not know. A fallback is
// fine for a type that never reaches the list; it is a lie for one that does.
describe('the version-history dialog’s type labels', () => {
  it('names every change type the store can write', () => {
    for (const changeType of Object.values(CHANGE_TYPES)) {
      expect(TYPE_LABELS[changeType], changeType).toBeTruthy();
      expect(TYPE_ICONS[changeType], changeType).toBeTruthy();
    }
  });

  it('does not show a parked conflict loser as an ordinary edit', () => {
    // A parked loser is one of the two versions two devices held when both
    // edited the same résumé: the newer one won, and this one was kept rather
    // than thrown away so it can be restored. Rendered as "Edit" with a pencil,
    // it claimed to be an ordinary change somebody made here.
    expect(TYPE_LABELS[CHANGE_TYPES.SYNC_CONFLICT]).not.toBe(TYPE_LABELS[CHANGE_TYPES.EDIT]);
    expect(TYPE_ICONS[CHANGE_TYPES.SYNC_CONFLICT]).not.toBe(TYPE_ICONS[CHANGE_TYPES.EDIT]);
  });

  it('does not claim a parked conflict loser came from another device', () => {
    // It is this device's OWN version whenever the remote copy is the newer
    // one, which is half of all conflicts — and the half in which the person is
    // looking for the work they just lost. The label must be true of both
    // directions, so it names which of the two versions this is and not whose.
    expect(TYPE_LABELS[CHANGE_TYPES.SYNC_CONFLICT]).not.toMatch(/device|another|their/i);
  });
});
