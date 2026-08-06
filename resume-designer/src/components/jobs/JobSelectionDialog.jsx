import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// Job-selection modal for "Analyze Resume Fit", ported from showJobSelectionModal
// + renderJobSelectionModalContent in jobDescriptionPanel.js. A standard shadcn
// Dialog: Model + Reasoning are real shadcn Selects, each job is a checkbox
// label-card (tinted when selected). Selection / model / reasoning live in local
// state seeded each time the dialog opens; confirm hands the chosen jobs back.

const REASONING_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export function JobSelectionDialog({ open, onOpenChange, jobs, models, defaultModelId, defaultReasoning = 'medium', onConfirm }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [modelId, setModelId] = useState(defaultModelId);
  const [reasoning, setReasoning] = useState(defaultReasoning);

  // Seed selection/model/reasoning when the dialog transitions to open.
  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set(jobs.filter((jd) => jd.isActive).map((jd) => jd.id)));
    setModelId(defaultModelId);
    setReasoning(defaultReasoning);
  }, [open, jobs, defaultModelId, defaultReasoning]);

  const toggle = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(jobs.map((jd) => jd.id)));
  const clearAll = () => setSelectedIds(new Set());

  const confirm = () => {
    const selectedJobs = jobs.filter((j) => selectedIds.has(j.id));
    onConfirm(selectedJobs, modelId, reasoning);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[90vw] max-w-[560px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">Select job descriptions to analyze your resume against</DialogDescription>

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-b p-6">
          <div className="space-y-1">
            <DialogTitle>Analyze resume fit</DialogTitle>
            <p className="text-sm text-muted-foreground">Pick the jobs and model to compare against.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="jd-select-model">Model</Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger id="jd-select-model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent className="glass-card">
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jd-select-reasoning">Reasoning</Label>
              <Select value={reasoning} onValueChange={setReasoning}>
                <SelectTrigger id="jd-select-reasoning">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="glass-card">
                  {REASONING_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <Label>Jobs</Label>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={selectAll}>Select all</Button>
              <Button variant="link" size="sm" className="h-auto p-0 text-muted-foreground" onClick={clearAll}>Clear</Button>
            </div>
          </div>

          <div className="space-y-2">
            {jobs.map((jd) => {
              const selected = selectedIds.has(jd.id);
              const preview =
                jd.description.length > 100 ? jd.description.substring(0, 100) + '...' : jd.description;
              return (
                <Label
                  key={jd.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors',
                    selected && 'border-primary/50 bg-primary/[0.025]',
                  )}
                >
                  <Checkbox className="mt-0.5" checked={selected} onCheckedChange={() => toggle(jd.id)} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{jd.title}</span>
                      <span className="truncate text-xs text-muted-foreground">{jd.company}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{preview}</p>
                  </div>
                </Label>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={selectedIds.size === 0} onClick={confirm}>
            <Search className="h-4 w-4" />
            Analyze{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
