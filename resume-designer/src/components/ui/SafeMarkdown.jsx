import { useRef, useEffect } from 'react';

import { formatMessage } from '../../markdownMessage.js';
import { htmlToBlocks } from '../chat/streamReconcile.js';
import { resolveHref } from './resolveHref.js';

// Render trusted-but-sanitized markdown. formatMessage() = marked + DOMPurify;
// htmlToBlocks turns the sanitized HTML string into DOM nodes we append via
// replaceChildren, matching the chat renderer's non-streaming path (no raw
// HTML-injection prop).
//
// `baseUrl` resolves relative links (release notes can carry them) to absolute
// URLs so the desktop interceptor opens them externally instead of navigating
// the webview into an internal 404; unresolvable relatives get their href
// removed (rendered inert).
export function SafeMarkdown({ content, className, baseUrl }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(...htmlToBlocks(formatMessage(content || '')));
    for (const a of el.querySelectorAll('a[href]')) {
      const resolved = resolveHref(a.getAttribute('href'), baseUrl);
      if (resolved === null) a.removeAttribute('href');
      else a.setAttribute('href', resolved);
    }
  }, [content, baseUrl]);
  return <div ref={ref} className={className} />;
}
