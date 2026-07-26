/**
 * Liveness guard for surfaces that latch a change set at open and then
 * delegate decisions to the live changeSession (DiffDialog's "owned" mode).
 *
 * changeSession.startSession() REPLACES an in-flight session without ending
 * it, so a follow-up proposal that finishes streaming behind an open dialog
 * swaps the session's change set out from under it. The dialog keeps
 * rendering the set it latched, but the shared inline actions it delegates to
 * resolve paths against the LIVE session — acting would apply changes the
 * user never saw. Object identity between the displayed set and
 * getChangeSet() is therefore the supersession signal (pinned by
 * test/changeSessionGuard.test.js).
 *
 * A null live set is NOT supersession: endSession() fires once the last path
 * is decided, the dialog deliberately keeps its final status frame through
 * its auto-close grace, and every delegate is a safe no-op without a session.
 *
 * @param {Object|null} displayedSet - the change set the surface latched at open
 * @param {Object|null} liveSet - changeSession.getChangeSet() right now
 * @param {boolean} owned - whether the surface delegates decisions to the session
 * @returns {boolean} true when the surface shows a stale set and must not act
 */
export function isSupersededSession(displayedSet, liveSet, owned) {
  return !!(owned && displayedSet && liveSet && liveSet !== displayedSet);
}
