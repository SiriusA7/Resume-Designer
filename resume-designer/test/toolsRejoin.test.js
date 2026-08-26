import { describe, it, expect, beforeEach } from 'vitest';
import { extractEditedValue } from '../src/inlineEditor.js';

/**
 * Editing one tool chip rewrites the WHOLE `tools` string from its siblings,
 * because every chip shares the one `data-editable="tools"` path. Pagination
 * then splits that list across pages, and each page gets its own
 * `.tools-bulleted` wrapper — so a re-join scoped to the wrapper collects only
 * the chips on the page that was clicked and writes a truncated string over the
 * full one.
 *
 * Measured on a real résumé: 18 tools became 8. Everything from the page break
 * onwards — Git, Android XR, Magic Leap 1/2, HoloLens 1/2, Meta Quest, LLM
 * APIs…, Adobe Creative Suite, Kotlin, Jetpack Compose — was silently deleted by
 * bolding one word on page one.
 *
 * Pagination MOVES the chips (the wrappers are `cloneNode(false)`, the leaves
 * are appended), so each chip exists exactly once in the document and a
 * document-wide re-join cannot double-count.
 */
function paginatedTools(pages) {
  document.body.innerHTML = `<div id="resume-container">${
    pages.map((chips) => `
      <div class="resume-page"><div class="sidebar-content"><div class="tools-bulleted">${
        chips.map((c) => `<span class="highlight-bullet" data-editable="tools">${c}</span>`).join('')
      }</div></div></div>`).join('')
  }</div>`;
  return document.querySelectorAll('.highlight-bullet[data-editable="tools"]');
}

describe('re-joining tool chips across a page break', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('keeps the tools that paginated onto a later page', () => {
    const chips = paginatedTools([['Unity', 'C#', 'Swift'], ['Git', 'Kotlin']]);
    // Edit a chip on page ONE — the page whose wrapper the old scope found.
    expect(extractEditedValue(chips[0], 'tools')).toBe('Unity • C# • Swift • Git • Kotlin');
  });

  it('keeps them when the edited chip is on the later page', () => {
    const chips = paginatedTools([['Unity', 'C#'], ['Git', 'Kotlin', 'Rust']]);
    expect(extractEditedValue(chips[3], 'tools')).toBe('Unity • C# • Git • Kotlin • Rust');
  });

  it('still works when the list fits on one page', () => {
    const chips = paginatedTools([['Unity', 'C#', 'Swift']]);
    expect(extractEditedValue(chips[1], 'tools')).toBe('Unity • C# • Swift');
  });
});
