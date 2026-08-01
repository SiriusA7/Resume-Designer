import { useEffect, useState } from 'react';
import { Wand2, X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

// "Tailor Resume" options modal — mirrors JobSelectionDialog's Model + Reasoning
// header, minus the job list (tailoring always uses the active job descriptions).
// Model + reasoning seed from the per-area remembered values and are handed back
// on confirm; the dialog has no job-selection step.

const REASONING_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export function TailorDialog({
  open, onOpenChange, models, defaultModelId, defaultReasoning = 'medium', activeCount = 0, onConfirm,
}) {
  const [modelId, setModelId] = useState(defaultModelId);
  const [reasoning, setReasoning] = useState(defaultReasoning);

  // Re-seed from the remembered values each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setModelId(defaultModelId);
    setReasoning(defaultReasoning);
  }, [open, defaultModelId, defaultReasoning]);

  const confirm = () => {
    onConfirm(modelId, reasoning);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex w-[90vw] max-w-[460px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">Choose the model and reasoning to tailor your resume</DialogDescription>

        <div className="flex items-start justify-between border-b p-6">
          <div className="space-y-1">
            <DialogTitle>Tailor resume</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Tailor your resume for {activeCount} active job{activeCount === 1 ? '' : 's'}.
            </p>
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

        <div className="grid grid-cols-2 gap-3 p-6">
          <div className="space-y-1.5">
            <Label htmlFor="tailor-select-model">Model</Label>
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger id="tailor-select-model">
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
            <Label htmlFor="tailor-select-reasoning">Reasoning</Label>
            <Select value={reasoning} onValueChange={setReasoning}>
              <SelectTrigger id="tailor-select-reasoning">
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

        <div className="flex justify-end gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={activeCount === 0} onClick={confirm}>
            <Wand2 className="h-4 w-4" />
            Tailor resume
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
