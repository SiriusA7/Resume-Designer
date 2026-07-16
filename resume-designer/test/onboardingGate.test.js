import { describe, it, expect, vi, afterEach } from 'vitest';

import { whenOnboardingClosed } from '../src/onboarding.js';

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
