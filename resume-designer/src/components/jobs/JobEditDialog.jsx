import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

// Job-description edit modal, ported from openEditModal in jobDescriptionPanel.js.
// A standard shadcn Dialog with controlled inputs seeded from `jd` whenever the
// dialog opens; Save trims and hands the values back to the parent (only when a
// description is present — the empty case is a silent no-op, preserved exactly).

export function JobEditDialog({ open, onOpenChange, jd, onSave }) {
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [description, setDescription] = useState('');

  // Seed the form from the selected job when the dialog opens.
  useEffect(() => {
    if (open && jd) {
      setTitle(jd.title || '');
      setCompany(jd.company || '');
      setDescription(jd.description || '');
    }
  }, [open, jd]);

  const save = () => {
    if (description.trim()) {
      onSave({ title: title.trim(), company: company.trim(), description: description.trim() });
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[90vw] max-w-[560px] flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">Edit the title, company, and description for this job</DialogDescription>

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-b p-6">
          <div className="space-y-1">
            <DialogTitle>Edit job</DialogTitle>
            <p className="text-sm text-muted-foreground">Update the title, company, and description.</p>
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
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" />
          <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" />
          <Textarea
            rows={10}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Job description"
          />
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
