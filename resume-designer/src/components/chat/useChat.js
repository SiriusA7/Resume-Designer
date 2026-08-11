import { useState, useRef, useEffect, useCallback } from 'react';
import {
  chat, generateBullets, getFeedback, improveSummary, isConfigured, getConfiguredProviders,
  generateResumeChanges, getDefaultModelId, validateModelId, isSafeModelSlug, getAllModels,
  modelSupportsReasoning, getCustomModels, removeCustomModel, fetchModelCatalog,
  getAllCatalogModels, refreshCatalogIfStale, CATALOG_UPDATED_EVENT,
  profileInterviewChat, extractProfileFromInterview, saveExtractedProfile,
} from '../../aiService.js';
import { getSettings, saveSettings, getUserProfile, SETTINGS_UPDATED_EVENT } from '../../persistence.js';
import { store } from '../../store.js';
import { createChangeSet } from '../../diffEngine.js';
import { showDiffView } from '../../diffView.js';
import { showInlineChanges } from '../../inlineChanges.js';
import {
  loadThreads, persistThreads, makeThread, trimMessages, clearLegacyHistory,
  migrateThreads, pickCurrentThreadId, chooseThreadAfterDelete, withContextMarker,
} from '../../chatThreads.js';
import { getCurrentId, loadVariant, getVariantList } from '../../variantManager.js';

// AI model catalog for the picker's Featured section. This MUST be a function,
// not a module constant: the catalog refreshes at runtime, and a constant
// evaluated at import time could never reflect it.
// Shape: [{ group, options: [{ value: slug, label }] }]
export function getAIModels() {
  return Object.entries(getAllModels()).map(([group, models]) => ({
    group,
    options: models.map((m) => ({ value: m.id, label: m.label })),
  }));
}

const FALLBACK_MODEL = 'anthropic/claude-sonnet-4.6';

// Keywords that mark a message as a change request (→ diff flow) vs. a question.
const CHANGE_KEYWORDS = [
  'change', 'update', 'modify', 'edit', 'rewrite', 'improve', 'replace',
  'make it', 'make my', 'fix', 'adjust', 'enhance', 'revise', 'rework',
  'redo', 'transform', 'convert', 'add to', 'remove from', 'delete',
  'can you change', 'can you update', 'can you modify', 'can you edit',
  'please change', 'please update', 'please modify', 'please edit',
  'tailor', 'customize', 'personalize', 'optimize',
];

// ── Pure helpers (module scope; read settings/store at call time) ───────────

export function getModelLabel(value) {
  if (!value) return 'Select Model';
  for (const group of getAIModels()) {
    for (const opt of group.options) {
      if (opt.value === value) return opt.label;
    }
  }
  const fromCatalog = getAllCatalogModels().find((m) => m.id === value);
  if (fromCatalog) return fromCatalog.name;
  // Custom slug not in the catalog — prettify the model part of the slug.
  // e.g. "anthropic/claude-opus-4.8" -> "Claude Opus 4.8"
  const modelPart = String(value).split('/').pop() || String(value);
  const pretty = modelPart
    .replace(/[-_]/g, ' ')
    .replace(/\d{8,}/g, '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return pretty || 'Custom Model';
}

function getInitialModel() {
  const settings = getSettings();
  if (settings.defaultModel) return validateModelId(settings.defaultModel);
  return getDefaultModelId() || FALLBACK_MODEL;
}

function isChangeRequest(message) {
  const lower = message.toLowerCase();
  return CHANGE_KEYWORDS.some((k) => lower.includes(k));
}

// Label for a context chip derived from the captured resume content/path.
function getContextLabel(content, type, path) {
  switch (type) {
    case 'section': {
      const match = path?.match(/sections\[(\d+)\]/);
      if (match) {
        const section = store.getData()?.sections?.[parseInt(match[1], 10)];
        return section?.title || 'Section';
      }
      return 'Section';
    }
    case 'experience': {
      const match = path?.match(/experience\[(\d+)\]/);
      if (match) {
        const exp = store.getData()?.experience?.[parseInt(match[1], 10)];
        if (exp) return `${exp.title} @ ${exp.company}`;
      }
      return 'Experience Entry';
    }
    case 'bullet':
      return 'Bullet Point';
    case 'text':
    default: {
      const text = content.trim();
      return text.length > 40 ? `${text.substring(0, 40)}...` : text;
    }
  }
}

// State paired with a synchronously-updated ref. The async send flow reads the
// refs to dodge stale closures (the React translation of the old module-level
// mutable variables). On a value update the ref is set immediately; on a
// functional update it's set inside the reducer (only ever read during render).
function useStateRef(initial) {
  const [state, setState] = useState(initial);
  const ref = useRef(state);
  const set = useCallback((updater) => {
    if (typeof updater === 'function') {
      setState((prev) => {
        const next = updater(prev);
        ref.current = next;
        return next;
      });
    } else {
      ref.current = updater;
      setState(updater);
    }
  }, []);
  return [state, set, ref];
}

/**
 * The chat session engine. Owns the full conversation state machine (messages,
 * threads, loading, animated "thinking" steps, context chips, model/options,
 * profile-interview mode) and the send-flow routing + AI calls. Returns plain
 * state + imperative handlers for the view components to render and drive.
 */
export function useChat() {
  const [messages, setMessages, messagesRef] = useStateRef([]);
  const [threads, setThreads, threadsRef] = useStateRef([]);
  const [currentThreadId, setCurrentThreadId, currentThreadIdRef] = useStateRef(null);
  const [loading, setLoading, loadingRef] = useStateRef(false);
  const [thinking, setThinking] = useStateRef(null);
  const [contextChips, setContextChips, chipsRef] = useStateRef([]);
  const [currentModel, setCurrentModelState, modelRef] = useStateRef(getInitialModel());
  const [reasoningEffort, setReasoningEffortState, reasoningRef] = useStateRef(getSettings().chatReasoningEffort || 'medium');
  const [webSearchEnabled, setWebSearchState, webSearchRef] = useStateRef(!!getSettings().chatWebSearch);
  // Live streaming assistant turn (real reasoning + answer as they arrive),
  // separate from the synthetic `thinking` steps the non-streamed flows still use.
  const [streamingMessage, setStreamingMessage, streamingRef] = useStateRef(null);
  const abortRef = useRef(null);
  // The thread the in-flight `abortRef` stream ORIGINATED from, so deleting a thread
  // aborts the stream only when that thread is its origin — a reply that kept running
  // after the user switched away must survive deletion of the now-active thread. Also
  // exposed as state (streamThreadId) so the panel can show a "still generating in …"
  // banner with Stop when that origin isn't the thread currently on screen; the ref
  // half is read synchronously by deleteThread.
  const [streamThreadId, setStreamThreadId, streamThreadRef] = useStateRef(null);
  const flushRaf = useRef(0);

  const interviewModeRef = useRef(false);
  const interviewMsgsRef = useRef([]);
  // The thread `/profile` was started in. The interview only routes messages
  // (and honors /done) while that thread is active, so switching threads can't
  // funnel an unrelated thread's chat into the interview or let /done save from it.
  const interviewThreadIdRef = useRef(null);
  const idCounterRef = useRef(0);
  // Set by jumpToVariant() to the thread to KEEP open across the imminent resume
  // switch, so the variant-follow effect re-selects it instead of the target
  // resume's home thread. One-shot: the follow effect reads then clears it.
  const pinThreadIdRef = useRef(null);

  // Settings/catalog-derived values, held as state and refreshed explicitly at
  // the moments they can change (API keys saved, a model picked, the live model
  // catalog loading) — see refresh() and selectModel(). They read external
  // mutable state, so they can't be plain useMemo derivations.
  const [configured, setConfigured] = useState(() => isConfigured());
  const [configuredProviders, setConfiguredProviders] = useState(() => getConfiguredProviders());
  const [customModels, setCustomModels] = useState(() => (isConfigured() ? getCustomModels() : []));
  const [reasoningSupported, setReasoningSupported] = useState(() => modelSupportsReasoning(getInitialModel()));

  // Bumped whenever a catalog refresh lands, so every model picker re-renders
  // with the new list. Mirrors the SETTINGS_UPDATED_EVENT pattern.
  const [catalogRev, setCatalogRev] = useState(0);
  useEffect(() => {
    const onCatalog = () => {
      setCatalogRev((n) => n + 1);
      // Recompute reasoning support too. modelSupportsReasoning() reads the
      // catalog cache, and callOpenRouter re-reads it at send time — so if a
      // revalidation changes the selected model's supported_parameters and this
      // state stays stale, the two disagree silently: the composer keeps
      // offering reasoning that the request then omits, or keeps the control
      // disabled after support was added. The initial fetch and the
      // model-selection paths already do this; only later revalidations (the
      // picker's 5-minute stale-while-revalidate) reached here without it.
      setReasoningSupported(modelSupportsReasoning(modelRef.current));
    };
    window.addEventListener(CATALOG_UPDATED_EVENT, onCatalog);
    return () => window.removeEventListener(CATALOG_UPDATED_EVENT, onCatalog);
  }, [modelRef]);

  const refreshCustomModels = () => setCustomModels(isConfigured() ? getCustomModels() : []);

  const uid = () => `${Date.now()}-${idCounterRef.current++}`;

  // ── persistence + message appends ──────────────────────────────────────
  const persistCurrentThread = (msgs) => {
    const tid = currentThreadIdRef.current;
    if (!tid) return;
    const next = threadsRef.current.map((t) =>
      t.id === tid ? { ...t, messages: trimMessages(msgs), updatedAt: new Date().toISOString() } : t
    );
    setThreads(next);
    persistThreads(next);
  };

  const appendMessage = (msg) => {
    const next = [...messagesRef.current, msg];
    setMessages(next);
    persistCurrentThread(next);
  };

  const addMessage = (role, content, applyData = null) =>
    appendMessage({ id: uid(), role, content, applyData, variantId: getCurrentId(), timestamp: new Date().toISOString() });

  // Insert a context-switch divider into the current thread when the active
  // resume differs from the thread's last turn (no-op otherwise). Called at the
  // start of send() and handleCommand() so every flow is preceded by a divider
  // when the resume changed.
  // The active variant's LABEL (e.g. "Backend SWE") for the context divider — NOT
  // store.getData()?.name, which is the person's NAME printed on the resume and so
  // mislabelled every divider with the candidate's name instead of the resume.
  const activeVariantLabel = () =>
    getVariantList().find((v) => v.id === getCurrentId())?.name || '';

  const markContextIfSwitched = () => {
    const withMarker = withContextMarker(messagesRef.current, getCurrentId(), activeVariantLabel());
    if (withMarker !== messagesRef.current) {
      setMessages(withMarker);
      persistCurrentThread(withMarker);
    }
  };

  // Commit a finished turn to the thread that was active when the flow STARTED.
  // If the user switched threads mid-stream, persist into that original thread
  // without disturbing the current view (prevents wrong-thread commits).
  const commitToThread = (startThreadId, msg) => {
    if (!startThreadId || currentThreadIdRef.current === startThreadId) {
      appendMessage(msg);
      return;
    }
    const next = threadsRef.current.map((t) =>
      t.id === startThreadId
        ? { ...t, messages: trimMessages([...(t.messages || []), msg]), updatedAt: new Date().toISOString() }
        : t
    );
    setThreads(next);
    persistThreads(next);
  };

  // Commit a non-streamed helper turn (/feedback, /improve, /generate, interview)
  // to the thread + resume active when the flow STARTED (captured by the caller),
  // so a mid-request thread/resume switch can't misroute or mis-stamp it — the same
  // guarantee the streamed flows already get.
  const commitHelperTurn = (startThreadId, startVariantId, role, content, applyData = null) =>
    commitToThread(startThreadId, {
      id: uid(), role, content, applyData,
      variantId: startVariantId, timestamp: new Date().toISOString(),
    });

  // ── animated "thinking" process ────────────────────────────────────────
  // Helper flows (feedback / improve / bullets / interview) are origin-bound
  // like the streamed ones: beginThinking records the origin thread (so the
  // ThinkingBlock renders only there and the background banner covers it
  // elsewhere) and arms an AbortController (so the banner's Stop and the
  // thread/resume delete paths can cancel it). Returns the signal for the flow
  // to pass into its aiService call.
  const beginThinking = (originThreadId = null) => {
    setLoading(true);
    setThinking({ steps: [], phase: 'active' });
    const controller = new AbortController();
    abortRef.current = controller;
    if (originThreadId) setStreamThreadId(originThreadId);
    return controller.signal;
  };
  const endThinking = (ownerSignal) => {
    // A superseded async helper (its thread was deleted, or the user started
    // another request first) must NOT reset the shared abort/loading state on
    // its late completion — that would wipe the newer request's Stop control and
    // leave a stale loading flag. Gate by controller identity; deleteThread and
    // the rd:threads-deleted handler call with no owner to force an immediate clear.
    if (ownerSignal !== undefined && abortRef.current?.signal !== ownerSignal) return;
    setLoading(false);
    setThinking(null);
    abortRef.current = null;
    setStreamThreadId(null);
  };
  const addThinkingStep = (text) =>
    setThinking((t) => {
      const base = t || { steps: [], phase: 'active' };
      return { ...base, steps: [...base.steps, { text, complete: false }] };
    });
  const completeThinkingStep = (newStep = null) =>
    setThinking((t) => {
      if (!t) return t;
      const steps = t.steps.map((s, i) => (i === t.steps.length - 1 ? { ...s, complete: true } : s));
      if (newStep) steps.push({ text: newStep, complete: false });
      return { ...t, steps };
    });

  // ── live streaming (real reasoning + answer) ─────────────────────────────
  // Coalesce streamed deltas to one state write per animation frame so the
  // Markdown render + DOMPurify re-sanitize runs at display rate, not per token.
  const scheduleFlush = (patch) => {
    const base = streamingRef.current || {
      id: uid(), role: 'assistant', streaming: true, content: '', reasoning: '',
      reasoningDetails: [], annotations: [], run: null, timestamp: new Date().toISOString(),
    };
    streamingRef.current = { ...base, ...patch(base) };
    if (flushRaf.current) return;
    flushRaf.current = requestAnimationFrame(() => {
      flushRaf.current = 0;
      setStreamingMessage(streamingRef.current);
    });
  };
  const clearStreaming = () => {
    if (flushRaf.current) { cancelAnimationFrame(flushRaf.current); flushRaf.current = 0; }
    setStreamingMessage(null);
    streamingRef.current = null;
    abortRef.current = null;
    setStreamThreadId(null);
  };
  // Reset the shared streaming + loading state ONLY when `controller` is still
  // the current request. A superseded streamed run (its thread deleted, or the
  // user started another request first) commits its own turn but must not clear
  // the newer request's abortRef/stream/loading — that would break its Stop and
  // show a stale loading state.
  const finishRequest = (controller) => {
    if (abortRef.current !== controller) return;
    clearStreaming();
    setLoading(false);
  };
  // Drop the live streaming display from the CURRENT view WITHOUT aborting the
  // request or discarding its buffer — used on a thread switch so an in-flight
  // reply keeps running and commits to its origin thread (commitToThread); the
  // gated hooks below won't repaint it in the thread we switched to.
  const clearStreamingDisplay = () => {
    if (flushRaf.current) { cancelAnimationFrame(flushRaf.current); flushRaf.current = 0; }
    const buffered = streamingRef.current;
    setStreamingMessage(null);
    // setStreamingMessage syncs streamingRef, so put the buffer back afterwards:
    // this is a DISPLAY-only clear. The buffered partial reply must survive so
    // reopening the origin thread can repaint it (syncStreamingDisplay below).
    streamingRef.current = buffered;
  };
  // Called whenever a navigation makes `threadId` current: repaint the buffered
  // live stream if that thread owns the in-flight request, else drop the display
  // from this view. Without the repaint, reopening the origin thread showed
  // nothing until the next delta — the banner hides (origin is now current), no
  // StreamingBubble/Stop renders, and the composer stays disabled, so a stalled
  // request left no visible way to cancel from the very thread that owns it.
  const syncStreamingDisplay = (threadId) => {
    // The streamingRef guard keeps this to STREAMED flows (which always seed a
    // buffer at request start): helper flows now also own abortRef/the origin
    // thread but paint through the ThinkingBlock, not a streaming bubble —
    // repainting for them would conjure an empty bubble beside the thinker.
    if (abortRef.current && streamThreadRef.current === threadId && streamingRef.current) {
      scheduleFlush(() => ({}));
    } else {
      clearStreamingDisplay();
    }
  };
  const stop = () => { if (abortRef.current) abortRef.current.abort(); };

  // ── AI flows ───────────────────────────────────────────────────────────
  const getAIResponse = async (userMessage, hasExplicitContext = false) => {
    const modelId = modelRef.current;
    const startThreadId = currentThreadIdRef.current;
    // Capture the active resume at request START. The reply commits to
    // startThreadId, so it must also be stamped with the variant that thread
    // belongs to — using getCurrentId() at completion would mis-stamp the turn
    // (and corrupt lastTurnVariantId/context dividers) if the user switched
    // resumes mid-stream.
    const startVariantId = getCurrentId();
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamThreadId(startThreadId);
    // Last 10 user/assistant turns; replace the final turn with the
    // context-augmented version we actually want to send. reasoningDetails ride
    // along on assistant turns for Anthropic thinking continuity.
    const history = messagesRef.current
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content, reasoningDetails: m.reasoningDetails }));
    if (history.length > 0) history[history.length - 1].content = userMessage;

    setStreamingMessage({
      id: uid(), role: 'assistant', streaming: true, content: '', reasoning: '',
      reasoningDetails: [], annotations: [], run: null, timestamp: new Date().toISOString(),
    });

    try {
      const res = await chat(modelId, history, !hasExplicitContext, {
        reasoningEffort: reasoningRef.current,
        webSearch: webSearchRef.current,
        signal: controller.signal,
        structured: true,
        hooks: {
          // Only paint the live stream while its origin thread is in view — if the
          // user switched away, keep buffering/finishing but don't leak it into the
          // thread they're now looking at (the full reply still commits below).
          onReasoning: (_d, full) => { if (currentThreadIdRef.current === startThreadId) scheduleFlush(() => ({ reasoning: full })); },
          onContent: (_d, full) => { if (currentThreadIdRef.current === startThreadId) scheduleFlush(() => ({ content: full })); },
          onAnnotations: (list) => { if (currentThreadIdRef.current === startThreadId) scheduleFlush(() => ({ annotations: list })); },
        },
      });
      finishRequest(controller);
      commitToThread(startThreadId, {
        id: uid(), role: 'assistant',
        content: res.stopped ? (res.text ? `${res.text}\n\n_(stopped)_` : '_(stopped)_') : res.text,
        reasoning: res.reasoning, reasoningDetails: res.reasoningDetails,
        annotations: res.annotations, run: res.run, variantId: startVariantId, timestamp: new Date().toISOString(),
      });
      refreshCustomModels(); // chat() records any newly-used custom slug
    } catch (error) {
      finishRequest(controller);
      commitToThread(startThreadId, { id: uid(), role: 'error', content: error.message, variantId: startVariantId, timestamp: new Date().toISOString() });
    }
  };

  const getAIFeedback = async () => {
    const startThreadId = currentThreadIdRef.current;
    const startVariantId = getCurrentId();
    const signal = beginThinking(startThreadId);
    try {
      addThinkingStep('Analyzing your resume...');
      const response = await getFeedback(modelRef.current, { signal });
      // chat()'s stream path RESOLVES with partial text on abort (the stopped
      // flag is dropped for plain-string callers) — don't present a truncated
      // reply as a finished one.
      if (signal.aborted) {
        endThinking(signal);
        commitHelperTurn(startThreadId, startVariantId, 'assistant',
          response ? `${response}\n\n_(stopped)_` : '_(stopped)_');
        return;
      }
      completeThinkingStep('Feedback ready');
      endThinking(signal);
      commitHelperTurn(startThreadId, startVariantId, 'assistant', response);
    } catch (error) {
      endThinking(signal);
      if (signal.aborted) commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
      else commitHelperTurn(startThreadId, startVariantId, 'error', error.message);
    }
  };

  const getAIImproveSummary = async () => {
    const startThreadId = currentThreadIdRef.current;
    const startVariantId = getCurrentId();
    const signal = beginThinking(startThreadId);
    try {
      addThinkingStep('Reading current summary...');
      await new Promise((r) => setTimeout(r, 200));
      // improveSummary builds its prompt from the ACTIVE resume only now — if
      // the user switched resumes during the wait, generating would produce the
      // other resume's summary stamped (and Apply-gated) as this one's, and
      // applying it would overwrite this resume with the other's summary. Bail
      // to a note instead, matching the change-request cross-resume pattern.
      if (getCurrentId() !== startVariantId) {
        endThinking(signal);
        commitHelperTurn(startThreadId, startVariantId, 'assistant',
          'The active resume changed while I was reading the summary — switch back to the resume you want improved and resend /improve summary.');
        return;
      }
      completeThinkingStep('Writing improved summary...');
      const response = await improveSummary(modelRef.current, { signal });
      // On abort the call RESOLVES with partial/empty text — committing it with
      // apply-summary would offer an Apply that overwrites the real summary
      // with a truncated one. Commit a stopped note with NO applyData instead.
      if (signal.aborted) {
        endThinking(signal);
        commitHelperTurn(startThreadId, startVariantId, 'assistant',
          response ? `${response}\n\n_(stopped)_` : '_(stopped)_');
        return;
      }
      completeThinkingStep('Summary improved');
      endThinking(signal);
      commitHelperTurn(startThreadId, startVariantId, 'assistant', response, { action: 'apply-summary', value: response });
    } catch (error) {
      endThinking(signal);
      if (signal.aborted) commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
      else commitHelperTurn(startThreadId, startVariantId, 'error', error.message);
    }
  };

  const getAIGenerateBullets = async (context) => {
    const startThreadId = currentThreadIdRef.current;
    const startVariantId = getCurrentId();
    const signal = beginThinking(startThreadId);
    try {
      addThinkingStep('Generating bullet points...');
      const response = await generateBullets(modelRef.current, context, 3, { signal });
      if (signal.aborted) {
        endThinking(signal);
        commitHelperTurn(startThreadId, startVariantId, 'assistant',
          response ? `${response}\n\n_(stopped)_` : '_(stopped)_');
        return;
      }
      completeThinkingStep('Bullets generated');
      endThinking(signal);
      commitHelperTurn(startThreadId, startVariantId, 'assistant', response);
    } catch (error) {
      endThinking(signal);
      if (signal.aborted) commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
      else commitHelperTurn(startThreadId, startVariantId, 'error', error.message);
    }
  };

  const requestAIChanges = async (instruction, targetPath = null, hasExplicitContext = false) => {
    const startThreadId = currentThreadIdRef.current;
    // Stamp the committed turns with the resume active at request START (the one
    // startThreadId belongs to), not getCurrentId() at completion — see getAIResponse.
    const startVariantId = getCurrentId();
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamThreadId(startThreadId);
    // Stream the model's reasoning live (the JSON answer is buffered and parsed
    // into a diff when the stream completes).
    setStreamingMessage({
      id: uid(), role: 'assistant', streaming: true, content: '', reasoning: '',
      reasoningDetails: [], annotations: [], run: null, timestamp: new Date().toISOString(),
    });
    let capturedRun = null;
    let capturedReasoning = '';
    try {
      const result = await generateResumeChanges(modelRef.current, instruction, targetPath, null, 'generate', {
        reasoningEffort: reasoningRef.current,
        signal: controller.signal,
        hooks: {
          onReasoning: (_d, full) => {
            capturedReasoning = full;
            // Paint live only while the origin thread is in view (see getAIResponse).
            if (currentThreadIdRef.current === startThreadId) scheduleFlush(() => ({ reasoning: full }));
          },
          onRun: (r) => { capturedRun = r; },
        },
      });
      finishRequest(controller);

      if (!result.changes || Object.keys(result.changes).length === 0) {
        // Nothing to apply. The router that sent us here is keyword-based
        // (isChangeRequest), so questions land in this path constantly —
        // "how would you improve my summary?" contains "improve" — and the
        // change model answers them by explaining why it made no edits: "No
        // resume edits were made because this was a question rather than an
        // edit request." That is a non-answer to a question the user actually
        // asked. Ask conversationally instead and let the real reply stand on
        // its own.
        //
        // Only when the origin thread is still the one in view: getAIResponse
        // captures currentThreadId itself, so retrying after a mid-request
        // switch would commit this thread's answer into another one.
        if (currentThreadIdRef.current === startThreadId) {
          await getAIResponse(instruction, hasExplicitContext);
          return;
        }
        commitToThread(startThreadId, {
          id: uid(), role: 'assistant',
          content: result.explanation || 'No changes were generated. The AI may need more specific instructions.',
          reasoning: capturedReasoning || null, run: capturedRun,
          variantId: startVariantId, timestamp: new Date().toISOString(),
        });
        return;
      }

      const count = Object.keys(result.changes).length;
      // The edits were generated for the resume active at request START. If the
      // user switched resumes before it returned, building the diff against the
      // now-current store.getData() (and showing/applying it) would write the old
      // resume's edits into the new one — so don't; tell them to switch back.
      if (getCurrentId() !== startVariantId) {
        commitToThread(startThreadId, {
          id: uid(), role: 'assistant',
          content: `${result.explanation || `Generated ${count} change${count > 1 ? 's' : ''}`}\n\nThese edits are for the resume you started from — switch back to it and resend to apply them.`,
          reasoning: capturedReasoning || null, run: capturedRun,
          variantId: startVariantId, timestamp: new Date().toISOString(),
        });
        return;
      }

      const changeSet = createChangeSet(store.getData(), result.changes);
      showInlineChanges(changeSet);

      commitToThread(startThreadId, {
        id: uid(), role: 'assistant',
        content: `${result.explanation || `Generated ${count} change${count > 1 ? 's' : ''} to your resume.`}\n\nChanges are highlighted on your resume. Use the buttons to apply or reject individual changes, or click "Review changes" below for a detailed diff view.`,
        reasoning: capturedReasoning || null, run: capturedRun,
        variantId: startVariantId, timestamp: new Date().toISOString(),
        pendingChanges: changeSet,
      });
    } catch (error) {
      finishRequest(controller);
      // A user Stop aborts the buffered JSON mid-stream → JSON.parse fails. Show a
      // clean "(stopped)" turn instead of a misleading "not valid JSON" error.
      commitToThread(startThreadId, controller.signal.aborted
        ? { id: uid(), role: 'assistant', content: '_(stopped)_', variantId: startVariantId, timestamp: new Date().toISOString() }
        : { id: uid(), role: 'error', content: error.message, variantId: startVariantId, timestamp: new Date().toISOString() });
    }
  };

  // ── profile interview ──────────────────────────────────────────────────
  // True only while an interview is active AND its origin thread is the one in view.
  const interviewActiveHere = () =>
    interviewModeRef.current && interviewThreadIdRef.current === currentThreadIdRef.current;

  const startInterview = async () => {
    if (getConfiguredProviders().length === 0) {
      addMessage('error', 'Please configure an API key in settings before starting a profile interview.');
      return;
    }
    // The Profile dialog fires rd:chat-start-interview directly, bypassing
    // send()'s loading guard — starting here mid-request would overwrite the
    // running request's abortRef/streamThreadId and orphan its Stop.
    if (loadingRef.current) {
      addMessage('error', 'Another request is still running — stop it or let it finish before starting the interview.');
      return;
    }
    interviewModeRef.current = true;
    const startThreadId = currentThreadIdRef.current;
    const startVariantId = getCurrentId();
    interviewThreadIdRef.current = startThreadId;
    interviewMsgsRef.current = [];
    addMessage('assistant', `**Profile Interview Started**

I'll ask you some questions to learn about your professional background. This information will help me give you better resume suggestions.

When you're done, type \`/done\` to save the information to your profile.

Let's begin!`);

    const signal = beginThinking(startThreadId);
    try {
      addThinkingStep('Starting interview...');
      interviewMsgsRef.current.push({ role: 'user', content: 'Please start the interview.' });
      const response = await profileInterviewChat(modelRef.current, interviewMsgsRef.current, { signal });
      if (signal.aborted) {
        endThinking(signal);
        interviewModeRef.current = false;
        interviewThreadIdRef.current = null;
        commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
        return;
      }
      interviewMsgsRef.current.push({ role: 'assistant', content: response });
      completeThinkingStep('Ready');
      endThinking(signal);
      commitHelperTurn(startThreadId, startVariantId, 'assistant', response);
    } catch (error) {
      endThinking(signal);
      interviewModeRef.current = false;
      interviewThreadIdRef.current = null;
      if (signal.aborted) commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
      else commitHelperTurn(startThreadId, startVariantId, 'error', `Failed to start interview: ${error.message}`);
    }
  };

  const continueInterview = async (userMessage) => {
    const startThreadId = currentThreadIdRef.current;
    const startVariantId = getCurrentId();
    interviewMsgsRef.current.push({ role: 'user', content: userMessage });
    const signal = beginThinking(startThreadId);
    try {
      addThinkingStep('Thinking...');
      const response = await profileInterviewChat(modelRef.current, interviewMsgsRef.current, { signal });
      if (signal.aborted) {
        endThinking(signal);
        commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
        return;
      }
      interviewMsgsRef.current.push({ role: 'assistant', content: response });
      completeThinkingStep('Response ready');
      endThinking(signal);
      commitHelperTurn(startThreadId, startVariantId, 'assistant', response);
    } catch (error) {
      endThinking(signal);
      // On abort the interview stays active — the user can just answer again.
      if (signal.aborted) commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
      else commitHelperTurn(startThreadId, startVariantId, 'error', error.message);
    }
  };

  const finishInterview = async () => {
    const startThreadId = currentThreadIdRef.current;
    const startVariantId = getCurrentId();
    if (interviewMsgsRef.current.length < 4) {
      commitHelperTurn(startThreadId, startVariantId, 'assistant', "We haven't talked enough yet! Please answer a few more questions so I have information to save.");
      return;
    }
    const signal = beginThinking(startThreadId);
    try {
      addThinkingStep('Analyzing conversation...');
      const extracted = await extractProfileFromInterview(modelRef.current, interviewMsgsRef.current, { signal });
      // Never save a profile parsed from an aborted (possibly truncated) call;
      // the interview stays active so /done can simply be sent again.
      if (signal.aborted) {
        endThinking(signal);
        commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
        return;
      }
      completeThinkingStep('Saving to profile...');
      saveExtractedProfile(extracted);
      completeThinkingStep('Profile updated!');
      endThinking(signal);

      interviewModeRef.current = false;
      interviewThreadIdRef.current = null;
      interviewMsgsRef.current = [];

      let summary = "**Profile Updated!**\n\nI've saved the following information to your profile:\n\n";
      if (extracted.personalSummary) summary += '- Personal summary\n';
      if (extracted.careerGoals) summary += '- Career goals\n';
      if (extracted.workExperience?.length > 0) summary += `- ${extracted.workExperience.length} work experience entries\n`;
      if (extracted.skills?.length > 0) summary += `- ${extracted.skills.length} skills\n`;
      if (extracted.education?.length > 0) summary += `- ${extracted.education.length} education entries\n`;
      if (extracted.projects?.length > 0) summary += `- ${extracted.projects.length} projects\n`;
      if (extracted.certifications?.length > 0) summary += `- ${extracted.certifications.length} certifications\n`;
      if (extracted.achievements?.length > 0) summary += `- ${extracted.achievements.length} achievements\n`;
      if (extracted.industryKnowledge) summary += '- Industry knowledge\n';
      if (extracted.preferences) summary += '- Work preferences\n';
      summary += '\nYou can view and edit your profile from **Tools > User Profile**.';
      commitHelperTurn(startThreadId, startVariantId, 'assistant', summary);
    } catch (error) {
      endThinking(signal);
      // Abort keeps the interview active so /done can simply be sent again.
      if (signal.aborted) commitHelperTurn(startThreadId, startVariantId, 'assistant', '_(stopped)_');
      else commitHelperTurn(startThreadId, startVariantId, 'error', `Failed to extract profile: ${error.message}\n\nYou can try \`/done\` again or continue the conversation.`);
    }
  };

  // ── simple commands ────────────────────────────────────────────────────
  const clearHistory = () => {
    setMessages([]);
    persistCurrentThread([]);
    clearLegacyHistory();
  };

  const showHelp = () => addMessage('assistant', `**Available Commands:**

• **/feedback** - Get detailed feedback on your resume
• **/improve summary** - Get an improved version of your summary
• **/improve [section]** - Get suggestions for a specific section
• **/generate [context]** - Generate bullet points based on context
• **/profile** - Start AI interview to fill your profile
• **/done** - Finish profile interview and save
• **/clear** - Clear chat history
• **/help** - Show this help message

**Tips:**
- You can also just type naturally and ask questions about your resume
- Click "Apply to Resume" buttons to directly update your resume
- Use the shortcut buttons below the input for quick actions
- Your User Profile info is automatically included in AI context`);

  const showDebugInfo = () => {
    const profile = getUserProfile();
    const hasProfile = profile && (
      profile.personalSummary || profile.careerGoals ||
      profile.workExperience?.length > 0 || profile.skills?.length > 0
    );
    let msg = '**Debug Information:**\n\n';
    msg += `**Profile Interview Mode:** ${interviewModeRef.current ? 'Active' : 'Inactive'}\n`;
    msg += `**Interview Messages:** ${interviewMsgsRef.current.length}\n\n`;
    msg += '**User Profile Status:**\n';
    if (!profile) {
      msg += '- Profile: Not found\n';
    } else {
      msg += `- Personal Summary: ${profile.personalSummary ? `Set (${profile.personalSummary.length} chars)` : 'Empty'}\n`;
      msg += `- Career Goals: ${profile.careerGoals ? 'Set' : 'Empty'}\n`;
      msg += `- Work Experience: ${profile.workExperience?.length || 0} entries\n`;
      msg += `- Skills: ${profile.skills?.length || 0} entries\n`;
      msg += `- Education: ${profile.education?.length || 0} entries\n`;
      msg += `- Projects: ${profile.projects?.length || 0} entries\n`;
      msg += `- Industry Knowledge: ${profile.industryKnowledge ? 'Set' : 'Empty'}\n`;
      msg += `- Preferences: ${profile.preferences ? 'Set' : 'Empty'}\n`;
    }
    msg += `\n**AI Context:** ${hasProfile ? 'Profile will be included in AI requests' : 'Profile is empty, not included in AI requests'}`;
    addMessage('assistant', msg);
  };

  const handleCommand = async (command) => {
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (cmd) {
      case '/feedback':
        markContextIfSwitched();
        addMessage('user', 'Please review my resume and provide feedback.');
        await getAIFeedback();
        break;
      case '/improve':
        markContextIfSwitched();
        if (args.toLowerCase().includes('summary')) {
          addMessage('user', 'Please improve my resume summary.');
          await getAIImproveSummary();
        } else {
          addMessage('user', `Please improve: ${args}`);
          await getAIResponse(`Please improve this section of my resume: ${args}`);
        }
        break;
      case '/generate':
        markContextIfSwitched();
        addMessage('user', `Generate content: ${args}`);
        await getAIGenerateBullets(args);
        break;
      case '/clear':
        clearHistory();
        break;
      case '/help':
        showHelp();
        break;
      case '/profile':
        markContextIfSwitched();
        await startInterview();
        break;
      case '/done':
        if (interviewActiveHere()) { markContextIfSwitched(); await finishInterview(); }
        else addMessage('assistant', 'No active interview to finish. Use `/profile` to start a profile interview.');
        break;
      case '/debug':
        showDebugInfo();
        break;
      default:
        addMessage('assistant', `Unknown command: ${cmd}\n\nAvailable commands:\n• /feedback - Get resume feedback\n• /improve [section] - Improve a section\n• /generate [context] - Generate bullet points\n• /profile - Start AI interview to fill your profile\n• /done - Finish profile interview and save\n• /clear - Clear chat history\n• /help - Show this help`);
    }
  };

  // ── send entry point ───────────────────────────────────────────────────
  const send = async (rawText) => {
    const text = (rawText || '').trim();
    if (!text || loadingRef.current) return;

    if (getConfiguredProviders().length === 0) {
      addMessage('error', 'Please configure an API key in settings before using the AI assistant.');
      return;
    }
    if (text.startsWith('/')) {
      await handleCommand(text);
      return;
    }

    const chips = chipsRef.current;
    let messageWithContext = text;
    if (chips.length > 0) {
      const contextText = chips.map((chip) => `[${chip.label}]:\n${chip.content}`).join('\n\n');
      messageWithContext = `Context from resume:\n${contextText}\n\n---\n\nUser request: ${text}`;
    }

    markContextIfSwitched();
    addMessage('user', text);
    const targetPath = chips.length > 0 ? chips[0].path : null;
    clearChips();

    if (interviewActiveHere()) {
      await continueInterview(text);
      return;
    }
    if (isChangeRequest(text)) await requestAIChanges(messageWithContext, targetPath, chips.length > 0);
    else await getAIResponse(messageWithContext, chips.length > 0);
  };

  // ── context chips ──────────────────────────────────────────────────────
  const addChip = (chip) => {
    const exists = chipsRef.current.some(
      (c) => (c.path && c.path === chip.path) || c.content === chip.content
    );
    if (!exists) setContextChips([...chipsRef.current, chip]);
  };
  const openWithContext = ({ context, path, type = 'text' }) => {
    if (!context) return;
    addChip({ type, path: path || '', content: context, label: getContextLabel(context, type, path) });
  };
  const removeChip = (index) => setContextChips(chipsRef.current.filter((_, i) => i !== index));
  const clearChips = () => setContextChips([]);

  // ── threads ────────────────────────────────────────────────────────────
  const switchThread = (threadId, save = true) => {
    const thread = threadsRef.current.find((t) => t.id === threadId);
    if (!thread) return;
    // Never abort the in-flight stream on a switch — it keeps running and commits
    // to its origin thread via commitToThread (the captured start id). Aborting
    // here would turn a mid-response switch into a lost "(stopped)" turn. Sync the
    // display instead: repaint the buffered bubble when switching BACK TO the
    // stream's origin (incl. via the background-stream banner), drop it otherwise.
    syncStreamingDisplay(threadId);
    // Save the outgoing thread's messages AND bump the target's updatedAt in one
    // write. Variant/startup selection (pickCurrentThreadId) opens the most-
    // recently-updated thread, so without bumping the target the saved-on-exit
    // outgoing thread would reopen instead of the one the user switched to.
    const now = new Date().toISOString();
    const outgoingId = currentThreadIdRef.current;
    const next = threadsRef.current.map((t) => {
      // The selected thread becomes the most-recent so selection reopens it.
      if (t.id === threadId) return { ...t, updatedAt: now };
      // Save the outgoing thread's messages but DON'T bump its updatedAt — else
      // it ties/outranks the target and selection reopens the thread we just left.
      if (save && outgoingId && t.id === outgoingId) {
        return { ...t, messages: trimMessages(messagesRef.current) };
      }
      return t;
    });
    setThreads(next);
    persistThreads(next);
    setCurrentThreadId(threadId);
    setMessages(thread.messages || []);
  };
  const newThread = () => {
    const t = makeThread('New Chat', [], getCurrentId());
    const next = [t, ...threadsRef.current];
    setThreads(next);
    persistThreads(next);
    switchThread(t.id, true);
  };
  // Give a thread an explicit name. Deliberately does NOT bump updatedAt:
  // selection reopens the most-recently-updated thread, so renaming one would
  // otherwise change which thread opens next time the panel does.
  const renameThread = (threadId, name) => {
    const title = (name || '').trim();
    if (!title) return;
    const next = threadsRef.current.map((t) => (t.id === threadId ? { ...t, name: title } : t));
    setThreads(next);
    persistThreads(next);
  };
  const deleteThread = (threadId) => {
    if (!threadsRef.current.some((t) => t.id === threadId)) return; // not found
    // Abort the in-flight reply ONLY when it ORIGINATED from the thread being deleted
    // (its commit target is about to vanish). Keying off the stream's origin — not
    // which thread happens to be active — means a reply still streaming in thread A
    // survives the user switching to and deleting thread B, and conversely a reply
    // running in a background thread is aborted when THAT thread is deleted.
    if (abortRef.current && streamThreadRef.current === threadId) {
      abortRef.current.abort();
      clearStreaming();
      // The aborted run may be a HELPER (ThinkingBlock UI): clearStreaming
      // drops streamThreadId, so without this the still-set thinking/loading
      // would paint the spinner into the replacement thread until the aborted
      // call settles. No-op for streams (thinking is already null). No owner —
      // force the clear now; the aborted run's own late endThinking is gated.
      endThinking();
    }
    if (threadId === currentThreadIdRef.current) {
      // Keep selection within the active resume — open its most-recent remaining
      // thread or create a fresh homed one, never an unrelated General/other-resume
      // thread (and never an empty panel).
      const { threads: next, currentThreadId: pick } =
        chooseThreadAfterDelete(threadsRef.current, threadId, getCurrentId());
      setThreads(next);
      persistThreads(next);
      setCurrentThreadId(pick);
      setMessages(next.find((t) => t.id === pick)?.messages || []);
      // The pick can be the origin of a stream still running in the background
      // (deleting thread B while A streams hidden) — repaint its bubble.
      syncStreamingDisplay(pick);
    } else {
      const next = threadsRef.current.filter((t) => t.id !== threadId);
      setThreads(next);
      persistThreads(next);
    }
  };
  // Switch the active resume from inside a thread (the context divider or the
  // cross-resume banner) WITHOUT losing the open thread. Pin the current thread so
  // the variant-follow effect re-selects it instead of the target's home thread.
  const jumpToVariant = (variantId) => {
    if (!variantId) return;
    pinThreadIdRef.current = currentThreadIdRef.current;
    // loadVariant emits 'dataLoaded' → the follow effect consumes the pin. If it
    // bails (unknown id, no event fired), clear the pin so it can't leak onto a
    // later, unrelated resume switch.
    if (!loadVariant(variantId)) pinThreadIdRef.current = null;
  };

  // Re-home a thread to the active resume (the "Move here" affordance).
  const moveThreadToCurrentVariant = (threadId) => {
    const activeId = getCurrentId();
    const next = threadsRef.current.map((t) =>
      t.id === threadId ? { ...t, homeVariantId: activeId, updatedAt: new Date().toISOString() } : t);
    setThreads(next);
    persistThreads(next);
  };

  // ── model + options ────────────────────────────────────────────────────
  const selectModel = (value) => {
    setCurrentModelState(value);
    setReasoningSupported(modelSupportsReasoning(value));
    saveSettings({ defaultModel: value });
  };
  const applyCustomSlug = (slug) => {
    const s = (slug || '').trim();
    if (!s || !isSafeModelSlug(s)) return false;
    selectModel(s);
    return true;
  };
  const removeCustomModelEntry = (slug) => {
    removeCustomModel(slug);
    // Fall back to the built-in default, NOT getInitialModel(): settings still
    // points at the just-removed (valid) slug, so getInitialModel() would
    // re-select what we just removed.
    if (slug === modelRef.current) selectModel(getDefaultModelId() || FALLBACK_MODEL);
    refreshCustomModels();
  };
  const setReasoning = (level) => { setReasoningEffortState(level); saveSettings({ chatReasoningEffort: level }); };
  const toggleWebSearch = () => {
    const next = !webSearchRef.current;
    setWebSearchState(next);
    saveSettings({ chatWebSearch: next });
  };

  // ── misc actions ───────────────────────────────────────────────────────
  const applyAction = (action, value) => {
    if (action === 'apply-summary') {
      // The resume re-renders via main.js's store subscription, so no explicit
      // onApply callback is needed here.
      store.update('summary', value);
      addMessage('assistant', '✓ Summary updated successfully!');
    } else {
      console.log('Unknown apply action:', action);
    }
  };
  const openDiffForMessage = (messageId) => {
    const m = messagesRef.current.find((x) => x.id === messageId);
    if (m?.pendingChanges) showDiffView(m.pendingChanges);
  };

  const refresh = useCallback(() => {
    const model = getInitialModel();
    setConfigured(isConfigured());
    setConfiguredProviders(getConfiguredProviders());
    setCustomModels(isConfigured() ? getCustomModels() : []);
    setCurrentModelState(model);
    setReasoningSupported(modelSupportsReasoning(model));
  }, [setCurrentModelState]);

  // ── effects ────────────────────────────────────────────────────────────
  useEffect(() => {
    const { threads: loaded, currentThreadId: persistedCid } = loadThreads();
    const migrated = migrateThreads(loaded);
    const activeId = getCurrentId();
    let cid = pickCurrentThreadId(migrated, activeId);
    let threadsToSet = migrated;
    // Open the active variant's most-recent thread. If it has none, create a
    // fresh homed thread — but only when we actually have an active variant id.
    // On a falsy active id (shouldn't happen post-init), fall back to the
    // persisted current thread and let the dataLoaded follow-effect settle it,
    // rather than creating a stray General (homeVariantId:null) thread.
    if (!cid) {
      if (activeId) {
        const t = makeThread('New Chat', [], activeId);
        threadsToSet = [t, ...migrated];
        cid = t.id;
      } else {
        cid = persistedCid;
      }
    }
    setThreads(threadsToSet);
    persistThreads(threadsToSet);
    setCurrentThreadId(cid);
    setMessages(threadsToSet.find((t) => t.id === cid)?.messages || []);
    fetchModelCatalog()
      .then(() => setReasoningSupported(modelSupportsReasoning(modelRef.current)))
      .catch(() => {});
  }, [setThreads, setCurrentThreadId, setMessages, modelRef]);

  // Follow the active resume: when the user switches variants (store emits
  // 'dataLoaded'), persist the current thread, reload threads from storage (to
  // pick up any external mutation, e.g. a variant delete), and open that
  // variant's most-recent thread — creating a fresh homed one if it has none.
  useEffect(() => {
    const unsub = store.subscribe((event) => {
      if (event !== 'dataLoaded') return;
      const activeId = getCurrentId();
      // Re-read from storage FIRST so an external mutation in this same tick (e.g. a
      // variant delete that reassigned/removed threads in Header) is not clobbered by
      // a stale in-memory write.
      let next = migrateThreads(loadThreads().threads);
      // Save the OUTGOING thread's latest messages onto the fresh array — but only if
      // it still exists (a deleted thread must not be resurrected). trimMessages()
      // caps the tail + strips heavy reasoning blobs, matching the append/switch
      // paths so a variant switch can't persist an oversize/quota-busting thread.
      const prevId = currentThreadIdRef.current;
      if (prevId && next.some((t) => t.id === prevId)) {
        next = next.map((t) =>
          t.id === prevId ? { ...t, messages: trimMessages(messagesRef.current), updatedAt: new Date().toISOString() } : t);
      }
      // An explicit in-thread jump (jumpToVariant) pins the thread to KEEP open, so
      // following the resume doesn't swap a cross-resume thread out from under the
      // user. One-shot — read and clear. Falls through to normal selection if the
      // pinned thread has since vanished.
      const pinned = pinThreadIdRef.current;
      pinThreadIdRef.current = null;
      let cid = pinned && next.some((t) => t.id === pinned) ? pinned : pickCurrentThreadId(next, activeId);
      if (!cid && activeId) {
        const t = makeThread('New Chat', [], activeId);
        next = [t, ...next];
        cid = t.id;
      }
      // Navigating resumes must NOT abort an in-flight reply — it commits to its
      // origin thread via commitToThread(startThreadId). Sync the display: the
      // selection can land on the stream's own origin thread (a pinned jump-back
      // or most-recent pick), where the buffered bubble must repaint.
      syncStreamingDisplay(cid);
      // Persist unconditionally so the migration write-back is guaranteed,
      // matching the init effect (whether or not a fresh thread was created).
      persistThreads(next);
      setThreads(next);
      setCurrentThreadId(cid);
      setMessages(next.find((t) => t.id === cid)?.messages || []);
    });
    return unsub;
  }, [setThreads, setCurrentThreadId, setMessages]);

  useEffect(() => {
    const onSettings = () => refresh();
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettings);
  }, [refresh]);

  // Deleting a resume WITH its threads (Header.handleDelete) drops them straight
  // in storage — it can't go through deleteThread. If the in-flight stream's
  // origin is among the dropped ids, its commit target is gone and the banner
  // can no longer render it (the thread lookup fails) while `loading` keeps the
  // composer disabled — so abort it, mirroring deleteThread's origin-abort.
  // Refs only, so the mount-once closure stays correct.
  useEffect(() => {
    const onThreadsDeleted = (e) => {
      const ids = e.detail?.threadIds;
      if (!Array.isArray(ids) || !abortRef.current) return;
      if (ids.includes(streamThreadRef.current)) {
        abortRef.current.abort();
        clearStreaming();
        // Helper runs paint through thinking/loading — clear them too so the
        // spinner can't leak into whichever thread becomes current (no-op for
        // streams, whose thinking is already null). No owner — force the clear.
        endThinking();
      }
    };
    window.addEventListener('rd:threads-deleted', onThreadsDeleted);
    return () => window.removeEventListener('rd:threads-deleted', onThreadsDeleted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // state
    messages, threads, currentThreadId, loading, thinking, streamingMessage, streamThreadId, contextChips,
    currentModel, reasoningEffort, webSearchEnabled,
    configured, configuredProviders, reasoningSupported, customModels,
    catalogRev, refreshCatalog: refreshCatalogIfStale,
    // active resume (re-read each render; the follow effect re-renders on switch)
    currentVariantId: getCurrentId(),
    // actions
    send, stop, selectModel, applyCustomSlug, removeCustomModelEntry,
    setReasoning, toggleWebSearch, addChip, openWithContext, removeChip, clearChips,
    newThread, switchThread, deleteThread, renameThread, moveThreadToCurrentVariant, jumpToVariant,
    openDiffForMessage, applyAction,
    startInterview, refresh,
  };
}
