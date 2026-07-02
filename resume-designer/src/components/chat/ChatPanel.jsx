import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, Square, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { getSettings, saveSettings } from '../../persistence.js';
import { openSettings } from '../../settingsModal.js';
import { getThreadDisplayName } from '../../chatThreads.js';
import { useVariants } from '../../hooks/useVariants.js';
import { useChat } from './useChat.js';
import { MessageList } from './MessageList.jsx';
import { ChatComposer } from './ChatComposer.jsx';
import { ThreadSelector } from './ThreadSelector.jsx';

const MIN_WIDTH = 240;
const MAX_WIDTH = 500;

/**
 * The docked AI chat panel. React owns the entire interior of the existing
 * `<aside id="chat-panel">` shell (the skeleton ships it empty), portaling its
 * content in and toggling the `.closed` class on the host the same way the
 * vanilla panel did. The floating `#toggle-chat-panel` button and its busy
 * indicator stay in the skeleton and are wired here by effect. All cross-module
 * entry points arrive as `rd:chat-*` window events (dispatched by chatPanel.js).
 *
 * Interior styling is genuine shadcn (Tailwind utilities + ui/* primitives);
 * only the panel shell/toggle positioning still lives in styles/chat.css.
 */
export default function ChatPanel() {
  const chat = useChat();
  const variants = useVariants();
  const [host] = useState(() => document.getElementById('chat-panel'));
  const [open, setOpen] = useState(false);

  // Latest engine snapshot for the once-subscribed event listeners below.
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const focusInput = () => setTimeout(() => document.getElementById('chat-input')?.focus(), 300);

  // Pin the width var to a clamped, valid value up front so the panel never
  // relies on the CSS fallback or collapses if settings.chatPanelWidth is bad.
  useEffect(() => {
    const saved = Number(getSettings().chatPanelWidth) || 320;
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved));
    document.documentElement.style.setProperty('--chat-panel-width', `${width}px`);
  }, []);

  // Wire the floating toggle button (lives in the skeleton).
  useEffect(() => {
    const btn = document.getElementById('toggle-chat-panel');
    if (!btn) return undefined;
    const onClick = () => setOpen((o) => !o);
    btn.addEventListener('click', onClick);
    return () => btn.removeEventListener('click', onClick);
  }, []);

  // Reflect open/closed on the host; focus the input when opening.
  useEffect(() => {
    host?.classList.toggle('closed', !open);
    // The ≤768px stylesheet keeps .chat-panel off-canvas and slides it in only
    // for .chat-panel.open, so toggle `open` too — otherwise opening on a narrow
    // viewport gives the panel width but leaves it translated off-screen.
    host?.classList.toggle('open', open);
    if (open) {
      const t = setTimeout(() => document.getElementById('chat-input')?.focus(), 300);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open, host]);

  // Busy indicator on the toggle pulses only while a request runs and the panel
  // is closed (so you notice work finishing without the panel open).
  useEffect(() => {
    document.getElementById('chat-toggle-indicator')?.classList.toggle('active', chat.loading && !open);
  }, [chat.loading, open]);

  // Bridge the vanilla/React entry points (inlineEditor, onboarding, settings,
  // profile panel) — subscribed once, always calling the latest engine.
  useEffect(() => {
    const onOpenContext = (e) => { setOpen(true); chatRef.current.openWithContext(e.detail || {}); focusInput(); };
    const onAddChip = (e) => chatRef.current.addChip(e.detail);
    const onRefresh = () => chatRef.current.refresh();
    const onStartInterview = () => { setOpen(true); chatRef.current.startInterview(); };
    window.addEventListener('rd:chat-open-context', onOpenContext);
    window.addEventListener('rd:chat-add-chip', onAddChip);
    window.addEventListener('rd:chat-refresh', onRefresh);
    window.addEventListener('rd:chat-start-interview', onStartInterview);
    return () => {
      window.removeEventListener('rd:chat-open-context', onOpenContext);
      window.removeEventListener('rd:chat-add-chip', onAddChip);
      window.removeEventListener('rd:chat-refresh', onRefresh);
      window.removeEventListener('rd:chat-start-interview', onStartInterview);
    };
  }, []);

  const startResize = (e) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.dataset.resizing = 'true';
    host?.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const move = (ev) => {
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, ev.clientX));
      document.documentElement.style.setProperty('--chat-panel-width', `${w}px`);
    };
    const end = () => {
      delete handle.dataset.resizing;
      host?.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', end);
      const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-panel-width'), 10);
      if (cur && !Number.isNaN(cur)) saveSettings({ chatPanelWidth: cur });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', end);
  };

  const openApiSettings = () => openSettings('api-keys');

  // Cross-résumé state: is the open thread homed to a DIFFERENT résumé than the
  // active one? If so, surface a slim banner with a Jump to its home résumé.
  const openThread = chat.threads.find((t) => t.id === chat.currentThreadId);
  const openHome = openThread?.homeVariantId ?? null;
  const crossResume = openHome !== null && openHome !== chat.currentVariantId;
  const homeName = variants.list.find((v) => v.id === openHome)?.name;

  // A reply may still be streaming in a thread OTHER than the one on screen: the
  // user switched away mid-response and it keeps running, committing to its origin
  // thread. Surface a pinned banner so that hidden run stays visible and cancellable
  // — otherwise the composer sits disabled (loading) with no Stop anywhere in view.
  const bgStreamThread =
    chat.loading && chat.streamThreadId && chat.streamThreadId !== chat.currentThreadId
      ? chat.threads.find((t) => t.id === chat.streamThreadId)
      : null;

  if (!host) return null;

  return createPortal(
    <>
      {/* Resize handle — the panel is docked left, so its grab edge is on the
          RIGHT (width = clientX). Pure Tailwind; the drag state paints via the
          data-resizing attribute set in startResize. */}
      <div
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 data-[resizing=true]:bg-primary/60"
        onMouseDown={startResize}
      />

      {/* Header: title row + thread row. */}
      <div className="shrink-0 border-b px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">AI Assistant</h2>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="API Settings"
              aria-label="API Settings"
              onClick={openApiSettings}
            >
              <Settings2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="Close panel"
              aria-label="Close panel"
              onClick={() => setOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        {chat.configured && (
          <div className="mt-1 flex">
            <ThreadSelector
              threads={chat.threads}
              currentThreadId={chat.currentThreadId}
              currentVariantId={chat.currentVariantId}
              variants={variants.list}
              onSwitch={chat.switchThread}
              onNew={chat.newThread}
              onDelete={chat.deleteThread}
              onMoveToCurrent={chat.moveThreadToCurrentVariant}
            />
          </div>
        )}
      </div>

      {/* Cross-résumé banner: pinned slim row when the open thread belongs to a
          different résumé than the active one, with a Jump to its home. */}
      {chat.configured && crossResume && homeName && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span className="flex min-w-0 items-center" title={`Thread from «${homeName}»`}>
            <span className="shrink-0">Thread from&nbsp;«</span>
            <span className="truncate">{homeName}</span>
            <span className="shrink-0">»</span>
          </span>
          <button
            type="button"
            className="shrink-0 font-medium text-foreground hover:underline"
            onClick={() => chat.jumpToVariant(openHome)}
            title={`Make «${homeName}» the active résumé — this thread stays open`}
          >
            Switch résumé
          </button>
        </div>
      )}

      <MessageList
        messages={chat.messages}
        thinking={chat.thinking}
        streamingMessage={chat.streamingMessage}
        configured={chat.configured}
        currentThreadId={chat.currentThreadId}
        variants={variants.list}
        onReviewChanges={chat.openDiffForMessage}
        onApply={chat.applyAction}
        onConfigure={openApiSettings}
        onStop={chat.stop}
        onJumpVariant={chat.jumpToVariant}
      />

      {/* Background-stream banner: a reply is still generating in a thread other than
          the one on screen. Restores visibility + a Stop for that hidden run (which
          leaves the composer disabled) — click the name to hop back to it. */}
      {chat.configured && bgStreamThread && (
        <div className="flex shrink-0 items-center gap-2 border-t bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground">
          <span
            className="size-2 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
            aria-hidden="true"
          />
          <span className="shrink-0">Still generating in</span>
          <button
            type="button"
            className="min-w-0 truncate font-medium text-foreground hover:underline"
            title={`Open «${getThreadDisplayName(bgStreamThread)}»`}
            onClick={() => chat.switchThread(bgStreamThread.id)}
          >
            {getThreadDisplayName(bgStreamThread)}
          </button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 shrink-0 gap-1 text-[11px]"
            onClick={chat.stop}
          >
            <Square className="size-3" />
            Stop
          </Button>
        </div>
      )}

      {chat.configured && (
        <ChatComposer
          contextChips={chat.contextChips}
          onRemoveChip={chat.removeChip}
          onClearChips={chat.clearChips}
          onSend={chat.send}
          loading={chat.loading}
          currentModel={chat.currentModel}
          configured={chat.configured}
          customModels={chat.customModels}
          onSelectModel={chat.selectModel}
          onApplyCustomSlug={chat.applyCustomSlug}
          onRemoveCustom={chat.removeCustomModelEntry}
          onConfigure={openApiSettings}
          reasoningEffort={chat.reasoningEffort}
          reasoningSupported={chat.reasoningSupported}
          onSetReasoning={chat.setReasoning}
          webSearchEnabled={chat.webSearchEnabled}
          onToggleWebSearch={chat.toggleWebSearch}
        />
      )}
    </>,
    host
  );
}
