import { describe, it, expect } from 'vitest';
import { renderExperienceEntries } from '../src/renderer.js';

const e = (title, company, dates, extra = {}) => ({ title, company, dates, bullets: ['did a thing'], ...extra });

const parse = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

describe('renderExperienceEntries — ungrouped', () => {
  it('renders a solo entry with no marker classes and no group header', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')]));
    const item = host.querySelector('.experience-item');
    expect(item.classList.contains('is-grouped')).toBe(false);
    expect(item.classList.contains('is-group-lead')).toBe(false);
    expect(host.querySelector('.experience-group-header')).toBeNull();
  });

  it('keeps the company editable on a solo entry', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')]));
    expect(host.querySelector('.experience-company').dataset.editable).toBe('experience[0].company');
  });

  it('addresses bullets by the flat path grammar', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')]));
    expect(host.querySelector('.experience-bullets li').dataset.editable).toBe('experience[0].bullets[0]');
  });
});

describe('renderExperienceEntries — grouped', () => {
  const twoRoles = [
    e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
    e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
  ];

  it('emits sibling .experience-item nodes with no wrapper element', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    expect(host.querySelectorAll(':scope > .experience-item')).toHaveLength(2);
    expect(host.querySelector('.experience-group')).toBeNull();
  });

  it('marks the lead and every member', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const items = host.querySelectorAll('.experience-item');
    expect(items[0].classList.contains('is-group-lead')).toBe(true);
    expect(items[0].classList.contains('is-grouped')).toBe(true);
    expect(items[1].classList.contains('is-group-lead')).toBe(false);
    expect(items[1].classList.contains('is-grouped')).toBe(true);
  });

  it('puts the group header FIRST inside the lead item (pagination head order)', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const lead = host.querySelector('.experience-item');
    expect(lead.firstElementChild.className).toBe('experience-group-header');
    expect(lead.firstElementChild.textContent.trim()).toBe('Acme');
  });

  it('points the header at a real leaf path and lists the run indices', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const header = host.querySelector('.experience-group-header');
    expect(header.dataset.editable).toBe('experience[0].company');
    expect(header.dataset.editableGroup).toBe('0,1');
  });

  it('keeps each role company in the DOM but NOT editable', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const companies = host.querySelectorAll('.experience-item .experience-company');
    expect(companies).toHaveLength(2);
    companies.forEach((node) => expect(node.dataset.editable).toBeUndefined());
  });

  it('leaves per-role titles, dates and bullets on their own flat paths', () => {
    const host = parse(renderExperienceEntries(twoRoles));
    const items = host.querySelectorAll('.experience-item');
    expect(items[1].querySelector('.experience-title').dataset.editable).toBe('experience[1].title');
    expect(items[1].querySelector('.experience-dates').dataset.editable).toBe('experience[1].dates');
    expect(items[1].querySelector('li').dataset.editable).toBe('experience[1].bullets[0]');
  });

  it('marks the last role of a run so the divider to the next employer survives', () => {
    // The run is NOT the last thing in the list — the case where a :last-child
    // rule would silently strip the boundary between Acme and Initech.
    const host = parse(renderExperienceEntries([...twoRoles, e('Intern', 'Initech', '2018')]));
    const items = host.querySelectorAll('.experience-item');
    expect(items[0].classList.contains('is-group-last')).toBe(false);
    expect(items[1].classList.contains('is-group-last')).toBe(true);
    // Only the non-final run member may have its separator suppressed.
    const suppressed = host.querySelectorAll('.experience-item.is-grouped:not(.is-group-last)');
    expect([...suppressed].map((n) => n.dataset.experienceId)).toEqual([items[0].dataset.experienceId]);
  });

  it('renders a solo entry that follows a run without marker classes', () => {
    const host = parse(renderExperienceEntries([...twoRoles, e('Intern', 'Initech', '2018')]));
    const items = host.querySelectorAll('.experience-item');
    expect(items[2].classList.contains('is-grouped')).toBe(false);
    expect(items[2].querySelector('.experience-company').dataset.editable).toBe('experience[2].company');
  });
});

describe('renderExperienceEntries — timeline variant', () => {
  it('emits .timeline-item siblings and a group header on the lead', () => {
    const host = parse(renderExperienceEntries([
      e('Senior Dev', 'Acme', 'Mar 2022 – Jun 2024', { _groupId: 'g1' }),
      e('Dev', 'Acme', 'Jan 2019 – Mar 2022', { _groupId: 'g1' }),
    ], 'timeline'));
    expect(host.querySelectorAll(':scope > .timeline-item')).toHaveLength(2);
    expect(host.querySelector('.timeline-item .experience-group-header')).not.toBeNull();
  });

  it('renders a solo timeline entry unchanged', () => {
    const host = parse(renderExperienceEntries([e('Dev', 'Acme', '2019 – 2022')], 'timeline'));
    expect(host.querySelector('.timeline-item').classList.contains('is-grouped')).toBe(false);
    expect(host.querySelector('.experience-group-header')).toBeNull();
  });
});
