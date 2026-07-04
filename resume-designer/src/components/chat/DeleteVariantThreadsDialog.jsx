import { useEffect, useState } from 'react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Imperative 3-outcome prompt for deleting a résumé that still has chat threads.
// Mirrors the confirmDestructive singleton pattern (rd:confirm), but resolves to
// 'cancel' | 'keep' | 'delete' instead of a boolean. The host is mounted once in
// App, next to <ConfirmHost />.

let resolver = null;

/**
 * Resolve with the user's choice:
 *  - 'cancel' — abort the variant delete entirely
 *  - 'keep'   — keep the threads (move them to General)
 *  - 'delete' — delete the threads along with the résumé
 */
export function askDeleteVariantThreads({ name, count }) {
  return new Promise((resolve) => {
    resolver?.('cancel'); // a newer prompt supersedes any pending one
    resolver = resolve;
    window.dispatchEvent(new CustomEvent('rd:delete-variant-threads', { detail: { name, count } }));
  });
}

export function DeleteVariantThreadsHost() {
  const [state, setState] = useState(null); // { name, count } | null

  useEffect(() => {
    const onOpen = (e) => setState(e.detail);
    window.addEventListener('rd:delete-variant-threads', onOpen);
    return () => window.removeEventListener('rd:delete-variant-threads', onOpen);
  }, []);

  const finish = (result) => {
    setState(null);
    resolver?.(result);
    resolver = null;
  };

  const count = state?.count ?? 0;

  return (
    <AlertDialog open={!!state} onOpenChange={(open) => !open && finish('cancel')}>
      <AlertDialogContent className="glass-card">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{state?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This résumé has {count} chat thread{count === 1 ? '' : 's'}.
            Keep them (moved to General) or delete them too?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish('cancel')}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => finish('keep')}>Keep threads</AlertDialogAction>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => finish('delete')}
          >
            Delete threads
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
