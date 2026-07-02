import { useEffect, useRef, useState } from 'react';
import shellHtml from './shell/appShell.html?raw';
import { Toaster } from '@/components/ui/sonner';
import { ConfirmHost } from '@/components/ui/confirm';
import { UpdateNotesHost } from '@/components/ui/updateNotes.jsx';
import { DeleteVariantThreadsHost } from './components/chat/DeleteVariantThreadsDialog.jsx';
import Header from './components/Header.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import HistoryDialog from './components/HistoryDialog.jsx';
import DiffDialog from './components/DiffDialog.jsx';
import PdfDialog from './components/PdfDialog.jsx';
import StructurePanel from './components/structure/StructurePanel.jsx';
import ChatPanel from './components/chat/ChatPanel.jsx';
import ProfileDialog from './components/profile/ProfileDialog.jsx';
import JobsDialog from './components/jobs/JobsDialog.jsx';
import OnboardingWizard from './components/onboarding/OnboardingWizard.jsx';
import { init } from './main.js';
import { whenStorageReady } from './appStorage.js';

// Single-root migration shell.
//
// React renders an empty container and injects the existing vanilla chrome
// skeleton (panels, toggles, hidden PDF button, empty header placeholder) into
// it ONCE. The markup is app-controlled and fixed at build time (a ?raw import
// of the former index.html body), NOT user input. The vanilla init() then wires
// every still-vanilla module against that markup exactly as it did when the
// markup lived in index.html. Regions are carved out into real React components
// one at a time (Steps 5-7), shrinking this hosted blob.
//
// React never re-renders the container's contents (it has no JSX children), so
// it won't clobber the injected DOM — the same contract renderCurrentResume
// relies on for #resume. The container is display:contents (and #root too, see
// shadcn.css) so `.app` keeps its body-level layout.
//
// App is the root, mounted once, never unmounted, and not wrapped in
// StrictMode, so the one-shot boot runs exactly once; the guard is cheap
// insurance against an accidental double-invoke.
let didBoot = false;

export default function App() {
  const shellRef = useRef(null);
  // <Header> portals into the `#header-bar` element that lives in the injected
  // skeleton, so it can't mount until that injection has run. Gate it on
  // `ready`, flipped true the moment the skeleton is in the DOM.
  const [ready, setReady] = useState(false);
  // Storage gate: every child that reads appStorage at mount waits for the
  // BOOT DATA — init() opens the gate (markStorageReady) only after BOTH
  // initAppStorage() AND maybeAutoMigrateLegacyData() settle. Mounting before
  // the facade picked a mode read the pre-init passthrough (empty localStorage
  // on a post-adoption Tauri boot); mounting before the legacy Electron import
  // landed had ChatPanel snapshot an empty thread list whose next save
  // overwrote the migrated chat history.
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    // Subscribe BEFORE firing init() and OUTSIDE the didBoot guard: the
    // promise is module-level and resolve-once, so a late subscriber (e.g. a
    // theoretical remount) still fires immediately.
    whenStorageReady().then(() => setStorageReady(true));
    if (didBoot) return;
    didBoot = true;
    const host = shellRef.current;
    if (host) {
      // Parse the static skeleton and append its nodes. DOMParser never executes
      // scripts (and the skeleton has none), so this stays off the XSS path
      // while producing DOM identical to the original index.html body.
      const parsed = new DOMParser().parseFromString(shellHtml, 'text/html');
      while (parsed.body.firstChild) {
        host.appendChild(parsed.body.firstChild);
      }
    }
    // The skeleton (incl. #header-bar) is now in the DOM — let portal-based
    // chrome mount before the still-vanilla init() wires everything else.
    setReady(true);
    init().catch((err) => console.error('[App] init failed:', err));
  }, []);

  // Gating shape: the skeleton <div> is the entire static layout (panels,
  // toggles, #resume host), so withholding the components below causes zero
  // layout shift — Header/StructurePanel/ChatPanel PORTAL into skeleton hosts
  // that keep their own size/position, and the dialogs render nothing while
  // closed (Radix portals). Toaster/ConfirmHost stay unconditional: they read
  // no storage, and the Toaster must exist for initAppStorage()'s own failure
  // toasts. The 300ms first-run onboarding check is safe: init() opens the
  // gate right after the migration await — well before that timer is even
  // scheduled — so OnboardingWizard is mounted long before it fires.
  return (
    <>
      <div ref={shellRef} style={{ display: 'contents' }} />
      {ready && storageReady && <Header />}
      {ready && storageReady && <StructurePanel />}
      {ready && storageReady && <ChatPanel />}
      {storageReady && <SettingsDialog />}
      {storageReady && <HistoryDialog />}
      {storageReady && <ProfileDialog />}
      {storageReady && <JobsDialog />}
      {storageReady && <OnboardingWizard />}
      {storageReady && <DiffDialog />}
      {storageReady && <PdfDialog />}
      <Toaster />
      <ConfirmHost />
      <UpdateNotesHost />
      <DeleteVariantThreadsHost />
    </>
  );
}
