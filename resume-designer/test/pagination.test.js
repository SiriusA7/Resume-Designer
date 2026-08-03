import { describe, it, expect } from 'vitest';
import {
  assignBlocksToPages, overflowingPages, makeNode, flatten, buildColumnRecursive,
  revealGroupContinuations,
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

describe('buildColumnRecursive — grouped experience survives pagination', () => {
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  };

  // One solo entry plus a two-role run — the mix is the point: a whitelist bug
  // drops only the grouped members, so a run-only fixture can pass while real
  // resumes lose jobs.
  const buildExperienceSection = () => {
    const section = el('div', 'experience-section');
    section.appendChild(el('div', 'section-title', 'Experience'));

    const makeItem = (id, cls, withHeader) => {
      const item = el('article', cls);
      item.dataset.experienceId = id;
      if (withHeader) item.appendChild(el('div', 'experience-group-header', 'Acme Corporation'));
      const header = el('div', 'experience-header');
      header.appendChild(el('h3', 'experience-title', id));
      item.appendChild(header);
      item.appendChild(el('time', 'experience-dates', '2020 – 2024'));
      const ul = el('ul', 'experience-bullets');
      ul.appendChild(el('li', null, 'a bullet'));
      item.appendChild(ul);
      return item;
    };

    section.appendChild(makeItem('exp-lead', 'experience-item is-grouped is-group-lead', true));
    section.appendChild(makeItem('exp-second', 'experience-item is-grouped', false));
    section.appendChild(makeItem('exp-solo', 'experience-item', false));
    return section;
  };

  const rebuild = (section) => {
    const node = makeNode(section);
    const units = [];
    flatten(node, [], units);
    const seen = new Set();
    for (const u of units) {
      u.firstOf = [];
      for (const g of u.chain) if (!seen.has(g)) { seen.add(g); u.firstOf.push(g); }
    }
    const target = document.createElement('div');
    buildColumnRecursive(target, units);
    return target;
  };

  it('keeps every experience entry after a rebuild', () => {
    const target = rebuild(buildExperienceSection());
    const ids = [...target.querySelectorAll('[data-experience-id]')].map((n) => n.dataset.experienceId);
    expect(ids).toEqual(['exp-lead', 'exp-second', 'exp-solo']);
  });

  it('keeps the company header, above the lead role', () => {
    const target = rebuild(buildExperienceSection());
    const header = target.querySelector('.experience-group-header');
    expect(header).not.toBeNull();
    expect(header.textContent).toBe('Acme Corporation');
    const lead = target.querySelector('[data-experience-id="exp-lead"]');
    expect(lead.contains(header)).toBe(true);
    expect(lead.firstElementChild.className).toBe('experience-group-header');
  });

  it('keeps every bullet', () => {
    const target = rebuild(buildExperienceSection());
    expect(target.querySelectorAll('.experience-bullets li')).toHaveLength(3);
  });
});

describe('revealGroupContinuations', () => {
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  };

  // A grouped role as it appears after Task 2's renderer: company present but hidden.
  const groupedRole = (id, withHeader) => {
    const item = el('article', withHeader ? 'experience-item is-grouped is-group-lead' : 'experience-item is-grouped');
    item.dataset.experienceId = id;
    if (withHeader) item.appendChild(el('div', 'experience-group-header', 'Acme Corporation'));
    const header = el('div', 'experience-header');
    header.appendChild(el('h3', 'experience-title', id));
    header.appendChild(el('span', 'experience-company', 'Acme Corporation'));
    item.appendChild(header);
    return item;
  };

  const page = (...children) => {
    const p = el('div', 'resume-page');
    children.forEach((c) => p.appendChild(c));
    return p;
  };

  it('reveals the company on a grouped role that starts a later page', () => {
    const p1 = page(groupedRole('r1', true));
    const p2 = page(groupedRole('r2', false));
    revealGroupContinuations([p1, p2]);
    expect(p2.querySelector('.experience-company').classList.contains('is-continuation')).toBe(true);
  });

  it('does not reveal anything on the page that already has the header', () => {
    const p1 = page(groupedRole('r1', true), groupedRole('r2', false));
    revealGroupContinuations([p1]);
    expect(p1.querySelectorAll('.experience-company.is-continuation')).toHaveLength(0);
  });

  it('reveals only the FIRST grouped role on a continuation page', () => {
    const p1 = page(groupedRole('r1', true));
    const p2 = page(groupedRole('r2', false), groupedRole('r3', false));
    revealGroupContinuations([p1, p2]);
    expect(p2.querySelectorAll('.experience-company.is-continuation')).toHaveLength(1);
    expect(p2.querySelector('.experience-company.is-continuation').closest('[data-experience-id]').dataset.experienceId)
      .toBe('r2');
  });

  it('leaves ungrouped entries alone', () => {
    const solo = el('article', 'experience-item');
    solo.dataset.experienceId = 'solo';
    const header = el('div', 'experience-header');
    header.appendChild(el('span', 'experience-company', 'Initech'));
    solo.appendChild(header);
    const p2 = page(solo);
    revealGroupContinuations([page(), p2]);
    expect(p2.querySelectorAll('.is-continuation')).toHaveLength(0);
  });

  it('is a no-op for a single page', () => {
    const p1 = page(groupedRole('r1', true), groupedRole('r2', false));
    revealGroupContinuations([p1]);
    expect(p1.querySelectorAll('.is-continuation')).toHaveLength(0);
  });
});
