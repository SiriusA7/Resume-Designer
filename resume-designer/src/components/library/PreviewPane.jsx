import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderResumeForLayout } from '../../renderer.js';
import { getSettings } from '../../persistence.js';
import { pageDimsIn } from '../../pageSetup.js';

/**
 * Inert, scaled live render of a variant's first page. Reuses the app's real
 * renderer + global .resume stylesheet, so it's always accurate to the current
 * layout setting; no thumbnail cache, rendered only for the selected variant.
 * (Global palette/spacing services style the live editor only — the preview
 * shows the default palette. Acceptable for Phase 1.)
 */
export default function PreviewPane({ variant }) {
  const settings = getSettings();
  const layout = settings.layout || 'sidebar';
  const html = useMemo(
    () => renderResumeForLayout(variant.data, layout, { groupPositions: settings.groupPositions !== false }),
    [variant, layout, settings.groupPositions],
  );

  const dims = pageDimsIn(settings); // settings carries pageSize/orientation/pageWidthIn
  const pageW = dims.widthIn * 96;
  const pageH = (dims.heightIn || 11) * 96; // continuous → clip to one letter page

  const boxRef = useRef(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setScale(el.clientWidth / pageW);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageW, variant.id]);

  return (
    <div
      ref={boxRef}
      className="overflow-hidden rounded-md border bg-white shadow-sm"
      style={{ height: scale ? pageH * scale : undefined }}
      aria-hidden="true"
    >
      {scale > 0 && (
        <div
          className="resume pointer-events-none select-none"
          data-layout={layout}
          style={{ width: `${pageW}px`, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
