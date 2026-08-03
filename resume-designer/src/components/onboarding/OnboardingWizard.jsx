import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

import { completeOnboarding, shouldShowOnboarding } from '../../onboarding.js';
import { loadRegistry } from '../../profiles.js';
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
    setCanDismiss(skipApiKeyStep || !shouldShowOnboarding() || (loadRegistry()?.length ?? 0) > 1);

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
    // A keychain refusal must not trap the user inside onboarding, so this
    // logs and continues to the validation step. Note the key is then NOT
    // persisted — setSecret updates its in-memory copy only after a confirmed
    // write — so AI calls keep failing until it is saved again from Settings,
    // which reports the error properly. Revisit alongside
    // secretStore#handleUnavailableKeychain.
    try {
      await saveApiKey(key);
    } catch (err) {
      console.error('[onboarding] could not persist the API key', err);
    }
    refreshChatPanel();
    return validateOpenRouterKey(key);
  }, []);

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

  const saveResume = useCallback(() => {
    // saveOnboardingResume throws when the variant can't be persisted (full
    // storage). Surface that and stay on the review step — advancing to
    // the success screen would claim a resume that doesn't exist.
    try {
      saveOnboardingResume({ parsedResume, mode, targetJob, jobDescriptions });
    } catch (err) {
      toast.error(err.message);
      return;
    }
    setStep(5);
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
