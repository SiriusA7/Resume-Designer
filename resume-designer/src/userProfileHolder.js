/**
 * The live User Profile working copy.
 *
 * `data:userProfile` is one sync unit (syncUnits.js's PLAIN_FIELDS), and
 * `saveUserProfile` (persistence.js) replaces that whole field from whatever
 * object it is handed. So the app's one long-lived copy of that object decides
 * whether a profile another device sent survives — and there is exactly one:
 * ProfileDialog's `profileRef`, a working copy taken when the dialog opens,
 * mutated in place by every field in it, and debounce-written back WHOLE. The
 * dialog is mounted for the app's whole lifetime (App.jsx renders it
 * unconditionally, so its `rd:profile-flush` listener is present even when
 * closed), so that ref long outlives any landing.
 *
 * The trap is the one KEY_OWNERS documents (src/sync/syncModel.js), one field
 * further in: a profile this device applied lasted exactly until the next
 * keystroke, whose debounced save wrote the OPEN-TIME snapshot back over the
 * merged field, stamped the unit (`changedDataUnits` sees a genuinely changed
 * payload) and — this device legitimately holding the record's change tag,
 * because the page had confirmed the apply — pushed the revert up as a clean,
 * uncontested update. No conflict was raised and nothing was parked: the other
 * device's profile was simply gone. The window is not a narrow one: the profile
 * editor is where someone types out a whole work history, so "open for minutes"
 * is its ordinary state.
 *
 * The native side designed this hazard out rather than fixing it after the fact
 * — see profileBridge.js's header, "There is no working copy on this side,
 * deliberately." The web dialog is exactly that working copy, and sync is a
 * second writer of the same shape as the interview merge it warns about.
 *
 * This module is a LEAF, and that is its whole reason to exist as a file:
 * syncModel.js must reach the holder without importing persistence.js (main.js
 * owns that graph edge — see registerPersistedSaveHandler), and the dialog must
 * reach it without importing the sync layer. Nothing is imported here.
 */

let holder = null;

/**
 * Install (or, with null, remove) the live working-copy holder — `{ isBusy(),
 * adopt() }`. ProfileDialog registers itself while mounted.
 *
 * Returns a deregistration that clears the slot ONLY while this holder is still
 * the one in it: React mounts a replacement before unmounting the holder it
 * replaces, so an unconditional clear would let the departing one deregister
 * the survivor and leave the live copy unreachable — the revert bug back, with
 * no symptom until another device's profile went missing.
 */
export function registerUserProfileHolder(next) {
  const installed = next && typeof next.adopt === 'function' ? next : null;
  holder = installed;
  return () => {
    if (holder === installed) holder = null;
  };
}

/**
 * Whether replacing the working copy right now would destroy work in flight.
 *
 * An edit lives ONLY in that ref until the 500 ms debounce fires — there is no
 * DOM copy behind it and no history to recover it from — so a profile landing
 * mid-edit takes the typing with it. A save that already fired and FAILED counts
 * as in flight too: the dialog still has to retry it (`failedSaveRef`), and
 * adopting would drop the edit that retry exists to persist.
 *
 * Exactly the exposure store.isBusyEditing covers for the résumé's inline edit
 * and threadHolderBusy for a streamed reply, answered from the same place: the
 * dialog's own existing refs, not a flag invented for sync.
 *
 * The caller REFUSES on a true rather than deferring — see
 * src/sync/syncModel.js, where refusing shortens the applied count, the
 * transport forfeits the record's change tag, and the unit is re-offered.
 */
export function userProfileHolderBusy() {
  return holder?.isBusy?.() === true;
}

/**
 * Ask the holder to take the profile now in storage. A no-op when nothing holds
 * a copy, which is the honest answer: every other reader calls getUserProfile(),
 * which reads storage each time.
 */
export function adoptStoredUserProfile() {
  holder?.adopt();
}
