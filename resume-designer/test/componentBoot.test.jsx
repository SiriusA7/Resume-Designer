import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { ConfirmHost } from '@/components/ui/confirm';
import { UpdateNotesHost } from '@/components/ui/updateNotes.jsx';
import { DeleteVariantThreadsHost } from '../src/components/chat/DeleteVariantThreadsDialog.jsx';
import { ExperienceDateEditorHost } from '../src/components/experience/ExperienceDateEditorHost.jsx';
import Header from '../src/components/Header.jsx';
import SettingsDialog from '../src/components/SettingsDialog.jsx';
import HistoryDialog from '../src/components/HistoryDialog.jsx';
import DiffDialog from '../src/components/DiffDialog.jsx';
import PdfDialog from '../src/components/PdfDialog.jsx';
import StructurePanel from '../src/components/structure/StructurePanel.jsx';
import ChatPanel from '../src/components/chat/ChatPanel.jsx';
import ProfileDialog from '../src/components/profile/ProfileDialog.jsx';
import JobsDialog from '../src/components/jobs/JobsDialog.jsx';
import LibraryDialog from '../src/components/library/LibraryDialog.jsx';
import OnboardingWizard from '../src/components/onboarding/OnboardingWizard.jsx';

/**
 * Every component App.jsx mounts at startup, rendered once.
 *
 * This exists because the suite could not render a component at all, and a
 * component that threw on EVERY render therefore shipped: OnboardingWizard
 * named `workspaceGone` in a hook dependency array 34 lines above its
 * `useState`, so the array — which is evaluated during render — read a `const`
 * still in its temporal dead zone. React never mounted, the web layer published
 * no snapshot, and the iOS app came up with no profiles and no résumés.
 *
 * Deliberately asserts only "does not throw". These components own dialogs,
 * portals and storage; asserting what they LOOK like would make this brittle
 * and it would stop being run. The bug class it exists to catch kills the
 * render outright, which "does not throw" catches exactly.
 *
 * Verified against the bug: restore the pre-fix OnboardingWizard and this fails
 * with `ReferenceError: Cannot access 'workspaceGone' before initialization` —
 * the same error the device threw.
 */
const MOUNTED_AT_STARTUP = [
  ['OnboardingWizard', OnboardingWizard],
  ['Header', Header],
  ['SettingsDialog', SettingsDialog],
  ['HistoryDialog', HistoryDialog],
  ['DiffDialog', DiffDialog],
  ['PdfDialog', PdfDialog],
  ['StructurePanel', StructurePanel],
  ['ChatPanel', ChatPanel],
  ['ProfileDialog', ProfileDialog],
  ['JobsDialog', JobsDialog],
  ['LibraryDialog', LibraryDialog],
  ['ConfirmHost', ConfirmHost],
  ['UpdateNotesHost', UpdateNotesHost],
  ['DeleteVariantThreadsHost', DeleteVariantThreadsHost],
  ['ExperienceDateEditorHost', ExperienceDateEditorHost],
];

describe('every component App mounts at startup renders', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '<div id="root"></div><div id="header-bar"></div>';
  });

  it.each(MOUNTED_AT_STARTUP)('%s renders without throwing', (_name, Component) => {
    expect(() => render(<Component />)).not.toThrow();
  });
});
