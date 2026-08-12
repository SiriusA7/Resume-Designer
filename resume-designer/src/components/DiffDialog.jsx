import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Minus, PencilLine, Check, X, Rows3, Columns2, CheckCheck } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { DIFF_TYPES, getPathLabel } from '../diffEngine.js';
import { applyChangeToStore, applyChangesToStore, selectUndecided } from '../changeApply.js';
import { publishDiffReview } from '../iosShell.js';
import * as changeSession from '../changeSession.js';
import { isSupersededSession } from '../changeSessionGuard.js';
import {
  applyAllInlineChanges, applyInlineChange, hideInlineChanges, rejectInlineChange,
} from '../inlineChanges.js';

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
//   • pending/applied/rejected state lives in changeSession whenever the open
//     change set is the one the session is reviewing (the chat / inline-preview
//     flow) — decisions here delegate to inlineChanges' shared actions, so the
//     inline highlights and the chat message's buttons stand down in lockstep.
//     If a follow-up proposal replaces the session's change set while the
//     dialog is open, the dialog closes rather than act on a set it never
//     displayed (isSupersededSession). Jobs "Tailor" and History "Compare"
//     open change sets that never entered the session; those keep per-open
//     local state exactly as before;
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
  // Standalone decisions, used ONLY when the dialog is opened for a change set
  // the shared session does not own (Jobs "Tailor Resume", History "Compare").
  // The chat / inline flow's decisions live in changeSession instead — writing
  // them into the session there is what setStatus would silently no-op on here.
  const [localApplied, setLocalApplied] = useState(() => new Set());
  const [localRejected, setLocalRejected] = useState(() => new Set());
  // The boot-time onApply callback (main.js: initDiffView(handleChatApply)),
  // carried on the open event so it survives across opens without re-render churn.
  const onApplyRef = useRef(null);

  // The session is the source of truth; this counter exists only to force a
  // re-render when another surface (inline preview, chat message) decides a path.
  const [, setSessionRev] = useState(0);
  // Whether the shared session owns this dialog's change set — latched at open
  // (true for the chat / inline-preview entry points, false for Jobs and
  // History) rather than re-derived, because deciding the last path ends the
  // session out from under the still-open dialog. A session *replaced* by a
  // different set is detected separately — see superseded() below.
  const ownedRef = useRef(false);
  const csRef = useRef(null);
  // Statuses last seen while the session owned our change set. While the
  // session is alive this mirrors it exactly (reseeded at open, resynced on
  // every notify below); once endSession fires it keeps the final frame — so
  // "everything decided" renders consistently through the 500ms auto-close
  // grace instead of every card flashing back to pending.
  const statusesRef = useRef(new Map());

  // Liveness guard: a follow-up proposal can replace the session's change set
  // behind this open dialog — nothing ends session A when the user sends
  // another request; the stream-completion path just startSession(B)s over it.
  // The inline delegates below resolve paths against the LIVE session, so
  // acting then would apply a set the dialog never displayed. The subscribe
  // callback closes the dialog the moment this trips; the decision handlers
  // also re-check at action time because setOpen(false) is async and Radix
  // keeps the content clickable through its exit animation. A null live
  // session is NOT supersession — after endSession the delegates are safe
  // no-ops and the dialog keeps its final frame through the auto-close grace.
  const superseded = useCallback(
    () => isSupersededSession(csRef.current, changeSession.getChangeSet(), ownedRef.current),
    [],
  );

  useEffect(() => changeSession.subscribe(() => {
    if (superseded()) {
      setOpen(false);
      return;
    }
    if (csRef.current && changeSession.getChangeSet() === csRef.current) {
      statusesRef.current = changeSession.statusMap();
    }
    setSessionRev((n) => n + 1);
  }), [superseded]);

  // Derived with plain `const`, not useMemo: the statuses live outside React
  // where a memo's dependency list cannot see them, and the Sets are tiny —
  // rebuilding per render is cheaper than justifying a lint suppression.
  const pathsWithStatus = (status) =>
    new Set((changeSet?.changes || [])
      .filter((c) => (statusesRef.current.get(c.path) || 'pending') === status)
      .map((c) => c.path));

  // Paths the user has applied, and paths they've rejected (hidden from the list).
  const applied = ownedRef.current ? pathsWithStatus('applied') : localApplied;
  const rejected = ownedRef.current ? pathsWithStatus('rejected') : localRejected;

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Open on showDiffView() -> rd:open-diff. Reset per-open state; keep the chosen
  // view mode sticky across opens (matches the vanilla module-level default).
  // A change set the session is already reviewing seeds from the session, so
  // decisions made from the resume's inline controls show as decided here.
  useEffect(() => {
    const onOpen = (e) => {
      const cs = e.detail?.changeSet || null;
      onApplyRef.current = e.detail?.onApply || null;
      csRef.current = cs;
      ownedRef.current = !!cs && changeSession.getChangeSet() === cs;
      statusesRef.current = ownedRef.current ? changeSession.statusMap() : new Map();
      setChangeSet(cs);
      setLocalApplied(new Set());
      setLocalRejected(new Set());
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

  // Apply one change, mark it applied, and (standalone) fire the callback. The
  // close-when-everything-is-handled effect above dismisses the dialog. Session
  // mode delegates to the shared inline action: it writes the store through the
  // same applyChangeToStore, records 'applied' in the session (converging the
  // inline preview and the chat buttons), re-renders the resume's marks, and
  // dismisses the whole preview once nothing is pending — which also covers
  // everything the standalone onApply callback (a re-render request) does.
  const applyChange = useCallback(
    (path) => {
      if (!changeSet || applied.has(path) || rejected.has(path)) return;
      const change = changeSet.changes.find((c) => c.path === path);
      if (!change) return;
      if (ownedRef.current) {
        if (!superseded()) applyInlineChange(path);
        return;
      }
      applyChangeToStore(change);
      onApplyRef.current?.();
      setLocalApplied((prev) => new Set(prev).add(path));
    },
    [changeSet, applied, rejected, superseded],
  );

  // Reject = hide the card from the list. The close-when-everything-is-handled
  // effect above dismisses the dialog once nothing is left to review. Session
  // mode records the decision in the session, which also re-renders the resume
  // so the proposed value stops being previewed for that path.
  const rejectChange = useCallback(
    (path) => {
      if (!changeSet || applied.has(path) || rejected.has(path)) return;
      if (ownedRef.current) {
        if (!superseded()) rejectInlineChange(path);
        return;
      }
      setLocalRejected((prev) => new Set(prev).add(path));
    },
    [changeSet, applied, rejected, superseded],
  );

  // The next still-actionable change (not applied, not rejected) for A / R.
  const nextActionable = useCallback(
    () => changeSet?.changes.find((c) => !applied.has(c.path) && !rejected.has(c.path)) || null,
    [changeSet, applied, rejected],
  );

  // Apply every change the user hasn't already applied or rejected. Skipping
  // rejected paths is what makes "reject one, apply the rest" safe — a rejected
  // card is never written to the resume by Apply All (both branches skip them:
  // applyAllInlineChanges only decides paths still pending in the session).
  const applyAll = useCallback(() => {
    const cs = changeSet;
    if (!cs) return;
    if (ownedRef.current) {
      if (!superseded()) applyAllInlineChanges();
      return;
    }
    // Standalone (History Compare, Jobs Tailor): batch through the ordered
    // helper rather than looping applyChange per path. Leaf paths are indexed
    // against the PROPOSED array, so applying in the diff engine's emitted
    // order corrupts arrays — `[A,B] -> [A,X,B']` writes experience[2] before
    // the insert creates it. Session mode routes around this via
    // applyAllInlineChanges; this branch has to do the same.
    const pending = selectUndecided(cs.changes, applied, rejected);
    if (pending.length === 0) return;
    applyChangesToStore(pending);
    onApplyRef.current?.();
    setLocalApplied((prev) => {
      const next = new Set(prev);
      for (const c of pending) next.add(c.path);
      return next;
    });
  }, [changeSet, applied, rejected, superseded]);

  // "Reject All" — in session mode this is the bulk dismiss the inline preview
  // otherwise lacks: end the session (the chat button and the resume highlights
  // stand down together) and restore the resume view to the stored data.
  // Changes already applied stay applied. Standalone opens just close, as before.
  // A superseded dialog only closes — ending the live session here would
  // dismiss a preview it never displayed.
  const rejectAll = useCallback(() => {
    if (ownedRef.current && !superseded()) hideInlineChanges();
    close();
  }, [close, superseded]);

  // --- native shell ---------------------------------------------------------
  //
  // On iOS this dialog is drawn by SwiftUI and its own card is hidden
  // (native-shell.css). It still RUNS, and that is deliberate: every entry
  // point — chat's Review changes, jobs tailoring, history compare, the inline
  // Full review banner — arrives here, and so does the one correct apply
  // sequence. The native buttons call the handlers below rather than
  // reimplementing them, because a second apply route is how someone accepts
  // an edit that was never applied.
  useEffect(() => {
    publishDiffReview(
      open && changeSet
        ? {
          open: true,
          title: 'Review changes',
          // `getPathLabel` is what the card headings use; resolving it here
          // keeps Swift from needing the résumé's path grammar.
          changes: changeSet.changes.map((c) => ({ ...c, label: getPathLabel(c.path) })),
          applied: [...applied],
          rejected: [...rejected],
        }
        : null,
      { applyChange, rejectChange, applyAll, rejectAll, close },
    );
  });

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
        // The hook native-shell.css hides this card by on iOS, where SwiftUI
        // draws the review instead. An id rather than a class so it cannot be
        // confused with the other web dialogs, which are still the real UI
        // there.
        id="diff-dialog-content"
        showCloseButton={false}
        className="flex h-[90vh] max-h-[90vh] w-[92vw] max-w-[760px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">
          Review proposed resume changes and apply or reject them.
        </DialogDescription>

        {/* Header — mockup .dlg-head.bordered: 20px 22px 16px, stat badges + mode seg. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-[22px] pb-4 pt-5">
          <DialogTitle>Review changes</DialogTitle>

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
              <Kbd>↵</Kbd> Apply all
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Esc</Kbd> Close
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={rejectAll}>
              <X className="h-4 w-4" /> Reject all
            </Button>
            <Button onClick={applyAll}>
              <CheckCheck className="h-4 w-4" /> Apply all
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
