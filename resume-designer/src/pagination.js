/**
 * On-screen pagination: turn the just-rendered résumé into true page "sheets".
 *
 * The PURE core is assignBlocksToPages() — fully unit-tested. The DOM glue
 * (paginate + adapters, added in later tasks) MEASURES the rendered blocks and
 * MOVES the existing nodes into page-height sheets; it is verified in the
 * desktop app / browser preview, not under jsdom (which has no layout engine).
 */

import { pageDimsIn } from './pageSetup.js';
import { getZoom } from './zoomControls.js';

const PX_PER_IN = 96;

// Layout adapter map. `body` (single) = the wrapper whose direct children are
// blocks. For two-column layouts `grid`/`cols`/`bodyWrap`/`lead` are used.
const LAYOUTS = {
  stacked:            { family: 'single', body: '.stacked-body' },
  'stacked-vertical': { family: 'single', body: '.stacked-vertical-body' },
  classic:            { family: 'single', body: '.classic-body' },
  'classic-featured': { family: 'single', body: '.classic-featured-body' },
  creative:           { family: 'single', body: '.creative-body' },
  sidebar:        { family: 'two', grid: '.resume-body',        cols: ['.resume-sidebar', '.resume-main'] },
  'right-sidebar':{ family: 'two', grid: '.right-sidebar-body', cols: ['.resume-main', '.resume-sidebar'] },
  modern:         { family: 'two', grid: '.modern-body',        cols: ['.modern-sidebar', '.modern-main'] },
  timeline:       { family: 'two', grid: '.timeline-body',      cols: ['.timeline-main', '.timeline-sidebar'] },
  compact:        { family: 'two', bodyWrap: '.compact-body',   grid: '.compact-columns',   cols: ['.compact-main', '.compact-sidebar'] },
  executive:      { family: 'two', bodyWrap: '.executive-body', grid: '.executive-columns', cols: ['.executive-main', '.executive-side'], lead: '.executive-summary' },
};

/**
 * Greedy block-break assignment.
 * @param {number[]} blockHeightsPx - height (incl. inter-block gap) of each block, in order.
 * @param {{firstPageContentPx:number, pageContentPx:number}} budgets - usable content height per page
 *   (page 0 is smaller when a full-width header/lead sits on it).
 * @returns {number[]} page index (0-based) for each block.
 *
 * A block that overflows the current page starts a new page; a block taller than
 * a whole page gets its own page (content allowed to overflow the sheet bottom).
 * A new page is never started while the current page is still empty.
 */
export function assignBlocksToPages(blockHeightsPx, { firstPageContentPx, pageContentPx }) {
  const pages = [];
  let page = 0;
  let used = 0;
  let budget = firstPageContentPx;
  for (const h of blockHeightsPx) {
    if (used > 0 && used + h > budget) {
      page += 1;
      used = 0;
      budget = pageContentPx;
    }
    pages.push(page);
    used += h;
  }
  return pages;
}

/**
 * Page indices whose assigned units sum to more than that page's content budget —
 * i.e. a single atomic (non-breakable) block, or an unsplittable remainder, taller
 * than the sheet. assignBlocksToPages deliberately lets such a block overflow the
 * sheet bottom rather than emit a blank page, but a fixed-height sheet with
 * `overflow: hidden` would clip it. The paginator tags these sheets with
 * `.is-overflowing` so CSS can let just those grow (height:auto) instead of
 * cutting content off on screen and in the PDF.
 * @param {number[]} blockHeightsPx
 * @param {number[]} assign - page index per block (from assignBlocksToPages)
 * @param {{firstPageContentPx:number, pageContentPx:number}} budgets
 * @returns {Set<number>} 0-based page indices that overflow their budget.
 */
export function overflowingPages(blockHeightsPx, assign, { firstPageContentPx, pageContentPx }) {
  const used = [];
  for (let i = 0; i < assign.length; i++) used[assign[i]] = (used[assign[i]] || 0) + blockHeightsPx[i];
  const out = new Set();
  // +0.5 epsilon so sub-pixel float drift on an exact fit doesn't flag a sheet.
  used.forEach((u, p) => { if (u > (p === 0 ? firstPageContentPx : pageContentPx) + 0.5) out.add(p); });
  return out;
}

// --- measurement (getBoundingClientRect is VISUAL px; divide by the zoom scale
// on .resume-container to recover layout px) ---

function computedV(el, prop) {
  const v = parseFloat(getComputedStyle(el)[prop]);
  return Number.isFinite(v) ? v : 0;
}
// Vertical padding of a content wrapper (column/body), applied on every sheet.
function vPadding(el) {
  return computedV(el, 'paddingTop') + computedV(el, 'paddingBottom');
}
// Outer height incl. vertical margins (for the header / lead band).
function rectOuterH(el, scale) {
  return el.getBoundingClientRect().height / scale + computedV(el, 'marginTop') + computedV(el, 'marginBottom');
}

// --- recursive flow model: break long containers (experience/education/sidebar
// sections, AND experience entries between their bullets) so pages fill tightly.
// Each container's "head" (section title / entry header) rides with its first
// child and is never repeated on continuation pages. ---

// A splittable container → how to find its head + its items (the items live
// directly under itemWrap, or under the element itself when itemWrap is null).
// Items may themselves be splittable (an entry splits into its bullets).
function splittableConfig(el) {
  if (!el.classList) return null;
  if (el.classList.contains('experience-section')) {
    const tl = el.querySelector(':scope > .timeline-container');
    return { head: [':scope > .section-title'], itemWrap: tl ? ':scope > .timeline-container' : null,
             itemSel: tl ? ':scope > .timeline-item' : ':scope > .experience-item' };
  }
  if (el.classList.contains('experience-item')) {
    return { head: [':scope > .experience-header', ':scope > .experience-dates'],
             itemWrap: ':scope > .experience-bullets', itemSel: ':scope > li' };
  }
  if (el.classList.contains('education-section')) {
    return { head: [':scope > .section-title'], itemWrap: ':scope > .education-content', itemSel: ':scope > p' };
  }
  if (el.classList.contains('sidebar-section')) {
    const content = el.querySelector(':scope > .sidebar-content');
    // Bulleted tools/highlights: split on the .highlight-bullet blocks (inside the
    // .tools-bulleted wrapper for tools, or directly under .sidebar-content).
    if (content && content.querySelector(':scope > .tools-bulleted > .highlight-bullet')) {
      return { head: [':scope > .sidebar-title'], itemWrap: ':scope > .sidebar-content > .tools-bulleted', itemSel: ':scope > .highlight-bullet' };
    }
    // Inline skills/tools render as .skill-tag-row spans with .skill-sep / <wbr>
    // separators BETWEEN them (not <p>). Treat every direct child as a unit so the
    // section flows across pages and the separators ride along, instead of the whole
    // section being an unsplittable block that overflows/clips a fixed-size sheet.
    if (content && (content.classList.contains('sidebar-skills') || content.querySelector(':scope > .skill-tag-row'))) {
      return { head: [':scope > .sidebar-title'], itemWrap: ':scope > .sidebar-content', itemSel: ':scope > *' };
    }
    return { head: [':scope > .sidebar-title'], itemWrap: ':scope > .sidebar-content', itemSel: ':scope > p' };
  }
  // Inline Tools (renderToolsInline) wrap EVERY .tool-token in a single
  // .skill-tag-row, so the sidebar-section split above sees that row as one
  // atomic child. Make the row itself splittable on its tokens (+ separators) so
  // a long inline Tools list flows across sidebar pages instead of being clipped.
  // Skills phrase-rows carry no .tool-token and stay atomic — phrases never break.
  if (el.classList.contains('skill-tag-row') && el.querySelector(':scope > .tool-token')) {
    return { head: [], itemWrap: null, itemSel: ':scope > *' };
  }
  return null;
}

// Build a flow node: a GROUP (splittable: head + child nodes) or a LEAF (atomic).
// Falls back to a leaf when the container has nothing to split (e.g. no bullets).
export function makeNode(el) {
  const cfg = splittableConfig(el);
  if (!cfg) return { group: false, el };
  const wrapEl = cfg.itemWrap ? el.querySelector(cfg.itemWrap) : el;
  const items = wrapEl ? Array.from(wrapEl.querySelectorAll(cfg.itemSel)) : [];
  if (items.length < 1) return { group: false, el };
  const head = cfg.head.map((s) => el.querySelector(s)).filter(Boolean);
  // The FULL wrapper chain from `el`'s child down to itemWrap (outer→inner), so a
  // rebuilt page reproduces every intermediate wrapper — e.g. the
  // `.sidebar-content.tools-list` around `.tools-bulleted` — and keeps its styles
  // (font-size, line-height, overflow-wrap), not just the innermost itemWrap element.
  let wrapChain = null;
  if (wrapEl && wrapEl !== el) {
    wrapChain = [];
    for (let w = wrapEl; w && w !== el; w = w.parentElement) wrapChain.unshift(w);
  }
  return { group: true, el, head, wrapChain, children: items.map(makeNode) };
}

// Flatten the tree to leaf UNITS in document order, each carrying its chain of
// ancestor groups; firstOf marks the groups a unit opens (so heads emit once).
export function flatten(node, chain, out) {
  if (!node.group) { out.push({ leaf: node.el, chain }); return; }
  const ch = chain.concat([node]);
  for (const child of node.children) flatten(child, ch, out);
}
function flowColumn(containerEl, scale) {
  const units = [];
  for (const child of Array.from(containerEl.children)) flatten(makeNode(child), [], units);
  const seen = new Set();
  for (const u of units) {
    u.firstOf = [];
    for (const g of u.chain) if (!seen.has(g)) { seen.add(g); u.firstOf.push(g); }
  }
  return { units, heights: measureUnits(units, scale) };
}

// A unit's vertical slot starts at the top of the OUTERMOST group it opens (so
// the slot includes that group's head + top padding), else at the leaf itself.
function unitTopEl(u) { return u.firstOf.length ? u.firstOf[0].el : u.leaf; }
function measureUnits(units, scale) {
  const tops = units.map((u) => unitTopEl(u).getBoundingClientRect().top);
  const out = [];
  for (let i = 0; i < units.length; i++) {
    out.push(i < units.length - 1
      ? (tops[i + 1] - tops[i]) / scale
      : (units[i].leaf.getBoundingClientRect().bottom - tops[i]) / scale);
  }
  return out;
}

// Rebuild a column from the units assigned to one page. Group wrappers are cloned
// and reused while consecutive units share them; a group's head is emitted only
// on the page where the group first appears (no repeated titles/entry headers).
export function buildColumnRecursive(targetEl, units) {
  let open = []; // [{ group, content }] — currently-open cloned chain, outer→inner
  for (const u of units) {
    let common = 0;
    while (common < open.length && common < u.chain.length && open[common].group === u.chain[common]) common++;
    open = open.slice(0, common);
    for (let d = common; d < u.chain.length; d++) {
      const group = u.chain[d];
      const clone = group.el.cloneNode(false);
      // Don't let a rebuilt section grow to fill the sheet. The résumé uses
      // `.experience-section { flex: 1 }` to bottom-anchor education on a single
      // page; across paginated sheets that growth would shove trailing content
      // (e.g. Education) to the bottom of the last page. Paginated content flows
      // top-down — the leftover space belongs at the bottom of the sheet.
      clone.style.flex = '0 0 auto';
      if (u.firstOf.includes(group)) for (const h of group.head) clone.appendChild(h);
      let content = clone;
      if (group.wrapChain) {
        for (const wrap of group.wrapChain) { const w = wrap.cloneNode(false); content.appendChild(w); content = w; }
      }
      (d === 0 ? targetEl : open[d - 1].content).appendChild(clone);
      open.push({ group, content });
    }
    (open.length ? open[open.length - 1].content : targetEl).appendChild(u.leaf);
  }
}

// --- sheet builders ---
function makePagesContainer() {
  const el = document.createElement('div');
  el.className = 'resume-pages';
  return el;
}
function makeSheet(widthPx, heightPx) {
  const page = document.createElement('div');
  page.className = 'resume-page';
  page.style.width = `${widthPx}px`;
  if (heightPx == null) page.classList.add('is-continuous');
  else page.style.height = `${heightPx}px`;
  return page;
}
function grow(el) { el.style.flex = '1 1 auto'; el.style.minHeight = '0'; return el; }

// Remove the paginated state from the long-lived containers — used when the
// preview falls back to the non-paginated empty state (no résumé loaded).
export function resetPaginatedState(resumeEl) {
  if (!resumeEl) return;
  resumeEl.classList.remove('is-paginated');
  resumeEl.style.width = '';
  resumeEl.closest('.resume-container')?.classList.remove('is-paginated');
}

/**
 * Paginate the just-rendered résumé in place.
 * @param {HTMLElement} resumeEl - the #resume element (its children are header + body).
 * @param {{pageSize,orientation,pageWidthIn}} setup - from the store accessors.
 * @param {string} layoutId - the active layout (passed in; not read from the DOM).
 */
export function paginate(resumeEl, setup, layoutId) {
  if (!resumeEl) return;
  const cfg = LAYOUTS[layoutId] || LAYOUTS.sidebar;
  const { widthIn, heightIn } = pageDimsIn(setup);
  const widthPx = Math.round(widthIn * PX_PER_IN);
  const heightPx = heightIn == null ? null : Math.round(heightIn * PX_PER_IN);
  const scale = getZoom() || 1;

  // Enter paginated state (idempotent; persists across re-renders on the
  // long-lived #resume / #resume-container elements).
  resumeEl.classList.add('is-paginated');
  const container = resumeEl.closest('.resume-container');
  if (container) container.classList.add('is-paginated');
  // !important so the print/PDF mode's `.resume { width: 8.5in !important }`
  // can't override the real sheet width while we measure the columns.
  resumeEl.style.setProperty('width', `${widthPx}px`, 'important');

  if (heightPx == null) { paginateContinuous(resumeEl, widthPx); return; }
  if (cfg.family === 'single') paginateSingle(resumeEl, cfg, widthPx, heightPx, scale);
  else paginateTwo(resumeEl, cfg, widthPx, heightPx, scale);
}

// Continuous: one open-height sheet, no splitting. Works for every layout.
function paginateContinuous(resumeEl, widthPx) {
  const kids = Array.from(resumeEl.childNodes);
  const pages = makePagesContainer();
  const page = makeSheet(widthPx, null);
  kids.forEach((k) => page.appendChild(k));
  pages.appendChild(page);
  resumeEl.replaceChildren(pages);
}

function paginateSingle(resumeEl, cfg, widthPx, heightPx, scale) {
  const header = resumeEl.querySelector(`:scope > .resume-header`);
  const body = resumeEl.querySelector(`:scope > ${cfg.body}`);
  if (!body) { paginateContinuous(resumeEl, widthPx); return; }

  const { units, heights } = flowColumn(body, scale);
  if (!units.length) { paginateContinuous(resumeEl, widthPx); return; }
  const headerH = header ? rectOuterH(header, scale) : 0;
  const pad = vPadding(body);
  const pageContentPx = Math.max(1, heightPx - pad);
  const firstPageContentPx = Math.max(1, pageContentPx - headerH);
  const assign = assignBlocksToPages(heights, { firstPageContentPx, pageContentPx });
  const overflow = overflowingPages(heights, assign, { firstPageContentPx, pageContentPx });
  const numPages = Math.max(1, (assign[assign.length - 1] ?? 0) + 1);

  const pages = makePagesContainer();
  for (let p = 0; p < numPages; p++) {
    const page = makeSheet(widthPx, heightPx);
    if (overflow.has(p)) page.classList.add('is-overflowing');
    if (p === 0 && header) page.appendChild(header);
    const bodyClone = body.cloneNode(false); // shallow: keep classes, drop children
    grow(bodyClone);
    buildColumnRecursive(bodyClone, units.filter((_, i) => assign[i] === p));
    page.appendChild(bodyClone);
    pages.appendChild(page);
  }
  resumeEl.replaceChildren(pages);
}

// Two-column: paginate the sidebar and main columns INDEPENDENTLY, then build
// per-page grids. Cloning the grid + each column (shallow) preserves grid-template,
// CSS `order`, and the sidebar background (which fills each sheet). The full-width
// header and any lead band (executive summary) sit on sheet 1 only.
function paginateTwo(resumeEl, cfg, widthPx, heightPx, scale) {
  const header = resumeEl.querySelector(':scope > .resume-header');
  const bodyWrap = cfg.bodyWrap ? resumeEl.querySelector(`:scope > ${cfg.bodyWrap}`) : null;
  const gridHost = bodyWrap || resumeEl;
  const grid = gridHost.querySelector(`:scope > ${cfg.grid}`);
  if (!grid) { paginateContinuous(resumeEl, widthPx); return; }

  const leadEls = cfg.lead && bodyWrap ? Array.from(bodyWrap.querySelectorAll(`:scope > ${cfg.lead}`)) : [];
  const colEls = cfg.cols.map((sel) => grid.querySelector(`:scope > ${sel}`)).filter(Boolean);
  if (colEls.length < 2) { paginateContinuous(resumeEl, widthPx); return; }

  const headerH = header ? rectOuterH(header, scale) : 0;
  const leadH = leadEls.reduce((s, el) => s + rectOuterH(el, scale), 0);

  const cols = colEls.map((col) => {
    const { units, heights } = flowColumn(col, scale);
    const pageContentPx = Math.max(1, heightPx - vPadding(col));
    const firstPageContentPx = Math.max(1, pageContentPx - headerH - leadH);
    const assign = assignBlocksToPages(heights, { firstPageContentPx, pageContentPx });
    return { col, units, assign, heights, firstPageContentPx, pageContentPx };
  });
  const numPages = Math.max(1, ...cols.map(({ assign }) => (assign[assign.length - 1] ?? 0) + 1));
  // A sheet overflows if EITHER column's content exceeds its budget on that page.
  const overflow = new Set();
  cols.forEach(({ heights, assign, firstPageContentPx, pageContentPx }) =>
    overflowingPages(heights, assign, { firstPageContentPx, pageContentPx }).forEach((p) => overflow.add(p)));

  const pages = makePagesContainer();
  for (let p = 0; p < numPages; p++) {
    const page = makeSheet(widthPx, heightPx);
    if (overflow.has(p)) page.classList.add('is-overflowing');
    if (p === 0 && header) page.appendChild(header);

    // Rebuild the body-wrapper chain (compact/executive) so its CSS + lead apply.
    let mount = page;
    if (bodyWrap) {
      const bw = bodyWrap.cloneNode(false);
      bw.style.display = 'flex';
      bw.style.flexDirection = 'column';
      grow(bw);
      if (p === 0) leadEls.forEach((el) => bw.appendChild(el));
      page.appendChild(bw);
      mount = bw;
    }

    const gridClone = grid.cloneNode(false); // keep grid-template + classes
    grow(gridClone);
    cols.forEach(({ col, units, assign }) => {
      const colClone = col.cloneNode(false); // keep column classes (sidebar bg, order)
      buildColumnRecursive(colClone, units.filter((_, i) => assign[i] === p));
      gridClone.appendChild(colClone);
    });
    mount.appendChild(gridClone);
    pages.appendChild(page);
  }
  resumeEl.replaceChildren(pages);
}
