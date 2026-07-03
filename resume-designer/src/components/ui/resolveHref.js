// Resolve an anchor href for rendering fetched Markdown (release notes) inside
// the Tauri webview.
//
// The desktop link interceptor (main.js) opens http(s) links in the system
// browser but lets fragment/relative links navigate the webview — which would
// replace the SPA with an internal 404. So absolute http(s)/mailto/tel and
// in-page fragments pass through unchanged; a relative link is resolved to an
// absolute URL against `baseUrl` (making the interceptor open it externally),
// or dropped (return null → caller removes the href) when no base is known.
export function resolveHref(href, baseUrl) {
  if (!href || href.startsWith('#')) return href; // in-page anchor: leave as-is
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href; // already absolute/safe
  if (!baseUrl) return null; // relative with no base to resolve against
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}
