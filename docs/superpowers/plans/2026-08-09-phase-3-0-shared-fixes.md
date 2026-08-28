# Phase 3.0 — Shared Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seven defects that are latent bugs in the shipping macOS app *and* blockers for the iOS UI — so the Mac improves before any iOS-specific work begins.

**Architecture:** No new subsystems. Two CSS corrections, one transition-suppression flag that fixes a measurement race, and three pure-function extractions that make previously-untestable maths unit-testable in the style `test/pagination.test.js` already establishes.

**Tech Stack:** Vanilla JS services (`.js`, no TypeScript), React 19 + shadcn/Radix for chrome, Tailwind 3, vitest + jsdom, Vite 8.

**Spec:** [`../specs/2026-08-09-ios-ui-redesign-design.md`](../specs/2026-08-09-ios-ui-redesign-design.md) — increment **3.0** in its staging table.

## Global Constraints

- **Never commit, push, or open a PR without being explicitly asked.**
- Conventional commits, subject starts **lowercase**. Commitlint runs on every commit in a PR.
- **FROZEN, never rename:** bundle id `com.resumedesigner.app`; Cargo package name `resume-designer`; every `resume-designer-*` / `resume-*` storage key.
- **Never sweep on the bare string `resume-`** — it also names the `.resume-page` / `.resume-sidebar` CSS classes that pagination and PDF page-splitting depend on.
- Brand is **"On Paper"** — two words, title case — in all prose and display copy.
- shadcn/ui here is the real thing. Extend the actual primitives in `src/components/ui/`; never hand-roll lookalikes.
- **`npm test` alone is not a gate.** It covers only service modules — broken imports or JSX in `src/components/**` pass a green suite. Always also run `npx vite build`.
- ClaudePreview is Chromium; the shipped app is WKWebView. Flexbox overflow (Task 1) is engine-agnostic and may be measured in preview; anything scroll- or transition-sensitive is confirmed in `npm run tauri:dev`.

## Two spec corrections this plan applies

1. **The spec says "`applyTextCommand` already has the markdown wrappers."** It does not exist. `toggleBoldMarkdown` is a local function at `src/inlineEditor.js:1120` and there is no italic/underline equivalent. Task 4 generalises it.
2. **The spec lists the `pagination.js` divisor and the `.is-zooming` wobble as separate items.** They are one defect — `pagination.js` already divides by `getZoom()` correctly (`:326`, `:93-94`, `:192-198`); the race is that `getBoundingClientRect()` reports in-flight values during the 0.2 s transition. Task 3 fixes both.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `resume-designer/styles/main.css:869-891` | Scroller overflow + container centring | 1 |
| `resume-designer/styles/main.css:1466-1674` | *Delete* dead media-query ladder | 6 |
| `resume-designer/src/zoomControls.js` | Export pure `computeFitZoom`; read computed padding; auto-fit on resize | 2 |
| `resume-designer/src/zoomControls.js` | `.is-zooming` suppression around programmatic zoom | 3 |
| `resume-designer/src/inlineEditor.js` | Export `toggleMarkdownMarker` + `serializeEmphasis`; Cmd+I/U | 4, 5 |
| `resume-designer/src/components/ui/dialog.jsx`, `alert-dialog.jsx` | Max height + scroll | 7 |
| `resume-designer/src/main.js:1052` | Drop deprecated `navigator.platform` | 6 |
| `resume-designer/test/zoomControls.test.js` | *New* — pure zoom maths | 2 |
| `resume-designer/test/inlineEditorFormat.test.js` | *New* — emphasis round-trip + marker toggling | 4, 5 |

---

### Task 1: Make the résumé's left margin reachable (B1)

**Files:**
- Modify: `resume-designer/styles/main.css:869-891`

**Interfaces:**
- Consumes: nothing.
- Produces: a scroller whose full content width is reachable. Task 2's `fitToView` measurements assume this.

**The defect.** `.resume-scroller` is `display:flex; justify-content:center; overflow:auto` wrapping a `flex-shrink:0; min-width:8.5in` child. A centred flex item wider than its scrollport overflows on **both** sides, and start-side overflow is not in the scrollable region in any engine — so the left portion of the page cannot be scrolled to. Phase 0 measured the signature exactly: `resumeRect x=-207`, which is `(402 − 816) / 2`. **This is broken on macOS too**, in any window narrow enough to crop the page.

- [ ] **Step 1: Reproduce and measure**

```bash
cd resume-designer && npm run dev
```

Open `http://localhost:3000`, narrow the window until the page is cropped, then in the browser console:

```js
const r = document.getElementById('resume').getBoundingClientRect();
console.log({ x: Math.round(r.x), width: Math.round(r.width),
              scrollLeft: document.getElementById('resume-scroller').scrollLeft });
```

Expected before the fix: **negative `x`**, and `scrollLeft` cannot be reduced below 0 to reveal it.

- [ ] **Step 2: Apply the fix**

In `resume-designer/styles/main.css`, change `.resume-scroller`'s `justify-content` and add centring to `.resume-container`:

```css
.resume-scroller {
  flex: 1;
  padding: var(--space-xl);
  padding-top: 32px;
  padding-bottom: 100px; /* Space for bottom toolbar */
  overflow: auto; /* Scroll both directions */
  display: flex;
  /* NOT `center`: a centred flex item wider than the scrollport overflows on
     BOTH sides, and start-side overflow is not scrollable in any engine — the
     left edge of the page becomes unreachable. Centring is done by the child's
     auto margins instead, which stay inside the scrollable region. */
  justify-content: flex-start;
  align-items: flex-start;
}

.resume-container {
  width: 8.5in;
  min-width: 8.5in;
  margin-inline: auto; /* centres when there is room; no-ops when cropped */
  background: white;
  border-radius: 4px;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.05),
    0 10px 40px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  overflow: hidden;
  transform-origin: top center;
  transition: transform 0.2s ease;
}
```

- [ ] **Step 3: Verify the measurement flips**

Re-run the console snippet from Step 1 in a narrow window.
Expected: `x` is **0 or positive**, and the full width is reachable by scrolling.
Then widen the window past 8.5in and confirm the page is still **centred** (auto margins take over).

- [ ] **Step 4: Confirm in the real shell**

```bash
cd resume-designer && npm run tauri:dev
```

Narrow the window, scroll to the left edge of the page, confirm the left margin is reachable and the page re-centres when widened. This is a WKWebView confirmation of a Chromium measurement.

- [ ] **Step 5: Verify nothing else moved**

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: 964 tests pass, 0 lint errors, build succeeds.

- [ ] **Step 6: Commit (ask first)**

```bash
git add resume-designer/styles/main.css
git commit -m "fix(layout): make the resume's left margin reachable when cropped"
```

---

### Task 2: Extract and test the fit-to-view maths; read real padding; auto-fit

**Files:**
- Modify: `resume-designer/src/zoomControls.js`
- Create: `resume-designer/test/zoomControls.test.js`

**Interfaces:**
- Consumes: Task 1's reachable scroller.
- Produces: `export function computeFitZoom({ availableWidth, availableHeight, contentWidth, contentHeight, minZoom, maxZoom }): number` and `export function fitToView(): void`. Task 3 wraps `setZoom`/`fitToView` in the `.is-zooming` flag. Phase 3.3 will lower `MIN_ZOOM` against these same tests.

**Three defects.** `fitToView` subtracts **hardcoded** padding (`- 64` and `- 96`) while the CSS uses `var(--space-xl)` plus `32px`/`100px`, so it is wrong today and wrong at every future breakpoint. It is not exported, so nothing can call it. And nothing listens for `resize` or `orientationchange`, so the app opens at whatever zoom was last saved — on iOS, a zoom synced from a Mac.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/zoomControls.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computeFitZoom } from '../src/zoomControls.js';

const LETTER_W = 8.5 * 96;   // 816
const SHEET_H  = 11 * 96;    // 1056

describe('computeFitZoom', () => {
  it('fits width when width is the binding constraint', () => {
    // 402pt phone, 24px padding each side -> 354 available
    const z = computeFitZoom({
      availableWidth: 354, availableHeight: 2000,
      contentWidth: LETTER_W, contentHeight: SHEET_H,
    });
    expect(z).toBeCloseTo(354 / LETTER_W, 5);
  });

  it('fits height when height is the binding constraint', () => {
    const z = computeFitZoom({
      availableWidth: 2000, availableHeight: 528,
      contentWidth: LETTER_W, contentHeight: SHEET_H,
    });
    expect(z).toBeCloseTo(528 / SHEET_H, 5);
  });

  it('never exceeds maxZoom', () => {
    const z = computeFitZoom({
      availableWidth: 5000, availableHeight: 5000,
      contentWidth: LETTER_W, contentHeight: SHEET_H,
      maxZoom: 2,
    });
    expect(z).toBe(2);
  });

  it('clamps to minZoom, which means a long resume does NOT fully fit', () => {
    // Documented limitation, not desired behaviour: a 4-sheet resume needs
    // ~0.22 but MIN_ZOOM is 0.25. Phase 3.3 lowers MIN_ZOOM; this test pins
    // today's behaviour so that change is visible when it happens.
    const z = computeFitZoom({
      availableWidth: 354, availableHeight: 700,
      contentWidth: LETTER_W, contentHeight: SHEET_H * 4,
      minZoom: 0.25,
    });
    expect(z).toBe(0.25);
  });

  it('returns 1 for unmeasurable input rather than NaN or 0', () => {
    expect(computeFitZoom({ availableWidth: 0, availableHeight: 0,
                            contentWidth: 0, contentHeight: 0 })).toBe(1);
    expect(computeFitZoom({ availableWidth: NaN, availableHeight: 100,
                            contentWidth: 100, contentHeight: 100 })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd resume-designer && npx vitest run test/zoomControls.test.js
```

Expected: FAIL — `computeFitZoom` is not exported from `../src/zoomControls.js`.

- [ ] **Step 3: Add the pure function**

In `resume-designer/src/zoomControls.js`, immediately below the `ZOOM_STEP` constant:

```js
/**
 * Pure fit-to-view maths, extracted so it can be unit-tested without a DOM.
 * All measurements are in CSS px at scale 1.
 *
 * Returns 1 (not 0 or NaN) for unmeasurable input, so a failed measurement
 * leaves the canvas where it is instead of collapsing it.
 */
export function computeFitZoom({
  availableWidth,
  availableHeight,
  contentWidth,
  contentHeight,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
}) {
  const ok = (n) => Number.isFinite(n) && n > 0;
  if (!ok(availableWidth) || !ok(availableHeight) || !ok(contentWidth) || !ok(contentHeight)) {
    return 1;
  }
  const fit = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);
  return Math.min(Math.max(fit, minZoom), maxZoom);
}
```

- [ ] **Step 4: Run the test again**

```bash
cd resume-designer && npx vitest run test/zoomControls.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite `fitToView` to use it, read real padding, and export it**

Replace the whole existing `function fitToView() { … }` in `resume-designer/src/zoomControls.js` with:

```js
// Fit resume to available view space
export function fitToView() {
  const scroller = document.getElementById('resume-scroller');
  const container = document.getElementById('resume-container');

  if (!scroller || !container) return;

  // Measure at scale 1 so scrollHeight is the true, unscaled height.
  container.style.transform = 'scale(1)';
  container.offsetHeight; // force reflow

  // clientWidth/Height INCLUDE padding, so subtract the real computed values
  // rather than the constants the CSS used to have. Padding is driven by
  // var(--space-xl) and will change again in 3.2.
  const cs = getComputedStyle(scroller);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

  setZoom(computeFitZoom({
    availableWidth: scroller.clientWidth - padX,
    availableHeight: scroller.clientHeight - padY,
    contentWidth: 8.5 * 96,
    contentHeight: container.scrollHeight || 11 * 96,
  }));
}
```

- [ ] **Step 6: Auto-fit on viewport change**

Inside `initZoomControls()`, immediately before its closing brace, add:

```js
  // The window can change size at any time — a resized Mac window, a rotated
  // phone, an iPad Split View drag. Refit rather than leaving a stale zoom.
  // Debounced because a Split View drag fires continuously.
  let refitTimer = null;
  const scheduleRefit = () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(fitToView, 150);
  };
  window.addEventListener('resize', scheduleRefit);
  window.addEventListener('orientationchange', scheduleRefit);
```

- [ ] **Step 7: Verify**

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: **969** tests pass (964 + 5 new), 0 lint errors, build succeeds.

Then `npm run tauri:dev`, resize the window, and confirm the page refits without needing the fit button.

- [ ] **Step 8: Commit (ask first)**

```bash
git add resume-designer/src/zoomControls.js resume-designer/test/zoomControls.test.js
git commit -m "fix(zoom): measure real padding, export fit-to-view, and refit on resize"
```

---

### Task 3: Suppress the zoom transition during programmatic zoom

**Files:**
- Modify: `resume-designer/src/zoomControls.js`
- Modify: `resume-designer/styles/main.css` (`.resume-container` rule from Task 1)

**Interfaces:**
- Consumes: Task 2's `fitToView` / `setZoom`.
- Produces: the guarantee that `getBoundingClientRect()` and `getZoom()` agree during a repaginate. Phase 3.3's column zoom depends on it.

**One defect, two symptoms.** `.resume-container` has `transition: transform 0.2s ease`. `fitToView` sets `scale(1)` to measure and then sets the fitted scale — **through** that transition, which is the visible out-and-back wobble on every fit click on the Mac. The same transition breaks measurement: `pagination.js` divides `getBoundingClientRect()` values by `getZoom()` (`:326`, `:93-94`, `:192-198`), but during the 0.2 s animation the rect is the *in-flight* size while `getZoom()` returns the *target* — so a repaginate landing mid-transition computes wrong page breaks. On desktop, today.

- [ ] **Step 1: Add the suppression class to CSS**

In `resume-designer/styles/main.css`, immediately after the `.resume-container` rule:

```css
/* Programmatic zoom (fit-to-view, and 3.3's column zoom) must be instantaneous:
   the transition makes getBoundingClientRect() report in-flight values while
   getZoom() reports the target, which makes pagination.js measure wrongly. It
   is also what causes the visible out-and-back wobble on fit-to-view. */
.resume-container.is-zooming {
  transition: none;
}
```

- [ ] **Step 2: Wrap programmatic zoom in the flag**

In `resume-designer/src/zoomControls.js`, add this helper above `applyZoom`:

```js
/**
 * Run a zoom mutation with the CSS transition suppressed, then restore it on
 * the next frame. Without this, measurement during the 0.2s transition
 * disagrees with getZoom() — see the .is-zooming comment in main.css.
 */
function withoutTransition(container, fn) {
  if (!container) { fn(); return; }
  container.classList.add('is-zooming');
  fn();
  container.offsetHeight; // commit the change before re-enabling
  requestAnimationFrame(() => container.classList.remove('is-zooming'));
}
```

Then in `applyZoom`, replace the transform assignment:

```js
  if (container) {
    withoutTransition(container, () => {
      container.style.transform = `scale(${currentZoom})`;
    });
  }
```

And in `fitToView`, wrap the measurement so the temporary `scale(1)` never animates. Replace the two measurement lines:

```js
  // Measure at scale 1 so scrollHeight is the true, unscaled height.
  container.classList.add('is-zooming');
  container.style.transform = 'scale(1)';
  container.offsetHeight; // force reflow
```

`applyZoom`'s own `withoutTransition` then removes the class on the next frame.

- [ ] **Step 3: Verify the wobble is gone**

```bash
cd resume-designer && npm run tauri:dev
```

Click the fit-to-view button repeatedly. Expected: the page snaps to the fitted size with **no** visible shrink-then-grow. Before this change it visibly bounces.

- [ ] **Step 4: Verify pagination is unaffected in the steady state**

With a résumé long enough to paginate (2+ sheets), click fit-to-view and confirm page breaks land in the same places as before. Then `npm test` — `test/pagination.test.js` must stay green.

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: 969 tests pass, 0 lint errors, build succeeds.

- [ ] **Step 5: Commit (ask first)**

```bash
git add resume-designer/src/zoomControls.js resume-designer/styles/main.css
git commit -m "fix(zoom): suppress the transform transition during programmatic zoom"
```

---

### Task 4: Generalise markdown emphasis toggling and add Cmd+I / Cmd+U

**Files:**
- Modify: `resume-designer/src/inlineEditor.js` (`toggleBoldMarkdown` at `:1120`, `toggleBoldInEditable` at `:1077`, `handleKeyDown` at `:997-1001`)
- Create: `resume-designer/test/inlineEditorFormat.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function toggleMarkdownMarker(value: string, start: number, end: number, marker: string): { value: string, start: number, end: number }`. Task 5 adds `serializeEmphasis` to the same test file.

**The defect.** Cmd+B works (`:997-1001`). Cmd+I and Cmd+U do not exist, on any platform — even though the renderer already understands `_italic_` and `++underline++` (`serializeEmphasis` at `:933-939` reads all three). **Correction to the spec:** there is no `applyTextCommand`; `toggleBoldMarkdown` is a local function with `**` hardcoded, so it must be generalised first.

- [ ] **Step 1: Write the failing test**

Create `resume-designer/test/inlineEditorFormat.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { toggleMarkdownMarker } from '../src/inlineEditor.js';

describe('toggleMarkdownMarker', () => {
  it('wraps a selection in the marker', () => {
    expect(toggleMarkdownMarker('hello world', 0, 5, '**'))
      .toEqual({ value: '**hello** world', start: 2, end: 7 });
  });

  it('unwraps an already-wrapped selection', () => {
    expect(toggleMarkdownMarker('**hello** world', 2, 7, '**'))
      .toEqual({ value: 'hello world', start: 0, end: 5 });
  });

  it('works for italic with a single-character marker', () => {
    expect(toggleMarkdownMarker('hello world', 6, 11, '_'))
      .toEqual({ value: 'hello _world_', start: 7, end: 12 });
  });

  it('works for underline', () => {
    expect(toggleMarkdownMarker('hello', 0, 5, '++'))
      .toEqual({ value: '++hello++', start: 2, end: 7 });
  });

  it('leaves an empty selection untouched', () => {
    expect(toggleMarkdownMarker('hello', 2, 2, '**'))
      .toEqual({ value: 'hello', start: 2, end: 2 });
  });

  it('does not confuse bold and italic markers', () => {
    // A `_`-toggle over text already bolded must add italics, not strip bold.
    expect(toggleMarkdownMarker('**hi**', 2, 4, '_'))
      .toEqual({ value: '**_hi_**', start: 3, end: 5 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd resume-designer && npx vitest run test/inlineEditorFormat.test.js
```

Expected: FAIL — `toggleMarkdownMarker` is not exported.

- [ ] **Step 3: Generalise the toggler**

In `resume-designer/src/inlineEditor.js`, replace the existing `function toggleBoldMarkdown(value, start, end) { … }` (at `:1120`) with:

```js
/**
 * Toggle a markdown emphasis marker around [start, end) of `value`.
 * Marker is the literal wrapper: '**' bold, '_' italic, '++' underline.
 * Exported for unit testing; the DOM wrapper is toggleMarkerInEditable.
 */
export function toggleMarkdownMarker(value, start, end, marker) {
  if (start === end) return { value, start, end };
  const len = marker.length;
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);

  // Already wrapped by this exact marker? Unwrap.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -len) + selected + after.slice(len),
      start: start - len,
      end: end - len,
    };
  }
  return {
    value: `${before}${marker}${selected}${marker}${after}`,
    start: start + len,
    end: end + len,
  };
}
```

- [ ] **Step 4: Run the test again**

```bash
cd resume-designer && npx vitest run test/inlineEditorFormat.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Point the DOM wrapper at it and generalise the caller**

Rename `toggleBoldInEditable` to `toggleMarkerInEditable` and give it a `marker` parameter. Replace the whole function at `:1077`:

```js
function toggleMarkerInEditable(editable, marker) {
  // Skip structural rich text nodes that are reconstructed by specialized extractors.
  if (editable.querySelector('.skill-tag, .skill-tag-inline, .highlight-bullet')) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return;

  const start = getTextOffset(editable, range.startContainer, range.startOffset);
  const end = getTextOffset(editable, range.endContainer, range.endOffset);
  const result = toggleMarkdownMarker(editable.textContent || '', start, end, marker);

  editable.textContent = result.value;
  setSelectionInEditable(editable, result.start, result.end);
}
```

- [ ] **Step 6: Wire all three shortcuts**

In `handleKeyDown`, replace the existing Cmd+B block (`:997-1001`) with:

```js
  const modKey = e.metaKey || e.ctrlKey;
  if (modKey && !e.altKey) {
    // '**' bold, '_' italic, '++' underline — the same markers serializeEmphasis reads.
    const marker = { b: '**', i: '_', u: '++' }[e.key.toLowerCase()];
    if (marker) {
      e.preventDefault();
      toggleMarkerInEditable(editable, marker);
      return;
    }
  }
```

- [ ] **Step 7: Verify**

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: **975** tests pass (969 + 6 new), 0 lint errors, build succeeds.

Then `npm run tauri:dev`: select text in a résumé bullet and press Cmd+B, Cmd+I, Cmd+U in turn. Each should wrap the selection and pressing again should unwrap it.

- [ ] **Step 8: Commit (ask first)**

```bash
git add resume-designer/src/inlineEditor.js resume-designer/test/inlineEditorFormat.test.js
git commit -m "feat(editor): add cmd+i and cmd+u by generalising the markdown toggler"
```

---

### Task 5: Stop dropping emphasis that WebKit inserted

**Files:**
- Modify: `resume-designer/src/inlineEditor.js:933-939`
- Modify: `resume-designer/test/inlineEditorFormat.test.js`

**Interfaces:**
- Consumes: Task 4's test file.
- Produces: `export function serializeEmphasis(el: Element): string`.

**The defect.** `serializeEmphasis` queries only `strong`, `em`, `u`. WebKit's own `execCommand` — which fires from the iPad shortcut bar and from macOS's Edit menu — inserts `<b>` and `<i>`. Those are silently dropped on the next round trip, on macOS today.

- [ ] **Step 1: Add the failing tests**

Append to `resume-designer/test/inlineEditorFormat.test.js`:

```js
import { serializeEmphasis } from '../src/inlineEditor.js';

function el(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('serializeEmphasis', () => {
  it('re-applies markers for semantic tags', () => {
    expect(serializeEmphasis(el('Led <strong>infra</strong> work'))).toBe('Led **infra** work');
    expect(serializeEmphasis(el('Led <em>infra</em> work'))).toBe('Led _infra_ work');
    expect(serializeEmphasis(el('Led <u>infra</u> work'))).toBe('Led ++infra++ work');
  });

  it('re-applies markers for the presentational tags WebKit execCommand inserts', () => {
    expect(serializeEmphasis(el('Led <b>infra</b> work'))).toBe('Led **infra** work');
    expect(serializeEmphasis(el('Led <i>infra</i> work'))).toBe('Led _infra_ work');
  });

  it('returns plain text unchanged', () => {
    expect(serializeEmphasis(el('Led infra work'))).toBe('Led infra work');
  });
});
```

- [ ] **Step 2: Run and watch the `<b>`/`<i>` cases fail**

```bash
cd resume-designer && npx vitest run test/inlineEditorFormat.test.js
```

Expected: the semantic-tag and plain-text tests pass; the `<b>`/`<i>` test **fails** (markers not applied). `serializeEmphasis` is also not exported yet, so expect an import error first — add the `export` keyword, then re-run to see the real failure.

- [ ] **Step 3: Widen the selectors and export**

Replace the function at `:933-939`:

```js
// Re-apply markdown emphasis (**bold**, _italic_, ++underline++) onto an element's
// plain text from its rendered children, so a round-trip through contentEditable
// doesn't silently drop formatting. Shared by bullet lists and tool chips.
//
// `b`/`i` are included alongside `strong`/`em` because WebKit's own execCommand —
// the iPad shortcut bar, and macOS's Edit menu — inserts the presentational tags.
// Querying only the semantic ones dropped that formatting on every round trip.
export function serializeEmphasis(el) {
  let result = (el.textContent || '').trim();
  el.querySelectorAll('strong, b').forEach((n) => { const t = n.textContent; if (t) result = result.replace(t, `**${t}**`); });
  el.querySelectorAll('em, i').forEach((n) => { const t = n.textContent; if (t) result = result.replace(t, `_${t}_`); });
  el.querySelectorAll('u').forEach((n) => { const t = n.textContent; if (t) result = result.replace(t, `++${t}++`); });
  return result;
}
```

- [ ] **Step 4: Run the tests again**

```bash
cd resume-designer && npx vitest run test/inlineEditorFormat.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Verify**

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: **978** tests pass, 0 lint errors, build succeeds.

- [ ] **Step 6: Commit (ask first)**

```bash
git add resume-designer/src/inlineEditor.js resume-designer/test/inlineEditorFormat.test.js
git commit -m "fix(editor): keep emphasis inserted as b and i tags on round trip"
```

---

### Task 6: Remove the dead media-query ladder and the deprecated platform sniff

**Files:**
- Modify: `resume-designer/styles/main.css:1466-1674` (delete)
- Modify: `resume-designer/src/main.js:1052`

**Interfaces:**
- Consumes: nothing.
- Produces: a stylesheet with no dead responsive rules, so Phase 3.2's container queries are the single source of layout truth.

**Two defects.** `main.css:1466-1671` is a media-query ladder whose `--chat-panel-width` overrides are dead: `ChatPanel.jsx:44-48` sets that property as an **inline style on `:root`**, which outranks any `@media { :root { … } }` rule. Roughly 200 lines actively misrepresent what the shell does. `:1674`'s `.header-actions > *` rule is also dead. Separately, `main.js:1052` derives the modifier key from the deprecated `navigator.platform`, while two other handlers in the same codebase already use `e.metaKey || e.ctrlKey`.

- [ ] **Step 1: Confirm the ladder is genuinely dead before deleting**

```bash
cd resume-designer
sed -n '1466,1674p' styles/main.css > /tmp/dead-ladder.css
grep -c "" /tmp/dead-ladder.css
grep -n "setProperty('--chat-panel-width'" src/components/chat/ChatPanel.jsx
```

Read `/tmp/dead-ladder.css`. **Any rule that is NOT a `--chat-panel-width` / `--structure-panel-width` override on `:root` must be kept** — move it above the deleted range rather than losing it. Record in the commit body what you kept and why.

- [ ] **Step 2: Delete the dead range**

Remove lines 1466-1674 of `resume-designer/styles/main.css`, re-inserting anything Step 1 identified as live.

- [ ] **Step 3: Fix the platform sniff**

In `resume-designer/src/main.js`, replace lines 1052-1053:

```js
    // metaKey on Apple platforms, ctrlKey elsewhere — accepting either avoids a
    // deprecated navigator.platform read and matches the two other handlers in
    // this file. No shortcut in this block uses both.
    const modKey = e.metaKey || e.ctrlKey;
```

- [ ] **Step 4: Verify the desktop layout is untouched**

```bash
cd resume-designer && npx vite build && npm run tauri:dev
```

Open and close both the chat and structure panels; resize the window across the widths the deleted ladder claimed to target (1400, 1200, 1024, 900, 768). Expected: **no visual difference from before** — the rules were dead. Confirm undo (Cmd+Z) and redo still work.

- [ ] **Step 5: Verify**

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: 978 tests pass, 0 lint errors, build succeeds.

- [ ] **Step 6: Commit (ask first)**

```bash
git add resume-designer/styles/main.css resume-designer/src/main.js
git commit -m "refactor(css): delete the dead media-query ladder and the platform sniff"
```

---

### Task 7: Stop dialogs clipping on short windows

**Files:**
- Modify: `resume-designer/src/components/ui/dialog.jsx:32`
- Modify: `resume-designer/src/components/ui/alert-dialog.jsx:30`

**Interfaces:**
- Consumes: nothing.
- Produces: dialogs that scroll instead of clipping. Phase 3.2's sheet work assumes this baseline.

**The defect.** Both `Content` primitives are `fixed top-[50%] translate-y-[-50%]` with **no max height and no overflow**. On a short laptop window — or any phone — `PdfDialog` and `DiffDialog` are clipped top and bottom with no way to scroll to the buttons.

- [ ] **Step 1: Add max height and scrolling to `DialogContent`**

In `resume-designer/src/components/ui/dialog.jsx`, in the `cn(...)` call at line 32, insert `max-h-[90dvh] overflow-y-auto` immediately after `max-w-lg`:

```jsx
        "fixed left-[50%] top-[50%] z-[1000] grid w-full max-w-lg max-h-[90dvh] overflow-y-auto translate-x-[-50%] translate-y-[-50%] gap-4 rounded-[14px] border bg-background p-6 shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
```

`dvh` rather than `vh` so the software keyboard is accounted for on iOS — the same reason Phase 3.1 replaces the `100vh` shell heights.

- [ ] **Step 2: Do the same for `AlertDialogContent`**

In `resume-designer/src/components/ui/alert-dialog.jsx` at line 30, insert the same two classes after `max-w-lg`:

```jsx
        "fixed left-[50%] top-[50%] z-[1000] grid w-full max-w-lg max-h-[90dvh] overflow-y-auto translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
```

- [ ] **Step 3: Verify against the dialogs that actually overflow**

```bash
cd resume-designer && npm run tauri:dev
```

Resize the window to roughly 700 px tall, then open **Settings**, the **PDF export** dialog, and a **Diff** review. Each must scroll internally with its action buttons reachable. Also confirm a short dialog (a destructive confirm) is **not** stretched — `max-h` is a ceiling, not a height.

- [ ] **Step 4: Verify**

```bash
cd resume-designer && npm test && npm run lint && npx vite build
```

Expected: 978 tests pass, 0 lint errors, build succeeds.

- [ ] **Step 5: Commit (ask first)**

```bash
git add resume-designer/src/components/ui/dialog.jsx resume-designer/src/components/ui/alert-dialog.jsx
git commit -m "fix(ui): give dialogs a max height so they scroll instead of clipping"
```

---

## Exit criteria for 3.0

- [ ] `npm test` — **978** passing (964 baseline + 5 zoom + 9 format)
- [ ] `npm run lint` — 0 errors
- [ ] `npx vite build` — succeeds
- [ ] `cargo check`, `cargo clippy -- -D warnings`, `cargo check --target aarch64-apple-ios` — all clean
- [ ] The résumé's left margin is reachable in a narrow window, verified in `tauri:dev`
- [ ] Fit-to-view no longer wobbles, and refits on window resize
- [ ] Cmd+B / Cmd+I / Cmd+U all toggle in a résumé bullet
- [ ] Settings, PDF and Diff dialogs scroll in a ~700 px-tall window
- [ ] No visual change to the desktop shell from the CSS deletion

## What 3.0 deliberately does NOT do

Per the spec's staging, these belong to later increments and must not creep in:
safe area and `viewport-fit=cover`; `visualViewport` keyboard inset; `autocorrect`
attributes; the coarse-pointer 44 pt target floor; the onboarding skip path;
container queries and the compact/regular shell; `sheet.jsx` adoption; the
segmented switcher; the structure-panel drawer; column zoom and
`transform-origin: 0 0`; lowering `MIN_ZOOM`; the AI Apply/Reject touch surface.
