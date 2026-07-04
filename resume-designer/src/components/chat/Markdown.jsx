import { useRef, useEffect } from 'react';
import { formatMessage } from '../../markdownMessage.js';
import { reconcileStreamBlocks, htmlToBlocks, applyEdgeFade } from './streamReconcile.js';
import { revealStep, prefersReducedMotion } from './streamReveal.js';

/**
 * Renders chat-message markdown. `formatMessage()` parses markdown and pipes it
 * through DOMPurify, so its output is already sanitized HTML. We turn that string
 * into real nodes with DOMParser (which never executes scripts) and adopt them
 * via replaceChildren — deliberately NOT React's raw-HTML escape hatch, matching
 * how App.jsx injects the shell and keeping us off the raw-innerHTML path.
 */
export function Markdown({ content, className = 'chat-markdown' }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(...htmlToBlocks(formatMessage(content)));
  }, [content]);

  return <div ref={ref} className={className} />;
}

/**
 * Streaming variant of <Markdown>. The plain renderer replaceChildren()s the whole
 * subtree on every token, which tears down the live block and re-fires any entrance
 * animation — so it can't animate gracefully. This one reconciles top-level blocks
 * by index (see reconcileStreamBlocks): settled blocks are left untouched, the
 * growing last block is updated in place, and each brand-new block fades+rises in.
 *
 * It also decouples DISPLAY from ARRIVAL: a requestAnimationFrame loop reveals the
 * accumulated text a few characters per frame (see revealStep) so bursty network deltas
 * stream in smoothly instead of snapping a whole chunk at once, and applyEdgeFade ramps
 * the trailing characters from solid to faint as they land. `onRender` fires after each
 * frame so the list can keep itself pinned to the bottom while the buffer catches up.
 *
 * On completion the producer swaps this bubble for the plain <Markdown> message the
 * instant the network closes; revealStep caps how far the buffer may trail (MAX_LAG), so
 * any not-yet-revealed tail that snaps in at that moment is bounded to ~one line.
 */
export function StreamingMarkdown({ content, className = 'chat-markdown', onRender }) {
  const ref = useRef(null);
  const shownRef = useRef(0); // characters currently displayed
  const rafRef = useRef(0);
  const targetRef = useRef(content);
  const onRenderRef = useRef(onRender);
  targetRef.current = content;
  onRenderRef.current = onRender;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = prefersReducedMotion();

    const paint = (len) => {
      shownRef.current = len;
      reconcileStreamBlocks(el, htmlToBlocks(formatMessage(targetRef.current.slice(0, len))));
      if (!reduced) applyEdgeFade(el); // positional fade trailing the live edge
      onRenderRef.current?.();
    };

    const tick = () => {
      rafRef.current = 0;
      const target = targetRef.current.length;
      if (shownRef.current !== target) paint(revealStep(Math.min(shownRef.current, target), target));
      if (shownRef.current < targetRef.current.length) rafRef.current = requestAnimationFrame(tick);
    };

    if (reduced) {
      // No animated reveal — show whatever has arrived immediately.
      paint(content.length);
    } else if (content.length < shownRef.current) {
      // Content reset/shrank (defensive) — repaint to the shorter target at once.
      paint(content.length);
    } else if (shownRef.current < content.length && !rafRef.current) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [content]);

  // Stop the loop if the bubble unmounts mid-reveal (abort, thread switch, commit).
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return <div ref={ref} className={className} />;
}
