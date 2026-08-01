import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowRightLeft, Check, KeyRound, Loader2, MessageCircle, Pencil, Settings2, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import * as changeSession from '../../changeSession.js';

import { Markdown, StreamingMarkdown } from './Markdown.jsx';
import { LiveReasoning } from './LiveReasoning.jsx';
import { Citations } from './Citations.jsx';
import { RunMeta } from './RunMeta.jsx';

// Synthetic "thinking" block — still used by the NON-streamed flows (/feedback,
// /improve, /generate, profile interview) which show scripted steps rather than a
// token stream. The streamed flows (chat reply, change-requests) use
// <StreamingBubble> instead. Mockup `.think`: bordered card, spinner, pulsing
// primary dots, green check steps.
function ThinkingBlock({ thinking, onStop }) {
  const done = thinking.phase === 'done';
  return (
    <div className="w-[92%] self-start rounded-xl border bg-background px-3 py-2.5">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        {done ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        )}
        <span>{done ? 'Complete' : 'Processing…'}</span>
        {/* Helper runs are abortable like streams — expose the same Stop here,
            since in the origin thread this block is the only in-flight UI. */}
        {!done && onStop && (
          <Button variant="outline" size="sm" className="ml-auto h-6 gap-1 text-[11px]" onClick={onStop}>
            <Square className="size-3" /> Stop
          </Button>
        )}
      </div>
      {thinking.steps.length > 0 && (
        <div className="mt-2 space-y-1">
          {thinking.steps.map((s, i) => {
            const active = !s.complete && i === thinking.steps.length - 1;
            return (
              <div key={i} className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {s.complete ? (
                    <Check className="size-3 text-success" />
                  ) : (
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        active ? 'animate-pulse bg-primary' : 'bg-muted-foreground/40'
                      )}
                    />
                  )}
                </span>
                <span>{s.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Live streaming assistant turn: real reasoning streams into the LiveReasoning
// panel, the answer streams below it, and Stop aborts the run mid-stream.
function StreamingBubble({ msg, onStop, onRender }) {
  return (
    <div className="w-[92%] max-w-[92%] self-start space-y-2 rounded-[14px_14px_14px_4px] border bg-background px-3 py-2.5">
      <LiveReasoning reasoning={msg.reasoning} reasoningTokens={msg.run?.reasoningTokens || 0} streaming defaultOpen />
      {msg.content ? (
        <div className="min-w-0 text-[13.5px] leading-relaxed">
          <StreamingMarkdown content={msg.content} onRender={onRender} />
        </div>
      ) : null}
      <Button variant="outline" size="sm" className="h-6 gap-1 text-[11px]" onClick={onStop}>
        <Square className="size-3" /> Stop
      </Button>
    </div>
  );
}

function MessageBubble({ msg, onReviewChanges, onApply, onJumpVariant, variants, currentVariantId }) {
  // Re-render on any change-session transition so the action buttons below
  // stand down the moment this message's changes are decided from ANY surface
  // (inline preview, diff dialog) — msg.pendingChanges alone cannot know that.
  const [, setSessionRev] = useState(0);
  useEffect(() => changeSession.subscribe(() => setSessionRev((n) => n + 1)), []);

  // Context-switch divider: a "Now discussing «Name»" row whose button makes that
  // resume active WITHOUT leaving this thread (onJumpVariant pins it). The name is
  // resolved live from the variant list so it tracks renames and so older markers
  // — which mis-stamped the person's name instead of the resume label — read right.
  if (msg.role === 'context') {
    const name =
      variants?.find((v) => v.id === msg.variantId)?.name || msg.variantName || 'this resume';
    return (
      <div className="my-2 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="flex min-w-0 shrink items-center gap-1.5">
          <span className="shrink-0">Now discussing</span>
          <button
            type="button"
            className="min-w-0 truncate rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
            onClick={() => onJumpVariant?.(msg.variantId)}
            title={`Switch the editor to «${name}» — this thread stays open`}
          >
            {name}
          </button>
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div className="w-fit max-w-[85%] rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <span className="font-semibold">Error:</span> {msg.content}
      </div>
    );
  }

  const isUser = msg.role === 'user';
  // This message's changes are reviewable only while they are the change set
  // the shared session is still deciding. Identity-scoped on purpose: a later
  // proposal's pending session must not resurrect an older message's buttons
  // over its stale diff.
  const changesStillPending = msg.pendingChanges
    ? changeSession.getChangeSet() === msg.pendingChanges && changeSession.hasPending()
    : false;
  const hasActions = msg.applyData || changesStillPending;
  // Apply/Review mutate or diff the ACTIVE resume (store-wide), but in a
  // cross-resume thread this message may have been generated against another
  // one. When the stamps disagree, offer the switch instead of the actions —
  // jumpToVariant keeps this thread open, and once the origin resume is active
  // the real buttons render. Messages predating variant stamping (no
  // msg.variantId) keep the old behavior; we can't know their origin.
  const actionsForeign =
    !!hasActions && !!msg.variantId && !!currentVariantId && msg.variantId !== currentVariantId;
  const originVariant = actionsForeign ? variants?.find((v) => v.id === msg.variantId) : null;

  return (
    <div
      className={cn(
        'w-fit px-3 py-2.5 text-[13.5px] leading-relaxed',
        isUser
          ? 'ml-auto max-w-[85%] rounded-[14px_14px_4px_14px] bg-primary text-primary-foreground'
          : 'max-w-[92%] rounded-[14px_14px_14px_4px] border bg-background'
      )}
    >
      {!isUser && <LiveReasoning reasoning={msg.reasoning} reasoningTokens={msg.run?.reasoningTokens || 0} />}

      <Markdown content={msg.content} />

      {!isUser && <Citations annotations={msg.annotations} />}

      {!isUser && msg.run && <RunMeta run={msg.run} showCost className="mt-2 border-t pt-2" />}

      {hasActions && (
        <div className="mt-2.5 flex flex-wrap gap-2 border-t pt-2.5">
          {actionsForeign ? (
            originVariant ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 max-w-full text-xs"
                onClick={() => onJumpVariant?.(msg.variantId)}
                title={`These edits were made for «${originVariant.name}» — switch to it to apply. This thread stays open.`}
              >
                <ArrowRightLeft className="size-3.5 shrink-0" />
                <span className="truncate">Switch to «{originVariant.name}» to apply</span>
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                These edits were for a resume that no longer exists.
              </span>
            )
          ) : (
            <>
              {msg.applyData && (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onApply(msg.applyData.action, msg.applyData.value)}
                >
                  <Check className="size-3.5" />
                  Apply to Resume
                </Button>
              )}
              {changesStillPending && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onReviewChanges(msg.id)}
                >
                  <Pencil className="size-3.5" />
                  Review Changes
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ApiKeyPrompt({ onConfigure }) {
  return (
    <div className="my-auto flex flex-col items-center gap-1 px-6 py-14 text-center">
      <KeyRound className="mb-3 size-10 text-muted-foreground/40" />
      <p className="text-sm font-medium">Setup Required</p>
      <p className="text-sm text-muted-foreground">
        To use the AI Assistant, add your OpenRouter API key — one key for Claude, GPT, Gemini &amp; 300+ models.
      </p>
      <Button className="mt-4" onClick={onConfigure}>
        <Settings2 className="size-4" />
        Configure API Keys
      </Button>
    </div>
  );
}

function Welcome() {
  return (
    <div className="my-auto flex flex-col items-center gap-1 px-6 py-14 text-center">
      <MessageCircle className="mb-3 size-10 text-muted-foreground/40" />
      <p className="text-sm font-medium">Welcome to AI Assistant</p>
      <p className="text-sm text-muted-foreground">I can help you improve your resume. Try asking me to:</p>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        <li>Rewrite a bullet point to be more impactful</li>
        <li>Suggest improvements for your summary</li>
        <li>Generate new experience bullets</li>
        <li>Review your resume for feedback</li>
      </ul>
    </div>
  );
}

/**
 * The scrolling message stream: API-key prompt when unconfigured, the welcome
 * card when empty, otherwise the message bubbles plus — while a request is in
 * flight — either the live <StreamingBubble> (streamed flows) or the synthetic
 * <ThinkingBlock> (helper flows). Auto-scrolls to the bottom on any change.
 */
export function MessageList({
  messages, thinking, streamingMessage, configured, currentThreadId, variants,
  currentVariantId, onReviewChanges, onApply, onConfigure, onStop, onJumpVariant,
}) {
  const scrollerRef = useRef(null);
  // Whether the viewport is parked at the bottom. While it is, new content sticks;
  // once the user scrolls up we leave them be (so streaming tokens don't yank the
  // view down), re-arming only when they return to within THRESHOLD px of the end.
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const THRESHOLD = 80;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Switching threads always re-arms stick and drops to the newest message.
  useEffect(() => {
    pinnedRef.current = true;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [currentThreadId]);

  // Follow new messages / streaming tokens only while the user is pinned to the end.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, streamingMessage]);

  // The streaming buffer reveals text across frames that don't change props, so the
  // effect above won't fire for them. It calls this after each frame to stay pinned —
  // honouring the same rule, so a user who scrolled up is never yanked back down.
  const followStream = useCallback(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div id="chat-messages" ref={scrollerRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-muted/40 p-4">
      {!configured ? (
        <ApiKeyPrompt onConfigure={onConfigure} />
      ) : messages.length === 0 && !thinking && !streamingMessage ? (
        <Welcome />
      ) : (
        <>
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              onReviewChanges={onReviewChanges}
              onApply={onApply}
              onJumpVariant={onJumpVariant}
              variants={variants}
              currentVariantId={currentVariantId}
            />
          ))}
          {streamingMessage && <StreamingBubble msg={streamingMessage} onStop={onStop} onRender={followStream} />}
          {thinking && <ThinkingBlock thinking={thinking} onStop={onStop} />}
        </>
      )}
    </div>
  );
}
