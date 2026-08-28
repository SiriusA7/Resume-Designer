/**
 * A focused NATIVE field has to reach the sync guards.
 *
 * Both guards ask the DOM: `interruptsLiveEditing` looks for an active
 * contentEditable, and `userProfileHolderBusy` asks a mounted React ref. Neither
 * can see a SwiftUI `@FocusState`, and the native screens keep their own draft
 * while focused — so a fetched unit passed the guard, the document or profile
 * was replaced underneath the field, and the next keystroke sent the pre-fetch
 * draft back as a fresh local edit over what had just been adopted.
 *
 * Asserted through the guards themselves rather than through the flag, because
 * the flag existing proves nothing about whether the sync layer consults it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerNativeProfileEditing, registerUserProfileHolder, userProfileHolderBusy,
} from '../src/userProfileHolder.js';

let nativeFocus;

beforeEach(() => {
  nativeFocus = { document: false, profile: false };
  registerNativeProfileEditing(() => nativeFocus.profile);
  registerUserProfileHolder(null);
});

describe('the profile guard', () => {
  it('is busy for a focused NATIVE field with no React holder mounted', () => {
    // On iOS the web dialog is not mounted at all, so the singleton holder is
    // null and used to answer "not busy" for every native edit.
    expect(userProfileHolderBusy()).toBe(false);
    nativeFocus.profile = true;
    expect(userProfileHolderBusy()).toBe(true);
  });

  it('goes quiet again on blur, rather than stalling every later adoption', () => {
    nativeFocus.profile = true;
    expect(userProfileHolderBusy()).toBe(true);
    nativeFocus.profile = false;
    expect(userProfileHolderBusy()).toBe(false);
  });

  it('still answers for the React holder, which iOS does not replace', () => {
    registerUserProfileHolder({ isBusy: () => true, adopt: () => {} });
    expect(userProfileHolderBusy()).toBe(true);
    registerUserProfileHolder(null);
  });
});

// NOT tested here: the résumé side's composition, which lives in main.js —
// `registerEditingProbe(() => getActiveInlineEditable() !== null ||
// nativeEditingBusy('document'))`. vitest does not cover main.js's wiring at
// all, and a test that rebuilt that expression locally would assert its own
// copy rather than the app's. What IS covered: the bridge records and scopes
// the focus (iosShell.test.js) and lint catches the undefined-global half.
