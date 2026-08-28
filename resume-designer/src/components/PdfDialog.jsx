import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { renderPdfPreview } from '@/pdfPreview';

// PDF export dialog. pdf.js dispatches `rd:open-pdf-dialog` with
// { defaultFilename, previewBase64?, onConfirm, onCancel }:
//  - Desktop (Tauri): `previewBase64` is the REAL generated PDF (base64). It is
//    rasterized with pdf.js into stacked <canvas> sheets — NOT an <iframe>: the
//    app's CSP forbids blob/asset frames and WKWebView won't render PDF frames
//    reliably anyway (see pdfPreview.js). The user reviews it, names it, then
//    Saves (→ native location dialog → copy temp to chosen path) or Cancels
//    (→ discard temp).
//  - Browser: no `previewBase64` → a compact filename-only dialog → html2pdf.
//
// Confirm calls onConfirm(filename); every other dismissal (Cancel, X, Esc,
// backdrop) calls onCancel — so the temp file is always cleaned up.
export default function PdfDialog() {
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState('Resume');
  const [previewBase64, setPreviewBase64] = useState(null);
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'done' | 'error'
  const [errMsg, setErrMsg] = useState('');
  const cbRef = useRef({ onConfirm: null, onCancel: null });
  const confirmedRef = useRef(false);
  const inputRef = useRef(null);
  const [hostNode, setHostNode] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    const onOpen = (e) => {
      const { defaultFilename, previewBase64: b64, onConfirm, onCancel } = e.detail || {};
      cbRef.current = {
        onConfirm: typeof onConfirm === 'function' ? onConfirm : null,
        onCancel: typeof onCancel === 'function' ? onCancel : null,
      };
      confirmedRef.current = false;
      setSaving(false);
      setSaveErr('');
      setFilename(defaultFilename || 'Resume');
      setPreviewBase64(b64 || null);
      setStatus(b64 ? 'loading' : 'idle');
      setOpen(true);
    };
    window.addEventListener('rd:open-pdf-dialog', onOpen);
    return () => window.removeEventListener('rd:open-pdf-dialog', onOpen);
  }, []);

  // Focus + select the filename when the dialog opens.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 80);
    return () => clearTimeout(t);
  }, [open]);

  // Rasterize the PDF into the canvas host whenever a preview opens. `hostNode`
  // is set by a callback ref, so this runs only once the (portaled) host <div>
  // is actually attached — a plain useRef reads null here because Radix mounts
  // the dialog content after this component's effects run. Cleanup cancels an
  // in-flight render, destroys the doc, and clears the host.
  useEffect(() => {
    if (!open || !previewBase64 || !hostNode) return undefined;
    let cancelled = false;
    let pdfDoc = null;
    setStatus('loading');
    setErrMsg('');
    renderPdfPreview(previewBase64, hostNode, () => cancelled)
      .then((pdf) => { pdfDoc = pdf; if (!cancelled) setStatus('done'); })
      .catch((err) => {
        if (!cancelled) {
          console.error('PDF preview render failed:', err);
          setErrMsg(String((err && err.message) || err));
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
      if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) { /* ignore */ } }
      hostNode.replaceChildren();
    };
  }, [open, previewBase64, hostNode]);

  const confirm = async () => {
    // Browser (no preview): close immediately and run the download in the
    // background — unchanged behavior.
    if (!previewBase64) {
      confirmedRef.current = true;
      setOpen(false);
      cbRef.current.onConfirm?.(filename);
      return;
    }
    // Desktop preview: keep the dialog open until the save actually succeeds, so
    // a failed save (disk full / permission denied) can be retried from the
    // retained temp PDF instead of forcing a full re-export. onConfirm rejects
    // only on a real save failure; backing out of the native picker resolves.
    setSaveErr('');
    setSaving(true);
    try {
      await cbRef.current.onConfirm?.(filename);
      confirmedRef.current = true; // set before close so onCancel is skipped
      setOpen(false);
    } catch (err) {
      setSaveErr(String((err && err.message) || err) || 'Failed to save the PDF.');
    } finally {
      setSaving(false);
    }
  };

  // Fires for every close. Skip onCancel exactly once after a confirm so a
  // confirm never also reports a cancel (which would discard the just-saved temp).
  const handleOpenChange = (next) => {
    if (!next && saving) return; // don't allow dismissing mid-save
    setOpen(next);
    if (!next) {
      if (confirmedRef.current) { confirmedRef.current = false; return; }
      cbRef.current.onCancel?.();
    }
  };

  const hasPreview = !!previewBase64;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={hasPreview ? 'max-w-2xl glass-card' : 'max-w-sm glass-card'}>
        <DialogHeader>
          <DialogTitle>{hasPreview ? 'Export PDF' : 'Download PDF'}</DialogTitle>
          <DialogDescription className="sr-only">
            {hasPreview ? 'Preview the PDF, then save it' : 'Choose a filename for the exported PDF'}
          </DialogDescription>
        </DialogHeader>

        {/* `pdf-preview-box` below is a styling hook, not a Tailwind class: the
            native iOS shell shortens this box (styles/native-shell.css) so the
            dialog's Save button still fits on a phone. 60vh plus the header,
            filename row and footer overflows a 760pt viewport by exactly enough
            to push Save off the bottom edge. */}
        {hasPreview && (
          <div className="pdf-preview-box relative h-[60vh] w-full overflow-auto rounded-md border bg-muted/30 p-3">
            <div ref={setHostNode} className="flex flex-col items-center gap-3" />
            {status === 'loading' && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">
                Rendering preview…
              </div>
            )}
            {status === 'error' && (
              <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-destructive">
                Couldn’t render the preview{errMsg ? `: ${errMsg}` : ''}. The PDF generated fine — you can still save it.
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="pdf-filename">Filename</Label>
          <div className="flex items-center gap-2">
            <Input
              id="pdf-filename"
              ref={inputRef}
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}
              placeholder="Resume"
              disabled={saving}
            />
            <span className="shrink-0 text-sm text-muted-foreground">.pdf</span>
          </div>
        </div>

        {saveErr && (
          <p className="text-sm text-destructive">
            Couldn’t save the PDF: {saveErr} Your preview is still here — try Save again.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={confirm} disabled={saving}>
            <Download className="size-4" /> {saving ? 'Saving…' : hasPreview ? 'Save PDF' : 'Download'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
