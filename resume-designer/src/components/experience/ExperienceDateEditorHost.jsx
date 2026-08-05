import { useEffect, useState } from 'react';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { store } from '../../store.js';
import { ExperienceDatePanel } from './ExperienceDateField.jsx';

/**
 * Bridges the vanilla inline editor to the React date panel.
 *
 * inlineEditor.js is a framework-free service module and stays that way: it
 * dispatches a CustomEvent and this host, mounted once in App, does the
 * rendering and the store write. That is the same hole confirmDestructive /
 * ConfirmHost already use.
 *
 * The popover is a Radix portal at document.body, so it is never a DOM child of
 * the resume. That matters twice over: pagination rebuilds the resume with
 * replaceChildren (a nested overlay would be destroyed on the next repaginate),
 * and it keeps the panel out of PDF capture. It also means clicks inside the
 * panel never reach inlineEditor's click listener, which is bound to #resume —
 * so no explicit exclusion is needed the way .editable-ai-container needs one.
 */
export function ExperienceDateEditorHost() {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    const onOpen = (e) => setTarget(e.detail);
    const onClose = () => setTarget(null);
    window.addEventListener('rd:edit-dates', onOpen);
    window.addEventListener('rd:close-date-editor', onClose);
    return () => {
      window.removeEventListener('rd:edit-dates', onOpen);
      window.removeEventListener('rd:close-date-editor', onClose);
    };
  }, []);

  // Tell the vanilla side the picker is gone, whatever closed it — commit,
  // Escape, or a click outside — so the AI button becomes available again.
  useEffect(() => {
    if (target) return;
    window.dispatchEvent(new Event('rd:date-editor-closed'));
  }, [target]);

  if (!target) return null;

  const match = /^experience\[(\d+)\]\.dates$/.exec(target.path);
  const index = match ? Number(match[1]) : -1;
  const experience = store.get('experience');
  const entry = Array.isArray(experience) ? experience[index] : null;
  if (!entry) return null;

  // One array write with all three fields set — the company-rename precedent —
  // not three separate scalar updates. Close BEFORE writing: the update
  // re-renders and re-paginates the resume, replacing the node we are anchored
  // to.
  const commit = (fields) => {
    setTarget(null);
    const next = experience.map((it, i) => (i === index ? { ...it, ...fields } : it));
    store.setChangeMetadata('Edited dates');
    store.update('experience', next);
  };

  const { top, left, width, height } = target.rect;

  return (
    <Popover open onOpenChange={(open) => { if (!open) setTarget(null); }}>
      {/* A zero-interaction stand-in for the resume's date node, placed at the
          rect captured on click. pointerEvents: none so it never intercepts a
          click meant for the text underneath. */}
      <PopoverAnchor asChild>
        <div style={{ position: 'fixed', top, left, width, height, pointerEvents: 'none' }} />
      </PopoverAnchor>
      <PopoverContent className="w-[320px]" align="start">
        <ExperienceDatePanel entry={entry} onCommit={commit} />
      </PopoverContent>
    </Popover>
  );
}
