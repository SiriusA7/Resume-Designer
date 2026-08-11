# Next: the Olia chat UI, and fixing zoom properly

Two pieces of work specified but not built. Both were requested directly, and
both have a known-good reference.

## 1. Chat UI — match Olia

Olia (formerly HyperBite) is a native SwiftUI app at
`~/HyperBuild/Projects/HyperBite-iOS/Olia`. Its chat is the target; copy the
approach rather than inventing one.

**Composer** — `Olia/Screens/Chat/MessageComposer.swift`:

- iOS 26+ wraps the field and the send button in a `GlassEffectContainer`, each
  carrying a `.glassEffectID` in a shared `@Namespace`, so the two MORPH into
  each other. That is the effect worth copying — it is not a background style.
- `TextField(..., axis: .vertical)` with `.lineLimit(1...8)`, `minHeight: 44`,
  `.glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 24,
  style: .continuous))`.
- Send is `.buttonStyle(.glassProminent)` + `.buttonBorderShape(.circle)`, an
  `arrow.up` glyph with `.symbolEffect(.bounce, value: isSending)`.
- There is a full iOS 18–25 fallback branch using `.ultraThinMaterial` and a
  hairline stroke. Keep it: On Paper's deployment target is 17.4.
- Character-limit and cooldown indicators sit below the field.

**Reasoning timeline** — `Olia/Screens/Chat/ReasoningTimelineView.swift`:

- Reasoning text is split into steps by newline, each rendered as a row with a
  dot and connecting rules drawn as `Rectangle`s above and below — a real
  timeline, not a disclosure group.
- `ReasoningStep` carries `isFirst`/`isLast`/`isDone`; the done row swaps the
  dot for `checkmark.circle` and centres its alignment.
- Rows fade and rise in (`opacity` + `offset(y: 6)`, `.easeOut(0.3)`) on first
  appearance, which is what makes streaming feel alive.
- `stripReasoningTitles()` / `findLastTitle()` handle OpenAI's `**Title**`
  summaries, including the case where the closing `**` lands on its own line.
  On Paper's models emit the same shape, so port these verbatim.

**Bridge work this needs.** `buildChatView()` currently projects role/text only.
The timeline needs each assistant message's `reasoning` (already on the message
in `useChat.js`, rendered today by `LiveReasoning.jsx`) plus the live `thinking`
state. Add them to the projection and to `ShellSnapshot.ChatView.Message`.

## 2. Zoom — the real problem

Two independent scales on one canvas: the toolbar's -/+ apply a CSS transform to
`.resume-container`, pinch drives WKWebView's own scroll-view zoom. The readout
tracks only the first, so pinching moves the page and the percentage sits still.

An attempt to unify on the webview's zoom was reverted (see git history around
`496ebb7`), because it could not reach BELOW 100%: WebKit re-derives
`minimumZoomScale` from the viewport on every layout and discards both a
`minimum-scale` meta tag and a direct `scrollView.minimumZoomScale` assignment.
The CSS transform is exactly how the app reaches below 100% today, so removing
it without a replacement loses fit-to-page.

**Do not simply retry that.** Establish first how WebKit is deriving the minimum
scale here — content width versus viewport width, and whether
`.resume-container`'s `min-width: 8.5in` is what pins it — then pick the model.
The alternative worth weighing is the opposite unification: keep the CSS
transform as the single zoom, disable WKWebView's own pinch
(`scrollView.pinchGestureRecognizer?.isEnabled = false`), and drive the CSS zoom
from a SwiftUI `MagnificationGesture`. That keeps the full range and makes the
readout correct by construction.

## Related: the canvas deliberately runs under the toolbar

An inset fix (`e8714e5`) was reverted on request: the résumé reaching the bottom
of the screen behind the floating toolbar is wanted, for the liquid-glass look.
So `window.innerHeight` legitimately exceeds the visible area, and anything
depending on it must account for that rather than "fixing" it again.
