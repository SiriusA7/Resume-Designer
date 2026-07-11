// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { renderResume, renderResumeTimeline, renderResumeForLayout } from '../src/renderer.js';
import { EMPTY_RESUME } from '../src/store.js';

describe('renderResumeForLayout', () => {
  it('renders the default sidebar layout for "sidebar" and unknown layouts', () => {
    expect(renderResumeForLayout(EMPTY_RESUME, 'sidebar')).toBe(renderResume(EMPTY_RESUME));
    expect(renderResumeForLayout(EMPTY_RESUME, 'not-a-layout')).toBe(renderResume(EMPTY_RESUME));
    expect(renderResumeForLayout(EMPTY_RESUME, undefined)).toBe(renderResume(EMPTY_RESUME));
  });

  it('dispatches named layouts to their renderer', () => {
    expect(renderResumeForLayout(EMPTY_RESUME, 'timeline')).toBe(renderResumeTimeline(EMPTY_RESUME));
  });
});
