import { describe, it, expect } from 'vitest';
import {
  assignBlocksToPages, overflowingPages, makeNode, flatten, buildColumnRecursive,
} from '../src/pagination.js';

describe('assignBlocksToPages', () => {
  const budgets = { firstPageContentPx: 250, pageContentPx: 300 };

  it('returns an empty array for no blocks', () => {
    expect(assignBlocksToPages([], budgets)).toEqual([]);
  });
  it('keeps blocks on page 0 until the first-page budget is exceeded', () => {
    expect(assignBlocksToPages([100, 100, 100], budgets)).toEqual([0, 0, 1]);
  });
  it('uses the larger per-page budget on pages after the first', () => {
    // page0: 100+100=200 (<=250); next 100 -> 300 > 250 -> page1. page1: 100,100,100=300 (<=300) ok.
    expect(assignBlocksToPages([100, 100, 100, 100, 100], budgets)).toEqual([0, 0, 1, 1, 1]);
  });
  it('gives an oversize block its own page (overflow allowed, never an empty page)', () => {
    expect(assignBlocksToPages([500, 100], { firstPageContentPx: 300, pageContentPx: 300 })).toEqual([0, 1]);
  });
  it('places a single block on page 0', () => {
    expect(assignBlocksToPages([100], budgets)).toEqual([0]);
  });
  it('never starts a new page for a block that fits exactly', () => {
    expect(assignBlocksToPages([250], budgets)).toEqual([0]);
    expect(assignBlocksToPages([250, 300], budgets)).toEqual([0, 1]);
  });
});

describe('overflowingPages', () => {
  it('flags a page whose single atomic block is taller than the sheet', () => {
    const budgets = { firstPageContentPx: 300, pageContentPx: 300 };
    const h = [500, 100];
    const assign = assignBlocksToPages(h, budgets); // [0, 1] — 500 gets page 0 alone
    expect([...overflowingPages(h, assign, budgets)]).toEqual([0]);
  });
  it('returns an empty set when every page fits its budget', () => {
    const budgets = { firstPageContentPx: 250, pageContentPx: 300 };
    const h = [100, 100, 100];
    const assign = assignBlocksToPages(h, budgets);
    expect([...overflowingPages(h, assign, budgets)]).toEqual([]);
  });
  it('does not flag an exact fit (float-drift epsilon)', () => {
    const budgets = { firstPageContentPx: 250, pageContentPx: 300 };
    expect([...overflowingPages([250], assignBlocksToPages([250], budgets), budgets)]).toEqual([]);
  });
  it('flags an oversize block on a later page, using that page\'s budget', () => {
    const budgets = { firstPageContentPx: 250, pageContentPx: 300 };
    const h = [100, 100, 400]; // page0: 100+100; page1: 400 alone (> 300)
    const assign = assignBlocksToPages(h, budgets);
    expect([...overflowingPages(h, assign, budgets)]).toEqual([1]);
  });
});

describe('buildColumnRecursive — sidebar wrapper preservation', () => {
  // Regression for the "bulleted Tools in a sidebar lose their wrapper on split"
  // bug: the two-level itemWrap (.sidebar-content > .tools-bulleted) must rebuild
  // BOTH wrappers, not collapse .tools-bulleted directly under .sidebar-section
  // (which would drop the .tools-list font/overflow styles in the paginated PDF).
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  };
  const buildSidebarToolsSection = () => {
    const section = el('div', 'sidebar-section');
    section.appendChild(el('div', 'sidebar-title', 'Tools'));
    const content = el('div', 'sidebar-content sidebar-skills tools-list');
    const bulleted = el('div', 'tools-bulleted');
    bulleted.appendChild(el('div', 'highlight-bullet', 'Photoshop'));
    bulleted.appendChild(el('div', 'highlight-bullet', 'Illustrator'));
    content.appendChild(bulleted);
    section.appendChild(content);
    return section;
  };

  it('captures the full wrapper chain (outer→inner) in makeNode', () => {
    const node = makeNode(buildSidebarToolsSection());
    expect(node.group).toBe(true);
    expect(node.wrapChain.map((w) => w.className)).toEqual([
      'sidebar-content sidebar-skills tools-list',
      'tools-bulleted',
    ]);
  });

  it('rebuilds a page with the .sidebar-content/tools-list wrapper intact', () => {
    const node = makeNode(buildSidebarToolsSection());
    const units = [];
    flatten(node, [], units);
    // mimic flowColumn's firstOf marking so heads/wrappers emit once
    const seen = new Set();
    for (const u of units) {
      u.firstOf = [];
      for (const g of u.chain) if (!seen.has(g)) { seen.add(g); u.firstOf.push(g); }
    }

    const target = document.createElement('div');
    buildColumnRecursive(target, units);

    // full chain preserved: section > sidebar-content.tools-list > tools-bulleted > bullets
    expect(
      target.querySelector('.sidebar-section > .sidebar-content.tools-list > .tools-bulleted > .highlight-bullet'),
    ).not.toBeNull();
    expect(target.querySelectorAll('.highlight-bullet')).toHaveLength(2);
    // and NOT the buggy flattened shape (.tools-bulleted directly under the section)
    expect(target.querySelector('.sidebar-section > .tools-bulleted')).toBeNull();
  });
});
