import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Minus, PencilLine, Check, X, Rows3, Columns2, CheckCheck } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { DIFF_TYPES, getPathLabel } from '../diffEngine.js';
import { applyChangeToStore } from '../changeApply.js';

// Diff review dialog — the React/shadcn rebuild of the former vanilla diffView.js
// overlay (§5.9). Always mounted; opens on the `rd:open-diff` window event that
// diffView.js's showDiffView() dispatches, carrying { changeSet, onApply }. All
// behavior from the vanilla version is preserved exactly — only the rendering is
// now React + genuine shadcn primitives (Dialog / Badge / Button / Separator /
// ScrollArea):
//   • inline / side-by-side modes (default side-by-side), word-level del/ins diff
//     reusing change.wordDiff from diffEngine (untouched);
//   • per-change Apply via the shared applyChangeToStore helper (changeApply.js),
//     Reject (drops the card; closes when none remain), Applied badge swap;
//   • A apply-next · R reject-next · Enter apply-all · Esc close (ignored while
//     typing in an input/textarea), click-outside close, body scroll lock,
//     empty state, and auto-close 500ms after every change is handled;
//   • live green/red/amber stat badges from changeSet.getSummary() + "N applied".
// Strings render as plain React children (auto-escaped) inside whitespace-pre-wrap
// blocks — the vanilla escapeHtml + \n→<br> handling is no longer needed.

// change.type -> the type Badge (lucide icon + tinted token pair).
const TYPE_META = {
  [DIFF_TYPES.ADD]: { label: 'Added', Icon: Plus, className: 'bg-success-bg text-success' },
  [DIFF_TYPES.REMOVE]: { label: 'Removed', Icon: Minus, className: 'bg-destructive-bg text-destructive' },
  [DIFF_TYPES.MODIFY]: { label: 'Modified', Icon: PencilLine, className: 'bg-warning-bg text-warning' },
};

// Render a word-level diff (array of { type, value }) as plain text with the
// changed runs tinted: removals red, additions green, unchanged inherits.
function WordDiff({ parts }) {
  return parts.map((part, i) => {
    if (part.type === DIFF_TYPES.ADD) {
      return (
        <span key={i} className="rounded-sm bg-success-bg px-0.5 text-success">
          {part.value}
        </span>
      );
    }
    if (part.type === DIFF_TYPES.REMOVE) {
      return (
        <span key={i} className="rounded-sm bg-destructive-bg px-0.5 text-destructive line-through">
          {part.value}
        </span>
      );
    }
    return <span key={i}>{part.value}</span>;
  });
}

// Keyboard hint chip — mockup .kbd: bordered, mono, a 2px bottom border for the
// keycap look, on the dialog surface.
function Kbd({ children }) {
  return (
    <kbd className="inline-block rounded-[5px] border border-b-2 bg-background px-[5px] font-mono text-[10.5px] leading-[1.6] text-muted-foreground">
      {children}
    </kbd>
  );
}

// A tinted Current/Proposed column in side-by-side mode. Mockup .df-cur is always
// red-tinted, .df-prop always green-tinted (rounded-[8px], no border); `dim` fades
// an empty side (the pure add/remove placeholder).
function DiffColumn({ label, tone, dim, children }) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'min-h-9 whitespace-pre-wrap break-words rounded-[8px] px-[11px] py-[9px] text-[12.5px] leading-[1.55]',
          tone === 'proposed' ? 'bg-success-bg text-success' : 'bg-destructive-bg text-destructive',
          dim && 'opacity-55',
        )}
      >
        {children}
      </div>
    </div>
  );
}

// One change card: type badge + section label + Apply/Reject (or Applied), then
// the diff body in the active mode.
function ChangeCard({ change, mode, applied, onApply, onReject }) {
  const meta = TYPE_META[change.type] || TYPE_META[DIFF_TYPES.MODIFY];
  const { Icon } = meta;
  const label = getPathLabel(change.path);

  // Empty-value placeholder matching the vanilla "(empty)" affordance.
  const empty = <span className="italic text-muted-foreground">(empty)</span>;

  let body;
  if (mode === 'inline') {
    let inner;
    if (change.wordDiff) {
      inner = <WordDiff parts={change.wordDiff} />;
    } else if (change.type === DIFF_TYPES.ADD) {
      inner = <span className="rounded-sm bg-success-bg px-0.5 text-success">{change.displayNew}</span>;
    } else if (change.type === DIFF_TYPES.REMOVE) {
      inner = (
        <span className="rounded-sm bg-destructive-bg px-0.5 text-destructive line-through">{change.displayOld}</span>
      );
    } else {
      inner = (
        <>
          <span className="rounded-sm bg-destructive-bg px-0.5 text-destructive line-through">{change.displayOld}</span>
          <span className="px-1.5 text-muted-foreground">→</span>
          <span className="rounded-sm bg-success-bg px-0.5 text-success">{change.displayNew}</span>
        </>
      );
    }
    body = (
      <div className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2.5 text-sm">{inner}</div>
    );
  } else {
    // Side-by-side. For a word-diffed modify, each column shows only its side's
    // runs; otherwise show the plain values with add/remove column tinting.
    let oldContent;
    let newContent;
    if (change.wordDiff && change.type === DIFF_TYPES.MODIFY) {
      oldContent = change.wordDiff
        .filter((p) => p.type !== DIFF_TYPES.ADD)
        .map((p, i) =>
          p.type === DIFF_TYPES.REMOVE ? (
            <span key={i} className="rounded-sm bg-destructive/20 px-0.5 line-through">
              {p.value}
            </span>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        );
      newContent = change.wordDiff
        .filter((p) => p.type !== DIFF_TYPES.REMOVE)
        .map((p, i) =>
          p.type === DIFF_TYPES.ADD ? (
            <span key={i} className="rounded-sm bg-success/20 px-0.5">
              {p.value}
            </span>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        );
    } else {
      oldContent = change.displayOld ? change.displayOld : empty;
      newContent = change.displayNew ? change.displayNew : empty;
    }
    body = (
      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
        <DiffColumn label="Current" dim={change.type === DIFF_TYPES.ADD}>
          {oldContent}
        </DiffColumn>
        <DiffColumn label="Proposed" tone="proposed" dim={change.type === DIFF_TYPES.REMOVE}>
          {newContent}
        </DiffColumn>
      </div>
    );
  }

  return (
    <div className={cn('rounded-[10px] border p-[13px]', applied && 'opacity-60')}>
      <div className="mb-[10px] flex items-center gap-2">
        <Badge className={cn('gap-1 border-transparent', meta.className)}>
          <Icon className="h-3 w-3" />
          {meta.label}
        </Badge>
        <Badge variant="secondary">{label}</Badge>
        <div className="ml-auto flex items-center gap-2">
          {applied ? (
            <Badge className="gap-1 border-transparent bg-success-bg text-success">
              <Check className="h-3 w-3" />
              Applied
            </Badge>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onReject} title="Reject (R)">
                Reject
              </Button>
              <Button size="sm" onClick={onApply} title="Apply (A)">
                <Check className="h-3.5 w-3.5" /> Apply
              </Button>
            </>
          )}
        </div>
      </div>
      {body}
    </div>
  );
}

export default function DiffDialog() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('side-by-side'); // 'inline' | 'side-by-side'
  const [changeSet, setChangeSet] = useState(null);
  // Paths the user has applied, and paths they've rejected (hidden from the list).
  const [applied, setApplied] = useState(() => new Set());
  const [rejected, setRejected] = useState(() => new Set());
  // The boot-time onApply callback (main.js: initDiffView(handleChatApply)),
  // carried on the open event so it survives across opens without re-render churn.
  const onApplyRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Open on showDiffView() -> rd:open-diff. Reset per-open state; keep the chosen
  // view mode sticky across opens (matches the vanilla module-level default).
  useEffect(() => {
    const onOpen = (e) => {
      const cs = e.detail?.changeSet || null;
      onApplyRef.current = e.detail?.onApply || null;
      setChangeSet(cs);
      setApplied(new Set());
      setRejected(new Set());
      setOpen(true);
    };
    const onClose = () => setOpen(false);
    window.addEventListener('rd:open-diff', onOpen);
    window.addEventListener('rd:close-diff', onClose);
    return () => {
      window.removeEventListener('rd:open-diff', onOpen);
      window.removeEventListener('rd:close-diff', onClose);
    };
  }, []);

  // Body scroll lock while open (Radix also sets this, but we mirror the vanilla
  // contract explicitly and restore on close/unmount).
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Auto-close 500ms after every change has been handled — applied or rejected —
  // so "reject one, apply the rest" dismisses the dialog once nothing is left to
  // review (and rejecting every card still closes). Centralizes the dismissal that
  // applyChange / rejectChange used to schedule ad hoc.
  useEffect(() => {
    if (!open || !changeSet || changeSet.changes.length === 0) return undefined;
    const allHandled = changeSet.changes.every((c) => applied.has(c.path) || rejected.has(c.path));
    if (!allHandled) return undefined;
    const t = setTimeout(() => setOpen(false), 500);
    return () => clearTimeout(t);
  }, [open, changeSet, applied, rejected]);

  // Apply one change to the store, mark it applied, and fire the callback. The
  // close-when-everything-is-handled effect above dismisses the dialog.
  const applyChange = useCallback(
    (path) => {
      const cs = changeSet;
      if (!cs) return;
      setApplied((prevApplied) => {
        if (prevApplied.has(path)) return prevApplied;
        const change = cs.changes.find((c) => c.path === path);
        if (!change) return prevApplied;

        applyChangeToStore(change);

        onApplyRef.current?.();

        const next = new Set(prevApplied);
        next.add(path);
        return next;
      });
    },
    [changeSet],
  );

  // Reject = hide the card from the list. The close-when-everything-is-handled
  // effect above dismisses the dialog once nothing is left to review.
  const rejectChange = useCallback(
    (path) => {
      if (!changeSet) return;
      setRejected((prevRejected) => {
        if (prevRejected.has(path)) return prevRejected;
        const next = new Set(prevRejected);
        next.add(path);
        return next;
      });
    },
    [changeSet],
  );

  // The next still-actionable change (not applied, not rejected) for A / R.
  const nextActionable = useCallback(
    () => changeSet?.changes.find((c) => !applied.has(c.path) && !rejected.has(c.path)) || null,
    [changeSet, applied, rejected],
  );

  // Apply every change the user hasn't already applied or rejected. Skipping
  // rejected paths is what makes "reject one, apply the rest" safe — a rejected
  // card is never written to the resume by Apply All.
  const applyAll = useCallback(() => {
    const cs = changeSet;
    if (!cs) return;
    for (const change of cs.changes) {
      if (!applied.has(change.path) && !rejected.has(change.path)) applyChange(change.path);
    }
  }, [changeSet, applied, rejected, applyChange]);

  // Keyboard shortcuts: A apply-next · R reject-next · Enter apply-all · Esc
  // close. Ignored while typing in an input/textarea. Esc is handled here (the
  // dialog uses no built-in close button) instead of Radix's onEscapeKeyDown so
  // the typing guard applies uniformly.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (e.key) {
        case 'Escape':
          close();
          break;
        case 'Enter':
          if (!e.shiftKey) {
            e.preventDefault();
            applyAll();
          }
          break;
        case 'a':
        case 'A':
          if (!e.ctrlKey && !e.metaKey) {
            const c = nextActionable();
            if (c) applyChange(c.path);
          }
          break;
        case 'r':
        case 'R':
          if (!e.ctrlKey && !e.metaKey) {
            const c = nextActionable();
            if (c) rejectChange(c.path);
          }
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close, applyAll, nextActionable, applyChange, rejectChange]);

  const stats = changeSet?.getSummary?.() || { added: 0, removed: 0, modified: 0, total: 0 };
  const visibleChanges = changeSet ? changeSet.changes.filter((c) => !rejected.has(c.path)) : [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[90vh] max-h-[90vh] w-[92vw] max-w-[760px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">
          Review proposed resume changes and apply or reject them.
        </DialogDescription>

        {/* Header — mockup .dlg-head.bordered: 20px 22px 16px, stat badges + mode seg. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-[22px] pb-4 pt-5">
          <DialogTitle>Review Changes</DialogTitle>

          <div className="flex items-center gap-1.5">
            <Badge className="border-transparent bg-success-bg text-success tabular-nums">+{stats.added}</Badge>
            <Badge className="border-transparent bg-destructive-bg text-destructive tabular-nums">
              -{stats.removed}
            </Badge>
            <Badge className="border-transparent bg-warning-bg text-warning tabular-nums">~{stats.modified}</Badge>
            {applied.size > 0 && (
              <Badge variant="secondary" className="tabular-nums">{applied.size} applied</Badge>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* View-mode toggle — mockup .seg.xs Segmented. */}
            <Segmented>
              <SegmentedItem size="xs" active={mode === 'inline'} onClick={() => setMode('inline')}>
                <Rows3 /> Inline
              </SegmentedItem>
              <SegmentedItem size="xs" active={mode === 'side-by-side'} onClick={() => setMode('side-by-side')}>
                <Columns2 /> Side by side
              </SegmentedItem>
            </Segmented>
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>
        </div>

        {/* Body */}
        <ScrollArea className="min-h-0 flex-1">
          {visibleChanges.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-6 py-20 text-center">
              <CheckCheck className="mb-3 h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">No changes to review</p>
              <span className="text-sm text-muted-foreground">Everything is up to date.</span>
            </div>
          ) : (
            <div className="space-y-3 p-6">
              {visibleChanges.map((change) => (
                <ChangeCard
                  key={change.path}
                  change={change}
                  mode={mode}
                  applied={applied.has(change.path)}
                  onApply={() => applyChange(change.path)}
                  onReject={() => rejectChange(change.path)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer — mockup .df-foot: muted bar, kbd hint chips + Reject/Apply All. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t bg-muted/40 px-5 py-[13px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Kbd>A</Kbd> Apply
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>R</Kbd> Reject
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> Apply All
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Esc</Kbd> Close
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={close}>
              <X className="h-4 w-4" /> Reject All
            </Button>
            <Button onClick={applyAll}>
              <CheckCheck className="h-4 w-4" /> Apply All
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
