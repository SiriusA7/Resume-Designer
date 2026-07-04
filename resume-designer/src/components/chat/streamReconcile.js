/**
 * Parse sanitized chat-message HTML into top-level block nodes, wrapping any <table>
 * in a horizontally-scrollable container. The wrapper lets wide tables (and the other
 * "graphs" the model sometimes emits) scroll INSIDE the bubble instead of spilling past
 * its right edge — without a bare `table { display: block }`, which would strip the
 * table's implicit screen-reader (ARIA grid) roles.
 */
export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('table').forEach((table) => {
    const wrap = doc.createElement('div');
    wrap.className = 'rd-table-scroll';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
  return [...doc.body.childNodes];
}

const EDGE_CHARS = 18;

/**
 * Wrap the last `charCount` characters of the live (last) block in a `.rd-stream-edge`
 * span, whose CSS mask ramps them from solid to faint — a positional "materialize"
 * trailing the live edge. Unlike a time-based fade, this survives the live block's
 * per-frame rebuild (the reveal buffer re-applies it after every frame), so the fade is
 * actually visible while text streams in a few characters at a time. Self-cleaning: any
 * prior edge span — including one left behind on a block that just settled — is unwrapped
 * first, so only the current live edge ever fades.
 */
export function applyEdgeFade(container, charCount = EDGE_CHARS) {
  container.querySelectorAll('.rd-stream-edge').forEach((span) => {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
  const live = container.lastElementChild;
  if (!live) return;
  let leaf = live;
  while (leaf.lastChild) leaf = leaf.lastChild; // deepest trailing node
  if (leaf.nodeType !== 3) return; // live edge isn't text (e.g. just-added element)
  const n = Math.min(charCount, leaf.nodeValue.length);
  if (n <= 0) return;
  const tail = leaf.splitText(leaf.nodeValue.length - n);
  const span = document.createElement('span');
  span.className = 'rd-stream-edge';
  tail.parentNode.replaceChild(span, tail);
  span.appendChild(tail);
}

/**
 * Reconcile the container's children against freshly-parsed top-level blocks by index.
 * Settled blocks (unchanged content) are skipped, the growing last block is updated in
 * place, and each brand-new block is tagged `.rd-stream-in` for a one-shot fade+rise.
 * Reconciling — rather than replaceChildren()ing the whole subtree every token — keeps
 * settled blocks' DOM stable so their entrance animation doesn't re-fire.
 */
export function reconcileStreamBlocks(el, next) {
  // Signature ignores the element's OWN markup — the transient .rd-stream-in class and
  // the .rd-stream-edge span change neither nodeName nor textContent, so a settled block
  // is skipped every frame instead of being re-churned just because it carries them.
  const sig = (n) => (n.nodeType === 1 ? `${n.nodeName} ${n.textContent}` : `${n.textContent}`);
  for (let i = 0; i < next.length; i++) {
    const node = next[i];
    const old = el.childNodes[i];
    if (!old) {
      if (node.nodeType === 1) node.classList.add('rd-stream-in');
      el.appendChild(node);
      continue;
    }
    if (sig(old) === sig(node)) continue;
    if (old.nodeType === 1 && node.nodeType === 1 && old.nodeName === node.nodeName) {
      old.replaceChildren(...node.childNodes);
    } else {
      el.replaceChild(node, old);
    }
  }
  while (el.childNodes.length > next.length) el.removeChild(el.lastChild);
}
