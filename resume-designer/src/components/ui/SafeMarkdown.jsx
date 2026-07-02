import { useRef, useEffect } from 'react';

import { formatMessage } from '../../markdownMessage.js';
import { htmlToBlocks } from '../chat/streamReconcile.js';

// Render trusted-but-sanitized markdown. formatMessage() = marked + DOMPurify;
// htmlToBlocks turns the sanitized HTML string into DOM nodes we append via
// replaceChildren, matching the chat renderer's non-streaming path (no raw
// HTML-injection prop).
export function SafeMarkdown({ content, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.replaceChildren(...htmlToBlocks(formatMessage(content || '')));
  }, [content]);
  return <div ref={ref} className={className} />;
}
