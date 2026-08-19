import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

import { completeOnboarding, shouldShowOnboarding } from '../../onboarding.js';
import { listProfiles } from '../../profiles.js';
import {
  INTERVIEW_QUESTIONS,
  validateOpenRouterKey,
  getAvailableModelsForSelector,
  parseResumeWithAI,
  extractFileText,
  improveInterviewAnswer,
  buildResumeFromInterview,
  generateResumeForJob,
  tailorResume,
  saveOnboardingResume,
  commitJobDescriptions,
} from '../../onboardingLogic.js';
import {
  getConfiguredProviders,
  getDefaultModelId,
  modelSupportsReasoning,
  fetchModelCatalog,
  checkProfileHasData,
} from '../../aiService.js';
import { getSettings, saveSettings, saveApiKey, SETTINGS_UPDATED_EVENT } from '../../persistence.js';
import { refreshChatPanel } from '../../chatPanel.js';
import { appStorage } from '../../appStorage.js';
import { publishOnboarding } from '../../iosShell.js';
import { initWindowDrag } from '../../tauriDrag.js';
import {
  ApiKeyStep,
  ChoosePathStep,
  ImportStep,
  FilePreviewStep,
  InterviewStep,
  JobInputStep,
  JobDescriptionStep,
  ReviewStep,
  FinalStep,
} from './OnboardingSteps.jsx';

/**
 * First-run onboarding wizard.
 *
 * Always mounted (renders null when closed) so its event listeners exist before
 * main.js's 300ms first-run check fires. Opens on `rd:open-onboarding` (detail =
 * { skipApiKeyStep }) and closes on `rd:close-onboarding`, both dispatched by the
 * onboarding.js bridge. The full-screen overlay is styled with Tailwind/shadcn
 * (Progress header + card panel); the `onboarding-overlay` + `show` class tokens
 * are kept purely as a cross-module contract — styles/onboarding.css's
 * `body:has(.onboarding-overlay.show)` rule hides the inline-editor AI menu while
 * the wizard is up. `entered` drives the fade/scale transition (mount without
 * `show`/opacity, add both on the next animation frame).
 *
 * Steps: 0 API key · 1 choose path · 2 import|interview|job-input · 3 job
 * descriptions · 4 review · 5 final. New-resume mode (the header "+" button) skips
 * step 0. The AI/parse/save logic lives in onboardingLogic.js; this component owns
 * the step state machine and the async flow orchestration.
 */
export default function OnboardingWizard() {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState(null); // 'new' | 'import' | 'job'
  const [isNewResumeMode, setIsNewResumeMode] = useState(false);
  const [canDismiss, setCanDismiss] = useState(false);

  // Cross-step data.
  const [parsedResume, setParsedResume] = useState(null);
  const [jobDescriptions, setJobDescriptions] = useState([]);
  const [targetJob, setTargetJob] = useState(null);
  const [jobGaps, setJobGaps] = useState([]);
  const [answers, setAnswers] = useState({});
  const [question, setQuestion] = useState(0);
  const [importText, setImportText] = useState('');
  const [filePreview, setFilePreview] = useState(null); // extracted text | null

  // Re-render trigger when settings change (keeps API/model state fresh).
  const [, bumpSettings] = useState(0);

  // Persisted across opens (component is never unmounted) AND across restarts —
  // seeded from the per-area remembered model/reasoning so the choice sticks.
  const jobGenModelRef = useRef(getSettings().onboardingModel || null);
  const jobGenReasoningRef = useRef(getSettings().onboardingReasoning || 'medium');
  const closeTimerRef = useRef(null);
  const dragStripRef = useRef(null);

  const doOpen = useCallback((options = {}) => {
    // New-resume mode (the header "+") always skips the API-key step, even with no
    // key configured. Step 0 has no cancel/skip affordance and ApiKeyStep won't
    // advance without a key, so gating the skip on a configured key would strand a
    // keyless existing user on the API-key screen. First-run (no skipApiKeyStep)
    // still shows step 0.
    const skipApiKeyStep = !!options.skipApiKeyStep;

    // The close X shows whenever this is NOT a genuine first run: new-resume mode,
    // a reopen once the app already has user data (Settings → Replay welcome
    // guide), OR when OTHER profiles exist — a new empty profile must not trap
    // the user, who needs to be able to dismiss and switch back. Without it, a
    // keyless user replaying the guide (or landing in a fresh profile) is stuck
    // on the API-key step — no skip, no cancel, only a reload. Snapshot at open
    // so the affordance doesn't pop in mid-wizard (completeOnboarding fires at
    // the end).
    setCanDismiss(skipApiKeyStep || !shouldShowOnboarding() || listProfiles().length > 1);

    setIsNewResumeMode(skipApiKeyStep);
    setStep(skipApiKeyStep ? 1 : 0);
    setMode(null);
    setParsedResume(null);
    setJobDescriptions([]);
    setTargetJob(null);
    setJobGaps([]);
    setAnswers({});
    setQuestion(0);
    setImportText('');
    setFilePreview(null);

    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
    document.body.style.overflow = 'hidden';
  }, []);

  const doClose = useCallback(() => {
    setEntered(false);
    document.body.style.overflow = '';
    refreshChatPanel();
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 300);
  }, []);

  // Explicit user dismissal (the header X): make it DURABLE by recording
  // completion — otherwise an empty profile whose wizard was cancelled
  // re-opens it on every future launch (shouldShowOnboarding sees no user
  // variants). The empty-state canvas takes over from here. Programmatic
  // closes (rd:close-onboarding) intentionally don't stamp: they aren't a
  // user choice.
  const dismiss = useCallback(() => {
    completeOnboarding();
    doClose();
  }, [doClose]);

  // Wizard open/close bridge events.
  useEffect(() => {
    const onOpen = (e) => doOpen(e.detail || {});
    const onCloseEvt = () => doClose();
    window.addEventListener('rd:open-onboarding', onOpen);
    window.addEventListener('rd:close-onboarding', onCloseEvt);
    return () => {
      window.removeEventListener('rd:open-onboarding', onOpen);
      window.removeEventListener('rd:close-onboarding', onCloseEvt);
    };
  }, [doOpen, doClose]);

  // Keep API/model-dependent UI in sync when settings change.
  useEffect(() => {
    const onSettings = () => bumpSettings((n) => n + 1);
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettings);
  }, []);

  // Play the enter transition: mount without `.show`, add it on the next frame.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return undefined;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Cleanup on unmount.
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    document.body.style.overflow = '';
  }, []);

  // The full-screen overlay covers the header's drag region, so window-dragging
  // from the top dies while the wizard is open. Re-arm native dragging on a thin
  // strip pinned to the very top of the backdrop (height = the app header's), so
  // only that band moves the window — not the whole backdrop. No-op outside Tauri.
  useEffect(() => {
    if (open && dragStripRef.current) initWindowDrag(dragStripRef.current);
  }, [open]);

  // --- flow handlers ------------------------------------------------------

  const goTo = useCallback((s) => setStep(s), []);

  const validateKey = useCallback(async (key) => {
    // Persist immediately so every AI entry point can use it, then validate.
    //
    // A keychain refusal has to STOP here. setSecret updates its in-memory copy
    // only after a confirmed write, so on failure the app holds the old key or
    // none at all — advancing would show "AI features are ready" and then fail
    // every call in the steps that follow, with nothing connecting the two.
    // Better to keep the user on key setup with something they can act on.
    try {
      await saveApiKey(key);
    } catch (err) {
      console.error('[onboarding] could not persist the API key', err);
      // `retainedInMemory` means the browser refused to store it but the key IS
      // live for this session, so AI works and blocking setup here would strand
      // the user over a warning. Anything else genuinely leaves no usable
      // credential, and advancing would promise AI that is about to fail.
      if (!err?.retainedInMemory) {
        return { saved: false, error: err?.message || 'Could not save your API key.' };
      }
      refreshChatPanel();
      return { saved: true, warning: err.message, valid: await validateOpenRouterKey(key) };
    }
    refreshChatPanel();
    return { saved: true, valid: await validateOpenRouterKey(key) };
  }, []);

  /**
   * The native step's own save, because it cannot read a return value.
   *
   * `model.send` is a synchronous dispatcher and drops promise results, so
   * `validateKey`'s `{ saved, error, warning, valid }` reached nobody on iOS. A
   * keychain refusal left `hasKey` false and the notice untouched — and since
   * `OPOnboardingSteps.swift` clears its `saving` flag only when one of those
   * two changes, the Save button stayed disabled with no message and no retry.
   * On a first run, which is not dismissible, that is a dead end.
   *
   * The outcome rides the projection instead, which is how every other native
   * result gets home. The web card keeps handling its own return value: it can,
   * and its wording is per-status rather than a single notice.
   */
  const nativeSaveKey = useCallback(async (key) => {
    setNotice(null);
    const result = await validateKey(key);
    if (!result?.saved) {
      setNotice({ kind: 'error', text: result?.error || 'Could not save your API key.' });
      return;
    }
    // Saved but not stored, or saved but unverified: both are worth saying, and
    // neither is a failure to save. Same words as the web card's, so the two
    // screens do not describe one outcome differently.
    if (result.warning) setNotice({ kind: 'error', text: result.warning });
    else if (!result.valid) {
      setNotice({
        kind: 'error',
        text: 'Could not validate your key. We saved it — you can re-check it later in Settings.',
      });
    }
  }, [validateKey]);

  const chooseMode = useCallback((m) => {
    setMode(m);
    setStep(2);
  }, []);

  const parseImport = useCallback(async (text) => {
    setImportText(text);
    const parsed = await parseResumeWithAI(text);
    setParsedResume(parsed);
    setFilePreview(null);
    setStep(3);
  }, []);

  const handleFile = useCallback(async (file) => {
    const text = await extractFileText(file);
    setFilePreview(text);
  }, []);

  const improveText = useCallback((questionText, value) => {
    const settings = getSettings();
    const modelId = settings.defaultModel || getDefaultModelId();
    return improveInterviewAnswer(questionText, value, modelId);
  }, []);

  const interviewNext = useCallback((value) => {
    const q = INTERVIEW_QUESTIONS[question];
    const next = { ...answers, [q.id]: value };
    setAnswers(next);
    if (question < INTERVIEW_QUESTIONS.length - 1) {
      setQuestion(question + 1);
    } else {
      setParsedResume(buildResumeFromInterview(next));
      setStep(3);
    }
  }, [question, answers]);

  const interviewBack = useCallback(() => {
    if (question === 0) setStep(1);
    else setQuestion(question - 1);
  }, [question]);

  const generateForJob = useCallback(async ({ title, company, description, model, reasoning, hooks, signal }) => {
    const job = { title: title || 'Target Role', company: company || 'Company', description };
    setTargetJob(job);
    setJobDescriptions([job]);
    jobGenModelRef.current = model;
    jobGenReasoningRef.current = reasoning;
    saveSettings({ onboardingModel: model, onboardingReasoning: reasoning });
    // No setStep here: JobInputStep settles into its own 'done' screen (reasoning +
    // token usage) and advances to review only when the user clicks through.
    const { resume, gaps } = await generateResumeForJob(model, job, reasoning, { hooks, signal });
    setParsedResume(resume);
    setJobGaps(gaps);
  }, []);

  const addJob = useCallback((jd) => setJobDescriptions((prev) => [...prev, jd]), []);
  const removeJob = useCallback((i) => setJobDescriptions((prev) => prev.filter((_, idx) => idx !== i)), []);

  // Jobs already persisted this session, tracked by object identity. Reaching
  // Review runs commitJobsAndTailor, and Back→Tailor re-enters it — since
  // addJobDescription mints a fresh id per call, re-committing the same
  // in-memory jobs would save duplicates. Only newly-added jobs are committed.
  const committedJobsRef = useRef(new Set());

  const commitJobsAndTailor = useCallback(async () => {
    const committed = committedJobsRef.current;
    const fresh = jobDescriptions.filter((jd) => !committed.has(jd));
    if (fresh.length > 0) {
      commitJobDescriptions(fresh);
      fresh.forEach((jd) => committed.add(jd));
    }
    if (jobDescriptions.length > 0 && getConfiguredProviders().length > 0) {
      try {
        const tailored = await tailorResume(parsedResume, jobDescriptions);
        setParsedResume(tailored);
      } catch (err) {
        console.error('[Onboarding] AI tailoring failed:', err);
        // Continue with the untailored resume.
      }
    }
    setStep(4);
  }, [jobDescriptions, parsedResume]);

  const jdBack = useCallback(() => {
    if (mode === 'new') setQuestion(INTERVIEW_QUESTIONS.length - 1);
    setStep(2);
  }, [mode]);

  const reviewBack = useCallback(() => setStep(mode === 'job' ? 2 : 3), [mode]);

  const saveResume = useCallback(async () => {
    // SINGLE FLIGHT. Waiting for durability opened a window this step never had
    // before: Create is a button on a screen that stays interactive, so a second
    // tap while the flush is pending would run `saveOnboardingResume` again —
    // minting a second résumé id, and in job mode committing the job
    // descriptions a second time as well.
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy('save');
    try {
      // saveOnboardingResume throws when the variant can't be persisted (full
      // storage). Surface that and stay on the review step — advancing to
      // the success screen would claim a resume that doesn't exist.
      setNotice(null);
      // NOT REDONE ON A RETRY. The variant from the first attempt exists; only
      // its durability was in doubt, so trying again re-flushes rather than
      // creating a second résumé the person never asked for.
      if (!savedRef.current) {
        try {
          saveOnboardingResume({ parsedResume, mode, targetJob, jobDescriptions });
        } catch (err) {
          toast.error(err.message);
          setNotice({ kind: 'error', text: err.message });
          return;
        }
        savedRef.current = true;
      }
    // …and the OTHER half of that same sentence, which the throw above does not
    // cover. On a device the write goes into `appStorage`'s cache and the disk
    // refusal arrives later, so the throw never happens and the wizard says
    // "ready" for a résumé that is only in memory — the first one, on a fresh
    // install, which is gone at the next launch with nothing to go back to.
    //
    // Waited for rather than warned about: this is a one-off at the end of a
    // wizard, where a moment's pause is affordable and "ready" has to mean it.
      if (!(await appStorage.flush())) {
        const text = 'Your resume could not be saved to disk. Free up space and try again.';
        toast.error(text);
        // The toast renders in the canvas, behind the native wizard. This is
        // what the iOS side reads.
        setNotice({ kind: 'error', text });
        return;
      }
      setStep(5);
    } finally {
      savingRef.current = false;
      setBusy('');
    }
  }, [parsedResume, mode, targetJob, jobDescriptions]);

  const finish = useCallback(() => {
    completeOnboarding();
    doClose();
    refreshChatPanel();
    window.dispatchEvent(new CustomEvent('resume-ready'));
  }, [doClose]);

  const openProfile = useCallback(() => {
    doClose();
    window.openUserProfilePanel?.();
  }, [doClose]);

  // --- native shell -------------------------------------------------------
  //
  // On iOS this wizard is drawn by SwiftUI (OPOnboarding.swift), so the step
  // machine below stays the only one: the component pushes its state and the
  // native buttons call these handlers. Nothing here changes the web path.
  //
  // Reachable at all because App.jsx mounts this component from app start and
  // it merely renders null while closed — the reason the other screens needed
  // their composition extracted into framework-free modules first.

  // What the web keeps inside JobInputStep's own state. The native step has no
  // component to hold it, so it lives here and rides the projection.
  const [nativeGen, setNativeGen] = useState(null);
  const [improved, setImproved] = useState(null);
  const [busy, setBusy] = useState('');
  // A durable save is in flight; a second Create must not start another.
  const savingRef = useRef(false);
  // The variant was created. Only its durability is outstanding, so a retry
  // re-flushes instead of minting a second résumé.
  const savedRef = useRef(false);
  const [notice, setNotice] = useState(null);
  const genAbortRef = useRef(null);
  const improveTokenRef = useRef(0);

  const nativeImprove = useCallback(async (value) => {
    const q = INTERVIEW_QUESTIONS[question];
    if (!q?.aiAssist) return;
    setBusy('improve');
    setNotice(null);
    try {
      // A NEW token every time, even for identical text: the native field
      // applies the result on token change, and a re-improve that happened to
      // return the same words would otherwise look like nothing happened.
      const text = await improveText(q.question, value);
      improveTokenRef.current += 1;
      setImproved({ token: improveTokenRef.current, text });
    } catch (err) {
      setNotice({ kind: 'error', text: err?.message || 'Could not improve that answer.' });
    } finally {
      setBusy('');
    }
  }, [question, improveText]);

  const nativeGenerate = useCallback(async (opts) => {
    const controller = new AbortController();
    genAbortRef.current = controller;
    setNotice(null);
    setNativeGen({ phase: 'generating', reasoning: '', done: false });
    try {
      await generateForJob({
        ...opts,
        signal: controller.signal,
        hooks: {
          onReasoning: (_delta, full) => setNativeGen(
            (g) => ({ ...g, phase: 'generating', reasoning: full, done: false }),
          ),
        },
      });
      // Settle into the done screen rather than advancing, which is what the
      // web does too — the user reads the reasoning and clicks through.
      setNativeGen((g) => ({ phase: 'done', reasoning: g?.reasoning || '', done: true }));
    } catch (err) {
      setNativeGen(null);
      // A user Cancel aborts the request; returning to the form silently is the
      // whole feedback, the same as on the web.
      if (!controller.signal.aborted) {
        setNotice({ kind: 'error', text: `Failed to generate resume: ${err.message}` });
      }
    } finally {
      genAbortRef.current = null;
    }
  }, [generateForJob]);

  // Long AI calls that the web runs behind a step's own spinner. Named in
  // `busy` so the native side can say which one is running.
  const nativeParseImport = useCallback(async (text) => {
    setBusy('parse');
    setNotice(null);
    try {
      await parseImport(text);
    } catch (err) {
      setNotice({ kind: 'error', text: err?.message || 'Could not read that résumé.' });
    } finally {
      setBusy('');
    }
  }, [parseImport]);

  // A file chosen in the native document picker. It arrives as base64 because
  // the command channel is a JS string literal — there is no way to hand a
  // Blob across it — and `parseResumeFile` branches on the FILENAME's
  // extension, so the name has to survive the trip too.
  const nativePickedFile = useCallback(async (name, base64) => {
    setBusy('read');
    setNotice(null);
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      await handleFile(new File([bytes], name));
    } catch (err) {
      setNotice({ kind: 'error', text: err?.message || 'Could not read that file.' });
    } finally {
      setBusy('');
    }
  }, [handleFile]);

  const nativeNext = useCallback(async () => {
    // The web's ApiKeyStep advances itself once its own validate resolves; the
    // native one has no such closure, so Next is what leaves the key step.
    if (step === 0) { goTo(1); return; }
    // The job path skips the step-3 collector: it gathered its job description
    // on the way in, and asking again is the bug that reads as a loop.
    if (step === 2 && mode === 'job') { goTo(4); return; }
    if (step !== 3) return;
    setBusy('tailor');
    try {
      await commitJobsAndTailor();
    } finally {
      setBusy('');
    }
  }, [step, mode, goTo, commitJobsAndTailor]);

  const nativeBack = useCallback((draft) => {
    switch (step) {
      case 1:
        // Nothing behind it in new-résumé mode — the key step is not just
        // skipped, it is not part of that flow.
        if (!isNewResumeMode) goTo(0);
        return;
      case 2:
        if (mode === 'import') {
          if (filePreview != null) setFilePreview(null);
          else goTo(1);
        } else if (mode === 'job') {
          // Carry the half-typed job back, or a Back-then-forward silently
          // discards what was written.
          if (draft) setTargetJob(draft);
          goTo(1);
        } else {
          interviewBack();
        }
        return;
      case 3: jdBack(); return;
      case 4: reviewBack(); return;
      default:
    }
  }, [step, mode, isNewResumeMode, filePreview, interviewBack, jdBack, reviewBack, goTo]);

  useEffect(() => {
    publishOnboarding(
      open
        ? {
          open, step, mode, isNewResumeMode, canDismiss,
          hasProviders: getConfiguredProviders().length > 0,
          hasKey: !!getSettings().openrouterKey,
          importText,
          filePreview,
          questions: INTERVIEW_QUESTIONS,
          question,
          answers,
          improved,
          jobDescriptions,
          targetJob,
          jobGaps,
          models: getAvailableModelsForSelector(),
          model: jobGenModelRef.current || getSettings().defaultModel || getDefaultModelId(),
          reasoning: jobGenReasoningRef.current,
          generating: nativeGen,
          resume: parsedResume,
          busy,
          notice,
        }
        : null,
      {
        validateKey: nativeSaveKey,
        chooseMode,
        parseImport: nativeParseImport,
        pickedFile: nativePickedFile,
        clearFilePreview: () => setFilePreview(null),
        interviewNext,
        interviewBack,
        improve: nativeImprove,
        generateForJob: nativeGenerate,
        cancelGenerate: () => genAbortRef.current?.abort(),
        addJob,
        removeJob,
        next: nativeNext,
        back: nativeBack,
        saveResume,
        finish,
        openProfile,
        dismiss,
      },
    );
  });

  if (!open) return null;

  const hasProviders = getConfiguredProviders().length > 0;
  const availableModels = getAvailableModelsForSelector();
  const totalSteps = isNewResumeMode ? 5 : 6;
  const displayStep = isNewResumeMode ? step : step + 1;

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <ApiKeyStep
            defaultKey={getSettings().openrouterKey || ''}
            hasProviders={hasProviders}
            onValidate={validateKey}
            goTo={goTo}
          />
        );
      case 1:
        return (
          <ChoosePathStep
            isNewResumeMode={isNewResumeMode}
            onChoose={chooseMode}
            onBack={() => goTo(0)}
          />
        );
      case 2:
        if (mode === 'import') {
          return filePreview != null ? (
            <FilePreviewStep
              previewText={filePreview}
              onBack={() => setFilePreview(null)}
              onContinue={parseImport}
            />
          ) : (
            <ImportStep
              initialText={importText}
              onParse={parseImport}
              onFile={handleFile}
              onBack={() => goTo(1)}
            />
          );
        }
        if (mode === 'job') {
          return (
            <JobInputStep
              hasProfileData={checkProfileHasData()}
              targetJob={targetJob}
              jobGaps={jobGaps}
              availableModels={availableModels}
              defaultModel={jobGenModelRef.current || getSettings().defaultModel || getDefaultModelId()}
              defaultReasoning={jobGenReasoningRef.current}
              modelSupportsReasoning={modelSupportsReasoning}
              fetchModelCatalog={fetchModelCatalog}
              onGenerate={generateForJob}
              onReview={() => goTo(4)}
              onBack={(draft) => { setTargetJob(draft); goTo(1); }}
              onOpenProfile={openProfile}
            />
          );
        }
        return (
          <InterviewStep
            key={INTERVIEW_QUESTIONS[question].id}
            question={INTERVIEW_QUESTIONS[question]}
            questionIndex={question}
            totalQuestions={INTERVIEW_QUESTIONS.length}
            initialValue={answers[INTERVIEW_QUESTIONS[question].id] || ''}
            hasProviders={hasProviders}
            onImprove={improveText}
            onBack={interviewBack}
            onNext={interviewNext}
          />
        );
      case 3:
        return (
          <JobDescriptionStep
            jobDescriptions={jobDescriptions}
            onAdd={addJob}
            onRemove={removeJob}
            onBack={jdBack}
            onNext={commitJobsAndTailor}
          />
        );
      case 4:
        return (
          <ReviewStep
            resume={parsedResume}
            isTailored={jobDescriptions.length > 0}
            onBack={reviewBack}
            onCreate={saveResume}
            saving={busy === 'save'}
          />
        );
      case 5:
        return <FinalStep onFinish={finish} onOpenProfile={openProfile} />;
      default:
        return null;
    }
  };

  return (
    <div
      id="onboarding-overlay"
      className={cn(
        // `onboarding-overlay` + `show` are functional tokens (see doc comment),
        // not stylesheet hooks — all visuals below are Tailwind.
        'onboarding-overlay fixed inset-0 z-[3000] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm transition-opacity duration-300',
        entered ? 'show opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* Window-drag strip: only this top band (the app header's height) drags the
          native window in Tauri — not the whole backdrop. Pinned to the true top
          of the viewport, behind the centered card. aria-hidden + transparent:
          purely a drag affordance, no semantics and no visual. */}
      <div
        ref={dragStripRef}
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[var(--header-height)]"
      />
      <div
        className={cn(
          'flex w-full max-w-[620px] max-h-[90vh] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg glass-card',
          'transition-transform duration-300',
          entered ? 'scale-100' : 'scale-95',
        )}
      >
        {/* Header — mockup .ob-head: 16px 22px, fixed 140px progress + step text. */}
        <div className="shrink-0 border-b px-[22px] py-4">
          <div className="flex items-center gap-3.5" id="onboarding-progress">
            <Progress value={(displayStep / totalSteps) * 100} className="h-[7px] w-[140px]" />
            <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
              Step {displayStep} of {totalSteps}
            </span>
            <span className="flex-1" />
            {canDismiss && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                id="wizard-close-btn"
                title="Cancel"
                aria-label="Cancel"
                onClick={dismiss}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {renderStep()}
      </div>
    </div>
  );
}
