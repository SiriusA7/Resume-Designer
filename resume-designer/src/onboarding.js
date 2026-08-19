/**
 * Onboarding wizard bridge.
 *
 * The first-run wizard is now a React component
 * (src/components/onboarding/OnboardingWizard.jsx) that listens for the
 * `rd:open-onboarding` / `rd:close-onboarding` window events dispatched here. This
 * thin module preserves the original ES exports so the still-vanilla callers keep
 * working unchanged:
 *
 *   - main.js                  → shouldShowOnboarding() + showOnboardingWizard()
 *                                (300ms first-run check) and window.showOnboardingWizard
 *   - components/Header.jsx     → window.showOnboardingWizard({ skipApiKeyStep: true })
 *   - components/SettingsDialog → window.showOnboardingWizard()  ("Replay welcome")
 *
 * shouldShowOnboarding / completeOnboarding / resetOnboarding stay here as pure
 * flag logic (no DOM) — they read variants + an appStorage key and are imported
 * directly by the boot code and the wizard component. The wizard's AI/parse/save
 * logic lives in src/onboardingLogic.js.
 */
import { getVariants } from './persistence.js';
import { appStorage } from './appStorage.js';
import { isInitialProfileFetchPending } from './profiles.js';

const ONBOARDING_KEY = 'resume-designer-onboarding-complete';

/**
 * Check if onboarding should be shown.
 * @returns {boolean}
 */
export function shouldShowOnboarding() {
  // A known account's registry is not proof that its active workspace is empty:
  // the profile-zone fetch follows later. Opening now can snapshot a
  // non-dismissible wizard over content that lands milliseconds afterward.
  if (isInitialProfileFetchPending()) return false;

  // Honor the "completed" flag FIRST — completion (including an explicit
  // dismissal via the wizard's X) is durable even for a profile with no user
  // variants yet. Checked before the zero-variant test below, which would
  // otherwise re-open the wizard on every launch into a dismissed empty
  // profile; the empty-state canvas covers that case instead.
  if (appStorage.getItem(ONBOARDING_KEY) === 'true') return false;

  const variants = getVariants();
  const variantList = Object.values(variants);

  // Always show on a fresh install (no variants at all).
  if (variantList.length === 0) return true;

  // Show if only built-in variants exist (no user-created ones).
  return variantList.every((v) => v.builtIn);
}

/** Mark onboarding as complete. */
export function completeOnboarding() {
  appStorage.setItem(ONBOARDING_KEY, 'true');
}

/** Reset onboarding (for testing). */
export function resetOnboarding() {
  appStorage.removeItem(ONBOARDING_KEY);
}

/**
 * Show the onboarding wizard.
 * @param {Object} options
 * @param {boolean} options.skipApiKeyStep - Skip the API-key step (new-resume mode)
 */
export function showOnboardingWizard(options = {}) {
  window.dispatchEvent(new CustomEvent('rd:open-onboarding', { detail: options }));
}

/** Close the onboarding wizard. */
export function closeOnboardingWizard() {
  window.dispatchEvent(new CustomEvent('rd:close-onboarding'));
}

// `.onboarding-overlay.show` is the wizard's "on screen" contract token (same
// one styles/onboarding.css keys off); `show` drops the instant a close
// starts, so a fading-out wizard already counts as closed.
const ONBOARDING_OPEN_SELECTOR = '.onboarding-overlay.show';
const ONBOARDING_CLOSE_POLL_MS = 400;

/**
 * Resolve once the onboarding wizard is neither on screen NOR due to open
 * (immediately if both hold). Used by the update / what's-new dialog: opening
 * a modal Radix Dialog while the wizard is up pointer-locks <body>, leaving
 * the wizard painted on top (z-[3000]) but completely inert until the hidden
 * dialog underneath is dismissed by an overlay click. Deferring the dialog
 * until the wizard closes sequences the two instead of stacking them.
 *
 * "Due to open" (the shouldShowOnboarding() term) matters because main.js
 * launches the changelog/update checks BEFORE its 300ms first-run timer — a
 * fast check would find no overlay yet, open the dialog, and the wizard would
 * then mount on top of it, recreating exactly the stacking this gate exists
 * to prevent. That timer opens the wizard iff shouldShowOnboarding(), and the
 * flag goes durably false on completion or an explicit dismissal — so if the
 * user leaves a due wizard unfinished, the dialog simply stays deferred to a
 * later launch rather than interrupting setup.
 */
/** Whether the wizard is on screen, which is the DOM's answer and not a flag. */
export function isOnboardingOpen() {
  return !!document.querySelector(ONBOARDING_OPEN_SELECTOR);
}

export function whenOnboardingClosed() {
  const blocked = () =>
    !!document.querySelector(ONBOARDING_OPEN_SELECTOR)
    || isInitialProfileFetchPending()
    || shouldShowOnboarding();
  if (!blocked()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!blocked()) {
        clearInterval(timer);
        resolve();
      }
    }, ONBOARDING_CLOSE_POLL_MS);
  });
}
