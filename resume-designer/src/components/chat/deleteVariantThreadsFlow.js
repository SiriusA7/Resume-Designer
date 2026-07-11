/**
 * Shared thread-handling contract for deleting a résumé variant, used by both
 * the Header delete flow and the Library DetailPane. Counts the variant's chat
 * threads and, if any exist, asks the user keep→General vs delete, persists the
 * reassignment via reassignThreadsForDeletedVariant, and (on delete) dispatches
 * rd:threads-deleted so an in-flight stream homed to a dropped thread aborts.
 * MUST run BEFORE the actual variant delete so the id still exists.
 */

import {
  loadThreads, persistThreads, reassignThreadsForDeletedVariant,
  countThreadsForVariant, threadIdsForVariant,
} from '../../chatThreads.js';
import { askDeleteVariantThreads } from './DeleteVariantThreadsDialog.jsx';

/** @returns {Promise<{ cancelled: boolean, hadThreads: boolean }>} */
export async function handleVariantThreadsForDelete({ variantId, variantName }) {
  const all = loadThreads().threads;
  const n = countThreadsForVariant(all, variantId);
  if (n === 0) return { cancelled: false, hadThreads: false };
  const choice = await askDeleteVariantThreads({ name: variantName, count: n });
  if (choice === 'cancel') return { cancelled: true, hadThreads: true };
  persistThreads(
    reassignThreadsForDeletedVariant(all, variantId, choice === 'delete' ? 'delete' : 'general')
  );
  if (choice === 'delete') {
    window.dispatchEvent(new CustomEvent('rd:threads-deleted', {
      detail: { threadIds: threadIdsForVariant(all, variantId) },
    }));
  }
  return { cancelled: false, hadThreads: true };
}
