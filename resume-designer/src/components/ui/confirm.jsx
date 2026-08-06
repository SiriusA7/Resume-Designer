import { useEffect, useState } from 'react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Imperative replacement for window.confirm() in React surfaces (spec §5.11).
// confirmDestructive(opts) resolves true/false; ConfirmHost is mounted once in App.

let resolver = null;

export function confirmDestructive({
  title, description, actionLabel = 'Confirm', cancelLabel = 'Cancel', destructive = true,
}) {
  return new Promise((resolve) => {
    resolver?.(false); // a newer confirm supersedes any pending one — never leave a caller hanging
    resolver = resolve;
    window.dispatchEvent(new CustomEvent('rd:confirm', { detail: { title, description, actionLabel, cancelLabel, destructive } }));
  });
}

export function ConfirmHost() {
  const [opts, setOpts] = useState(null);

  useEffect(() => {
    const onOpen = (e) => setOpts(e.detail);
    window.addEventListener('rd:confirm', onOpen);
    return () => window.removeEventListener('rd:confirm', onOpen);
  }, []);

  const settle = (result) => {
    setOpts(null);
    resolver?.(result);
    resolver = null;
  };

  return (
    <AlertDialog open={!!opts} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialogContent className="glass-card">
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          <AlertDialogDescription>{opts?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>{opts?.cancelLabel || 'Cancel'}</AlertDialogCancel>
          <AlertDialogAction
            className={opts?.destructive ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
            onClick={() => settle(true)}
          >
            {opts?.actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
