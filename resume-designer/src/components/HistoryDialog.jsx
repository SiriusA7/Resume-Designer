import { useEffect, useReducer, useState } from 'react';
import { FileText, Pencil, RotateCcw, Columns2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { store } from '../store.js';
// The badge label and icon per changeType, in their own module: see the header
// there for why they are not in this file.
import { TYPE_LABELS, TYPE_ICONS } from './historyEntryTypes.js';
import { diffResumeData } from '../diffEngine.js';
import { showDiffView } from '../diffView.js';

// Version-history dialog — a vertical-rail timeline, matching the approved mockup
// (rd-timeline): each entry is a row with a left rail (bordered 30px icon dot +
// a 1.5px connector line down to the next dot) and a body holding a squared type
// badge + relative time, the description, and outline Restore/Compare actions
// (the current version gets a terracotta-tinted dot + a "Current" badge instead).
// Built from genuine shadcn primitives (Dialog / Badge / Button) + Tailwind, no
// bespoke CSS. Opens on `rd:open-history`; Restore/Compare go through the store +
// diffView. Restore confirm() -> confirmDestructive; compare no-diff -> toast.

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

export default function HistoryDialog() {
  const [open, setOpen] = useState(false);
  // Force a re-read of the store's history list while the dialog is open.
  const [, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('rd:open-history', onOpen);
    return () => window.removeEventListener('rd:open-history', onOpen);
  }, []);

  // Re-render when history changes (e.g. after a restore) — only while open.
  useEffect(() => {
    if (!open) return;
    return store.subscribe((event) => {
      if (event === 'historyChanged') bump();
    });
  }, [open]);

  const entries = open ? store.getHistoryEntries() : [];
  const currentIndex = open ? store.getHistoryIndex() : -1;

  const handleRestore = async (index) => {
    // PAIRED with the version the row named. A history unit fetched from another
    // device merges into this array and renumbers it, and the confirm is an
    // unbounded wait — so the index on its own would restore a different whole
    // document than the dialog described. The native route carries the
    // timestamp for exactly this reason; see `restoreVersion` in main.js.
    const stamp = entries[index]?.timestamp;
    const ok = await confirmDestructive({
      title: 'Restore to this version?',
      description: 'Your current changes will be saved in history.',
      actionLabel: 'Restore',
      destructive: false,
    });
    if (!ok) return;
    if (store.getHistoryEntries()[index]?.timestamp !== stamp) {
      toast.error('That version moved while the dialog was open — nothing was restored.');
      return;
    }
    store.restoreToEntry(index); // fires historyChanged -> bump() re-renders
  };

  const handleCompare = (index) => {
    const selectedData = store.getHistoryEntryData(index);
    const currentData = store.getData();
    if (!selectedData || !currentData) return;

    const changes = diffResumeData(selectedData, currentData);
    if (changes.length === 0) {
      toast.info('No differences found between these versions.');
      return;
    }
    const changeSet = {
      currentData: selectedData,
      proposedData: currentData,
      changes,
      getSummary() {
        const added = changes.filter((c) => c.type === 'add').length;
        const removed = changes.filter((c) => c.type === 'remove').length;
        const modified = changes.filter((c) => c.type === 'modify').length;
        return { added, removed, modified, total: changes.length };
      },
    };
    setOpen(false);
    showDiffView(changeSet);
  };

  // Newest first; map back to the store's original (ascending) index.
  const rows = [...entries].map((entry, i) => ({ entry, originalIndex: i })).reverse();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[90vw] max-w-md flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">Resume change history with restore and compare</DialogDescription>

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-b p-6">
          <div className="space-y-1">
            <DialogTitle>Version history</DialogTitle>
            <p className="text-sm text-muted-foreground">Restore or compare earlier versions.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        {/* Body — vertical-rail timeline (mockup rd-timeline). */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-14 text-center">
              <FileText className="mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">No history yet</p>
              <span className="text-sm text-muted-foreground">Changes will appear here as you edit</span>
            </div>
          ) : (
            <div className="flex flex-col">
              {rows.map(({ entry, originalIndex }, rowIdx) => {
                const isCurrent = originalIndex === currentIndex;
                const isLast = rowIdx === rows.length - 1;
                const label = TYPE_LABELS[entry.changeType] || 'Edit';
                const Icon = TYPE_ICONS[entry.changeType] || Pencil;
                return (
                  <div key={originalIndex} className="flex gap-3.5">
                    {/* Rail: bordered 30px dot (terracotta on the current version)
                        + a 1.5px connector line down to the next dot. */}
                    <div className="flex flex-col items-center">
                      <div
                        className={cn(
                          'flex size-[30px] shrink-0 items-center justify-center rounded-full border',
                          isCurrent
                            ? 'border-primary bg-primary/[0.06] text-primary'
                            : 'bg-background text-muted-foreground',
                        )}
                      >
                        <Icon className="size-[15px]" />
                      </div>
                      {!isLast && <div className="my-1 w-[1.5px] flex-1 bg-border" />}
                    </div>
                    {/* Body */}
                    <div className={cn('flex-1', !isLast && 'pb-[18px]')}>
                      <div className="flex items-center gap-2">
                        {/* Squared type badge (mockup rd-type-badge): muted, 11.5px/600. */}
                        <span className="inline-flex items-center rounded-[6px] bg-muted px-2 py-px text-[11.5px] font-semibold text-foreground">
                          {label}
                        </span>
                        <span className="text-xs text-muted-foreground">{formatTime(entry.timestamp)}</span>
                        {isCurrent && <Badge variant="secondary" className="ml-auto">Current</Badge>}
                      </div>
                      <p className="mt-1.5 text-[13.5px] leading-snug">{entry.description}</p>
                      {!isCurrent && (
                        <div className="mt-2.5 flex gap-2">
                          <Button variant="outline" size="sm" className="h-[31px] rounded-[7px] text-[12.5px]" onClick={() => handleRestore(originalIndex)}>
                            <RotateCcw className="size-[13px]" /> Restore
                          </Button>
                          <Button variant="outline" size="sm" className="h-[31px] rounded-[7px] text-[12.5px]" onClick={() => handleCompare(originalIndex)}>
                            <Columns2 className="size-[13px]" /> Compare
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
