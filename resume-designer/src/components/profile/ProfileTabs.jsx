import { useId, useReducer } from 'react';
import { Globe, Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { confirmDestructive } from '@/components/ui/confirm';
import { toast } from 'sonner';
import { userProfileAdoptions } from '../../userProfileHolder.js';

import { shouldSpellcheck, EDITABLE_TEXT_ATTRS } from '../../spellcheck.js';
import { groupExperience, companyKey } from '../../experienceGroups.js';
// The compositions these tabs used to hold inline. They live in profileBridge.js
// so the native iOS sheet performs the SAME edit rather than a second one — see
// that file's header for why a Swift reimplementation of the run rules is the
// thing to avoid.
import {
  PROFICIENCY_OPTIONS, addProfileItem, addRoleAt, deleteProfileItem, detachRole,
  linkAbove, removeEntries, setRunCompany, stripEmphasis,
} from '../../profileBridge.js';
import ExperienceDateField from '../experience/ExperienceDateField.jsx';

// The profile editor's per-tab content, rebuilt on genuine shadcn primitives to
// match SettingsDialog's idiom (Label + Input grids, SectionHeader, entry cards
// = `rounded-lg border bg-card p-4`, dashed outline add buttons, muted empty
// states). Inputs stay UNCONTROLLED (defaultValue) and write straight into the
// working `profile` object on change, so typing never re-renders (caret-safe).
// Add/delete call `refresh()`, which the parent uses to bump a remount key so
// the list reflects the structural change without disturbing the caret.

// Brand glyphs (LinkedIn / GitHub / Twitter / Instagram). lucide-react ships no
// brand marks (verified: Linkedin/Github/Twitter/Instagram are undefined in this
// version) and the project has no brand-icon package, so these single-path
// `currentColor` SVGs remain as the documented decorative-adornment exception —
// mapping them to a generic lucide glyph would lose brand recognition. The
// portfolio "globe" adornment, which DOES have a lucide equivalent, now uses
// lucide `Globe`. These are aria-hidden, non-interactive.
function BrandIcon({ children }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

// Section heading + optional muted description (mirrors SettingsDialog.SectionHeader).
// Mockup tokens: group-title 14px/600, group-sub 12.5px muted.
function SectionHeader({ title, description }) {
  return (
    <div className={cn(description ? 'mb-3.5' : 'mb-3')}>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted-foreground">{description}</p>}
    </div>
  );
}

// A labeled, uncontrolled text input that commits to the working object on change.
// `prose`: this field's value is résumé content (not an identifier like email/
// phone/a social URL), so WebKit autocorrect/autocapitalize are disabled — see
// EDITABLE_TEXT_ATTRS in spellcheck.js.
function Field({ id, label, icon, type = 'text', value, placeholder, onCommit, prose = false }) {
  return (
    <div className="space-y-1.5">
      {label && (
        <Label htmlFor={id} className="flex items-center gap-1.5">
          {icon}
          {label}
        </Label>
      )}
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        defaultValue={value || ''}
        onChange={(e) => onCommit(e.target.value)}
        {...(prose ? EDITABLE_TEXT_ATTRS : null)}
      />
    </div>
  );
}

// A labeled, uncontrolled textarea with a muted hint (Summary-tab idiom). Every
// caller holds résumé prose, so WebKit autocorrect/autocapitalize are always off.
function Area({ id, label, hint, value, placeholder, rows = 4, onCommit }) {
  return (
    <div className="space-y-1.5">
      {(label || hint) && (
        <div className="space-y-1">
          {label && <Label htmlFor={id} className="text-base font-medium">{label}</Label>}
          {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
        </div>
      )}
      <Textarea
        id={id}
        rows={rows}
        placeholder={placeholder}
        defaultValue={stripEmphasis(value)}
        onChange={(e) => onCommit(e.target.value)}
        {...EDITABLE_TEXT_ATTRS}
      />
    </div>
  );
}

// Full-width dashed "Add …" affordance (outline button + leading plus).
function AddButton({ onClick, children }) {
  return (
    <Button type="button" variant="outline" className="w-full border-dashed" onClick={onClick}>
      <Plus className="h-4 w-4" />
      {children}
    </Button>
  );
}

// Centered muted empty state for an empty list.
function Empty({ title, subtitle }) {
  return (
    <div className="rounded-lg border border-dashed py-8 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────

function ContactTab({ profile, scheduleSave }) {
  const c = profile.contactInfo;
  const set = (field) => (value) => { c[field] = value; scheduleSave(); };
  return (
    <div className="space-y-6">
      <section>
        <SectionHeader title="Basic information" description="Your name and contact details for resumes" />
        <div className="grid grid-cols-2 gap-4">
          <Field id="profile-fullName" label="Full name" value={c.fullName} placeholder="e.g. John Smith" onCommit={set('fullName')} prose />
          <Field id="profile-email" label="Email" type="email" value={c.email} placeholder="e.g. john@example.com" onCommit={set('email')} />
          <Field id="profile-phone" label="Phone" type="tel" value={c.phone} placeholder="e.g. (555) 123-4567" onCommit={set('phone')} />
          <Field id="profile-location" label="Location" value={c.location} placeholder="e.g. San Francisco, CA" onCommit={set('location')} prose />
        </div>
      </section>

      <section>
        <SectionHeader title="Online presence" description="Links to your professional profiles and portfolio" />
        <div className="grid grid-cols-2 gap-4">
          <Field
            id="profile-linkedin"
            type="url"
            label="LinkedIn"
            value={c.linkedin}
            placeholder="e.g. linkedin.com/in/johnsmith"
            onCommit={set('linkedin')}
            icon={<BrandIcon><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></BrandIcon>}
          />
          <Field
            id="profile-portfolio"
            type="url"
            label="Portfolio / website"
            value={c.portfolio}
            placeholder="e.g. johnsmith.com"
            onCommit={set('portfolio')}
            icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
          />
          <Field
            id="profile-github"
            type="url"
            label="GitHub"
            value={c.github}
            placeholder="e.g. github.com/johnsmith"
            onCommit={set('github')}
            icon={<BrandIcon><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></BrandIcon>}
          />
          <Field
            id="profile-twitter"
            type="url"
            label="Twitter / X"
            value={c.twitter}
            placeholder="e.g. twitter.com/johnsmith"
            onCommit={set('twitter')}
            icon={<BrandIcon><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></BrandIcon>}
          />
          <Field
            id="profile-instagram"
            type="url"
            label="Instagram"
            value={c.instagram}
            placeholder="e.g. instagram.com/johnsmith"
            onCommit={set('instagram')}
            icon={<BrandIcon><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" /></BrandIcon>}
          />
        </div>
      </section>
    </div>
  );
}

function SummaryTab({ profile, scheduleSave }) {
  const set = (field) => (value) => { profile[field] = value; scheduleSave(); };
  return (
    <div className="space-y-6">
      <Area
        id="profile-personalSummary"
        label="Personal summary"
        hint="Tell the AI who you are professionally. What makes you unique?"
        rows={6}
        value={profile.personalSummary}
        onCommit={set('personalSummary')}
        placeholder="Example: I'm a passionate UX designer with 8 years of experience in fintech and healthcare. I specialize in complex data visualization and have led design systems initiatives at two Fortune 500 companies..."
      />
      <Area
        id="profile-careerGoals"
        label="Career goals"
        hint="What are you looking for? What roles interest you?"
        value={profile.careerGoals}
        onCommit={set('careerGoals')}
        placeholder="Example: I'm seeking a senior or lead UX position at a company focused on AI/ML products. I want to transition into more strategic work while still being hands-on with design..."
      />
      <Area
        id="profile-preferences"
        label="Preferences"
        hint="Work style, industries, salary expectations, location preferences, etc."
        value={profile.preferences}
        onCommit={set('preferences')}
        placeholder="Example: Remote-first, interested in Series B+ startups or established tech companies. Open to contract work. Prefer collaborative environments with strong design culture..."
      />
    </div>
  );
}

// One entry card: a title Input + ghost-destructive trash in the header row,
// then the body fields beneath. Mirrors the spec's `rounded-lg border bg-card`.
function EntryCard({ titleInput, onDelete, children }) {
  return (
    <div className="space-y-2.5 rounded-[10px] border bg-card p-[13px]">
      <div className="flex items-center gap-2.5">
        {titleInput}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Delete"
          aria-label="Delete"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}

// Generic add/delete list of entry cards.
function ItemList({ items, emptyTitle, emptySubtitle, addLabel, onAdd, onDelete, renderTitle, renderBody }) {
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <Empty title={emptyTitle} subtitle={emptySubtitle} />
      ) : (
        items.map((item, i) => (
          <EntryCard key={item.id || `row-${i}`} titleInput={renderTitle(item, i)} onDelete={() => onDelete(i)}>
            {renderBody(item, i)}
          </EntryCard>
        ))
      )}
      <AddButton onClick={onAdd}>{addLabel}</AddButton>
    </div>
  );
}

// ── Experience: employer blocks ─────────────────────────────────────────
// The résumé prints several positions at one employer as a company header with
// dated roles beneath. These render the same shape in the editor, so the two
// surfaces agree. A run of ONE collapses to SoloJobCard — nesting appears only
// where a progression exists, so it means something.

// One role inside an employer block. Deliberately has NO company field: the
// block states the employer once, so there is nothing to repeat and nothing to
// get out of sync.
function RoleSubCard({ exp, index, set, setDates, onDelete, onDetach, canDetach }) {
  return (
    <div className="space-y-2.5 rounded-[8px] border bg-background/40 p-2.5">
      <div className="flex items-center gap-2.5">
        <Input
          className="font-medium" placeholder="Job title"
          defaultValue={exp.title || ''}
          onChange={(e) => set(index, 'title')(e.target.value)}
          {...EDITABLE_TEXT_ATTRS}
        />
        <Button
          type="button" variant="ghost" size="icon"
          title="Delete role" aria-label="Delete role"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <ExperienceDateField entry={exp} onCommit={setDates(index)} />
      <Textarea
        rows={4}
        placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
        defaultValue={stripEmphasis(exp.details)}
        onChange={(e) => set(index, 'details')(e.target.value)}
        {...EDITABLE_TEXT_ATTRS}
      />
      {canDetach && (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <Button
            variant="outline" size="sm" type="button" className="h-7 text-xs"
            onClick={onDetach}
          >
            Make this its own employer
          </Button>
        </div>
      )}
    </div>
  );
}

// A run of 2+: the employer stated once, its roles beneath.
function EmployerBlock({
  group, set, setDates, onCompanyChange, onCompanyBlur, onAddRole, onDeleteRole, onDetachRole, onDeleteEmployer,
  onLinkAbove, canLinkAbove, showLinkAbove,
}) {
  const employerInputId = useId();
  const canAddRole = !!(group.company || '').trim();
  return (
    <div className="space-y-2.5 rounded-[10px] border bg-card p-[13px]">
      <div className="flex items-end gap-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor={employerInputId} className="text-xs text-muted-foreground">Employer</Label>
          <Input
            id={employerInputId}
            className="font-semibold" placeholder="Company"
            defaultValue={group.company}
            onChange={(e) => onCompanyChange(group, e.target.value)}
            onBlur={onCompanyBlur}
            {...EDITABLE_TEXT_ATTRS}
          />
        </div>
        <span className="shrink-0 whitespace-nowrap pb-2 text-[11.5px] font-medium text-muted-foreground">
          {group.roles.length} positions
        </span>
        <Button
          type="button" variant="ghost" size="icon"
          title="Delete employer" aria-label="Delete employer"
          className="mb-0.5 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDeleteEmployer(group)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-2">
        {group.roles.map((role, position) => (
          <RoleSubCard
            key={role.entry.id || `role-${role.index}`}
            exp={role.entry}
            index={role.index}
            set={set}
            setDates={setDates}
            onDelete={() => onDeleteRole(role.index)}
            onDetach={() => onDetachRole(role.index)}
            canDetach={position > 0}
          />
        ))}
      </div>
      {(canAddRole || showLinkAbove) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {canAddRole && (
            <Button
              variant="outline" size="sm" type="button" className="h-7 flex-1 text-xs"
              onClick={() => onAddRole(group)}
            >
              <Plus className="h-3.5 w-3.5" /> Add role at this company
            </Button>
          )}
          {/* A detached role leaves [solo Acme] + [Acme block]; without this the
              block's lead has no way back. linkAbove never writes `company`, and
              it carries the lead's trailing run members with it. */}
          {showLinkAbove && (
            <Button
              variant="outline" size="sm" type="button" className="h-7 text-xs"
              disabled={!canLinkAbove}
              title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
              onClick={() => onLinkAbove(group.roles[0].index)}
            >
              Link to company above
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// A run of ONE: today's flat card, unchanged in shape. It keeps its own company
// field, because there is no block above it to state the employer.
function SoloJobCard({ exp, index, set, setDates, onCompanyBlur, onAddRole, onDelete, onLinkAbove, canLinkAbove, showLinkAbove }) {
  const canAddRole = !!(exp.company || '').trim();
  return (
    <div className="space-y-2.5 rounded-[10px] border bg-card p-[13px]">
      <div className="flex items-center gap-2.5">
        <Input
          className="font-medium" placeholder="Job title"
          defaultValue={exp.title || ''}
          onChange={(e) => set(index, 'title')(e.target.value)}
          {...EDITABLE_TEXT_ATTRS}
        />
        {canAddRole && (
          <Button
            variant="outline" size="sm" type="button" className="h-7 shrink-0 text-xs"
            title="Add role at this company"
            onClick={() => onAddRole(index)}
          >
            <Plus className="h-3.5 w-3.5" /> Add role
          </Button>
        )}
        <Button
          type="button" variant="ghost" size="icon"
          title="Delete" aria-label="Delete"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        placeholder="Company"
        defaultValue={exp.company || ''}
        onChange={(e) => set(index, 'company')(e.target.value)}
        onBlur={onCompanyBlur}
        {...EDITABLE_TEXT_ATTRS}
      />
      <ExperienceDateField entry={exp} onCommit={setDates(index)} />
      <Textarea
        rows={4}
        placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
        defaultValue={stripEmphasis(exp.details)}
        onChange={(e) => set(index, 'details')(e.target.value)}
        {...EDITABLE_TEXT_ATTRS}
      />
      {showLinkAbove && (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <Button
            variant="outline" size="sm" type="button" className="h-7 text-xs"
            disabled={!canLinkAbove}
            title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
            onClick={() => onLinkAbove(index)}
          >
            Link to company above
          </Button>
        </div>
      )}
    </div>
  );
}

function ExperienceTab({ profile, scheduleSave, refresh }) {
  const items = profile.workExperience;
  const set = (i, field) => (v) => { items[i][field] = v; scheduleSave(); };
  // Dates write THREE fields at once (the display string plus the
  // machine-readable pair), so this cannot go through `set`, which writes one.
  // The local bump re-renders the tab so the trigger label updates; it must NOT
  // be `refresh`, which bumps the parent's `version` — the tab wrapper's React
  // key — and would remount the tab mid-interaction.
  const setDates = (i) => (fields) => { Object.assign(items[i], fields); scheduleSave(); bumpGrouping(); };
  // Local re-render ONLY, to re-derive the grouping after a company edit. It must
  // not go through `refresh`: that bumps the parent's `version`, which is the tab
  // wrapper's React key, so blurring the company input would remount the tab and
  // unmount the button being pressed before its click fired.
  const [, bumpGrouping] = useReducer((n) => n + 1, 0);
  const groups = groupExperience(items);
  const rewrite = (next) => { if (next) { items.splice(0, items.length, ...next); refresh(); } };

  // The four run edits. Each returns the next array (or null when the edit does
  // not apply), so committing it is this component's job and the rules stay in
  // profileBridge.js, which the native sheet calls with the same arguments.
  const addRole = (leadIndex) => rewrite(addRoleAt(items, leadIndex));
  const detach = (index) => rewrite(detachRole(items, index));
  const link = (index) => rewrite(linkAbove(items, index));

  const deleteEntry = (index) => { deleteProfileItem(profile, 'workExperience', index); refresh(); };

  // The block shows ONE company field for the whole employer, so an edit applies
  // to every role in it. The indices come from the RENDER-TIME group and are
  // deliberately not re-derived per keystroke — see setRunCompany.
  const setGroupCompany = (group, value) => {
    setRunCompany(items, group.roles.map((role) => role.index), value);
    scheduleSave();
  };

  // Removes several entries at once, so it asks first. Splices by descending
  // index so earlier removals cannot shift the ones still to come.
  const deleteEmployer = async (group) => {
    const count = group.roles.length;
    // Read the company from `items` at click time, not from the render-time
    // `group`: the field is uncontrolled and setGroupCompany deliberately skips
    // the re-render, so a just-typed name would not be reflected here and this
    // dialog would name the wrong employer while asking to destroy it.
    const liveCompany = items[group.roles[0]?.index]?.company || group.company;
    // The confirmation is an unbounded wait, and an adopted `data:userProfile`
    // unit replaces the dialog's working copy during one. The tab is keyed on
    // its version, so that REMOUNTS it — and this handler belongs to the
    // component that is now gone, holding an `items` array that is no longer
    // attached to anything. Splicing it writes into nothing while `refresh()`
    // saves the adopted copy unchanged, so the employer the person confirmed
    // deleting is simply still there, with no error and nothing to retry.
    const adoptions = userProfileAdoptions();
    const ok = await confirmDestructive({
      title: `Delete ${liveCompany || 'this employer'}?`,
      description: `All ${count} positions at this employer will be permanently removed from your profile.`,
      actionLabel: 'Delete',
    });
    if (!ok) return;
    if (userProfileAdoptions() !== adoptions) {
      toast.error('Your profile changed on another device while that was open — nothing was deleted.');
      return;
    }
    rewrite(removeEntries(items, group.roles.map((r) => r.index)));
  };

  return (
    <section>
      <SectionHeader
        title="Detailed work experience"
        description="Add details beyond what's on your resume - challenges faced, technologies used, team size, impact metrics, lessons learned. Several positions at one employer sit together under a single company heading."
      />
      <div className="space-y-3">
        {items.length === 0 ? (
          <Empty title="No experience entries yet" subtitle="Add detailed information about your work history" />
        ) : (
          groups.map((group) => {
            const lead = group.roles[0];
            const i = lead.index;
            const prev = i > 0 ? items[i - 1] : null;
            const canLinkAbove = !!prev
              && !!companyKey(prev.company)
              && companyKey(prev.company) === companyKey(lead.entry.company);
            if (group.roles.length > 1) {
              return (
                <EmployerBlock
                  key={lead.entry.id || `emp-${lead.index}`}
                  group={group}
                  set={set}
                  setDates={setDates}
                  onCompanyChange={setGroupCompany}
                  onCompanyBlur={bumpGrouping}
                  onAddRole={(g) => addRole(g.roles[0].index)}
                  onDeleteRole={deleteEntry}
                  onDetachRole={detach}
                  onDeleteEmployer={deleteEmployer}
                  onLinkAbove={link}
                  canLinkAbove={canLinkAbove}
                  showLinkAbove={i > 0}
                />
              );
            }
            return (
              <SoloJobCard
                key={lead.entry.id || `exp-${i}`}
                exp={lead.entry}
                index={i}
                set={set}
                setDates={setDates}
                onCompanyBlur={bumpGrouping}
                onAddRole={addRole}
                onDelete={() => deleteEntry(i)}
                onLinkAbove={link}
                canLinkAbove={canLinkAbove}
                showLinkAbove={i > 0}
              />
            );
          })
        )}
        <AddButton onClick={() => { addProfileItem(profile, 'workExperience'); refresh(); }}>
          Add experience entry
        </AddButton>
      </div>
    </section>
  );
}

function SkillsTab({ profile, scheduleSave, refresh }) {
  const skills = profile.skills;
  const set = (i, field) => (v) => { skills[i][field] = v; scheduleSave(); };
  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          title="Skills inventory"
          description="List all your skills with proficiency levels and years of experience."
        />
        <div className="space-y-2">
          {skills.length === 0 ? (
            <Empty title="No skills added yet" subtitle="Add your skills with proficiency levels" />
          ) : (
            skills.map((skill, i) => (
              <div className="flex items-center gap-2" key={i}>
                <Input className="flex-1" placeholder="Skill name" defaultValue={skill.name || ''} onChange={(e) => set(i, 'name')(e.target.value)} {...EDITABLE_TEXT_ATTRS} />
                <Select defaultValue={skill.proficiency || undefined} onValueChange={set(i, 'proficiency')}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Proficiency" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROFICIENCY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input className="w-20" placeholder="Years" defaultValue={skill.years || ''} onChange={(e) => set(i, 'years')(e.target.value)} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Delete"
                  aria-label="Delete"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => { deleteProfileItem(profile, 'skills', i); refresh(); }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
          <AddButton onClick={() => { addProfileItem(profile, 'skills'); refresh(); }}>Add skill</AddButton>
        </div>
      </section>

      <Area
        id="profile-industryKnowledge"
        label="Industry knowledge"
        hint="Domains you've worked in, tools mastered, methodologies you follow."
        value={profile.industryKnowledge}
        onCommit={(v) => { profile.industryKnowledge = v; scheduleSave(); }}
        placeholder="Example: Deep expertise in e-commerce, SaaS, and mobile app design. Familiar with Agile/Scrum, Design Thinking, and Jobs-to-be-Done frameworks. Strong knowledge of accessibility standards (WCAG 2.1)..."
      />
    </div>
  );
}

function EducationTab({ profile, scheduleSave, refresh }) {
  const items = profile.education;
  const set = (i, field) => (v) => { items[i][field] = v; scheduleSave(); };
  return (
    <section>
      <SectionHeader
        title="Education details"
        description="Include courses, projects, thesis topics, honors, extracurriculars - details beyond a typical resume."
      />
      <ItemList
        items={items}
        emptyTitle="No education entries yet"
        emptySubtitle="Add detailed information about your education"
        addLabel="Add education entry"
        onAdd={() => { addProfileItem(profile, 'education'); refresh(); }}
        onDelete={(i) => { deleteProfileItem(profile, 'education', i); refresh(); }}
        renderTitle={(edu, i) => (
          <Input className="font-medium" placeholder="Degree / program" defaultValue={edu.degree || ''} onChange={(e) => set(i, 'degree')(e.target.value)} {...EDITABLE_TEXT_ATTRS} />
        )}
        renderBody={(edu, i) => (
          <>
            <Input placeholder="Institution" defaultValue={edu.institution || ''} onChange={(e) => set(i, 'institution')(e.target.value)} {...EDITABLE_TEXT_ATTRS} />
            <Input placeholder="Dates / year" defaultValue={edu.dates || ''} onChange={(e) => set(i, 'dates')(e.target.value)} />
            <Textarea
              rows={3}
              placeholder="Notable courses, projects, thesis, honors, activities, GPA if relevant..."
              defaultValue={stripEmphasis(edu.details)}
              onChange={(e) => set(i, 'details')(e.target.value)}
              {...EDITABLE_TEXT_ATTRS}
            />
          </>
        )}
      />
    </section>
  );
}

function ProjectsTab({ profile, scheduleSave, refresh }) {
  const items = profile.projects;
  const set = (i, field) => (v) => { items[i][field] = v; scheduleSave(); };
  return (
    <section>
      <SectionHeader
        title="Portfolio & projects"
        description="Personal projects, open source contributions, side work, freelance projects - anything that showcases your abilities."
      />
      <ItemList
        items={items}
        emptyTitle="No projects added yet"
        emptySubtitle="Add projects that showcase your work"
        addLabel="Add project"
        onAdd={() => { addProfileItem(profile, 'projects'); refresh(); }}
        onDelete={(i) => { deleteProfileItem(profile, 'projects', i); refresh(); }}
        renderTitle={(proj, i) => (
          <Input className="font-medium" placeholder="Project name" defaultValue={proj.name || ''} onChange={(e) => set(i, 'name')(e.target.value)} {...EDITABLE_TEXT_ATTRS} />
        )}
        renderBody={(proj, i) => (
          <>
            <Input placeholder="URL (optional)" defaultValue={proj.url || ''} onChange={(e) => set(i, 'url')(e.target.value)} spellCheck={shouldSpellcheck('url')} />
            <Textarea
              rows={4}
              placeholder="Describe the project: what problem does it solve? What technologies did you use? What was your role? What was the outcome?"
              defaultValue={stripEmphasis(proj.description)}
              onChange={(e) => set(i, 'description')(e.target.value)}
              {...EDITABLE_TEXT_ATTRS}
            />
          </>
        )}
      />
    </section>
  );
}

// A compact mini-list row: fields + a ghost-destructive X button.
function CompactRow({ onDelete, children }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Delete"
        aria-label="Delete"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function MoreTab({ profile, scheduleSave, refresh }) {
  const certs = profile.certifications;
  const achs = profile.achievements;
  const customs = profile.customSections;
  return (
    <div className="space-y-6">
      <section>
        <SectionHeader title="Certifications & training" description="Professional certifications, courses, training programs." />
        <div className="space-y-2">
          {certs.length === 0 ? (
            <Empty title="No certifications added" />
          ) : certs.map((cert, i) => (
            <CompactRow key={i} onDelete={() => { deleteProfileItem(profile, 'certifications', i); refresh(); }}>
              <Input className="flex-1" placeholder="Certification name" defaultValue={cert.name || ''} onChange={(e) => { certs[i].name = e.target.value; scheduleSave(); }} {...EDITABLE_TEXT_ATTRS} />
              <Input className="w-24" placeholder="Year" defaultValue={cert.year || ''} onChange={(e) => { certs[i].year = e.target.value; scheduleSave(); }} />
            </CompactRow>
          ))}
          <AddButton onClick={() => { addProfileItem(profile, 'certifications'); refresh(); }}>Add certification</AddButton>
        </div>
      </section>

      <section>
        <SectionHeader title="Achievements & awards" description="Notable accomplishments, recognition, awards." />
        <div className="space-y-2">
          {achs.length === 0 ? (
            <Empty title="No achievements added" />
          ) : achs.map((ach, i) => (
            <CompactRow key={i} onDelete={() => { deleteProfileItem(profile, 'achievements', i); refresh(); }}>
              <Input className="flex-1" placeholder="Achievement description" defaultValue={ach.description || ''} onChange={(e) => { achs[i].description = e.target.value; scheduleSave(); }} {...EDITABLE_TEXT_ATTRS} />
            </CompactRow>
          ))}
          <AddButton onClick={() => { addProfileItem(profile, 'achievements'); refresh(); }}>Add achievement</AddButton>
        </div>
      </section>

      <section>
        <SectionHeader title="Custom sections" description="Add any other information you want the AI to know about." />
        <div className="space-y-3">
          {customs.length === 0 ? (
            <Empty title="No custom sections added" />
          ) : customs.map((sec, i) => (
            <EntryCard
              key={i}
              titleInput={<Input className="font-medium" placeholder="Section title" defaultValue={sec.title || ''} onChange={(e) => { customs[i].title = e.target.value; scheduleSave(); }} {...EDITABLE_TEXT_ATTRS} />}
              onDelete={() => { deleteProfileItem(profile, 'customSections', i); refresh(); }}
            >
              <Textarea rows={3} placeholder="Content..." defaultValue={stripEmphasis(sec.content)} onChange={(e) => { customs[i].content = e.target.value; scheduleSave(); }} {...EDITABLE_TEXT_ATTRS} />
            </EntryCard>
          ))}
          <AddButton onClick={() => { addProfileItem(profile, 'customSections'); refresh(); }}>Add custom section</AddButton>
        </div>
      </section>
    </div>
  );
}

const TAB_COMPONENTS = {
  contact: ContactTab,
  summary: SummaryTab,
  experience: ExperienceTab,
  skills: SkillsTab,
  education: EducationTab,
  projects: ProjectsTab,
  more: MoreTab,
};

export function ProfileTabContent({ tab, ...props }) {
  const Component = TAB_COMPONENTS[tab] || ContactTab;
  return <Component {...props} />;
}
