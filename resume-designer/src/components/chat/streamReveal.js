// Reveal pacing for the streaming markdown buffer (see StreamingMarkdown). Networks
// deliver tokens in bursts, so a whole chunk would otherwise snap in within one frame.
// Instead we pay out the backlog over several frames: always at least MIN_STEP
// characters (a gentle "typing" cadence at the live edge) plus a share of the backlog,
// so a large burst drains quickly with an ease-out while a trickle stays smooth.
// ~1/CATCHUP_DIVISOR of the backlog clears each frame, so the display trails the
// stream by only a few frames.
export const MIN_STEP = 2;
export const CATCHUP_DIVISOR = 5;
// Cap how far the display may trail the arrived text. The buffer is unmounted the
// instant the network completes, so whatever it hasn't yet revealed snaps in via the
// committed message. Bounding the lag bounds that end-of-stream pop to ~one line — for
// a normal token stream the backlog never approaches this, so smoothing is unaffected;
// it only kicks in for a fast reply that arrives in a couple of bursts.
export const MAX_LAG = 90;

/**
 * How many characters to display next, given how many are shown and how many have
 * arrived. Pure + deterministic so the pacing can be unit-tested without rAF. Never
 * overshoots `target`, always advances (step >= 1) so it converges, and never trails
 * by more than `maxLag` characters.
 */
export function revealStep(shown, target, minStep = MIN_STEP, divisor = CATCHUP_DIVISOR, maxLag = MAX_LAG) {
  if (shown >= target) return target;
  const backlog = target - shown;
  const step = Math.max(minStep, Math.ceil(backlog / divisor), backlog - maxLag);
  return Math.min(target, shown + step);
}

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
