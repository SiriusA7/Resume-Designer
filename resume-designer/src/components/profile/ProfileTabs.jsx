import { Globe, Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { shouldSpellcheck } from '../../spellcheck.js';
import { groupExperience } from '../../experienceGroups.js';
import { generateId } from '../../store.js';

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

// Profile fields are plain-text inputs, but AI-extracted content can carry markdown
// emphasis markers (**bold**, _italic_). Strip them on display so the Profile shows
// clean text instead of raw symbols — emphasis belongs in the generated resume (the
// renderer applies it there), not in this input surface. Mirrors the renderer's bold
// + italic patterns so only genuine emphasis is removed (mid-word underscores like
// my_var stay intact).
function stripEmphasis(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s([{"'`])_([^_\n]+)_(?=$|[\s)\]}"'`.,!?;:])/g, '$1$2');
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
function Field({ id, label, icon, type = 'text', value, placeholder, onCommit }) {
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
      />
    </div>
  );
}

// A labeled, uncontrolled textarea with a muted hint (Summary-tab idiom).
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
          <Field id="profile-fullName" label="Full name" value={c.fullName} placeholder="e.g. John Smith" onCommit={set('fullName')} />
          <Field id="profile-email" label="Email" type="email" value={c.email} placeholder="e.g. john@example.com" onCommit={set('email')} />
          <Field id="profile-phone" label="Phone" type="tel" value={c.phone} placeholder="e.g. (555) 123-4567" onCommit={set('phone')} />
          <Field id="profile-location" label="Location" value={c.location} placeholder="e.g. San Francisco, CA" onCommit={set('location')} />
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

function ExperienceTab({ profile, scheduleSave, refresh }) {
  const items = profile.workExperience;
  const set = (i, field) => (v) => { items[i][field] = v; scheduleSave(); };
  return (
    <section>
      <SectionHeader
        title="Detailed work experience"
        description="Add details beyond what's on your resume - challenges faced, technologies used, team size, impact metrics, lessons learned."
      />
      <ItemList
        items={items}
        emptyTitle="No experience entries yet"
        emptySubtitle="Add detailed information about your work history"
        addLabel="Add experience entry"
        onAdd={() => { items.push({ id: generateId('exp'), title: '', company: '', dates: '', details: '' }); refresh(); }}
        onDelete={(i) => { items.splice(i, 1); refresh(); }}
        renderTitle={(exp, i) => (
          <Input className="font-medium" placeholder="Job title" defaultValue={exp.title || ''} onChange={(e) => set(i, 'title')(e.target.value)} />
        )}
        renderBody={(exp, i) => {
          const groups = groupExperience(items);
          const group = groups.find((g) => g.roles.some((r) => r.index === i));
          const isRunMember = !!group && group.roles.length > 1;
          const isLead = isRunMember && group.roles[0].index === i;
          // First member of its own group, run of one included: the entry that
          // can gain a second role in place.
          const isGroupStart = !!group && group.roles[0].index === i;
          const prev = i > 0 ? items[i - 1] : null;
          const canLinkAbove = !!prev && !!prev.company && prev.company === exp.company;
          const rewrite = (next) => { items.splice(0, items.length, ...next); refresh(); };
          return (
            <>
              <Input placeholder="Company" defaultValue={exp.company || ''} onChange={(e) => set(i, 'company')(e.target.value)} onBlur={refresh} />
              <Input placeholder="Dates (e.g., Jan 2020 - Present)" defaultValue={exp.dates || ''} onChange={(e) => set(i, 'dates')(e.target.value)} />
              <Textarea
                rows={4}
                placeholder="Describe this role in detail: what did you accomplish? What challenges did you overcome? What technologies did you use? What was your team like?"
                defaultValue={stripEmphasis(exp.details)}
                onChange={(e) => set(i, 'details')(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
                {isRunMember && (
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {isLead ? `${group.company} · ${group.roles.length} positions` : 'Same company as above'}
                  </span>
                )}
                {isGroupStart && (
                  <Button
                    variant="outline" size="sm" type="button" className="h-7 text-xs"
                    onClick={() => {
                      // The only other add action appends to the END of the list, so
                      // without this a grouped employer followed by another employer
                      // can never gain a position: the new entry lands non-adjacent
                      // and "Link to company above" can only reach the last employer.
                      // Walk the CURRENT items at click time — the company input is
                      // uncontrolled and writes through, so a render-time bound can
                      // point past a boundary the user just typed into existence.
                      const id = exp._groupId || generateId('grp');
                      const company = exp.company || '';
                      let last = i;
                      if (exp._groupId && company) {
                        while (last + 1 < items.length) {
                          const entry = items[last + 1];
                          if (!entry || entry._groupId !== exp._groupId || entry.company !== company) break;
                          last += 1;
                        }
                      }
                      const next = [...items];
                      if (!next[i]._groupId) next[i] = { ...next[i], _groupId: id };
                      next.splice(last + 1, 0, {
                        id: generateId('exp'),
                        title: '',
                        company,
                        dates: '',
                        details: '',
                        _groupId: id,
                      });
                      rewrite(next);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add role at this company
                  </Button>
                )}
                {/* A run LEAD has no run member above it, so separating it is a pure
                    no-op that still costs an undo entry — offer it the link action. */}
                {isRunMember && !isLead ? (
                  <Button
                    variant="outline" size="sm" type="button" className="h-7 text-xs"
                    onClick={() => {
                      const oldId = exp._groupId;
                      const freshId = generateId('grp');
                      const next = [...items];
                      next[i] = { ...next[i], _groupId: freshId };
                      // Trailing members of the SAME run follow the detached entry, so
                      // separating the middle role of a 3-role run yields [A] + [B,C]
                      // rather than orphaning C too.
                      for (let k = i + 1; k < next.length; k += 1) {
                        const entry = next[k];
                        if (!oldId || entry._groupId !== oldId || entry.company !== exp.company) break;
                        next[k] = { ...entry, _groupId: freshId };
                      }
                      rewrite(next);
                    }}
                  >
                    Separate from company above
                  </Button>
                ) : i > 0 ? (
                  <Button
                    variant="outline" size="sm" type="button" className="h-7 text-xs"
                    disabled={!canLinkAbove}
                    title={canLinkAbove ? undefined : 'Only available when the entry above has the same company'}
                    onClick={() => {
                      // Read the CURRENT items at click time: the company input is
                      // uncontrolled and writes through, so a render-time neighbour
                      // check can be stale. Never write `company` here.
                      const cur = items[i];
                      const above = items[i - 1];
                      if (!cur || !above || !above.company || above.company !== cur.company) return;
                      const id = above._groupId || generateId('grp');
                      const oldId = cur._groupId;
                      const next = [...items];
                      next[i - 1] = { ...above, _groupId: id };
                      next[i] = { ...cur, _groupId: id };
                      // The clicked entry may itself be the LEAD of a run: its
                      // trailing members come with it, rather than being ejected
                      // into an orphaned singleton on the old id.
                      for (let k = i + 1; k < next.length; k += 1) {
                        const entry = next[k];
                        if (!oldId || entry._groupId !== oldId || entry.company !== cur.company) break;
                        next[k] = { ...entry, _groupId: id };
                      }
                      rewrite(next);
                    }}
                  >
                    Link to company above
                  </Button>
                ) : null}
              </div>
            </>
          );
        }}
      />
    </section>
  );
}

const PROFICIENCY_OPTIONS = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'expert', label: 'Expert' },
];

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
                <Input className="flex-1" placeholder="Skill name" defaultValue={skill.name || ''} onChange={(e) => set(i, 'name')(e.target.value)} />
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
                  onClick={() => { skills.splice(i, 1); refresh(); }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
          <AddButton onClick={() => { skills.push({ name: '', proficiency: '', years: '' }); refresh(); }}>Add skill</AddButton>
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
        onAdd={() => { items.push({ degree: '', institution: '', dates: '', details: '' }); refresh(); }}
        onDelete={(i) => { items.splice(i, 1); refresh(); }}
        renderTitle={(edu, i) => (
          <Input className="font-medium" placeholder="Degree / program" defaultValue={edu.degree || ''} onChange={(e) => set(i, 'degree')(e.target.value)} />
        )}
        renderBody={(edu, i) => (
          <>
            <Input placeholder="Institution" defaultValue={edu.institution || ''} onChange={(e) => set(i, 'institution')(e.target.value)} />
            <Input placeholder="Dates / year" defaultValue={edu.dates || ''} onChange={(e) => set(i, 'dates')(e.target.value)} />
            <Textarea
              rows={3}
              placeholder="Notable courses, projects, thesis, honors, activities, GPA if relevant..."
              defaultValue={stripEmphasis(edu.details)}
              onChange={(e) => set(i, 'details')(e.target.value)}
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
        onAdd={() => { items.push({ name: '', url: '', description: '' }); refresh(); }}
        onDelete={(i) => { items.splice(i, 1); refresh(); }}
        renderTitle={(proj, i) => (
          <Input className="font-medium" placeholder="Project name" defaultValue={proj.name || ''} onChange={(e) => set(i, 'name')(e.target.value)} />
        )}
        renderBody={(proj, i) => (
          <>
            <Input placeholder="URL (optional)" defaultValue={proj.url || ''} onChange={(e) => set(i, 'url')(e.target.value)} spellCheck={shouldSpellcheck('url')} />
            <Textarea
              rows={4}
              placeholder="Describe the project: what problem does it solve? What technologies did you use? What was your role? What was the outcome?"
              defaultValue={stripEmphasis(proj.description)}
              onChange={(e) => set(i, 'description')(e.target.value)}
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
            <CompactRow key={i} onDelete={() => { certs.splice(i, 1); refresh(); }}>
              <Input className="flex-1" placeholder="Certification name" defaultValue={cert.name || ''} onChange={(e) => { certs[i].name = e.target.value; scheduleSave(); }} />
              <Input className="w-24" placeholder="Year" defaultValue={cert.year || ''} onChange={(e) => { certs[i].year = e.target.value; scheduleSave(); }} />
            </CompactRow>
          ))}
          <AddButton onClick={() => { certs.push({ name: '', year: '' }); refresh(); }}>Add certification</AddButton>
        </div>
      </section>

      <section>
        <SectionHeader title="Achievements & awards" description="Notable accomplishments, recognition, awards." />
        <div className="space-y-2">
          {achs.length === 0 ? (
            <Empty title="No achievements added" />
          ) : achs.map((ach, i) => (
            <CompactRow key={i} onDelete={() => { achs.splice(i, 1); refresh(); }}>
              <Input className="flex-1" placeholder="Achievement description" defaultValue={ach.description || ''} onChange={(e) => { achs[i].description = e.target.value; scheduleSave(); }} />
            </CompactRow>
          ))}
          <AddButton onClick={() => { achs.push({ description: '' }); refresh(); }}>Add achievement</AddButton>
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
              titleInput={<Input className="font-medium" placeholder="Section title" defaultValue={sec.title || ''} onChange={(e) => { customs[i].title = e.target.value; scheduleSave(); }} />}
              onDelete={() => { customs.splice(i, 1); refresh(); }}
            >
              <Textarea rows={3} placeholder="Content..." defaultValue={stripEmphasis(sec.content)} onChange={(e) => { customs[i].content = e.target.value; scheduleSave(); }} />
            </EntryCard>
          ))}
          <AddButton onClick={() => { customs.push({ title: '', content: '' }); refresh(); }}>Add custom section</AddButton>
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
