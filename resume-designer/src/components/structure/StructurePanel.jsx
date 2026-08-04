import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus, Trash2, X } from 'lucide-react';

import { store, generateId, experienceSortValue } from '../../store.js';
import { sortRunAware, groupExperience } from '../../experienceGroups.js';
import { SINGLE_COLUMN_LAYOUTS } from '../../renderer.js';
import { getSettings, SETTINGS_UPDATED_EVENT } from '../../persistence.js';
import { SortableList, SortableItem, DragHandle } from '../Sortable.jsx';
import { PanelSection } from './PanelSection.jsx';
import DesignTab from './DesignTab.jsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

// Structure panel — restyled onto genuine shadcn primitives + Tailwind for the
// full-shadcn chrome redesign. It's a docked side <aside> (not a modal), so it
// keeps its skeleton shell + slide CSS: this component wires the skeleton
// toggle/close buttons, syncs the .open / .panel-open classes, and portals its
// body into #structure-panel-content.
//
// Data flow (the cursor-jump fix, in React): inputs are UNCONTROLLED
// (defaultValue) and write to the store on change without remounting — so typing
// never disturbs the caret. A `dataVersion` key remounts the form ONLY on
// EXTERNAL store changes (variant switch / AI edit / undo) and on local ARRAY
// ops (add/delete/reorder), refreshing every field's defaultValue. Local text
// edits are suppressed via the module `localEdit` flag — the exact translation
// of the vanilla isHandlingLocalFieldUpdate gate. Collapse state is lifted here
// so it survives remounts; scroll position is captured + restored.

const TAB_OPTIONS = {
  header: { tabLabel: 'Header', label: 'Header' },
  sidebar: { tabLabel: 'Sidebar', label: 'Sidebar' },
  main: { tabLabel: 'Main', label: 'Main content' },
  design: { tabLabel: 'Design', label: 'Design' },
};

const SECTION_TEMPLATES = {
  skills: { title: 'Skills', type: 'list', content: ['Skill 1', 'Skill 2', 'Skill 3'] },
  highlights: { title: 'Highlights', type: 'list', content: ['- Key achievement 1', '- Key achievement 2'] },
  languages: { title: 'Languages', type: 'list', content: ['English (Native)', 'Spanish (Conversational)'] },
  certifications: { title: 'Certifications', type: 'list', content: ['Certification Name — Year'] },
  interests: { title: 'Interests', type: 'list', content: ['Interest 1', 'Interest 2'] },
};

// --- tools are stored as a ' • '-joined string, not an array ---
function normalizeTools(tools) {
  if (Array.isArray(tools)) return tools.map((t) => String(t || '').trim()).filter(Boolean);
  if (tools == null) return [];
  return String(tools).split(/[\n•]/g).map((t) => t.trim()).filter(Boolean);
}
function serializeTools(items) {
  return items.map((t) => String(t || '').trim()).filter(Boolean).join(' • ');
}

// Suppress the form remount while the user is typing in a text field (the store
// 'change' it triggers must NOT refresh defaultValues mid-keystroke). Module
// scope so the store subscription closure always sees the latest value.
let localEdit = false;
function writeField(path, value) {
  localEdit = true;
  try { store.update(path, value); } finally { localEdit = false; }
}
function writeTool(index, value) {
  // Split WITHOUT dropping blanks (and join the same way) so the index space stays
  // aligned with the rendered inputs while the user is mid-edit — e.g. after clearing
  // a field before retyping. normalizeTools/serializeTools filter blanks, which shrank
  // the array, so the still-mounted input wrote to a stale index and overwrote the next
  // tool (or, with a single tool, saved nothing). Blanks compact via serializeTools on
  // add/delete/reorder/remount.
  const raw = store.get('tools');
  const items = Array.isArray(raw)
    ? raw.map((t) => String(t ?? ''))
    : String(raw ?? '').split(/[\n•]/g).map((t) => t.trim());
  if (index < 0 || index >= items.length) return;
  items[index] = value;
  writeField('tools', items.join(' • '));
}

// ------------------------------ small building blocks ------------------------

// Compact labeled field. Resume-data inputs stay UNCONTROLLED (defaultValue)
// and write through writeField on change — never `value`.
function Field({ label, type = 'text', path, defaultValue, onBlur }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type={type} className="h-8" data-field={path} defaultValue={defaultValue}
        onChange={(e) => writeField(path, e.target.value)}
        onBlur={onBlur}
      />
    </div>
  );
}

// Ghost icon delete button at the end of a sortable row.
function RowDeleteButton({ title = 'Delete', onClick }) {
  return (
    <Button
      variant="ghost" size="icon" type="button"
      className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
      title={title} onClick={onClick}
    >
      <X className="size-3.5" />
    </Button>
  );
}

// "+ Add …" ghost row at the foot of a list.
function AddRowButton({ label, onClick }) {
  return (
    <Button
      variant="ghost" size="sm" type="button"
      className="w-full justify-start gap-2 text-muted-foreground"
      onClick={onClick}
    >
      <Plus className="size-3.5" /> {label}
    </Button>
  );
}

// ------------------------------ sub-views ------------------------------------

function SectionContentList({ sectionIndex, content }) {
  const ids = content.map((_, i) => `sc-${sectionIndex}-${i}`);
  return (
    <SortableList
      className="space-y-1.5"
      ids={ids}
      onReorder={(from, to) => store.moveInArray(`sections[${sectionIndex}].content`, from, to)}
    >
      {content.map((item, i) => (
        <SortableItem key={ids[i]} id={ids[i]} className="flex items-center gap-1.5">
          <DragHandle />
          <Input
            type="text" className="h-8 flex-1"
            data-field={`sections[${sectionIndex}].content[${i}]`}
            defaultValue={item}
            onChange={(e) => writeField(`sections[${sectionIndex}].content[${i}]`, e.target.value)}
          />
          <RowDeleteButton onClick={() => store.removeFromArray(`sections[${sectionIndex}].content`, i)} />
        </SortableItem>
      ))}
      <AddRowButton label="Add item" onClick={() => store.addToArray(`sections[${sectionIndex}].content`, 'New item')} />
    </SortableList>
  );
}

function SectionItem({ section, index, activeLayout }) {
  const type = ['skills', 'paragraph'].includes(section?.type) ? section.type : 'list';
  const removeSection = async () => {
    const ok = await confirmDestructive({
      title: 'Delete this section?',
      description: 'The section and its items will be permanently removed from this resume.',
      actionLabel: 'Delete',
    });
    if (ok) store.removeFromArray('sections', index);
  };
  return (
    <SortableItem id={section.id || `section-${index}`} className="space-y-2.5 rounded-[9px] border bg-background p-2.5">
      <div className="flex items-center gap-1.5">
        <DragHandle />
        <Input
          type="text" className="h-8 flex-1"
          data-field={`sections[${index}].title`}
          defaultValue={section.title}
          onChange={(e) => writeField(`sections[${index}].title`, e.target.value)}
        />
        <RowDeleteButton title="Delete section" onClick={removeSection} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Area</span>
          <Segmented size="xs">
            {[['sidebar', 'Sidebar'], ['main', 'Main']].map(([a, label]) => (
              <SegmentedItem
                key={a} size="xs"
                active={(section.area || 'sidebar') === a}
                onClick={() => store.update(`sections[${index}].area`, a)}
              >
                {label}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Display</span>
          <Segmented size="xs">
            {[['list', 'Bulleted'], ['skills', 'Inline tags'], ['paragraph', 'Paragraph']].map(([t, label]) => (
              <SegmentedItem
                key={t} size="xs"
                active={type === t}
                onClick={() => store.update(`sections[${index}].type`, t)}
              >
                {label}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
      </div>
      {SINGLE_COLUMN_LAYOUTS.has(activeLayout) && (
        <p className="text-[11px] text-muted-foreground">
          This template uses a single column, so Area has no visible effect here.
        </p>
      )}
      <SectionContentList sectionIndex={index} content={section.content || []} />
    </SortableItem>
  );
}

// --- grouping actions -------------------------------------------------------
// Each is ONE store.update('experience', next) preceded by setChangeMetadata, so
// each is a single undo step. Never push-then-drag: that is two history entries
// and routes the user through the drag that breaks runs.

function linkToCompanyAbove(index) {
  const experience = store.get('experience');
  if (!Array.isArray(experience) || index < 1) return;
  const prev = experience[index - 1];
  const cur = experience[index];
  // Re-check against FRESH store data: the panel suppresses re-renders while a
  // field is being typed (localEdit), so the button's canLinkAbove prop can be
  // stale and this entry's company may have just changed. Never write `company`
  // here — copying the neighbour's name is how a role gets filed under an
  // employer the user never worked for.
  if (!prev || !prev.company || prev.company !== cur.company) return;
  const id = prev._groupId || generateId('grp');
  const oldId = cur._groupId;
  const next = [...experience];
  next[index - 1] = { ...prev, _groupId: id };
  next[index] = { ...cur, _groupId: id };
  // The clicked entry may itself be the LEAD of a run: its trailing members come
  // with it. Re-idding only this index would leave them on the old id, splitting
  // them off as an orphaned singleton the user never asked to unlink.
  for (let i = index + 1; i < next.length; i += 1) {
    const entry = next[i];
    if (!oldId || entry._groupId !== oldId || entry.company !== cur.company) break;
    next[i] = { ...entry, _groupId: id };
  }
  store.setChangeMetadata('Linked roles at one company');
  store.update('experience', next);
}

function separateFromCompanyAbove(index) {
  const experience = store.get('experience');
  if (!Array.isArray(experience) || index < 0) return;
  const cur = experience[index];
  const oldId = cur._groupId;
  // A fresh id — never reuse — so this entry can never re-fuse with the run above.
  const freshId = generateId('grp');
  const next = [...experience];
  next[index] = { ...next[index], _groupId: freshId };
  // Trailing members of the SAME run follow the detached entry, so separating the
  // middle role of a 3-role run yields [A] + [B,C] rather than orphaning C too.
  for (let i = index + 1; i < next.length; i += 1) {
    const entry = next[i];
    if (!oldId || entry._groupId !== oldId || entry.company !== cur.company) break;
    next[i] = { ...entry, _groupId: freshId };
  }
  store.setChangeMetadata('Separated role from company');
  store.update('experience', next);
}

function addRoleAtCompany(leadIndex) {
  const experience = store.get('experience');
  if (!Array.isArray(experience)) return;
  const lead = experience[leadIndex];
  if (!lead) return;
  // Revalidate the company against FRESH data, not just the button's gating: local
  // text edits suppress re-renders, so the user can clear this field while the
  // already-rendered button stays visible. A run needs a non-empty company, so
  // proceeding would insert a second blank row and id both entries into a "run"
  // the grouping rule then refuses to form.
  if (!lead.company) return;
  const id = lead._groupId || generateId('grp');
  // Recompute the run's end from FRESH store data rather than trusting a bound
  // that was computed at render time: the panel suppresses re-renders while a
  // field is being typed (localEdit), so renaming this lead's company shortens
  // the run without the render ever hearing about it. Splicing at a stale end
  // would drop the new role outside the run it belongs to.
  let lastIndexOfRun = leadIndex;
  if (lead._groupId && lead.company) {
    while (lastIndexOfRun + 1 < experience.length) {
      const nextEntry = experience[lastIndexOfRun + 1];
      if (!nextEntry || nextEntry._groupId !== lead._groupId || nextEntry.company !== lead.company) break;
      lastIndexOfRun += 1;
    }
  }
  const role = {
    id: generateId('exp'),
    title: 'New Position',
    company: lead.company,
    dates: 'Start – End',
    bullets: ['Describe your accomplishments'],
    _groupId: id,
    _expanded: true,
  };
  const next = [...experience];
  if (!next[leadIndex]._groupId) next[leadIndex] = { ...next[leadIndex], _groupId: id };
  next.splice(lastIndexOfRun + 1, 0, role);
  store.setChangeMetadata('Added a role at this company');
  store.update('experience', next);
}

function ExperienceItem({ exp, index, group, isLead, isRunMember, canLinkAbove, onCompanyBlur }) {
  const [expanded, setExpanded] = useState(exp._expanded !== false);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    // updateSilent => no history, no 'change' event, so no remount; the expanded
    // state persists across later structural re-renders (#9).
    store.updateSilent(`experience[${index}]._expanded`, next);
  };
  const removeExperience = async () => {
    const ok = await confirmDestructive({
      title: 'Delete this experience?',
      description: 'The experience entry will be permanently removed from this resume.',
      actionLabel: 'Delete',
    });
    if (ok) store.removeFromArray('experience', index);
  };
  const bulletIds = (exp.bullets || []).map((_, i) => `b-${index}-${i}`);
  return (
    <SortableItem id={exp.id || `exp-${index}`} className="overflow-hidden rounded-[9px] border bg-background">
      <div className="flex cursor-pointer items-center gap-2 px-2.5 py-2" onClick={toggle}>
        <DragHandle />
        {/* The rail is the whole grouping affordance: membership is visible
            without opening an accordion. */}
        <span
          aria-hidden="true"
          className={cn('w-[3px] self-stretch rounded-full', isRunMember ? 'bg-primary/40' : 'bg-transparent')}
        />
        <span className="min-w-0 flex-1">
          {isLead && group && group.roles.length > 1 && (
            <span className="block truncate text-[11.5px] font-semibold text-muted-foreground">
              {exp.company} · {group.roles.length} roles
            </span>
          )}
          <span className="block truncate text-[13px] font-semibold">{exp.title || 'Untitled position'}</span>
          {!isRunMember && <span className="block truncate text-[11.5px] text-muted-foreground">{exp.company || ''}</span>}
        </span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
        />
      </div>
      {/* Body stays MOUNTED when closed (Tailwind `hidden`), matching the old
          CSS expand/collapse — its uncontrolled inputs must keep their DOM
          values across toggles without a remount. */}
      <div className={cn('space-y-3 border-t bg-muted/40 p-2.5', !expanded && 'hidden')}>
        {[['title', 'Job title'], ['company', 'Company'], ['dates', 'Dates']].map(([f, label]) => (
          <Field
            key={f} label={label}
            path={`experience[${index}].${f}`}
            defaultValue={exp[f] || ''}
            // Company only: `writeField` suppresses the store-driven remount while
            // typing, so the grouping gating (canLinkAbove, "Add role at this
            // company") keeps whatever it computed BEFORE the rename — a disabled
            // Link button can never be clicked, so the fresh-data revalidation
            // inside the action never gets its chance. Blur forces a plain
            // re-render (no key change, no remount, no caret loss) which re-reads
            // store.getData() and re-gates against the typed company.
            onBlur={f === 'company' ? onCompanyBlur : undefined}
          />
        ))}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Bullets</Label>
          <SortableList
            className="space-y-1.5" ids={bulletIds}
            onReorder={(from, to) => store.moveInArray(`experience[${index}].bullets`, from, to)}
          >
            {(exp.bullets || []).map((bullet, i) => (
              <SortableItem key={bulletIds[i]} id={bulletIds[i]} className="flex items-center gap-1.5">
                <DragHandle />
                <Input
                  type="text" className="h-8 flex-1"
                  data-field={`experience[${index}].bullets[${i}]`}
                  defaultValue={bullet}
                  onChange={(e) => writeField(`experience[${index}].bullets[${i}]`, e.target.value)}
                />
                <RowDeleteButton onClick={() => store.removeFromArray(`experience[${index}].bullets`, i)} />
              </SortableItem>
            ))}
            <AddRowButton label="Add bullet" onClick={() => store.addToArray(`experience[${index}].bullets`, 'New bullet point')} />
          </SortableList>
        </div>
        <div className="flex flex-wrap gap-1.5 border-t pt-2.5">
          {/* Offered on the first member of ANY group, including a run of one:
              "I was promoted here" starts from a single entry, and this is the
              only path that adds the second role in place. Requires a company —
              a run needs a non-empty one to form, so without it the action would
              duplicate the row without producing a visible group. */}
          {isLead && group && !!exp.company && (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              onClick={() => addRoleAtCompany(index)}
            >
              <Plus className="size-3.5" /> Add role at this company
            </Button>
          )}
          {/* A run LEAD has no run member above it, so separating it is a pure
              no-op that still costs an undo entry — offer it the link action.
              At index 0 there is nothing above at all, so offer neither. */}
          {isRunMember && !isLead ? (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              onClick={() => separateFromCompanyAbove(index)}
            >
              Separate from company above
            </Button>
          ) : index > 0 ? (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              disabled={!canLinkAbove}
              title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
              onClick={() => linkToCompanyAbove(index)}
            >
              Link to company above
            </Button>
          ) : null}
        </div>
        <Button
          variant="ghost" size="sm" type="button"
          className="text-destructive hover:text-destructive"
          onClick={removeExperience}
        >
          <Trash2 className="size-3.5" /> Delete experience
        </Button>
      </div>
    </SortableItem>
  );
}

// ------------------------------ main component -------------------------------

export default function StructurePanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('header');
  const [dataVersion, bump] = useReducer((n) => n + 1, 0);
  // A SECOND counter whose only job is to force a plain re-render. It must never
  // reach the tab key below: putting it there would remount the tab on blur and
  // unmount the grouping button before its click landed, which is exactly the
  // "first click is swallowed" bug the profile editor had. Render re-reads
  // store.getData(), so a re-render alone re-gates the grouping controls.
  const [, bumpGrouping] = useReducer((n) => n + 1, 0);
  const [collapsed, setCollapsed] = useState({});
  const [renameOpen, setRenameOpen] = useState(false); // "Custom Section…" title dialog
  const [customTitle, setCustomTitle] = useState('');
  // Experience "Sort by" mode: 'date' | 'relevance' | 'custom'. Date/relevance are
  // one-shot reorders; 'custom' keeps the user's manual drag order. Persisted
  // per-variant on the resume data (experienceSortMode) via updateSilent, so it
  // survives reload/variant-switch without polluting undo history. Seeded from
  // saved data on open + kept in sync via the store subscription below.
  const [sortMode, setSortMode] = useState(() => store.getData()?.experienceSortMode || 'date');
  // Active template, for the single-column note on section items. The layout is
  // a design SETTING (getSettings().layout), not resume data, and switching it
  // emits no store event — so track it via the settings-updated window event.
  const [activeLayout, setActiveLayout] = useState(() => getSettings().layout || 'sidebar');
  const tabContentRef = useRef(null);
  const scrollPos = useRef(0);

  // Wire the skeleton toggle + close buttons to our open state.
  useEffect(() => {
    const toggleBtn = document.getElementById('toggle-structure-panel');
    const closeBtn = document.getElementById('close-structure-panel');
    const onToggle = () => setOpen((o) => !o);
    const onClose = () => setOpen(false);
    toggleBtn?.addEventListener('click', onToggle);
    closeBtn?.addEventListener('click', onClose);
    return () => {
      toggleBtn?.removeEventListener('click', onToggle);
      closeBtn?.removeEventListener('click', onClose);
    };
  }, []);

  // Sync the slide/layout classes the existing CSS keys on.
  useEffect(() => {
    document.getElementById('structure-panel')?.classList.toggle('open', open);
    document.getElementById('toggle-structure-panel')?.classList.toggle('active', open);
    document.querySelector('.app')?.classList.toggle('panel-open', open);
  }, [open]);

  // Follow template switches (DesignTab → saveSettings → this event).
  useEffect(() => {
    const onSettings = () => setActiveLayout(getSettings().layout || 'sidebar');
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettings);
  }, []);

  // Remount the content form on external store changes (and local array ops),
  // but never on a local text edit (localEdit gate).
  useEffect(() => {
    if (!open) return undefined;
    // Seed the sort mode from the active variant's saved value when the panel opens.
    setSortMode(store.getData()?.experienceSortMode || 'date');
    return store.subscribe((event) => {
      if (event === 'change' || event === 'dataLoaded') {
        if (localEdit) return;
        // Keep the sort dropdown in sync with the data (variant switch, undo/redo).
        setSortMode(store.getData()?.experienceSortMode || 'date');
        bump();
      }
    });
  }, [open]);

  // Restore scroll after a content remount.
  useLayoutEffect(() => {
    if (tabContentRef.current) tabContentRef.current.scrollTop = scrollPos.current;
  }, [dataVersion]);

  const host = typeof document !== 'undefined' ? document.getElementById('structure-panel-content') : null;
  if (!host || !open) return host ? createPortal(null, host) : null;

  const data = store.getData() || {};
  const toggleCollapse = (key) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const sectionProps = (id) => ({
    collapsed: !!collapsed[`${tab}-${id}`],
    onToggleCollapse: () => toggleCollapse(`${tab}-${id}`),
  });

  const addSection = (templateKey) => {
    const template = SECTION_TEMPLATES[templateKey];
    if (!template) return;
    store.addToArray('sections', {
      id: generateId('section'), area: 'sidebar',
      ...JSON.parse(JSON.stringify(template)),
    });
  };
  const addCustomSection = () => {
    const title = customTitle.trim();
    if (!title) return;
    store.addToArray('sections', {
      id: generateId('section'), title, type: 'list', area: 'sidebar', content: ['Item 1'],
    });
    setRenameOpen(false);
    setCustomTitle('');
  };
  const applySort = (mode) => {
    setSortMode(mode);
    // Persist the choice per-variant without history/remount (updateSilent).
    store.updateSilent('experienceSortMode', mode);
    // 'custom' keeps the user's manual order — nothing to reorder.
    if (mode === 'custom') return;
    const experience = store.get('experience');
    if (!Array.isArray(experience) || experience.length < 2) return;
    // Ordering is RUN-AWARE: a naive sort interleaves a foreign employer between
    // two roles at one company, which silently drops the company header from the
    // preview and the PDF. Because applySort('custom') is a no-op, that shredded
    // order would become the saved data with no way back.
    const sorted = mode === 'relevance'
      ? sortRunAware(
        experience,
        (run) => Math.min(...run.map((e) => (Number.isFinite(e?._relevanceRank) ? e._relevanceRank : Number.MAX_SAFE_INTEGER))),
        (a, b) => a - b,
      )
      : sortRunAware(
        experience,
        (run) => Math.max(...run.map(experienceSortValue)),
        (a, b) => b - a,
      );
    store.update('experience', sorted);
  };

  // A manual drag is an explicit custom arrangement: persist the new order AND
  // flip the sort mode to 'custom' so it sticks (and the dropdown reflects it).
  const reorderExperience = (from, to) => {
    setSortMode('custom');
    store.updateSilent('experienceSortMode', 'custom');
    const experience = store.get('experience');
    if (!Array.isArray(experience)) return;
    const next = [...experience];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // A drag can strand an entry away from its run. Rather than leave an id that
    // no longer describes anything, clear it — immediately visible in the rail,
    // and re-linked with one click.
    const before = next[to - 1];
    const after = next[to + 1];
    const stillAdjacent = (before && before._groupId && before._groupId === moved._groupId && before.company === moved.company)
      || (after && after._groupId && after._groupId === moved._groupId && after.company === moved.company);
    if (moved._groupId && !stillAdjacent) {
      next[to] = { ...moved, _groupId: undefined };
    }
    store.setChangeMetadata('Reordered experience');
    store.update('experience', next);
  };

  const sections = data.sections || [];
  const experience = data.experience || [];
  const education = data.education || [];
  const tools = normalizeTools(data.tools);
  const toolsDisplay = data.toolsDisplay === 'skills' ? 'skills' : 'list';

  return createPortal(
    <>
      {/* Fixed top zone: 4-tab segmented switcher (content scrolls). Text
          formatting (bold/italic/underline/…) for the panel's markdown fields is
          handled by the shared bottom toolbar, which formats the focused field
          the same way it formats the resume inline. */}
      <div className="shrink-0 border-b px-4 pb-3 pt-3.5">
        <Segmented className="flex w-full">
          {Object.entries(TAB_OPTIONS).map(([key, { tabLabel, label }]) => (
            <SegmentedItem
              key={key}
              className="flex-1"
              active={tab === key}
              onClick={() => { scrollPos.current = 0; setTab(key); }}
              title={label}
            >
              {tabLabel}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>

      {/* Tab content — keyed so content tabs remount on data change; design tab
          stays put. This wrapper is the scroller (flex-1 + overflow-y-auto inside
          the host's flex column), exactly as .panel-tab-content was before. */}
      <div
        className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5"
        ref={tabContentRef}
        onScroll={(e) => { scrollPos.current = e.currentTarget.scrollTop; }}
        key={tab === 'design' ? 'design' : `${tab}-${dataVersion}`}
      >
        {tab === 'header' && (
          <>
            <PanelSection title="Name & title" {...sectionProps('name-title')}>
              <Field label="Name" path="name" defaultValue={data.name || ''} />
              <Field label="Professional title" path="tagline" defaultValue={data.tagline || ''} />
            </PanelSection>
            <PanelSection title="Contact information" {...sectionProps('contact-info')}>
              {[['location', 'Location', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'tel'], ['portfolio', 'Portfolio URL', 'text'], ['instagram', 'Instagram', 'text']].map(([f, label, type]) => (
                <Field key={f} label={label} type={type} path={`contact.${f}`} defaultValue={data.contact?.[f] || ''} />
              ))}
            </PanelSection>
          </>
        )}

        {tab === 'sidebar' && (
          <>
            <PanelSection title="Sections" {...sectionProps('sidebar-sections')} headerExtra={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" type="button" className="size-7" title="Add section">
                    <Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {Object.entries(SECTION_TEMPLATES).map(([key, t]) => (
                    <DropdownMenuItem key={key} onSelect={() => addSection(key)}>{t.title}</DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => { setCustomTitle(''); setRenameOpen(true); }}>Custom section…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }>
              <SortableList className="space-y-2" ids={sections.map((s, i) => s.id || `section-${i}`)}
                onReorder={(from, to) => store.moveInArray('sections', from, to)}>
                {sections.map((section, i) => <SectionItem key={section.id || `section-${i}`} section={section} index={i} activeLayout={activeLayout} />)}
              </SortableList>
            </PanelSection>

            <PanelSection title="Tools" {...sectionProps('tools')}>
              {tools.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Display</span>
                  <Segmented size="xs">
                    {[['list', 'Bulleted'], ['skills', 'Inline tags']].map(([t, label]) => (
                      <SegmentedItem
                        key={t} size="xs"
                        active={toolsDisplay === t}
                        onClick={() => store.update('toolsDisplay', t)}
                      >
                        {label}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </div>
              )}
              <SortableList className="space-y-1.5" ids={tools.map((_, i) => `tool-${i}`)}
                onReorder={(from, to) => {
                  const items = normalizeTools(store.get('tools'));
                  const [moved] = items.splice(from, 1);
                  items.splice(to, 0, moved);
                  writeField('tools', serializeTools(items));
                  bump();
                }}>
                {tools.map((tool, i) => (
                  <SortableItem key={`tool-${i}`} id={`tool-${i}`} className="flex items-center gap-1.5">
                    <DragHandle />
                    <Input
                      type="text" className="h-8 flex-1" placeholder="Tool name"
                      defaultValue={tool} onChange={(e) => writeTool(i, e.target.value)}
                    />
                    <RowDeleteButton onClick={() => { const items = normalizeTools(store.get('tools')); items.splice(i, 1); writeField('tools', serializeTools(items)); bump(); }} />
                  </SortableItem>
                ))}
                <AddRowButton label="Add tool" onClick={() => { const items = normalizeTools(store.get('tools')); items.push('New tool'); writeField('tools', serializeTools(items)); bump(); }} />
              </SortableList>
            </PanelSection>
          </>
        )}

        {tab === 'main' && (
          <>
            <PanelSection title="Summary" {...sectionProps('summary')}>
              <Textarea
                data-field="summary" rows={4} placeholder="A brief professional summary..."
                defaultValue={data.summary || ''} onChange={(e) => writeField('summary', e.target.value)}
              />
            </PanelSection>

            <PanelSection title="Experience" {...sectionProps('experience')} headerExtra={
              <Button
                variant="ghost" size="icon" type="button" className="size-7" title="Add experience"
                onClick={() => store.addToArray('experience', { id: generateId('exp'), title: 'New Position', company: 'Company Name', dates: 'Start – End', bullets: ['Describe your accomplishments'], _expanded: true })}
              >
                <Plus className="size-4" />
              </Button>
            }>
              {experience.length > 1 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Sort by</span>
                  <Select value={sortMode} onValueChange={applySort}>
                    <SelectTrigger className="h-7 w-[130px] text-xs" aria-label="Sort experience by">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="date">Date</SelectItem>
                      <SelectItem value="relevance">Relevance</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <SortableList className="space-y-2" ids={experience.map((e, i) => e.id || `exp-${i}`)}
                onReorder={reorderExperience}>
                {(() => {
                  const groups = groupExperience(experience);
                  // index -> { group, isLead }
                  const byIndex = new Map();
                  groups.forEach((group) => {
                    group.roles.forEach((role, position) => {
                      byIndex.set(role.index, { group, isLead: position === 0 });
                    });
                  });
                  return experience.map((exp, i) => {
                    const meta = byIndex.get(i) || {};
                    const isRunMember = !!meta.group && meta.group.roles.length > 1;
                    const prev = i > 0 ? experience[i - 1] : null;
                    return (
                      <ExperienceItem
                        key={exp.id || `exp-${i}`}
                        exp={exp}
                        index={i}
                        group={meta.group}
                        isLead={!!meta.isLead}
                        isRunMember={isRunMember}
                        canLinkAbove={!!prev && !!prev.company && prev.company === exp.company}
                        onCompanyBlur={bumpGrouping}
                      />
                    );
                  });
                })()}
              </SortableList>
            </PanelSection>

            <PanelSection title="Education" {...sectionProps('education')} headerExtra={
              <Button
                variant="ghost" size="icon" type="button" className="size-7" title="Add education"
                onClick={() => store.addToArray('education', 'Degree — Institution — Dates')}
              >
                <Plus className="size-4" />
              </Button>
            }>
              <SortableList className="space-y-1.5" ids={education.map((_, i) => `edu-${i}`)}
                onReorder={(from, to) => store.moveInArray('education', from, to)}>
                {education.map((edu, i) => (
                  <SortableItem key={`edu-${i}`} id={`edu-${i}`} className="flex items-center gap-1.5">
                    <DragHandle />
                    <Input
                      type="text" className="h-8 flex-1" data-field={`education[${i}]`}
                      defaultValue={edu} onChange={(e) => writeField(`education[${i}]`, e.target.value)}
                    />
                    <RowDeleteButton onClick={() => store.removeFromArray('education', i)} />
                  </SortableItem>
                ))}
              </SortableList>
            </PanelSection>
          </>
        )}

        {tab === 'design' && <DesignTab sectionProps={sectionProps} />}
      </div>

      {/* Custom section title dialog (replaces prompt()) */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm glass-card">
          <DialogHeader>
            <DialogTitle>New section</DialogTitle>
            <DialogDescription className="sr-only">Enter a title for the new custom section</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); addCustomSection(); }} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="custom-section-title">Section title</Label>
              <Input id="custom-section-title" value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} autoFocus />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setRenameOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!customTitle.trim()}>Add section</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>,
    host
  );
}
