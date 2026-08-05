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
    // Resolve the index (and confirm the entry exists) here, at open time, rather
    // than during render. If the entry can't be resolved, the popover never opens —
    // so dispatch the "closed" signal immediately, because nothing else will (target
    // never goes from truthy to falsy, so the effect below won't fire) and without it
    // dateEditorOpen would stay stuck suppressing the AI button. The index is stored
    // on target so render doesn't have to re-parse the path.
    const onOpen = (e) => {
      const { path, rect } = e.detail;
      const match = /^experience\[(\d+)\]\.dates$/.exec(path);
      const index = match ? Number(match[1]) : -1;
      const experience = store.get('experience');
      const entry = Array.isArray(experience) ? experience[index] : null;
      if (!entry) {
        window.dispatchEvent(new Event('rd:date-editor-closed'));
        return;
      }
      setTarget({ path, rect, index });
    };
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

  // Close on any concurrent store change while the popover is open, rather than
  // race it. Undo is bound at document level and guarded only against
  // INPUT/TEXTAREA/contentEditable targets — the picker's month cells are
  // <button>s, so Cmd+Z fires right through it. Without this, `commit` below
  // would write its closed-over (now stale) `entry`/index back over whatever
  // undo just restored. Same philosophy as closing on scroll.
  useEffect(() => {
    if (!target) return undefined;
    return store.subscribe((event) => {
      if (event === 'change' || event === 'dataLoaded') setTarget(null);
    });
  }, [target]);

  if (!target) return null;

  // Render-time lookup stays live (the entry can change while the popover is
  // open, e.g. between mount and the first paint) but can now assume
  // target.index is valid — onOpen already confirmed the entry resolves.
  const experience = store.get('experience');
  const entry = Array.isArray(experience) ? experience[target.index] : null;
  if (!entry) return null;

  // One array write with all three fields set — the company-rename precedent —
  // not three separate scalar updates. Close BEFORE writing: the update
  // re-renders and re-paginates the resume, replacing the node we are anchored
  // to.
  //
  // Re-read the array instead of using the `experience` closed over above: while
  // the popover was open a store change could have replaced it wholesale (see the
  // subscribe effect), and writing back a stale array would resurrect whatever it
  // held at that render. setTarget(null) above is synchronous-enough that the
  // subscribe effect is still attached when store.update's 'change' fires below —
  // it sets target to null again, a harmless no-op.
  const commit = (fields) => {
    setTarget(null);
    const current = store.get('experience');
    if (!Array.isArray(current) || !current[target.index]) return;
    const next = current.map((it, i) => (i === target.index ? { ...it, ...fields } : it));
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
        <ExperienceDatePanel entry={entry} onCommit={commit} onClose={() => setTarget(null)} />
      </PopoverContent>
    </Popover>
  );
}
