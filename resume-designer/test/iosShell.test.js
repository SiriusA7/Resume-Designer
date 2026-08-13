import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildChatView,
  newListItem,
  buildDesign,
  buildDocumentOutline,
  buildHistory,
  buildPendingChanges,
  buildSettings,
  buildSnapshot,
  createCommandDispatcher,
  hasOpenModal,
  isNativeShellAvailable,
  openNativePdfPreview,
  SHELL_HANDLER,
} from '../src/iosShell.js';
import { TYPE_LABELS } from '../src/historyEntryLabels.js';

// The bridge's contract with src-tauri/ios/OPShell.swift. Swift decodes the
// snapshot into a Codable struct and sends commands back as JSON, so the shapes
// below are the actual interface — a change here is a change to the Swift.

describe('buildSnapshot', () => {
  const list = [
    { id: 'a', name: 'Senior Engineer' },
    { id: 'b', name: 'Product Lead' },
  ];

  it('projects the loaded variant name as the chrome title', () => {
    const snap = buildSnapshot({ currentId: 'b', list, zoom: 1 });
    expect(snap.variantName).toBe('Product Lead');
    expect(snap.variantId).toBe('b');
    expect(snap.variants).toEqual(list);
  });

  it('reports zoom as both a scale and a whole percent', () => {
    // The toolbar renders the percent; the scale is what a native zoom control
    // would drive. 1.15 must not surface as "115.00000000000001%".
    expect(buildSnapshot({ zoom: 1.15 }).zoomPercent).toBe(115);
    expect(buildSnapshot({ zoom: 0.335 }).zoomPercent).toBe(34);
  });

  it('falls back to 100% rather than emitting NaN into the toolbar', () => {
    for (const bad of [undefined, null, NaN, 0, -1, 'big']) {
      const snap = buildSnapshot({ zoom: bad });
      expect(snap.zoom).toBe(1);
      expect(snap.zoomPercent).toBe(100);
    }
  });

  it('names an unnamed variant instead of sending an empty menu row', () => {
    expect(buildSnapshot({ currentId: 'a', list: [{ id: 'a' }] }).variantName).toBe('Untitled');
    expect(buildSnapshot({ currentId: 'a', list: [{ id: 'a', name: '' }] }).variantName).toBe('Untitled');
  });

  it('drops entries with no id, which could not be selected anyway', () => {
    const snap = buildSnapshot({ currentId: 'a', list: [{ id: 'a', name: 'Keep' }, { name: 'Drop' }, null] });
    expect(snap.variants).toEqual([{ id: 'a', name: 'Keep' }]);
  });

  it('leaves the title empty when nothing is loaded', () => {
    expect(buildSnapshot({ currentId: null, list }).variantName).toBe('');
    expect(buildSnapshot({ currentId: 'gone', list }).variantName).toBe('');
  });

  it('survives being called with nothing at all', () => {
    expect(buildSnapshot()).toEqual({
      variantId: null,
      variantName: '',
      variants: [],
      zoom: 1,
      zoomPercent: 100,
      pdfBusy: false,
      modalOpen: false,
      settings: {
        theme: 'system', hasApiKey: false, autoFallback: false, syncEnabled: false, version: '',
      },
      document: null,
      chat: null,
      library: null,
      design: null,
      history: null,
      jobs: null,
      profile: null,
      onboarding: null,
      diff: null,
    });
  });
});

describe('newListItem', () => {
  // The ONLY place a new row's shape lives. Swift carries the path and nothing
  // else, so if these drift the native Add button appends something the
  // renderer cannot draw.
  it('normalises indices so every role and section shares one template', () => {
    expect(newListItem('experience[0].bullets')).toBe('New bullet point');
    expect(newListItem('experience[7].bullets')).toBe('New bullet point');
    expect(newListItem('sections[3].content')).toBe('New item');
  });

  it('matches what the web Add buttons pass to store.addToArray', () => {
    expect(newListItem('education')).toBe('Degree — Institution — Dates');
    expect(newListItem('experience', () => 'exp-1')).toEqual({
      id: 'exp-1',
      title: 'New Position',
      company: 'Company Name',
      dates: 'Start – End',
      bullets: ['Describe your accomplishments'],
      _expanded: true,
    });
    expect(newListItem('sections', () => 'section-1')).toEqual({
      id: 'section-1',
      title: 'New section',
      type: 'list',
      area: 'sidebar',
      content: ['Item 1'],
    });
  });

  it('has no template for a path that is not a list, rather than a default', () => {
    // `name` and `summary` are strings; appending to them is meaningless and
    // must be refused, not guessed at.
    expect(newListItem('name')).toBeUndefined();
    expect(newListItem('contact.email')).toBeUndefined();
    expect(newListItem('')).toBeUndefined();
    expect(newListItem(null)).toBeUndefined();
  });
});

describe('buildDocumentOutline list actions', () => {
  const doc = {
    name: 'Ash',
    experience: [{ title: 'Designer', bullets: ['Did a thing'] }],
    education: ['A degree'],
    sections: [
      { title: 'Skills', content: ['One'] },
      { title: 'About', content: 'Prose, not a list.' },
    ],
  };

  it('lets a role add bullets and be deleted whole', () => {
    const role = buildDocumentOutline(doc).groups.find((g) => g.id === 'experience-0');
    expect(role.addLabel).toBe('Add bullet');
    // The array and index, not a "delete me" flag — removal goes through the
    // same removeItem(path, index) every row deletion uses.
    expect([role.removePath, role.removeIndex]).toEqual(['experience', 0]);
    expect(role.removeTitle).toBe('Designer');
  });

  it('offers no row-add on a prose section, which is one string', () => {
    const [list, prose] = buildDocumentOutline(doc).groups.filter((g) => g.id.startsWith('section-'));
    expect(list.addLabel).toBe('Add item');
    expect(prose.addLabel).toBe('');
    expect(prose.listPath).toBe(null);
    // Still deletable as a whole, though.
    expect([prose.removePath, prose.removeIndex]).toEqual(['sections', 1]);
  });

  it('does not offer to delete groups that are not array members', () => {
    const header = buildDocumentOutline(doc).groups.find((g) => g.id === 'header');
    expect(header.removePath).toBe(null);
    expect(header.addLabel).toBe('');
  });

  it('always offers the document-level adds, even with nothing to group', () => {
    // A group only exists once its array is non-empty, so a résumé with no
    // education has no education group — and without these could never gain
    // one.
    const empty = buildDocumentOutline({ name: 'Ash' });
    expect(empty.groups.some((g) => g.id === 'education')).toBe(false);
    expect(empty.additions.map((a) => a.path)).toEqual(['experience', 'education', 'sections']);
    // And every one of them resolves to a real template.
    for (const addition of empty.additions) {
      expect(newListItem(addition.path)).toBeDefined();
    }
  });
});

describe('createCommandDispatcher', () => {
  it('routes a command to its handler with the whole payload', () => {
    const selectVariant = vi.fn();
    const dispatch = createCommandDispatcher({ selectVariant });
    expect(dispatch({ type: 'selectVariant', id: 'b' })).toEqual({ ok: true });
    expect(selectVariant).toHaveBeenCalledWith({ type: 'selectVariant', id: 'b' });
  });

  it('carries a plain-object handler return value in the reply', () => {
    const dispatch = createCommandDispatcher({
      syncUnit: () => ({ id: 'resume:v-1', payload: '{"name":"Ash"}' }),
    });

    expect(dispatch({ type: 'syncUnit', unitId: 'resume:v-1' })).toEqual({
      ok: true,
      result: { id: 'resume:v-1', payload: '{"name":"Ash"}' },
    });
  });

  it('omits result when a handler returns a Promise', () => {
    const dispatch = createCommandDispatcher({ save: () => Promise.resolve(true) });

    const reply = dispatch({ type: 'save' });

    expect(reply).toEqual({ ok: true });
    expect('result' in reply).toBe(false);
  });

  it('omits result when a handler returns undefined', () => {
    const dispatch = createCommandDispatcher({ zoomIn: () => undefined });

    const reply = dispatch({ type: 'zoomIn' });

    expect(reply).toEqual({ ok: true });
    expect('result' in reply).toBe(false);
  });

  it('accepts the JSON string Swift actually sends', () => {
    const zoomIn = vi.fn();
    const dispatch = createCommandDispatcher({ zoomIn });
    expect(dispatch('{"type":"zoomIn"}')).toEqual({ ok: true });
    expect(zoomIn).toHaveBeenCalled();
  });

  it('reports malformed input as data instead of throwing', () => {
    // Swift calls this through evaluateJavaScript and cannot catch a JS throw,
    // so every failure has to come back as a return value.
    const dispatch = createCommandDispatcher({});
    expect(dispatch('{not json')).toEqual({ ok: false, error: 'malformed-json' });
    expect(dispatch(null)).toEqual({ ok: false, error: 'malformed-command' });
    expect(dispatch({ id: 'b' })).toEqual({ ok: false, error: 'malformed-command' });
    expect(dispatch({ type: 42 })).toEqual({ ok: false, error: 'malformed-command' });
  });

  it('names an unknown command so a Swift/JS drift is diagnosable', () => {
    const dispatch = createCommandDispatcher({});
    expect(dispatch({ type: 'openTeleporter' })).toEqual({
      ok: false,
      error: 'unknown-command:openTeleporter',
    });
  });

  it('contains a throwing handler rather than taking the chrome down', () => {
    const dispatch = createCommandDispatcher({
      exportPdf: () => { throw new Error('control not found: #download-pdf'); },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = dispatch({ type: 'exportPdf' });
    expect(reply).toEqual({
      ok: false,
      error: 'control not found: #download-pdf',
    });
    expect('result' in reply).toBe(false);
    spy.mockRestore();
  });
});

describe('isNativeShellAvailable', () => {
  it('is false everywhere Swift has not registered its handler', () => {
    expect(isNativeShellAvailable({})).toBe(false);
    expect(isNativeShellAvailable({ webkit: {} })).toBe(false);
    expect(isNativeShellAvailable({ webkit: { messageHandlers: {} } })).toBe(false);
    // WKWebView exposes messageHandlers for Tauri's own IPC, so the presence of
    // `webkit` proves nothing — only our named handler does.
    expect(isNativeShellAvailable({ webkit: { messageHandlers: { ipc: { postMessage() {} } } } })).toBe(false);
  });

  it('is true once the handler is there', () => {
    const win = { webkit: { messageHandlers: { [SHELL_HANDLER]: { postMessage() {} } } } };
    expect(isNativeShellAvailable(win)).toBe(true);
  });
});

describe('hasOpenModal', () => {
  // The native toolbar floats above the webview, so it covered the PDF
  // preview's Save button. This is the signal that withdraws it.
  const root = (html) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  it('sees an open Radix dialog or alert dialog', () => {
    expect(hasOpenModal(root('<div role="dialog" data-state="open"></div>'))).toBe(true);
    expect(hasOpenModal(root('<div role="alertdialog" data-state="open"></div>'))).toBe(true);
  });

  it('ignores a closed one, which Radix leaves in the DOM', () => {
    expect(hasOpenModal(root('<div role="dialog" data-state="closed"></div>'))).toBe(false);
  });

  it("sees the app's own overlays only once they are showing", () => {
    expect(hasOpenModal(root('<div class="onboarding-overlay show"></div>'))).toBe(true);
    expect(hasOpenModal(root('<div class="modal-overlay show"></div>'))).toBe(true);
    expect(hasOpenModal(root('<div class="onboarding-overlay"></div>'))).toBe(false);
    expect(hasOpenModal(root('<div class="modal-overlay"></div>'))).toBe(false);
  });

  it('does not count the chat or structure drawers', () => {
    // They are toggled FROM the toolbar; withdrawing it would strand the user.
    expect(hasOpenModal(root('<aside class="chat-panel"></aside>'))).toBe(false);
    expect(hasOpenModal(root('<aside class="structure-panel open"></aside>'))).toBe(false);
  });

  it('is false for an empty document and a missing root', () => {
    expect(hasOpenModal(root(''))).toBe(false);
    expect(hasOpenModal(null)).toBe(false);
  });
});

describe('buildSettings', () => {
  it('normalises an unknown theme to system rather than passing it through', () => {
    // Swift switches on this string; an unrecognised value must land on the
    // default arm, not leave the segmented control with nothing selected.
    expect(buildSettings({ theme: 'solarized' }).theme).toBe('system');
    expect(buildSettings({}).theme).toBe('system');
    expect(buildSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(buildSettings({ theme: 'light' }).theme).toBe('light');
  });

  it('reports only WHETHER a key is set', () => {
    // The key lives in the OS keychain. Nothing in the native sheet needs to
    // read it back, so the projection must not be able to leak it.
    const projected = buildSettings({ hasApiKey: true });
    expect(projected.hasApiKey).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('sk-or');
    expect(Object.keys(projected).sort()).toEqual(
      ['autoFallback', 'hasApiKey', 'syncEnabled', 'theme', 'version']
    );
  });

  it('defaults to a shape Swift can decode when given nothing', () => {
    expect(buildSettings()).toEqual({
      theme: 'system', hasApiKey: false, autoFallback: false, syncEnabled: false, version: '',
    });
  });

  it('leaves iCloud sync off unless something says otherwise', () => {
    // Off is the product decision, not a placeholder: turning it on writes a
    // person's resumes into their iCloud account. A missing or junk value must
    // land on off, never on on.
    expect(buildSettings({}).syncEnabled).toBe(false);
    expect(buildSettings({ syncEnabled: undefined }).syncEnabled).toBe(false);
    expect(buildSettings({ syncEnabled: true }).syncEnabled).toBe(true);
    // Coerced, because Swift decodes this into a Bool and a string there is a
    // whole-snapshot decode failure.
    expect(buildSettings({ syncEnabled: 'true' }).syncEnabled).toBe(true);
  });

  it('never projects a sync status, which only Swift can know', () => {
    // The account state lives in the transport. A status projected from here
    // would be a second, always-stale copy of something JS cannot observe.
    expect('syncStatus' in buildSettings({ syncEnabled: true })).toBe(false);
  });
});

describe('buildDocumentOutline', () => {
  const doc = {
    name: 'Ada Lovelace',
    tagline: 'Engineer',
    contact: { location: 'London', email: 'ada@example.com' },
    summary: 'Builds engines.',
    experience: [
      { title: 'Principal Engineer', company: 'Analytical Engines', dates: '2021 – Now',
        bullets: ['Led the move', 'Cut export time'] },
    ],
    education: ['BSc Mathematics'],
    sections: [{ title: 'Skills', content: ['Rust', 'Swift'] }],
  };

  it('keys every field by the path the store already understands', () => {
    // These exact strings go to store.update -> setByPath. A change here is a
    // change to how edits land in the document.
    const paths = buildDocumentOutline(doc).groups.flatMap((g) => g.fields.map((f) => f.path));
    expect(paths).toContain('name');
    expect(paths).toContain('contact.email');
    expect(paths).toContain('summary');
    expect(paths).toContain('experience[0].title');
    expect(paths).toContain('experience[0].bullets[1]');
    expect(paths).toContain('education[0]');
    expect(paths).toContain('sections[0].content[1]');
  });

  it('titles a role group by the role, so the panel is navigable', () => {
    const titles = buildDocumentOutline(doc).groups.map((g) => g.title);
    expect(titles).toEqual(['Header', 'Summary', 'Principal Engineer', 'Education', 'Skills']);
  });

  it('falls back to a positional title when a role or section is unnamed', () => {
    const groups = buildDocumentOutline({ experience: [{}], sections: [{}] }).groups;
    expect(groups.map((g) => g.title)).toEqual(['Header', 'Summary', 'Role 1', 'Section 1']);
  });

  it('marks long-form fields multiline and short ones not', () => {
    const byPath = Object.fromEntries(
      buildDocumentOutline(doc).groups.flatMap((g) => g.fields).map((f) => [f.path, f])
    );
    expect(byPath['summary'].multiline).toBe(true);
    expect(byPath['experience[0].bullets[0]'].multiline).toBe(true);
    expect(byPath['name'].multiline).toBe(false);
    expect(byPath['sections[0].content[0]'].multiline).toBe(false);
  });

  it('handles a prose section, whose content is a string not a list', () => {
    const groups = buildDocumentOutline({ sections: [{ title: 'About', content: 'One paragraph.' }] }).groups;
    const fields = groups.at(-1).fields;
    expect(fields.map((f) => f.path)).toEqual(['sections[0].title', 'sections[0].content']);
    expect(fields[1].value).toBe('One paragraph.');
  });

  it('never emits a non-string value, which Swift could not decode', () => {
    const messy = { name: 42, contact: { email: {} }, summary: null, experience: [{ bullets: [null, 7] }] };
    for (const f of buildDocumentOutline(messy).groups.flatMap((g) => g.fields)) {
      expect(typeof f.value).toBe('string');
    }
  });

  it('omits Education entirely when there is none, rather than an empty group', () => {
    const titles = buildDocumentOutline({ education: [] }).groups.map((g) => g.title);
    expect(titles).not.toContain('Education');
  });

  it('survives a missing or malformed document', () => {
    expect(buildDocumentOutline(null)).toEqual({ groups: [] });
    expect(buildDocumentOutline('nope')).toEqual({ groups: [] });
    expect(buildDocumentOutline({}).groups.map((g) => g.id)).toEqual(['header', 'summary']);
  });
});

describe('buildPendingChanges', () => {
  // Nothing applies on iOS without its before/after on screen, so this
  // projection is the safety boundary, not a convenience.
  const change = (over = {}) => ({
    path: 'experience[0].bullets[1]', type: 'modify',
    displayOld: 'Old text', displayNew: 'New text', ...over,
  });

  it('carries the diff strings the desktop review already computed', () => {
    const [c] = buildPendingChanges([change()]);
    expect(c).toEqual({
      path: 'experience[0].bullets[1]',
      label: 'experience[0].bullets[1]',
      type: 'modify',
      before: 'Old text',
      after: 'New text',
    });
  });

  it('keeps add and remove distinguishable from a modification', () => {
    expect(buildPendingChanges([change({ type: 'add' })])[0].type).toBe('add');
    expect(buildPendingChanges([change({ type: 'remove' })])[0].type).toBe('remove');
    // Anything unrecognised reads as a modification rather than vanishing.
    expect(buildPendingChanges([change({ type: 'wat' })])[0].type).toBe('modify');
  });

  it('truncates a proposal too large to read on a phone', () => {
    const huge = 'x'.repeat(5000);
    const [c] = buildPendingChanges([change({ displayNew: huge })]);
    expect(c.after).toHaveLength(601);
    expect(c.after.endsWith('…')).toBe(true);
  });

  it('never emits a non-string, which Swift could not decode', () => {
    const [c] = buildPendingChanges([change({ displayOld: null, displayNew: 42 })]);
    expect(c.before).toBe('');
    expect(c.after).toBe('42');
  });

  it('drops entries with no path, which could not be applied', () => {
    expect(buildPendingChanges([{ type: 'modify' }, null, change()])).toHaveLength(1);
  });

  it('survives a missing change set', () => {
    expect(buildPendingChanges(undefined)).toEqual([]);
    expect(buildPendingChanges(null)).toEqual([]);
  });
});

describe('buildChatView', () => {
  const view = (over = {}) => buildChatView({ configured: true, ...over });

  it('opens a streaming row the moment a request starts', () => {
    // The native sheet reads this row as "Thinking…" — with no reasoning and no
    // text yet, it is the only thing that tells the user the send landed.
    const { messages } = view({ loading: true });
    expect(messages).toEqual([
      { id: 'streaming', role: 'assistant', text: '', hasChanges: false, reasoning: '' },
    ]);
  });

  it('leaves the placeholder out while a helper turn owns the status line', () => {
    // /feedback and /improve report through `thinking`; both at once would be
    // two spinners for one request.
    expect(view({ loading: true, thinking: 'Analyzing your resume...' }).messages).toEqual([]);
  });

  it('carries reasoning and text on the streaming row as they arrive', () => {
    const { messages } = view({
      loading: true,
      streamingMessage: { content: 'Here is', reasoning: '**Reading**\nthe summary\n' },
    });
    expect(messages.at(-1)).toEqual({
      id: 'streaming', role: 'assistant', text: 'Here is',
      hasChanges: false, reasoning: '**Reading**\nthe summary\n',
    });
  });

  it('marks the thread the sheet titles itself from', () => {
    const { threads } = view({
      currentThreadId: 't2',
      threads: [{ id: 't1', title: 'Older chat' }, { id: 't2', title: 'Tailoring for Acme' }],
    });
    expect(threads).toEqual([
      { id: 't1', title: 'Older chat', isCurrent: false },
      { id: 't2', title: 'Tailoring for Acme', isCurrent: true },
    ]);
  });

  it('says nothing is in flight when nothing is', () => {
    expect(view().messages).toEqual([]);
    expect(view().thinking).toBe('');
  });
});

describe('buildDesign', () => {
  // Swift decodes this into ONE Codable struct and holds no catalog of its own,
  // so the shape below is the whole Design sheet: settings on the left of each
  // group, the options the pickers offer on the right.
  const state = () => ({
    page: { size: 'letter', orientation: 'portrait', widthIn: 8.5, groupPositions: true },
    pageSizes: [{ id: 'continuous', name: 'Continuous' }, { id: 'letter', name: 'Letter' }],
    color: { palette: 'ocean', customColor: '#2563eb' },
    palettes: [{ id: 'ocean', name: 'Ocean', p1: '#2563eb', p2: '#1e3a5f', p3: '#dbeafe' }],
    layout: 'sidebar-left',
    layouts: [{ id: 'sidebar-left', name: 'Sidebar Left' }, { id: 'timeline', name: 'Timeline' }],
    header: { type: 'gradient', styleId: 'linear-135', imageOpacity: 0.4, imageFit: 'cover', hasImage: false },
    headerStyles: [
      { id: 'linear-135', name: 'Diagonal', group: 'gradient', css: 'linear-gradient(135deg, #2563eb 0%, #1e3a5f 100%)' },
      { id: 'dots', name: 'Dots', group: 'pattern', css: 'radial-gradient(#2563eb15 2px, transparent 2px)' },
    ],
    fonts: { mode: 'pairing', pairingId: 'modern-clean', displayName: 'Inter', bodyName: 'Inter' },
    fontPairings: [{ id: 'modern-clean', name: 'Modern Clean', display: 'Inter', body: 'Inter' }],
    systemFonts: [{ id: 'helvetica', name: 'Helvetica Neue' }],
    googleFonts: [{ family: 'Karla', category: 'sans-serif' }, { family: 'Merriweather', category: 'serif' }],
    spacing: {
      fontScale: 1, lineHeight: 1.45, sectionSpacing: 0.8, sidebarWidth: 2.4,
      marginTop: 0.5, marginRight: 0.5, marginBottom: 0.5, marginLeft: 0.5, presetId: 'default',
    },
    spacingPresets: [{ id: 'default', name: 'Default' }, { id: 'compact', name: 'Compact' }],
    accent: {
      underlineStyle: 'solid', underlineWidth: 2, bulletStyle: 'disc', borderRadius: 'subtle',
      skillTagStyle: 'plain', showCornerTriangle: true, showSidebarGradient: false,
    },
    underlines: [{ id: 'solid', name: 'Solid' }, { id: 'none', name: 'None' }],
    bullets: [{ id: 'disc', name: 'Circle', char: '•' }, { id: 'none', name: 'None', char: '' }],
    radii: [{ id: 'subtle', name: 'Subtle' }],
    skillTags: [{ id: 'plain', name: 'Plain' }],
    photo: {
      enabled: true, hasImage: true, placement: 'header', shape: 'circle', size: 'medium',
      borderColor: '#ffffff', objectPosition: '50% 50%', scale: 1.2,
    },
    placements: [{ id: 'header', name: 'Header' }],
    shapes: [{ id: 'circle', name: 'Circle' }],
    sizes: [{ id: 'medium', name: 'Medium' }],
  });

  // Every leaf on the wire, so a decode-breaking value cannot hide in a group
  // no assertion happens to name.
  const leaves = (value, path = '') =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
      : [[path, value]];

  it('carries each control its current setting', () => {
    const d = buildDesign(state());
    expect(d.page).toEqual({ size: 'letter', orientation: 'portrait', widthIn: 8.5, groupPositions: true });
    expect(d.color).toEqual({ palette: 'ocean', customColor: '#2563eb' });
    expect(d.layout).toBe('sidebar-left');
    expect(d.fonts).toEqual({
      mode: 'pairing', pairingId: 'modern-clean', displayName: 'Inter', bodyName: 'Inter',
    });
    expect(d.spacing.lineHeight).toBe(1.45);
    expect(d.accent.showSidebarGradient).toBe(false);
    expect(d.photo.scale).toBe(1.2);
  });

  it('carries the catalogs, because Swift has no copy of them', () => {
    // A style added to headerStyleService.js has to reach iOS without a Swift
    // change, and Swift must only ever send back an id it was given here.
    const d = buildDesign(state());
    expect(d.headerStyles[0]).toEqual({
      id: 'linear-135', name: 'Diagonal', group: 'gradient',
      css: 'linear-gradient(135deg, #2563eb 0%, #1e3a5f 100%)',
    });
    expect(d.palettes[0]).toEqual({
      id: 'ocean', name: 'Ocean', p1: '#2563eb', p2: '#1e3a5f', p3: '#dbeafe',
    });
    expect(d.googleFonts).toEqual([
      { family: 'Karla', category: 'sans-serif' },
      { family: 'Merriweather', category: 'serif' },
    ]);
    // The 'none' bullet's glyph is legitimately empty; it must survive as a
    // row rather than being read as a missing value and dropped.
    expect(d.bullets.at(-1)).toEqual({ id: 'none', name: 'None', char: '' });
  });

  it('never emits a value Swift could not decode', () => {
    // One `null` where the struct expects a Double fails the WHOLE decode, so a
    // single bad catalog row would blank the entire sheet, not just its line.
    const messy = {
      page: { size: 42, widthIn: '8.5', groupPositions: 'true' },
      color: { palette: null },
      spacing: { fontScale: NaN, lineHeight: null, marginTop: undefined, presetId: null },
      accent: { underlineWidth: Infinity, showCornerTriangle: 'no' },
      photo: { scale: '1.2', hasImage: 'yes' },
      palettes: [{ id: 'ocean', name: null, p1: 1 }],
      bullets: [{ id: 'disc', char: undefined }],
      googleFonts: [{ family: 'Karla', category: null }],
    };
    for (const [path, value] of leaves(buildDesign(messy))) {
      expect(['string', 'number', 'boolean'], path).toContain(typeof value);
      if (typeof value === 'number') expect(Number.isFinite(value), path).toBe(true);
    }
  });

  it('reports a missing number as 0 rather than as the service default', () => {
    // A value that only appears because the read went wrong must not look like
    // a setting the user chose — and the real defaults stay single-sourced in
    // spacingService/accentService instead of being restated on the wire.
    const d = buildDesign({ spacing: { fontScale: NaN }, page: { widthIn: '8.5' } });
    expect(d.spacing.fontScale).toBe(0);
    expect(d.spacing.sidebarWidth).toBe(0);
    expect(d.page.widthIn).toBe(0);
  });

  it('says "" and never null when nothing matches', () => {
    // Both bind to a String selection in Swift. Null would fail the decode; the
    // empty string is how the sheet shows "no preset selected".
    const d = buildDesign({ spacing: { presetId: null }, fonts: { pairingId: undefined } });
    expect(d.spacing.presetId).toBe('');
    expect(d.fonts.pairingId).toBe('');
  });

  it('drops a catalog row with no id, which could not be selected', () => {
    // It would also collide with any other blank row as a SwiftUI ForEach id.
    const d = buildDesign({
      palettes: [{ id: 'ocean', name: 'Ocean' }, { name: 'Nameless' }, null, { id: '' }],
      googleFonts: [{ family: 'Karla' }, { category: 'serif' }],
    });
    expect(d.palettes.map((p) => p.id)).toEqual(['ocean']);
    expect(d.googleFonts.map((f) => f.family)).toEqual(['Karla']);
  });

  it('labels an unlabelled row with its id instead of leaving it blank', () => {
    const d = buildDesign({ layouts: [{ id: 'timeline' }], headerStyles: [{ id: 'linear-135' }] });
    expect(d.layouts[0].name).toBe('timeline');
    expect(d.headerStyles[0].name).toBe('linear-135');
  });

  it('reports only WHETHER an image is set', () => {
    // A header or photo image is a multi-megabyte data URL and this projection
    // goes out on every publish; the canvas is already rendering it.
    const d = buildDesign({
      header: { hasImage: true, image: 'data:image/png;base64,AAAA' },
      photo: { hasImage: true, dataUrl: 'data:image/jpeg;base64,BBBB' },
    });
    expect(d.header.hasImage).toBe(true);
    expect(d.photo.hasImage).toBe(true);
    expect(JSON.stringify(d)).not.toContain('data:image');
  });

  it('survives a missing or malformed state', () => {
    // The sheet opening empty is recoverable; a throw inside a publish is not.
    for (const bad of [undefined, null, 'nope', 42, []]) {
      const d = buildDesign(bad);
      expect(d.palettes).toEqual([]);
      expect(d.spacing.fontScale).toBe(0);
      expect(d.photo.enabled).toBe(false);
    }
    // A group that arrived as the wrong TYPE must not take its neighbours down.
    const d = buildDesign({ page: 'letter', palettes: 'ocean', layout: 'timeline' });
    expect(d.page.size).toBe('');
    expect(d.palettes).toEqual([]);
    expect(d.layout).toBe('timeline');
  });
});

describe('the Design sheet commands', () => {
  // These run against the dispatcher initIOSShell actually builds, not a
  // hand-made one: which dep each command reaches, and what it is handed, is
  // the part Swift depends on and the part a createCommandDispatcher test
  // cannot see. Each mount re-imports the module so the streaming flags — which
  // live at module scope — do not leak between tests.
  const mount = async (over = {}) => {
    vi.resetModules();
    const postMessage = vi.fn();
    globalThis.webkit = { messageHandlers: { [SHELL_HANDLER]: { postMessage } } };
    const deps = {
      subscribeVariants: vi.fn(),
      subscribeDocument: vi.fn(),
      getVariantsSnapshot: () => ({ currentId: null, list: [] }),
      getZoom: () => 1,
      fitToView: vi.fn(),
      duplicateVariant: vi.fn(),
      exportCurrentVariant: vi.fn(),
      getAppInfo: () => Promise.resolve({ version: '2.1.0' }),
      getSettings: () => ({}),
      getTheme: () => 'system',
      getDocument: vi.fn(),
      getLibrary: vi.fn(),
      getPendingChanges: () => [],
      getDesign: vi.fn(() => ({ palettes: [{ id: 'ocean', name: 'Ocean' }] })),
      applyDesign: vi.fn(),
      resetDesign: vi.fn(),
      setDesignImage: vi.fn(),
      clearDesignImage: vi.fn(),
      ...over,
    };
    const { initIOSShell } = await import('../src/iosShell.js');
    initIOSShell(deps);
    return { deps, postMessage, send: (command) => window.__opShell.command(command) };
  };

  // publish() coalesces into a microtask, so nothing is on the wire until one
  // has run.
  const settled = () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const lastSnapshot = (postMessage) =>
    postMessage.mock.calls.map(([m]) => m).filter((m) => m.kind === 'snapshot').at(-1);

  afterEach(() => { delete globalThis.webkit; });

  it('resolves a new row\'s shape on this side, from the path alone', async () => {
    const addListItem = vi.fn();
    const { send } = await mount({ addListItem, generateId: () => 'exp-9' });

    // Swift sends a path and nothing else. What lands in the document is
    // decided here, which is what keeps the schema out of the native side.
    send({ type: 'addItem', path: 'experience[2].bullets' });
    expect(addListItem).toHaveBeenCalledWith('experience[2].bullets', 'New bullet point');

    send({ type: 'addItem', path: 'experience' });
    expect(addListItem).toHaveBeenLastCalledWith('experience', expect.objectContaining({
      id: 'exp-9', title: 'New Position',
    }));
  });

  it('refuses to append to something that has no template', async () => {
    const addListItem = vi.fn();
    const { send } = await mount({ addListItem });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(send({ type: 'addItem', path: 'name' })).toEqual({
      ok: false, error: 'addItem has no template for name',
    });
    expect(send({ type: 'addItem' })).toEqual({
      ok: false, error: 'addItem needs a list path',
    });
    expect(addListItem).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses a removal whose index cannot be real', async () => {
    // `store.removeFromArray` ignores an out-of-range index silently, so a row
    // tapped after the list shrank underneath would look like it worked.
    const removeListItem = vi.fn();
    const { send } = await mount({ removeListItem });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    send({ type: 'removeItem', path: 'education', index: '2' });
    expect(removeListItem).toHaveBeenCalledWith('education', 2);

    expect(send({ type: 'removeItem', path: 'education', index: '-1' }).ok).toBe(false);
    expect(send({ type: 'removeItem', path: 'education', index: 'x' }).ok).toBe(false);
    expect(removeListItem).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('puts the wizard on the wire as soon as it pushes, with no sheet to open', async () => {
    // Unlike every other screen there is no `setOnboardingOpen` command: the
    // wizard IS the screen when it is up, so its own `open` is the only gate.
    // And the push comes from the component, so this is also the check that the
    // key reaches buildSnapshot at all — the failure that has silently broken
    // this bridge twice.
    const { postMessage } = await mount();
    const { publishOnboarding } = await import('../src/iosShell.js');
    await settled();
    expect(lastSnapshot(postMessage).onboarding).toBe(null);

    publishOnboarding({ open: true, step: 1, mode: 'import', isNewResumeMode: true });
    await settled();
    expect(lastSnapshot(postMessage).onboarding).toMatchObject({
      open: true, step: 1, mode: 'import', totalSteps: 5,
    });

    publishOnboarding(null);
    await settled();
    expect(lastSnapshot(postMessage).onboarding).toBe(null);
  });

  it('routes every wizard command to the handler the component registered', async () => {
    const { send } = await mount();
    const { publishOnboarding } = await import('../src/iosShell.js');
    const handlers = {
      validateKey: vi.fn(), chooseMode: vi.fn(), parseImport: vi.fn(),
      interviewNext: vi.fn(), improve: vi.fn(), generateForJob: vi.fn(),
      cancelGenerate: vi.fn(), addJob: vi.fn(), removeJob: vi.fn(),
      next: vi.fn(), back: vi.fn(), saveResume: vi.fn(), finish: vi.fn(),
      dismiss: vi.fn(),
    };
    publishOnboarding({ open: true }, handlers);

    send({ type: 'onboardingChoose', mode: 'job' });
    expect(handlers.chooseMode).toHaveBeenCalledWith('job');

    send({ type: 'onboardingRemoveJob', index: '2' });
    expect(handlers.removeJob).toHaveBeenCalledWith(2);

    send({ type: 'onboardingGenerate', title: 'Designer', description: 'JD', reasoning: 'high' });
    expect(handlers.generateForJob).toHaveBeenCalledWith({
      title: 'Designer', company: '', description: 'JD', model: '', reasoning: 'high',
    });

    send({ type: 'onboardingCancelGenerate' });
    expect(handlers.cancelGenerate).toHaveBeenCalled();
  });

  it('omits the async onboardingSaveKey result from the command reply', async () => {
    const { send } = await mount();
    const { publishOnboarding } = await import('../src/iosShell.js');
    const validateKey = vi.fn(async () => true);
    publishOnboarding({ open: true }, { validateKey });

    const reply = send({ type: 'onboardingSaveKey', key: 'sk-test' });

    expect(validateKey).toHaveBeenCalledWith('sk-test');
    expect(reply).toEqual({ ok: true });
    expect('result' in reply).toBe(false);
  });

  it('passes a job draft back only when Back actually carries one', async () => {
    const { send } = await mount();
    const { publishOnboarding } = await import('../src/iosShell.js');
    const back = vi.fn();
    publishOnboarding({ open: true }, { back });

    // Every other step's Back has no draft, and handing it an empty one would
    // overwrite the job the user typed with blanks.
    send({ type: 'onboardingBack' });
    expect(back).toHaveBeenLastCalledWith(null);

    send({ type: 'onboardingBack', title: 'Designer', company: 'Acme', description: 'JD' });
    expect(back).toHaveBeenLastCalledWith({
      title: 'Designer', company: 'Acme', description: 'JD',
    });
  });

  it('ignores a wizard command that arrives before the component has rendered', async () => {
    // The dispatcher catches throws, but a throw here would still be reported
    // as a failed command for something that is merely early.
    const { send } = await mount();
    expect(send({ type: 'onboardingFinish' })).toEqual({ ok: true });
  });

  it('projects the catalogs only while the sheet is open', async () => {
    // They are the largest payload the bridge carries and they never change;
    // the canvas re-renders on every keystroke.
    const { deps, postMessage, send } = await mount();
    await settled();
    expect(deps.getDesign).not.toHaveBeenCalled();
    expect(lastSnapshot(postMessage).design).toBe(null);

    send({ type: 'setDesignOpen', value: 'true' });
    await settled();
    expect(deps.getDesign).toHaveBeenCalled();
    expect(lastSnapshot(postMessage).design.palettes).toEqual([{ id: 'ocean', name: 'Ocean' }]);
  });

  it('stops projecting them when the sheet closes', async () => {
    const { deps, postMessage, send } = await mount();
    send({ type: 'setDesignOpen', value: 'true' });
    await settled();
    deps.getDesign.mockClear();

    send({ type: 'setDesignOpen', value: 'false' });
    await settled();
    expect(deps.getDesign).not.toHaveBeenCalled();
    expect(lastSnapshot(postMessage).design).toBe(null);
  });

  it('writes through the controller, with the string Swift sent', async () => {
    // Payload values are always strings on this bridge; designController owns
    // every coercion, so nothing about what a setting means is decided twice.
    const { deps, send } = await mount();
    expect(send({ type: 'setDesign', group: 'spacing', property: 'fontScale', value: '1.1' }))
      .toEqual({ ok: true });
    expect(deps.applyDesign).toHaveBeenCalledWith({
      group: 'spacing', property: 'fontScale', value: '1.1',
    });
  });

  it('sends an empty string rather than undefined when a value is cleared', async () => {
    const { deps, send } = await mount();
    send({ type: 'setDesign', group: 'color', property: 'customColor' });
    expect(deps.applyDesign).toHaveBeenCalledWith({
      group: 'color', property: 'customColor', value: '',
    });
  });

  it('refuses a write that names no group or no property', async () => {
    // Guessing either one would write a real setting from a malformed command.
    const { deps, send } = await mount();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(send({ type: 'setDesign', property: 'fontScale', value: '1.1' }).ok).toBe(false);
    expect(send({ type: 'setDesign', group: 'spacing', value: '1.1' }).ok).toBe(false);
    expect(deps.applyDesign).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('republishes after a write, so derived fields reach the sheet', async () => {
    // Moving one spacing slider empties `presetId`, and the sheet cannot work
    // that out for itself — without the re-push it keeps a preset highlighted
    // that the values no longer match.
    const { deps, send } = await mount();
    send({ type: 'setDesignOpen', value: 'true' });
    await settled();
    deps.getDesign.mockClear();

    send({ type: 'setDesign', group: 'spacing', property: 'fontScale', value: '1.1' });
    await settled();
    expect(deps.getDesign).toHaveBeenCalled();
  });

  it('resets a whole group through the controller', async () => {
    // Rather than by replaying every property, which would put the defaults in
    // Swift.
    const { deps, send } = await mount();
    expect(send({ type: 'resetDesign', group: 'spacing' })).toEqual({ ok: true });
    expect(deps.resetDesign).toHaveBeenCalledWith('spacing');
  });

  it('hands a picked image to the controller and refuses an empty one', async () => {
    const { deps, send } = await mount();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(send({ type: 'setDesignImage', target: 'photo', dataUrl: 'data:image/png;base64,AAAA' }))
      .toEqual({ ok: true });
    expect(deps.setDesignImage).toHaveBeenCalledWith('photo', 'data:image/png;base64,AAAA');
    // An empty data URL would set a header background to nothing at all, which
    // reads as a broken image rather than as no image.
    expect(send({ type: 'setDesignImage', target: 'header', dataUrl: '' }).ok).toBe(false);
    expect(deps.setDesignImage).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('clears an image through the controller', async () => {
    const { deps, send } = await mount();
    expect(send({ type: 'clearDesignImage', target: 'header' })).toEqual({ ok: true });
    expect(deps.clearDesignImage).toHaveBeenCalledWith('header');
  });

  it('hands Swift units it never has to understand', async () => {
    const collectUnits = vi.fn(() => ([
      { id: 'resume:v-1', kind: 'resume', payload: '{"name":"A"}', modifiedAt: '2026-08-09T00:00:00.000Z' },
    ]));
    const { send } = await mount({ collectUnits });
    expect(send({ type: 'syncCollect' })).toEqual({ ok: true });
    expect(collectUnits).toHaveBeenCalled();
  });

  it('projects the stored iCloud switch, and leaves it off when nothing stored it', async () => {
    const off = await mount();
    await settled();
    expect(lastSnapshot(off.postMessage).settings.syncEnabled).toBe(false);

    const on = await mount({ getSyncEnabled: () => true });
    await settled();
    expect(lastSnapshot(on.postMessage).settings.syncEnabled).toBe(true);
  });

  it('persists the switch and republishes what landed, not what was asked', async () => {
    // The toggle reads from the next snapshot, so a write that did not land
    // springs the control back rather than leaving it lying.
    let stored = false;
    const setSyncEnabled = vi.fn((value) => { stored = value; });
    const { postMessage, send } = await mount({
      setSyncEnabled, getSyncEnabled: () => stored,
    });

    expect(send({ type: 'setSyncEnabled', value: 'true' })).toEqual({ ok: true });
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
    await settled();
    expect(lastSnapshot(postMessage).settings.syncEnabled).toBe(true);

    // This bridge carries strings. Anything that is not 'true' is off, which is
    // the direction a garbled value has to fail in.
    send({ type: 'setSyncEnabled', value: 'false' });
    expect(setSyncEnabled).toHaveBeenLastCalledWith(false);
    await settled();
    expect(lastSnapshot(postMessage).settings.syncEnabled).toBe(false);
  });

  it('returns one opaque unit to Swift through the command reply', async () => {
    const unit = {
      id: 'resume:v-1',
      kind: 'resume',
      payload: '{"name":"A"}',
      modifiedAt: '2026-08-09T00:00:00.000Z',
    };
    const collectUnit = vi.fn(() => unit);
    const { send } = await mount({ collectUnit });

    expect(send({ type: 'syncUnit', unitId: 'resume:v-1' })).toEqual({
      ok: true,
      result: unit,
    });
    expect(collectUnit).toHaveBeenCalledWith('resume:v-1');
  });

  it('returns null through the command reply for an unknown unit id', async () => {
    const collectUnit = vi.fn(() => null);
    const { send } = await mount({ collectUnit });

    expect(send({ type: 'syncUnit', unitId: 'resume:unknown' })).toEqual({
      ok: true,
      result: null,
    });
    expect(collectUnit).toHaveBeenCalledWith('resume:unknown');
  });

  it('republishes after landing units, so an open sheet is not left on the old projection', async () => {
    // Every sheet projects on demand and nothing else re-reads it, so a landing
    // that replaced the job list or the application history would otherwise sit
    // behind whatever the sheet last drew until the user touched something.
    const applyUnits = vi.fn(() => ({ applied: 1 }));
    const { postMessage, send } = await mount({ applyUnits });
    await settled();
    const before = postMessage.mock.calls.filter(([m]) => m.kind === 'snapshot').length;

    expect(send({ type: 'syncApply', units: '[{"id":"key:x","payload":"[]"}]' }))
      .toEqual({ ok: true, result: { applied: 1 } });
    await settled();

    expect(postMessage.mock.calls.filter(([m]) => m.kind === 'snapshot').length)
      .toBeGreaterThan(before);
  });

  it('names the active profile in the activation, since Swift has no way to know it', async () => {
    // The CloudKit zone is one per profile and `getActiveProfileId` lives in
    // JS, so the activation is where the native side learns which one it is
    // syncing. Without it `start(profileId:)` has nothing to open a zone with.
    const { postMessage } = await mount({ getActiveProfileId: () => 'p-42' });
    const activations = postMessage.mock.calls
      .map(([m]) => m).filter((m) => m.kind === 'activated');
    expect(activations).toEqual([{ kind: 'activated', profileId: 'p-42' }]);
  });

  it('activates with an empty profile id rather than not at all', async () => {
    // Before adoption there is no active profile. The message still has to go
    // — it is also what re-locks WKWebView's own zoom on every reload — and
    // the native side leaves sync down until an activation names one.
    const { postMessage } = await mount({ getActiveProfileId: () => null });
    expect(postMessage.mock.calls.map(([m]) => m)).toContainEqual({
      kind: 'activated', profileId: '',
    });
  });

  it('posts the dirty unit ids to the native sync engine', async () => {
    let notifyDirty;
    const setSyncDirtyNotifier = vi.fn((notify) => { notifyDirty = notify; });
    const { postMessage } = await mount({ setSyncDirtyNotifier });

    notifyDirty(['resume:v-1', 'key:resume-designer-history-v-1']);

    expect(postMessage).toHaveBeenCalledWith({
      kind: 'syncDirty',
      unitIds: ['resume:v-1', 'key:resume-designer-history-v-1'],
    });
  });

  it('keeps single-unit lookup and dirty notification safe without a native shell', async () => {
    const unit = {
      id: 'resume:v-1', kind: 'resume', payload: '{}', modifiedAt: null,
    };
    let notifyDirty;
    const { send } = await mount({
      collectUnit: () => unit,
      setSyncDirtyNotifier: (notify) => { notifyDirty = notify; },
    });
    delete globalThis.webkit;

    expect(() => send({ type: 'syncUnit', unitId: 'resume:v-1' })).not.toThrow();
    expect(send({ type: 'syncUnit', unitId: 'resume:v-1' })).toEqual({ ok: true, result: unit });
    expect(() => notifyDirty(['resume:v-1'])).not.toThrow();
  });

  it('applies units and parks a conflict loser', async () => {
    const applyUnits = vi.fn(() => ({ applied: 1 }));
    const parkLoser = vi.fn(() => true);
    const { send } = await mount({ applyUnits, parkLoser });

    send({ type: 'syncApply', units: '[{"id":"resume:v-1","kind":"resume","payload":"{}","modifiedAt":"2026-08-09T00:00:00.000Z"}]' });
    expect(applyUnits).toHaveBeenCalledWith([
      { id: 'resume:v-1', kind: 'resume', payload: '{}', modifiedAt: '2026-08-09T00:00:00.000Z' },
    ]);

    send({ type: 'syncParkLoser', unitId: 'resume:v-1', payload: '{"name":"lost"}' });
    expect(parkLoser).toHaveBeenCalledWith('resume:v-1', '{"name":"lost"}');
  });

  it('answers with the count applyUnits actually landed', async () => {
    // Swift decides whether to keep the server's change tags for this batch on
    // this number, so it has to cross the bridge rather than be discarded: a
    // change tag is a claim to know which server version this device is
    // editing, and holding one for units the page never took makes the next
    // save of them a clean update that destroys the server's copy.
    const applyUnits = vi.fn(() => ({ applied: 2 }));
    const { send } = await mount({ applyUnits });

    expect(send({
      type: 'syncApply',
      units: '[{"id":"resume:v-1","kind":"resume","payload":"{}","modifiedAt":null},'
        + '{"id":"resume:v-2","kind":"resume","payload":"{}","modifiedAt":null}]',
    })).toEqual({ ok: true, result: { applied: 2 } });
    expect(applyUnits).toHaveBeenCalledTimes(1);
  });

  it('reports malformed units as data rather than throwing', async () => {
    const applyUnits = vi.fn();
    const { send } = await mount({ applyUnits });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(send({ type: 'syncApply', units: 'not json' }).ok).toBe(false);
    expect(applyUnits).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('openNativePdfPreview', () => {
  // The export guard is held from generation until the preview is answered, and
  // the temp PDF is only cleaned up by that answer — so the contract here is
  // that the native sheet either takes the job or declines it cleanly.
  const withHandler = (postMessage) => {
    globalThis.webkit = { messageHandlers: { [SHELL_HANDLER]: { postMessage } } };
    return () => { delete globalThis.webkit; };
  };

  const request = () => ({
    path: '/tmp/preview-1.pdf',
    defaultFilename: 'Alex Rivera',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  });

  it('declines when there is no native shell, so the web dialog still opens', () => {
    const req = request();
    expect(openNativePdfPreview(req)).toBe(false);
    expect(req.onConfirm).not.toHaveBeenCalled();
    expect(req.onCancel).not.toHaveBeenCalled();
  });

  it('declines without a path rather than opening an empty preview', () => {
    const restore = withHandler(vi.fn());
    expect(openNativePdfPreview({ ...request(), path: '' })).toBe(false);
    restore();
  });

  it('hands Swift the file and the name to offer', () => {
    const postMessage = vi.fn();
    const restore = withHandler(postMessage);
    expect(openNativePdfPreview(request())).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      kind: 'pdfPreview',
      path: '/tmp/preview-1.pdf',
      filename: 'Alex Rivera',
    });
    restore();
  });

  it('falls back to a usable name when none was given', () => {
    const postMessage = vi.fn();
    const restore = withHandler(postMessage);
    openNativePdfPreview({ ...request(), defaultFilename: undefined });
    expect(postMessage.mock.calls[0][0].filename).toBe('Resume');
    restore();
  });
});

describe('buildHistory', () => {
  const entry = (over = {}) => ({
    timestamp: '2026-08-11T12:00:00.000Z',
    description: 'Edited summary',
    changeType: 'edit',
    isCurrent: false,
    ...over,
  });

  it('names a version parked from another device as such, not as an edit', () => {
    // A conflict's losing version is kept in history so it can be restored.
    // Labelling it 'Edit' would say this machine made it, which is untrue and
    // is the one thing a person needs to know before restoring it.
    const { entries } = buildHistory([entry({ changeType: 'sync-conflict' })]);
    expect(entries[0].label).toBe('From another device');
  });

  it('draws its labels from the shared map, not a private copy', () => {
    // There used to be a second copy of this map in iosShell.js, and it is how
    // 'sync-conflict' came to be missing on iOS after the web dialog gained it.
    // Every type the web dialog can name, the bridge must name identically.
    for (const [changeType, label] of Object.entries(TYPE_LABELS)) {
      const { entries } = buildHistory([entry({ changeType })]);
      expect(entries[0].label, changeType).toBe(label);
    }
  });

  it('falls back to Edit for a change type nothing has named yet', () => {
    const { entries } = buildHistory([entry({ changeType: 'invented-later' })]);
    expect(entries[0].label).toBe('Edit');
  });

  it('lists the newest version first, keeping the store’s own index', () => {
    // The index is what `restoreToEntry` addresses. Reversing the ROWS without
    // reversing the indices is the whole point: Swift echoes an index back and
    // must never compute one.
    const { entries } = buildHistory([
      entry({ description: 'Created', changeType: 'initial' }),
      entry({ description: 'Edited summary' }),
      entry({ description: 'Rewrote it', changeType: 'ai', isCurrent: true }),
    ]);
    expect(entries.map((e) => e.index)).toEqual([2, 1, 0]);
    expect(entries[0].description).toBe('Rewrote it');
    expect(entries[0].isCurrent).toBe(true);
  });

  it('resolves the label so the two platforms cannot name a version differently', () => {
    const labels = buildHistory([
      entry({ changeType: 'initial' }), entry({ changeType: 'ai' }),
      entry({ changeType: 'import' }), entry({ changeType: 'reorder' }),
    ]).entries.map((e) => e.label);
    expect(labels).toEqual(['Reordered', 'Import', 'AI change', 'Created']);
  });

  it('falls back to Edit for a changeType it has never seen', () => {
    // The store can grow a type without this file knowing; an unlabelled row
    // would read as a blank version.
    const [row] = buildHistory([entry({ changeType: 'teleported' })]).entries;
    expect(row.label).toBe('Edit');
    expect(row.changeType).toBe('teleported');
  });

  it('carries the résumé the versions belong to', () => {
    // History is per-résumé and the sheet has no session identity of its own.
    expect(buildHistory([], 'variant-7').variantId).toBe('variant-7');
    expect(buildHistory([]).variantId).toBe('');
  });

  it('never ships a version’s document, only its description', () => {
    const { entries } = buildHistory([entry({ data: { name: 'Alex Rivera' } })]);
    expect(JSON.stringify(entries)).not.toContain('Alex Rivera');
  });

  it('projects an open comparison through the same diff shape the review uses', () => {
    const { diff } = buildHistory([entry()], 'v1', {
      label: 'Edit · 8h ago',
      changes: [{ path: 'summary', type: 'modify', displayOld: 'Old', displayNew: 'New' }],
    });
    expect(diff.label).toBe('Edit · 8h ago');
    expect(diff.changes).toEqual([
      { path: 'summary', label: 'summary', type: 'modify', before: 'Old', after: 'New' },
    ]);
  });

  it('survives an empty stack and a malformed one', () => {
    expect(buildHistory([]).entries).toEqual([]);
    expect(buildHistory(undefined).entries).toEqual([]);
    expect(buildHistory([null, 42]).entries).toHaveLength(2);
    expect(buildHistory([null]).entries[0].label).toBe('Edit');
  });
});
