import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { whenOnboardingClosed, shouldShowOnboarding } from '../src/onboarding.js';

// Regression: the update / what's-new dialog used to open while the onboarding
// wizard was on screen. The Radix Dialog pointer-locks <body>, so the wizard
// (custom overlay, z-[3000]) painted on top but was completely inert until the
// hidden dialog behind it was dismissed by an overlay click. showUpdateNotes()
// now awaits whenOnboardingClosed() — these tests pin that gate's behavior.
describe('whenOnboardingClosed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('resolves immediately when the wizard is not on screen', async () => {
    await expect(whenOnboardingClosed()).resolves.toBeUndefined();
  });

  it('treats a fading-out wizard (show removed) as closed', async () => {
    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay'; // close started: `show` already dropped
    document.body.appendChild(overlay);

    await expect(whenOnboardingClosed()).resolves.toBeUndefined();
  });

  it('stays pending while the wizard is up and resolves after it closes', async () => {
    vi.useFakeTimers();
    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay show';
    document.body.appendChild(overlay);

    let settled = false;
    whenOnboardingClosed().then(() => { settled = true; });

    // Well past several poll ticks: still waiting while the wizard is open.
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);

    overlay.classList.remove('show');
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(true);
  });
});

// Regression (PR #89 finding 27): dismissing the wizard in an empty secondary
// profile wasn't durable — shouldShowOnboarding() returned true for a
// zero-variant profile BEFORE consulting the completed flag, so every later
// launch into that profile re-opened the wizard. The flag now wins outright.
describe('shouldShowOnboarding durability', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stays hidden after completion even with zero variants', () => {
    localStorage.setItem('resume-designer-onboarding-complete', 'true');
    expect(shouldShowOnboarding()).toBe(false);
  });

  it('still shows on a genuine fresh install (no flag, no variants)', () => {
    expect(shouldShowOnboarding()).toBe(true);
  });

  it('still shows when only built-in variants exist and no flag is set', () => {
    localStorage.setItem('resume-designer-data', JSON.stringify({
      variants: { b1: { builtIn: true, data: {} } },
    }));
    expect(shouldShowOnboarding()).toBe(true);
  });

  it('stays hidden when completed with only built-in variants', () => {
    localStorage.setItem('resume-designer-onboarding-complete', 'true');
    localStorage.setItem('resume-designer-data', JSON.stringify({
      variants: { b1: { builtIn: true, data: {} } },
    }));
    expect(shouldShowOnboarding()).toBe(false);
  });
});
