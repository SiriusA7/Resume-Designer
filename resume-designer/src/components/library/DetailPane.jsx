import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { Separator } from '../ui/separator.jsx';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../ui/alert-dialog.jsx';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select.jsx';
import { cn } from '@/lib/utils';
import {
  addApplication, deleteApplication, setApplicationStatus, updateApplication,
  APPLICATION_STATUSES, STATUS_LABELS,
} from '../../applications.js';
import { getAllJobDescriptions, getJobDescription } from '../../jobDescriptions.js';
import {
  loadVariant, deleteCurrentVariant, createVariant, getCurrentId, refreshVariants,
} from '../../variantManager.js';
import {
  deleteVariant, renameVariant, getVariants, generateUniqueVariantName,
} from '../../persistence.js';
import { loadThreads, countThreadsForVariant } from '../../chatThreads.js';
import { handleVariantThreadsForDelete } from '../chat/deleteVariantThreadsFlow.js';
import { STATUS_BADGE_CLASSES } from './statusStyles.js';
import PreviewPane from './PreviewPane.jsx';

function shortDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

/** One application card: status select, dates, notes, inline JD expand. */
function ApplicationCard({ app, onRequestDelete }) {
  const [notes, setNotes] = useState(app.notes || '');
  const [showJd, setShowJd] = useState(false);
  const jd = app.jobId ? getJobDescription(app.jobId) : null;

  // Re-seed local notes when switching between applications.
  useEffect(() => { setNotes(app.notes || ''); }, [app.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium">
            {app.jobSnapshot?.title || 'Untitled role'}
            {app.jobSnapshot?.company ? ` @ ${app.jobSnapshot.company}` : ''}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {app.appliedAt ? `Applied ${shortDate(app.appliedAt)}` : `Prepared ${shortDate(app.createdAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Select value={app.status} onValueChange={(s) => setApplicationStatus(app.id, s)}>
            <SelectTrigger className={cn('h-7 w-[130px] text-xs', STATUS_BADGE_CLASSES[app.status])}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPLICATION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label="Delete application"
            onClick={() => onRequestDelete(app)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <Textarea
        value={notes}
        // Persist on every edit so the note ALWAYS lives in appStorage — the
        // only way to survive a native window close, where React never unmounts
        // and no reliable pre-destroy visibilitychange fires, so the app's own
        // close-flush (appStorage.flush) is what saves it. updateApplication is
        // a cheap in-memory update + debounced disk write.
        onChange={(e) => { const v = e.target.value; setNotes(v); updateApplication(app.id, { notes: v }); }}
        placeholder="Notes (e.g. recruiter said reapply in 6 months)"
        className="min-h-[52px] text-[12.5px]"
      />

      {jd && (
        <div>
          <button
            type="button"
            onClick={() => setShowJd((v) => !v)}
            className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            {showJd ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            Job description
            {jd.url && (
              <a
                href={jd.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="ml-1 inline-flex items-center gap-0.5 underline"
              >
                open <ExternalLink className="size-3" />
              </a>
            )}
          </button>
          {showJd && (
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11.5px] text-muted-foreground">
              {jd.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Manual fallback: link this resume to a job it was sent to. */
function AddApplicationForm({ variant }) {
  const [adding, setAdding] = useState(false);
  const [jobId, setJobId] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [appliedOn, setAppliedOn] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  });
  const jds = getAllJobDescriptions();

  const submit = () => {
    const jd = jds.find((j) => j.id === jobId);
    if (!jd && !title.trim() && !company.trim()) return;
    const todayLocal = new Date();
    todayLocal.setMinutes(todayLocal.getMinutes() - todayLocal.getTimezoneOffset());
    const backdated = appliedOn && appliedOn !== todayLocal.toISOString().slice(0, 10)
      ? new Date(`${appliedOn}T12:00:00`).toISOString()
      : undefined;
    addApplication({
      variantId: variant.id,
      variantName: variant.name,
      jobId: jd ? jd.id : null,
      jobSnapshot: jd ? { title: jd.title, company: jd.company } : { title: title.trim(), company: company.trim() },
      status: 'applied', // manual adds exist because you actually applied
      appliedAt: backdated,
    });
    setAdding(false);
    setJobId(''); setTitle(''); setCompany('');
    setAppliedOn(todayLocal.toISOString().slice(0, 10));
  };

  if (!adding) {
    return (
      <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
        <Plus className="size-3.5" /> Add application
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      {jds.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs">Saved job</Label>
          <Select value={jobId} onValueChange={setJobId}>
            <SelectTrigger className="w-full text-xs">
              <SelectValue placeholder="Pick a saved job description…" />
            </SelectTrigger>
            <SelectContent>
              {jds.map((jd) => (
                <SelectItem key={jd.id} value={jd.id}>{jd.title} @ {jd.company}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {!jobId && (
        <div className="flex gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" className="h-8 text-xs" />
          <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" className="h-8 text-xs" />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="app-applied-on" className="text-xs">Applied on</Label>
        <Input
          id="app-applied-on"
          type="date"
          value={appliedOn}
          onChange={(e) => setAppliedOn(e.target.value)}
          className="h-8 w-[150px] text-xs"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit}>Add</Button>
        <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
      </div>
    </div>
  );
}

export default function DetailPane({ variant, applications, onAfterDelete, onClose }) {
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(variant.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingDeleteApp, setPendingDeleteApp] = useState(null);

  useEffect(() => { setRenaming(false); setNewName(variant.name); }, [variant.id, variant.name]);

  const isCurrent = getCurrentId() === variant.id;
  const isLastVariant = Object.keys(getVariants()).length <= 1;

  const openVariant = () => { loadVariant(variant.id); onClose(); };

  const duplicate = () => {
    const name = generateUniqueVariantName(`${variant.name} (Copy)`, getVariants());
    createVariant(name, JSON.parse(JSON.stringify(variant.data))); // loads the copy + notifies
  };

  const commitRename = () => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== variant.name) {
      renameVariant(variant.id, trimmed);
      refreshVariants();
    }
    setRenaming(false);
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    // Route through the shared thread-handling contract (keep→General vs delete,
    // persist reassignment, abort orphaned streams) before removing the variant.
    const { cancelled } = await handleVariantThreadsForDelete({
      variantId: variant.id,
      variantName: variant.name,
    });
    if (cancelled) return;
    if (isCurrent) {
      if (deleteCurrentVariant().ok) onAfterDelete();
    } else {
      deleteVariant(variant.id);
      refreshVariants();
      onAfterDelete();
    }
  };

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          {renaming ? (
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                // Reset the draft before unmounting so a blur fired during the
                // unmount no-ops on commitRename's `trimmed !== variant.name` guard.
                // (The Library dialog's onEscapeKeyDown keeps Radix from also
                // closing the dialog — it matches on data-rename-input.)
                if (e.key === 'Escape') { setNewName(variant.name); setRenaming(false); }
              }}
              autoFocus
              data-rename-input=""
              className="h-8 max-w-[320px] text-[15px] font-semibold"
            />
          ) : (
            <h3 className="truncate text-[15px] font-semibold">{variant.name}</h3>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            Created {shortDate(variant.createdAt)} · Updated {shortDate(variant.updatedAt)}
            {(() => {
              const n = countThreadsForVariant(loadThreads().threads, variant.id);
              return n > 0 ? ` · ${n} chat thread${n === 1 ? '' : 's'}` : '';
            })()}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" onClick={openVariant} disabled={isCurrent}>
            {isCurrent ? 'Current' : 'Open'}
          </Button>
          <Button size="sm" variant="outline" onClick={duplicate}>Duplicate</Button>
          <Button size="sm" variant="outline" onClick={() => setRenaming(true)}>Rename</Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={isLastVariant}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <PreviewPane variant={variant} />

      <Separator />

      <div className="space-y-2">
        <h4 className="text-[13px] font-medium">Applications</h4>
        {applications.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            Not linked to any job yet. Tailoring against a job creates a link automatically.
          </p>
        )}
        {applications.map((app) => (
          <ApplicationCard key={app.id} app={app} onRequestDelete={setPendingDeleteApp} />
        ))}
        <AddApplicationForm variant={variant} />
      </div>

      <AlertDialog open={!!pendingDeleteApp} onOpenChange={(v) => { if (!v) setPendingDeleteApp(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this application?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the link to {pendingDeleteApp?.jobSnapshot?.company || 'this job'} and its status history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { deleteApplication(pendingDeleteApp.id); setPendingDeleteApp(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{variant.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The resume is deleted permanently. Its application history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
