/**
 * The bound on one variant's version history.
 *
 * Owned by neither of the two modules that enforce it. store.js's `pushHistory`
 * trims to this number and src/sync/syncMerge.js's `mergeHistory` caps to it,
 * and the two have to agree to the letter — a merge that kept more than the
 * store's bound would just be trimmed on the next edit, one entry per edit,
 * silently. Two literal `100`s with nothing keeping them equal is the failure
 * being avoided.
 *
 * Neither may own it. syncMerge.js is deliberately pure — no storage, no DOM,
 * no app imports — so taking the number from store.js would drag appStorage and
 * everything under it into the sync layer's one pure module. Taking it the
 * other way round made the core store import the sync layer, and
 * src/sync/syncModel.js already imports store.js: no cycle exists today, but it
 * would close the moment anything in the store called into sync.
 *
 * So it lives here, in a leaf that imports nothing and can be imported from
 * either side.
 */
export const MAX_HISTORY = 100;
