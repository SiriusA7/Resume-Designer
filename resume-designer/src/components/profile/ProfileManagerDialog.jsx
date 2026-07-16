import { useEffect, useRef, useState } from 'react';
import { Download, Pencil, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDestructive } from '@/components/ui/confirm';

import {
  loadRegistry, getActiveProfileId, renameProfile, deleteProfile,
  exportProfileBackup, importProfileBackup,
} from '../../profiles.js';

/**
 * Manage-profiles dialog: rename (name + emoji), export, import, and delete,
 * over the profile registry. Always mounted (like ProfileDialog) and opened by
 * the `rd:open-profile-manager` event the ProfileSwitcher dispatches; the
 * registry is re-read on every open so it never shows a stale list.
 *
 * Delete is double-guarded: the button is disabled for the active profile and
 * when only one profile exists, and profiles.deleteProfile throws for both
 * cases anyway (surfaced as a toast) should the disabled state ever be stale.
 */
export function ProfileManagerDialog() {
  const [open, setOpen] = useState(false);
  const [registry, setRegistry] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: '', emoji: '' });
  const fileRef = useRef(null);
  const activeId = getActiveProfileId();

  useEffect(() => {
    const onOpen = () => {
      setRegistry(loadRegistry() || []);
      setEditingId(null);
      setOpen(true);
    };
    window.addEventListener('rd:open-profile-manager', onOpen);
    return () => window.removeEventListener('rd:open-profile-manager', onOpen);
  }, []);

  const refresh = () => setRegistry(loadRegistry() || []);

  const onDelete = async (p) => {
    const ok = await confirmDestructive({
      title: `Delete profile "${p.name}"?`,
      description: 'Their résumés, job descriptions, applications, and chats are permanently removed. Export the profile first if you might need it again.',
      actionLabel: 'Delete profile',
    });
    if (!ok) return;
    try {
      deleteProfile(p.id);
      refresh();
      toast.success(`Deleted "${p.name}".`);
    } catch (e) {
      toast.error(String(e.message || e));
    }
  };

  const onExport = (p) => {
    try {
      exportProfileBackup(p.id).catch((e) => toast.error(String(e.message || e)));
    } catch (e) {
      // Unknown-id throws synchronously (before the download promise exists).
      toast.error(String(e.message || e));
    }
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const profile = importProfileBackup(parsed);
      refresh();
      toast.success(`Imported "${profile.name}" as a new profile.`);
    } catch (err) {
      toast.error(String(err.message || err));
    }
  };

  const saveEdit = (id) => {
    renameProfile(id, {
      name: draft.name.trim() || undefined,
      emoji: draft.emoji.trim() || undefined,
    });
    setEditingId(null);
    refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md glass-card">
        <DialogHeader>
          <DialogTitle>Manage profiles</DialogTitle>
          <DialogDescription>
            Each profile is a separate workspace — résumés, job descriptions, applications, and chats.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {registry.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              {editingId === p.id ? (
                <>
                  <Input
                    className="w-12 text-center"
                    value={draft.emoji}
                    maxLength={4}
                    aria-label="Emoji"
                    onChange={(e) => setDraft((d) => ({ ...d, emoji: e.target.value }))}
                  />
                  <Input
                    className="flex-1"
                    value={draft.name}
                    autoFocus
                    aria-label="Name"
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(p.id); }}
                  />
                  <Button size="sm" onClick={() => saveEdit(p.id)}>Save</Button>
                </>
              ) : (
                <>
                  <span aria-hidden>{p.emoji}</span>
                  <span className="flex-1 truncate text-sm">
                    {p.name}
                    {p.id === activeId && <span className="ml-2 text-xs text-muted-foreground">(current)</span>}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Rename"
                    onClick={() => { setEditingId(p.id); setDraft({ name: p.name, emoji: p.emoji }); }}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Export this profile"
                    onClick={() => onExport(p)}
                  >
                    <Download className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={p.id === activeId
                      ? 'Cannot delete the active profile — switch away first'
                      : registry.length <= 1 ? 'Cannot delete the last profile' : 'Delete'}
                    disabled={p.id === activeId || registry.length <= 1}
                    onClick={() => onDelete(p)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div>
          <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={onImport} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> Import profile…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
