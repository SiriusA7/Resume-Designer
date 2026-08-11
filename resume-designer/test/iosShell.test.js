import { describe, it, expect, vi } from 'vitest';
import {
  buildSettings,
  buildSnapshot,
  createCommandDispatcher,
  hasOpenModal,
  isNativeShellAvailable,
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
