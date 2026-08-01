import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, ArrowRight, Brain, Briefcase, Check, Clipboard, Cpu, FileText, Info, KeyRound,
  Loader2, Lock, MessageSquareText, Plus, Sparkles, Target, Upload, X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { LiveReasoning } from '../chat/LiveReasoning.jsx';
import { GapReport } from './GapReport.jsx';
import { formatTokenCount } from '../../tokenTrackingService.js';

/**
 * Presentational step components for the onboarding wizard, composed from
 * genuine shadcn primitives + Tailwind utilities (no bespoke CSS — see
 * SettingsDialog.jsx for the canonical patterns these follow).
 *
 * Each component returns a single flex column that slots into the wizard panel:
 * a scrollable body and a pinned footer (Back = ghost Button with ArrowLeft,
 * primary action right, busy = disabled + Loader2 + label swap). All data and
 * actions arrive via props — these components import nothing from the app
 * (store/persistence/aiService live in OnboardingWizard.jsx and
 * onboardingLogic.js). Handler logic is a 1:1 port of the previous version;
 * only the markup/styling changed (and window alerts → sonner toast).
 */

// --- shared step scaffolding ------------------------------------------------

function StepBody({ className, children }) {
  return <div className={cn('min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5', className)}>{children}</div>;
}

function StepFooter({ className, children }) {
  return <div className={cn('flex shrink-0 items-center justify-between gap-2 border-t px-6 py-4', className)}>{children}</div>;
}

function StepHeader({ title, description, centered }) {
  return (
    <div className={cn('space-y-1', centered && 'text-center')}>
      <h2 className={cn('font-semibold', centered ? 'text-xl tracking-tight' : 'text-lg')}>{title}</h2>
      {description && <p className={cn('text-muted-foreground', centered ? 'text-[13.5px]' : 'text-sm')}>{description}</p>}
    </div>
  );
}

// The centered 60px terracotta circle for centered steps (mockup .ob-icon).
function StepIcon({ icon: Icon }) {
  return (
    <div className="mx-auto flex size-[60px] items-center justify-center rounded-full bg-primary/10 text-primary">
      <Icon className="size-[26px]" />
    </div>
  );
}

// --- Step 0: API key ------------------------------------------------------

export function ApiKeyStep({ defaultKey, hasProviders, onValidate, goTo }) {
  const [key, setKey] = useState(defaultKey);
  const [status, setStatus] = useState(null); // null | { message, success }
  const [validating, setValidating] = useState(false);

  const handleContinue = async () => {
    const k = key.trim();
    if (!k) {
      setStatus({ message: 'Enter your OpenRouter API key to use AI features.', success: false });
      return;
    }
    setValidating(true);

    const valid = await onValidate(k);
    setStatus(valid
      ? { message: 'API key validated. AI features are ready to use.', success: true }
      : { message: 'Could not validate your key. We saved it — you can re-check it later in Settings.', success: false });

    setTimeout(() => goTo(1), valid ? 1000 : 1200);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
          <KeyRound className="size-5 text-muted-foreground" />
        </div>
        <StepHeader
          title="Welcome to On Paper"
          description="On Paper uses AI to help you create professional resumes. Enter your OpenRouter API key to get started."
        />

        <div className="space-y-2">
          <Label htmlFor="api-openrouter">OpenRouter API key</Label>
          <Input
            type="password"
            id="api-openrouter"
            placeholder="sk-or-v1-..."
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            One key for Claude, GPT, Gemini &amp; 300+ models. Get a key at{' '}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              openrouter.ai/keys
            </a>
          </p>
        </div>

        {status && (
          <p className={cn('flex items-start gap-2 text-sm', status.success ? 'text-success' : 'text-destructive')}>
            {status.success && <Check className="mt-0.5 size-4 shrink-0" />}
            <span>{status.message}</span>
          </p>
        )}

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          Your API key is stored locally on your device and is sent only to OpenRouter to make AI requests.
        </p>
      </StepBody>
      <StepFooter className="justify-end">
        <Button id="validate-and-continue" disabled={validating} onClick={handleContinue}>
          {validating ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Validating…
            </>
          ) : (
            hasProviders ? 'Continue' : 'Validate & continue'
          )}
        </Button>
      </StepFooter>
    </div>
  );
}

// --- Step 1: Choose path --------------------------------------------------

const PATH_OPTIONS = [
  {
    id: 'option-import',
    mode: 'import',
    Icon: Upload,
    title: 'Import existing resume',
    description: 'Upload a PDF or paste text — AI will parse and structure your content automatically',
  },
  {
    id: 'option-new',
    mode: 'new',
    Icon: MessageSquareText,
    title: 'Start fresh',
    description: 'Answer a few questions and AI will help you craft professional content',
  },
  {
    id: 'option-job',
    mode: 'job',
    Icon: Target,
    title: 'Create for job',
    description: 'Generate a resume from your profile, tailored to a specific job posting',
    featured: true,
  },
];

export function ChoosePathStep({ isNewResumeMode, onChoose, onBack }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Centered step — mockup .ob-body: 30px 34px 26px, ob-icon + heading. */}
      <StepBody className="px-[34px] pb-[26px] pt-[30px]">
        <StepIcon icon={FileText} />
        <StepHeader
          centered
          title="How would you like to start?"
          description="Choose how you'd like to create your AI-powered resume."
        />

        <div className="space-y-2.5 pt-1.5 text-left">
          {PATH_OPTIONS.map(({ id, mode, Icon, title, description, featured }) => (
            <button
              key={id}
              type="button"
              id={id}
              onClick={() => onChoose(mode)}
              className={cn(
                // Mockup .ob-opt: rounded-[12px] border p-4, horizontal layout.
                'relative flex w-full items-start gap-3.5 rounded-[12px] border p-4 text-left transition-colors',
                featured
                  ? 'border-primary bg-primary/[0.04] ring-1 ring-primary'
                  : 'hover:bg-accent/50',
              )}
            >
              <span
                className={cn(
                  // 38px icon tile, rounded-[10px]; terracotta when featured.
                  'flex size-[38px] shrink-0 items-center justify-center rounded-[10px]',
                  featured ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-semibold">{title}</span>
                <span className="pr-[74px] text-[12.5px] leading-[1.5] text-muted-foreground">{description}</span>
              </span>
              <Badge className="absolute right-3 top-3 gap-1 border-transparent bg-primary/10 text-primary">
                <Sparkles className="size-3" /> AI-powered
              </Badge>
            </button>
          ))}
        </div>
      </StepBody>
      {/* New-resume mode has no Back target (step 0 is skipped); the header X closes. */}
      {!isNewResumeMode && (
        <StepFooter>
          <Button variant="ghost" id="back-btn" onClick={onBack}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        </StepFooter>
      )}
    </div>
  );
}

// --- Step 2 (import mode): Import ------------------------------------------

export function ImportStep({ initialText, onParse, onFile, onBack }) {
  const [text, setText] = useState(initialText);
  const [extracting, setExtracting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const handleFile = async (file) => {
    setExtracting(true);
    try {
      await onFile(file);
    } catch (e) {
      toast.error('Failed to read file: ' + e.message);
    } finally {
      setExtracting(false);
    }
  };

  const handleParse = async () => {
    const t = text.trim();
    if (!t) {
      toast.error('Please paste or upload your resume content');
      return;
    }
    setParsing(true);
    try {
      await onParse(t);
    } catch (e) {
      toast.error('Failed to parse resume: ' + e.message);
      setParsing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <StepHeader
          title="Import your resume"
          description="Paste your existing resume text below, or upload a file."
        />

        <Textarea
          id="import-textarea"
          className="min-h-40"
          placeholder="Paste your resume text here..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">or</span>
          <Separator className="flex-1" />
        </div>

        <div
          id="file-drop-zone"
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground transition-colors hover:bg-accent/30',
            dragOver && 'border-primary/50 bg-accent/30',
          )}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) await handleFile(file);
          }}
        >
          {extracting ? (
            <>
              <Loader2 className="size-6 animate-spin" />
              <p>Extracting text…</p>
            </>
          ) : (
            <>
              <Upload className="size-6" />
              <p className="font-medium text-foreground">Drop file here or click to browse</p>
              <p className="text-xs">Supports TXT, PDF, DOCX</p>
              {/* No handler of its own: the click bubbles to the zone's file picker. */}
              <Button type="button" variant="outline" size="sm" className="mt-1">
                Browse files
              </Button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            id="file-input"
            accept=".txt,.pdf,.docx"
            hidden
            onChange={async (e) => {
              const file = e.target.files[0];
              if (file) await handleFile(file);
            }}
          />
        </div>
      </StepBody>
      <StepFooter>
        <Button variant="ghost" id="back-btn" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button id="next-btn" disabled={parsing} onClick={handleParse}>
          {parsing ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Parsing with AI…
            </>
          ) : (
            'Parse resume'
          )}
        </Button>
      </StepFooter>
    </div>
  );
}

// --- Step 2 (import mode, file preview): File preview ----------------------

export function FilePreviewStep({ previewText, onBack, onContinue }) {
  const [busy, setBusy] = useState(false);

  const handleContinue = async () => {
    setBusy(true);
    try {
      await onContinue(previewText);
    } catch (e) {
      toast.error('Failed to parse resume: ' + e.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <StepHeader
          title="Review extracted text"
          description="We've extracted the following text from your file. Please review before continuing."
        />

        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 text-xs">
          {previewText}
        </div>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          If the text doesn&apos;t look right, try uploading a different file or paste the text manually.
        </p>
      </StepBody>
      <StepFooter>
        <Button variant="ghost" id="back-btn" onClick={onBack}>
          <ArrowLeft className="size-4" /> Try again
        </Button>
        <Button id="next-btn" disabled={busy} onClick={handleContinue}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Parsing with AI…
            </>
          ) : (
            'Use this text'
          )}
        </Button>
      </StepFooter>
    </div>
  );
}

// --- Step 2 (new mode): Interview -----------------------------------------

export function InterviewStep({
  question,
  questionIndex,
  totalQuestions,
  initialValue,
  hasProviders,
  onImprove,
  onBack,
  onNext,
}) {
  const [value, setValue] = useState(initialValue);
  const [improving, setImproving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(id);
  }, []);

  const handleImprove = async () => {
    const v = value.trim();
    if (!v) {
      toast.error('Please enter some text first');
      return;
    }
    setImproving(true);
    try {
      const improved = await onImprove(question.question, v);
      setValue(improved);
    } catch (e) {
      toast.error('AI assistance failed: ' + e.message);
    } finally {
      setImproving(false);
    }
  };

  const handleNext = () => {
    const v = value.trim();
    if (!v && question.id !== 'summary') {
      toast.error('Please provide an answer');
      return;
    }
    onNext(v);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <p className="text-xs text-muted-foreground">
          Question {questionIndex + 1} of {totalQuestions}
        </p>

        <h2 className="text-base font-medium">{question.question}</h2>

        {question.type === 'textarea' ? (
          <Textarea
            ref={inputRef}
            id="interview-input"
            className="min-h-32"
            placeholder="Type your answer..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <Input
            ref={inputRef}
            type="text"
            id="interview-input"
            placeholder="Type your answer..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}

        {question.aiAssist && hasProviders && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            id="ai-assist-btn"
            disabled={improving}
            onClick={handleImprove}
          >
            {improving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Improving…
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" /> Improve with AI
              </>
            )}
          </Button>
        )}
      </StepBody>
      <StepFooter>
        <Button variant="ghost" id="back-btn" onClick={onBack}>
          <ArrowLeft className="size-4" /> {questionIndex === 0 ? 'Back' : 'Previous'}
        </Button>
        <Button id="next-btn" onClick={handleNext}>
          {questionIndex === totalQuestions - 1 ? 'Continue' : 'Next'}
        </Button>
      </StepFooter>
    </div>
  );
}

// --- Step 2 (job mode): Job input -----------------------------------------

const REASONING_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const JOB_INPUT_BENEFITS = [
  'AI extracts key requirements and skills',
  'Resume tailored with matching keywords',
  'Experience prioritized for this role',
];

// One token-usage stat (muted label + big number) for the completion strip.
function GenStat({ label, value }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * The "generating resume" screen — replaces the JobInputStep form once generation
 * starts. Shows a read-only summary of the target job + the model/reasoning used
 * (the now-hidden inputs), the live reasoning stream, and — on completion ('done')
 * — a prominent token-usage strip plus a Review button. Cancel aborts mid-flight.
 */
export function JobGeneratingView({ job, modelLabel, reasoningLabel, reasoning, run, elapsed, phase, gaps, onCancel, onReview, onEdit }) {
  const done = phase === 'done';
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const totalTokens = run ? (run.promptTokens || 0) + (run.completionTokens || 0) : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <StepHeader
          title={done ? 'Resume ready' : 'Generating your resume'}
          description={done
            ? 'Tailored to the role below — review and fine-tune it next.'
            : 'Tailoring your profile to this role. This usually takes 20–40 seconds.'}
        />

        {/* Read-only representation of the target job + the model/reasoning used. */}
        <div className="flex flex-wrap items-center gap-2.5 rounded-md border bg-muted/40 p-3">
          <Briefcase className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{job.title || 'Target role'}</div>
            {job.company && <div className="truncate text-xs text-muted-foreground">{job.company}</div>}
          </div>
          <Badge variant="secondary" className="gap-1 font-normal"><Cpu className="size-3" />{modelLabel}</Badge>
          {reasoningLabel && (
            <Badge variant="secondary" className="gap-1 font-normal"><Brain className="size-3" />Reasoning: {reasoningLabel}</Badge>
          )}
        </div>

        {/* Reasoning summary — streams while generating, collapsible recap when done. */}
        <LiveReasoning
          reasoning={reasoning}
          reasoningTokens={run?.reasoningTokens || 0}
          streaming={!done}
          defaultOpen
        />

        {/* Token usage — prominent, appears on completion. */}
        {done && run && (
          <div className="grid grid-cols-3 gap-2.5">
            <GenStat label="Tokens" value={formatTokenCount(totalTokens)} />
            <GenStat label="Reasoning" value={formatTokenCount(run.reasoningTokens || 0)} />
            <GenStat label="Time" value={clock} />
          </div>
        )}

        {/* Gap report — what the job asks for that the profile doesn't support.
            Renders nothing when there are no gaps. */}
        {done && <GapReport gaps={gaps} />}
      </StepBody>
      <StepFooter>
        {done ? (
          <>
            <Button variant="ghost" onClick={onEdit}>
              <ArrowLeft className="size-4" /> Back to edit
            </Button>
            <Button onClick={onReview}>
              Review your resume <ArrowRight className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Writing your resume…
              <span className="tabular-nums text-xs text-muted-foreground/70">{clock}</span>
            </span>
            <Button variant="ghost" onClick={onCancel}>
              <X className="size-4" /> Cancel
            </Button>
          </>
        )}
      </StepFooter>
    </div>
  );
}

export function JobInputStep({
  hasProfileData,
  targetJob,
  jobGaps,
  availableModels,
  defaultModel,
  defaultReasoning,
  modelSupportsReasoning,
  fetchModelCatalog,
  onGenerate,
  onReview,
  onBack,
  onOpenProfile,
}) {
  const [title, setTitle] = useState(targetJob?.title || '');
  const [company, setCompany] = useState(targetJob?.company || '');
  const [description, setDescription] = useState(targetJob?.description || '');
  const [model, setModel] = useState(defaultModel);
  const [reasoning, setReasoning] = useState(defaultReasoning);
  // Generation lifecycle: 'form' (inputs) → 'generating' (live screen) → 'done'
  // (settled screen: token usage + Review). Errors/cancel return to 'form'.
  const [phase, setPhase] = useState('form');
  const [liveReasoning, setLiveReasoning] = useState('');
  const [run, setRun] = useState(null); // token usage, from the onRun hook at stream end
  const [elapsed, setElapsed] = useState(0); // seconds since generation started
  const abortRef = useRef(null); // AbortController backing Cancel
  const [tick, setTick] = useState(0);

  // Re-evaluate reasoning support after the catalog loads (tick bump).
  void tick;
  const reasoningSupported = modelSupportsReasoning(model);

  useEffect(() => {
    fetchModelCatalog().then(() => setTick((t) => t + 1)).catch(() => {});
  }, [fetchModelCatalog]);

  // Elapsed-time ticker — runs only while generating; its value freezes on done.
  useEffect(() => {
    if (phase !== 'generating') return undefined;
    setElapsed(0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  if (!hasProfileData) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <StepBody>
          <StepHeader
            title="Profile needed"
            description="To create a tailored resume from a job description, we need your background information. Please fill out your profile first with your work experience, skills, and education."
          />

          <div className="flex items-start gap-2 rounded-md border bg-muted/50 p-3 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-muted-foreground">
                After filling out your profile, come back here to create a tailored resume.
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                id="open-profile-btn"
                onClick={onOpenProfile}
              >
                Open profile
              </Button>
            </div>
          </div>
        </StepBody>
        <StepFooter>
          <Button
            variant="ghost"
            id="back-btn"
            onClick={() => onBack(targetJob || { title: '', company: '', description: '' })}
          >
            <ArrowLeft className="size-4" /> Back
          </Button>
        </StepFooter>
      </div>
    );
  }

  const handlePaste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setDescription(t);
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      toast.error('Unable to access clipboard. Please paste manually using Ctrl+V / Cmd+V.');
    }
  };

  const handleGenerate = async () => {
    const d = description.trim();
    if (!d) {
      toast.error('Please paste a job description');
      return;
    }
    setLiveReasoning('');
    setRun(null);
    setPhase('generating');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // onGenerate sets the parsed resume in the wizard but does NOT advance — we
      // settle into the 'done' screen here; the user clicks through to review.
      await onGenerate({
        title: title.trim(), company: company.trim(), description: d, model, reasoning,
        signal: controller.signal,
        hooks: {
          onReasoning: (_x, full) => setLiveReasoning(full),
          onRun: (r) => setRun(r),
        },
      });
      setPhase('done');
    } catch (e) {
      // A user Cancel aborts the request — return to the form silently; surface
      // anything else as an error toast.
      if (controller.signal.aborted) setPhase('form');
      else { toast.error('Failed to generate resume: ' + e.message); setPhase('form'); }
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancel = () => abortRef.current?.abort();

  // Group the flat model list for the Select (JobsDialog/JobSelectionDialog pattern).
  const groupedModels = {};
  for (const m of availableModels) {
    (groupedModels[m.group || 'Models'] ??= []).push(m);
  }

  // Once generation starts, swap the whole form for the dedicated generating / done
  // screen (read-only target + live reasoning + token usage).
  if (phase !== 'form') {
    const modelLabel = availableModels.find((m) => m.id === model)?.label || model;
    const reasoningLabel = reasoningSupported && reasoning !== 'none'
      ? (REASONING_OPTIONS.find((o) => o.value === reasoning)?.label || null)
      : null;
    return (
      <JobGeneratingView
        job={{ title: title.trim(), company: company.trim() }}
        modelLabel={modelLabel}
        reasoningLabel={reasoningLabel}
        reasoning={liveReasoning}
        run={run}
        elapsed={elapsed}
        phase={phase}
        gaps={jobGaps}
        onCancel={handleCancel}
        onReview={onReview}
        onEdit={() => setPhase('form')}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <StepHeader
          title="Target job details"
          description="Paste the job description below. AI will read it and draft a resume from your profile for this role."
        />

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="job-title-input">Job title</Label>
            <Input
              type="text"
              id="job-title-input"
              placeholder="e.g. Senior Software Engineer"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="job-company-input">Company</Label>
            <Input
              type="text"
              id="job-company-input"
              placeholder="e.g. Google"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="job-desc-input">Job description</Label>
          <Textarea
            id="job-desc-input"
            className="min-h-40"
            placeholder="Paste the full job description here..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Button type="button" variant="outline" size="sm" id="paste-clipboard-btn" onClick={handlePaste}>
            <Clipboard className="size-3.5" /> Paste from clipboard
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="job-model-select">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="job-model-select">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent className="glass-card">
                {Object.entries(groupedModels).map(([group, models]) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Reasoning</Label>
            {/* Reasoning effort — mockup .seg.xs Segmented. */}
            <Segmented className="flex w-full">
              {REASONING_OPTIONS.map((o) => (
                <SegmentedItem
                  key={o.value}
                  size="xs"
                  className="flex-1"
                  active={reasoning === o.value}
                  disabled={!reasoningSupported}
                  onClick={() => setReasoning(o.value)}
                >
                  {o.label}
                </SegmentedItem>
              ))}
            </Segmented>
            {!reasoningSupported && (
              <p className="text-xs text-muted-foreground">Reasoning not available</p>
            )}
          </div>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/50 p-3">
          {JOB_INPUT_BENEFITS.map((benefit) => (
            <p key={benefit} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="size-4 shrink-0 text-success" />
              {benefit}
            </p>
          ))}
        </div>
      </StepBody>
      <StepFooter>
        <Button
          variant="ghost"
          id="back-btn"
          onClick={() => onBack({ title: title.trim(), company: company.trim(), description: description.trim() })}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button id="generate-btn" onClick={handleGenerate}>
          <Sparkles className="size-4" /> Generate resume
        </Button>
      </StepFooter>
    </div>
  );
}

// --- Step 3: Job descriptions ---------------------------------------------

const JD_BENEFITS = [
  'Customized summary targeting the role',
  'Highlights that match key requirements',
  'Keywords from the job posting',
];

export function JobDescriptionStep({ jobDescriptions, onAdd, onRemove, onBack, onNext }) {
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const hasJobs = jobDescriptions.length > 0;

  const handleAdd = () => {
    const d = desc.trim();
    if (!d) {
      toast.error('Please paste a job description');
      return;
    }
    onAdd({ title: title.trim() || 'Target Role', company: company.trim() || 'Company', description: d });
    setTitle('');
    setCompany('');
    setDesc('');
  };

  const handleNext = async () => {
    setBusy(true);
    try {
      await onNext();
    } catch (e) {
      toast.error('Something went wrong: ' + e.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <StepHeader title="Target a specific job" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Why add a job description?</span>{' '}
          AI will read the job requirements and tailor your resume to highlight your most relevant
          skills and experience.
        </p>

        <div className="space-y-1.5 rounded-md border bg-muted/50 p-3">
          {JD_BENEFITS.map((benefit) => (
            <p key={benefit} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="size-4 shrink-0 text-success" />
              {benefit}
            </p>
          ))}
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="text"
              id="target-job-title-input"
              placeholder="Job title (e.g. Senior Designer)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Input
              type="text"
              id="target-job-company-input"
              placeholder="Company name"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <Textarea
            id="target-job-desc-input"
            className="min-h-24"
            placeholder="Paste the full job description here..."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="flex justify-end">
            <Button type="button" variant="secondary" size="sm" id="add-target-job-btn" onClick={handleAdd}>
              <Plus className="size-3.5" /> Add
            </Button>
          </div>
        </div>

        {hasJobs && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Target jobs added</p>
            {jobDescriptions.map((jd, i) => (
              <div className="flex items-center justify-between rounded-md border p-3" key={i}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{jd.title}</p>
                  <p className="truncate text-xs text-muted-foreground">at {jd.company}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 hover:text-destructive"
                  title="Remove"
                  aria-label={`Remove ${jd.title}`}
                  onClick={() => onRemove(i)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </StepBody>
      <StepFooter>
        <Button variant="ghost" id="back-btn" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button
          id="next-btn"
          variant={hasJobs ? 'default' : 'outline'}
          disabled={busy}
          onClick={handleNext}
        >
          {hasJobs ? (
            busy ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Tailoring…
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> Tailor my resume
              </>
            )
          ) : (
            'Skip for now'
          )}
        </Button>
      </StepFooter>
    </div>
  );
}

// --- Step 4: Review -------------------------------------------------------

function ReviewSectionLabel({ children }) {
  return <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{children}</p>;
}

export function ReviewStep({ resume, isTailored, onBack, onCreate }) {
  const hasName = resume?.name && resume.name !== 'Not set';
  const hasTagline = resume?.tagline && resume.tagline !== 'Not set';
  const hasSummary = resume?.summary;
  const hasHighlights = resume?.highlights?.length > 0;
  const hasExperience = resume?.experience?.length > 0;
  const hasSkills = resume?.skills?.length > 0;
  const hasEducation = resume?.education?.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <StepHeader
          title={isTailored ? 'Your tailored resume' : 'Review your resume'}
          description={isTailored
            ? "AI has customized your resume for your target role. Here's what we created:"
            : "Here's what we extracted. You can edit everything in the main app."}
        />

        <div className="space-y-3 rounded-lg border p-4">
          {isTailored && (
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="size-3" /> Tailored to your target role
            </Badge>
          )}

          <div className="space-y-0.5">
            <p className={cn('text-base font-semibold', !hasName && 'font-normal italic text-muted-foreground')}>
              {resume?.name || 'Not detected'}
            </p>
            <p className={cn('text-sm text-muted-foreground', !hasTagline && 'italic')}>
              {resume?.tagline || 'Not detected'}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {hasExperience && (
              <Badge variant="outline">
                {resume.experience.length} experience{resume.experience.length === 1 ? '' : 's'}
              </Badge>
            )}
            {hasEducation && (
              <Badge variant="outline">
                {resume.education.length} education
              </Badge>
            )}
            {hasSkills && (
              <Badge variant="outline">
                {resume.skills.length} skills
              </Badge>
            )}
          </div>

          {hasSummary && (
            <div className="space-y-1">
              <ReviewSectionLabel>Summary</ReviewSectionLabel>
              <p className="text-sm">{resume.summary}</p>
            </div>
          )}

          {hasHighlights && (
            <div className="space-y-1">
              <ReviewSectionLabel>Highlights</ReviewSectionLabel>
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {resume.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
          )}

          {hasSkills && (
            <div className="space-y-1.5">
              <ReviewSectionLabel>Key skills</ReviewSectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {resume.skills.map((s, i) => (
                  <Badge variant="secondary" key={i}>{s}</Badge>
                ))}
              </div>
            </div>
          )}

          {hasExperience && (
            <div className="space-y-1.5">
              <ReviewSectionLabel>Experience</ReviewSectionLabel>
              {resume.experience.slice(0, 3).map((exp, i) => (
                <div key={i}>
                  <p className="text-sm font-medium">{exp.title || 'Position'}</p>
                  <p className="text-xs text-muted-foreground">{exp.company || 'Company'}</p>
                </div>
              ))}
              {resume.experience.length > 3 && (
                <p className="text-xs text-muted-foreground">+{resume.experience.length - 3} more</p>
              )}
            </div>
          )}

          {hasEducation && (
            <div className="space-y-1.5">
              <ReviewSectionLabel>Education</ReviewSectionLabel>
              {resume.education.slice(0, 2).map((edu, i) => (
                <div key={i}>
                  <p className="text-sm font-medium">{typeof edu === 'string' ? edu : (edu.degree || 'Degree')}</p>
                  {typeof edu !== 'string' && (
                    <p className="text-xs text-muted-foreground">{edu.school || ''}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {!hasSummary && !hasHighlights && (
          <p className="flex items-start gap-2 rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            Add a target job in the previous step to get AI-generated summary and highlights.
          </p>
        )}
      </StepBody>
      <StepFooter>
        <Button variant="ghost" id="back-btn" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button id="next-btn" onClick={onCreate}>Create resume</Button>
      </StepFooter>
    </div>
  );
}

// --- Step 5: Final --------------------------------------------------------

export function FinalStep({ onFinish, onOpenProfile }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StepBody>
        <div className="flex flex-col items-center space-y-3 py-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-success-bg text-success">
            <Check className="size-6" />
          </div>
          <h2 className="text-lg font-semibold">Your resume is ready</h2>
          <p className="text-sm text-muted-foreground">
            You can now edit, style, and export your resume. Click any text to edit it directly,
            or use the AI assistant to improve your content.
          </p>
          <div className="flex items-center gap-2 pt-2">
            <Button variant="outline" onClick={onOpenProfile}>Set up profile</Button>
            <Button id="finish-btn" onClick={onFinish}>Start editing</Button>
          </div>
        </div>
      </StepBody>
    </div>
  );
}
