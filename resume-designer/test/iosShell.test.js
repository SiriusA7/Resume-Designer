import { describe, it, expect, vi } from 'vitest';
import {
  buildChatView,
  buildDocumentOutline,
  buildPendingChanges,
  buildSettings,
  buildSnapshot,
  createCommandDispatcher,
  hasOpenModal,
  isNativeShellAvailable,
  openNativePdfPreview,
  SHELL_HANDLER,
} from '../src/iosShell.js';

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
      settings: { theme: 'system', hasApiKey: false, autoFallback: false, version: '' },
      document: null,
      chat: null,
      library: null,
    });
  });
});

describe('createCommandDispatcher', () => {
  it('routes a command to its handler with the whole payload', () => {
    const selectVariant = vi.fn();
    const dispatch = createCommandDispatcher({ selectVariant });
    expect(dispatch({ type: 'selectVariant', id: 'b' })).toEqual({ ok: true });
    expect(selectVariant).toHaveBeenCalledWith({ type: 'selectVariant', id: 'b' });
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
    expect(dispatch({ type: 'exportPdf' })).toEqual({
      ok: false,
      error: 'control not found: #download-pdf',
    });
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
      ['autoFallback', 'hasApiKey', 'theme', 'version']
    );
  });

  it('defaults to a shape Swift can decode when given nothing', () => {
    expect(buildSettings()).toEqual({
      theme: 'system', hasApiKey: false, autoFallback: false, version: '',
    });
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
