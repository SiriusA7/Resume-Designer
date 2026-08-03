import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  withPreviewSuppressed, isPreviewSuppressed, showInlineChanges,
  hideInlineChanges, decorateRenderedResume, initInlineChanges,
} from '../src/inlineChanges.js';
import { diffResumeData } from '../src/diffEngine.js';
import { applyPendingToData } from '../src/changePreview.js';

// The browser PDF fallback captures the LIVE DOM (html2pdf on #resume). While a
// proposal is under review that DOM shows the projection — proposed content the
// user has never accepted — and `.pdf-export-mode` only strips the highlight
// styling, not the text underneath. So an export taken mid-review silently
// wrote never-applied AI content into the user's PDF.
//
// withPreviewSuppressed turns the projection off, re-renders from stored data,
// and restores afterwards. The native desktop path is unaffected: it renders
// /print.html from stored data in a separate window.

const A = { id: 'a', company: 'Acme' };
const B = { id: 'b', company: 'Beta' };

const changeSet = () => ({
  changes: diffResumeData(
    { experience: [A, B] },
    { experience: [A, { ...B, company: 'PROPOSED' }] },
  ),
});

describe('preview suppression during export', () => {
  beforeEach(() => {
    hideInlineChanges();
  });

  it('suppresses even when no session exists at the start', async () => {
    expect(isPreviewSuppressed()).toBe(false);
    const seen = [];
    const out = await withPreviewSuppressed(async () => {
      seen.push(isPreviewSuppressed());
      return 'result';
    });
    expect(out).toBe('result');
    // The guard must cover the whole capture: the export is async, and a
    // session can appear mid-flight. Skipping the flag here would reopen the
    // very hole this closes.
    expect(seen).toEqual([true]);
    expect(isPreviewSuppressed()).toBe(false);
  });

  // The race: an AI request lands during the async import + capture.
  it('stays suppressed when a session starts mid-capture', async () => {
    const inside = [];
    await withPreviewSuppressed(async () => {
      inside.push(isPreviewSuppressed());
      // Proposal arrives while html2pdf is working.
      showInlineChanges(changeSet());
      inside.push(isPreviewSuppressed());
    });
    // Suppressed throughout, so the re-render showInlineChanges triggers cannot
    // project the proposal into the DOM being captured.
    expect(inside).toEqual([true, true]);
    expect(isPreviewSuppressed()).toBe(false);
  });

  it('restores the preview when the session appeared mid-capture', async () => {
    const rerender = vi.fn();
    initInlineChanges(rerender);
    rerender.mockClear();

    await withPreviewSuppressed(async () => {
      showInlineChanges(changeSet()); // renders once, suppressed
    });

    // The exit render must happen even though there was no session on entry,
    // or the user is left looking at stored data with a live review invisible.
    expect(rerender.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(isPreviewSuppressed()).toBe(false);
  });

  it('suppresses for the duration of the callback and restores after', async () => {
    showInlineChanges(changeSet());
    const seen = [];
    await withPreviewSuppressed(async () => { seen.push(isPreviewSuppressed()); });
    expect(seen).toEqual([true]);
    expect(isPreviewSuppressed()).toBe(false);
  });

  it('restores even when the export throws', async () => {
    showInlineChanges(changeSet());
    await expect(
      withPreviewSuppressed(async () => { throw new Error('capture failed'); }),
    ).rejects.toThrow('capture failed');
    // A failed export must not strand the user with the review invisible.
    expect(isPreviewSuppressed()).toBe(false);
  });

  it('re-renders on both edges so the DOM is rebuilt from stored data', async () => {
    const rerender = vi.fn();
    initInlineChanges(rerender);
    showInlineChanges(changeSet());
    rerender.mockClear();

    await withPreviewSuppressed(async () => {
      // One render already happened, with suppression on.
      expect(rerender).toHaveBeenCalledTimes(1);
      expect(isPreviewSuppressed()).toBe(true);
    });

    // …and one on the way out, restoring the preview.
    expect(rerender).toHaveBeenCalledTimes(2);
  });

  it('drops the change markers while suppressed', async () => {
    const cs = changeSet();
    showInlineChanges(cs);

    const root = document.createElement('div');
    root.innerHTML = '<span data-editable="experience[1].company"></span>';

    decorateRenderedResume(root, { experience: [{ ...A }, { ...B }] });
    expect(root.querySelector('[data-change-status]')).not.toBeNull();

    await withPreviewSuppressed(async () => {
      decorateRenderedResume(root, { experience: [{ ...A }, { ...B }] });
      // Nothing may carry a change marker into the capture.
      expect(root.querySelector('[data-change-status]')).toBeNull();
    });
  });

  // Guards the actual leak: the projection really does differ from storage.
  it('the projection contains content that is not in the stored data', () => {
    const data = { experience: [{ ...A }, { ...B }] };
    const projected = applyPendingToData(data, changeSet(), new Map());
    expect(projected.experience.map((e) => e.company)).toEqual(['Acme', 'PROPOSED']);
    expect(data.experience.map((e) => e.company)).toEqual(['Acme', 'Beta']);
  });
});
