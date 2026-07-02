import { useEffect, useState } from 'react';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SafeMarkdown } from '@/components/ui/SafeMarkdown';

// Imperative, promise-returning update-notes dialog — same pattern as
// confirm.jsx. `mode: 'update'` resolves 'download' | 'later'; `mode: 'whatsnew'`
// (post-update) resolves 'ok'. UpdateNotesHost is mounted once in App.
let resolver = null;

export function showUpdateNotes({ version, currentVersion = null, notes = '', full = '', mode = 'update' }) {
  return new Promise((resolve) => {
    resolver?.(mode === 'update' ? 'later' : 'ok'); // a newer call supersedes any pending dialog
    resolver = resolve;
    window.dispatchEvent(new CustomEvent('rd:update-notes', {
      detail: { version, currentVersion, notes, full, mode },
    }));
  });
}

export function UpdateNotesHost() {
  const [opts, setOpts] = useState(null);

  useEffect(() => {
    const onOpen = (e) => setOpts(e.detail);
    window.addEventListener('rd:update-notes', onOpen);
    return () => window.removeEventListener('rd:update-notes', onOpen);
  }, []);

  const settle = (result) => {
    setOpts(null);
    resolver?.(result);
    resolver = null;
  };

  const isUpdate = opts?.mode === 'update';
  const title = isUpdate ? `Update available — v${opts?.version}` : `What's new in v${opts?.version}`;
  const hasFull = !!opts?.full && opts.full !== opts.notes;

  return (
    <Dialog open={!!opts} onOpenChange={(open) => !open && settle(isUpdate ? 'later' : 'ok')}>
      <DialogContent className="glass-card max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Release notes</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto pr-1">
          {opts?.notes
            ? <SafeMarkdown className="chat-markdown text-sm" content={opts.notes} />
            : <p className="text-sm text-muted-foreground">No release notes for this version.</p>}
          {hasFull && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Full changelog</summary>
              <SafeMarkdown className="chat-markdown mt-2 text-xs" content={opts.full} />
            </details>
          )}
        </div>
        <DialogFooter>
          {isUpdate ? (
            <>
              <Button variant="outline" onClick={() => settle('later')}>Later</Button>
              <Button onClick={() => settle('download')}>Download</Button>
            </>
          ) : (
            <Button onClick={() => settle('ok')}>Got it</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
