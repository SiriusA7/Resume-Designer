/**
 * The Profile screen's seam with the native iOS sheet.
 *
 * Shaped like designController.js — one implementation the web dialog and the
 * bridge both call, because a second one written in Swift is how the two drift.
 * Everything the web dialog composed inside a React handler with no callable
 * entry point (the blank-record shapes, the `_groupId` run edits, the markdown
 * import) lives here now, and ProfileTabs/ProfileDialog call these.
 *
 * **There is no working copy on this side, deliberately.** The web dialog edits
 * a deep clone held in a ref and debounce-saves it 500ms later, which is what
 * keeps its uncontrolled inputs caret-stable. A native sheet cannot share that
 * ref, and a SECOND working copy would be the bug the whole file exists to
 * avoid: `buildWorkingCopy()` runs only on `rd:open-profile`, so a copy taken
 * once and written back later would save a pre-interview profile over the merge
 * `aiService.js` made while the sheet was open. So every action here reads the
 * stored profile, edits it, and writes it back; the projection reads it again.
 * The sheet renders what actually landed, which is the same rule the Settings
 * and Design sheets follow.
 *
 * Writing through on every keystroke rather than debouncing is what makes the
 * `flushPendingProfileSave()` contract (src/userProfilePanel.js) hold by
 * construction: backupFlow.js and AccountSection read that answer synchronously
 * to decide whether a backup/switch is safe, and nothing is ever sitting in a
 * timer here to be lost. The one case that still has to be reported is a write
 * that FAILED — see `saveFailed` and `ensureFlushListener`.
 */

import { getUserProfile, saveUserProfile } from './persistence.js';
import { currentWriteSequence, onWriteFailure, onWriteSettled } from './appStorage.js';
import { DEFAULT_PROFILE, markdownToProfile } from './profileMarkdown.js';
import { assignGroupIds, companyKey, groupExperience } from './experienceGroups.js';
import { buildDateFields, freeformDateFields, readEntryDates } from './experienceDates.js';
import { getByPath, setByPath } from './diffEngine.js';
import { userProfileAdoptions } from './userProfileHolder.js';
import { generateId } from './store.js';
import { profileCompleteness } from './accountStats.js';

// The profile lives inside the data blob, so that is the key whose write
// failing means the profile did not save.
const PROFILE_STORAGE_KEY = 'resume-designer-data';
/** Fired when `saveFailed` changes without any DOM change to notice. */
export const PROFILE_STATE_CHANGED_EVENT = 'rd:profile-state-changed';

// ---------------------------------------------------------------------------
// Shared with the web dialog
// ---------------------------------------------------------------------------

/** Every array-valued key of a profile, in the order the editor shows them. */
const LIST_KEYS = [
  'workExperience', 'skills', 'education', 'projects',
  'certifications', 'achievements', 'customSections',
];

/**
 * The blank record each list adds. Kept in JS so Swift never learns a record's
 * shape — it sends a list name it was handed and gets back a row.
 */
const BLANK_ITEMS = {
  workExperience: () => ({ id: generateId('exp'), title: '', company: '', dates: '', details: '' }),
  skills: () => ({ name: '', proficiency: '', years: '' }),
  education: () => ({ degree: '', institution: '', dates: '', details: '' }),
  projects: () => ({ name: '', url: '', description: '' }),
  certifications: () => ({ name: '', year: '' }),
  achievements: () => ({ description: '' }),
  customSections: () => ({ title: '', content: '' }),
};

/**
 * The one identifying field of a row, per list.
 *
 * Only `workExperience` carries a real `id`; the other six lists are keyed by
 * array position in React and have nothing else. So the projection ships each
 * row's own primary text as its identity and every destructive action echoes it
 * back, the way `restoreVersion` echoes a version's timestamp (main.js) — a
 * delete that lands on a renumbered list refuses instead of removing a
 * different record. It cannot refuse a legitimate delete: the key travelled out
 * in the same snapshot the row was rendered from.
 */
const ITEM_KEYS = {
  workExperience: (item) => text(item?.id),
  skills: (item) => text(item?.name),
  education: (item) => text(item?.degree),
  projects: (item) => text(item?.name),
  certifications: (item) => text(item?.name),
  achievements: (item) => text(item?.description),
  customSections: (item) => text(item?.title),
};

export const PROFICIENCY_OPTIONS = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'expert', label: 'Expert' },
];

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * A deep, shape-complete clone of a stored profile: every key and every list
 * exists, so nothing downstream has to null-check its way through.
 *
 * The defaults are CLONED, not spread. `{ ...DEFAULT_PROFILE }` hands back the
 * module constant's own arrays for any list the source omits, and the first
 * `push` onto one of those would extend DEFAULT_PROFILE for the rest of the
 * session — the same aliasing markdownToProfile already guards against.
 */
export function completeProfile(source) {
  const cloned = source && typeof source === 'object' ? JSON.parse(JSON.stringify(source)) : {};
  const profile = {
    ...structuredClone(DEFAULT_PROFILE),
    ...cloned,
    contactInfo: { ...DEFAULT_PROFILE.contactInfo, ...(cloned.contactInfo || {}) },
  };
  // A stored profile whose list was written as null/undefined by an older build
  // would otherwise crash the projection rather than render as empty.
  for (const key of LIST_KEYS) {
    if (!Array.isArray(profile[key])) profile[key] = [];
  }
  return profile;
}

/**
 * Strip markdown emphasis for DISPLAY only.
 *
 * Profile fields are plain-text inputs, but AI-extracted content carries
 * `**bold**` / `_italic_` markers — emphasis belongs in the generated résumé,
 * where the renderer applies it, not in an input surface showing raw symbols.
 * Mirrors the renderer's bold + italic patterns so only genuine emphasis is
 * removed (mid-word underscores like my_var stay intact).
 */
export function stripEmphasis(value) {
  if (!value) return '';
  return String(value)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s([{"'`])_([^_\n]+)_(?=$|[\s)\]}"'`.,!?;:])/g, '$1$2');
}

/** Append a blank record to one of the profile's lists. Returns it, or null. */
export function addProfileItem(profile, listPath) {
  const make = BLANK_ITEMS[listPath];
  if (!make || !Array.isArray(profile?.[listPath])) return null;
  const item = make();
  profile[listPath].push(item);
  return item;
}

/** Remove one row. Returns whether it was there. */
export function deleteProfileItem(profile, listPath, index) {
  const list = profile?.[listPath];
  if (!Array.isArray(list) || !list[index]) return false;
  list.splice(index, 1);
  return true;
}

/**
 * Splice a new role in after the run's LAST member, carrying the run's id and
 * company. Returns the next array, or null when there is nothing to add to.
 *
 * Walks `items` as given rather than a pre-computed group: the web's company
 * input is uncontrolled, so a render-time bound can point past a boundary just
 * typed into existence.
 */
export function addRoleAt(items, leadIndex) {
  const lead = items?.[leadIndex];
  if (!lead) return null;
  const company = companyKey(lead.company);
  if (!company) return null;
  const id = lead._groupId || generateId('grp');
  let last = leadIndex;
  if (lead._groupId) {
    while (last + 1 < items.length) {
      const entry = items[last + 1];
      if (!entry || entry._groupId !== lead._groupId || companyKey(entry.company) !== company) break;
      last += 1;
    }
  }
  const next = [...items];
  if (!next[leadIndex]._groupId) next[leadIndex] = { ...next[leadIndex], _groupId: id };
  next.splice(last + 1, 0, {
    id: generateId('exp'), title: '', company: lead.company, dates: '', details: '', _groupId: id,
  });
  return next;
}

/**
 * Detach a role into its own employer. Trailing members of the SAME run follow
 * it, so detaching the middle role of a 3-role block yields [A] + [B,C] rather
 * than orphaning C.
 */
export function detachRole(items, index) {
  const cur = items?.[index];
  if (!cur) return null;
  const oldId = cur._groupId;
  const freshId = generateId('grp');
  const next = [...items];
  next[index] = { ...next[index], _groupId: freshId };
  for (let k = index + 1; k < next.length; k += 1) {
    const entry = next[k];
    if (!oldId || entry._groupId !== oldId || companyKey(entry.company) !== companyKey(cur.company)) break;
    next[k] = { ...entry, _groupId: freshId };
  }
  return next;
}

/**
 * Merge this entry into the employer above. Never writes `company` — copying a
 * neighbour's name is how a role gets filed under an employer the user never
 * worked for. The clicked entry's trailing run members come with it.
 */
export function linkAbove(items, index) {
  const cur = items?.[index];
  const above = items?.[index - 1];
  if (!cur || !above) return null;
  if (!companyKey(above.company) || companyKey(above.company) !== companyKey(cur.company)) return null;
  const id = above._groupId || generateId('grp');
  const oldId = cur._groupId;
  const next = [...items];
  next[index - 1] = { ...above, _groupId: id };
  next[index] = { ...cur, _groupId: id };
  for (let k = index + 1; k < next.length; k += 1) {
    const entry = next[k];
    if (!oldId || entry._groupId !== oldId || companyKey(entry.company) !== companyKey(cur.company)) break;
    next[k] = { ...entry, _groupId: id };
  }
  return next;
}

/**
 * One employer name across every role in the run.
 *
 * Takes the INDICES rather than re-deriving the run, and both callers hand over
 * the ones they were shown. Re-deriving mid-edit is the trap: `groupExperience`
 * needs a non-empty company to join, so a name cleared on the way to being
 * retyped is no longer a run, and the next write would land on the lead alone
 * and leave its colleagues behind under the old employer.
 *
 * Mutates in place, like the web's other field writes — the inputs are
 * uncontrolled, so no re-render is needed per keystroke, and the run rule stays
 * satisfied because every member changes together.
 */
export function setRunCompany(items, indices, value) {
  for (const index of indices) {
    if (items?.[index]) items[index].company = value;
  }
}

/** Remove several rows at once, descending so earlier removals cannot shift the rest. */
export function removeEntries(items, indices) {
  const next = [...(items || [])];
  for (const index of [...indices].sort((a, b) => b - a)) next.splice(index, 1);
  return next;
}

/**
 * Parse an imported markdown profile and say whether the grouping question is
 * worth asking.
 *
 * `grouped` is the same entries with one `_groupId` per run of repeated
 * employers; `runCount` is how many employers that would fold together, which
 * is 0 for most profiles and is the only case where the user has a decision to
 * make.
 */
export function parseProfileImport(markdown) {
  const imported = markdownToProfile(String(markdown ?? ''));
  const entries = Array.isArray(imported?.workExperience) ? imported.workExperience : [];
  const grouped = assignGroupIds(entries);
  const runCount = groupExperience(grouped).filter((g) => g.roles.length > 1).length;
  return { imported, grouped, runCount };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * One editable field.
 *
 * `path` is minted here and only ever echoed back, exactly as
 * `buildDocumentOutline` does it: Swift renders a generic form and has no way
 * to CONSTRUCT a path, which is what keeps the grammar from getting a second
 * implementation.
 *
 * `kind` is the control, `keyboard` the keys it offers, `prose` whether this is
 * résumé content. The three are independent: an email field is single-line,
 * gets the email keyboard, and keeps normal autocorrect, while a job title is
 * single-line, gets the default keyboard, and must have autocorrect OFF —
 * `EDITABLE_TEXT_ATTRS` exists because WebKit's text substitution silently
 * rewrites `**bold**` with no undo, and `.autocorrectionDisabled()` is the same
 * decision on the native side.
 */
function field(path, label, value, spec = {}) {
  const kind = spec.kind || 'text';
  return {
    path,
    label,
    // Shown under the control. Empty for most fields; the Summary tab's three
    // questions are useless without theirs.
    hint: spec.hint || '',
    placeholder: spec.placeholder || '',
    // Multiline fields hold prose the AI wrote, so they are shown through the
    // same strip the web textareas use — otherwise the sheet displays literal
    // `**bold**`. Nothing writes the stripped value back on its own: a write
    // only happens when the user types.
    value: kind === 'multiline' ? stripEmphasis(value) : text(value),
    kind,
    keyboard: spec.keyboard || 'default',
    prose: !!spec.prose,
    options: spec.options || [],
  };
}

function group(id, title, footer, fields) {
  return {
    id, title, footer, fields, listPath: '', addLabel: '', emptyLabel: '', items: [],
  };
}

/** A group whose rows come from one of the profile's arrays. */
function listGroup(id, title, footer, listPath, list, options) {
  return {
    id,
    title,
    footer,
    // Fields ABOVE the list (none today, but the shape has to be uniform: Swift
    // decodes one struct and a missing key fails the whole decode).
    fields: [],
    listPath,
    addLabel: options.addLabel,
    emptyLabel: options.emptyLabel,
    items: list.map((item, index) => ({
      key: ITEM_KEYS[listPath](item),
      index,
      fields: options.fields(item, index),
    })),
  };
}

function section(id, title, badge, groups) {
  return { id, title, badge, kind: 'form', listPath: '', groups, employers: [] };
}

function countLabel(count, one, many) {
  if (count === 0) return 'None';
  return `${count} ${count === 1 ? one : many}`;
}

function contactSection(profile) {
  const c = profile.contactInfo;
  const basics = [
    field('contactInfo.fullName', 'Full name', c.fullName, { placeholder: 'John Smith', prose: true }),
    field('contactInfo.email', 'Email', c.email, { placeholder: 'john@example.com', keyboard: 'email' }),
    field('contactInfo.phone', 'Phone', c.phone, { placeholder: '(555) 123-4567', keyboard: 'phone' }),
    field('contactInfo.location', 'Location', c.location, { placeholder: 'San Francisco, CA', prose: true }),
  ];
  const online = [
    field('contactInfo.linkedin', 'LinkedIn', c.linkedin, { placeholder: 'linkedin.com/in/johnsmith', keyboard: 'url' }),
    field('contactInfo.portfolio', 'Portfolio / website', c.portfolio, { placeholder: 'johnsmith.com', keyboard: 'url' }),
    field('contactInfo.github', 'GitHub', c.github, { placeholder: 'github.com/johnsmith', keyboard: 'url' }),
    field('contactInfo.twitter', 'Twitter / X', c.twitter, { placeholder: 'twitter.com/johnsmith', keyboard: 'url' }),
    field('contactInfo.instagram', 'Instagram', c.instagram, { placeholder: 'instagram.com/johnsmith', keyboard: 'url' }),
  ];
  const filled = [...basics, ...online].filter((f) => f.value.trim()).length;
  return section('contact', 'Contact', `${filled} of ${basics.length + online.length}`, [
    group('contact-basics', 'Basic information', 'Your name and contact details for resumes', basics),
    group('contact-online', 'Online presence', 'Links to your professional profiles and portfolio', online),
  ]);
}

function summarySection(profile) {
  const fields = [
    field('personalSummary', 'Personal summary', profile.personalSummary, {
      kind: 'multiline',
      prose: true,
      hint: 'Tell the AI who you are professionally. What makes you unique?',
      placeholder: 'A UX designer with 8 years in fintech and healthcare…',
    }),
    field('careerGoals', 'Career goals', profile.careerGoals, {
      kind: 'multiline',
      prose: true,
      hint: 'What are you looking for? What roles interest you?',
      placeholder: 'Seeking a senior or lead role on AI products…',
    }),
    field('preferences', 'Preferences', profile.preferences, {
      kind: 'multiline',
      prose: true,
      hint: 'Work style, industries, salary expectations, location.',
      placeholder: 'Remote-first, Series B+ startups, open to contract…',
    }),
  ];
  const filled = fields.filter((f) => f.value.trim()).length;
  return section('summary', 'Summary', `${filled} of ${fields.length}`, [
    group('summary-prose', '', 'Background the AI reads before it writes anything for you.', fields),
  ]);
}

/**
 * The dates an entry actually holds, read ONLY through `readEntryDates` — the
 * machine-readable pair, never the display string. Recovering structure from
 * prose is what the strict/lenient split in experienceGroups.js exists to
 * prevent, and a wrong guess here would be persisted by the next commit.
 *
 * A zero year or month means "nothing selected"; the picker's own range starts
 * at 1900, so no real value collides with it.
 */
function roleDates(entry) {
  const read = readEntryDates(entry);
  return {
    display: text(entry?.dates),
    startYear: read.start ? read.start.year : 0,
    startMonth: read.start ? read.start.month : 0,
    endYear: read.end ? read.end.year : 0,
    endMonth: read.end ? read.end.month : 0,
    ongoing: read.ongoing,
    // No readable pair, so the picker opens with nothing selected and offers
    // the existing text for editing instead.
    freeform: read.freeform,
  };
}

/**
 * The experience section: one block per employer run, its roles beneath.
 *
 * The runs come from `groupExperience` and nothing here re-derives them — the
 * run rule is one implementation on purpose (see experienceGroups.js), and the
 * editor and the printed résumé agreeing about what an employer IS depends on
 * both asking the same function.
 */
function experienceSection(profile) {
  const items = profile.workExperience;
  const employers = groupExperience(items).map((run) => {
    const lead = run.roles[0];
    const i = lead.index;
    const prev = i > 0 ? items[i - 1] : null;
    return {
      id: ITEM_KEYS.workExperience(lead.entry) || `row-${i}`,
      // The RAW company, not `run.company`: that one is trimmed for the run
      // rule, and a field that silently eats the space you just typed is a
      // field you cannot type a two-word employer into.
      company: text(lead.entry.company),
      leadIndex: i,
      leadKey: ITEM_KEYS.workExperience(lead.entry),
      // A role can only be added to a named employer — the run rule needs a
      // non-empty company, so an unnamed one would produce two solo cards.
      canAddRole: !!companyKey(lead.entry.company),
      canLinkAbove: !!prev
        && !!companyKey(prev.company)
        && companyKey(prev.company) === companyKey(lead.entry.company),
      showLinkAbove: i > 0,
      roles: run.roles.map((role, position) => ({
        index: role.index,
        key: ITEM_KEYS.workExperience(role.entry),
        title: text(role.entry.title),
        // The run's lead has nothing above it to detach FROM.
        canDetach: position > 0,
        dates: roleDates(role.entry),
        fields: [
          field(`workExperience[${role.index}].title`, 'Job title', role.entry.title, {
            placeholder: 'Job title', prose: true,
          }),
          field(`workExperience[${role.index}].details`, 'Details', role.entry.details, {
            kind: 'multiline',
            prose: true,
            placeholder: 'What did you accomplish? Technologies, team size, impact, lessons.',
          }),
        ],
      })),
    };
  });

  return {
    id: 'experience',
    title: 'Experience',
    badge: countLabel(items.length, 'role', 'roles'),
    kind: 'experience',
    // The array a new entry is appended to and a role is deleted from. Named
    // here rather than spelled out in Swift for the same reason paths are:
    // Swift echoes identifiers it was handed and constructs none.
    listPath: 'workExperience',
    groups: [],
    employers,
  };
}

function skillsSection(profile) {
  return section('skills', 'Skills', countLabel(profile.skills.length, 'skill', 'skills'), [
    listGroup(
      'skills', 'Skills inventory',
      'Everything you can do, with how good you are at it and for how long.',
      'skills', profile.skills,
      {
        addLabel: 'Add skill',
        emptyLabel: 'No skills yet',
        fields: (skill, i) => [
          field(`skills[${i}].name`, 'Skill', skill.name, { placeholder: 'Skill name', prose: true }),
          field(`skills[${i}].proficiency`, 'Proficiency', skill.proficiency, {
            kind: 'choice', options: PROFICIENCY_OPTIONS,
          }),
          field(`skills[${i}].years`, 'Years', skill.years, { placeholder: 'Years', keyboard: 'number' }),
        ],
      },
    ),
    group('skills-industry', 'Industry knowledge', '', [
      field('industryKnowledge', 'Industry knowledge', profile.industryKnowledge, {
        kind: 'multiline',
        prose: true,
        hint: 'Domains you have worked in, tools mastered, methodologies you follow.',
        placeholder: 'E-commerce and SaaS, Agile/Scrum, WCAG 2.1…',
      }),
    ]),
  ]);
}

function educationSection(profile) {
  return section('education', 'Education', countLabel(profile.education.length, 'entry', 'entries'), [
    listGroup(
      'education', 'Education details',
      'Courses, projects, thesis topics, honours — details beyond a typical résumé.',
      'education', profile.education,
      {
        addLabel: 'Add education entry',
        emptyLabel: 'No education entries yet',
        fields: (edu, i) => [
          field(`education[${i}].degree`, 'Degree / program', edu.degree, { placeholder: 'Degree / program', prose: true }),
          field(`education[${i}].institution`, 'Institution', edu.institution, { placeholder: 'Institution', prose: true }),
          field(`education[${i}].dates`, 'Dates / year', edu.dates, { placeholder: '2016 – 2020' }),
          field(`education[${i}].details`, 'Details', edu.details, {
            kind: 'multiline', prose: true, placeholder: 'Notable courses, thesis, honours, activities.',
          }),
        ],
      },
    ),
  ]);
}

function projectsSection(profile) {
  return section('projects', 'Projects', countLabel(profile.projects.length, 'project', 'projects'), [
    listGroup(
      'projects', 'Portfolio & projects',
      'Personal projects, open source, side work — anything that shows what you can do.',
      'projects', profile.projects,
      {
        addLabel: 'Add project',
        emptyLabel: 'No projects yet',
        fields: (proj, i) => [
          field(`projects[${i}].name`, 'Project', proj.name, { placeholder: 'Project name', prose: true }),
          // A URL keeps normal autocorrect off by KIND, not by `prose`: it is
          // not résumé prose, it is an identifier, and the web marks it the
          // same way through shouldSpellcheck('url').
          field(`projects[${i}].url`, 'URL', proj.url, { placeholder: 'https://…', keyboard: 'url' }),
          field(`projects[${i}].description`, 'Description', proj.description, {
            kind: 'multiline', prose: true, placeholder: 'What problem does it solve? Your role? The outcome?',
          }),
        ],
      },
    ),
  ]);
}

function moreSection(profile) {
  const count = profile.certifications.length + profile.achievements.length
    + profile.customSections.length;
  return section('more', 'More', countLabel(count, 'entry', 'entries'), [
    listGroup(
      'certifications', 'Certifications & training',
      'Professional certifications, courses, training programs.',
      'certifications', profile.certifications,
      {
        addLabel: 'Add certification',
        emptyLabel: 'No certifications yet',
        fields: (cert, i) => [
          field(`certifications[${i}].name`, 'Certification', cert.name, { placeholder: 'Certification name', prose: true }),
          field(`certifications[${i}].year`, 'Year', cert.year, { placeholder: 'Year', keyboard: 'number' }),
        ],
      },
    ),
    listGroup(
      'achievements', 'Achievements & awards',
      'Notable accomplishments, recognition, awards.',
      'achievements', profile.achievements,
      {
        addLabel: 'Add achievement',
        emptyLabel: 'No achievements yet',
        fields: (ach, i) => [
          field(`achievements[${i}].description`, 'Achievement', ach.description, {
            placeholder: 'What you did, and why it mattered', prose: true,
          }),
        ],
      },
    ),
    listGroup(
      'customSections', 'Custom sections',
      'Anything else you want the AI to know about.',
      'customSections', profile.customSections,
      {
        addLabel: 'Add custom section',
        emptyLabel: 'No custom sections yet',
        fields: (sec, i) => [
          field(`customSections[${i}].title`, 'Title', sec.title, { placeholder: 'Section title', prose: true }),
          field(`customSections[${i}].content`, 'Content', sec.content, {
            kind: 'multiline', prose: true, placeholder: 'Content…',
          }),
        ],
      },
    ),
  ]);
}

/**
 * Everything the native Profile sheet renders. Pure over what it is handed.
 *
 * Coerced rather than trusted, for the reason `buildDesign` documents: Swift
 * decodes this into ONE Codable struct, so a null where it expects a String
 * fails the whole decode and blanks the entire sheet rather than one row.
 *
 * @param {{profile: object, saveFailed?: boolean, pendingImport?: object|null}} state
 */
export function buildProfile(state) {
  const source = state && typeof state === 'object' ? state : {};
  const profile = completeProfile(source.profile);
  const pending = source.pendingImport;
  return {
    completeness: profileCompleteness(profile).pct,
    // A quota failure means the write did NOT land. The web reports it as a
    // toast rendered in the canvas — invisible under a native sheet — so it
    // crosses as state instead and the sheet says so in a banner. Swallowing it
    // leaves the user typing into a void and losing everything on a switch.
    saveFailed: !!source.saveFailed,
    // WHICH profile these rows are, so a positional write made from a control
    // that holds no focus — a picker's menu — can say which one it was drawn
    // from. See `requireCurrentProfile`.
    revision: userProfileAdoptions(),
    // A parsed import waiting on the grouping question. It cannot be asked with
    // `confirmDestructive()`: that renders a Radix AlertDialog INSIDE the
    // webview, behind the sheet, where the promise would never settle.
    pendingImport: pending ? { runCount: Number(pending.runCount) || 0 } : null,
    sections: [
      contactSection(profile),
      summarySection(profile),
      experienceSection(profile),
      skillsSection(profile),
      educationSection(profile),
      projectsSection(profile),
      moreSection(profile),
    ],
  };
}

// ---------------------------------------------------------------------------
// The write side
// ---------------------------------------------------------------------------

// The last write's durability, and the profile it failed to write. `false`
// here is the difference between "your edits are on disk" and "you are typing
// into a void", so it is both projected to the sheet and reported to the flush.
let saveFailed = false;
let unsavedProfile = null;

// A parsed markdown import held between the file being read and the user
// answering the grouping question.
let pendingImport = null;

let flushListenerAttached = false;
// The last profile handed to storage, kept only to retry an async refusal, and
// the id of the write that carried it. The id is what makes the copy belong to
// a specific write rather than merely to a key — see `currentWriteSequence`.
let lastCommitted = null;
let lastCommittedSeq = 0;

/**
 * Answer `rd:profile-flush` when a native write failed.
 *
 * `flushPendingProfileSave()` (userProfilePanel.js) dispatches that event and
 * reads `detail.ok` synchronously; backupFlow.js and AccountSection abort a
 * backup or a profile switch on false, which is the only thing standing between
 * a failed write and edits reloaded away.
 *
 * Two details are load-bearing:
 *
 *  - It only ever writes `false`. ProfileDialog's own listener assigns
 *    `detail.ok = <its own result>` unconditionally, so a listener that also
 *    wrote `true` could raise the dialog's genuine failure back to success.
 *  - It attaches LAZILY, on the sheet's first read. ProfileDialog registers at
 *    mount, which is boot; the native sheet cannot be opened before then, so
 *    attaching here guarantees this runs second and its `false` is the answer
 *    the caller sees.
 */
function ensureFlushListener() {
  if (flushListenerAttached || typeof window === 'undefined') return;
  flushListenerAttached = true;
  // The disk refusing the profile key, reported asynchronously by the drain
  // that actually attempted it. Without this the sheet only ever heard about a
  // SYNCHRONOUS failure — the browser's localStorage quota throw — and on a
  // device, where the write is behind a cache, it heard nothing at all: the
  // banner never showed and the retry below never armed, while the person was
  // told their edits were saved.
  // The held copy stops being the last word once the disk has reached OR PASSED
  // the write that carried it. Kept past that, it would be promoted by somebody
  // else's later failure on the same key — the key is `resume-designer-data`,
  // which every resume save writes too — and the `rd:profile-flush` retry would
  // put this stale profile back over the newer one already on disk, losing
  // every field added since.
  //
  // Gated on the write id, NOT on the key alone. The drain reads its value when
  // the op's turn arrives and then awaits the disk, so a write already in
  // flight can land bytes OLDER than this copy. Cleared on that, the sheet's
  // own write — not yet even attempted — would be refused with nothing left to
  // promote: no banner, no retry, and a person told their edits were saved.
  onWriteSettled((logicalKey, seq) => {
    if (logicalKey !== PROFILE_STORAGE_KEY) return;
    if (seq < lastCommittedSeq) return; // an older write; says nothing about mine
    lastCommitted = null;
  });
  onWriteFailure((logicalKey, seq) => {
    if (logicalKey !== PROFILE_STORAGE_KEY) return;
    // Somebody else's earlier write failing says nothing about this copy, whose
    // own write has not been attempted yet. `>=` rather than `===` because the
    // drain coalesces: a later write to this key subsumes ours, so its refusal
    // is ours as well.
    if (seq < lastCommittedSeq) return;
    if (saveFailed) return; // already reported; the retry owns it now
    // Only now does the sheet have something true to say. Promoting the held
    // copy is what arms both the banner and the `rd:profile-flush` retry, which
    // reads `unsavedProfile`.
    if (!lastCommitted) return;
    saveFailed = true;
    unsavedProfile = lastCommitted;
    // The sheet reads `saveFailed` off the next snapshot, and nothing else
    // here would prompt one — a disk failure is not a DOM change.
    window.dispatchEvent(new CustomEvent(PROFILE_STATE_CHANGED_EVENT));
  });
  window.addEventListener('rd:profile-flush', (event) => {
    if (!saveFailed) return;
    // Retry: the failure discarded the write, and storage may have room now.
    // Nothing newer exists to clobber — every later edit read the same stored
    // profile this one failed to replace.
    const ok = saveUserProfile(unsavedProfile) !== false;
    saveFailed = !ok;
    if (ok) unsavedProfile = null;
    else if (event?.detail) event.detail.ok = false;
  });
}

/**
 * The profile every read and every edit starts from.
 *
 * Storage, except while a write is outstanding. A failed write leaves storage
 * holding the PRE-edit profile, so reading it again would quietly drop
 * everything typed since — the next edit would be built on the old profile, and
 * the flush's retry would then write back one keystroke instead of the whole
 * session. Keeping the copy that could not be written means the sheet goes on
 * showing the user's work while the banner says it is not on disk, and one
 * successful retry lands all of it.
 */
function current() {
  return unsavedProfile || getUserProfile();
}

/** Read the raw state the projection is built from. */
export function getProfileState() {
  ensureFlushListener();
  return {
    profile: current(),
    saveFailed,
    pendingImport: pendingImport ? { runCount: pendingImport.runCount } : null,
  };
}

/**
 * Refuse a positional write aimed at a profile that has since been replaced.
 *
 * The adoption COUNT rather than the `data:userProfile` event: an operation
 * that spans an adoption — a menu held open across one — has to ask whether it
 * happened while it was away, and a listener cannot answer that.
 */
function requireCurrentProfile(revision, path) {
  const seen = Number(revision);
  if (!Number.isInteger(seen)) return;
  if (seen !== userProfileAdoptions()) {
    throw new Error(`${path} was aimed at an older profile`);
  }
}

/** A shape-complete copy, safe to mutate. */
function read() {
  return completeProfile(current());
}

/** Write it back, remembering a failure so the sheet and the flush can report it. */
function commit(profile) {
  const ok = saveUserProfile(profile) !== false;
  saveFailed = !ok;
  unsavedProfile = ok ? null : profile;
  // Held for the ASYNC failure only. On Tauri the answer above is the cache
  // taking the value, not the disk; the drain can refuse it later, and the
  // retry then needs the copy that was refused.
  //
  // NOT used as a read source, and `unsavedProfile` is still cleared on
  // success. `current()` has to go on reading storage, because saving
  // NORMALISES — `saveUserProfile` merges over the default shape — so serving
  // the raw copy back would have every later edit build on an unnormalised
  // profile. An earlier draft of this retained it and the profileBridge suite
  // failed on exactly that.
  lastCommitted = ok ? profile : null;
  // Asked FOR THIS KEY, never as a global "last write". `setItem` is
  // re-entrant — it calls the sync stamper synchronously, which writes the sync
  // state key from inside it — so by the time `saveUserProfile` returns, the
  // most recently minted id belongs to that other key's write. Gating on it
  // rejected the profile write's own notification, and the sheet stopped
  // reporting its own refusals altogether.
  lastCommittedSeq = ok ? currentWriteSequence(PROFILE_STORAGE_KEY) : 0;
}

function toIndex(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

function toFlag(value) {
  return value === true || value === 'true';
}

/**
 * The row at `index`, provided it is still the one the sheet was showing.
 *
 * The check is the point: a delete renumbers everything after it, and a sheet
 * acting on the list it rendered a moment ago would otherwise address a
 * different record. Refusing comes back to Swift as a failed command, which is
 * what the "that row moved" alert is for.
 */
function requireItem(list, listPath, index, key) {
  const item = list[index];
  if (!item || ITEM_KEYS[listPath](item) !== text(key)) {
    throw new Error('that row moved — reopen the section and try again');
  }
  return item;
}

/** The indices of the whole employer run `leadIndex` belongs to. */
function runIndices(items, leadIndex) {
  const run = groupExperience(items).find((g) => g.roles.some((r) => r.index === leadIndex));
  return run ? run.roles.map((r) => r.index) : [];
}

/** `skills[2].years` → `skills[2]`; a top-level key → ''. */
function parentPath(path) {
  const match = path.match(/^(.*?)(?:\.[^.[\]]+|\[\d+\])$/);
  return match ? match[1] : '';
}

/** The picker's `{year, month}`, or null when either half is missing. */
function toMonthPair(year, month) {
  const y = Number.parseInt(String(year ?? ''), 10);
  const m = Number.parseInt(String(month ?? ''), 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || y < 1) return null;
  return { year: y, month: m };
}

function applyImport(profile) {
  pendingImport = null;
  commit(profile);
}

/**
 * Perform one action. Every value arrives as a string (the bridge's convention
 * — see `setZoom` and `setDesign`), so each case coerces its own.
 *
 * **The action's name is `action`, not `type`.** `type` belongs to the
 * dispatcher: `createCommandDispatcher` looks the handler up by it, and
 * `ShellModel.send` assigns `body["type"] = "profileAction"` AFTER copying the
 * payload, so anything sent under that key is overwritten before it leaves
 * Swift. A nested action name needs a key of its own.
 *
 * Nothing here asks for confirmation. `confirmDestructive()` opens a Radix
 * AlertDialog inside the webview, which sits BEHIND the native sheet: the
 * promise never settles and the action hangs forever. The sheet confirms
 * natively before it sends, and these do the deed unconditionally.
 */
export function applyProfile(command) {
  ensureFlushListener();
  const action = command && typeof command === 'object' ? command : {};
  const name = text(action.action);
  switch (name) {
    // The only way a scalar is written. The path is echoed back exactly as the
    // projection minted it.
    case 'setField': {
      const path = text(action.path);
      if (!path) throw new Error('setField needs a path');
      // WHICH PROFILE this path counts into, when the caller can say.
      //
      // `skills[1].proficiency` is a position. A field ROW is safe without this
      // because it holds the profile guard for as long as it has focus, so no
      // adoption can land underneath it — but a picker has no focus, and its
      // menu can sit open across one. The path then names whichever skill moved
      // into that index.
      //
      // Absent means "the caller is guarded another way", which is true of every
      // keystroke write from a focused row. Present and stale is refused.
      requireCurrentProfile(action.revision, path);
      const profile = read();
      // `setByPath` MATERIALISES missing parents, which for a stale path — a
      // row deleted since the sheet last rendered — would grow a hole in the
      // array rather than fail. Refuse to create; only ever overwrite.
      const parent = parentPath(path);
      if (parent) {
        const target = getByPath(profile, parent);
        if (!target || typeof target !== 'object') throw new Error(`no field at ${path}`);
      }
      setByPath(profile, path, text(action.value));
      commit(profile);
      return;
    }

    case 'addItem': {
      const listPath = text(action.listPath);
      const profile = read();
      if (!addProfileItem(profile, listPath)) throw new Error(`unknown profile list: ${listPath}`);
      commit(profile);
      return;
    }

    case 'deleteItem': {
      const listPath = text(action.listPath);
      if (!ITEM_KEYS[listPath]) throw new Error(`unknown profile list: ${listPath}`);
      const profile = read();
      const index = toIndex(action.index);
      requireItem(profile[listPath], listPath, index, action.key);
      deleteProfileItem(profile, listPath, index);
      commit(profile);
      return;
    }

    // Dates write THREE fields at once (the display string plus the
    // machine-readable pair), and either all three land or none do:
    // `buildDateFields` returns null for a half pair or a reversed range so
    // that nothing is written, and `freeformDateFields` deliberately CLEARS the
    // pair when text is typed. Assembling those three in Swift would produce a
    // display string disagreeing with the pair the run gate then acts on.
    case 'setDates': {
      const profile = read();
      const items = profile.workExperience;
      const index = toIndex(action.index);
      requireItem(items, 'workExperience', index, action.key);
      const fields = text(action.mode) === 'text'
        ? freeformDateFields(text(action.text))
        : buildDateFields({
          start: toMonthPair(action.startYear, action.startMonth),
          end: toMonthPair(action.endYear, action.endMonth),
          ongoing: toFlag(action.ongoing),
        });
      if (!fields) throw new Error('that date range is incomplete');
      Object.assign(items[index], fields);
      commit(profile);
      return;
    }

    case 'addRole':
    case 'detachRole':
    case 'linkAbove': {
      const profile = read();
      const index = toIndex(action.index);
      requireItem(profile.workExperience, 'workExperience', index, action.key);
      const edit = { addRole: addRoleAt, detachRole, linkAbove }[name];
      const next = edit(profile.workExperience, index);
      if (!next) throw new Error('that is not possible from here');
      profile.workExperience = next;
      commit(profile);
      return;
    }

    case 'setCompany': {
      const profile = read();
      const items = profile.workExperience;
      const index = toIndex(action.index);
      requireItem(items, 'workExperience', index, action.key);
      setRunCompany(items, runIndices(items, index), text(action.value));
      commit(profile);
      return;
    }

    // Several entries at once, so the sheet asks first — natively, and with the
    // live company name, which it has because the projection republished after
    // the rename landed.
    case 'deleteEmployer': {
      const profile = read();
      const items = profile.workExperience;
      const index = toIndex(action.index);
      requireItem(items, 'workExperience', index, action.key);
      profile.workExperience = removeEntries(items, runIndices(items, index));
      commit(profile);
      return;
    }

    // Import arrives as text Swift read from the file importer, because a
    // hidden `<input type="file">` inside a `<label>` does nothing in WKWebView.
    // It lands in two steps when — and only when — there is something to ask:
    // the parse is stashed, the sheet asks natively, and `resolveImport`
    // finishes it.
    case 'importMarkdown': {
      const { imported, grouped, runCount } = parseProfileImport(action.text);
      if (runCount > 0) {
        pendingImport = { imported, grouped, runCount };
        return;
      }
      applyImport(completeProfile(imported));
      return;
    }

    case 'resolveImport': {
      if (!pendingImport) return;
      const { imported, grouped } = pendingImport;
      applyImport(completeProfile(
        toFlag(action.group) ? { ...imported, workExperience: grouped } : imported
      ));
      return;
    }

    case 'cancelImport':
      pendingImport = null;
      return;

    default:
      throw new Error(`unknown profile action: ${name}`);
  }
}
