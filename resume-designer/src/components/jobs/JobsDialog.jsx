import { useState, useEffect, useRef, useReducer, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Clipboard, Plus, Search, Wand2, ChevronsDownUp, ChevronsUpDown, Upload, Download,
  FileText, Loader2, X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { TooltipProvider } from '@/components/ui/tooltip';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';
import { LiveReasoning } from '../chat/LiveReasoning.jsx';
import { RunMeta } from '../chat/RunMeta.jsx';

import {
  initJobDescriptions, getAllJobDescriptions, getActiveJobDescriptions,
  addJobDescription, updateJobDescription, deleteJobDescription, toggleJobDescriptionActive,
  parseJobDescriptionText, exportJobDescriptions, importJobDescriptions,
  subscribeJobDescriptions,
} from '../../jobDescriptions.js';
import {
  getConfiguredProviders, getAllModels, isConfigured, validateModelId, getDefaultModelId,
} from '../../aiService.js';
import { getSettings, getVariantAnalysis } from '../../persistence.js';
import { showDiffView } from '../../diffView.js';
import { getCurrentId } from '../../variantManager.js';
// The two AI compositions live in the bridge module, not in these handlers, so
// the native Jobs sheet runs the same ones — see the note there. This component
// owns only what is React's: its own state and its own toasts.
import { runJobAnalysis, runTailor } from '../../jobsBridge.js';
import { applyRecommendationToStore } from '../../jobRecommendations.js';
import { JobCard } from './JobCard.jsx';
import { AnalysisResults } from './AnalysisResults.jsx';
import { JobSelectionDialog } from './JobSelectionDialog.jsx';
import { TailorDialog } from './TailorDialog.jsx';
import { JobEditDialog } from './JobEditDialog.jsx';

const RECENT_JD_LIMIT = 5;

function getDisplayed(jobs, recentOnly) {
  if (!recentOnly || jobs.length <= RECENT_JD_LIMIT) return jobs;
  return [...jobs].sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded)).slice(0, RECENT_JD_LIMIT);
}

function getAvailableModels() {
  if (!isConfigured()) return [];
  const grouped = getAllModels();
  const available = [];
  for (const models of Object.values(grouped)) {
    for (const m of models) available.push({ id: m.id, label: m.label, provider: m.group });
  }
  return available;
}

// Full-screen analysis loading overlay, portaled to document.body so it sits
// above the Radix dialog (z-[2200]). The 3 cumulative steps light up in turn on
// a 2s cycle while a request is in flight. Dark blur + accent spinner; restyled
// from the old .jd-analysis-loading-overlay to genuine token classes.
// Full-screen overlay shown while an analyze/tailor run is in flight, portaled
// above the Radix dialog (z-[2200]). The model's REAL reasoning streams into the
// LiveReasoning panel as it works, replacing the old synthetic 3-step animation.
function AnalysisLoadingOverlay({ reasoning, title, subtitle }) {
  return createPortal(
    <div className="fixed inset-0 z-[2200] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <Loader2 className="size-12 animate-spin text-primary" />
        <div className="space-y-1">
          <p className="text-base font-semibold">{title}</p>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="w-full text-left">
          <LiveReasoning reasoning={reasoning} streaming defaultOpen />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Section heading + count, matching the gold-standard SectionHeader idiom.
// Mockup .jb-sect-head h3 = 14px/600.
function SectionHeader({ title, actions }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {actions}
    </div>
  );
}

/**
 * Target Job Descriptions panel — the React port of jobDescriptionPanel.js.
 * A genuine shadcn Dialog (always mounted so the rd:open-jobs /
 * rd:jobs-variant-change listeners persist) hosting three Separator-divided
 * sections: the add form, the JD list, and AI analysis. Job data lives in
 * jobDescriptions.js (re-read after each CRUD via a bump); analysis is persisted
 * per-variant. The selection + edit sub-modals and the results view are separate
 * components; applying a recommendation routes through
 * jobRecommendations.applyRecommendationToStore.
 */
export default function JobsDialog() {
  const [open, setOpen] = useState(false);
  const [, bump] = useReducer((x) => x + 1, 0);
  const [analysisResults, setAnalysisResults] = useState(null);
  const [appliedIndexes, setAppliedIndexes] = useState(() => new Set());
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [genReasoning, setGenReasoning] = useState('');
  const [lastRun, setLastRun] = useState(null);
  const [genOp, setGenOp] = useState('analyze');
  const [tailorSelectionOpen, setTailorSelectionOpen] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [showRecentOnly, setShowRecentOnly] = useState(true);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [editingJd, setEditingJd] = useState(null);
  const [addError, setAddError] = useState(false);
  const collapseInit = useRef(false);

  const titleRef = useRef(null);
  const companyRef = useRef(null);
  const descRef = useRef(null);

  const jobs = getAllJobDescriptions();
  const activeJDs = getActiveJobDescriptions();
  const displayed = getDisplayed(jobs, showRecentOnly);
  const configured = getConfiguredProviders().length > 0;

  const reloadAnalysis = useCallback(() => {
    const id = getCurrentId();
    setAnalysisResults(id ? getVariantAnalysis(id) : null);
    setAppliedIndexes(new Set());
    setLastRun(null); // run metadata isn't persisted; only show it for fresh runs
  }, []);

  useEffect(() => { initJobDescriptions(); }, []);

  // The `bump` below covers every mutation this dialog makes; sync is the one
  // writer it does not make. A job list landing from another device replaces the
  // whole module array, and without this the open list keeps rendering the rows
  // that array no longer holds.
  useEffect(() => subscribeJobDescriptions(bump), []);

  useEffect(() => {
    const onOpen = () => { reloadAnalysis(); setOpen(true); };
    const onVariant = () => reloadAnalysis();
    window.addEventListener('rd:open-jobs', onOpen);
    window.addEventListener('rd:jobs-variant-change', onVariant);
    return () => {
      window.removeEventListener('rd:open-jobs', onOpen);
      window.removeEventListener('rd:jobs-variant-change', onVariant);
    };
  }, [reloadAnalysis]);

  // Collapse all cards by default on first render that has jobs.
  useEffect(() => {
    if (!collapseInit.current && jobs.length > 0) {
      setCollapsedIds(new Set(jobs.map((j) => j.id)));
      collapseInit.current = true;
    }
  }, [jobs]);

  const handleAdd = () => {
    const description = descRef.current?.value.trim();
    if (!description) { setAddError(true); return; }
    addJobDescription({
      title: titleRef.current?.value.trim() || 'Untitled Position',
      company: companyRef.current?.value.trim() || 'Unknown Company',
      description,
    });
    if (titleRef.current) titleRef.current.value = '';
    if (companyRef.current) companyRef.current.value = '';
    if (descRef.current) descRef.current.value = '';
    setAddError(false);
    bump();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const parsed = parseJobDescriptionText(text);
        if (titleRef.current) titleRef.current.value = parsed.title;
        if (companyRef.current) companyRef.current.value = parsed.company;
        if (descRef.current) descRef.current.value = parsed.description;
        setAddError(false);
      }
    } catch (e) {
      console.error('Failed to read clipboard:', e);
      toast.error('Could not read from clipboard. Please paste manually.');
    }
  };

  const toggleCollapse = (id) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const collapseAll = () => setCollapsedIds(new Set(jobs.map((j) => j.id)));
  const expandAll = () => setCollapsedIds(new Set());

  const toggleActive = (id) => { toggleJobDescriptionActive(id); bump(); };
  const removeJob = async (id) => {
    const ok = await confirmDestructive({
      title: 'Delete this job description?',
      description: 'This permanently removes it from your saved jobs.',
      actionLabel: 'Delete',
    });
    if (!ok) return;
    deleteJobDescription(id);
    bump();
  };
  const saveEdit = (fields) => { if (editingJd) { updateJobDescription(editingJd.id, fields); setEditingJd(null); bump(); } };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const count = importJobDescriptions(await file.text());
        toast.success(`Imported ${count} job description(s)`);
        bump();
      } catch (err) {
        toast.error(`Failed to import: ${err.message}`);
      }
    };
    input.click();
  };

  const handleExport = () => {
    const blob = new Blob([exportJobDescriptions()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'job-descriptions.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const runAnalysis = async (selectedJobs, modelId, reasoningEffort) => {
    setGenOp('analyze');
    setGenReasoning('');
    setLastRun(null);
    setIsAnalyzing(true);
    setAppliedIndexes(new Set());
    try {
      const results = await runJobAnalysis({
        jobs: selectedJobs,
        modelId,
        reasoning: reasoningEffort,
        hooks: { onReasoning: (_d, full) => setGenReasoning(full), onRun: (r) => setLastRun(r) },
      });
      setAnalysisResults(results);
    } catch (error) {
      toast.error(`Analysis failed: ${error.message}`);
      setAnalysisResults(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleTailor = async (tailorModelId, tailorReasoningEffort) => {
    setGenOp('tailor');
    setGenReasoning('');
    setLastRun(null);
    setIsAnalyzing(true);
    try {
      // runTailor pins the target résumé, guards against it being deleted or
      // switched mid-run, and records the drafts; the outcome carries the
      // sentence for whichever way it went, so the copy is written once and
      // the native sheet shows the same words.
      const outcome = await runTailor({
        modelId: tailorModelId,
        reasoning: tailorReasoningEffort,
        hooks: { onReasoning: (_d, full) => setGenReasoning(full), onRun: (r) => setLastRun(r) },
      });
      if (outcome.status === 'changes') {
        if (outcome.message) toast.info(outcome.message);
        // Closed before the diff opens, so the two dialogs never stack.
        setOpen(false);
        showDiffView(outcome.changeSet);
      } else if (outcome.status === 'no-changes') {
        toast.info(outcome.message);
      } else {
        toast.error(outcome.message);
      }
    } catch (error) {
      toast.error(`Failed to generate changes: ${error.message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const applyRec = (index) => {
    const rec = analysisResults?.recommendations?.[index];
    if (!rec || appliedIndexes.has(index)) return;
    const ok = applyRecommendationToStore(rec.section?.toLowerCase().trim(), rec.current, rec.suggested);
    if (ok) {
      setAppliedIndexes((prev) => new Set(prev).add(index));
    } else {
      toast.error(`Could not automatically apply this recommendation to "${rec.section}". Please make this change manually in the resume editor.`);
    }
  };

  // Seed the analyze dialog from the per-area remembered model/reasoning (falling
  // back to the global default the first time), so the choice sticks per #2.
  const defaultModelId = validateModelId(getSettings().analysisModel || getSettings().defaultModel) || getDefaultModelId();
  const defaultAnalysisReasoning = getSettings().analysisReasoning || 'medium';
  const defaultTailorModelId = validateModelId(getSettings().tailorModel || getSettings().defaultModel) || getDefaultModelId();
  const defaultTailorReasoning = getSettings().tailorReasoning || 'medium';

  const countLabel = jobs.length > 0
    ? ` (${displayed.length}${showRecentOnly && jobs.length > RECENT_JD_LIMIT ? ` of ${jobs.length}` : ''})`
    : '';

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[85vh] w-[90vw] max-w-[700px] flex-col gap-0 overflow-hidden p-0 glass-card"
        >
          <DialogDescription className="sr-only">Manage job descriptions and analyze resume fit</DialogDescription>

          {/* Header — mockup .dlg-head.bordered: 20px 22px 16px. */}
          <div className="flex shrink-0 items-start justify-between gap-3 border-b px-[22px] pb-4 pt-5">
            <div className="space-y-1">
              <DialogTitle>Jobs</DialogTitle>
              <p className="text-[13px] text-muted-foreground">Save target jobs and analyze how well your resume fits.</p>
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

          <TooltipProvider>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-[22px] py-[18px]">
              {/* Add form */}
              <section>
                <SectionHeader title="Add a job" />
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Input ref={titleRef} placeholder="Job title (e.g., Senior Designer)" />
                    <Input ref={companyRef} placeholder="Company name" />
                  </div>
                  <Textarea
                    ref={descRef}
                    rows={6}
                    placeholder="Paste the full job description here..."
                    aria-invalid={addError}
                    className={cn(addError && 'border-destructive focus-visible:ring-destructive')}
                    onChange={() => { if (addError) setAddError(false); }}
                  />
                  {addError && <p className="text-sm text-destructive">Please enter a job description.</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={handlePaste}>
                      <Clipboard className="h-4 w-4" />
                      Paste from clipboard
                    </Button>
                    <Button onClick={handleAdd}>
                      <Plus className="h-4 w-4" />
                      Add job
                    </Button>
                  </div>
                </div>
              </section>

              <Separator />

              {/* JD list */}
              <section>
                <SectionHeader
                  title={`Your jobs${countLabel}`}
                  actions={
                    <div className="flex items-center gap-2">
                      {/* Recent / All filter — mockup .seg.xs. */}
                      {jobs.length > 0 && (
                        <Segmented>
                          <SegmentedItem size="xs" active={showRecentOnly} onClick={() => setShowRecentOnly(true)}>
                            Recent
                          </SegmentedItem>
                          <SegmentedItem size="xs" active={!showRecentOnly} onClick={() => setShowRecentOnly(false)}>
                            All
                          </SegmentedItem>
                        </Segmented>
                      )}
                      <div className="flex items-center gap-1">
                        {jobs.length > 1 && (
                          <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Collapse all" aria-label="Collapse all" onClick={collapseAll}>
                              <ChevronsDownUp className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Expand all" aria-label="Expand all" onClick={expandAll}>
                              <ChevronsUpDown className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Import from JSON" aria-label="Import from JSON" onClick={handleImport}>
                          <Upload className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Export to JSON" aria-label="Export to JSON" onClick={handleExport}>
                          <Download className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  }
                />

                {jobs.length === 0 ? (
                  <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-6 py-12 text-center">
                    <FileText className="mb-3 h-10 w-10 text-muted-foreground/40" />
                    <p className="text-sm font-medium">No job descriptions added yet</p>
                    <span className="text-sm text-muted-foreground">Add target jobs to analyze your resume fit</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {displayed.map((jd) => (
                      <JobCard
                        key={jd.id}
                        jd={jd}
                        collapsed={collapsedIds.has(jd.id)}
                        onToggleCollapse={() => toggleCollapse(jd.id)}
                        onToggleActive={() => toggleActive(jd.id)}
                        onEdit={() => setEditingJd(jd)}
                        onDelete={() => removeJob(jd.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              {jobs.length > 0 && (
                <>
                  <Separator />
                  <section>
                    <SectionHeader title="Resume analysis" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button disabled={!configured || isAnalyzing} onClick={() => setSelectionOpen(true)}>
                        <Search className="h-4 w-4" />
                        {isAnalyzing ? 'Working…' : 'Analyze resume fit'}
                      </Button>
                      <Button variant="outline" disabled={!configured || isAnalyzing || activeJDs.length === 0} onClick={() => setTailorSelectionOpen(true)}>
                        <Wand2 className="h-4 w-4" />
                        Tailor resume
                      </Button>
                    </div>
                    {!configured && (
                      <p className="mt-2 text-sm text-muted-foreground">Configure an API key in settings to use AI analysis.</p>
                    )}
                    {analysisResults && (
                      <div className="mt-5 space-y-3">
                        {lastRun && <RunMeta run={lastRun} />}
                        <AnalysisResults results={analysisResults} appliedIndexes={appliedIndexes} onApply={applyRec} />
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          </TooltipProvider>
        </DialogContent>
      </Dialog>

      <JobSelectionDialog
        open={selectionOpen}
        onOpenChange={setSelectionOpen}
        jobs={jobs}
        models={getAvailableModels()}
        defaultModelId={defaultModelId}
        defaultReasoning={defaultAnalysisReasoning}
        onConfirm={runAnalysis}
      />
      <TailorDialog
        open={tailorSelectionOpen}
        onOpenChange={setTailorSelectionOpen}
        models={getAvailableModels()}
        defaultModelId={defaultTailorModelId}
        defaultReasoning={defaultTailorReasoning}
        activeCount={activeJDs.length}
        onConfirm={handleTailor}
      />
      <JobEditDialog
        open={!!editingJd}
        onOpenChange={(next) => { if (!next) setEditingJd(null); }}
        jd={editingJd}
        onSave={saveEdit}
      />
      {isAnalyzing && (
        <AnalysisLoadingOverlay
          reasoning={genReasoning}
          title={genOp === 'tailor' ? 'Tailoring your resume' : 'Analyzing resume fit'}
          subtitle={genOp === 'tailor'
            ? 'Tailoring your resume for the target jobs…'
            : 'Comparing your resume against job requirements…'}
        />
      )}
    </>
  );
}
